#!/bin/zsh
# Convert the licensed-folder CC0 studio HDRIs (EXR) into bundled Radiance .hdr files
# (v8 · M1). Radiance keeps the loader simple (three's RGBELoader) and the files ~4x
# smaller than EXR; 1k is plenty — PMREM blurs reflections anyway.
#
# Converts through headless Blender (already a dev dependency — device previews render
# through it; the Homebrew ImageMagick lacks the OpenEXR delegate). Re-run after
# adding/updating EXRs.
set -euo pipefail

if [[ -z "${1:-}" && -z "${KOOKABURRA_ASSETS_DIR:-}" ]]; then
  echo "error: set KOOKABURRA_ASSETS_DIR (your private assets folder, containing HDRI/1k/)" >&2
  echo "       or pass the HDRI source folder as the first argument." >&2
  exit 2
fi
SRC="${1:-$KOOKABURRA_ASSETS_DIR/HDRI/1k}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src/assets/hdri"
BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"

if [[ ! -x "$BLENDER" ]]; then
  echo "error: Blender not found at $BLENDER" >&2
  exit 1
fi
if [[ ! -d "$SRC" ]]; then
  echo "error: HDRI source folder not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

# Bundled id (kookaburra:<name>) ← source file. Keep in sync with engine/environments.ts.
typeset -A MAP
MAP=(
  ferndale-studio ferndale_studio_07_1k.exr
  monochrome-studio monochrome_studio_01_1k.exr
  story-studio story_studio_01_1k.exr
  warehouse empty_warehouse_01_1k.exr
  night-city shanghai_bund_1k.exr
  sunset venice_sunset_1k.exr
  cyclorama cyclorama_hard_light_1k.exr
  dawn kiara_1_dawn_1k.exr
  interior lebombo_1k.exr
)

# The Blender conversion is a DETERMINISM BOUNDARY: re-converting a shipped file through a
# different Blender silently rebases every project using it, so existing outputs are skipped.
# Re-converting on purpose (a deliberate full rebase) takes KOOKABURRA_HDRI_FORCE=1.
FORCE="${KOOKABURRA_HDRI_FORCE:-0}"

for name src_file in "${(@kv)MAP}"; do
  in="$SRC/$src_file"
  out="$DEST/$name.hdr"
  if [[ -f "$out" && "$FORCE" != "1" ]]; then
    echo "skip $out (exists; KOOKABURRA_HDRI_FORCE=1 rebases)"
    continue
  fi
  if [[ ! -f "$in" ]]; then
    echo "warn: missing $in — skipped" >&2
    continue
  fi
  "$BLENDER" -b --factory-startup -P "$ROOT/scripts/exr-to-hdr.py" -- "$in" "$out" \
    | grep -E "^wrote|Error" || true
  [[ -f "$out" ]] || { echo "error: conversion failed for $in" >&2; exit 1; }
  echo "ok $out ($(du -h "$out" | cut -f1 | tr -d ' '))"
done

# Picker thumbnails (UI-only JPEGs, safe to regenerate: never an export input). Generated
# for every map with a source EXR present, skipping ones already baked.
THUMBS="$ROOT/src/assets/hdri-thumbs"
mkdir -p "$THUMBS"
for name src_file in "${(@kv)MAP}"; do
  in="$SRC/$src_file"
  thumb="$THUMBS/$name.jpg"
  [[ -f "$thumb" || ! -f "$in" ]] && continue
  "$BLENDER" -b --factory-startup -P "$ROOT/scripts/hdri-thumb.py" -- "$in" "$thumb" \
    | grep -E "^wrote|Error" || true
  [[ -f "$thumb" ]] || { echo "error: thumbnail failed for $in" >&2; exit 1; }
  echo "ok $thumb"
done
