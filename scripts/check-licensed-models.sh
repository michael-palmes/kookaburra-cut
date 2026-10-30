#!/usr/bin/env bash
#
# Checks the licensed device models a release build needs. Licensed glbs resolve through
# import.meta.glob at BUILD time, so a missing file silently HIDES that device in the shipped
# app (0.15.0 shipped without the iPad this way). Each mapped glb must exist and match
# src/assets/models/licensed.sha256, the pins the release workflow unpacks against.
#
#   check-licensed-models.sh [DIR]   DIR defaults to src/assets/models/licensed
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-$ROOT/src/assets/models/licensed}"
PINS="$ROOT/src/assets/models/licensed.sha256"
bad=0

while IFS='|' read -r model_const glb; do
  [[ -n "$glb" ]] || continue
  if [[ ! -f "$DIR/$glb" ]]; then
    echo "missing: $model_const -> $glb" >&2
    bad=1
    continue
  fi
  want="$(awk -v f="$glb" '$2 == f { print $1 }' "$PINS")"
  if [[ -z "$want" ]]; then
    echo "unpinned: $glb has no line in $PINS" >&2
    bad=1
  elif [[ "$(shasum -a 256 "$DIR/$glb" | cut -d' ' -f1)" != "$want" ]]; then
    echo "mismatch: $glb does not match its pin in $PINS" >&2
    bad=1
  fi
done < <(sed -nE 's/^const ([A-Z0-9_]+)_GLB = "([^"]+\.glb)".*/\1|\2/p' "$ROOT/src/toolkit/device/modelUrl.ts")

if [[ "$bad" != 0 ]]; then
  echo "error: licensed device models missing or unpinned in $DIR; those devices would be HIDDEN in the shipped app." >&2
  echo "       Regenerate with KOOKABURRA_ASSETS_DIR=<private assets folder> pnpm assets:devices, or unpack the licensed archive (src/assets/models/README.md)." >&2
  exit 1
fi
echo "licensed device models OK: $DIR"
