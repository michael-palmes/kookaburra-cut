#!/usr/bin/env bash
#
# Builds the styled DMG installer from release/Kookaburra Cut.app. System tools only.
# No notarisation; sign-and-notarize.sh owns that.
#
# Needs a logged-in GUI session: Finder does the styling, so this cannot run headless.
# The first run prompts once to let the terminal drive Finder.
#
#   KOOKABURRA_SIGNING_IDENTITY   optional; signs the .dmg when set, else unsigned preview
#
# Output: release/KookaburraCut-<version>.dmg
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP_NAME="Kookaburra Cut"
VOL_NAME="Kookaburra Cut"
APP_BUNDLE="$ROOT/release/$APP_NAME.app"
BG_1X="$ROOT/src-tauri/dmg/dmg_bg.png"
BG_2X="$ROOT/src-tauri/dmg/dmg_bg@2x.png"
ICNS="$ROOT/src-tauri/icons/icon.icns"
WORK="$ROOT/.build/dmg"
STAGE="$WORK/stage"
TMP_DMG="$WORK/kookaburra-rw.dmg"
FINAL="$ROOT/release/KookaburraCut-${VERSION}.dmg"

DEV=""
cleanup() {
  [[ -n "$DEV" ]] && hdiutil detach "$DEV" -force >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

[[ -d "$APP_BUNDLE" ]] || { echo "ERROR: $APP_BUNDLE missing; run sign-and-notarize.sh first." >&2; exit 1; }
[[ -f "$BG_1X" && -f "$BG_2X" ]] || { echo "ERROR: DMG background art missing in src-tauri/dmg/." >&2; exit 1; }
[[ -f "$ICNS" ]] || { echo "ERROR: $ICNS missing; run pnpm setup:icon." >&2; exit 1; }

# The icon positions below are tuned to this exact artwork size.
check_dims() {
  local f=$1 w=$2 h=$3 dims
  dims=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null)
  grep -q "pixelWidth: $w" <<<"$dims" && grep -q "pixelHeight: $h" <<<"$dims" \
    || { echo "ERROR: $f must be ${w}x${h} (got: $dims)." >&2; exit 1; }
}
check_dims "$BG_1X" 806 488
check_dims "$BG_2X" 1612 976

# Clear a volume left mounted by a crashed earlier run.
if [[ -d "/Volumes/$VOL_NAME" ]]; then
  STRAY=$(hdiutil info | awk -v vol="/Volumes/$VOL_NAME" '
    /^\/dev\// { dev=$1 }
    index($0, vol) { print dev; exit }')
  [[ -n "${STRAY:-}" ]] && hdiutil detach "$STRAY" -force >/dev/null 2>&1 || true
fi

# A two-rep TIFF (1x first) is the only way Finder serves a crisp Retina background.
rm -rf "$WORK"
mkdir -p "$STAGE/.background"
tiffutil -cathidpicheck "$BG_1X" "$BG_2X" -out "$STAGE/.background/background.tiff"

# cp -R keeps the signed and stapled bundle intact; never xattr or re-sign it here.
cp -R "$APP_BUNDLE" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
cp "$ICNS" "$STAGE/.VolumeIcon.icns"

rm -f "$TMP_DMG"
hdiutil create -srcfolder "$STAGE" -volname "$VOL_NAME" -fs HFS+ -format UDRW -ov "$TMP_DMG" >/dev/null

# Mount at the default /Volumes/<volname>: Finder addresses the disk by name below,
# so -mountrandom fails the styling with -1728, and -nobrowse hides it from Finder.
ATTACH=$(hdiutil attach -readwrite -noverify -noautoopen "$TMP_DMG")
DEV=$(awk 'NR==1 {print $1}' <<<"$ATTACH")
MOUNT=$(grep -Eo '/Volumes/.*$' <<<"$ATTACH" | tail -1)
[[ -n "$DEV" && -d "$MOUNT" ]] || { echo "ERROR: failed to attach $TMP_DMG." >&2; exit 1; }
SetFile -a C "$MOUNT" # honour the custom .VolumeIcon.icns

# Window is 806x516: the 488pt artwork plus a ~28pt title bar, so the caption is not clipped.
# Icons sit in the artwork's drop-target circles, centred at (170,253) and (635,253) in 1x
# points; Finder lands an icon ~3pt low, hence y=250. That drops each label onto the plate
# the artwork paints at y=316..345, which is what makes the label readable in Light Mode.
# Re-measure all of this if the art or the OS title-bar height changes.
cat > "$WORK/style.applescript" <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 1006, 636}
    set viewOpts to the icon view options of container window
    set arrangement of viewOpts to not arranged
    set icon size of viewOpts to 128
    set text size of viewOpts to 12
    set background picture of viewOpts to file ".background:background.tiff"
    set position of item "$APP_NAME.app" of container window to {170, 250}
    set position of item "Applications" of container window to {635, 250}
    set position of item ".background" of container window to {1200, 1200}
    set position of item ".VolumeIcon.icns" of container window to {1200, 1200}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT

# Finder needs a moment to register a freshly attached volume, else it errors with -1728.
sleep 4
styled=0
for attempt in 1 2 3 4; do
  if osascript "$WORK/style.applescript" >/dev/null 2>&1; then styled=1; break; fi
  echo "  (Finder styling attempt $attempt did not take; retrying)" >&2
  sleep 3
done
if [[ "$styled" != "1" ]]; then
  echo "ERROR: Finder styling failed. If macOS asked to let the terminal control Finder," >&2
  echo "allow it (System Settings > Privacy & Security > Automation) and re-run." >&2
  exit 1
fi

# Wait for Finder to flush the layout to .DS_Store before unmounting.
for _ in $(seq 1 20); do
  [[ -f "$MOUNT/.DS_Store" ]] && break
  sleep 1
done
sync
rm -rf "$MOUNT/.fseventsd" 2>/dev/null || true
for _ in $(seq 1 5); do
  hdiutil detach "$DEV" >/dev/null 2>&1 && { DEV=""; break; }
  sleep 2
  hdiutil detach "$DEV" -force >/dev/null 2>&1 && { DEV=""; break; }
  sleep 2
done
[[ -z "$DEV" ]] || { echo "ERROR: could not detach $TMP_DMG." >&2; exit 1; }

mkdir -p "$ROOT/release"
rm -f "$FINAL"
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$FINAL" >/dev/null

if [[ -n "${KOOKABURRA_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$KOOKABURRA_SIGNING_IDENTITY" "$FINAL"
  codesign --verify --verbose=2 "$FINAL"
  echo "Created $FINAL (signed: $KOOKABURRA_SIGNING_IDENTITY)"
else
  echo "Created $FINAL (unsigned preview; set KOOKABURRA_SIGNING_IDENTITY to sign)"
fi
