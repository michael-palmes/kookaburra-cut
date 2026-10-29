#!/usr/bin/env bash
#
# Prints the SHA-256 of a Mach-O binary with its code signature removed, so the build job's
# unsigned sidecar and the verify job's Developer ID signed copy compare equal when the code
# is the same. A linker-signed binary lays out __LINKEDIT differently from one codesign has
# rewritten, so every copy is ad-hoc signed first and then stripped, which normalises both.
# Usage: sidecar-digest.sh <binary>...  (one "<sha256>  <basename>" line each)
#
set -euo pipefail

[[ $# -gt 0 ]] || { echo "usage: $0 <binary>..." >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-digest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

for bin in "$@"; do
  [[ -f "$bin" ]] || { echo "error: no file at $bin" >&2; exit 1; }
  cp "$bin" "$WORK/stripped"
  codesign --force --sign - "$WORK/stripped" 2>/dev/null
  codesign --remove-signature "$WORK/stripped"
  printf '%s  %s\n' "$(shasum -a 256 "$WORK/stripped" | cut -d' ' -f1)" "$(basename "$bin")"
done
