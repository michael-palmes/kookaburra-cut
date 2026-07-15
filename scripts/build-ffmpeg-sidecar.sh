#!/usr/bin/env bash
#
# Build the RELEASE ffmpeg sidecar: a pinned, self-contained (static) binary with no
# Homebrew dylib dependencies, replacing the dev copy `setup-ffmpeg.sh` provisions.
# Links only system libraries/frameworks, so the bundled .app runs on machines without
# Homebrew. Output: src-tauri/bin/ffmpeg-aarch64-apple-darwin (Tauri externalBin).
#
#   pnpm setup:ffmpeg:release              # GPL build (libx264 + VideoToolbox + ProRes)
#   LICENSE=lgpl pnpm setup:ffmpeg:release # LGPL build (drops libx264 — VideoToolbox only)
#   FFMPEG_VERSION=8.1 ...                 # override the pinned source release
#
# GPL note (decided 2026-07-02): libx264 makes this binary GPL. It ships as a separate
# arm's-length sidecar PROCESS and the app is local-only, so this is fine today; for
# public distribution build with LICENSE=lgpl (loses the deterministic libx264 default)
# or revisit. Signing/notarisation of the binary is the v5 signing task, not this script.
#
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1}"
LICENSE="${LICENSE:-gpl}"
TRIPLE="aarch64-apple-darwin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# SIDECAR_DEST overrides the install location (e.g. build in a sandbox, install separately).
DEST="${SIDECAR_DEST:-$ROOT/src-tauri/bin/ffmpeg-$TRIPLE}"
JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d /tmp/kookaburra-ffmpeg.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

X264_PREFIX="$(brew --prefix x264 2>/dev/null || true)"
if [[ "$LICENSE" == "gpl" && ! -f "$X264_PREFIX/lib/libx264.a" ]]; then
  echo "error: static libx264 not found ($X264_PREFIX/lib/libx264.a) — 'brew install x264'." >&2
  exit 1
fi
# libx265 rides the GPL build too (v11 · M7: the H.265 export presets).
X265_PREFIX="$(brew --prefix x265 2>/dev/null || true)"
if [[ "$LICENSE" == "gpl" && ! -f "$X265_PREFIX/lib/libx265.a" ]]; then
  echo "error: static libx265 not found ($X265_PREFIX/lib/libx265.a) — 'brew install x265'." >&2
  exit 1
fi

echo "[sidecar] fetching ffmpeg-$FFMPEG_VERSION source…"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$WORK/src.tar.xz"
tar -xf "$WORK/src.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-$FFMPEG_VERSION"

# Force the STATIC libx264: link against a directory containing ONLY the .a — macOS ld
# (-search_paths_first, the default) takes whatever it finds first per directory, and
# the brew lib dir also holds the dylib, which would silently win otherwise.
CONFIG_LICENSE=()
if [[ "$LICENSE" == "gpl" ]]; then
  mkdir -p "$WORK/staticlibs"
  ln -sf "$X264_PREFIX/lib/libx264.a" "$WORK/staticlibs/libx264.a"
  ln -sf "$X265_PREFIX/lib/libx265.a" "$WORK/staticlibs/libx265.a"
  export PKG_CONFIG_PATH="$X264_PREFIX/lib/pkgconfig:$X265_PREFIX/lib/pkgconfig"
  CONFIG_LICENSE=(
    --enable-gpl
    --enable-libx264
    --enable-libx265
    --extra-cflags="-I$X264_PREFIX/include -I$X265_PREFIX/include"
    --extra-ldflags="-L$WORK/staticlibs"
    # x265 is C++ — the system libc++ is /usr/lib, so self-containment holds.
    --extra-libs="-lc++"
  )
fi

echo "[sidecar] configuring ($LICENSE)…"
./configure \
  --pkg-config-flags="--static" \
  --disable-shared --enable-static \
  --enable-videotoolbox \
  --disable-ffplay \
  --disable-doc \
  --disable-network \
  --disable-xlib --disable-sdl2 --disable-libxcb \
  --disable-vulkan \
  "${CONFIG_LICENSE[@]}" \
  >"$WORK/configure.log" 2>&1 || { tail -30 "$WORK/configure.log" >&2; exit 1; }

echo "[sidecar] building with $JOBS jobs (this takes a few minutes)…"
make -j"$JOBS" ffmpeg ffprobe >"$WORK/make.log" 2>&1 || { tail -30 "$WORK/make.log" >&2; exit 1; }

# Self-containment gate: fail if anything outside /usr/lib or /System is linked.
for bin in ffmpeg ffprobe; do
  if otool -L "$bin" | tail -n +2 | grep -vE "^\s(/usr/lib/|/System/)"; then
    echo "error: $bin has non-system dynamic dependencies (above) — not self-contained." >&2
    exit 1
  fi
done

# ffprobe installs beside ffmpeg with the same triple suffix (v6 · M4: media probing).
PROBE_DEST="$(dirname "$DEST")/ffprobe-$TRIPLE"
mkdir -p "$(dirname "$DEST")"
cp ffmpeg "$DEST"
cp ffprobe "$PROBE_DEST"
chmod +x "$DEST" "$PROBE_DEST"

echo "[sidecar] ready: $DEST"
"$DEST" -version | head -1
otool -L "$DEST" | head -5
echo "[sidecar] ready: $PROBE_DEST"
"$PROBE_DEST" -version | head -1
echo "[sidecar] NOTE: dev copies via 'pnpm setup:ffmpeg' will overwrite these."