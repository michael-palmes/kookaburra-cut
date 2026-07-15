#!/usr/bin/env bash
#
# Cuts a release: guards, then sign + notarise + staple, zip, checksum, tag, publish.
#
# Usage: release.sh [--no-github]
#   --no-github   build, tag locally, and stop; no push, no GitHub release
#
# Publishing is also skipped automatically when no git remote is configured.
# Bump "version" in src-tauri/tauri.conf.json first; an already-tagged version is refused.
#
#   KOOKABURRA_SIGNING_IDENTITY   Developer ID Application cert
#   KOOKABURRA_NOTARY_PROFILE     notarytool keychain profile
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

PUBLISH=1
for arg in "$@"; do
  case "$arg" in
    --no-github) PUBLISH=0 ;;
    --help | -h) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP_NAME="Kookaburra Cut"
TAG="v${VERSION}"
APP_BUNDLE="$ROOT/release/$APP_NAME.app"
APP_DMG="$ROOT/release/KookaburraCut-${VERSION}.dmg"
APP_ZIP="$ROOT/release/KookaburraCut-${VERSION}.zip"
APP_ZIP_SHA="$ROOT/release/KookaburraCut-${VERSION}.zip.sha256"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty; commit or stash before releasing." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR: tag $TAG already exists; bump \"version\" in src-tauri/tauri.conf.json." >&2
  exit 1
fi

if [[ "$PUBLISH" == "1" ]] && ! git remote | grep -q .; then
  echo "No git remote configured; building and tagging locally only."
  PUBLISH=0
fi
# Fail on a missing gh now, not after a ten-minute notarisation run.
if [[ "$PUBLISH" == "1" ]]; then
  command -v gh >/dev/null || { echo "ERROR: gh CLI not installed." >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "ERROR: gh is not authenticated (gh auth login)." >&2; exit 1; }
fi

echo "==> Typecheck, tests and lint (release guards)"
pnpm build
pnpm test
pnpm lint

"$ROOT/scripts/sign-and-notarize.sh"
[[ -f "$APP_DMG" ]] || { echo "ERROR: expected DMG missing at $APP_DMG" >&2; exit 1; }

echo "==> Zipping artefacts"
rm -f "$APP_ZIP" "$APP_ZIP_SHA"
/usr/bin/ditto --norsrc -c -k --keepParent "$APP_BUNDLE" "$APP_ZIP"
# cd so the checksum records a bare filename and verifies wherever it is downloaded.
(cd "$ROOT/release" && /usr/bin/shasum -a 256 "$(basename "$APP_ZIP")" > "$(basename "$APP_ZIP_SHA")")

NOTES_FILE=$(mktemp "${TMPDIR:-/tmp}/kookaburra-release-notes.XXXXXX")
trap 'rm -f "$NOTES_FILE"' EXIT
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
{
  echo "## Kookaburra Cut ${VERSION}"
  echo ""
  echo "Apple Silicon (arm64), macOS 13+. Developer ID signed and notarised."
  echo ""
  if [[ -n "$PREV_TAG" ]]; then
    echo "Changes since ${PREV_TAG}:"
    git log --pretty='- %s' "${PREV_TAG}..HEAD"
  else
    echo "Changes:"
    git log --pretty='- %s' --max-count=30
  fi
  echo ""
  # GPL compliance for the bundled libx264 ffmpeg sidecar.
  echo "The bundled ffmpeg sidecar is a GPL build (libx264). Its exact build recipe is"
  echo "\`scripts/build-ffmpeg-sidecar.sh\`; ffmpeg's source is available from ffmpeg.org."
} > "$NOTES_FILE"

echo "==> Tagging $TAG"
git tag -a "$TAG" -m "Kookaburra Cut ${VERSION}"

if [[ "$PUBLISH" != "1" ]]; then
  echo
  echo "Skipping push and GitHub release. Artefacts:"
  echo "  $APP_DMG"
  echo "  $APP_ZIP"
  echo "  $APP_ZIP_SHA"
  echo "Local tag $TAG created; push it when you are ready."
  exit 0
fi

git push origin "$TAG"

echo "==> Creating draft GitHub release $TAG"
gh release create "$TAG" "$APP_DMG" "$APP_ZIP" "$APP_ZIP_SHA" \
  --draft \
  --title "Kookaburra Cut ${VERSION}" \
  --notes-file "$NOTES_FILE"

echo "Done: draft release $TAG created. Review and publish on GitHub."
