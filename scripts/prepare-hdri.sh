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
)

for name src_file in "${(@kv)MAP}"; do
  in="$SRC/$src_file"
  out="$DEST/$name.hdr"
  if [[ ! -f "$in" ]]; then
    echo "warn: missing $in — skipped" >&2
    continue
  fi
  "$BLENDER" -b --factory-startup -P "$ROOT/scripts/exr-to-hdr.py" -- "$in" "$out" \
    | grep -E "^wrote|Error" || true
  [[ -f "$out" ]] || { echo "error: conversion failed for $in" >&2; exit 1; }
  echo "ok $out ($(du -h "$out" | cut -f1 | tr -d ' '))"
done
