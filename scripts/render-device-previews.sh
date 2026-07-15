#!/usr/bin/env bash
#
# Render the device-picker preview PNGs, one card per catalog colour, from the LICENSED
# vendor .blends (each colour ships its authored materials + studio setup; see
# src/assets/models/README.md for provenance). Outputs are committed, so this only reruns
# when a model or colour changes.
#
# Usage:
#   pnpm assets:device-previews            # all devices
#   DEVICE=macbook-pro-16 pnpm assets:device-previews
#   BLENDER=... SIZE=640 pnpm assets:device-previews
#
set -euo pipefail

if [[ -z "${KOOKABURRA_ASSETS_DIR:-}" ]]; then
  echo "error: set KOOKABURRA_ASSETS_DIR (your private assets folder with the licensed blends)." >&2
  exit 2
fi
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
SIZE="${SIZE:-640}"
DEVICE="${DEVICE:-all}"

if [[ ! -x "$BLENDER" ]]; then
  echo "[assets:device-previews] Blender not found at $BLENDER (override with BLENDER=...)." >&2
  exit 1
fi

# render <device-id> <colour-id> <blend-path>
render() {
  local device="$1" id="$2" blend="$3"
  local out_dir="src/assets/device-previews/$device"
  if [[ "$DEVICE" != "all" && "$DEVICE" != "$device" ]]; then return; fi
  if [[ ! -f "$blend" ]]; then
    echo "[assets:device-previews] missing source: $blend" >&2
    exit 1
  fi
  mkdir -p "$out_dir"
  echo "[assets:device-previews] $device/$id"
  "$BLENDER" -b "$blend" --python scripts/blender-render-preview.py -- \
    "$PWD/$out_dir/$id.png" "$SIZE" >/dev/null
}

SRC15="$KOOKABURRA_ASSETS_DIR/Licensed Apple iPhone 15 Pro"
render iphone-15-pro natural-titanium "$SRC15/APPLE_iPhone 15 Pro_Natural Titanium.blend"
render iphone-15-pro blue-titanium "$SRC15/APPLE_iPhone 15 Pro_Blue Titanium.blend"
render iphone-15-pro white-titanium "$SRC15/APPLE_iPhone 15 Pro_White Titanium.blend"
render iphone-15-pro black-titanium "$SRC15/APPLE_iPhone 15 Pro_Black Titanium.blend"

SRC17="$KOOKABURRA_ASSETS_DIR/Licensed iPhone 17 Pro/uploads_files_6761789_APPLE_iPhone+17+Pro_BLEND"
render iphone-17-pro silver "$SRC17/APPLE_iPhone 17 Pro_Silver.blend"
render iphone-17-pro cosmic-orange "$SRC17/APPLE_iPhone 17 Pro_Cosmic Orange.blend"
render iphone-17-pro deep-blue "$SRC17/APPLE_iPhone 17 Pro_Deep Blue.blend"

SRCMBP="$KOOKABURRA_ASSETS_DIR/Licensed Apple 2023 M2 MacBook Pro/uploads-files-4559180-APPLE_M2+MacBook+Pro_2023_BLEND"
render macbook-pro-16 silver "$SRCMBP/APPLE_M2 MacBook Pro_2023_16 Inch_Silver.blend"
render macbook-pro-16 space-grey "$SRCMBP/APPLE_M2 MacBook Pro_2023_16 Inch_Space Grey.blend"

echo "[assets:device-previews] done:"
ls -lh src/assets/device-previews/*/
