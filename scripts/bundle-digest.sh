#!/usr/bin/env bash
#
# Prints a digest of every file in an app bundle, one "<sha256>  <path>" line each, so the build
# job's unsigned bundle and the verify job's signed copy compare equal when only the signature
# differs. Code in Contents/MacOS goes through sidecar-digest.sh, a symlink hashes its target's
# name, and only the seal and the ticket that signing adds are left out, so any file the sign job
# adds, removes or changes shows as a differing line.
# Usage: bundle-digest.sh <app>
#
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <app>" >&2; exit 2; }
[[ -d "$1/Contents/MacOS" ]] || { echo "error: no app bundle at $1" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$1"

odd="$(find . ! -type d ! -type f ! -type l -print)"
[[ -z "$odd" ]] || { echo "error: the bundle holds special files: $odd" >&2; exit 1; }

list() {
  local f sha
  while IFS= read -r -d '' f; do
    sha="$(bash "$HERE/sidecar-digest.sh" "$f" | cut -d' ' -f1)"
    printf '%s  %s\n' "$sha" "$f"
  done < <(find ./Contents/MacOS -type f -print0)
  while IFS= read -r -d '' f; do
    printf '%s  %s\n' "$(readlink "$f" | shasum -a 256 | cut -d' ' -f1)" "$f"
  done < <(find . -type l -print0)
  find . -type f ! -path './Contents/MacOS/*' \
    ! -path ./Contents/_CodeSignature/CodeResources ! -path ./Contents/CodeResources -print0 \
    | xargs -0 shasum -a 256
}
list | LC_ALL=C sort -k2
