#!/usr/bin/env bash
#
# Build the RELEASE ffmpeg sidecar: a pinned, self-contained (static) binary with no
# Homebrew dylib dependencies, replacing the dev copy `setup-ffmpeg.sh` provisions.
# Every shipped byte comes from pinned source: the ffmpeg tarball is checked against
# FFMPEG_SHA256, x264 against a commit, x265 against its release tarball's SHA-256.
# Homebrew supplies build tools only (nasm, cmake), never code that ships.
# Output: src-tauri/bin/ffmpeg-aarch64-apple-darwin and ffprobe-aarch64-apple-darwin.
#
#   pnpm setup:ffmpeg:release              # GPL build (libx264 + libx265 + VideoToolbox + ProRes)
#   LICENSE=lgpl pnpm setup:ffmpeg:release # LGPL build (drops libx264 and libx265)
#   build-ffmpeg-sidecar.sh --print-pins   # the pins as KEY=VALUE lines, nothing built
#
# Bumping a pin: change the version, run once, paste the hash the script reports.
# The release workflow builds this exact recipe on a clean runner.
#
# GPL note (decided 2026-07-02): libx264 makes this binary GPL. It ships as a separate
# arm's-length sidecar PROCESS and the app is local-only, so this is fine today; for
# public distribution build with LICENSE=lgpl (loses the deterministic libx264 default)
# or revisit.
#
set -euo pipefail

FFMPEG_VERSION="8.1"
FFMPEG_SHA256="b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a"
# x264 has no releases; Homebrew's r3222 is this commit.
X264_COMMIT="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
X264_URL="https://code.videolan.org/videolan/x264.git"
# libx264 stamps this into every H.264 stream's SEI, so it is part of the export bytes.
X264_SEI="x264 - core 165 r3222 b35605a"
X265_VERSION="4.3"
X265_SHA256="83c53e4c8bbb8f1e33ed59e10a7d621d1d7801ca853910c3eb41f038b8ffb121"

if [[ "${1:-}" == "--print-pins" ]]; then
  printf 'FFMPEG_VERSION=%s\nFFMPEG_SHA256=%s\nX264_COMMIT=%s\nX264_SEI=%s\nX265_VERSION=%s\nX265_SHA256=%s\n' \
    "$FFMPEG_VERSION" "$FFMPEG_SHA256" "$X264_COMMIT" "$X264_SEI" "$X265_VERSION" "$X265_SHA256"
  exit 0
fi

LICENSE="${LICENSE:-gpl}"
TRIPLE="aarch64-apple-darwin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# SIDECAR_DEST overrides the install location (e.g. build in a sandbox, install separately).
DEST="${SIDECAR_DEST:-$ROOT/src-tauri/bin/ffmpeg-$TRIPLE}"
JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-ffmpeg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX"

die() { echo "error: $*" >&2; exit 1; }

# Downloads URL to OUT and refuses anything but the pinned digest.
fetch_pinned() {
  local url="$1" out="$2" sha="$3" got
  echo "[sidecar] fetching $(basename "$out")…"
  curl -fsSL --retry 3 -o "$out" "$url"
  got="$(shasum -a 256 "$out" | cut -d' ' -f1)"
  [[ "$got" == "$sha" ]] || die "$(basename "$out") is sha256 $got, pinned $sha (refusing to build from it)"
}

