#!/usr/bin/env bash
#
# Prepare the generated Android (Pixel-style) device: convert the unlicensed OBJ to GLB
# (Blender), optimise it (gltf-transform, no Draco/KTX2, since CDN decoders break offline
# export), then render the picker previews. Unlike the licensed vendor models, the OBJ is
# generated, so its GLB + previews are COMMITTED. Provenance and the model contract live in
# src/assets/models/README.md.
#
# Usage:
#   KOOKABURRA_ANDROID_OBJ=/path/to/android.obj pnpm assets:android
#   bash scripts/prepare-android-model.sh /path/to/android.obj
#
set -euo pipefail

OBJ="${1:-${KOOKABURRA_ANDROID_OBJ:-}}"
if [[ -z "$OBJ" ]]; then
  echo "error: set KOOKABURRA_ANDROID_OBJ to the generated android.obj, or pass its path." >&2
  exit 2
fi
if [[ ! -f "$OBJ" ]]; then
  echo "[assets:android] source OBJ not found: $OBJ" >&2
  exit 1
fi

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
if [[ ! -x "$BLENDER" ]]; then
  echo "[assets:android] Blender not found at $BLENDER (override with BLENDER=...)." >&2
  exit 1
fi

OUT="src/assets/models/android.glb"
PREVIEWS="src/assets/device-previews/android"
TMPDIR="$(mktemp -d)"
RAW="$TMPDIR/android-raw.glb"

mkdir -p "$(dirname "$OUT")" "$PREVIEWS"

echo "[assets:android] converting: $OBJ"
"$BLENDER" -b --python scripts/prepare-android-model.py -- "$OBJ" "$RAW"

echo "[assets:android] optimising -> $OUT"
# Palette OFF: it fuses materials into anonymous names, breaking the catalog's colour
# overrides and screen lookup. Simplify OFF: hard-surface detail (buttons, camera rings).
pnpm dlx --allow-build=sharp @gltf-transform/cli@latest optimize "$RAW" "$OUT" \
  --compress false \
  --palette false \
  --simplify false \
  --texture-compress webp \
  --texture-size 2048

echo "[assets:android] rendering previews -> $PREVIEWS"
"$BLENDER" -b --python scripts/render-android-previews.py -- "$OUT" "$PREVIEWS"

echo "[assets:android] done:"
ls -lh "$OUT" "$PREVIEWS"/*.png
