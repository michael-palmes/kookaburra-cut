#!/usr/bin/env bash
#
# Signs, notarises and staples the app and the DMG, then builds the updater archive.
#
# Takes a prebuilt, unsigned .app (the release workflow's sign job) or builds one first
# (a local run). Signs inside-out itself: the two sidecars, then the bundle, hardened runtime
# and a secure timestamp. Notarises with notarytool through a keychain profile (local) or an
# App Store Connect API key (CI), which Tauri's own notarisation cannot do; Tauri also never
# notarises the DMG.
#
#   sign-and-notarize.sh [--app <unsigned.app>] [--adhoc] [--plain-dmg]
#     --app        sign this bundle instead of running `pnpm tauri build` first
#     --adhoc      ad-hoc signature, no notarisation, throwaway updater key: a rehearsal
#     --plain-dmg  hdiutil-only DMG (headless runners); the default is the styled Finder DMG
#
#   KOOKABURRA_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)" or its SHA-1
#   KOOKABURRA_TEAM_ID            when set, the signature's TeamIdentifier must match it
#   KOOKABURRA_NOTARY_PROFILE     notarytool keychain profile (xcrun notarytool store-credentials), or
#   KOOKABURRA_NOTARY_KEY_PATH + KOOKABURRA_NOTARY_KEY_ID + KOOKABURRA_NOTARY_ISSUER_ID
#                                 an App Store Connect API key (the CI path)
#   TAURI_SIGNING_PRIVATE_KEY / _PATH (+ _PASSWORD)   the updater key; --adhoc makes a throwaway one
#   TAURI_CLI                     the tauri CLI command (default "pnpm tauri"; CI passes a pinned cargo-tauri)
#
# Output in release/: Kookaburra Cut.app, KookaburraCut-<v>.dmg, KookaburraCut-<v>.zip,
#   KookaburraCut-<v>-updater.app.tar.gz (+ .sig, bound to the version) and latest.json.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

APP_IN=""
ADHOC=0
PLAIN_DMG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP_IN="${2:?--app needs a path}"; shift 2 ;;
    --adhoc) ADHOC=1; shift ;;
    --plain-dmg) PLAIN_DMG=1; shift ;;
    --help | -h) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP_NAME="Kookaburra Cut"
OUT="$ROOT/release"
APP_BUNDLE="$OUT/$APP_NAME.app"
DMG="$OUT/KookaburraCut-${VERSION}.dmg"
ZIP="$OUT/KookaburraCut-${VERSION}.zip"
UPDATER_TAR="$OUT/KookaburraCut-${VERSION}-updater.app.tar.gz"
LATEST_JSON="$OUT/latest.json"
SIDECARS=(ffmpeg ffprobe)
# Must match plugins.updater.endpoints in src-tauri/tauri.conf.json.
REPO_SLUG="michael-palmes/kookaburra-cut"
read -ra TAURI <<<"${TAURI_CLI:-pnpm tauri}"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-sign.XXXXXX")
chmod 700 "$TEMP_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

# ── preflight ────────────────────────────────────────────────────────────────
NOTARY_AUTH=()
if [[ "$ADHOC" == 1 ]]; then
  SIGN_ID="-"
  SIGN_FLAGS=(--timestamp=none)