if [[ "$LICENSE" == "gpl" ]]; then
  for tool in nasm cmake; do
    command -v "$tool" >/dev/null || die "$tool is needed to build x264/x265 (brew install nasm cmake)."
  done

  echo "[sidecar] fetching x264 at ${X264_COMMIT:0:12}…"
  # Full history and origin/master: x264's version.sh derives X264_SEI from both.
  git init -q "$WORK/x264"
  git -C "$WORK/x264" remote add origin "$X264_URL"
  git -C "$WORK/x264" fetch -q origin master "$X264_COMMIT"
  git -C "$WORK/x264" -c advice.detachedHead=false checkout -q "$X264_COMMIT"
  [[ "$(git -C "$WORK/x264" rev-parse HEAD)" == "$X264_COMMIT" ]] || die "x264 checkout is not $X264_COMMIT"
  echo "[sidecar] building x264…"
  (
    cd "$WORK/x264"
    ./configure --prefix="$PREFIX" --disable-lsmash --disable-swscale --disable-ffms \
      --enable-static --disable-shared --enable-strip >"$WORK/x264-configure.log" 2>&1 \
      || { tail -30 "$WORK/x264-configure.log" >&2; exit 1; }
    make -j"$JOBS" install >"$WORK/x264-make.log" 2>&1 || { tail -30 "$WORK/x264-make.log" >&2; exit 1; }
  )

  fetch_pinned "https://github.com/Multicorewareinc/x265/releases/download/$X265_VERSION/x265_$X265_VERSION.tar.gz" \
    "$WORK/x265.tar.gz" "$X265_SHA256"
  mkdir -p "$WORK/x265"
  tar -xzf "$WORK/x265.tar.gz" -C "$WORK/x265" --strip-components=1
  # Homebrew's multilib recipe: 10- and 12-bit cores linked into the 8-bit library, one libx265.a.
  echo "[sidecar] building x265 (8, 10 and 12 bit)…"
  (
    cd "$WORK/x265"
    HIGH=(-DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF -DENABLE_SHARED=OFF -DENABLE_CLI=OFF)
    cmake -S source -B 10bit -DENABLE_HDR10_PLUS=ON "${HIGH[@]}" >"$WORK/x265-10.log" 2>&1 || { tail -30 "$WORK/x265-10.log" >&2; exit 1; }
    cmake --build 10bit -j"$JOBS" >>"$WORK/x265-10.log" 2>&1 || { tail -30 "$WORK/x265-10.log" >&2; exit 1; }
    cmake -S source -B 12bit -DMAIN12=ON "${HIGH[@]}" >"$WORK/x265-12.log" 2>&1 || { tail -30 "$WORK/x265-12.log" >&2; exit 1; }
    cmake --build 12bit -j"$JOBS" >>"$WORK/x265-12.log" 2>&1 || { tail -30 "$WORK/x265-12.log" >&2; exit 1; }
    mkdir -p 8bit
    cp 10bit/libx265.a 8bit/libx265_main10.a
    cp 12bit/libx265.a 8bit/libx265_main12.a
    cmake -S source -B 8bit -DCMAKE_INSTALL_PREFIX="$PREFIX" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
      -DLINKED_10BIT=ON -DLINKED_12BIT=ON -DEXTRA_LINK_FLAGS=-L. \
      -DEXTRA_LIB="x265_main10.a;x265_main12.a" >"$WORK/x265-8.log" 2>&1 || { tail -30 "$WORK/x265-8.log" >&2; exit 1; }
    cmake --build 8bit -j"$JOBS" >>"$WORK/x265-8.log" 2>&1 || { tail -30 "$WORK/x265-8.log" >&2; exit 1; }
    cd 8bit
    mv libx265.a libx265_main.a
    libtool -static -o libx265.a libx265_main.a libx265_main10.a libx265_main12.a 2>>"$WORK/x265-8.log"
    make install >>"$WORK/x265-8.log" 2>&1 || { tail -30 "$WORK/x265-8.log" >&2; exit 1; }
  )
fi

fetch_pinned "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/src.tar.xz" "$FFMPEG_SHA256"
tar -xf "$WORK/src.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-$FFMPEG_VERSION"

CONFIG_LICENSE=()
if [[ "$LICENSE" == "gpl" ]]; then
  export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
  CONFIG_LICENSE=(
    --enable-gpl
    --enable-libx264
    --enable-libx265
    --extra-cflags="-I$PREFIX/include"
    --extra-ldflags="-L$PREFIX/lib"
    # x265 is C++; the system libc++ is /usr/lib, so self-containment holds.
    --extra-libs="-lc++"
  )
fi

echo "[sidecar] configuring ffmpeg $FFMPEG_VERSION ($LICENSE)…"
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
    die "$bin has non-system dynamic dependencies (above), so it is not self-contained."
  fi
done

# SEI gate: a sidecar stamping anything but the pinned x264 string moves every export hash.
if [[ "$LICENSE" == "gpl" ]]; then
  ./ffmpeg -y -hide_banner -loglevel error -f lavfi -i color=black:s=64x64:r=30:d=0.1 \
    -c:v libx264 -f h264 "$WORK/sei.h264"
  sei="$(strings "$WORK/sei.h264" | grep -o 'x264 - core [^-]*' | sed -n '1s/ *$//p' || true)"
  [[ "$sei" == "$X264_SEI" ]] || die "libx264 stamps '$sei' into H.264 streams, pinned '$X264_SEI'."
fi

PROBE_DEST="$(dirname "$DEST")/ffprobe-$TRIPLE"
mkdir -p "$(dirname "$DEST")"
cp ffmpeg "$DEST"
cp ffprobe "$PROBE_DEST"
chmod +x "$DEST" "$PROBE_DEST"

echo "[sidecar] ready: $DEST"
"$DEST" -version | head -1
echo "[sidecar] ready: $PROBE_DEST"
"$PROBE_DEST" -version | head -1
shasum -a 256 "$DEST" "$PROBE_DEST"
echo "[sidecar] NOTE: dev copies via 'pnpm setup:ffmpeg' will overwrite these."
