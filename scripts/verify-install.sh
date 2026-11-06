#!/usr/bin/env bash
#
# Checks a Kookaburra Cut release on any Mac, from 0.23.0 on, with gh, codesign, shasum, spctl and
# jq: the release's files against SHA256SUMS; the DMG and build-info.txt against this repository's
# build provenance from the release workflow on the tag; the DMG against its SBOM attestation; the
# SBOM against the commit build-info.txt records, and that commit against the tag; every signature
# in the app and its sidecars (Developer ID, the Team ID below, hardened runtime, secure timestamp,
# no entitlements); notarisation and Gatekeeper; the version. It downloads nothing: fetch the
# release's files first.
#
#   gh release download v<version> --repo michael-palmes/kookaburra-cut --dir <dir>
#   verify-install.sh --version <version> --dir <dir> [--app <path>] [--bundle <file>] [--previous <version>]
#     --version   the release (its tag is v<version>)
#     --dir       the folder holding the downloaded release files
#     --app       an installed app to check in place (default: the app inside the DMG)
#     --bundle    verify the build provenance offline against this bundle (default: the release page's
#                 KookaburraCut-<version>.intoto.jsonl when it is in --dir)
#     --previous  print how the release's SECURITY.md differs from this version's (through gh api)
#   With rust-audit-info on PATH (cargo install rust-audit-info) it also counts the crates the
#   binary carries in its .dep-v0 section.
#
set -euo pipefail

TEAM_ID=Q4B8N8ZKA2
REPO=michael-palmes/kookaburra-cut
SIGNER_WORKFLOW="$REPO/.github/workflows/release.yml"
APP_NAME="Kookaburra Cut"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

VERSION=""
DIR=""
APP=""
BUNDLE=""
PREVIOUS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a version}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a folder}"; shift 2 ;;
    --app) APP="${2:?--app needs a path}"; shift 2 ;;
    --bundle) BUNDLE="${2:?--bundle needs a file}"; shift 2 ;;
    --previous) PREVIOUS="${2:?--previous needs a version}"; shift 2 ;;
    --help | -h) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument '$1' (--help)" ;;
  esac
done
[[ -n "$VERSION" && -n "$DIR" ]] || die "--version and --dir are required (--help)"
re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $re ]] || die "not a version: $VERSION"
TAG="v$VERSION"
[[ -d "$DIR" ]] || die "no folder $DIR"
DIR=$(cd "$DIR" && pwd)
DMG="$DIR/KookaburraCut-$VERSION.dmg"
SBOM="$DIR/KookaburraCut-$VERSION.cdx.json"
INFO="$DIR/build-info.txt"
SUMS="$DIR/SHA256SUMS"
SECURITY="$DIR/SECURITY.md"
for f in "$SUMS" "$DMG" "$INFO" "$SBOM" "$SECURITY"; do
  [[ -f "$f" ]] || die "missing $f; fetch the release first: gh release download $TAG --repo $REPO --dir \"$DIR\" (the SBOM ships from 0.23.0)"
done
[[ -n "$BUNDLE" || ! -f "$DIR/KookaburraCut-$VERSION.intoto.jsonl" ]] || BUNDLE="$DIR/KookaburraCut-$VERSION.intoto.jsonl"
[[ -z "$BUNDLE" || -f "$BUNDLE" ]] || die "no bundle at $BUNDLE"
[[ -z "$APP" || -d "$APP" ]] || die "no app at $APP"
for tool in gh codesign shasum spctl jq hdiutil plutil; do
  command -v "$tool" >/dev/null || die "$tool is needed"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-verify-install.XXXXXX")
