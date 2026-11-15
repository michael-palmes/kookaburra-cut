#!/usr/bin/env bash
#
# Prints one version's section of CHANGELOG.md: the lines under its "## [<version>]" heading,
# subheadings intact, up to the next version heading. The release workflow's publish job builds
# the release body from it, and the build job and scripts/release.sh refuse a tag whose section is
# missing or empty, so every release page carries its notes.
#
#   changelog-section.sh <version> [CHANGELOG.md]
#
set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version> [file]}"
FILE="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CHANGELOG.md}"
[[ -f "$FILE" ]] || { echo "ERROR: no changelog at $FILE" >&2; exit 1; }

# A heading starts "## [": the one for this version opens the section, any other closes it.
section="$(awk -v heading="## [${VERSION}]" '
  index($0, "## [") == 1 { inside = (index($0, heading) == 1); next }
  inside { print }
' "$FILE" | sed -e '/./,$!d')"
[[ -n "${section//[[:space:]]/}" ]] || { echo "ERROR: $FILE has no entry for ${VERSION}; write its section under \"## [${VERSION}]\" first" >&2; exit 1; }
printf '%s\n' "$section"
