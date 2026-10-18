#!/usr/bin/env bash
#
# Provisions the beat-this small model the song analyser runs for beats and downbeats.
# Both ONNX files come from danigb/beat-this-rs at the commit tagged v1.1.0 (the release
# of the `beat-this` crate the app links) and must match the SHA-256 pins below. They land
# in src-tauri/resources/models/ (gitignored), which tauri.conf.json bundles as
# Contents/Resources/models/. Without them the app falls back to the DSP tracker.
#
#   pnpm setup:models                  fetch what is missing (a pinned copy in the main
#                                      checkout is reused before the network), then verify
#   setup-models.sh --from DIR         copy verified files from DIR instead of downloading
#   setup-models.sh --check [DIR]      verify only, no network (release and acceptance guards)
#   setup-models.sh --stub             placeholder files so tauri-build passes (CI)
#
set -euo pipefail

COMMIT="1ae768e78f1ad83b0ed3886241dc29ffde853c40"
BASE_URL="https://raw.githubusercontent.com/danigb/beat-this-rs/$COMMIT/models"
# file|sha256|bytes
MODELS=(
  "beat_this_small.onnx|a5f8d39d989f31859454ba27afe61c5317ca95e4d9373e6853e5361b8937172f|10555592"
  "mel_spectrogram.onnx|fdd59e65c515331308e4c8841edf99972deca646bdf6197744c2a5b7755e3de9|270742"
)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/models"

sha_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

# True when FILE exists and matches its pin.
pinned() {
  local file="$1" sha="$2"
  [[ -f "$file" ]] && [[ "$(sha_of "$file")" == "$sha" ]]
}

check_dir() {
  local dir="$1" bad=0 entry name sha
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r name sha _ <<<"$entry"
    if [[ ! -f "$dir/$name" ]]; then
      echo "missing: $dir/$name" >&2
      bad=1
    elif ! pinned "$dir/$name" "$sha"; then
      echo "mismatch: $dir/$name (sha256 $(sha_of "$dir/$name"), pinned $sha)" >&2
      bad=1
    fi
  done
  return "$bad"
}

# The main checkout of this repo when running from a linked worktree, else nothing.
main_checkout() {
  local common
  common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [[ -n "$common" ]] || return 0
  local primary
  primary="$(dirname "$common")"
  [[ "$primary" != "$ROOT" ]] && echo "$primary"
  return 0
}

install_from() {
  local src="$1" name="$2" sha="$3"
  pinned "$src" "$sha" || return 1
  cp "$src" "$DEST/$name.tmp"
  mv "$DEST/$name.tmp" "$DEST/$name"
}

download() {
  local name="$1" sha="$2" bytes="$3" tmp="$DEST/$1.download"
  echo "Downloading $name ($bytes bytes) from beat-this-rs@${COMMIT:0:7}"
  rm -f "$tmp"
  if ! curl -fsSL --retry 3 -o "$tmp" "$BASE_URL/$name"; then
    rm -f "$tmp"
    echo "error: could not download $BASE_URL/$name" >&2
    exit 1
  fi
  if ! pinned "$tmp" "$sha"; then
    echo "error: $name does not match its pin (sha256 $(sha_of "$tmp"), pinned $sha)" >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$DEST/$name"
}

MODE="fetch"
FROM=""
case "${1:-}" in
  "") ;;
  --check) MODE="check"; DEST="${2:-$DEST}" ;;
  --stub) MODE="stub" ;;
  --from)
    [[ -n "${2:-}" ]] || { echo "error: --from needs a folder" >&2; exit 2; }
    FROM="$2"
    ;;
  --help | -h) sed -n '2,14p' "$0"; exit 0 ;;
  *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
esac

if [[ "$MODE" == "check" ]]; then
  if check_dir "$DEST"; then
    echo "beat-this model OK: $DEST"
    exit 0
  fi
  echo "error: the beat-this model is missing or not the pinned build; run pnpm setup:models" >&2
  exit 1
fi

mkdir -p "$DEST"

if [[ "$MODE" == "stub" ]]; then
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r name _ _ <<<"$entry"
    [[ -f "$DEST/$name" ]] || printf 'placeholder: run pnpm setup:models\n' >"$DEST/$name"
  done
  echo "Placeholder model files in $DEST (the app will use the DSP tracker)"
  exit 0
fi

PRIMARY="$(main_checkout)"
for entry in "${MODELS[@]}"; do
  IFS='|' read -r name sha bytes <<<"$entry"
  if pinned "$DEST/$name" "$sha"; then
    echo "Up to date: $name"
    continue
  fi
  if [[ -n "$FROM" ]]; then
    install_from "$FROM/$name" "$name" "$sha" || {
      echo "error: $FROM/$name is missing or does not match its pin" >&2
      exit 1
    }
    echo "Copied: $name (from $FROM)"
  elif [[ -n "$PRIMARY" ]] && install_from "$PRIMARY/src-tauri/resources/models/$name" "$name" "$sha"; then
    echo "Copied: $name (from the main checkout)"
  else
    download "$name" "$sha" "$bytes"
  fi
done

check_dir "$DEST"
echo "beat-this model ready: $DEST"
