#!/usr/bin/env bash
#
# Developer ID signs, notarises and staples the app and the DMG.
#
# Tauri does the signing: it walks the bundle and signs the sidecars and nested code
# inside-out. This script does all the notarising, because Tauri's built-in
# notarisation cannot use a keychain profile and never notarises the DMG.
#
#   KOOKABURRA_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   KOOKABURRA_NOTARY_PROFILE     notarytool keychain profile, created once with:
#                                   xcrun notarytool store-credentials <name> \
#                                     --apple-id <email> --team-id <TEAMID> --password <app-specific>
#   TAURI_SIGNING_PRIVATE_KEY / _PATH   updater keypair (pnpm tauri signer generate);
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password; falls back to the login-keychain
#                                       item "kookaburra-cut-updater", else the sign step prompts.
#
# Output: release/Kookaburra Cut.app, release/KookaburraCut-<version>.dmg and
#         release/KookaburraCut-<version>-updater.app.tar.gz (+ .sig)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP_NAME="Kookaburra Cut"
APP_BUNDLE="$ROOT/release/$APP_NAME.app"
BUILT_APP="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DMG="$ROOT/release/KookaburraCut-${VERSION}.dmg"
SIDECARS=(ffmpeg ffprobe)
TRIPLE="aarch64-apple-darwin"

if [[ -z "${KOOKABURRA_SIGNING_IDENTITY:-}" ]]; then
  echo "ERROR: KOOKABURRA_SIGNING_IDENTITY is not set." >&2
  echo "       List candidates with: security find-identity -p codesigning -v" >&2
  exit 1
fi
if [[ -z "${KOOKABURRA_NOTARY_PROFILE:-}" ]]; then
  echo "ERROR: KOOKABURRA_NOTARY_PROFILE is not set (a notarytool keychain profile)." >&2
  echo "       Create one once with: xcrun notarytool store-credentials <name> ..." >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "ERROR: TAURI_SIGNING_PRIVATE_KEY (or _PATH) is not set (the updater keypair)." >&2
  echo "       Generate once with: pnpm tauri signer generate -w ~/.tauri/kookaburra-cut-updater.key" >&2
  exit 1
fi
# The key password lives in the login keychain; an exported env var still wins.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  if pass=$(security find-generic-password -s kookaburra-cut-updater -w 2>/dev/null); then
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass"
  fi
fi

# pnpm setup:ffmpeg copies the Homebrew ffmpeg, whose dylibs are absent on other Macs.
# Such a bundle signs and notarises fine, then fails to encode for the user.
for name in "${SIDECARS[@]}"; do
  bin="$ROOT/src-tauri/bin/${name}-${TRIPLE}"
  [[ -f "$bin" ]] || { echo "ERROR: sidecar missing: $bin; run 'pnpm setup:ffmpeg:release'." >&2; exit 1; }
  foreign=$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/|/usr/lib/)' || true)
  if [[ -n "$foreign" ]]; then
    echo "ERROR: the $name sidecar links non-system libraries, so it will not run on another Mac:" >&2
    sed 's/^/       /' <<<"$foreign" >&2
    echo "       Run 'pnpm setup:ffmpeg:release' for the pinned static build, then retry." >&2
    exit 1
  fi
done
echo "==> Sidecars are self-contained (system libraries only)"

if ! compgen -G "$ROOT/src/assets/models/licensed/*.glb" >/dev/null; then
  echo "ERROR: no licensed device model in src/assets/models/licensed/; run 'pnpm assets:phone'." >&2
  exit 1
fi

# Tauri signs but does not notarise: APPLE_ID and APPLE_API_KEY are deliberately unset.
echo "==> Building and signing the app bundle (Developer ID, hardened runtime)"
APPLE_SIGNING_IDENTITY="$KOOKABURRA_SIGNING_IDENTITY" pnpm tauri build

[[ -d "$BUILT_APP" ]] || { echo "ERROR: expected bundle missing at $BUILT_APP" >&2; exit 1; }

mkdir -p "$ROOT/release"
rm -rf "$APP_BUNDLE"
ditto "$BUILT_APP" "$APP_BUNDLE"

echo "==> Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
for name in "${SIDECARS[@]}"; do
  sidecar=$(find "$APP_BUNDLE/Contents" -type f -name "$name" -perm -u+x | head -1)
  [[ -n "$sidecar" ]] || { echo "ERROR: $name is not in the bundle." >&2; exit 1; }
  codesign --verify --strict "$sidecar"
done

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-notarize.XXXXXX")
chmod 700 "$TEMP_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

NOTARIZE_ZIP="$TEMP_DIR/KookaburraCutNotarize.zip"
/usr/bin/ditto --norsrc -c -k --keepParent "$APP_BUNDLE" "$NOTARIZE_ZIP"

echo "==> Submitting the app for notarisation (waits for Apple)"
xcrun notarytool submit "$NOTARIZE_ZIP" --keychain-profile "$KOOKABURRA_NOTARY_PROFILE" --wait

echo "==> Stapling the ticket"
xcrun stapler staple "$APP_BUNDLE"
xcrun stapler validate "$APP_BUNDLE"

# Stapling rewrites the bundle, so clear attrs that would dirty the zip below.
xattr -cr "$APP_BUNDLE"
find "$APP_BUNDLE" -name '._*' -delete

echo "==> Gatekeeper assessment (app)"
spctl -a -t exec -vv "$APP_BUNDLE"

# The DMG is built from the stapled app, then notarised in its own right.
echo "==> Building the styled DMG installer"
"$ROOT/scripts/make-dmg.sh"
[[ -f "$DMG" ]] || { echo "ERROR: expected DMG missing at $DMG" >&2; exit 1; }

echo "==> Submitting the DMG for notarisation (waits for Apple)"
xcrun notarytool submit "$DMG" --keychain-profile "$KOOKABURRA_NOTARY_PROFILE" --wait

echo "==> Stapling the DMG ticket"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

echo "==> Gatekeeper assessment (DMG)"
spctl -a -t open --context context:primary-signature -vv "$DMG"

# The in-app updater downloads this tar of the STAPLED app (bundle.createUpdaterArtifacts
# would tar the pre-staple bundle during `tauri build`, hence the hand-rolled step here).
UPDATER_TAR="$ROOT/release/KookaburraCut-${VERSION}-updater.app.tar.gz"
echo "==> Building and signing the updater archive"
rm -f "$UPDATER_TAR" "$UPDATER_TAR.sig"
(cd "$ROOT/release" && COPYFILE_DISABLE=1 /usr/bin/tar -czf "$UPDATER_TAR" "$APP_NAME.app")
pnpm tauri signer sign "$UPDATER_TAR"
[[ -f "$UPDATER_TAR.sig" ]] || { echo "ERROR: expected signature missing at $UPDATER_TAR.sig" >&2; exit 1; }

echo "Done: $APP_BUNDLE, $DMG and $UPDATER_TAR are signed (app and DMG notarised and stapled)."
