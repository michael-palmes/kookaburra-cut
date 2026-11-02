---
name: kookaburra-release
description: Cutting a macOS release of Kookaburra Cut through the GitHub Actions release pipeline: the signed v* tag that triggers it, the Touch ID tag key and the commit key, recovery for a lost Mac, the build / sign / verify / publish jobs, the protected release environment and its secrets, the private licensed-models archive, ad-hoc rehearsals, Developer ID signing, Apple notarisation, the plain and styled DMGs, the updater manifest and the packaged-parity gate. Use when asked to "cut a release", "tag a release", "rehearse the release", "build a release build", "make a DMG", "sign the app", "notarise", "staple", "ship it", "publish a build", "bump the version and release", "rotate the signing key", "rotate the tag key", "lost my Mac", or when touching .github/allowed_tag_signers, .github/allowed_signers, .github/workflows/release.yml, .github/workflows/signers.yml, scripts/release.sh, scripts/sign-and-notarize.sh, scripts/verify-release.sh, scripts/make-dmg.sh, scripts/build-ffmpeg-sidecar.sh, src-tauri/dmg/, or bundle.macOS and plugins.updater in tauri.conf.json.
---

# kookaburra-release

Ship a signed, notarised, stapled `.app` and DMG that opens on any Mac with no Gatekeeper warning, built by CI from a signed tag so no laptop holds a release key.

## The shape, in one paragraph

A release is a **signed `v*` tag on `main`**, pushed by `pnpm release`. `.github/workflows/release.yml` then runs four jobs on fresh runners: **build** (no signing secret in reach) verifies the tag against `main`'s `.github/allowed_tag_signers`, builds the ffmpeg sidecar from pinned source, fetches the beat-this model and the licensed device models, runs `pnpm tauri build --no-sign` and uploads the unsigned app with its SHA-256; **sign**, in the protected `release` environment (one reviewer approves), checks that digest, imports the Developer ID into a temporary keychain, signs inside-out with the hardened runtime, notarises and staples the app and a plain DMG, tars the stapled app for the updater and signs it bound to the version, then deletes every key; **verify**, with no environment, checks signatures, notarisation and Gatekeeper, runs the signed binary's `edit caps` and `check flashes`, and compares the sidecars' signature-stripped digests with the build job's; **publish** writes `SHA256SUMS`, attests provenance and drafts the GitHub release for you to publish. Budget **about an hour**, plus the approval click.

## Cutting a release

1. **Bump the version** in `src-tauri/tauri.conf.json` (the single source of truth), re-read `SECURITY.md` against `main` and set its "As of version" line to match, and merge both to `main` through a PR like any change. `pnpm release` and the build job refuse a tag whose `SECURITY.md` names another version, because 0.21.1 shipped under a file describing controls it lacked. The README must state the `minimumSystemVersion` floor (`macOS 26.0+`); the build job refuses otherwise.
2. **Tag and push** from a clean `main` equal to `origin/main`:
   ```bash
   pnpm release
   ```
   It signs the tag with the key at `kookaburra.tagkey` (one Touch ID), verifies it against `.github/allowed_tag_signers`, pushes only the tag and prints the workflow URL. Nothing is built locally.
