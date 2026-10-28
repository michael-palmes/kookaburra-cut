# Security policy

## Reporting a vulnerability

If you believe you have found a security issue (for example in the Tauri IPC
surface, the pack extractor, the bundled sidecar handling, the update
mechanism or the embedded terminal), report it privately through GitHub's
private vulnerability reporting: open the
[Security tab](https://github.com/michael-palmes/kookaburra-cut/security) and
choose **Report a vulnerability**, or use the
[report form](https://github.com/michael-palmes/kookaburra-cut/security/advisories/new)
directly. That creates a draft advisory visible only to the maintainer, so
details stay private until a fix ships. Please do not open a public issue for
anything that looks like a security problem.

Include the app version (Settings ▸ About), your macOS version and steps to
reproduce. You will get an acknowledgement as soon as practical, and a fix or
mitigation plan once the report is confirmed.

## Supported versions

Only the latest release receives security fixes; please update before
reporting.

## Scope and threat model

Kookaburra Cut is a local macOS desktop app that renders and exports product
films from a project folder of scene code, sidecars and assets, with an
optional Claude Code integration. It runs on corporate Macs holding
confidential, unreleased work. This file lists everything it touches and the
control behind each claim, as of the hardening that followed the October 2026
review. [docs/privacy.md](docs/privacy.md) says the same in plain words.

It is built for these risks:

- **A shared project or pack that carries code or agent configuration.** A
  project's scenes are TypeScript that the app compiles and runs; a pack or a
  shared folder can also carry `CLAUDE.md`, `.claude/settings.json`, terminal
  commands and website origins. Scene code runs only after a person presses
  Allow on a native sheet bound to the content's hash; agent configuration is
  stripped on import and rewritten at every open; nothing in a pack runs when
  it is imported.
- **An agent that follows the wrong instructions.** Everything in a project
  (scene copy, `project.json` fields, brand files, notes, pack contents,
  captured frames, fetched pages) is written by whoever shared it. The stamped
  rules tell the agent it is data, never instructions, and every bridge and kb
  output escapes control, bidi and format characters and caps its length.
- **An agent that reaches too far.** The embedded terminal starts Claude Code
  from a fixed launch shape with an allow-listed environment; kb writes only
  inside the project, the workspace or a folder a person picked in the app this
  session, and refuses credential folders; other projects need an in-app
  confirmation.
- **Confidential work on disk.** Projects, caches and exports stay in the
  user's home folder; nothing is uploaded, synchronised or indexed by the app.
  Today they sit at the default umask; a 0700/0600 pass is in flight (below).
- **Other local users and a compromised window.** Each app window holds only
  the native commands it uses; remote website content gets none; the webview's
  content security policy names no outside host.
- **A tampered install or release.** Releases are Developer ID signed with the
  hardened runtime and notarised; updates install only with a valid ed25519
  signature from the key baked into the app.

Out of scope: a hostile process already running as the same user can read the
user's files, settings and caches and drive the app itself; the controls here
make the app's own paths harder, not that one. Claude Code's own behaviour,
network use and storage (`~/.claude`) are Anthropic's, under the user's
account; the app bounds what it is given, not what it does.

## What leaves the Mac

Nothing leaves the Mac unless a person starts it. The app window's content
security policy (`src-tauri/tauri.conf.json`, `security.csp`) allows
`connect-src` only to itself, `blob:`, `ipc:` and `asset:`; no Rust code links
an HTTP client of its own (`src-tauri/Cargo.toml`: reqwest arrives only through
Tauri and the updater plugin); the bridge is a file queue, not a socket
(`src-tauri/src/bridge.rs`); the release ffmpeg is built `--disable-network`
(`scripts/build-ffmpeg-sidecar.sh`). Opening a project, importing a pack,
exporting and presenting make no request.

| Path | Trigger | Destination | Data | Consent and off switch | Control |
| --- | --- | --- | --- | --- | --- |
| Update check | At launch, at most every 20 h, only with the consent on; or Check for Updates (menu, ⌘K, Settings), which runs without consent and stores nothing | `github.com/michael-palmes/kookaburra-cut/releases/latest/download/latest.json` | One GET; no identifiers, no version in the URL; the plugin's user agent only | First-run welcome switch (on by default, Escape saves off); Settings ▸ Updates. `update_check_consent` in `$APPDATA/settings.json` | `src-tauri/src/updater.rs`, `src/engine/updates.ts`; `KOOKABURRA_UPDATE_ENDPOINT` is honoured only in debug builds |
| Update install | Install and relaunch on the update dialog | The release asset `latest.json` names | The signed updater archive | Later declines and remembers the version | `updater.rs` (`download_and_install`); the ed25519 signature is checked against `plugins.updater.pubkey` before anything is written |
| Claude Code version probe | While the built-in terminal runs Claude, at most once a day, only with the update consent on | `downloads.claude.ai/claude-code-releases/latest` | One GET through `/usr/bin/curl`, no identifiers | The same consent | `src-tauri/src/claude_update.rs` |
| Built-in Claude terminal | Start Claude Code in the terminal panel (main window only) | Anthropic, through the user's own Claude Code install and account | The project's files and the conversation, as Claude Code works | Not starting it; Settings ▸ Claude ▸ Edit with picks the Claude app instead. The panel says what it sends before Start | `src-tauri/src/pty.rs` (`Launch::ClaudeSession`), `src/engine/terminal.ts`, `src/ui/TerminalPanel.tsx` |
| Claude Code installer and update | Install Claude Code, or Update, in the terminal panel | `claude.ai/install.sh`, piped to bash | Whatever Anthropic's installer needs | Not pressing it; the command is typed visibly into the shell and runs only there | `src/engine/terminal.ts`, `TerminalPanel.tsx` (`pty_write`) |
| Edit with Claude (`claude://` handoff) | Edit with Claude, with the Claude desktop app installed | The Claude desktop app on this Mac, which talks to Anthropic under the user's account | The project folder path and a starter prompt, typed in, never sent | Settings ▸ Claude ▸ Edit with | `src-tauri/src/claude_app.rs` (`code_session_link`, `open_in_claude`) |
| Live scene websites | Open live website in the paused editor after Allow for that origin; Present reloads an allowed origin on each hold | The approved origin, with the reach of a browser tab (subresources, subframes and scripts are not filtered) | Whatever the page loads; cookies and storage in a profile separate from Safari | Allow per origin per project (main window only); revoke in the inspector; Settings ▸ Website data clears storage | `src-tauri/src/website.rs` (`website_open` refuses without a grant, HTTPS or loopback only, downloads and new windows denied, no Tauri capability for the child) |
| Fixed pages in the browser | Get Claude, or What leaves your Mac | `claude.ai/download`; `github.com/.../docs/privacy.md` | The constant URL, nothing appended | Not pressing it | `claude_app.rs` (`open_claude_download`, `open_privacy_page`) |

Dev-time only, never in the app: `pnpm setup:models` downloads the beat model
from a pinned commit and checks its SHA-256 (`scripts/setup-models.sh`);
`pnpm setup:ffmpeg:release` fetches the ffmpeg, x264 and x265 sources against their pins (`scripts/build-ffmpeg-sidecar.sh`).

Managed preferences that force any of these off are in flight (see "Managed
preferences").

## On the Mac

Every location the app writes, with its mode. Only the pack key is created
0700/0600 today; everything else takes the umask default, and nothing is
excluded from Spotlight or Time Machine. The privacy-at-rest work in flight
(`fix/privacy-at-rest`) tightens `$APPDATA`, its caches, `_bridge` and
`_autorun` and adds `.metadata_never_index` to the caches. `$APPDATA` is
`~/Library/Application Support/com.mpalmes.kookaburracut` (`src-tauri/src/tools.rs`).

- **The workspace, `~/Kookaburra Cut`** by default (`WORKSPACE_DIR_NAME` in
  `src-tauri/src/workspace.rs`; Settings ▸ Workspace moves it through
  `move_workspace`, settings window only, behind a native sheet, refused during
  an export or import; `KOOKABURRA_WORKSPACE_ROOT` overrides it for one boot).
  One folder per project: `project.json`, `scenes/`, `assets/` (with
  `.originals/` for conformed footage, `website/` captures, `_meta.json`
  provenance holding bare file names only), `edits/`, `exports/`, a per-project
  git repository (`create_project` runs `git init`, `git add -A` and one commit,
  so a trashed asset stays in `.git` until the project is deleted), `CLAUDE.md`,
  `NOTES.md`, `BRAND.md`, the stamped `.claude/` and `./kb`, and `.kb/` (the
  agent's lock, leases and scratch). Workspace-level: `brands/`, `themes/`,
  `fonts/`, `gradients/`, `export-presets/`, `presets/`, `templates/`,
  `objects/`, `screenshots/`, and `.kookaburra/` (welcome snapshots and scene
  thumbs per project, pack import staging, and `import-backup/` holding what an
  import replaced, hard-deleted after 24 h). The asset protocol scope is
  `$HOME/Kookaburra Cut/**` and `$APPDATA/cache/**` (`tauri.conf.json`).
- **`~/Kookaburra Cut/_bridge/`** (always under the home folder, even when the
  workspace moves): the agent bridge's file queue. `responses/` holds answers
  cleaned through `clean_text`, capture PNGs, contact sheets and export
  progress for up to an hour and 2 GiB in all; `requests/.claimed/` the claimed
  requests; `apps/<pid>.json` and `app.json` heartbeats carry the executable
  path, workspace root, open project, playhead and the folders picked this
  session; `cli.json` the headless CLI's location. Control: `bridge.rs`
  (`bridge_root`, the caps at its head, `prune`).
- **`~/Kookaburra Cut/_autorun/`**: terminal-triggered runs (`runs/<id>/` with
  `last-run.json`, `dev.log`, screenshots and preview batches), the gate cache
  and the FIFO queue. Control: `scripts/kookaburra-run.sh`, `scripts/ready.mjs`,
  `autorun_result_dir` in `lib.rs`.
- **`$APPDATA/settings.json`**: preferences, `updateCheckConsent` and the
  update bookkeeping, `trustedProjects` (slug, path, content hash, time),
  `knownPublishers` (the TOFU store), `websiteOriginGrants` per project path,
  the publisher profile, the Claude preferences and the last Claude version
  seen; per-project entries other than the trust grant outlive a project
  delete. Written through a temporary file and rename under one lock. Control:
  `workspace.rs` (`AppSettings`, `settings_path`).
- **`$APPDATA/pack-key/ed25519.key`**: the install's pack signing key, 32 raw
  bytes, created on the first pack export, folder 0700, file 0600, refused if
  group or other bits are set, never the Keychain. Control: `src-tauri/src/pack/key.rs`.
- **`$APPDATA/cache/`**: `clips/` (decoded video frames per content hash,
  capped at 20 GB by default with least-recently-used eviction in 120-frame
  chunks, never while pinned by an open project or a running export; Settings
  ▸ Storage sets the cap and clears it; a deleted project's frames are not
  evicted on delete), `media/` (posters, scrub frames and probe data by content
  hash, brand images and screenshots included; Settings ▸ Storage clears it),
  `theme-previews/`, `beats/` (song analysis, which can include a track's lyric
  tags), `loudness/`, `font-embedding.json`, `tapdot/` and `export-mezz/` (the
  two-pass mezzanine, removed when the export ends). The last six have no
  Settings clear. Control: `src-tauri/src/clip_cache.rs`, `media.rs`,
  `theme.rs`, `song/mod.rs`, `loudness.rs`, `fonts.rs`, `edit.rs`, `lib.rs`.
- **`$APPDATA/.window-state.json`**: window positions (`tauri-plugin-window-state`).
  The webview's `localStorage` holds font, colour and icon recents and UI
  toggles, nothing from a project's content.
- **The Website data store**: one WebKit data store for every approved live
  website, identified by a fixed UUID, separate from Safari and from the app's
  own store; Settings ▸ Website data lists and clears its records. Control:
  `website.rs` (`WEBSITE_DATA_STORE`, `website_list_data`, `website_clear_data`).
- **Exports**: `~/Downloads/<project>-<aspect>.<ext>` by default, never
  overwriting, or the project's `exports/` folder (Settings ▸ Video, "Save
  exports to Downloads"; terminal and bridge runs always use the project
  folder). ffmpeg writes a hidden `.part` sibling and renames it on success.
  Stills and `.kbpack` files go where the save dialog points
  (`pack::commands::validate_destination` refuses system folders, `$APPDATA`
  and the app bundle). Control: `resolve_export_output` in `lib.rs`.
- **`~/.claude`**: Claude Code's own history, sessions and login. The app only
  reads `~/.claude/projects/<project>/` to offer "Continue last conversation"
  (`pty.rs`) and never writes there; the only agent files it writes are inside
  the project (`kit.rs`).
- **Temporary files**: hidden siblings beside their target (`*.tmp`,
  `.staging-*`, `.part`, `.kit-tmp`, `.kc-render/`); no `std::env::temp_dir`
  outside tests. The updater plugin unpacks an update in the system temporary
  folder while installing.

Deletions go to the Trash through `workspace::trash_path` (NSFileManager):
projects, scene files, media and their originals, themes, gradients, export
presets and screenshots. User templates and scene presets delete in place
(`src-tauri/src/library.rs`, `delete_user_item`), as do import backups after
24 h and cache clears; recorded as a follow-up. A project delete removes its
trust grant and nothing from the caches, snapshots or thumbs.

Processes the app starts: the ffmpeg and ffprobe sidecars are spawned from
Rust by basename with argv built from typed structs, never a shell
(`src-tauri/src/lib.rs`, `encode.rs`, `media.rs`); they inherit the app's
environment today (the allow-list is in flight with the privacy-at-rest
work). `-nostdin` is set on the background lanes and `-protocol_whitelist` on
none; the export soundtrack is checked to be an absolute regular file
(`lib.rs`, `start_export`). `git` runs once, at project creation.

## What reaches your agent

Two paths hand a project to Claude Code; both run under the user's own account
and install. The app holds no API key and sends nothing to Anthropic itself.

- **The embedded terminal** (`pty.rs`): `pty_spawn` takes a `Launch` enum,
  `claudeSession { continueLast, grounding }` or `interactiveShell`, never a
  command string. Rust execs the binary `detect_claude` stored (absolute,
  regular file) behind the fixed script `exec "$0" "$@"` with
  `--permission-mode auto --model claude-opus-5-5 --effort high` and the
  grounding as one argv element (`CLAUDE_FIXED_ARGS`); the cwd is confined to
  the workspace (`confine_terminal_cwd`); the child environment is
  `env_clear()` plus `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`,
  `TMPDIR`, `TERM`, `COLORTERM`, `SSH_AUTH_SOCK` and the prefixes `LC_`,
  `TERM_`, `CLAUDE_` and `ANTHROPIC_` (`ENV_ALLOW`, `ENV_ALLOW_PREFIX`), so
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` still reach every session,
  including a scene's interactive shell. Only the main window holds the
  `terminal` permission set, and `Launch::ClaudeSession` is refused from any
  other (`CLAUDE_LAUNCH_WINDOWS`). Every session command checks the owning
  window (`owned_session`). The panel's copy says "Sends this project's files
  to Anthropic as you work. Scene edits and kb commands run without asking;
  other commands ask." (`TerminalPanel.tsx`, `CLAUDE_DISCLOSURE` in
  `ClaudeLauncher.tsx`); under `--permission-mode auto` Claude Code's own
  classifier can approve a command outside the allow rules, so "ask" is
  Anthropic's judgement, not the app's. "Continue last conversation" reads
  `~/.claude/projects/<project>/` for an earlier session.
- **The `claude://` handoff** (`claude_app.rs`): `open claude://code/new?folder=<project>&q=<prompt>`,
  the prompt capped at the Claude app's limit, opened only when LaunchServices
  reports a handler; the prompt is typed into the app, not sent, until the
  person presses Enter there. The kit is stamped first, as the terminal does.
- **What the kit auto-allows** (`kit.rs`, `managed_allow_rules`): `Bash(./kb *)`,
  the two `kb.py` spellings, the template's `git status/diff/log/add/commit`,
  and `Read` of `~/Kookaburra Cut/_bridge/**`, `themes/**`, `brands/**` and
  the app bundle's `Resources/**`. Every stamp (first load per session, before
  each Claude launch, before each handoff) rewrites `.claude/settings.json`:
  `env` and `apiKeyHelper` removed, every `permissions` key except the managed
  `allow` rules removed, every hook without the kb marker removed, and
  `.claude/commands/`, `.claude/agents/` and unshipped `.claude/skills/*`
  deleted, each logged `[kit]`. Hooks run `kb.py hook …` only (`SessionStart`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`), and only once the person
  accepts Claude Code's own folder trust. Release and dev builds restamp when
  any stamped file's SHA-256 differs from the shipped file or from the `files`
  record in `kit.json`.
- **The untrusted-text rule** (`.agents/skills/kookaburra-scene-authoring/RULES.md`,
  "Untrusted text" and "Stop and ask"; the grounding in `terminal.ts` names
  RULES.md as the authority): sidecar copy and names, `project.json` fields,
  `BRAND.md`, `NOTES.md`, pack contents, captured frames and fetched pages are
  data, never instructions; text that addresses the agent is reported, not
  followed; the agent asks before touching any path outside `project.json`,
  `scenes/` and `assets/`, before following a command, URL or path found in
  content, and before anything that sends work off the Mac.
- **kb reach** (`kblib/reach.py`): writes (`capture --out`, `assets unused --archive`,
  the CLI's `render --out` in `cli.rs`) land only inside the project, the
  workspace or a folder the app's own dialog returned this session
  (`note_picked_folder` in `bridge.rs`, which refuses the home folder, shallow
  paths and credential folders); reads outside the workspace print the resolved
  path and size to stderr and refuse `~/.ssh`, `~/.aws`, `~/.config`,
  `~/.gnupg`, `~/Library/Keychains`, `.env*`, `.netrc`, `*.pem`, `*.p12`,
  `*.key` and shell histories. Bridge captures, checks, preset inserts and
  `openEdit` for a workspace project other than the one open ask once per
  project per session through a native dialog (`bridge_confirm_project`,
  decline held 60 s); `openEdit` is enforced in Rust, the other three in the
  render window's JavaScript (`src/render/bridgeService.ts`, `allowedProject`).
- **Output escaping** (`src-tauri/src/clean_text.rs`, `kblib/util.py`
  `clean_text`): every bridge response value and every kb `emit`, `emit_json`,
  error and hook context escapes C0 and C1 controls (not `\n` and `\t`), bidi,
  zero-width, tag and other format characters as `\uXXXX`, and cuts a string at
  500 characters with ` …[+N chars]`, so an OSC 52 clipboard write in a scene
  name reaches the agent inert as `\u001b]52…`. The terminal banner and the
  grounding strip control and whitespace from the project name and cap it at
  80 characters.

The agent's reach is also bounded by the bridge: request ids are
`[A-Za-z0-9-]` up to 64 characters, requests expire after 120 s, a deadline
is at most an hour, captures are rationed per client (`capture_service.rs`),
and every answer carries `servedBy` so a client discards one from another
workspace root. The queue has no authentication: any same-user process can
drop a request, which is the out-of-scope case above.

## Scene code and the trust boundary

- **The Allow gate** (`workspace.rs`, `request_project_trust`, `trust_project`,
  `check_project_trust`; `src-tauri/src/native_alert.rs`): an `NSAlert` sheet on
  the main window names the project and its folder; the default button, Return,
  is Don't open. Allow mints a 32-byte single-use nonce bound to the slug for
  120 s, and `trust_project` records a grant only for that nonce while the
  content hash still matches. The hash is SHA-256 over the content of
  `project.json`, every non-dot file under `scenes/`, `CLAUDE.md` and
  `.claude/settings.json` (`trust_covered_files`); assets are not covered. A
  grant is path and hash bound (`trustedProjects` in `settings.json`): the app's
  own writers re-stamp inside `restamping_trust`, an edit landing while the
  project is open and allowed this session re-stamps from the hash Rust
  computes, and content changed while the project was closed re-asks. Present
  and `KOOKABURRA_TRUST=stored-only` loads never re-stamp; an autorun
  (`KOOKABURRA_ACTION` set) mints its nonce without a sheet. All three commands
  are in the `trust` set, main window only. Deleting a project removes its
  grant. Declining stamps nothing. `copy_scene_to_project` (main and render
  windows) writes into another project inside `restamping_trust` with no
  consent step of its own; recorded as a follow-up.
- **Per-window ACL** (`src-tauri/permissions/*.json`, `src-tauri/capabilities/*.json`):
  every `#[tauri::command]` belongs to exactly one permission set, and each
  window gets only its sets. Main: project read, render and write, trust, media
  library, library, export, capture host, studio, terminal, Claude launcher,
  updater, website editor. Present: project read, render, its own window and
  website show. Render: project read, render, bridge serving. Settings: its
  caches, the workspace location, updater and publisher. Packs: pack commands
  and the dialog. Editor and theme editor: theirs. Dev-only commands are
  `cfg(debug_assertions)` and granted only by `capabilities/dev/`, which
  `build.rs` includes in debug builds alone. `src-tauri/src/acl.rs` lists each
  window's commands and fails on a new command until it is placed, on any
  window but main reaching `pty_spawn`, the trust commands, `start_export`,
  `delete_project`, `website_grant_origin` or `init_default_workspace`, and on
  any window but settings reaching `init_workspace` or `move_workspace`.
  `website::guard_invoke` is the second layer: any label outside the seven app
  windows gets no command at all.
- **Worker isolation** (in flight, `feat/scene-isolation-worker`): every scene
  tree moves into a Web Worker on an OffscreenCanvas with no `window`,
  `document` or `__TAURI_INTERNALS__`, so scene code can no longer reach IPC
  even from the main window. Until it merges, scene code runs in the window
  that shows it, with that window's commands, and the Allow gate and the ACL
  are the boundary.
- **Scene terminals and websites**: a scene's terminal block pre-types its
  command and never submits it (`sanitizeStartCommand`); Present shows the
  captured snapshot and has no PTY command. A scene's website block loads
  nothing until the person grants its origin in the editor; the child
  WKWebView has no Tauri capability, no file, media or sensor access, no
  downloads and no new windows; an approved origin reloads in Present on each
  hold without a further click (`src/present/PresentWebsiteOverlay.tsx`).

## Packs

`.kbpack` is a zip whose `manifest.json` lists every payload file with its
SHA-256 and is signed Ed25519 over its exact stored bytes
(`src-tauri/src/pack/`; the format in [docs/packs.md](docs/packs.md)).

- **Signature.** `verify_strict` against the `ed25519:<base64>` public key the
  manifest carries, needing a 64-byte signature; unsigned or invalid is refused
  at inspect and again at stage (`pack/key.rs`, `pack/commands.rs`). Every file
  is re-hashed as it is extracted and one mismatch fails the import
  (`pack/read.rs`, `HashMismatch`).
- **TOFU and its limits.** The key id is `hex(sha256(pubkey)[0..8])`; the store
  (`known_publishers` in `settings.json`) is keyed by the id the manifest
  declares, and the verdict compares the stored public key with the manifest's,
  so a declared id under another key reads as first time. A publisher name is
  self-declared and never verified; the same key under a new name warns. A
  known name under a new key reads as first time, which is the gap a
  name-indexed warning in flight closes. The trust screen's "Contents verified"
  tick today reflects the manifest signature alone (per-file hashes are checked
  at stage) and draws above the publisher verdict; the in-flight work moves it
  below. Continue is the primary button; Cancel is secondary.
- **What is stripped on import.** Any entry with a `.claude` segment is dropped
  at staging and listed on the summary (`pack/paths.rs`, `pack/read.rs`); an
  imported `CLAUDE.md` is replaced by the app's default and the author's text
  saved as `NOTES.md`, shown on the summary (`pack/apply.rs`). `__MACOSX`,
  `.DS_Store` and `._*` are ignored. Export never packs `exports/`, `.git/`,
  `.claude/`, `.kb/`, the kb shim, the emoji cache, originals or tap
  preferences (`pack/scan.rs`, `is_excluded`). Import writes files and never
  compiles: the first open hits the Allow gate.
- **Caps and paths** (`pack/limits.rs`, `pack/paths.rs`): 50,000 entries, 8 GiB
  total, 4 GiB per entry, a 200:1 ratio per entry, path depth 16, path length
  512 bytes, manifest 8 MiB; a structural path validator refuses control, bidi
  and zero-width characters, absolute paths, `..`, dotted folders, drive
  letters and extensions outside each kind's allow-list; symlinks and any
  non-regular file are refused; staging is a fresh folder under
  `<workspace>/.kookaburra/import-staging/` removed on drop. Per-kind payload
  caps (fonts, models, images, video) are in flight.
- **Review before apply.** The trust screen shows the scene code; the summary
  shows pre-typed terminal commands, custom start paths, website origins
  (loopback flagged as session-only) and the author's notes, read from the
  landed sidecars, never the manifest.

## Saved secrets

The app keeps one secret: the pack signing key at
`$APPDATA/pack-key/ed25519.key` (0700 folder, 0600 file, refused with wider
bits; moving it to the login Keychain is in flight). Everything else is the
user's: Claude Code's login lives in `~/.claude` and the `CLAUDE_*` and
`ANTHROPIC_*` variables pass through to the terminal as described above;
website logins live in the Website data store. No password, token or key is
printed by the app or written to its logs.

## Managed preferences

None are honoured today: every switch above is per person. Managed keys in
the domain `com.mpalmes.kookaburracut`, honoured only when a configuration
profile forces them (`DisableClaude`, `DisableLiveWebsites`,
`AllowedPublisherKeyIds`, `DisableUpdateCheck`, `WorkspaceRoot`), are in
flight; when they land, `docs/mdm.md` holds the key table and a sample
profile, and Settings marks each affected row "Managed by your organisation".

## Release integrity

A release is a signed `v*` tag on `main`; `.github/workflows/release.yml`
builds it in separate jobs, each on a fresh runner.

- **Build, with no signing secret in reach.** The build job checks that the tag
  is signed by a key in `main`'s `.github/allowed_signers` (read from `main`,
  never from the tagged tree) and sits on `main`, builds the ffmpeg sidecar from
  sources pinned by SHA-256 and commit (`scripts/build-ffmpeg-sidecar.sh`),
  fetches the beat model against its pins, unpacks the licensed device models
  from a private repository's `age`-encrypted archive and refuses any glb that
  does not match `src/assets/models/licensed.sha256`, runs
  `pnpm tauri build --no-sign` and uploads the unsigned app with its SHA-256.
  Its only secrets are the read-only token for that private repository and the
  archive's decryption key; neither can sign anything.
- **Sign, in the protected `release` environment.** Behind a required reviewer
  and limited to `v*` tags, the sign job checks the payload's digest against the
  build job, imports the Developer ID certificate into a temporary keychain,
  signs the two sidecars and then the bundle (`scripts/sign-and-notarize.sh`:
  hardened runtime, secure timestamp, no entitlements), notarises and staples
  the app and the DMG through an App Store Connect API key, tars the stapled
  app for the updater and signs it with the minisign-format ed25519 key bound to
  the version (`--app-version`), then deletes the keychain and the keys. It
  never builds or runs the payload, and never runs `pnpm install`: the updater
  signature comes from a SHA-256 pinned `tauri-cli` binary.
- **Verify, with no environment.** `scripts/verify-release.sh` on another fresh
  runner: `codesign --verify --deep --strict`, the Developer ID chain, the Team
  ID, no entitlements, `stapler validate` and `spctl` on the zip's app, the
  updater tar's app and the DMG; the DMG holds the same bytes as the zip;
  `latest.json` names the same signature and version; the signed binary runs
  `edit caps` and `check flashes` on a film its bundled ffmpeg renders; and the
  sidecars' signature-stripped digests equal the ones the build job recorded.
- **Publish.** `SHA256SUMS` over the DMG, the zip, the updater tar and
  `latest.json`; a GitHub build provenance attestation over the DMG, zip and
  tar; a static notes body naming the Team ID; a draft release a person
  publishes. The in-app updater sees a release only once it is published.
- **Updater.** `plugins.updater.requireSignedVersion` is on: the app refuses a
  signature whose trusted comment does not bind the announced version, so a
  manifest re-pointed at an older signed archive cannot roll an install back.
  The manifest's notes are never rendered.
- **Repository controls.** `scripts/release.sh` only tags: it refuses unless on
  `main` equal to `origin/main`, signs the tag and verifies it against
  `.github/allowed_signers` before pushing. Every pull request's head commit
  must be signed by a listed key (`.github/workflows/signers.yml`, run from the
  base branch's copy); `CODEOWNERS` names the maintainer; `audit.yml` runs
  `pnpm audit --prod` and `cargo deny check advisories` on every pull request
  and weekly. Every workflow starts from `permissions: {}` or `contents: read`,
  pins actions to a commit SHA and sets `persist-credentials: false`.
- **Verify an install.** On the release page's files:

  ```bash
  shasum -a 256 -c SHA256SUMS --ignore-missing
  gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
    --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
    --source-ref refs/tags/v<version> --deny-self-hosted-runners
  codesign -dvv "/Applications/Kookaburra Cut.app"       # flags=0x10000(runtime), Authority=Developer ID Application
  spctl -a -t exec -vv "/Applications/Kookaburra Cut.app" # source=Notarized Developer ID
  ```

One maintainer holds admin rights on the repository; a hardware security key
on the account and a hardware-backed tag key in `allowed_signers` are the
backstop against an account takeover.

## Process

- `pnpm ready` runs the workspace-name check on every branch
  (`scripts/workspace-names.mjs`): every added line is matched against the
  project folder names under `~/Kookaburra Cut` on this Mac and against the
  leak shapes in `scripts/workspace-denylist.txt`; the `kookaburra-commit`
  skill runs the same before each commit, and CI runs the denylist half on
  every pull request (`.github/workflows/ci.yml`, "Workspace names").
- Every PR runs `/code-review high` and `pnpm ready`; a render-path change
  gates through `docs/determinism.md`.

## Not yet

Deliberately deferred, recorded so nobody mistakes them for done:

- Fuzzing of the Rust parsers (the pack reader, `allsorts` font parsing, PNG
  and glTF inputs, the edit documents); they are bounded and tested on hostile
  fixtures, not fuzzed.
- A strict pass over every `unsafe` block (the objc2 bridges in `native_alert.rs`,
  `website.rs` and the AVFoundation conform path).
- A Homebrew cask, so MDM fleets can install and pin versions without the DMG.
- A per-project website data store: approved projects share one login profile
  today (`docs/scene-website.md`, "Accepted residual risk").
- A disk-free ceiling on single clip extractions, and eviction of a deleted
  project's clip frames.
- The bridge queue has no authentication beyond the user account.
