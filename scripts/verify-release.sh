#!/usr/bin/env bash
#
# Verifies a signed release set on a machine that never held a key: the release workflow's
# verify job, and the last step of a local rehearsal. Checks the signatures, notarisation and
# Gatekeeper verdicts, the updater signature against plugins.updater.pubkey, runs the signed
# binary's headless CLI, and compares every bundle file, signatures stripped, with what the build
# job recorded. The DMG, the pkg and the updater tar must each hold the zip's app, and the app and the
# pkg's payload must carry every licence text and notice (Contents/Resources/licenses).
#
#   verify-release.sh [--adhoc] [--dir release/] [--sidecar-digests <file>] [--bundle-digests <file>]
#     --adhoc             an ad-hoc rehearsal: no notarisation or Gatekeeper checks, an unsigned pkg
#     --dir DIR           where the zip, DMG, pkg, updater tar and latest.json are (default release/)
#     --sidecar-digests   the build job's `sidecar-digest.sh` output to compare against
#     --bundle-digests    the build job's `bundle-digest.sh` output to compare against
#   KOOKABURRA_TEAM_ID    when set, every signature's TeamIdentifier must match it
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")
BUNDLE_ID=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').identifier")
MIN_OS=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').bundle.macOS.minimumSystemVersion")
APP_NAME="Kookaburra Cut"
DIR="$ROOT/release"
ADHOC=0
DIGESTS=""
BUNDLE_DIGESTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --adhoc) ADHOC=1; shift ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --sidecar-digests) DIGESTS="${2:?--sidecar-digests needs a file}"; shift 2 ;;
    --bundle-digests) BUNDLE_DIGESTS="${2:?--bundle-digests needs a file}"; shift 2 ;;
    --help | -h) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
DIR=$(cd "$DIR" && pwd)
ZIP="$DIR/KookaburraCut-${VERSION}.zip"
DMG="$DIR/KookaburraCut-${VERSION}.dmg"
PKG="$DIR/KookaburraCut-${VERSION}.pkg"
UPDATER_TAR="$DIR/KookaburraCut-${VERSION}-updater.app.tar.gz"
LATEST_JSON="$DIR/latest.json"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }
for f in "$ZIP" "$DMG" "$PKG" "$UPDATER_TAR" "$UPDATER_TAR.sig" "$LATEST_JSON"; do
  [[ -f "$f" ]] || die "missing: $f"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-verify.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
MOUNT=""
cleanup() {
  [[ -z "$MOUNT" ]] || hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# One code object: strict signature, hardened runtime, the right authority, no entitlements.
verify_code() {
  local path="$1" info
  codesign --verify --deep --strict --verbose=2 "$path"
  info=$(codesign -dv --verbose=4 "$path" 2>&1)
  if [[ "$ADHOC" == 1 ]]; then
    grep -Fq "Signature=adhoc" <<<"$info" || die "$path: expected an ad-hoc signature"
    grep -Eq "flags=0x10002\(adhoc,runtime\)" <<<"$info" || die "$path: hardened runtime flag missing"
  else
    grep -Fq "Authority=Developer ID Application:" <<<"$info" || die "$path: not a Developer ID signature"
    grep -Fq "Authority=Developer ID Certification Authority" <<<"$info" || die "$path: chain is not Apple's Developer ID CA"
    grep -Eq "flags=0x10000\(runtime\)" <<<"$info" || die "$path: expected flags=0x10000(runtime)"
    grep -Eq "^Timestamp=" <<<"$info" || die "$path: no secure timestamp"
    [[ -z "${KOOKABURRA_TEAM_ID:-}" ]] || grep -Fq "TeamIdentifier=$KOOKABURRA_TEAM_ID" <<<"$info" \
      || die "$path: TeamIdentifier is not $KOOKABURRA_TEAM_ID"
  fi
}

file_shas() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256); }

