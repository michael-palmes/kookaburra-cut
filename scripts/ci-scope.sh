#!/usr/bin/env bash
#
# Prints the CI job flags (`rust=true|false`, `kit=true|false`) for a pull request's changed paths.
# Any other event, or a diff that can't be read, prints true for both.
#
#   scripts/ci-scope.sh pull_request            # diffs the PR merge commit against its base
#   scripts/ci-scope.sh pull_request <path>...  # classifies the given paths instead
#
set -euo pipefail

# What the rust job reads: the crate, plus the repo folders build.rs, kit stamping and its tests load.
RUST='^(src-tauri/|\.agents/|src/theme/|src/assets/|presets/|projects/|\.cargo/|rust-toolchain|package\.json$|pnpm-lock\.yaml$|scripts/setup-models\.sh$|scripts/ci-scope\.sh$|\.github/workflows/ci\.yml$)'
# What the kb suite reads.
KIT='^(\.agents/|projects/|src-tauri/templates/|scripts/test-kit\.mjs$|scripts/ci-scope\.sh$|package\.json$|\.github/workflows/ci\.yml$)'

everything() {
  echo "rust=true"
  echo "kit=true"
}

event="${1:-}"
shift || true
if [ "$event" != "pull_request" ]; then
  everything
  exit 0
fi
if [ "$#" -gt 0 ]; then
  files="$(printf '%s\n' "$@")"
elif ! files="$(git diff --name-only HEAD^1 HEAD 2>/dev/null)"; then
  everything
  exit 0
fi

flag() {
  # A here-string, not a pipe: under pipefail, grep -q exiting early can SIGPIPE the writer.
  if grep -Eq "$1" <<<"$files"; then echo true; else echo false; fi
}
echo "rust=$(flag "$RUST")"
echo "kit=$(flag "$KIT")"
