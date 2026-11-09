#!/bin/bash
# Removes Kookaburra Cut and each account's app data, the cask's zap list; projects and Keychain keys stay (docs/fleet-deployment.md).
set -euo pipefail

APP="/Applications/Kookaburra Cut.app"

[ "$(id -u)" -eq 0 ] || {
  echo "kookaburra-cut: run this as root, as your MDM does"
  exit 1
}
if pgrep -qf "^$APP/Contents/MacOS/"; then
  echo "kookaburra-cut: the app is open; the next run tries again"
  exit 3
fi

rm -rf "$APP"
if pkgutil --pkg-info com.mpalmes.kookaburracut >/dev/null 2>&1; then
  pkgutil --forget com.mpalmes.kookaburracut >/dev/null
fi

for home in /Users/*; do
  [ -d "$home/Library" ] || continue
  rm -rf \
    "$home/Kookaburra Cut/_autorun" \
    "$home/Kookaburra Cut/_bridge" \
    "$home/Library/Application Support/com.mpalmes.kookaburracut" \
    "$home/Library/Caches/com.mpalmes.kookaburracut" \
    "$home/Library/Preferences/com.mpalmes.kookaburracut.plist" \
    "$home/Library/WebKit/com.mpalmes.kookaburracut"
done
echo "kookaburra-cut: removed"
