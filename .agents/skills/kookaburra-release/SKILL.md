---
name: kookaburra-release
description: Cutting a macOS release of Kookaburra Cut through the GitHub Actions release pipeline: the signed v* tag that triggers it, the Touch ID tag key and the commit key, the Signed head app check, recovery for a lost Mac, the build / sign / verify / publish jobs, the protected release environment and its secrets, the private licensed-models archive, ad-hoc rehearsals, Developer ID signing, Apple notarisation, the plain and styled DMGs, the MDM installer pkg (Developer ID Installer), the updater manifest and the packaged-parity gate. Use when asked to "cut a release", "tag a release", "rehearse the release", "build a release build", "make a DMG", "build the pkg", "installer package for MDM", "sign the app", "notarise", "staple", "ship it", "publish a build", "bump the version and release", "rotate the signing key", "rotate the tag key", "Signed head is missing", "lost my Mac", or when touching .github/allowed_tag_signers, .github/allowed_signers, .github/workflows/release.yml, .github/workflows/signers.yml, scripts/release.sh, scripts/sign-and-notarize.sh, scripts/verify-release.sh, scripts/make-dmg.sh, scripts/build-ffmpeg-sidecar.sh, scripts/install-build-tools.sh, scripts/bundle-digest.sh, rust-toolchain.toml, src-tauri/dmg/, or bundle.macOS and plugins.updater in tauri.conf.json.
---

# kookaburra-release

Ship a signed, notarised, stapled `.app` and DMG that opens on any Mac with no Gatekeeper warning, built by CI from a signed tag so no laptop holds a release key.

## The shape, in one paragraph

A release is a **signed `v*` tag on `main`**, pushed by `pnpm release`. `.github/workflows/release.yml` then runs four jobs on fresh runners: **build** (no signing secret in reach) verifies the tag against `main`'s `.github/allowed_tag_signers`, sets up the pinned toolchain, builds the ffmpeg sidecar from pinned source, fetches the beat-this model and the licensed device models, runs `pnpm tauri build --no-sign` through `cargo auditable` (the binary carries its crate list), writes the SBOM (`scripts/sbom.mjs`), uploads the sidecar's exact source archives (`SIDECAR_SOURCES`) and uploads the unsigned app with its SHA-256, plus a separate build record (`build-info.txt`, `bundle-digests.txt`, `sidecar-digests.txt`, `KookaburraCut-<version>.cdx.json`) whose digest is a job output; **sign**, in the protected `release` environment (one reviewer approves), checks that digest, imports the Developer ID into a temporary keychain, signs inside-out with the hardened runtime, notarises and staples the app and a plain DMG, tars the stapled app for the updater and signs it bound to the version, then deletes every key; **verify**, with no environment, checks signatures, notarisation, Gatekeeper and the updater signature against `plugins.updater.pubkey`, compares every file in the zip's and the updater tar's app, signatures stripped and file list included, with the build record, then runs the signed binary's `edit caps` and `check flashes`; **publish** writes `SHA256SUMS` over the set (the updater `.sig` included), `build-info.txt`, the SBOM and the sidecar's ffmpeg, x264 and x265 source archives, each checked against its pin in `build-info.txt` (`scripts/release-sums.sh`, which a branch rehearsal also runs), attests the DMG, pkg, zip, updater tar, `build-info.txt`, the SBOM and the source archives in one attestation, attests the SBOM on the DMG and the pkg, and drafts the GitHub release for you to publish, its body the version's `CHANGELOG.md` section (`scripts/changelog-section.sh`) followed by the install and verify text, with the attestation's bundle as `KookaburraCut-<version>.intoto.jsonl`, the updater `.sig`, the SBOM and the source archives among its assets (OpenSSF Scorecard reads only release assets, never the attestation store). Budget **about an hour**, plus the approval click.

