#!/usr/bin/env bash
#
# Generates Kookaburra Cut's app icon set from the brand master.
#
# The master (icon-source-macos-1024.png) is exported from Icon Composer with the
# macOS shape, margins and edge treatment ALREADY baked in — do not re-mask or
# re-tile it here (doing so double-borders the Dock icon). This script only runs
# `tauri icon` to emit every platform size into src-tauri/icons/ and prunes the
# mobile output. The raw square layer is kept beside it as icon-source-1024.png
# for reference only.
#
# Re-run after replacing the master:  pnpm setup:icon
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS_DIR="$ROOT/src-tauri/icons"
MASTER="$ICONS_DIR/icon-source-macos-1024.png"

if [[ ! -f "$MASTER" ]]; then
  echo "error: master not found at $MASTER" >&2
  echo "       export a 1024px icon from Icon Composer and place it there." >&2
  exit 1
fi

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