MOUNT=""
cleanup() {
  [[ -z "$MOUNT" ]] || hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the files, against the checksums the publish job wrote ───────────────────
log "SHA256SUMS"
for f in "$DMG" "$INFO" "$SBOM" "$SECURITY"; do
  grep -Fq "  $(basename "$f")" "$SUMS" || die "SHA256SUMS does not list $(basename "$f")"
done
(cd "$DIR" && shasum -a 256 -c SHA256SUMS --ignore-missing)

# ── provenance: built by release.yml on the tag, on GitHub's own runners ─────
attest() {
  gh attestation verify "$1" --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" \
    --source-ref "refs/tags/$TAG" --deny-self-hosted-runners "${@:2}"
}
bundle_args=()
[[ -z "$BUNDLE" ]] || bundle_args=(--bundle "$BUNDLE")
log "Build provenance: the DMG and build-info.txt${BUNDLE:+ (offline, from $BUNDLE)}"
attest "$DMG" ${bundle_args[@]+"${bundle_args[@]}"}
attest "$INFO" ${bundle_args[@]+"${bundle_args[@]}"}
log "SBOM attestation on the DMG"
attest "$DMG" --predicate-type https://cyclonedx.org/bom

# ── the record: build-info.txt's commit is the tag's, and the SBOM is for it ─
commit=$(sed -n 's/^commit=//p' "$INFO")
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "build-info.txt records no commit"
read -r sha kind <<<"$(gh api "repos/$REPO/git/ref/tags/$TAG" --jq '.object.sha + " " + .object.type')"
[[ "$kind" != tag ]] || sha=$(gh api "repos/$REPO/git/tags/$sha" --jq .object.sha)
[[ "$sha" == "$commit" ]] || die "build-info.txt records commit $commit, but $TAG points at $sha"
log "build-info.txt records the commit $TAG points at (${commit:0:12})"
jq -e --arg v "$VERSION" --arg c "$commit" '
  .bomFormat == "CycloneDX" and .metadata.component.version == $v
  and ([.metadata.properties[] | select(.name == "kookaburra-cut:commit") | .value] == [$c])
' "$SBOM" >/dev/null || die "the SBOM is not for $VERSION at $commit"
log "SBOM: $(jq '.components | length' "$SBOM") components for $VERSION at that commit"

# ── the DMG ──────────────────────────────────────────────────────────────────
log "Signature and Gatekeeper: $DMG"
codesign --verify --verbose=2 "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | tee "$WORK/spctl-dmg.txt"
grep -q "accepted" "$WORK/spctl-dmg.txt" || die "Gatekeeper did not accept $DMG"
if [[ -z "$APP" ]]; then
  mkdir -p "$WORK/mnt"
  attach=$(hdiutil attach -readonly -nobrowse -noautoopen -mountrandom "$WORK/mnt" "$DMG" 2>/dev/null)
  MOUNT=$(awk -F'\t' 'END { print $NF }' <<<"$attach")
  [[ -n "$MOUNT" && -d "$MOUNT/$APP_NAME.app" ]] || die "the DMG does not hold $APP_NAME.app"
  APP="$MOUNT/$APP_NAME.app"
fi

# ── the app: one code object at a time ───────────────────────────────────────
verify_code() {
  local path="$1" info
  codesign --verify --deep --strict --verbose=2 "$path"
  info=$(codesign -dv --verbose=4 "$path" 2>&1)
  grep -Fq "Authority=Developer ID Application:" <<<"$info" || die "$path: not a Developer ID signature"
  grep -Fq "Authority=Developer ID Certification Authority" <<<"$info" || die "$path: chain is not Apple's Developer ID CA"
  grep -Eq "flags=0x10000\(runtime\)" <<<"$info" || die "$path: expected flags=0x10000(runtime)"
  grep -Eq "^Timestamp=" <<<"$info" || die "$path: no secure timestamp"
  grep -Fq "TeamIdentifier=$TEAM_ID" <<<"$info" || die "$path: TeamIdentifier is not $TEAM_ID"
}
log "Signatures: $APP"
verify_code "$APP"
for sidecar in ffmpeg ffprobe; do verify_code "$APP/Contents/MacOS/$sidecar"; done
ent=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || true)
[[ -z "$ent" || "$ent" == "{}" ]] || die "$APP carries entitlements, expected none: $ent"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" == "$VERSION" ]] \
  || die "$APP is not version $VERSION"
log "Notarisation and Gatekeeper: $APP"
if command -v xcrun >/dev/null && xcrun --find stapler >/dev/null 2>&1; then xcrun stapler validate "$APP"; fi
spctl -a -t exec -vv "$APP" 2>&1 | tee "$WORK/spctl-app.txt"
grep -q "accepted" "$WORK/spctl-app.txt" || die "Gatekeeper did not accept $APP"
grep -q "Notarized Developer ID" "$WORK/spctl-app.txt" || die "Gatekeeper source is not Notarized Developer ID for $APP"
if command -v rust-audit-info >/dev/null; then
  log "Rust dependency list in the binary: $(rust-audit-info "$APP/Contents/MacOS/kookaburra-cut" | jq '.packages | length') crates in .dep-v0"
else
  log "rust-audit-info is not on PATH (cargo install rust-audit-info), so the binary's own crate list was not read"
fi

# ── the security policy shipped with the release, against the previous one ───
raw() { gh api -H "Accept: application/vnd.github.raw+json" "repos/$REPO/contents/SECURITY.md?ref=$1"; }
if [[ -n "$PREVIOUS" ]]; then
  raw "$TAG" > "$WORK/security-tag.md"
  cmp -s "$SECURITY" "$WORK/security-tag.md" || die "the release's SECURITY.md is not the one at $TAG"
  raw "v$PREVIOUS" > "$WORK/security-previous.md"
  log "SECURITY.md, v$PREVIOUS to $TAG"
  diff -u --label "v$PREVIOUS" --label "$TAG" "$WORK/security-previous.md" "$SECURITY" || true
fi

echo
echo "Verified: $APP_NAME $VERSION at ${commit:0:12}, signed by Team ID $TEAM_ID, notarised, with its provenance and SBOM"
