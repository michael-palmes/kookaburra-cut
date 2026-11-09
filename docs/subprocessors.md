# Subprocessors and third parties

**Version:** 0.23.0, pending.

Kookaburra Cut runs on the Mac, and nothing it does sends data to the vendor.
There is no account, no server and no hosted data, so there is no subprocessor:
nobody handles customer data on the vendor's behalf. This page names every
third party a Mac running the app can reach, what each can receive and how to
turn it off. Each one is reached only after a person acts. What changes at
0.23.0 is listed in [vendor-questionnaire.md](./vendor-questionnaire.md#version).

## At a glance

| Third party | When | What is sent | Identifiers | Off switch | Behind it |
| --- | --- | --- | --- | --- | --- |
| GitHub | The update check, with consent or on Check for Updates; the download, on Install and relaunch | One GET for `latest.json`; then the signed archive comes down | None added by the app | Settings ▸ Updates; `DisableUpdateCheck`; `UpdateEndpoint` | [updater.rs](../src-tauri/src/updater.rs), [tauri.conf.json](../src-tauri/tauri.conf.json) |
| Anthropic, through the person's own Claude Code | Only after Edit with Claude, or Claude Code started in the folder by the person | Nothing from the app. Claude Code sends project files as the person works | None from the app; Claude Code uses the person's own login | `DisableClaude`; `DisableAgentKit` | [claude_app.rs](../src-tauri/src/claude_app.rs) |
| Websites a person approves | After Allow for that origin, in the editor or a Present hold | The page loads like a browser tab | None added by the app; the site's own cookies | Revoke in the inspector; `DisableLiveWebsites` | [website.rs](../src-tauri/src/website.rs) |

Apple is not on this list: it notarises each release at build time and
receives nothing from the app at run time ([below](#apple-build-time-only)).

## GitHub

- **When.** The update check runs at launch and then hourly while the app is
  open, at most once every 20 hours, only while the first-run consent is on;
  Check for Updates runs it once by hand. The download runs only when a person
  presses Install and relaunch.
- **What is sent.** One GET for
  `github.com/michael-palmes/kookaburra-cut/releases/latest/download/latest.json`,
  which GitHub redirects to `release-assets.githubusercontent.com`. No version
  or identifier is in the URL, and the user agent is the updater plugin's name
  and version, not the app's. The install downloads the archive `latest.json`
  names and checks its signature against the key built into the app before
  writing anything.
- **Identifiers.** None added by the app. GitHub sees the request's network
  address and time, as for any download.
- **Off switch.** The first-run switch or Settings ▸ Updates; for a fleet,
  `DisableUpdateCheck`, or `UpdateEndpoint` to ask your own server, after which
  GitHub is not contacted for updates ([mdm.md](./mdm.md#keys)).
- **Behind it.** `plugins.updater.endpoints` in
  [tauri.conf.json](../src-tauri/tauri.conf.json),
  [updater.rs](../src-tauri/src/updater.rs),
  [updates.ts](../src/engine/updates.ts).

The What leaves your Mac button opens this repository's `docs/privacy.md` on
`github.com` in the default browser: a fixed URL with nothing added, fetched
by the browser, not the app ([claude_app.rs](../src-tauri/src/claude_app.rs)).

## Anthropic, through the person's own Claude Code

- **When.** Only after a person presses Edit with Claude, or starts Claude Code
  in a project folder themselves. From then on, whenever Claude Code works.
- **What the app sends.** Nothing to Anthropic. Edit with Claude opens
  `claude://code/new` with the project folder's path and a starter prompt for
  the Claude desktop app on the same Mac, typed in and never sent until the
  person presses Enter there. Claude Code then sends the project's files, and
  any frame or text the agent reads, to Anthropic under the person's own
  account and their organisation's Claude settings.
- **Identifiers.** None from the app, which holds no API key and starts no
  Claude Code. Claude Code signs in with the person's own login, in
  `~/.claude`, which the app never reads or writes.
- **Off switch.** `DisableClaude` removes every Claude entry point;
  `DisableAgentKit` also stops the kit and the bridge; Claude Code's own
  managed settings apply on top ([fleet.md](./fleet.md#claude-codes-own-managed-settings-on-top)).
- **Behind it.** [claude_app.rs](../src-tauri/src/claude_app.rs),
  [SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent).

Anthropic serves the person or their organisation under their own agreement
with Anthropic; it is not a subprocessor of this vendor. Get Claude opens
`claude.ai/download` in the default browser, a fixed URL with nothing added.

## Websites a person approves for a live scene

- **When.** After a person presses Allow for that origin on a native sheet in
  the paused editor, once per origin per project. Present reloads an allowed
  origin on each hold without asking again.
- **What is sent.** The page loads like a browser tab, with its subresources
  and scripts. It must be HTTPS, or HTTP on loopback with an explicit port.
- **Identifiers.** None added by the app. Cookies and storage the site sets
  live in one WebKit profile separate from Safari, shared by every approved
  project, and never travel in a pack.
- **Off switch.** Revoke the origin in the scene's inspector; Settings ▸
  Website data clears one site or all; `DisableLiveWebsites` for a fleet.
- **Behind it.** [website.rs](../src-tauri/src/website.rs),
  [scene-website.md](./scene-website.md#accepted-residual-risk).

## Apple: build time only

The release workflow sends each release's app and DMG to Apple's notary
service with an App Store Connect API key before it is published
([sign-and-notarize.sh](../scripts/sign-and-notarize.sh),
[release.yml](../.github/workflows/release.yml)). That is the vendor's build,
not customer data, so Apple is not a runtime subprocessor. At run time the app
sends Apple nothing; macOS's own Gatekeeper and certificate checks belong to
the operating system, as for any app. Text recognition in stills runs through
Apple's Vision on the Mac ([ocr.rs](../src-tauri/src/ocr.rs)).

## No analytics, crash reporting or telemetry

There is no analytics, crash reporting or telemetry vendor, and the app
reports nothing about its use to anyone. To check:

- The window's content security policy allows `connect-src` only to itself,
  `blob:`, `data:`, `ipc:` and `asset:`
  ([tauri.conf.json](../src-tauri/tauri.conf.json), `security.csp`).
- No capability file names an outside host: none has a `remote` entry, so no
  outside page is granted any of the app's commands
  ([capabilities](../src-tauri/capabilities/)).
- No Rust code links an HTTP client of its own: reqwest arrives only through
  Tauri and the updater plugin ([Cargo.toml](../src-tauri/Cargo.toml)).
- Scene code runs behind a guard that refuses every network API but the app's
  own files ([realmGuard.ts](../src/stage/realmGuard.ts)), and the release
  ffmpeg is built with `--disable-network`
  ([build-ffmpeg-sidecar.sh](../scripts/build-ffmpeg-sidecar.sh)).

```bash
grep -o '"csp": "[^"]*"' src-tauri/tauri.conf.json   # connect-src 'self' blob: data: ipc: asset:
grep -rl '"remote"' src-tauri/capabilities             # prints nothing
```

## Build and release services

These serve the vendor's build and never receive customer data: GitHub
Actions and its attestation store, the crates.io and npm registries, a private
GitHub repository holding the licensed device models, the hosts of the pinned
ffmpeg, x264, x265 and build tool sources
([build-ffmpeg-sidecar.sh](../scripts/build-ffmpeg-sidecar.sh),
[install-build-tools.sh](../scripts/install-build-tools.sh)), the beat model's
pinned files on `raw.githubusercontent.com`
([setup-models.sh](../scripts/setup-models.sh)) and Apple's notary service.
