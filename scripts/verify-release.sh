#!/usr/bin/env bash
#
# Verifies a signed release set on a machine that never held a key: the release workflow's
# verify job, and the last step of a local rehearsal. Checks the signatures, notarisation and
# Gatekeeper verdicts, runs the signed binary's headless CLI, and compares the sidecars'
# signature-stripped digests with the ones the build job recorded.
#
#   verify-release.sh [--adhoc] [--dir release/] [--sidecar-digests <file>]
#     --adhoc             an ad-hoc rehearsal: no notarisation or Gatekeeper checks
#     --dir DIR           where the zip, DMG, updater tar and latest.json are (default release/)
#     --sidecar-digests   the build job's `sidecar-digest.sh` output to compare against
#   KOOKABURRA_TEAM_ID    when set, every signature's TeamIdentifier must match it
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")
APP_NAME="Kookaburra Cut"
DIR="$ROOT/release"
ADHOC=0
DIGESTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --adhoc) ADHOC=1; shift ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --sidecar-digests) DIGESTS="${2:?--sidecar-digests needs a file}"; shift 2 ;;
    --help | -h) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
DIR=$(cd "$DIR" && pwd)
ZIP="$DIR/KookaburraCut-${VERSION}.zip"
DMG="$DIR/KookaburraCut-${VERSION}.dmg"
UPDATER_TAR="$DIR/KookaburraCut-${VERSION}-updater.app.tar.gz"
LATEST_JSON="$DIR/latest.json"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }
for f in "$ZIP" "$DMG" "$UPDATER_TAR" "$UPDATER_TAR.sig" "$LATEST_JSON"; do
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

verify_app() {
  local app="$1" ent
  log "Signature: $app"
  verify_code "$app"
  for sidecar in ffmpeg ffprobe; do verify_code "$app/Contents/MacOS/$sidecar"; done
  ent=$(codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || true)
  [[ -z "$ent" || "$ent" == "{}" ]] || die "$app carries entitlements, expected none: $ent"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$VERSION" ]] \
    || die "$app is not version $VERSION"
  if [[ "$ADHOC" == 0 ]]; then
    xcrun stapler validate "$app"
    spctl -a -t exec -vv "$app" 2>&1 | tee "$WORK/spctl.txt"
    grep -q "accepted" "$WORK/spctl.txt" || die "Gatekeeper did not accept $app"
    grep -q "Notarized Developer ID" "$WORK/spctl.txt" || die "Gatekeeper source is not Notarized Developer ID for $app"
  fi
}

# ── the zip ──────────────────────────────────────────────────────────────────
log "Unpacking $ZIP"
ditto -x -k "$ZIP" "$WORK/zip"
APP="$WORK/zip/$APP_NAME.app"
[[ -d "$APP" ]] || die "the zip does not hold $APP_NAME.app at its root"
verify_app "$APP"

# ── the updater archive, what the in-app updater installs ────────────────────
log "Unpacking $UPDATER_TAR"
mkdir -p "$WORK/tar"
/usr/bin/tar -xzf "$UPDATER_TAR" -C "$WORK/tar"
[[ -z "$(/usr/bin/tar -tzf "$UPDATER_TAR" | grep -E '(^|/)\._' || true)" ]] || die "the updater tar carries AppleDouble entries"
verify_app "$WORK/tar/$APP_NAME.app"
base64 -d <"$UPDATER_TAR.sig" | grep -Fq "version:$VERSION" || die "the updater signature is not bound to version $VERSION"
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
diff <(cd "$APP" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) \
     <(cd "$MOUNT/$APP_NAME.app" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) \
  || die "the app inside the DMG differs from the zipped app"
hdiutil detach "$MOUNT" >/dev/null 2>&1
MOUNT=""
log "The DMG holds the same app as the zip"

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

# ── sidecar provenance: the same code the build job produced ─────────────────
log "Sidecar digests (signature stripped)"
bash "$ROOT/scripts/sidecar-digest.sh" "$APP/Contents/MacOS/ffmpeg" "$APP/Contents/MacOS/ffprobe" | tee "$WORK/digests.txt"
if [[ -n "$DIGESTS" ]]; then
  diff <(LC_ALL=C sort "$DIGESTS") <(LC_ALL=C sort "$WORK/digests.txt") || die "the signed sidecars are not the ones the build job produced"
  log "Sidecars match the build job's record"
fi

echo
echo "Verified: $ZIP, $UPDATER_TAR and $DMG$([[ "$ADHOC" == 1 ]] && echo " (ad-hoc rehearsal)")"
