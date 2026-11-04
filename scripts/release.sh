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
# SECURITY.md names that version and the checkout is main, equal to origin/main after a fetch,
# with that version still untagged. It prints what changed since the previous tag and asks y/N
# before signing.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --adhoc) ADHOC=1 ;;
    --help | -h) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
MIN_OS=$(node -p "require('./src-tauri/tauri.conf.json').bundle.macOS.minimumSystemVersion")
TAG="v${VERSION}"
SIGNERS="$ROOT/.github/allowed_tag_signers"

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

# People read SECURITY.md as a description of the app they installed; 0.21.1 lacked most of what it listed.
AS_OF=$(sed -nE '1,5s/^\*\*As of version ([^ ]+)\.\*\*.*/\1/p' "$ROOT/SECURITY.md")
[[ "$AS_OF" == "$VERSION" ]] || die "SECURITY.md describes version '${AS_OF:-none}', not $VERSION; re-read it against main and update its first lines."

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit first."
[[ "$(git branch --show-current)" == "main" ]] || die "release from main, not '$(git branch --show-current)'."
git fetch --quiet origin main "+refs/tags/*:refs/tags/*"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not equal to origin/main; pull or push first."
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG already exists; bump \"version\" in src-tauri/tauri.conf.json."
TAG_KEY=$(git config --path kookaburra.tagkey) || die "set kookaburra.tagkey to the public key file of the key in .github/allowed_tag_signers (kookaburra-release skill)."
[[ "$(git config gpg.format)" == "ssh" ]] || die "set gpg.format to ssh (the keys in .github/allowed_tag_signers are SSH keys)."

# What the tag key would vouch for: read it before signing, since src/ and build.rs change under the commit key.
TAG_PATHS=()
while read -r path; do
  TAG_PATHS+=("$path")
done < <(sed -n '/tag_paths=(/,/^ *)$/p' "$ROOT/.github/workflows/signers.yml" | sed '1d;$d')
[[ ${#TAG_PATHS[@]} -gt 0 ]] || die "no tag_paths found in .github/workflows/signers.yml."
PREV_TAG=$(git tag --merged HEAD --list 'v*' --sort=-v:refname | sed -n 1p)
if [[ -n "$PREV_TAG" ]]; then
  echo "==> Commits since $PREV_TAG"
  git --no-pager shortlog "$PREV_TAG..HEAD"
  echo "==> What the release pipeline runs or pins, changed since $PREV_TAG"
  git --no-pager diff --stat "$PREV_TAG..HEAD" -- "${TAG_PATHS[@]}"
else
  echo "==> No previous tag on this branch, so nothing to compare $TAG with"
fi
echo
read -r -p "Sign and push $TAG? [y/N] " ANSWER || ANSWER=""
[[ "$ANSWER" == [yY] ]] || die "not signed; nothing was tagged."

echo "==> Tagging $TAG (Touch ID signs it)"
SSH_SK_PROVIDER="${SSH_SK_PROVIDER:-/usr/lib/ssh-keychain.dylib}" git -c user.signingkey="$TAG_KEY" tag -s "$TAG" -m "Kookaburra Cut ${VERSION}"
# The workflow verifies the tag against main's allowed_tag_signers; prove it here before pushing.
git -c gpg.ssh.allowedSignersFile="$SIGNERS" -c gpg.minTrustLevel=fully verify-tag "$TAG" \
  || { git tag -d "$TAG" >/dev/null; die "the tag's signature is not from a key in $SIGNERS (tag removed)."; }

echo "==> Pushing $TAG"
git push origin "refs/tags/$TAG"
echo
echo "Pushed $TAG. The release workflow builds and signs it (about an hour, with one approval in"
echo "the release environment), then drafts the GitHub release for you to publish:"
echo "  https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions/workflows/release.yml"
