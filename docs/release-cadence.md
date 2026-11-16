# Release cadence

How Kookaburra Cut versions are numbered, which release gets security fixes,
how a fleet holds a version and how to check a release before it reaches a Mac.

## Version numbers

- **`MAJOR.MINOR.PATCH`**, under [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
  with every release recorded in [CHANGELOG.md](../CHANGELOG.md) in the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape.
- **Still 0.x.** Semantic Versioning makes no compatibility promise before
  1.0.0. In practice a minor (0.22.0) adds or changes features and a patch
  (0.22.1, 0.22.2) fixes defects; security fixes ride whichever comes next.
- **One source of truth**: `version` in `src-tauri/tauri.conf.json`. The
  release tag is `v<version>`, signed by a key in `main`'s
  `.github/allowed_tag_signers`, and the build refuses a tag whose
  `SECURITY.md` names another version
  ([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)).
- **No fixed calendar.** A release ships when it's ready. Every release and
  its date is in the changelog.

## Which release gets security fixes

Only the latest release
([SECURITY.md, "Supported versions"](../SECURITY.md#supported-versions)).
Older versions are not patched, and nothing is backported. A fix ships as the
next release, patch or minor, whichever comes first, and is listed under
`### Security` in the changelog and the release notes. Fixes are best effort,
with no committed time ([support-policy.md](./support-policy.md#security-issues)).

The in-app updater is how a Mac moves forward: it offers the latest
published release when it is newer than the installed one, and installs it
when a person presses Install and relaunch
([below](#how-a-release-reaches-a-mac)). A Mac that turns update checks off,
or a fleet pinned to a version, stays on whatever it has, holes included,
until it moves.

If a release itself is pulled or a signing key is compromised,
[incident-response.md](./incident-response.md) says what happens.

## How a release reaches a Mac

1. A signed tag on `main` starts `.github/workflows/release.yml`, which builds,
   signs, notarises, verifies and drafts the release. A person publishes the
   draft, and the in-app updater sees a release only once it is published
   ([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)).
2. The [releases page](https://github.com/michael-palmes/kookaburra-cut/releases)
   carries the DMG, the pkg for MDM installs, the zip, the updater archive and
   its `.sig`, `latest.json`, `SHA256SUMS`, `build-info.txt`, the SBOM
   (`KookaburraCut-<version>.cdx.json`), the sidecar's ffmpeg, x264 and x265
   source archives, the provenance bundle (`KookaburraCut-<version>.intoto.jsonl`)
   and `SECURITY.md` as it stood at the tag.
3. With the first-run consent on, the app checks at launch and then hourly
   while it is open, at most once every 20 hours; Check for Updates runs on
   request. It installs only when a person presses Install and relaunch, and
   only an archive whose ed25519 signature matches the key built into the app
   and names the announced version, so a manifest can't roll a Mac back
   (`src-tauri/src/updater.rs`, `plugins.updater` in `tauri.conf.json`).

## Holding a fleet on a version

Two ways, both in [fleet.md](./fleet.md) and
[fleet-deployment.md](./fleet-deployment.md):

- **Deploy by version through your MDM.** Push the DMG, zip or other package
  of the version you approved, and force `DisableUpdateCheck` so the app never
  asks GitHub and never offers an install ([mdm.md](./mdm.md)). Every format
  the project publishes, and how to pin each one, is in
  [fleet-deployment.md](./fleet-deployment.md).
- **Mirror the updater.** Force `UpdateEndpoint` to an `https` URL of a
  `latest.json` you serve, whose `platforms.darwin-aarch64.url` points at your
  copy of the archive. The app asks only that host, and still refuses an
  archive this project didn't sign. Serve the manifest of the version you
  approved: Macs below it move up to it, and none move past it. A malformed
  URL means no check at all, never a fallback to GitHub, and
  `DisableUpdateCheck` still wins ([mdm.md](./mdm.md)).

Either way, watch the repository's releases and security advisories, and give
a release with a `### Security` section a fast lane: a pinned fleet keeps
every hole that release closed until it moves.

## Checking a release

Run the commands in
[SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity) under
"Verify an install" before a release reaches a Mac: `SHA256SUMS`, the build
provenance attestation tied to this repository's release workflow at the tag,
the commit in `build-info.txt`, then `codesign` and `spctl` on the installed
app. [fleet.md, "Verify a release"](./fleet.md#verify-a-release) runs the same
checks with a staging install and the `SECURITY.md` diff between the version
you approved and the new one.

## If the project stops

One person maintains the project and no successor is named, so plan for it to
stop:

- **Installed apps keep working.** The app needs no account, licence server or
  service from the project; it renders and exports offline.
- **Releases and fixes stop.** The updater keeps finding the last release, and
  nothing patches it after that.
- **The code stays open.** MIT OR Apache-2.0, with every tool and source pinned
  (`.github/workflows/release.yml`), so anyone can fork, build and ship it
  under their own Developer ID. Installed apps trust only this project's
  updater key, so moving a Mac to a fork takes one manual install.
