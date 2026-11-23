# Homebrew cask

`Casks/kookaburra-cut.rb` waits here until the tap repository
`michael-palmes/homebrew-kookaburra-cut` exists. Homebrew finds a tap by its
`homebrew-` prefix, so people will then install with:

```bash
brew tap michael-palmes/kookaburra-cut
brew trust --cask michael-palmes/kookaburra-cut/kookaburra-cut
brew install --cask kookaburra-cut
```

Homebrew 7 refuses to load a cask from a tap the account has not trusted
(`brew trust`, kept per account in `~/.homebrew/trust.json`), so each account
runs the second line once.

## What the cask does

- Installs `KookaburraCut-<version>.dmg` from the GitHub release, checked
  against `sha256`, the value the release's `SHA256SUMS` lists for the DMG.
- Apple Silicon on macOS 26 or later only (`depends_on arch: :arm64`,
  `depends_on macos: :tahoe`), matching `minimumSystemVersion` in
  `src-tauri/tauri.conf.json` and the release notes in
  `.github/workflows/release.yml` (no Intel build).
- `livecheck` reads the latest GitHub release.
- `zap` trashes what `SECURITY.md` ("On the Mac") lists as the app's own:
  `~/Library/Application Support/com.mpalmes.kookaburracut` (settings, caches,
  the pack key's fallback file, and from 0.23.0 the app log), WebKit's cache and
  stores, the preferences plist, and `~/Kookaburra Cut/_bridge` and `_autorun`.
  It never touches the projects in the workspace. Casks cannot delete Keychain
  items, so the pack signing key (service "Kookaburra Cut pack signing key",
  `src-tauri/src/pack/key.rs`) stays: the person deletes it in Keychain Access,
  or runs `security delete-generic-password -s "Kookaburra Cut pack signing key"`.
- `docs/fleet-deployment.md` ("Remove it") removes the same paths for every
  account on a managed Mac.

## Why no `auto_updates`

`auto_updates true` makes `brew upgrade` skip a cask unless it is run with
`--greedy`, on the grounds that the app updates itself. Here the in-app updater
is a choice: off until the person agrees in the first-run welcome
(`updateCheckConsent`, `src-tauri/src/updater.rs`), and a fleet may force it off
with `DisableUpdateCheck` (`docs/mdm.md`). With `auto_updates`, those Macs would
stay on the version they first installed. Without it, Homebrew owns the
version: `brew upgrade` moves it and `brew pin --cask kookaburra-cut` holds it.
Pick one updater per Mac; a Mac running both can show Homebrew an older version
than the app reports.

## Move it to the tap

1. The maintainer creates the public repository `michael-palmes/homebrew-kookaburra-cut`
   with a ruleset on `main` that requires a pull request, so a token that writes
   to it can propose a bump but never land one.
2. Copy `Casks/kookaburra-cut.rb` into the tap's `Casks/` folder and push it
   through a pull request.
3. From another account, check it as people will use it:
   `brew tap michael-palmes/kookaburra-cut`, `brew trust --cask
   michael-palmes/kookaburra-cut/kookaburra-cut`, `brew style --cask` and
   `brew audit --cask --strict --online` on that name, then
   `brew install --cask kookaburra-cut`.
4. In the change that adds the bump job, delete `Casks/` here so only the tap
   holds the cask, and update the cask lines in `SECURITY.md` ("Not yet") and
   `docs/fleet-deployment.md`.

## Bump it at each release

By hand, until the job below exists:

```bash
V=0.23.0
D="$(mktemp -d)"
gh release download "v$V" --repo michael-palmes/kookaburra-cut -D "$D" -p SHA256SUMS -p "KookaburraCut-$V.dmg"
(cd "$D" && shasum -a 256 -c SHA256SUMS --ignore-missing)
gh attestation verify "$D/KookaburraCut-$V.dmg" --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref "refs/tags/v$V" --deny-self-hosted-runners
SHA="$(awk -v f="KookaburraCut-$V.dmg" '$2 == f { print $1 }' "$D/SHA256SUMS")"
brew bump-cask-pr --version "$V" --sha256 "$SHA" --no-fork --no-browse michael-palmes/kookaburra-cut/kookaburra-cut
```

`brew bump-cask-pr` rewrites `version` and `sha256`, runs `brew style` and
`brew audit`, and opens a pull request on the tap. Only those two lines change
while the DMG keeps its name, `KookaburraCut-<version>.dmg`
(`.github/workflows/release.yml`). Until the tap exists, edit this copy
instead, together with the defaults in `packaging/mdm/install-kookaburra-cut.sh`;
`scripts/fleet-profiles.test.mjs` fails while the two disagree.

## Audit record

Run on 2026-11-09 against the v0.22.2 release assets, Homebrew 7.0.12, macOS
27.2. Homebrew 7 refuses `brew audit` and `brew style` on a path outside a tap,
so the cask went into a throwaway tap (`brew tap-new kbaudit/kookaburra-cut`),
was trusted with `brew trust --cask`, and the tap was removed afterwards with
`brew untrust` and `brew untap`.

```
$ brew style --cask kbaudit/kookaburra-cut/kookaburra-cut
1 file inspected, no offenses detected
$ brew audit --cask --strict --online kbaudit/kookaburra-cut/kookaburra-cut
==> Downloading https://github.com/michael-palmes/kookaburra-cut/releases/download/v0.22.2/KookaburraCut-0.22.2.dmg
==> Downloading and extracting artifacts
(exit 0, no problems reported)
$ brew livecheck --cask kbaudit/kookaburra-cut/kookaburra-cut
kookaburra-cut: 0.22.2 ==> 0.22.2
```

Two changes came out of it: `depends_on macos: :tahoe` (style rejects
`">= :tahoe"`), and no `verified:` on the `url` (livecheck warns it is
deprecated). The downloaded DMG matched the cask's `sha256`, and its
`Kookaburra Cut.app` is `com.mpalmes.kookaburracut` 0.22.2 with
`LSMinimumSystemVersion` 26.0, which `spctl` accepts as notarised Developer ID
(team Q4B8N8ZKA2).

## Design note: the bump in the release pipeline

Not built: `.github/**` is a tag-key path, so the maintainer adds it.

- **When.** The release workflow ends with a draft that a person publishes
  (`.github/workflows/release.yml`, "Draft the GitHub release"), and the DMG's
  URL answers only after that. So the bump cannot run in the publish job. It
  belongs in its own workflow on `release: types: [published]`, which fires when
  the maintainer publishes the draft.
- **Token.** A fine-grained token that reaches only
  `michael-palmes/homebrew-kookaburra-cut`, with Contents and Pull requests read
  and write and a one-year expiry, kept as a secret of the `release`
  environment, so only a run that environment's reviewer approved can read it.
  That approval is one more click per release.
- **Steps.** On `macos-26` (GitHub's macOS images carry Homebrew): the
  commands under "Bump it at each release", with `HOMEBREW_GITHUB_API_TOKEN`
  set to the token, after `brew tap` and `brew trust` for the tap.
- **Pull request, not a direct commit (recommended).** With the tap's ruleset
  requiring a pull request, a leaked token can only propose a bump, and the
  maintainer merges it like everything else on `main`. A direct commit
  (`brew bump-cask-pr --write-only --commit`, then a push) saves that merge, but
  the token alone could then point every new install at another download.
- **No token here at all.** The tap could instead run a scheduled workflow that
  does the same checks after `brew livecheck` finds a release, with its own
  `GITHUB_TOKEN`. That keeps a secret out of this repository's `release`
  environment, at the cost of a delay up to the schedule's interval.
