#!/usr/bin/env bash
#
# Prepare a bundled device model: headless-export a licensed vendor .blend to GLB, then
# optimise it for the web (resize textures + WebP, dedup/prune/weld) WITHOUT Draco/KTX2 —
# those need decoders drei's useGLTF fetches from a CDN, breaking offline/deterministic
# export (see docs/determinism.md). Outputs are gitignored; provenance and the model
# contract live in src/assets/models/README.md.
#
# Usage:
#   bash scripts/prepare-device-model.sh <device-id> [path/to/model.blend]
#   pnpm assets:phone | assets:iphone-17-pro | assets:macbook-pro-16 | assets:devices
#
set -euo pipefail

DEVICE="${1:-}"
if [[ -z "$DEVICE" ]]; then
  echo "usage: prepare-device-model.sh <iphone-15-pro|iphone-17-pro|macbook-pro-16> [blend]" >&2
  exit 2
fi

if [[ -z "${2:-}" && -z "${BLEND:-}" && -z "${KOOKABURRA_ASSETS_DIR:-}" ]]; then
  echo "error: set KOOKABURRA_ASSETS_DIR (your private assets folder, containing the licensed" >&2
  echo "       vendor blends), or pass the .blend path as the second argument / BLEND env." >&2
  exit 2
fi

# Per-device table: geometry-source .blend (colours are catalog overrides on one glb),
# bundled output name, and the corrective yaw that makes the screen face glTF +Z at
# identity rotation (the app's front-on contract, verified via blender-render-glb-check.py).
# Outputs are UUIDs, not product names, so bundled asset filenames stay trade-dress-neutral;
# the device-id to UUID mapping lives here and in src/toolkit/device/modelUrl.ts.
case "$DEVICE" in
  iphone-15-pro)
    DEFAULT_BLEND="${KOOKABURRA_ASSETS_DIR:-}/Licensed Apple iPhone 15 Pro/APPLE_iPhone 15 Pro_Natural Titanium.blend"
    OUT="src/assets/models/licensed/6241bad0-f016-4c0f-95c0-9aac0930a6ac.glb"
    YAW=0
    ;;
  iphone-17-pro)
    DEFAULT_BLEND="${KOOKABURRA_ASSETS_DIR:-}/Licensed iPhone 17 Pro/uploads_files_6761789_APPLE_iPhone+17+Pro_BLEND/APPLE_iPhone 17 Pro_Silver.blend"
    OUT="src/assets/models/licensed/e1bfddac-38f7-48a6-adf0-0d0120b7e937.glb"
    YAW=180
    ;;
  macbook-pro-16)
    DEFAULT_BLEND="${KOOKABURRA_ASSETS_DIR:-}/Licensed Apple 2023 M2 MacBook Pro/uploads-files-4559180-APPLE_M2+MacBook+Pro_2023_BLEND/APPLE_M2 MacBook Pro_2023_16 Inch_Silver.blend"
    OUT="src/assets/models/licensed/b30d3bc4-a66b-4376-95d1-30978b87212c.glb"
    YAW=0
    # Join/flatten would merge the lid into the body; the DISPLAY hinge node must survive for the lid-angle control.
    # Simplify OFF: even with locked borders it creases the wide keycaps (spacebar, right shift, F3, F5).
    EXTRA_FLAGS="--join false --flatten false --simplify false"
    ;;
  *)
    echo "[assets:$DEVICE] unknown device id: $DEVICE" >&2
    exit 2
    ;;
esac

BLEND="${2:-${BLEND:-$DEFAULT_BLEND}}"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
TEXTURE_SIZE="${TEXTURE_SIZE:-2048}"
EXTRA_FLAGS="${EXTRA_FLAGS:-}"
TMPDIR="$(mktemp -d)"
RAW="$TMPDIR/$DEVICE-raw.glb"

if [[ ! -f "$BLEND" ]]; then
  echo "[assets:$DEVICE] source .blend not found: $BLEND" >&2
  echo "  pass one explicitly:  bash scripts/prepare-device-model.sh $DEVICE /path/to/model.blend" >&2
  exit 1
fi
if [[ ! -x "$BLENDER" ]]; then
  echo "[assets:$DEVICE] Blender not found at $BLENDER (override with BLENDER=...)." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

echo "[assets:$DEVICE] exporting: $BLEND (yaw $YAW)"
"$BLENDER" -b "$BLEND" --python scripts/blender-export-glb.py -- "$RAW" "$YAW"

echo "[assets:$DEVICE] optimising -> $OUT"
# sharp needs its native postinstall; pnpm dlx blocks build scripts unless allowed.
# Palette OFF: it fuses materials into anonymous PaletteMaterialNNN, destroying the
# material names the catalog's colour overrides and screen lookup key on.
# Simplify keeps its topological borders locked and its error budget near zero: the
# defaults (borders free, error 0.0001) collapse keycap rims and speaker perforations.
# shellcheck disable=SC2086 -- EXTRA_FLAGS is a deliberate word-split flag list
pnpm dlx --allow-build=sharp @gltf-transform/cli@latest optimize "$RAW" "$OUT" \
  --compress false \
  --palette false \
  --texture-compress webp \
  --texture-size "$TEXTURE_SIZE" \
  --simplify-lock-border true \
  --simplify-error 0.00001 \
  $EXTRA_FLAGS

echo "[assets:$DEVICE] done:"
ls -lh "$OUT"
