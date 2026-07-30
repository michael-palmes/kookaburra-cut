#!/usr/bin/env bash
# One-off lighting thumbnail bake. Renders each preview-lab-lighting scene through the
# deterministic screenshot action, then downscales to the 320x180 OptionCard JPEGs in
# src/assets/lighting-thumbs/. Deliberately NOT wired into option-previews or any stale
# detection: re-run this by hand when a preset's spec (src/toolkit/lighting/presets.ts)
# or the bake scenes change, then commit the JPEGs.
# Needs a runnable dev app (pnpm install + pnpm setup:ffmpeg) and port 1420 free.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="src/assets/lighting-thumbs"
mkdir -p "$OUT"

STEMS=(
  "light-soft-studio:soft-studio"
  "light-hard-keynote:hard-keynote"
  "light-neon-corridor:neon-corridor"
  "light-golden-hour:golden-hour"
  "light-dark-rim:dark-rim"
  "light-clinical-white:clinical-white"
  "light-softbox:softbox"
)

for pair in "${STEMS[@]}"; do
  stem="${pair%%:*}"
  name="${pair##*:}"
  pnpm kookaburra:run --action screenshot --project preview-lab-lighting --scene "$stem"
  png="$(grep -o '"path": "[^"]*"' "$HOME/Kookaburra Cut/_autorun/last-run.json" | head -1 | sed 's/"path": "\(.*\)"/\1/')"
  if [[ -z "$png" || ! -f "$png" ]]; then
    echo "lighting-thumb-bake: no screenshot for $stem" >&2
    exit 1
  fi
  sips -s format jpeg -s formatOptions 82 -z 180 320 "$png" --out "$OUT/$name.jpg" >/dev/null
  echo "lighting-thumb-bake: $OUT/$name.jpg"
done
