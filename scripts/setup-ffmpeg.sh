#!/usr/bin/env bash
#
# Provisions the ffmpeg sidecar binary that Kookaburra Cut bundles via tauri.conf.json
# (`bundle.externalBin: ["bin/ffmpeg"]`). Tauri resolves the target-triple-suffixed
# file `bin/ffmpeg-<triple>` and bundles it as `ffmpeg` inside the .app.
#
#   DEV (this script):  copies the system ffmpeg so the export path is testable now.
#   RELEASE (manual):   replace with a signed LGPL VideoToolbox build that enables
#                       h264_videotoolbox + prores_ks / prores_videotoolbox, then
#                       codesign + staple it — otherwise Gatekeeper blocks the .app.
#                       (libx264 makes the binary GPL; ship VideoToolbox by default.)
#
set -euo pipefail

TRIPLE="aarch64-apple-darwin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/src-tauri/bin"
DEST="$DEST_DIR/ffmpeg-$TRIPLE"

mkdir -p "$DEST_DIR"

SRC="$(command -v ffmpeg || true)"
if [[ -z "$SRC" ]]; then
  echo "error: no system ffmpeg on PATH." >&2
  echo "       install one (e.g. 'brew install ffmpeg') or drop a build at:" >&2
  echo "       $DEST" >&2
  exit 1
fi

rm -f "$DEST" # may exist read-only (a prior copy of a read-only Homebrew binary)
cp "$SRC" "$DEST"
chmod 755 "$DEST"

# ffprobe rides along (v6 · M4: media metadata probing). Same triple-suffix contract.
PROBE_SRC="$(command -v ffprobe || true)"
PROBE_DEST="$DEST_DIR/ffprobe-$TRIPLE"
if [[ -n "$PROBE_SRC" ]]; then
  rm -f "$PROBE_DEST"
  cp "$PROBE_SRC" "$PROBE_DEST"
  chmod 755 "$PROBE_DEST"
else
  echo "warning: no system ffprobe on PATH — media metadata probing won't work." >&2
fi

echo "Sidecar ready: $DEST"
"$DEST" -version | head -1
if [[ -n "$PROBE_SRC" ]]; then
  echo "Sidecar ready: $PROBE_DEST"
  "$PROBE_DEST" -version | head -1
fi
echo
echo "NOTE: this is a DEV copy of your system ffmpeg. For a shareable .app, replace"
echo "      it with a signed LGPL VideoToolbox build (see header of this script)."
