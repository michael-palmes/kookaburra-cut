#!/usr/bin/env bash
#
# Installs the sidecar's build tools from SHA-256 pinned releases into <dest>/bin, so the release
# build takes none of them from Homebrew or the runner image. cmake is Kitware's notarised build;
# nasm and pkgconf build from source. Their code never ships, but they steer the sidecar's build,
# so a bump needs the sidecar proved unchanged first (kookaburra-release skill, "A toolchain bump").
#
#   install-build-tools.sh <dest>
#   install-build-tools.sh --print-pins   the pins as KEY=VALUE lines, nothing installed
#
set -euo pipefail

CMAKE_VERSION="4.4.4"
CMAKE_SHA256="4b7b73704b1db9b374e5c9ab8e17ac6148b817b6396ee75cd94a852cbac9d305"
NASM_VERSION="3.02"
NASM_SHA256="87336eba53b4acfe917424ab5d500d2b0054d9f5148d35c2273ccf2cfb712f0d"
PKGCONF_VERSION="3.0.10"
PKGCONF_SHA256="9371b2f6372da574d4c6dc96fe9b1463037bcf6afcb6671c1555afde7b17e2de"

if [[ "${1:-}" == "--print-pins" ]]; then
  printf 'CMAKE_VERSION=%s\nCMAKE_SHA256=%s\nNASM_VERSION=%s\nNASM_SHA256=%s\nPKGCONF_VERSION=%s\nPKGCONF_SHA256=%s\n' \
    "$CMAKE_VERSION" "$CMAKE_SHA256" "$NASM_VERSION" "$NASM_SHA256" "$PKGCONF_VERSION" "$PKGCONF_SHA256"
  exit 0
fi

[[ $# -eq 1 ]] || { echo "usage: $0 <dest> | --print-pins" >&2; exit 2; }
mkdir -p "$1/bin"
DEST="$(cd "$1" && pwd)"
JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-tools.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

die() { echo "error: $*" >&2; exit 1; }

# Downloads URL to OUT and refuses anything but the pinned digest.
fetch_pinned() {
  local url="$1" out="$2" sha="$3" got
  echo "[tools] fetching $(basename "$url")"
  curl -fsSL --retry 3 -o "$out" "$url"
  got="$(shasum -a 256 "$out" | cut -d' ' -f1)"
  [[ "$got" == "$sha" ]] || die "$(basename "$url") is sha256 $got, pinned $sha (refusing it)"
}

fetch_pinned "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-macos-universal.tar.gz" \
  "$WORK/cmake.tar.gz" "$CMAKE_SHA256"
mkdir -p "$DEST/cmake"
tar -xzf "$WORK/cmake.tar.gz" -C "$DEST/cmake" --strip-components=1
ln -sf "$DEST/cmake/CMake.app/Contents/bin/cmake" "$DEST/bin/cmake"

# Builds an autotools release tarball into DEST, quietly unless it fails.
build_source() {
  local name="$1" dir="$WORK/$1"
  echo "[tools] building $name"
  mkdir -p "$dir"
  tar -xf "$WORK/$name.tar.xz" -C "$dir" --strip-components=1
  (
    cd "$dir"
    ./configure --prefix="$DEST" >"$WORK/$name.log" 2>&1 || { tail -30 "$WORK/$name.log" >&2; exit 1; }
    make -j"$JOBS" install >>"$WORK/$name.log" 2>&1 || { tail -30 "$WORK/$name.log" >&2; exit 1; }
  )
}

fetch_pinned "https://www.nasm.us/pub/nasm/releasebuilds/$NASM_VERSION/nasm-$NASM_VERSION.tar.xz" "$WORK/nasm.tar.xz" "$NASM_SHA256"
build_source nasm
fetch_pinned "https://distfiles.ariadne.space/pkgconf/pkgconf-$PKGCONF_VERSION.tar.xz" "$WORK/pkgconf.tar.xz" "$PKGCONF_SHA256"
build_source pkgconf
ln -sf "$DEST/bin/pkgconf" "$DEST/bin/pkg-config"

[[ "$("$DEST/bin/cmake" --version | sed -n '1s/^cmake version //p')" == "$CMAKE_VERSION" ]] || die "cmake is not $CMAKE_VERSION"
[[ "$("$DEST/bin/nasm" --version | awk '{ print $3 }')" == "$NASM_VERSION" ]] || die "nasm is not $NASM_VERSION"
[[ "$("$DEST/bin/pkg-config" --version)" == "$PKGCONF_VERSION" ]] || die "pkgconf is not $PKGCONF_VERSION"
echo "[tools] ready: $DEST/bin (cmake $CMAKE_VERSION, nasm $NASM_VERSION, pkgconf $PKGCONF_VERSION)"