else
  [[ -n "${KOOKABURRA_SIGNING_IDENTITY:-}" ]] || die "KOOKABURRA_SIGNING_IDENTITY is not set (security find-identity -p codesigning -v lists candidates)."
  SIGN_ID="$KOOKABURRA_SIGNING_IDENTITY"
  SIGN_FLAGS=(--timestamp)
  if [[ -n "${KOOKABURRA_NOTARY_PROFILE:-}" ]]; then
    NOTARY_AUTH=(--keychain-profile "$KOOKABURRA_NOTARY_PROFILE")
  elif [[ -n "${KOOKABURRA_NOTARY_KEY_PATH:-}" ]]; then
    [[ -n "${KOOKABURRA_NOTARY_KEY_ID:-}" && -n "${KOOKABURRA_NOTARY_ISSUER_ID:-}" ]] \
      || die "KOOKABURRA_NOTARY_KEY_PATH needs KOOKABURRA_NOTARY_KEY_ID and KOOKABURRA_NOTARY_ISSUER_ID too."
    [[ -f "$KOOKABURRA_NOTARY_KEY_PATH" ]] || die "no notary key at $KOOKABURRA_NOTARY_KEY_PATH."
    NOTARY_AUTH=(--key "$KOOKABURRA_NOTARY_KEY_PATH" --key-id "$KOOKABURRA_NOTARY_KEY_ID" --issuer "$KOOKABURRA_NOTARY_ISSUER_ID")
  else
    die "set KOOKABURRA_NOTARY_PROFILE (a notarytool keychain profile) or the KOOKABURRA_NOTARY_KEY_* trio."
  fi
  [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" || -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]] \
    || die "TAURI_SIGNING_PRIVATE_KEY (or _PATH) is not set (the updater keypair)."
  # The key password lives in the login keychain locally; an exported env var still wins.
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    if pass=$(security find-generic-password -s kookaburra-cut-updater -w 2>/dev/null); then
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass"
    fi
  fi
fi

# ── the unsigned bundle ──────────────────────────────────────────────────────
if [[ -z "$APP_IN" ]]; then
  log "Building the app bundle (unsigned)"
  "${TAURI[@]}" build --ci --no-sign
  APP_IN="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
fi
[[ -d "$APP_IN/Contents/MacOS" ]] || die "no app bundle at $APP_IN"
BUILT_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_IN/Contents/Info.plist")
[[ "$BUILT_VERSION" == "$VERSION" ]] || die "the bundle is version $BUILT_VERSION but tauri.conf.json says $VERSION."

# A dev sidecar (pnpm setup:ffmpeg) links Homebrew dylibs absent on other Macs: it signs, then fails to encode.
for name in "${SIDECARS[@]}"; do
  bin="$APP_IN/Contents/MacOS/$name"
  [[ -f "$bin" ]] || die "sidecar missing from the bundle: $bin"
  foreign=$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/|/usr/lib/)' || true)
  if [[ -n "$foreign" ]]; then
    echo "ERROR: the $name sidecar links non-system libraries, so it will not run on another Mac:" >&2
    sed 's/^/       /' <<<"$foreign" >&2
    die "run 'pnpm setup:ffmpeg:release' for the pinned static build, then rebuild."
  fi
done
log "Sidecars are self-contained (system libraries only)"

mkdir -p "$OUT"
rm -rf "$APP_BUNDLE" "$DMG" "$ZIP" "$UPDATER_TAR" "$UPDATER_TAR.sig" "$LATEST_JSON"
ditto --norsrc --noextattr --noqtn "$APP_IN" "$APP_BUNDLE"
find "$APP_BUNDLE" \( -name '._*' -o -name '.DS_Store' \) -delete
xattr -cr "$APP_BUNDLE"

# ── sign inside-out ──────────────────────────────────────────────────────────
sign() { codesign --force --options runtime "${SIGN_FLAGS[@]}" --sign "$SIGN_ID" "$@"; }
log "Signing (hardened runtime, inside-out) as $SIGN_ID"
nested=$(find "$APP_BUNDLE/Contents" -mindepth 1 -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.appex' \) -print)
[[ -z "$nested" ]] || die "the bundle holds nested code that this script does not sign:"$'\n'"$nested"
for name in "${SIDECARS[@]}"; do
  sign "$APP_BUNDLE/Contents/MacOS/$name"
done
sign "$APP_BUNDLE"

log "Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
info=$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1)
if [[ "$ADHOC" == 1 ]]; then
  grep -Fq "Signature=adhoc" <<<"$info" || die "expected an ad-hoc signature"
  grep -Eq "flags=0x10002\(adhoc,runtime\)" <<<"$info" || die "hardened runtime flag missing"
else
  grep -Fq "Authority=Developer ID Application:" <<<"$info" || die "not signed by a Developer ID Application certificate"
  grep -Eq "flags=0x10000\(runtime\)" <<<"$info" || die "expected flags=0x10000(runtime)"
  grep -Eq "^Timestamp=" <<<"$info" || die "no secure timestamp"
  if [[ -n "${KOOKABURRA_TEAM_ID:-}" ]]; then
    grep -Fq "TeamIdentifier=$KOOKABURRA_TEAM_ID" <<<"$info" || die "TeamIdentifier is not $KOOKABURRA_TEAM_ID"
  fi
fi
# Nothing in the shell needs an entitlement (docs/decisions.md); one appearing means a regression.
ent=$(codesign -d --entitlements - --xml "$APP_BUNDLE" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || true)
[[ -z "$ent" || "$ent" == "{}" ]] || die "the app carries entitlements, expected none: $ent"

# ── notarise and staple the app ──────────────────────────────────────────────
notarize() {
  local file="$1" out="$TEMP_DIR/notary-$(basename "$file").json" id status
  log "Submitting $(basename "$file") for notarisation (waits for Apple)"
  xcrun notarytool submit "$file" "${NOTARY_AUTH[@]}" --wait --timeout 1h --output-format json >"$out" || true
  id=$(node -p "try{require('$out').id||''}catch{''}")
  status=$(node -p "try{require('$out').status||''}catch{''}")
  [[ -n "$id" ]] || { cat "$out" >&2; die "notarytool submit failed"; }
  if [[ "$status" != "Accepted" ]]; then
    xcrun notarytool log "$id" "${NOTARY_AUTH[@]}" >&2 || true
    die "notarisation $id finished with status '$status'"
  fi
  echo "    accepted: submission $id"
}

