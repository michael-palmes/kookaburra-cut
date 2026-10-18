#!/usr/bin/env bash
# Seeds a new worktree's src-tauri/target with APFS clones of the primary checkout's third-party Rust artefacts (AGENTS.md, "Rust build cache across worktrees").
set -euo pipefail

note() { echo "seed-cargo-target: $*"; }

clone_profile() {
  set -euo pipefail
  local src=$1 dst=$2 part
  shift 2
  for part in deps build .fingerprint; do
    [[ -d "$src/$part" ]] || continue
    mkdir -p "$dst/$part"
    find "$src/$part" -mindepth 1 -maxdepth 1 "$@" -print0 | xargs -0 -J % cp -c -p -R % "$dst/$part/"
  done
}

with_shared_lock() {
  perl -MFcntl=:flock -e '
    $| = 1;
    my ($lock, $fh) = (shift);
    if (open($fh, "<", $lock)) {
      my $tries = 0;
      until (flock($fh, LOCK_SH | LOCK_NB)) {
        print "seed-cargo-target: waiting for the primary checkout to finish building\n" unless $tries;
        exit 75 if ++$tries > 60;
        sleep 1;
      }
    }
    exit(system(@ARGV) == 0 ? 0 : 1);
  ' "$@"
}

[[ "$(uname -s)" == Darwin ]] || exit 0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
GIT_DIR="$(cd "$GIT_DIR" && pwd -P)"
COMMON="$(cd "$COMMON" && pwd -P)"
[[ "$GIT_DIR" == "$COMMON" ]] && exit 0

STAGE="$GIT_DIR/cargo-target-seed.$$"
trap 'rm -rf "$STAGE"' EXIT
trap 'exit 1' HUP INT TERM
trap 'note "seeding failed, so the first build compiles everything"; exit 0' ERR

for stale in "$GIT_DIR"/cargo-target-seed.*; do
  [[ -d "$stale" ]] && ! kill -0 "${stale##*.}" 2>/dev/null && rm -rf "$stale"
done

TARGET="$ROOT/src-tauri/target"
[[ -e "$TARGET" ]] && exit 0
PRIMARY="$(dirname "$COMMON")"
SOURCE="$PRIMARY/src-tauri/target"

profiles=""
for profile in debug release; do
  [[ -d "$SOURCE/$profile/deps" ]] && profiles="$profiles $profile"
done
if [[ -z "$profiles" ]]; then
  note "no Rust build in $SOURCE to seed from"
  exit 0
fi
if [[ "$(stat -f %d "$SOURCE")" != "$(stat -f %d "$ROOT/src-tauri")" ]]; then
  note "the primary checkout is on another volume, so its target cannot be cloned"
  exit 0
fi

keep=(! -name '*kookaburra_cut*' ! -name 'kookaburra-cut-*')
for test in "$ROOT"/src-tauri/tests/*.rs "$PRIMARY"/src-tauri/tests/*.rs; do
  [[ -f "$test" ]] && keep+=(! -name "$(basename "$test" .rs | tr - _)-*")
done

start=$(date +%s)
for profile in $profiles; do
  status=0
  with_shared_lock "$SOURCE/$profile/.cargo-lock" \
    bash -c "$(declare -f clone_profile); clone_profile \"\$@\"" _ "$SOURCE/$profile" "$STAGE/$profile" "${keep[@]}" ||
    status=$?
  case $status in
    0) ;;
    75) note "the primary checkout is still building; run 'pnpm setup:target' later"; exit 0 ;;
    *) note "APFS clone failed, so the first build compiles everything"; exit 0 ;;
  esac
done
[[ -f "$SOURCE/CACHEDIR.TAG" ]] && cp -c -p "$SOURCE/CACHEDIR.TAG" "$STAGE/"

if ! perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$STAGE" "$TARGET"; then
  note "src-tauri/target appeared while seeding, so it was left as it is"
  exit 0
fi
note "cloned third-party artefacts (${profiles# }) from $PRIMARY in $(($(date +%s) - start))s"