**The pkg, for MDM fleets.** The sign job also builds `KookaburraCut-<version>.pkg` from the stapled app (`pkgbuild` then `productbuild` in `sign-and-notarize.sh`: `/Applications`, system domain only, the `minimumSystemVersion` floor, arm64, root-owned, not relocatable, no scripts), signs it with the Developer ID Installer identity, then notarises and staples it. Verify checks its signature, ticket and Gatekeeper verdict, expands it and proves its app equals the zip's, bytes and bundle digest. Publish lists it in `SHA256SUMS` (`scripts/release-sums.sh`), the one provenance attestation and the SBOM attestation, and attaches it; `scripts/verify-install.sh` checks it when it is in the folder. `pnpm release:rehearse` builds it unsigned (no installer certificate on a laptop) and verifies the rest.

## Cutting a release

1. **Bump the version** in `src-tauri/tauri.conf.json` (the single source of truth), re-read `SECURITY.md` against `main` and set its "As of version" line to match, move `## [Unreleased]`'s entries in `CHANGELOG.md` under `## [<version>] - <date>` (every security fix under `### Security`, one line on what it meant for a user, a GHSA link when an advisory exists: `CONTRIBUTING.md`, "Changelog"), and merge all three to `main` through a PR like any change. `pnpm release` and the build job refuse a tag whose `SECURITY.md` names another version, because 0.21.1 shipped under a file describing controls it lacked, and a tag whose `CHANGELOG.md` has no section, because the release body is built from it. The README must state the `minimumSystemVersion` floor (`macOS 26.0+`); the build job refuses otherwise.
   **Security docs:** `git diff v<previous> HEAD -- SECURITY.md docs/privacy.md docs/mdm.md`, carry every change into `docs/security-overview.md` and `docs/fleet.md`, and set the version line in all four (`scripts/security-docs.test.mjs` fails until each matches `tauri.conf.json`).
2. **Tag and push** from a clean `main` equal to `origin/main`:
   ```bash
   pnpm release
   ```
   It prints the commits and the `signers.yml` tag-key files changed since the previous tag and asks y/N. Read them: `src/` and `build.rs` change under the commit key. Then it signs the tag with the key at `kookaburra.tagkey` (one Touch ID), verifies it against `.github/allowed_tag_signers`, pushes only the tag and prints the workflow URL. Nothing is built locally.