if [[ "$ADHOC" == 0 ]]; then
  NOTARIZE_ZIP="$TEMP_DIR/KookaburraCutNotarize.zip"
  /usr/bin/ditto --norsrc -c -k --keepParent "$APP_BUNDLE" "$NOTARIZE_ZIP"
  notarize "$NOTARIZE_ZIP"
  log "Stapling the app ticket"
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
  # Stapling rewrites the bundle, so clear attrs that would dirty the archives below.
  xattr -cr "$APP_BUNDLE"
  find "$APP_BUNDLE" -name '._*' -delete
  log "Gatekeeper assessment (app)"
  spctl -a -t exec -vv "$APP_BUNDLE"
fi

# ── the DMG, from the stapled app ────────────────────────────────────────────
if [[ "$PLAIN_DMG" == 1 ]]; then
  # No Finder on a headless runner, so no background art or icon layout: the same app, a plain window.
  log "Building the plain DMG installer"
  STAGE="$TEMP_DIR/dmg"
  mkdir -p "$STAGE"
  cp -R "$APP_BUNDLE" "$STAGE/$APP_NAME.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -srcfolder "$STAGE" -volname "$APP_NAME" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null
  codesign --force "${SIGN_FLAGS[@]}" --sign "$SIGN_ID" "$DMG"
  codesign --verify --verbose=2 "$DMG"
else
  log "Building the styled DMG installer"
  if [[ "$ADHOC" == 1 ]]; then
    KOOKABURRA_SIGNING_IDENTITY="" "$ROOT/scripts/make-dmg.sh"
    codesign --force --timestamp=none --sign - "$DMG"
  else
    KOOKABURRA_SIGNING_IDENTITY="$SIGN_ID" "$ROOT/scripts/make-dmg.sh"
  fi
fi
[[ -f "$DMG" ]] || die "expected DMG missing at $DMG"

if [[ "$ADHOC" == 0 ]]; then
  notarize "$DMG"
  log "Stapling the DMG ticket"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  log "Gatekeeper assessment (DMG)"
  spctl -a -t open --context context:primary-signature -vv "$DMG"
fi

# ── zip and updater archive ──────────────────────────────────────────────────
log "Zipping the app"
/usr/bin/ditto --norsrc -c -k --keepParent "$APP_BUNDLE" "$ZIP"

# The in-app updater downloads this tar of the STAPLED app (bundle.createUpdaterArtifacts
# would tar the pre-staple bundle during `tauri build`, hence the hand-rolled step here).
log "Building and signing the updater archive"
(cd "$OUT" && COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs -czf "$UPDATER_TAR" "$APP_NAME.app")
if [[ "$ADHOC" == 1 ]]; then
  # A throwaway key exercises the signing path; nothing it signs is installable by a real app.
  THROWAWAY_PASSWORD=$(openssl rand -hex 16)
  "${TAURI[@]}" signer generate --ci --force -p "$THROWAWAY_PASSWORD" -w "$TEMP_DIR/updater.key" >/dev/null
  TAURI_SIGNING_PRIVATE_KEY_PATH="$TEMP_DIR/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$THROWAWAY_PASSWORD" \
    "${TAURI[@]}" signer sign --app-version "$VERSION" "$UPDATER_TAR"
else
  "${TAURI[@]}" signer sign --app-version "$VERSION" "$UPDATER_TAR"
fi
[[ -f "$UPDATER_TAR.sig" ]] || die "expected signature missing at $UPDATER_TAR.sig"
# requireSignedVersion makes the app refuse a signature without this binding.
base64 -d <"$UPDATER_TAR.sig" | sed -n 3p | tr '\t' '\n' | grep -Fxq "version:$VERSION" || die "the updater signature is not bound to version $VERSION"

# The manifest the app polls at releases/latest/download/latest.json; it points at this tag's
# versioned asset URL, so an already-downloaded manifest stays coherent after a newer release.
# No notes: the app never renders manifest text (an attacker with the GitHub account could write it).
log "Writing the updater manifest"
SIG=$(cat "$UPDATER_TAR.sig")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat >"$LATEST_JSON" <<JSON
{
  "version": "${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG}",
      "url": "https://github.com/${REPO_SLUG}/releases/download/v${VERSION}/$(basename "$UPDATER_TAR")"
    }
  }
}
JSON

echo
if [[ "$ADHOC" == 1 ]]; then
  echo "Done (ad-hoc rehearsal, not notarised, throwaway updater key): $APP_BUNDLE, $DMG, $ZIP, $UPDATER_TAR"
else
  echo "Done: $APP_BUNDLE, $DMG and $UPDATER_TAR are signed; the app and the DMG are notarised and stapled."
fi
