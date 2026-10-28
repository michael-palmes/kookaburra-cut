#!/usr/bin/env bash
#
# Cuts a release by tagging it. The signed tag is the whole release trigger: the release
# workflow builds, signs, notarises, verifies and drafts the GitHub release from it
# (.github/workflows/release.yml, .agents/skills/kookaburra-release/SKILL.md).
#
# Usage: release.sh            tag v<version> on main (signed) and push the tag
#        release.sh --adhoc    local rehearsal: build, sign ad hoc, plain DMG, verify; no tag
#
# Bump "version" in src-tauri/tauri.conf.json first and merge it; the tag step refuses unless
# the checkout is main, equal to origin/main after a fetch, with that version still untagged.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --adhoc) ADHOC=1 ;;
    --help | -h) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
MIN_OS=$(node -p "require('./src-tauri/tauri.conf.json').bundle.macOS.minimumSystemVersion")
TAG="v${VERSION}"
SIGNERS="$ROOT/.github/allowed_signers"

die() { echo "ERROR: $*" >&2; exit 1; }

# The README and every release body state the floor the bundle enforces; 0.15 and 0.16 advertised
# "macOS 13+" for a binary that refuses to launch below 26.
grep -q "macOS ${MIN_OS}+" "$ROOT/README.md" || die "README.md does not state the macOS ${MIN_OS}+ floor set in src-tauri/tauri.conf.json."

if [[ "$ADHOC" == 1 ]]; then
  echo "==> Rehearsal: the release workflow's steps, on this Mac, ad hoc"
  bash "$ROOT/scripts/check-licensed-models.sh"
  bash "$ROOT/scripts/setup-models.sh" --check
  bash "$ROOT/scripts/sign-and-notarize.sh" --adhoc --plain-dmg
  bash "$ROOT/scripts/setup-models.sh" --check "$ROOT/release/Kookaburra Cut.app/Contents/Resources/models" >/dev/null \
    || die "the bundle's beat-this model does not match the pins."
  bash "$ROOT/scripts/verify-release.sh" --adhoc
  echo "Rehearsal complete. Nothing was tagged; artefacts are in release/."
  exit 0
fi

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit first."
[[ "$(git branch --show-current)" == "main" ]] || die "release from main, not '$(git branch --show-current)'."
git fetch --quiet origin main "+refs/tags/*:refs/tags/*"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not equal to origin/main; pull or push first."
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG already exists; bump \"version\" in src-tauri/tauri.conf.json."
[[ -n "$(git config user.signingkey)" ]] || die "no user.signingkey configured; the tag must be signed by a key in .github/allowed_signers."

echo "==> Tagging $TAG (signed)"
git tag -s "$TAG" -m "Kookaburra Cut ${VERSION}"
# The workflow verifies the tag against main's allowed_signers; prove it here before pushing.
git -c gpg.ssh.allowedSignersFile="$SIGNERS" -c gpg.minTrustLevel=fully verify-tag "$TAG" \
  || { git tag -d "$TAG" >/dev/null; die "the tag's signature is not from a key in $SIGNERS (tag removed)."; }

echo "==> Pushing $TAG"
git push origin "refs/tags/$TAG"
echo
echo "Pushed $TAG. The release workflow builds and signs it (about an hour, with one approval in"
echo "the release environment), then drafts the GitHub release for you to publish:"
echo "  https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions/workflows/release.yml"
