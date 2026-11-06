#!/usr/bin/env bash
#
# Writes SHA256SUMS for a release set: copies build-info.txt and the SBOM from the build record and
# SECURITY.md from the checkout into the set, refuses any file missing from the list below, then
# checks the file it wrote. The publish job runs it on the verified set; a branch rehearsal runs it
# on the ad-hoc set, so a file missing from the release page fails the dry run, not the tag.
#
#   release-sums.sh --dir <release set> --record <build record> --version <version>
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR=""
RECORD=""
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a folder}"; shift 2 ;;
    --record) RECORD="${2:?--record needs a folder}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a version}"; shift 2 ;;
    --help | -h) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$DIR" && -n "$RECORD" && -n "$VERSION" ]] || { echo "ERROR: --dir, --record and --version are required" >&2; exit 2; }
[[ -d "$DIR" && -d "$RECORD" ]] || { echo "ERROR: $DIR and $RECORD must be folders" >&2; exit 1; }

SBOM="KookaburraCut-${VERSION}.cdx.json"
cp "$RECORD/build-info.txt" "$DIR/build-info.txt"
cp "$RECORD/$SBOM" "$DIR/$SBOM"
cp "$ROOT/SECURITY.md" "$DIR/SECURITY.md"
FILES=(
  "KookaburraCut-${VERSION}.dmg"
  "KookaburraCut-${VERSION}.zip"
  "KookaburraCut-${VERSION}-updater.app.tar.gz"
  "KookaburraCut-${VERSION}-updater.app.tar.gz.sig"
  latest.json
  build-info.txt
  "$SBOM"
  SECURITY.md
)
cd "$DIR"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "ERROR: missing $f" >&2; exit 1; }
done
shasum -a 256 "${FILES[@]}" > SHA256SUMS
shasum -a 256 -c SHA256SUMS
