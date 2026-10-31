#!/usr/bin/env bash
# Renders the flat fallback icon set from AppIcon.icon; run after changing it (docs/architecture.md, "Icon / identity refresh").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS_DIR="$ROOT/src-tauri/icons"
DOCUMENT="$ICONS_DIR/AppIcon.icon"
MASTER="$ICONS_DIR/icon-source-macos-1024.png"
ICTOOL="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"

if [[ ! -d "$DOCUMENT" ]]; then
  echo "error: Icon Composer document not found at $DOCUMENT" >&2
  exit 1
fi
if [[ ! -x "$ICTOOL" ]]; then
  echo "error: ictool not found at $ICTOOL (needs Xcode 26 or later)" >&2
  exit 1
fi
if ! command -v magick >/dev/null; then
  echo "error: ImageMagick not found (brew install imagemagick)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BODY="$WORK/body.png"
SHADOW="$WORK/shadow.png"

echo "Rendering the master with ictool..."
# ictool renders edge to edge, so add macOS's margin and shadow; never re-mask the result.
"$ICTOOL" "$DOCUMENT" --export-image --output-file "$BODY" \
  --platform macOS --rendition Default --width 824 --height 824 --scale 1 >/dev/null
magick -size 1024x1024 xc:black \( "$BODY" -alpha extract \) -geometry +100+108 -composite \
  -blur 0x16 -evaluate multiply 0.26 "$SHADOW"
magick -size 1024x1024 xc:black "$SHADOW" -compose CopyOpacity -composite \
  -compose Over "$BODY" -geometry +100+100 -composite -strip "$MASTER"

echo "Generating icon set via tauri icon..."
cd "$ROOT"
pnpm tauri icon "$MASTER"

# Kookaburra Cut is a macOS-only desktop app; drop the mobile output `tauri icon`
# always emits so the committed set stays desktop-only and re-runs are clean.
rm -rf "$ICONS_DIR/ios" "$ICONS_DIR/android"

# The build script embeds icon + Info.plist at compile time and does not re-run on
# icon changes, so clean the shell package or dev keeps serving the old embed.
echo "Cleaning the shell package so the next dev run re-embeds the icon..."
cargo clean --manifest-path "$ROOT/src-tauri/Cargo.toml" -p kookaburra-cut

echo
echo "Icons regenerated in $ICONS_DIR"
echo "Next 'pnpm tauri dev' recompiles the shell with the new icon and name."
