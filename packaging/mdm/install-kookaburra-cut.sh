#!/bin/bash
# Installs Kookaburra Cut from its release DMG once the pinned SHA-256 and Developer ID team check out (docs/fleet-deployment.md).
set -euo pipefail

VERSION="${4:-0.25.0}"
DMG_SHA256="${5:-4431f9b5a89b2583effb66c74bde744a9c1ff777a6731322c856126fa654b40a}"
BASE_URL="${6:-https://github.com/michael-palmes/kookaburra-cut/releases/download/v$VERSION}"

TEAM_ID="Q4B8N8ZKA2"
APP="/Applications/Kookaburra Cut.app"
DMG="KookaburraCut-$VERSION.dmg"

say() { echo "kookaburra-cut: $*"; }
fail() {
  say "$1"
  exit "${2:-1}"
}
version_of() {
  [ -f "$1/Contents/Info.plist" ] || return 0
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || true
}
check() {
  codesign --verify --deep --strict "$1" 2>/dev/null || fail "$1 fails its code signature check"
  local signer
  signer="$(codesign -dv "$1" 2>&1)"
  grep -qx "TeamIdentifier=$TEAM_ID" <<<"$signer" || fail "$1 is not signed by team $TEAM_ID"
  spctl -a -t exec "$1" 2>/dev/null || fail "Gatekeeper rejects $1"
  [ "$(version_of "$1")" = "$VERSION" ] || fail "$1 is not version $VERSION"
}

[ "$(id -u)" -eq 0 ] || fail "run this as root, as your MDM does"
[ "$(uname -m)" = arm64 ] || fail "Kookaburra Cut needs Apple Silicon" 2
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] || fail "Kookaburra Cut needs macOS 26 or later" 2
installed="$(version_of "$APP")"
if [ "$installed" = "$VERSION" ]; then
  say "$VERSION is already installed"
  exit 0
fi
if [ -n "$installed" ] && [ "$(printf '%s\n' "$installed" "$VERSION" | sort -V | tail -1)" = "$installed" ]; then
  say "$installed is newer than $VERSION; leaving it"
  exit 0
fi
if pgrep -qf "^$APP/Contents/MacOS/"; then
  fail "the app is open; the next run tries again" 3
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-cut.XXXXXX")"
trap 'hdiutil detach -quiet "$work/mnt" 2>/dev/null || true; rm -rf "$work"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/$DMG" "$BASE_URL/$DMG" || fail "could not download $BASE_URL/$DMG"
echo "$DMG_SHA256  $work/$DMG" | shasum -a 256 -c - >/dev/null 2>&1 || fail "$DMG does not match the pinned SHA-256"

mkdir "$work/mnt" "$work/stage"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$work/mnt" "$work/$DMG" || fail "could not open $DMG"
check "$work/mnt/Kookaburra Cut.app"
ditto "$work/mnt/Kookaburra Cut.app" "$work/stage/Kookaburra Cut.app"
chown -R root:wheel "$work/stage/Kookaburra Cut.app"
check "$work/stage/Kookaburra Cut.app"

rm -rf "$APP"
mv "$work/stage/Kookaburra Cut.app" "$APP" || fail "could not move the new app into /Applications"
check "$APP"
say "installed $VERSION"