3. **Approve the sign job** when GitHub asks (the `release` environment's required reviewer). The run waits for you; nothing is signed before.
4. **Publish the draft** once verify and publish are green: read the run summary (digests, sidecar record, SBOM count, build info), check the draft's assets hold `KookaburraCut-<version>.cdx.json` and its body opens with the version's changelog section, then publish the release on GitHub. The in-app updater only sees a published release (the draft 404s at `releases/latest/download/latest.json`).
5. **Run the packaged-parity gate** on the published DMG's app (below). The workflow does not run it: it needs this machine's recorded baselines.
6. **Update the website.** In `mpalmes-website-nextjs`, set `DESCRIBES` in `pages/kookaburracut/security.tsx` to the new version so its tag-pinned links resolve (the page lands with the website's security PRs; before then there is nothing to set), and refresh `Expires` in `public/kookaburracut/security.txt` if it falls within the next three months; open a PR there.

Rehearsals, in order of cost:
- `pnpm release:rehearse`: build, sign ad hoc, plain DMG, verify, on this Mac. No key, no tag.
- **Actions > Release > Run workflow** on a branch with `dry_run` true: the same pipeline on GitHub's runners with an ad-hoc signature; the branch never sees a secret. Use it for any change to the workflow or the scripts.
- The same dispatch on a `v*` tag with `dry_run` true: a real signed, notarised set as artefacts, no release.

## One-time setup (GitHub side)

Everything here is done by hand, once. Nothing in the repository works until it is.

1. **Signing keys, in the Secure Enclave.** Two non-exportable keys, so a stolen disk signs nothing. See "Signing keys" below.
2. **The signed-head app**, which posts `Signed head` (see "Signing keys"). Its key is in an environment only `main` can use, so no workflow a pull request adds can post as it. Do all of this before the ruleset requires its check, or every PR waits on a check nothing posts.
   1. Create the app (private, no webhook, Checks write only), then on its page note the **App ID** and **Client ID**, click **Generate a private key** and **Install App** on `kookaburra-cut` only:
      ```bash
      open "https://github.com/settings/apps/new?name=kookaburra-cut-signed-head&description=Posts%20the%20Signed%20head%20check&url=https://github.com/michael-palmes/kookaburra-cut&public=false&webhook_active=false&checks=write"
      ```
   2. The `signed-head` environment, limited to `main`, holding the key and the client ID; then delete the downloaded `.pem`:
      ```bash
      gh api --method PUT repos/michael-palmes/kookaburra-cut/environments/signed-head -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
      ```
      ```bash
      gh api --method POST repos/michael-palmes/kookaburra-cut/environments/signed-head/deployment-branch-policies -f name=main -f type=branch
      ```
      ```bash
      gh secret set SIGNED_HEAD_APP_KEY --env signed-head --repo michael-palmes/kookaburra-cut < "<path to the one downloaded .pem>"
      ```
      ```bash
      gh variable set SIGNED_HEAD_APP_CLIENT_ID --env signed-head --repo michael-palmes/kookaburra-cut --body "<Client ID>"
      ```
      Without the branch policy any branch's own workflow could use the key, so check it reads `{"custom_branch_policies":true,"protected_branches":false}` and `["branch:main"]`, then lists both names:
      ```bash
      R=repos/michael-palmes/kookaburra-cut/environments/signed-head && gh api $R --jq .deployment_branch_policy && gh api $R/deployment-branch-policies --jq '[.branch_policies[] | "\(.type):\(.name)"]' && gh secret list --env signed-head --repo michael-palmes/kookaburra-cut && gh variable list --env signed-head --repo michael-palmes/kookaburra-cut
      ```
   3. Open or update any PR into `main`: the app's `Signed head` check must appear beside `Head commit signed` with the same result. Only then require it (next step).
3. **Rulesets.** `main`: pull request required, the `frontend`, `rust` and `Signed head` checks required, `Signed head` pinned to the app's ID so an Actions job of that name can't answer for it; no force push, no deletion; an empty bypass list. Tags `v*`: no update, no deletion. To swap `Head commit signed` for the app's check, then confirm it reads back:
   ```bash
   APP_ID="<App ID>" RS=19092788 && gh api repos/michael-palmes/kookaburra-cut/rulesets/$RS | jq --argjson app "$APP_ID" '{rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks |= (map(select(.context != "Head commit signed")) + [{context: "Signed head", integration_id: $app}]) else . end]}' | gh api --method PUT repos/michael-palmes/kookaburra-cut/rulesets/$RS --input -
   ```
   ```bash
   gh api repos/michael-palmes/kookaburra-cut/rulesets/19092788 --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
   ```
4. **The `release` environment** with a required reviewer (yourself) and a deployment branch policy of **tags matching `v*` only**. Its secrets:
   | Secret | What |
   | --- | --- |
   | `DEVELOPER_ID_P12` | the Developer ID Application certificate and key, base64 of a `.p12` export |
   | `DEVELOPER_ID_P12_PASSWORD` | the export password |
   | `DEVELOPER_ID_INSTALLER_P12` | the Developer ID Installer certificate and key (same team), base64 of a `.p12` export; signs the pkg |
   | `DEVELOPER_ID_INSTALLER_P12_PASSWORD` | its export password |
   | `NOTARY_KEY_P8` | an App Store Connect API key (`.p8`, Developer role), raw or base64 |
   | `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID` | that key's ID and issuer |
   | `TAURI_SIGNING_PRIVATE_KEY` | the updater (minisign) private key file's contents |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |
   Only the Account Holder can create the Installer certificate: developer.apple.com > Certificates > + > Developer ID Installer, from a CSR made in Keychain Access, then export the certificate with its key as a `.p12` (it never shows under `security find-identity -p codesigning`; plain `-v` lists it). Without it the sign job stops at the keychain import, before anything is signed. Locally, `pnpm package:signed` reads the identity from `KOOKABURRA_INSTALLER_IDENTITY`. Set both secrets from stdin so nothing lands in shell history or a second file: `base64 -i <export>.p12 | gh secret set DEVELOPER_ID_INSTALLER_P12 --env release --repo michael-palmes/kookaburra-cut`, then `gh secret set DEVELOPER_ID_INSTALLER_P12_PASSWORD --env release --repo michael-palmes/kookaburra-cut` (it prompts), delete the `.p12`, and check with `gh secret list --env release`.
   Repository **variables**: `APPLE_TEAM_ID` (the Team ID every signature is checked against), optionally `LICENSED_ASSETS_REPO`. The runner image is `macos-26`, hard-coded so a variable can't redirect the sign job.
5. **Updater key.** Keep the key the published apps trust (`plugins.updater.pubkey`) if existing installs are to update themselves; rotating it means every install at or below the last laptop-signed release needs one manual download, since their bundled public key will not verify the new signature. Either way, generate any new key with `pnpm tauri signer generate -w <file>` and paste the public key into `tauri.conf.json` in the same PR that rotates the secret.
6. **Licensed device models** (`src/assets/models/README.md`). Create a private repository (default `michael-palmes/kookaburra-cut-assets`) holding one file, `licensed-models.tar.age`: a flat tar of the licensed glbs encrypted to an age recipient. Repository secrets (not in the environment: the build job reads them, and they hold no signing power): `LICENSED_ASSETS_TOKEN`, a fine-grained token with read-only Contents on that one repository, and `LICENSED_ASSETS_AGE_KEY`, the matching age identity. The build job unpacks the archive and refuses any glb that does not match `src/assets/models/licensed.sha256`.
   ```bash
   cd src/assets/models/licensed && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf /tmp/licensed-models.tar *.glb
   age-keygen -o /tmp/licensed-models.key          # the identity goes in the secret, the recipient below
   age -r <recipient> -o licensed-models.tar.age /tmp/licensed-models.tar
   ```
7. **Back up and retire the laptop key material.** Export the Developer ID `.p12` and the updater key to an encrypted offline backup, then remove the signing identity from the login keychain, the `kookaburra-cut-updater` keychain item and the `~/.tauri` key file. Nothing local signs releases any more.

## Signing keys

| Key | Protection | Listed in | Signs | Can't |
| --- | --- | --- | --- | --- |
| Tag (`kookaburra-tag`) | Touch ID | `.github/allowed_tag_signers` | release tags, PR heads that change what the release pipeline runs or pins | run without a person |
| Commit (`kookaburra-commit`) | none, no prompt | `.github/allowed_signers` | every other PR head, including an agent's while you're away | tag a release, change what the release pipeline runs or pins |

`release.yml` and `release.sh` read only the tag list. `signers.yml` requires the tag key when anything in its `tag_paths` differs between the PR head and its merge base with the base branch: `.github/`, every script the pipeline reaches, both lock files, `package.json`, `patches/`, `tauri.conf.json` and the pin files. A stolen commit key can't point `release.yml` at the commit list or swap what the sign job runs, but it can still change `src/` and `build.rs`, so read the diff before tagging. `scripts/signers-paths.test.mjs` fails when a new pipeline script is missing from the list, which `release.sh` reads too. GitHub runs the workflow from the default branch's copy, whatever the PR's base, and it reads both lists from `main`.

Two jobs, so the key never sits beside PR content. `Head commit signed` has no secret: it fetches the head by SHA as data, checks it and logs the fix. For a PR into `main`, `Post Signed head` then mints a Checks-only token from the app's key and posts the verdict as the app's `Signed head`, the check the ruleset requires; a missing verdict posts a failure. Keep it that way: never give the key to a job that fetches or reads PR content, and pass PR values to `run:` only through `env:`, never as `${{ }}` inside the script. A re-run checks the run's own head against `main` as it stood at the first run (a force-pushed head has its own run), and the app check's own Re-run does nothing (no webhook): re-run from the Signers run it links, or close and reopen the PR to check against today's lists. A fork's head carries no listed key, so it fails: fetch it into a branch here, re-sign the head and open the PR from that.

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

A head signed by an unlisted key fails Signers on every PR, so set `user.signingkey` last. Without `SSH_SK_PROVIDER`, signing stops with `No FIDO SecurityKeyProvider specified`; `release.sh` sets it itself. A list line is `<GitHub noreply address> namespaces="git" <first two fields of the .pub>`. Check a key with `ssh-keygen -lf <file>.pub` against `sc_auth list-ctk-identities -t ssh`. Dependabot's branches are re-signed by hand, each with the tag key (one Touch ID), because every bump touches a lock file or `.github/`; `Signed head` fails on Dependabot's own head and passes on yours. About half of all PRs touch the list too, and an agent working alone stops there until you can sign.

**Rotating a key.** Change the list in a PR with the head signed by the current tag key: `git -c user.signingkey="$(git config --path kookaburra.tagkey)" commit --amend --no-edit -S`. Remove the old key once no open PR's head still carries it; a PR that passed before keeps that pass until it runs again, so close and reopen any still signed by it.

**Rotating the app key.** On the app's page, generate a new private key and store it with the `gh secret set` above, check that the next PR's `Signed head` posts, then delete the old key there.

**Testing a change to `signers.yml`.** `pull_request_target` always runs `main`'s copy, so a test PR into a branch does not exercise your edit. Copy the keyless job into a throwaway workflow under `pull_request` on that base branch. The app job can't run there (its environment refuses any ref but `main`), so the next PR into `main` proves a change to it; if a merged change stops `Signed head` posting, every PR waits on it: land the fix through the admin bypass as in "Recovery for a lost Mac". Never test with a `v*` tag: the ruleset refuses to delete it and a push starts a release.

## Recovery for a lost Mac

Both keys die with the Mac and neither has a backup, by design. No listed key remains to sign the PR that replaces them, so this goes through a repository admin. It needs the GitHub account, so keep its recovery route off that Mac.

1. **Contain.** Sign the lost Mac out of GitHub (Settings > Sessions), revoke its SSH keys and tokens, and rotate the secrets it could reach. A Mac taken while logged in can still sign with the commit key, which can't tag or change a list. The tag key needs a finger.
2. **New keys.** Set up the new Mac as above.
3. **PR.** Replace every line for the lost keys in both lists and sign the head with the new tag key. `Signed head` fails, as it should.
4. **Admin bypass, for this PR only.** Settings > Rules > `main-branch-protection`: add Repository admin to the bypass list, merge the PR, then empty the bypass list straight away. Check it reads `[]`:
   ```bash
   gh api repos/michael-palmes/kookaburra-cut/rulesets --jq '.[] | select(.name=="main-branch-protection") | .id' | xargs -I{} gh api repos/michael-palmes/kookaburra-cut/rulesets/{} --jq .bypass_actors
   ```
5. **Prove it.** Open a PR with a one-line change signed by the new commit key: `Signed head` passes. Close it.

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

**Unpinned source is not a release.** `scripts/build-ffmpeg-sidecar.sh` fetches ffmpeg, x264 and x265 against SHA-256 pins and a commit; a bump edits the pin and the hash together, in one reviewed commit. CI takes `cmake`, `nasm` and `pkgconf` from `scripts/install-build-tools.sh`; a local build may use Homebrew's.

**A toolchain bump can move the sidecar.** The Rust, Node, pnpm and tool pins are in `rust-toolchain.toml`, `package.json` (`engines`, `packageManager`) and `install-build-tools.sh`. The digests in the build record differ on every run, because ffmpeg's configuration string holds the build's random temp path, so comparing them across runs proves nothing. Before bumping a build tool, build the sidecar with the old and the new one, then compare with signatures removed and that path normalised: only the 16-byte `LC_UUID` may differ, and a small x264 and x265 encode must match byte for byte. For `packageManager`, use `+sha512.<hex>` of the npm tarball's integrity: pnpm itself and `pnpm/action-setup` ignore the hash, so only the release build's corepack enforces it.

**A failed bundle digest means the sign job changed the bundle.** `verify-release.sh` prints the differing lines. `bundle-digest.sh` runs `Contents/MacOS` through `sidecar-digest.sh` and hashes everything else raw, leaving out only `Contents/_CodeSignature/CodeResources` and the stapled `Contents/CodeResources`. Never add a path to that list to get a release through: find out what wrote the file. The normal form also depends on the runner's `codesign`, so an image rollout between build and verify fails every Mach-O line and no other: compare `runner_image` in `build-info.txt` with the verify job's log, then re-run the whole workflow.

**A missing licensed model silently drops that device.** `modelUrl.ts` resolves `src/assets/models/licensed/*.glb` through `import.meta.glob`, fixed at BUILD time; an absent glb hides the device and renders saved references through the Android fallback (0.15.0 shipped without the iPad this way). `scripts/check-licensed-models.sh` fails the tag build when any mapped glb is missing or does not match its pin. A branch rehearsal skips the fetch and ships the fallback, by design.

**The updater must bind the version.** `plugins.updater.requireSignedVersion` is on, so the app refuses a signature whose trusted comment lacks `version:<v>`; `sign-and-notarize.sh` signs with `--app-version` and checks the comment. Manifests before 0.21 carry no binding, which is the point: a `latest.json` re-pointed at an older build is refused.

**Never set `bundle.createUpdaterArtifacts`.** It tars the bundle during `tauri build`, BEFORE notarisation staples the ticket. The script tars the stapled app itself.

**Never call `trash::delete`.** The crate's default macOS backend drives Finder over `osascript`; TCC blames the Apple Event on us, and under the hardened runtime it is silently denied. Call `workspace::trash_path` instead.

**The Secure Enclave identities carry a one-year certificate.** `sc_auth list-ctk-identities` shows `Valid To`. Whether signing stops at that date is untested; rotate both keys before it.

**The pkg must not be relocatable.** `pkgbuild` on the `macos-26` runner marks a bundle relocatable by default, so Installer would update whichever copy of the app it finds by bundle id (an old one in Downloads) and leave `/Applications` stale. `sign-and-notarize.sh` empties `<relocate>` in the component's `PackageInfo` and `verify-release.sh` refuses a pkg with a `<relocate>` bundle. Never switch to `pkgbuild --root` to get `BundleIsRelocatable`: a `--root` payload gives `/Applications` itself the staging folder's mode and owner (`0755 root:wheel` over `0775 root:admin`), which verify also refuses. Never add install scripts to get something done at install time: verify refuses them, and fleets audit a script-free pkg by its payload alone.

**Entitlements must stay empty.** `sign-and-notarize.sh` and `verify-release.sh` fail on any entitlement. Nothing in the shell needs one.

**Artefacts go in `release/`, never `dist/`.** `dist/` is Vite's output; `vite build` empties it.

**The ffmpeg sidecar is GPL** (libx264, libx265). It ships as an arm's-length sidecar *process*, and every release attaches the exact archives it was built from: `ffmpeg-<v>.tar.xz` and `x265_<v>.tar.gz` as upstream publishes them, and `x264-<commit>.tar` from `git archive`, pinned by `X264_SOURCE_SHA256` (`NOTICE.md`). A bump of the x264 commit, or a git whose tar output differs, stops a build that keeps the sources (the release's) until that pin is updated with it; a branch dispatch proves the runner's git first. Do not "fix" this with `LICENSE=lgpl`: that drops the deterministic default encoder and invalidates every baseline.

**The app carries its licences** in `Contents/Resources/licenses/`: the sidecar build copies the GPL texts out of its sources into `src-tauri/resources/licenses/sidecar/` (a dev `pnpm setup:ffmpeg` removes them), and `pnpm setup:licences` writes the rest, `THIRD-PARTY-NOTICES.txt` included. The build job and `sign-and-notarize.sh` run it before `tauri build`; `verify-release.sh` fails an app or pkg payload missing any file, and the build job fails when the notices miss a package the SBOM lists. A package with no licence file and a licence with no text in `scripts/licences/spdx/` stops the notices: add that SPDX text.

## DMG artwork

CI ships a **plain** DMG (`--plain-dmg`: the app, an Applications link, no background): Finder styles the DMG and there is no Finder on a headless runner. The styled Retina DMG stays for local builds (`pnpm package:dmg` from a `release/Kookaburra Cut.app`): `src-tauri/dmg/dmg_bg.png` (806×488) and `dmg_bg@2x.png` (1612×976), an exact 2:1 pair that `make-dmg.sh` merges into a multi-rep TIFF (**1x first**). Icon positions are measured off the artwork: either end of the printed rule at `(170,253)` and `(635,253)` with Finder landing icons ~3pt low, and label plates at `y=316..345` because Finder draws labels in the system colour. Swapping art means re-measuring both.

## Verify by hand

`scripts/verify-release.sh` does all of this; for a single artefact:

```bash
codesign -dvv "release/Kookaburra Cut.app"                  # flags=0x10000(runtime), Authority=Developer ID Application, a Timestamp
codesign -d --entitlements - "release/Kookaburra Cut.app"   # expect NO entitlements
xcrun stapler validate "release/Kookaburra Cut.app"
xcrun stapler validate release/KookaburraCut-<version>.dmg
pkgutil --check-signature release/KookaburraCut-<version>.pkg   # 1. Developer ID Installer: ... (<team>), trusted by the Apple notary service
xcrun stapler validate release/KookaburraCut-<version>.pkg
spctl -a -t install -vv release/KookaburraCut-<version>.pkg     # accepted, source=Notarized Developer ID
spctl -a -t exec -vv "release/Kookaburra Cut.app"           # accepted, source=Notarized Developer ID
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners
gh attestation verify KookaburraCut-<version>.dmg --bundle KookaburraCut-<version>.intoto.jsonl \
  --repo michael-palmes/kookaburra-cut --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners   # offline, the release's own bundle
node scripts/verify-updater-sig.mjs KookaburraCut-<version>-updater.app.tar.gz KookaburraCut-<version>-updater.app.tar.gz.sig \
  "$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")" <version>
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners \
  --predicate-type https://cyclonedx.org/bom           # the SBOM attestation
```

`scripts/verify-install.sh --version <version> --dir <downloads>` runs every check above on a downloaded release (`gh release download v<version>` first), plus the Team ID and the sidecars' signatures, and with `--previous <version>` prints how `SECURITY.md` changed.

## Troubleshooting

- **`Signed head` stays Expected on a PR into `main`**: read the Signers run's `Post Signed head` job. `not allowed to deploy` means the run's ref isn't `main`; a failed token step means the app is uninstalled, its key revoked or the client ID wrong (one-time setup, step 2). Fix it and re-run Signers.
- **`verify-tag` fails in the build job**: the tag was not made by `pnpm release`, or its key is not in `main`'s `.github/allowed_tag_signers` (`No principal matched` means the commit key signed it). Delete the tag only if the `v*` ruleset lets you; otherwise bump the version.
- **The sign job waits forever**: nobody approved the `release` environment. Approve it from the run page.
- **notarytool returns `Invalid`**: the sign job prints `notarytool log`; usually an unsigned or dylib-linked sidecar.
- **Verify fails on `edit caps`**: the signed binary could not run its sidecars; check the notary log and the self-containment gate output in the build job.
- **Finder styling fails (`-1728`) locally**: grant the terminal Automation permission (System Settings > Privacy & Security > Automation) and re-run `pnpm package:dmg`.
- **App launches then quits in a packaged build only**: suspect the CSP or a TCC denial, not the signature (`docs/determinism.md`, "Packaged-app parity").