3. **Approve the sign job** when GitHub asks (the `release` environment's required reviewer). The run waits for you; nothing is signed before.
4. **Publish the draft** once verify and publish are green: read the run summary (digests, sidecar record), then publish the release on GitHub. The in-app updater only sees a published release (the draft 404s at `releases/latest/download/latest.json`).
5. **Run the packaged-parity gate** on the published DMG's app (below). The workflow does not run it: it needs this machine's recorded baselines.

Rehearsals, in order of cost:
- `pnpm release:rehearse`: build, sign ad hoc, plain DMG, verify, on this Mac. No key, no tag.
- **Actions > Release > Run workflow** on a branch with `dry_run` true: the same pipeline on GitHub's runners with an ad-hoc signature; the branch never sees a secret. Use it for any change to the workflow or the scripts.
- The same dispatch on a `v*` tag with `dry_run` true: a real signed, notarised set as artefacts, no release.

## One-time setup (GitHub side)

Everything here is done by hand, once. Nothing in the repository works until it is.

1. **Signing keys, in the Secure Enclave.** Two non-exportable keys, so a stolen disk signs nothing. See "Signing keys" below.
2. **Rulesets.** `main`: pull request required, the `frontend`, `rust` and `Head commit signed` checks required, no force push, no deletion; an empty bypass list. Tags `v*`: no update, no deletion.
3. **The `release` environment** with a required reviewer (yourself) and a deployment branch policy of **tags matching `v*` only**. Its secrets:
   | Secret | What |
   | --- | --- |
   | `DEVELOPER_ID_P12` | the Developer ID Application certificate and key, base64 of a `.p12` export |
   | `DEVELOPER_ID_P12_PASSWORD` | the export password |
   | `NOTARY_KEY_P8` | an App Store Connect API key (`.p8`, Developer role), raw or base64 |
   | `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID` | that key's ID and issuer |
   | `TAURI_SIGNING_PRIVATE_KEY` | the updater (minisign) private key file's contents |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |
   Repository **variables**: `APPLE_TEAM_ID` (the Team ID every signature is checked against), optionally `MACOS_RUNNER` (default `macos-26`) and `LICENSED_ASSETS_REPO`.
4. **Updater key.** Keep the key the published apps trust (`plugins.updater.pubkey`) if existing installs are to update themselves; rotating it means every install at or below the last laptop-signed release needs one manual download, since their bundled public key will not verify the new signature. Either way, generate any new key with `pnpm tauri signer generate -w <file>` and paste the public key into `tauri.conf.json` in the same PR that rotates the secret.
5. **Licensed device models** (`src/assets/models/README.md`). Create a private repository (default `michael-palmes/kookaburra-cut-assets`) holding one file, `licensed-models.tar.age`: a flat tar of the licensed glbs encrypted to an age recipient. Repository secrets (not in the environment: the build job reads them, and they hold no signing power): `LICENSED_ASSETS_TOKEN`, a fine-grained token with read-only Contents on that one repository, and `LICENSED_ASSETS_AGE_KEY`, the matching age identity. The build job unpacks the archive and refuses any glb that does not match `src/assets/models/licensed.sha256`.
   ```bash
   cd src/assets/models/licensed && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf /tmp/licensed-models.tar *.glb
   age-keygen -o /tmp/licensed-models.key          # the identity goes in the secret, the recipient below
   age -r <recipient> -o licensed-models.tar.age /tmp/licensed-models.tar
   ```
6. **Back up and retire the laptop key material.** Export the Developer ID `.p12` and the updater key to an encrypted offline backup, then remove the signing identity from the login keychain, the `kookaburra-cut-updater` keychain item and the `~/.tauri` key file. Nothing local signs releases any more.

## Signing keys

| Key | Protection | Listed in | Signs | Can't |
| --- | --- | --- | --- | --- |
| Tag (`kookaburra-tag`) | Touch ID | `.github/allowed_tag_signers` | release tags, PR heads that change a signer list, `signers.yml` or `release.yml` | run without a person |
| Commit (`kookaburra-commit`) | none, no prompt | `.github/allowed_signers` | every other PR head, including an agent's while you're away | tag a release, change a signer list, `signers.yml` or `release.yml` |

`release.yml` and `release.sh` read only the tag list. `signers.yml` requires the tag key when either list, `signers.yml` or `release.yml` differs between the PR head and its merge base with the base branch, so a stolen commit key can't point `release.yml` at the commit list. GitHub runs that check from the default branch's copy, whatever the PR's base.

Set up a Mac (the files `ssh-keygen -K` writes are references to the Secure Enclave, useless on another machine):

```bash
sc_auth create-ctk-identity -l kookaburra-tag -k p-256-ne -t bio
sc_auth create-ctk-identity -l kookaburra-commit -k p-256-ne -t none
mkdir -m 700 -p ~/.ssh/kookaburra && (cd ~/.ssh/kookaburra && ssh-keygen -w /usr/lib/ssh-keychain.dylib -K -N "")   # press Return at the PIN prompt
echo 'export SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib' >> ~/.zshenv
# from here, run inside this repository
git config kookaburra.tagkey ~/.ssh/kookaburra/id_ecdsa_sk_rk_kookaburra-tag.pub
git config gpg.format ssh && git config commit.gpgsign true && git config tag.gpgsign true
git config user.signingkey ~/.ssh/kookaburra/id_ecdsa_sk_rk_kookaburra-commit.pub   # only once main lists this key
```

A head signed by an unlisted key fails Signers on every PR, so set `user.signingkey` last. Without `SSH_SK_PROVIDER`, signing stops with `No FIDO SecurityKeyProvider specified`; `release.sh` sets it itself. A list line is `<GitHub noreply address> namespaces="git" <first two fields of the .pub>`. Check a key with `ssh-keygen -lf <file>.pub` against `sc_auth list-ctk-identities -t ssh`. Dependabot's branches are re-signed by hand, with the tag key (one Touch ID) when the bump changes `signers.yml` or `release.yml`.

**Rotating a key.** Change the list in a PR with the head signed by the current tag key: `git -c user.signingkey="$(git config --path kookaburra.tagkey)" commit --amend --no-edit -S`. Remove the old key once no open PR's head still carries it.

**Testing a change to `signers.yml`.** `pull_request_target` always runs `main`'s copy, so a test PR into a branch does not exercise your edit. Copy the job into a throwaway workflow under `pull_request` on that base branch. Never test with a `v*` tag: the ruleset refuses to delete it and a push starts a release.

## Recovery for a lost Mac

Both keys die with the Mac and neither has a backup, by design. No listed key remains to sign the PR that replaces them, so this goes through a repository admin. It needs the GitHub account, so keep its recovery route off that Mac.

1. **Contain.** Sign the lost Mac out of GitHub (Settings > Sessions), revoke its SSH keys and tokens, and rotate the secrets it could reach. A Mac taken while logged in can still sign with the commit key, which can't tag or change a list. The tag key needs a finger.
2. **New keys.** Set up the new Mac as above.
3. **PR.** Replace every line for the lost keys in both lists and sign the head with the new tag key. Signers fails, as it should.
4. **Admin bypass, for this PR only.** Settings > Rules > `main-branch-protection`: add Repository admin to the bypass list, merge the PR, then empty the bypass list straight away. Check it reads `[]`:
   ```bash
   gh api repos/michael-palmes/kookaburra-cut/rulesets --jq '.[] | select(.name=="main-branch-protection") | .id' | xargs -I{} gh api repos/michael-palmes/kookaburra-cut/rulesets/{} --jq .bypass_actors
   ```
5. **Prove it.** Open a PR with a one-line change signed by the new commit key: Signers passes. Close it.

Published releases are unaffected, since a tag is checked only at build time. A tag not yet built fails against the new list; bump the version and tag again.

## Packaged-parity gate (required before publishing)

`docs/determinism.md` makes this its own gate class: the packaged `.app` must reproduce dev-mode hashes, because "internally deterministic" is not "correct". Download the DMG from the draft (or the `kookaburra-cut-<version>` artefact), mount it, copy the app to `release/`, quit any running Kookaburra Cut, then run **one leg at a time**:

```bash
pnpm kookaburra:run --action verify --project showcase-tour  --aspect 16:9 --app "release/Kookaburra Cut.app"
pnpm kookaburra:run --action verify --project ws:launch-2026 --aspect 16:9 --app "release/Kookaburra Cut.app"
```

`ws:launch-2026` must be **EQUAL** (the null-for-legacy proof). On any divergence, diff the `renderStateFingerprint` first.

## Traps

Each of these produces a build that signs and notarises happily, then misbehaves.

**The dev sidecar poisons a local build.** `pnpm setup:ffmpeg` copies the *Homebrew* ffmpeg, which links `/opt/homebrew` dylibs that exist on no other Mac, and it **overwrites** the release sidecar. `sign-and-notarize.sh` refuses a bundle whose sidecars link anything outside `/usr/lib` and `/System`. The release build never has this problem: CI builds the sidecar from pinned source every time.

**Unpinned source is not a release.** `scripts/build-ffmpeg-sidecar.sh` fetches ffmpeg, x264 and x265 against SHA-256 pins and a commit; a bump edits the pin and the hash together, in one reviewed commit. Homebrew supplies only `nasm` and `cmake`.

**A missing licensed model silently drops that device.** `modelUrl.ts` resolves `src/assets/models/licensed/*.glb` through `import.meta.glob`, fixed at BUILD time; an absent glb hides the device and renders saved references through the Android fallback (0.15.0 shipped without the iPad this way). `scripts/check-licensed-models.sh` fails the tag build when any mapped glb is missing or does not match its pin. A branch rehearsal skips the fetch and ships the fallback, by design.

**The updater must bind the version.** `plugins.updater.requireSignedVersion` is on, so the app refuses a signature whose trusted comment lacks `version:<v>`; `sign-and-notarize.sh` signs with `--app-version` and checks the comment. Manifests before 0.21 carry no binding, which is the point: a `latest.json` re-pointed at an older build is refused.

**Never set `bundle.createUpdaterArtifacts`.** It tars the bundle during `tauri build`, BEFORE notarisation staples the ticket. The script tars the stapled app itself.

**Never call `trash::delete`.** The crate's default macOS backend drives Finder over `osascript`; TCC blames the Apple Event on us, and under the hardened runtime it is silently denied. Call `workspace::trash_path` instead.

**The Secure Enclave identities carry a one-year certificate.** `sc_auth list-ctk-identities` shows `Valid To`. Whether signing stops at that date is untested; rotate both keys before it.

**Entitlements must stay empty.** `sign-and-notarize.sh` and `verify-release.sh` fail on any entitlement. Nothing in the shell needs one.

**Artefacts go in `release/`, never `dist/`.** `dist/` is Vite's output; `vite build` empties it.

**The ffmpeg sidecar is GPL** (libx264, libx265). It ships as an arm's-length sidecar *process*; the release notes point at the recipe and the sources. Do not "fix" this with `LICENSE=lgpl`: that drops the deterministic default encoder and invalidates every baseline.

## DMG artwork

CI ships a **plain** DMG (`--plain-dmg`: the app, an Applications link, no background): Finder styles the DMG and there is no Finder on a headless runner. The styled Retina DMG stays for local builds (`pnpm package:dmg` from a `release/Kookaburra Cut.app`): `src-tauri/dmg/dmg_bg.png` (806×488) and `dmg_bg@2x.png` (1612×976), an exact 2:1 pair that `make-dmg.sh` merges into a multi-rep TIFF (**1x first**). Icon positions are measured off the artwork: either end of the printed rule at `(170,253)` and `(635,253)` with Finder landing icons ~3pt low, and label plates at `y=316..345` because Finder draws labels in the system colour. Swapping art means re-measuring both.

## Verify by hand

`scripts/verify-release.sh` does all of this; for a single artefact:

```bash
codesign -dvv "release/Kookaburra Cut.app"                  # flags=0x10000(runtime), Authority=Developer ID Application, a Timestamp
codesign -d --entitlements - "release/Kookaburra Cut.app"   # expect NO entitlements
xcrun stapler validate "release/Kookaburra Cut.app"
xcrun stapler validate release/KookaburraCut-<version>.dmg
spctl -a -t exec -vv "release/Kookaburra Cut.app"           # accepted, source=Notarized Developer ID
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

## Troubleshooting

- **`verify-tag` fails in the build job**: the tag was not made by `pnpm release`, or its key is not in `main`'s `.github/allowed_tag_signers` (`No principal matched` means the commit key signed it). Delete the tag only if the `v*` ruleset lets you; otherwise bump the version.
- **The sign job waits forever**: nobody approved the `release` environment. Approve it from the run page.
- **notarytool returns `Invalid`**: the sign job prints `notarytool log`; usually an unsigned or dylib-linked sidecar.
- **Verify fails on `edit caps`**: the signed binary could not run its sidecars; check the notary log and the self-containment gate output in the build job.
- **Finder styling fails (`-1728`) locally**: grant the terminal Automation permission (System Settings > Privacy & Security > Automation) and re-run `pnpm package:dmg`.
- **App launches then quits in a packaged build only**: suspect the CSP or a TCC denial, not the signature (`docs/determinism.md`, "Packaged-app parity").
