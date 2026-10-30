---
name: kookaburra-release
description: Cutting a macOS release of Kookaburra Cut through the GitHub Actions release pipeline: the signed v* tag that triggers it, the build / sign / verify / publish jobs, the protected release environment and its secrets, the private licensed-models archive, ad-hoc rehearsals, Developer ID signing, Apple notarisation, the plain and styled DMGs, the updater manifest and the packaged-parity gate. Use when asked to "cut a release", "tag a release", "rehearse the release", "build a release build", "make a DMG", "sign the app", "notarise", "staple", "ship it", "publish a build", "bump the version and release", "rotate the signing key", or when touching .github/workflows/release.yml, scripts/release.sh, scripts/sign-and-notarize.sh, scripts/verify-release.sh, scripts/make-dmg.sh, scripts/build-ffmpeg-sidecar.sh, src-tauri/dmg/, or bundle.macOS and plugins.updater in tauri.conf.json.
---

# kookaburra-release

Ship a signed, notarised, stapled `.app` and DMG that opens on any Mac with no Gatekeeper warning, built by CI from a signed tag so no laptop holds a release key.

## The shape, in one paragraph

A release is a **signed `v*` tag on `main`**, pushed by `pnpm release`. `.github/workflows/release.yml` then runs four jobs on fresh runners: **build** (no signing secret in reach) verifies the tag against `main`'s `.github/allowed_signers`, builds the ffmpeg sidecar from pinned source, fetches the beat-this model and the licensed device models, runs `pnpm tauri build --no-sign` and uploads the unsigned app with its SHA-256; **sign**, in the protected `release` environment (one reviewer approves), checks that digest, imports the Developer ID into a temporary keychain, signs inside-out with the hardened runtime, notarises and staples the app and a plain DMG, tars the stapled app for the updater and signs it bound to the version, then deletes every key; **verify**, with no environment, checks signatures, notarisation and Gatekeeper, runs the signed binary's `edit caps` and `check flashes`, and compares the sidecars' signature-stripped digests with the build job's; **publish** writes `SHA256SUMS`, attests provenance and drafts the GitHub release for you to publish. Budget **about an hour**, plus the approval click.

## Cutting a release

1. **Bump the version** in `src-tauri/tauri.conf.json` (the single source of truth) and merge it to `main` through a PR like any change. The README must state the `minimumSystemVersion` floor (`macOS 26.0+`); the build job refuses otherwise.
2. **Tag and push** from a clean `main` equal to `origin/main`:
   ```bash
   pnpm release
   ```
   It signs the tag (`git tag -s`), verifies it against `.github/allowed_signers`, pushes only the tag and prints the workflow URL. Nothing is built locally.
3. **Approve the sign job** when GitHub asks (the `release` environment's required reviewer). The run waits for you; nothing is signed before.
4. **Publish the draft** once verify and publish are green: read the run summary (digests, sidecar record), then publish the release on GitHub. The in-app updater only sees a published release (the draft 404s at `releases/latest/download/latest.json`).
5. **Run the packaged-parity gate** on the published DMG's app (below). The workflow does not run it: it needs this machine's recorded baselines.

Rehearsals, in order of cost:
- `pnpm release:rehearse`: build, sign ad hoc, plain DMG, verify, on this Mac. No key, no tag.
- **Actions > Release > Run workflow** on a branch with `dry_run` true: the same pipeline on GitHub's runners with an ad-hoc signature; the branch never sees a secret. Use it for any change to the workflow or the scripts.
- The same dispatch on a `v*` tag with `dry_run` true: a real signed, notarised set as artefacts, no release.

## One-time setup (GitHub side)

Everything here is done by hand, once. Nothing in the repository works until it is.

1. **Tag key, hardware-backed.** Add a signing key to `.github/allowed_signers` (`<principal> namespaces="git" ssh-ed25519 <key>`; the principal is the GitHub noreply address). Prefer a key that lives on a hardware token (`ssh-keygen -t ed25519-sk`), so a laptop compromise cannot tag a release. Configure git locally: `gpg.format ssh`, `user.signingkey <pub key path>`, `tag.gpgsign true`, `commit.gpgsign true`. The Signers check (`.github/workflows/signers.yml`) requires every PR head commit to be signed by a listed key, so commits need the key too; Dependabot's branches are re-signed by hand before merging.
2. **Rulesets.** `main`: pull request required, the `frontend`, `rust` and `Head commit signed` checks required, no force push, no deletion; no bypass for the repository admin in daily use. Tags `v*`: no update, no deletion, creation only by the maintainer. (Both rulesets exist today; add the Signers check and remove the admin bypass.)
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

**Entitlements must stay empty.** `sign-and-notarize.sh` and `verify-release.sh` fail on any entitlement. Nothing in the shell needs one.

**Artefacts go in `release/`, never `dist/`.** `dist/` is Vite's output; `vite build` empties it.

**The ffmpeg sidecar is GPL** (libx264, libx265). It ships as an arm's-length sidecar *process*; the release notes point at the recipe and the sources. Do not "fix" this with `LICENSE=lgpl`: that drops the deterministic default encoder and invalidates every baseline.

## DMG artwork

CI ships a **plain** DMG (`--plain-dmg`: the app, an Applications link, no background): Finder styles the DMG and there is no Finder on a headless runner. The styled Retina DMG stays for local builds (`pnpm package:dmg` from a `release/Kookaburra Cut.app`): `src-tauri/dmg/dmg_bg.png` (806×488) and `dmg_bg@2x.png` (1612×976), an exact 2:1 pair that `make-dmg.sh` merges into a multi-rep TIFF (**1x first**). Icon positions are measured off the artwork: drop-target circles at `(170,253)` and `(635,253)` with Finder landing icons ~3pt low, and label plates at `y=316..345` because Finder draws labels in the system colour. Swapping art means re-measuring both.

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

- **`verify-tag` fails in the build job**: the tag was not made by `pnpm release`, or its key is not in `main`'s `.github/allowed_signers`. Delete the tag only if the `v*` ruleset lets you; otherwise bump the version.
- **The sign job waits forever**: nobody approved the `release` environment. Approve it from the run page.
- **notarytool returns `Invalid`**: the sign job prints `notarytool log`; usually an unsigned or dylib-linked sidecar.
- **Verify fails on `edit caps`**: the signed binary could not run its sidecars; check the notary log and the self-containment gate output in the build job.
- **Finder styling fails (`-1728`) locally**: grant the terminal Automation permission (System Settings > Privacy & Security > Automation) and re-run `pnpm package:dmg`.
- **App launches then quits in a packaged build only**: suspect the CSP or a TCC denial, not the signature (`docs/determinism.md`, "Packaged-app parity").
