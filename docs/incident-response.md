# Incident response

What happens if a published release, or a key that signs releases, is
compromised, and how to check what you have. One person maintains the project
and every step below is theirs, best effort, with no committed time
([support-policy.md](./support-policy.md)). Where the repository has no
mechanism for a step yet, the step says so.

## What counts

- **A compromised release**: a published release whose files were not built
  from its signed tag by `.github/workflows/release.yml`, or whose source
  carried something hostile (a dependency, a script, a change nobody meant).
- **A compromised key**: any of the keys and secrets that make a release.

| Key | Where it lives | What it can do |
| --- | --- | --- |
| Tag key | The maintainer's Mac, in the Secure Enclave behind Touch ID; listed in `.github/allowed_tag_signers` | Sign a `v*` tag that starts a release, and sign a pull request that changes the release pipeline |
| Commit key | The same Mac, Secure Enclave, no prompt; listed in `.github/allowed_signers` | Sign every other pull request head. It can't tag or change a signer list |
| Developer ID certificate | The `release` environment (`DEVELOPER_ID_P12`) and an encrypted offline backup | Sign a Mac app as this project's Team ID |
| Notary API key | The `release` environment (`NOTARY_KEY_P8`) | Notarise a build with Apple |
| Updater key | The `release` environment (`TAURI_SIGNING_PRIVATE_KEY`) and an encrypted offline backup | Sign an update archive the app installs, checked against `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` |
| The GitHub account | The maintainer | Everything above: it administers the repository, edits the signer lists and approves the `release` environment ([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)) |

## What the maintainer does

1. **Pull the release.** Download and keep a private copy of its files for the
   investigation, then delete the release on GitHub
   (`gh release delete v<version>`). The tag stays: the `v*` tag ruleset
   forbids deleting it. The updater reads
   `releases/latest/download/latest.json`, so it then sees the previous
   release. A Mac already on the pulled version is not moved back, since the
   updater only offers a newer version and refuses a signature bound to
   another one (`requireSignedVersion`). It stays on that version until step 5.
2. **Publish a GitHub security advisory** on the repository: what happened,
   the affected versions (and for a key, the window it was exposed), what to
   do, and how to check (below). The advisory is the one place people are
   told: the app shows no message from the project except an update offer,
   and never renders the manifest's notes.
3. **Contain.** For a lost or compromised Mac, or account: sign the Mac out
   of GitHub, revoke its SSH keys and tokens and rotate every secret it could
   reach, as the `kookaburra-release` skill's "Recovery for a lost Mac" sets
   out. Recover a taken-over GitHub account through GitHub first, then treat
   every key in the table as compromised.
4. **Rotate what was exposed.** Each key in its own way:
   - **Tag and commit keys.** Make new keys on a clean Mac, replace their
     lines in `.github/allowed_tag_signers` and `.github/allowed_signers`, and
     merge that change through the one-off admin bypass the skill describes,
     then empty the bypass list. Published releases are unaffected, since a
     tag is checked only at build time; a tag not yet built fails against the
     new list.
   - **Developer ID certificate.** Make a new Developer ID Application
     certificate in the Apple Developer account, replace `DEVELOPER_ID_P12`
     and its password, and revoke the old one with Apple. Every published
     release is signed with the old certificate, so ask Apple what revoking it
     does to existing installs before you do. The repository has no
     mechanism for this step; it is Apple's.
   - **Notary API key.** Revoke it in App Store Connect and replace
     `NOTARY_KEY_P8`, `NOTARY_KEY_ID` and `NOTARY_ISSUER_ID`.
   - **Updater key.** Generate a new key (`pnpm tauri signer generate`),
     replace the secret and put the new public key in `tauri.conf.json` in the
     same change. The app trusts one key and has no way to roll to a second,
     so **every existing install needs one manual download** to reach a build
     that trusts the new key. With the old key alone an attacker still needs a
     manifest the app reads: the GitHub release, which needs the repository,
     or an organisation's own `UpdateEndpoint`.
5. **Ship a fixed version.** Bump the version and release it the usual way
   (the `kookaburra-release` skill), listed under `### Security` in
   `CHANGELOG.md`. The in-app updater offers it to every Mac that checks for
   updates, unless the updater key was rotated, in which case the advisory and
   the release notes say to download it by hand. Fleets that pin a version or
   point `UpdateEndpoint` at their own server move when their IT team pushes
   it ([release-cadence.md](./release-cadence.md#holding-a-fleet-on-a-version)).
6. **Close out.** Update the advisory with the fixed version, and record any
   change to the pipeline in `SECURITY.md` and [decisions.md](./decisions.md).

## How to check what you have

- **The version**: at the foot of the Settings window (⌘,). Compare it with
  the advisory's affected versions.
- **The signature**, on the installed app:

  ```bash
  codesign -dvv "/Applications/Kookaburra Cut.app"       # Authority=Developer ID Application, the Team ID in the release notes
  spctl -a -t exec -vv "/Applications/Kookaburra Cut.app" # source=Notarized Developer ID
  ```

- **A downloaded file**, against its release: `SHA256SUMS` and the build
  provenance attestation, as [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)
  shows under "Verify an install". A file whose attestation does not name this
  repository's release workflow at the expected tag did not come from it.
- **An installed app against its release, file by file**: not yet. The
  release workflow's own check (`scripts/verify-release.sh`) runs on the
  release's files before they are published, not on an installed copy.