verify_app() {
  local app="$1" ent
  log "Signature: $app"
  verify_code "$app"
  for sidecar in ffmpeg ffprobe; do verify_code "$app/Contents/MacOS/$sidecar"; done
  ent=$(codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || true)
  [[ -z "$ent" || "$ent" == "{}" ]] || die "$app carries entitlements, expected none: $ent"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$VERSION" ]] \
    || die "$app is not version $VERSION"
  # The bundler only logs when actool is missing or too old, so a lost icon must fail here.
  [[ -f "$app/Contents/Resources/Assets.car" ]] || die "$app has no Assets.car"
  [[ -n "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$app/Contents/Info.plist" 2>/dev/null)" ]] \
    || die "$app has no CFBundleIconName"
  if [[ "$ADHOC" == 0 ]]; then
    xcrun stapler validate "$app"
    spctl -a -t exec -vv "$app" 2>&1 | tee "$WORK/spctl.txt"
    grep -q "accepted" "$WORK/spctl.txt" || die "Gatekeeper did not accept $app"
    grep -q "Notarized Developer ID" "$WORK/spctl.txt" || die "Gatekeeper source is not Notarized Developer ID for $app"
  fi
}

# The licences the app redistributes under: the GPL texts from the sidecar's sources and every notice.
verify_licences() {
  local dir="$1/Contents/Resources/licenses" f
  for f in README.md LICENSE-MIT LICENSE-APACHE NOTICE.md THIRD-PARTY-NOTICES.txt fonts/OFL.txt fonts/LICENSES.md \
    shaders/NOTICE.md shaders/LICENSE-APACHE beat-this/LICENSE sidecar/ffmpeg-LICENSE.md sidecar/ffmpeg-COPYING.GPLv2 \
    sidecar/x264-COPYING sidecar/x265-COPYING; do
    [[ -s "$dir/$f" ]] || die "$1 lacks licenses/$f (pnpm setup:licences, and pnpm setup:ffmpeg:release for sidecar/)"
  done
  for f in LICENSE-MIT LICENSE-APACHE NOTICE.md; do
    cmp -s "$dir/$f" "$ROOT/$f" || die "$1 carries a licenses/$f that is not this checkout's"
  done
  for f in ffmpeg-COPYING.GPLv2 x264-COPYING x265-COPYING; do
    grep -q "GNU GENERAL PUBLIC LICENSE" "$dir/sidecar/$f" && grep -q "Version 2, June 1991" "$dir/sidecar/$f" \
      || die "$1's licenses/sidecar/$f is not the GPLv2"
  done
  grep -Eq '^npm packages: [1-9]' "$dir/THIRD-PARTY-NOTICES.txt" && grep -Eq '^Rust crates: [1-9]' "$dir/THIRD-PARTY-NOTICES.txt" \
    || die "$1's THIRD-PARTY-NOTICES.txt lists no npm packages or no crates"
  log "Licences: $1 carries the GPL texts and $(grep -Ec '^(npm|crate): ' "$dir/THIRD-PARTY-NOTICES.txt") package notices"
}

# ── the zip ──────────────────────────────────────────────────────────────────
log "Unpacking $ZIP"
ditto -x -k "$ZIP" "$WORK/zip"
APP="$WORK/zip/$APP_NAME.app"
[[ -d "$APP" ]] || die "the zip does not hold $APP_NAME.app at its root"
verify_app "$APP"
verify_licences "$APP"

# ── the updater archive, what the in-app updater installs ────────────────────
log "Unpacking $UPDATER_TAR"
mkdir -p "$WORK/tar"
/usr/bin/tar -xzf "$UPDATER_TAR" -C "$WORK/tar"
[[ -z "$(/usr/bin/tar -tzf "$UPDATER_TAR" | grep -E '(^|/)\._' || true)" ]] || die "the updater tar carries AppleDouble entries"
verify_app "$WORK/tar/$APP_NAME.app"
# A rehearsal signs with a throwaway key; a real release must verify against the key installed apps trust.
if [[ "$ADHOC" == 1 ]]; then
  UPDATER_PUBKEY=$(cat "$DIR/updater-adhoc.pub")
else
  UPDATER_PUBKEY=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').plugins.updater.pubkey")
fi
node "$ROOT/scripts/verify-updater-sig.mjs" "$UPDATER_TAR" "$UPDATER_TAR.sig" "$UPDATER_PUBKEY" "$VERSION"
log "The updater signature verifies against the configured key and binds version $VERSION"
node -e '
  const m = require(process.argv[1]); const v = process.argv[2]; const sig = require("fs").readFileSync(process.argv[3], "utf8").trim();
  const p = m.platforms && m.platforms["darwin-aarch64"];
  if (m.version !== v) throw new Error(`latest.json announces ${m.version}, not ${v}`);
  if (!p || p.signature !== sig) throw new Error("latest.json signature differs from the .sig file");
  if (!p.url.endsWith(`/v${v}/${process.argv[4]}`)) throw new Error(`latest.json url does not point at the v${v} asset: ${p.url}`);
  if ("notes" in m) throw new Error("latest.json carries notes; the app never shows manifest text");
' "$LATEST_JSON" "$VERSION" "$UPDATER_TAR.sig" "$(basename "$UPDATER_TAR")"
log "latest.json is coherent with the updater archive"

# ── the DMG ──────────────────────────────────────────────────────────────────
log "Signature: $DMG"
codesign --verify --verbose=2 "$DMG"
if [[ "$ADHOC" == 0 ]]; then
  xcrun stapler validate "$DMG"
  spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | tee "$WORK/spctl-dmg.txt"
  grep -q "accepted" "$WORK/spctl-dmg.txt" || die "Gatekeeper did not accept $DMG"
fi
log "Mounting the DMG"
mkdir -p "$WORK/mnt"
ATTACH=$(hdiutil attach -readonly -nobrowse -noautoopen -mountrandom "$WORK/mnt" "$DMG" 2>/dev/null)
MOUNT=$(awk -F'\t' 'END { print $NF }' <<<"$ATTACH")
[[ -n "$MOUNT" && -d "$MOUNT/$APP_NAME.app" ]] || die "the DMG does not hold $APP_NAME.app (mounted at '${MOUNT:-nowhere}')"
# The volume holds the app we unpacked from the zip, byte for byte.
diff <(file_shas "$APP") <(file_shas "$MOUNT/$APP_NAME.app") || die "the app inside the DMG differs from the zipped app"
hdiutil detach "$MOUNT" >/dev/null 2>&1
MOUNT=""
log "The DMG holds the same app as the zip"

# ── the pkg, what an MDM installs ────────────────────────────────────────────
log "Signature: $PKG"
if [[ "$ADHOC" == 1 ]]; then
  # sign-and-notarize.sh --adhoc leaves the pkg unsigned; anything else here means it changed.
  pkgutil --check-signature "$PKG" >"$WORK/pkgsig.txt" 2>&1 || true
  grep -Fq "Status: no signature" "$WORK/pkgsig.txt" || { cat "$WORK/pkgsig.txt" >&2; die "expected the rehearsal's pkg to be unsigned"; }
  echo "    unsigned, as a rehearsal builds it"
else
  pkgutil --check-signature "$PKG" >"$WORK/pkgsig.txt" 2>&1 || { cat "$WORK/pkgsig.txt" >&2; die "$PKG is not signed"; }
  cat "$WORK/pkgsig.txt"
  grep -Fq "Status: signed by a developer certificate issued by Apple for distribution" "$WORK/pkgsig.txt" \
    || die "$PKG is not signed by an Apple-issued Developer ID certificate"
  grep -Fq "Notarization: trusted by the Apple notary service" "$WORK/pkgsig.txt" || die "$PKG is not notarised"
  grep -Fq "Signed with a trusted timestamp" "$WORK/pkgsig.txt" || die "$PKG has no trusted timestamp"
  grep -Eq '^ +1\. Developer ID Installer: ' "$WORK/pkgsig.txt" || die "$PKG is not signed by a Developer ID Installer certificate"
  grep -Eq '^ +2\. Developer ID Certification Authority' "$WORK/pkgsig.txt" || die "$PKG's chain is not Apple's Developer ID CA"
  [[ -z "${KOOKABURRA_TEAM_ID:-}" ]] || grep -Eq "^ +1\. Developer ID Installer: .*\(${KOOKABURRA_TEAM_ID}\)" "$WORK/pkgsig.txt" \
    || die "$PKG is not signed by team $KOOKABURRA_TEAM_ID"
  xcrun stapler validate "$PKG"
  spctl -a -t install -vv "$PKG" 2>&1 | tee "$WORK/spctl-pkg.txt"
  grep -q "accepted" "$WORK/spctl-pkg.txt" || die "Gatekeeper did not accept $PKG"
  grep -q "Notarized Developer ID" "$WORK/spctl-pkg.txt" || die "Gatekeeper source is not Notarized Developer ID for $PKG"
fi
log "Expanding the pkg"
pkgutil --expand-full "$PKG" "$WORK/pkg"
xq() { xmllint --xpath "$1" "$2" 2>/dev/null || true; }
expect() { [[ "$(xq "$2" "$3")" == "$4" ]] || die "the pkg's $1 is '$(xq "$2" "$3")', expected '$4'"; }
DIST="$WORK/pkg/Distribution"
[[ -f "$DIST" ]] || die "the pkg is not a product archive (no Distribution)"
expect "system domain" 'string(//domains/@enable_localSystem)' "$DIST" true
expect "any-volume domain" 'string(//domains/@enable_anywhere)' "$DIST" false
expect "home domain" 'string(//domains/@enable_currentUserHome)' "$DIST" false
expect "minimum macOS" 'string(//allowed-os-versions/os-version/@min)' "$DIST" "$MIN_OS"
expect "host architecture" 'string(//options/@hostArchitectures)' "$DIST" arm64
COMPONENTS=$(find "$WORK/pkg" -mindepth 1 -maxdepth 1 -name '*.pkg')
[[ "$(wc -l <<<"$COMPONENTS" | tr -d ' ')" == 1 && -d "$COMPONENTS" ]] || die "the pkg must hold one component, found: ${COMPONENTS:-none}"
INFO="$COMPONENTS/PackageInfo"
expect "identifier" 'string(/pkg-info/@identifier)' "$INFO" "$BUNDLE_ID"
expect "version" 'string(/pkg-info/@version)' "$INFO" "$VERSION"
expect "install location" 'string(/pkg-info/@install-location)' "$INFO" /Applications
expect "relocatable bundle count" 'count(/pkg-info/relocate/bundle)' "$INFO" 0
expect "version-checked bundle count" "count(/pkg-info/bundle-version/bundle[@id='$BUNDLE_ID'])" "$INFO" 1
expect "script count" 'count(/pkg-info/scripts/*)' "$INFO" 0
[[ "$(lsbom -p ug "$COMPONENTS/Bom" | LC_ALL=C sort -u)" == $'0\t0' ]] || die "the pkg installs files not owned by root:wheel"
# The install location's own entry must carry no mode, or Installer would rewrite /Applications.
[[ "$(lsbom -p fm "$COMPONENTS/Bom" | awk -F'\t' '$1 == "." { print $2 }')" == 0 ]] || die "the pkg sets a mode on /Applications itself"
PKG_APP="$COMPONENTS/Payload/$APP_NAME.app"
PAYLOAD=$(find "$COMPONENTS/Payload" -mindepth 1 -maxdepth 1)
[[ "$PAYLOAD" == "$PKG_APP" ]] || die "the pkg's payload must hold only $APP_NAME.app, found: $PAYLOAD"
diff <(file_shas "$APP") <(file_shas "$PKG_APP") || die "the app inside the pkg differs from the zipped app"
verify_licences "$PKG_APP"
log "The pkg installs the zip's app into /Applications, root-owned, on macOS $MIN_OS+ (arm64), with no scripts"

# ── provenance: the same files the build job produced, before anything signed runs ──
log "Sidecar digests (signature stripped)"
bash "$ROOT/scripts/sidecar-digest.sh" "$APP/Contents/MacOS/ffmpeg" "$APP/Contents/MacOS/ffprobe" | tee "$WORK/digests.txt"
if [[ -n "$DIGESTS" ]]; then
  diff <(LC_ALL=C sort "$DIGESTS") <(LC_ALL=C sort "$WORK/digests.txt") || die "the signed sidecars are not the ones the build job produced"
  log "Sidecars match the build job's record"
fi
log "Bundle digests (signatures stripped)"
bash "$ROOT/scripts/bundle-digest.sh" "$APP" >"$WORK/bundle.txt"
bash "$ROOT/scripts/bundle-digest.sh" "$WORK/tar/$APP_NAME.app" >"$WORK/bundle-tar.txt"
diff "$WORK/bundle.txt" "$WORK/bundle-tar.txt" || die "the app in the updater archive differs from the zipped app"
log "The updater archive holds the same app as the zip ($(wc -l <"$WORK/bundle.txt" | tr -d ' ') files)"
bash "$ROOT/scripts/bundle-digest.sh" "$PKG_APP" >"$WORK/bundle-pkg.txt"
diff "$WORK/bundle.txt" "$WORK/bundle-pkg.txt" || die "the app in the pkg differs from the zipped app"
log "The pkg's bundle digest equals the zip's"
if [[ -n "$BUNDLE_DIGESTS" ]]; then
  diff "$BUNDLE_DIGESTS" "$WORK/bundle.txt" || die "the signed bundle is not the one the build job produced"
  log "Every bundle file matches the build job's record"
fi

# ── the signed binary's headless CLI ─────────────────────────────────────────
BIN="$APP/Contents/MacOS/kookaburra-cut"
log "Running the signed binary: edit caps"
"$BIN" edit caps >"$WORK/caps.json"
node -e '
  const c = require(process.argv[1]); const v = process.argv[2];
  const must = (ok, msg) => { if (!ok) throw new Error(msg); };
  must(c.ok === true, "edit caps did not answer ok");
  must(c.build === "release", `edit caps reports a ${c.build} build`);
  must(c.appVersion === v, `edit caps reports ${c.appVersion}, not ${v}`);
  must(c.ffmpeg && c.ffmpeg.ok === true, "the bundled ffmpeg did not answer");
  must(c.ffprobe && c.ffprobe.ok === true, "the bundled ffprobe did not answer");
  must(Array.isArray(c.filters) && c.filters.length > 0, "the bundled ffmpeg lists no filters");
' "$WORK/caps.json" "$VERSION"

log "Running the signed binary: check flashes on a film the bundled ffmpeg renders"
"$APP/Contents/MacOS/ffmpeg" -hide_banner -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=30:duration=1" \
  -c:v libx264 -pix_fmt yuv420p -y "$WORK/film.mp4"
"$BIN" check flashes --file "$WORK/film.mp4" >"$WORK/flashes.json"
node -e '
  const r = require(process.argv[1]);
  if (r.ok !== true) throw new Error(`check flashes did not answer ok: ${JSON.stringify(r)}`);
' "$WORK/flashes.json"

echo
echo "Verified: $ZIP, $UPDATER_TAR, $DMG and $PKG$([[ "$ADHOC" == 1 ]] && echo " (ad-hoc rehearsal)")"
