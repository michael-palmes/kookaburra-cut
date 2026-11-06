# Security policy

**As of version 0.22.2.** This file describes that version. Older versions have
less: 0.22.1 asks the Keychain for the pack key whenever Settings or Export
opens, and its Later stops the launch check offering that version again; 0.22.0
is 0.22.1 built before the pinned toolchain and the whole-bundle record
("Release integrity"); and "Version 0.21.1" below lists what that version lacks.
Each release from 0.22.0 on carries its own copy of this file in its assets.

On a managed Mac, a configuration profile can pin the posture an organisation
needs: turn off the app's Claude launchers, live scene websites or update checks,
limit pack imports to approved publishers, and fix where projects are kept.
The app honours a key only while macOS reports it as forced by a profile, so a
user's own `defaults write` grants nothing, and a malformed key fails closed.
The keys and a sample profile: [`docs/mdm.md`](docs/mdm.md).

## Reporting a vulnerability

If you believe you have found a security issue (for example in the Tauri IPC
surface, the pack extractor, the bundled sidecar handling or the update
mechanism), report it privately through GitHub's
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

## Version 0.21.1

0.21.1 was cut before most of what this file lists. On it:

- Pressing Allow runs a project's scenes in the main window, with that window's
  native commands, the terminal among them. Allow on a shared project runs code
  with your account, the same decision as running a program that person sent
  you. The sheet on that build says so.
- App data is not owner-only: `$APPDATA` is 0755, `settings.json` 0644 and
  `_bridge` 0755 with 0644 heartbeats, with no Spotlight or Time Machine markers.
- `asset://` serves every window `$APPDATA/cache` and the whole workspace.
- `CLAUDE_*` and `ANTHROPIC_*` reach every terminal, a scene's shell included.
- Footage and exports are not kept out of a project's git history.

Update once a newer release is out. Until then, open only projects and packs
you made, or that come from someone you'd run a program from.

## Scope and threat model

Kookaburra Cut is a local macOS desktop app that renders and exports product
films from a project folder of scene code, sidecars and assets, with an
optional Claude Code integration. It runs on corporate Macs holding
confidential, unreleased work. This file lists everything it touches and the
control behind each claim, at the version named on its first line.
[docs/privacy.md](docs/privacy.md) says the same in plain words.

It is built for these risks:

- **A shared project or pack that carries code or agent configuration.** A
  project's scenes are TypeScript that the app compiles and runs; a pack or a
  shared folder can also carry `CLAUDE.md`, `.claude/settings.json`, website
  origins and a `.git` that names a program. Scene code runs only after a person presses
  Allow on a native sheet bound to the content's hash, and then on a stage shut
  off from the network and the app's commands; agent configuration is dropped on
  import and moved out of the folder at every open, and Claude won't start until
  a person has seen what moved; the agent's own git runs only where the app
  would run git itself; nothing in a pack runs when it is imported.
- **An agent that follows the wrong instructions.** Everything in a project
  (scene copy, `project.json` fields, brand files, notes, pack contents,
  captured frames, fetched pages) is written by whoever shared it. The stamped
  rules tell the agent it is data, never instructions, and every bridge and kb
  output escapes control, bidi and format characters and caps its length.
- **An agent that reaches too far.** The app starts no Claude Code, and no
  shell but the updater's administrator install ("On the Mac"): a session
  begins in the Claude app or the person's own terminal. kb
  writes only inside the project, the workspace or a folder a person picked in the app this
  session, and refuses credential folders; other projects need an in-app
  confirmation; commands that look like sending work off the Mac ask a person
  first. None of this is a sandbox (see "Not yet").
- **Confidential work on disk.** Projects, caches and exports stay in the
  user's home folder; nothing is uploaded or synchronised by the app. The
  app's own folders are owner-only (0700/0600), re-sealed at every launch and
  excluded from Spotlight; a deleted project's decoded frames leave the caches
  with it (below).
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
security policy (`src-tauri/tauri.conf.json`, `security.csp`), which the stage
worker inherits (Tauri sets the header on HTML only, so the worker starts from a
`blob:` URL: `src/stage/stageClient.ts`), allows `connect-src` only to itself,
`blob:`, `data:`, `ipc:` and `asset:`; no Rust code links
an HTTP client of its own (`src-tauri/Cargo.toml`: reqwest arrives only through
Tauri and the updater plugin); the bridge is a file queue, not a socket
(`src-tauri/src/bridge.rs`); the release ffmpeg is built `--disable-network`
(`scripts/build-ffmpeg-sidecar.sh`). Opening a project, importing a pack,
exporting and presenting make no request, and allowed scene code can't make one:
a release build's worker refuses to start unless the policy is live
(`provePolicy`), and before any scene loads `src/stage/realmGuard.ts` limits
`fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource` and `importScripts` to the
`asset:` paths its window handed over, `blob:`, `data:` and the app's own files,
and refuses every nested worker.

| Path | Trigger | Destination | Data | Consent and off switch | Control |
| --- | --- | --- | --- | --- | --- |
| Update check | At launch and hourly while the main window is open, at most every 20 h, only with the consent on and never during an export; or Check for Updates (menu, ⌘K, Settings), which runs without consent and stores nothing | `github.com/michael-palmes/kookaburra-cut/releases/latest/download/latest.json` | One GET; no identifiers, no version in the URL; the plugin's user agent only | First-run welcome switch (on by default, Escape saves off); Settings ▸ Updates. `update_check_consent` in `$APPDATA/settings.json` | `src-tauri/src/updater.rs`, `src/engine/updates.ts`; `KOOKABURRA_UPDATE_ENDPOINT` is honoured only in debug builds |
| Update install | Install and relaunch on the update dialog | The release asset `latest.json` names | The signed updater archive | Later hides the offer until the next check | `updater.rs` (`download_and_install`); the ed25519 signature is checked against `plugins.updater.pubkey` before anything is written |
| Edit with Claude (`claude://` handoff) | Edit with Claude, with the Claude desktop app installed | The Claude desktop app on this Mac, which talks to Anthropic under the user's account | The project folder path and a starter prompt, typed in, never sent | Not pressing it; `DisableClaude` turns it off for a fleet | `src-tauri/src/claude_app.rs` (`code_session_link`, `open_in_claude`) |
| Live scene websites | Open live website in the paused editor after Allow for that origin; Present reloads an allowed origin on each hold | The approved origin, with the reach of a browser tab (subresources, subframes and scripts are not filtered) | Whatever the page loads; cookies and storage in a profile separate from Safari | Allow per origin per project (main window only); revoke in the inspector; Settings ▸ Website data clears storage | `src-tauri/src/website.rs` (`website_open` refuses without a grant, HTTPS or loopback only, downloads and new windows denied, no Tauri capability for the child) |
| Fixed pages in the browser | Get Claude, or What leaves your Mac | `claude.ai/download`; `github.com/.../docs/privacy.md` | The constant URL, nothing appended | Not pressing it | `claude_app.rs` (`open_claude_download`, `open_privacy_page`) |

Dev-time only, never in the app: `pnpm setup:models` downloads the beat model
from a pinned commit and checks its SHA-256 (`scripts/setup-models.sh`);
`pnpm setup:ffmpeg:release` fetches the ffmpeg, x264 and x265 sources against their pins (`scripts/build-ffmpeg-sidecar.sh`).

A configuration profile can force the update check, the Claude launchers and
live websites off (see "Managed preferences").

## On the Mac

Every location the app writes, with its mode. `$APPDATA`, everything under
it, `_bridge` and `_autorun` are created 0700 (folders) and 0600 (files),
every launch re-seals the trees in the background and logs one `[privacy]`
line when it had to correct anything, and `cache/`, `logs/`, `_bridge/` and
`_autorun/` carry `.metadata_never_index` (`src-tauri/src/privacy.rs`, `audit.rs`;
`scripts/kookaburra-run.sh` seals the queue it creates). Projects and the
workspace folders are the user's documents and take the umask default; pack
extraction forces 0644/0755 on what it lands. `cache/clips` and
`cache/media` carry Time Machine's per-item exclusion attribute
(`com.apple.metadata:com_apple_backup_excludeItem`, set at every launch by
`privacy::exclude_from_backup`), so what those two caches hold never reaches a
backup. Everything else is backed up like any document: projects with their own
`assets/`, the frames kb keeps in `.kb/` and `<film>.flashes/`, capture PNGs in
`_bridge/responses/`, and the other caches under `$APPDATA/cache`. `$APPDATA` is
`~/Library/Application Support/com.mpalmes.kookaburracut` (`src-tauri/src/tools.rs`).

- **The workspace, `~/Kookaburra Cut`** by default (`WORKSPACE_DIR_NAME` in
  `src-tauri/src/workspace.rs`; Settings ▸ Workspace moves it through
  `move_workspace`, settings window only, behind a native sheet, refused during
  an export or import; `KOOKABURRA_WORKSPACE_ROOT` overrides it for one boot).
  One folder per project: `project.json`, `scenes/`, `assets/` (with
  `.originals/` for conformed footage, `website/` captures, `_meta.json`
  provenance holding bare file names only), `edits/`, `exports/`, a per-project
  git repository (`create_project` runs `git init` with `/assets/` and
  `/exports/` in `.git/info/exclude` before its one commit, so footage and
  renders never enter history and a trashed asset is gone; a project from
  before this rule has them rewritten out of its history, reflog expired and
  pruned, on its next open, off the load path, with one toast and one
  `[history]` log line, only when the app made the repository: one with a
  remote, a root commit by someone else or a `.git` file is left as it is and
  logged: `src-tauri/src/history.rs`), `CLAUDE.md`,
  `NOTES.md`, `BRAND.md`, the stamped `.claude/` and `./kb`, anything a stamp
  moved out of the way (`kb.moved-aside`, `.claude.moved-aside*`),
  `.kookaburra/app-edits.jsonl` (what the app's own writers changed, for the
  agent: `src-tauri/src/app_edits.rs`), `.kb/` and, beside
  a film, `<film>.flashes/` (the frames of its flash warnings). `.kb/` ignores
  itself in git, never travels in a pack, and holds the agent's lock, leases,
  events and notes, kit files someone edited (`kit-replaced/`, kept before a
  restamp), plus work that can show confidential content: `captures/`,
  `previews/`, `flashes/`, `footage/`, `thumbs/`, `song/` (a track's analysis) and
  `reference/` (frames of a reference film and the words read from them).
  Workspace-level: `brands/`, `themes/`,
  `fonts/`, `gradients/`, `export-presets/`, `presets/`, `templates/`,
  `objects/`, `screenshots/`, and `.kookaburra/` (welcome snapshots and scene
  thumbs per project, pack import staging, and `import-backup/` holding what an
  import replaced, hard-deleted after 24 h). Files reach the webview as
  `asset://` URLs served by the app's own handler (`src-tauri/src/asset_reach.rs`,
  registered in place of Tauri's): an app window may read `$APPDATA/cache`,
  `fonts/`, `objects/` and the one project it loaded last
  (`read_project_manifest`), which it loses on the welcome screen
  (`release_project`) or when the window closes; only the main window also reads
  `templates/`, `presets/`, `brands/`, `screenshots/` and the snapshots and scene
  thumbs under `.kookaburra/`; a child webview (a live website) is served
  nothing. The stage worker holds a narrower list still: see `realmGuard.ts`. Paths are
  canonicalised before the check, so a link inside a project that leads out of
  it is refused, and no hidden folder below a root is served (`.emoji-cache`
  reads through a command). Native reads of a project asset go through
  `media::resolve_asset_in`, which refuses the same links by name, and
  `copy_dir_recursive` refuses to copy a link at all.
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
  `agentFiles` (per folder, what a stamp moved and whether a person has seen it),
  the publisher profile and the Claude preferences; per-project entries other
  than the trust grant outlive a project delete. Written through a temporary file that is 0600 from its first byte, then
  a rename, under one lock. Control: `workspace.rs` (`AppSettings`,
  `settings_path`), `privacy::atomic_write_private`.
- **The pack signing key**: 32 raw bytes created on the first pack export, a
  generic password in the login Keychain (service "Kookaburra Cut pack signing
  key", account the bundle identifier, `kSecAttrSynchronizable` unset so it
  never leaves the Mac); macOS may ask once whether the app may use it, only
  when signing or rotating, and a declined prompt stops that rather than
  minting a second key. `$APPDATA/pack-key/ed25519.key` (folder 0700, file
  0600, refused if group or other bits are set) is the fallback only where the
  Keychain cannot answer: no login keychain, or `KOOKABURRA_PACK_KEY_FILE=1`;
  a file from an earlier build moves into the Keychain at the next signing and
  is deleted. Settings reads only `pack-key/identity.json` (0600, atomic): the
  public key, its id and where it lives, rewritten at signing whenever it
  disagrees with the real key. Builds without a Developer ID signature, and
  autoruns, never touch the Keychain and keep their own file key in
  `$APPDATA/pack-key-dev/`, so a dev or ad-hoc build can't create the release
  item with an access list that trusts only itself. Control:
  `src-tauri/src/pack/key.rs`.
- **`$APPDATA/cache/`**: `clips/` (decoded video frames per content hash,
  capped at 20 GB by default with least-recently-used eviction in 120-frame
  chunks, never while pinned by an open project or a running export; an
  extraction is refused up front when its raw-frame ceiling would leave the
  volume under 2 GB, naming the space it needs; Settings
  ▸ Storage sets the cap and clears it; deleting a project or an asset drops
  its entries, except content another project, template or preset still maps
  to), `media/` (posters, scrub frames and probe data by content hash, brand
  images and screenshots included; Settings ▸ Storage clears it, and a project
  or asset delete drops its entries and path stamps),
  `theme-previews/`, `beats/` (song analysis, which can include a track's lyric
  tags), `loudness/`, `font-embedding.json`, `tapdot/` and `export-mezz/` (the
  two-pass mezzanine, removed when the export ends). The last six have no
  Settings clear. Control: `src-tauri/src/clip_cache.rs`, `media.rs`,
  `theme.rs`, `song/mod.rs`, `loudness.rs`, `fonts.rs`, `edit.rs`, `lib.rs`.
- **`$APPDATA/.window-state.json`**: window positions (`tauri-plugin-window-state`).
  The webview's `localStorage` holds font, colour and icon recents and UI
  toggles, nothing from a project's content.
- **`$APPDATA/logs/`**: `app.log`, the app's own record, kept by release and
  dev builds alike (`src-tauri/src/audit.rs`, `audit::builder`): what a stamp
  moved or stripped and where the agent's git is off (`[kit]`), footage trims
  (`[history]`), Allow given, declined and asked again (`[trust]`), website
  origins allowed, declined and removed (`[website]`), pack imports with the
  publisher's key id, verdict, item counts and outcome (`[pack]`), update checks
  and installs (`[update]`), workspace moves and project deletes
  (`[workspace]`), managed keys and refusals (`[managed]`) and what the startup
  seal corrected (`[privacy]`). Lines hold paths, slugs, origins, key ids,
  versions and counts, never a file's contents or a secret, and a name a pack or
  page chose is escaped onto one line (`audit::field`). Only the app's own lines
  reach it, never the webview's or a library's (`own_target`). A file rotates
  at 1 MiB and three are kept, at most 3 MiB (`ROTATED_KEPT`); the folder is
  made 0700 with `.metadata_never_index` before the first line (`log_dir`), a
  file opens at the umask inside it, and every launch re-seals the files to 0600
  (`privacy::seal_at_startup`). Nothing in it leaves the Mac, and no managed key
  turns it off (`docs/decisions.md`, "Release builds keep a log"). The headless
  CLI kb runs never starts it and writes to stderr (`src-tauri/src/main.rs`).
- **The Website data store**: one WebKit data store for every approved live
  website, identified by a fixed UUID, separate from Safari and from the app's
  own store; Settings ▸ Website data lists and clears its records. Control:
  `website.rs` (`WEBSITE_DATA_STORE`, `website_list_data`, `website_clear_data`).
- **Exports**: `~/Downloads/<project>-<aspect>.<ext>` by default, never
  overwriting, or the project's `exports/` folder (Settings ▸ Video, "Save
  exports to Downloads"; terminal and bridge runs always use the project
  folder). ffmpeg writes a hidden `.part` sibling and renames it on success.
  Stills go where the save dialog points; `.kbpack` files go where the Save
  dialog `build_pack` runs from Rust points, never a webview path
  (`pack::commands::validate_destination` refuses system folders, `$APPDATA`
  and the app bundle). Control: `resolve_export_output` in `lib.rs`.
- **`~/.claude`**: Claude Code's own history, sessions and login. The app never
  reads or writes it; the only agent files it writes are inside the project
  (`kit.rs`).
- **Temporary files**: hidden siblings beside their target (`*.tmp`,
  `.staging-*`, `.part`, `.kit-tmp`, `.kc-render/`); the app has no
  `std::env::temp_dir` outside tests. The updater plugin unpacks an update in
  the system temporary folder while installing, or beside the app when that
  folder is on another volume. kb and the brand skill use it for
  short-lived work that can hold copies of stills and frames (`kb-*` and `brand-*`
  folders, removed when the step ends), and for hook baselines (`kb-hooks/`).

Deletions go to the Trash through `workspace::trash_path` (NSFileManager):
projects, scene files, media and their originals, themes, gradients, export
presets, screenshots, user templates and scene presets. Import backups after
24 h and cache clears delete in place. A project delete removes its
trust grant and its clip and media cache entries (the media is hashed before
the folder moves, from the library's stamps where it has them), and nothing
from the snapshots or thumbs.

Processes the app starts: the ffmpeg and ffprobe sidecars are spawned from
Rust by basename with argv built from typed structs, never a shell
(`src-tauri/src/lib.rs`, `encode.rs`, `media.rs`), with `env_clear()` plus
`HOME`, `PATH`, `TMPDIR`, `LANG`, `USER` and `LC_*` (`tools::sidecar`,
`tools::sidecar_command`). Every ffmpeg lane whose stdin is not the frame pipe
passes `-nostdin`. Each lane that opens project, library or pack bytes takes its
input arguments from `src-tauri/src/media_input.rs`: `-protocol_whitelist
file,pipe` and format and codec whitelists, so a playlist or concat file can't
pull in another file on the disk and ffmpeg reaches only the demuxers and decoders
the app supports (kb's lanes use `kblib/media_input.py`, and a test fails on one
that skips it). The export soundtrack must
be an absolute file with an audio extension inside the readable roots
(`media::confine_soundtrack`), and preset `profile`, `level` and `entropy`
are allow-listed in both languages (`encode.rs` `EncodeSpec::validate`,
`src/export/presetSchema.ts`).

Also:

- `git` from `PATH` (`history.rs`), at project creation and after a project has
  loaded through the Allow gate, never on a failed load, to find footage in older
  history and rewrite it, and at each kit stamp to read `.git/config` for the
  agent's verdict. A folder's `.git` arrives with it, so each run sets
  `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CEILING_DIRECTORIES`
  and overrides every key that names a program (`GUARDS`), and the app refuses a
  `.git` that is a link or file, or a `.git/config` holding a key the app and
  git's own setup don't write. kb's git does the same (`kblib/git.py`). The
  agent's own plain git has no such overrides, so it gets the same verdict and a
  hook check instead (`history::agent_git_verdict`, "What the kit auto-allows").
- `/usr/bin/sips` to check and convert a dropped still (`src-tauri/src/imagefile.rs`,
  `kblib/imagefile.py`): one file, a 60 s limit in the app, no shell, and the
  app's own environment, not the sidecars' allow-list. kb and the brand skill also
  run `osascript` to rasterise an SVG they have rewritten first (`kblib/svgsafe.py`).
- `open` for Finder, the `claude://` handoff and the fixed pages (`claude_app.rs`).
- The updater, only after Install and relaunch (`updater.rs`,
  `download_and_install`): `touch` from `PATH` on the installed bundle, then
  `/usr/bin/open -n` to relaunch it (Tauri's `restart`). When the app's folder
  isn't writable, macOS asks for an administrator password and the plugin runs
  `do shell script` as root: `sh` with `/usr/bin/osascript -l JavaScript` to
  swap the bundles, then `mv` and `rm` on paths it quoted itself. Cancelling
  leaves the installed app as it was.

The app never starts Claude Code, and starts a shell only for that administrator
install.

## What reaches your agent

Claude Code runs outside the app, in the Claude desktop app or the person's own
terminal, under their own account, install and settings. The app holds no API
key, sends nothing to Anthropic itself and starts no Claude Code, and no shell
but the updater's administrator install, so no credential passes through it and
no window can type into a session.

- **The `claude://` handoff** (`claude_app.rs`): `open claude://code/new?folder=<project>&q=<prompt>`,
  the prompt capped at the Claude app's limit, opened only when LaunchServices
  reports a handler; the prompt is typed into the app, not sent, until the
  person presses Enter there. The kit is stamped first, and if the stamp moved
  files aside a native sheet lists them before the handoff
  (`review_agent_files_for`). The launcher's copy says "Claude Code sends this
  project's files to Anthropic under your own account and settings."
  (`CLAUDE_DISCLOSURE`, `ClaudeLauncher.tsx`). Claude Code's permission mode is
  the person's: the app sets none.
- **What the kit auto-allows** (`kit.rs`, `managed_allow_rules`): `Bash(./kb *)`,
  the two `kb.py` spellings, the template's `git status/diff/log/add/commit`,
  and `Read` of `~/Kookaburra Cut/_bridge/**`, `themes/**`, `brands/**` and
  the app bundle's `Resources/**`. The git rules stay only in a folder whose
  `.git` the app would run git in itself (`history::agent_git_verdict`), since
  plain git runs the folder's hooks and the programs its config names: a live
  hook found on a folder's first open moves to `.git/hooks.moved-aside/` and the
  review sheet lists it (`sweep_agent_files`), and a `.git/config` the app
  refuses, a `.git` that is a link or file, a hook added later, or another
  repository inside the project leaves the agent no git allow rule and a `Bash(git:*)` deny, decided again at every
  stamp and logged `[kit]`. kb's `bash-pre` hook refuses the same live, for a
  session that starts in a terminal after the folder changed
  (`kblib/hookfast.py`, `git_withheld`). Every stamp (first load per session, before
  each handoff) rewrites `.claude/settings.json`:
  only `$schema`, `model`, the managed `allow`, `ask` and `deny` rules and the
  hooks with the kb marker stay, `.claude/settings.local.json` is cut to `$schema`
  and `model`, and `.claude/commands/`, `.claude/agents/` and unshipped
  `.claude/skills/*` are deleted, each logged `[kit]`. `WebFetch` and `WebSearch`
  ask, and `Read` of credential paths is denied, for the agent's own tools. Hooks
  run `kb.py hook …` only (`SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`; the first two print a fixed
  note instead when the kit is missing), and only once the person
  accepts Claude Code's own folder trust. Release and dev builds restamp when
  any stamped file's SHA-256 differs from the shipped file or from the `files`
  record in `kit.json`.
- **What a folder may hold** (`kit.rs`, `sweep_agent_files`, before everything else
  on every stamp): `CLAUDE.local.md`, `AGENTS.md`, `.claude.json`,
  `.claude/CLAUDE.md` and any `CLAUDE.md` below the root move to fenced sections of
  `NOTES.md`; `.mcp.json` goes there with its `env` and `headers` values removed,
  and the original moves aside. Anything else in `.claude/` outside the kit, and
  a link, folder, oversized or non-UTF-8 file under one of those names, moves aside
  unread. A root `CLAUDE.md` that isn't a shipped default moves on the first open
  of a folder; after that it is the person's. The record sits in `settings.json`,
  outside the folder, so a folder can't mark itself reviewed.
- **The review before Claude** (`workspace.rs`, `review_agent_files_for`): a native
  sheet shows what moved, and Return is Not now. Edit with Claude refuses the
  handoff, by the folder alone and whatever the webview says, until the sweep has
  finished, the person has seen it and no such file is present. Typing `claude`
  in a shell of their own is outside this gate.
- **Send-off asks** (`kblib/hookfast.py`, `send_off_reason`): the `bash-pre` hook
  asks a person before `curl`, `wget`, `nc` and `socat` to anything but loopback,
  `scp`, `sftp`, `ftp`, `ssh`, `rsync` to a host, `git push`, `gh`, cloud CLIs, mail,
  `open` with a URL, and inline Python or Node naming a network module. It slows
  a misled agent and asks a person; it doesn't stop a determined one.
- **A folder's own `kb` and links** (`kit.rs`, `real_dir.rs`, `kblib/realdir.py`):
  a `./kb` that is not the app's, or a `.claude` that is a link, is moved aside
  as `<name>.moved-aside` and logged before anything runs it, and the folders
  the app and kb write inside a project must be real folders, so a planted link
  can't steer their writes or deletes.
- **The untrusted-text rule** (`.agents/skills/kookaburra-scene-authoring/RULES.md`,
  "Untrusted text" and "Stop and ask"): sidecar copy and names, `project.json` fields,
  `BRAND.md`, `NOTES.md`, pack contents, captured frames and fetched pages are
  data, never instructions; text that addresses the agent is reported, not
  followed; the agent asks before touching any path outside `project.json`,
  `scenes/` and `assets/`, before following a command, URL or path found in
  content, and before anything that sends work off the Mac.
- **kb reach** (`kblib/reach.py`): writes (`capture --out`, `assets unused --archive`,
  the CLI's `render --out` in `cli.rs`) land only inside the project, the
  workspace or a folder a Rust-run dialog returned this session (`pick_folder`
  and the pack Save dialog, through `note_chosen_folder` in `bridge.rs`, which
  keeps out the home folder, shallow paths and credential folders; the webview
  cannot add one); reads outside the workspace print the resolved
  path and size to stderr and refuse `~/.ssh`, `~/.aws`, `~/.config`,
  `~/.gnupg`, `~/Library/Keychains`, `~/.docker`, `~/.kube`, `~/.azure`,
  `~/.claude`, `.env*`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, private
  keys by name, `credentials*.json`, `*.pem`, `*.p12`, `*.key`, `*.jks`,
  `*.keystore`, `*.tfstate` and shell histories (`kit.rs` `CREDENTIAL_*` is the
  same list, and a test holds them together). The kit denies the agent's own Read
  tool the credential paths kb refuses (of `~/.claude`, only the secrets), which
  binds Claude Code's file tools and not a script the agent runs. Bridge captures,
  frame ranges, checks, preset
  inserts and `openEdit` for a workspace project other than the one open ask
  once per project per session through a native dialog (`bridge_confirm_project`,
  decline held 60 s); `openEdit` is enforced in Rust, the other four in the
  render window's JavaScript (`src/render/bridgeService.ts`, `allowedProject`).
- **What the agent reads goes to Anthropic.** Frames and words kb saves on this
  Mac (`.kb/reference/` among them) leave it when the agent reads them.
  `<exe> media ocr` reads words from stills through Vision on this Mac, with no
  network (`ocr.rs`).
- **Output escaping** (`src-tauri/src/clean_text.rs`, `kblib/util.py`
  `clean_text`): every bridge response value and every kb `emit`, `emit_json`,
  error and hook context escapes C0 and C1 controls (not `\n` and `\t`), bidi,
  zero-width, tag and other format characters as `\uXXXX`, and cuts a string at
  500 characters with ` …[+N chars]`, so an OSC 52 clipboard write in a scene
  name reaches the agent inert as `\u001b]52…`. A project-sourced name stays on one
  line (`clean_name`), so it can't pass as a line of instructions.

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
  (`KOOKABURRA_ACTION` set) mints its nonce without a sheet, and in a release
  build that grant lasts for the launch and never reaches `trustedProjects`. All three commands
  are in the `trust` set, main window only. Deleting a project removes its
  grant. Declining stamps nothing. `copy_scene_to_project` (main and render
  windows) refuses a workspace project, user template or user preset as its
  source unless that source's grant matches its content or this session
  allowed it (`require_source_allowed`); bundled templates and presets ship
  with the app and pass. The main window asks through the native sheet before
  calling, so a person meets the sheet, never the refusal.
- **Website origin grants** (`website_grant_origin`, main window only): an
  `NSAlert` sheet names the origin and the project; the default button, Return,
  is Don't allow. Only a request `website_open` or a blocked navigation raised
  this session can reach it, and any answer spends that request. A grant is once
  per origin per project; an origin already granted asks nothing. The Allow
  gate, moving the workspace, bridge confirmations and these grants are all
  answered natively, so a compromised webview can show the question but never
  press the button.
- **Per-window ACL** (`src-tauri/permissions/*.json`, `src-tauri/capabilities/*.json`):
  every `#[tauri::command]` belongs to exactly one permission set, and each
  window gets only its sets. Main: project read, render and write, trust, media
  library, library, export, capture host, studio, Claude launcher, updater,
  website editor. Present: project read, render, its own window and
  website show. Render: project read, render, bridge serving. Settings: its
  caches, the workspace location, updater and publisher. Packs: pack commands
  and the dialog. Editor and theme editor: theirs. Dev-only commands are
  `cfg(debug_assertions)` and granted only by `capabilities/dev/`, which
  `build.rs` includes in debug builds alone. `src-tauri/src/acl.rs` lists each
  window's commands and fails on a new command until it is placed, on any
  window but main reaching the trust commands, `start_export`,
  `delete_project`, `website_grant_origin` or `init_default_workspace`, and on
  any window but settings reaching `init_workspace` or `move_workspace`.
  `website::guard_invoke` is the second layer: any label outside the seven app
  windows gets no command at all.
- **Worker isolation** (`src/stage/`): every scene tree runs in a Web Worker on
  an OffscreenCanvas with no `window`, `document` or `__TAURI_INTERNALS__`, so
  scene code can't reach IPC even from the main window, and the network is shut
  ("What leaves the Mac"); its native port refuses any project the window did not
  hand it (`stageClient.ts`). Over `asset://` the guard admits its project, pinned
  fonts and the objects it read, and it refuses nested workers, which would start
  without it.
- **Stills on the way in** (`src-tauri/src/imagefile.rs`, `kblib/imagefile.py`,
  `kblib/svgsafe.py`): an imported still is untrusted. Its header is read with no
  decoder and capped first (256 MB, 16384 px a side, 100 MP), and its first bytes,
  not its name, decide the format. An SVG is rewritten from an allow-list of drawing
  elements before it is rasterised.
- **Scene terminals and websites**: a scene's terminal block is text and a baked
  PNG; no process ever runs for it, and its transcript parser drops every escape
  sequence but colours (`sceneTerminalTranscript.ts`). A scene's website block loads
  nothing until the person grants its origin in the editor; the child
  WKWebView has no Tauri capability, no file, media or sensor access, no
  downloads and no new windows; an approved origin reloads in Present on each
  hold without a further click (`src/present/PresentWebsiteOverlay.tsx`).

## Packs

`.kbpack` is a zip whose `manifest.json` lists every payload file with its
SHA-256 and is signed Ed25519 over its exact stored bytes
(`src-tauri/src/pack/`; the format in [docs/packs.md](docs/packs.md)).

- **Signature.** `verify_strict` against the `ed25519:<base64>` public key the
  manifest carries, needing a 64-byte signature; `manifest.sig` is read to a
  256-byte bound (`MAX_SIGNATURE_BYTES`) and a longer entry is refused as
  invalid; inspect reports an unsigned or invalid pack to the trust screen, and
  stage refuses it in Rust whatever the screen saw
  (`pack/key.rs`, `pack/commands.rs`). Every file is re-hashed as it is
  extracted and one mismatch fails the import (`pack/read.rs`,
  `HashMismatch`); anything read before staging (a scene source for the code
  viewer, a sidecar for the review) is refused unless its bytes hash to the
  signed value (`read_verified_entry`).
- **The manifest's claims about itself.** The reader recomputes the publisher
  key id from the public key and refuses a declared `keyId` that differs
  (`KeyIdMismatch`); requires each project, template and preset's `root` to be
  the folder apply lands for its kind and slug, once (`ItemRootMismatch`); and
  builds that item's staged scene set (`scenes/**/*.tsx` in the signed file
  list) and refuses the pack when its `sceneFiles` is not exactly that set
  (`SceneFilesMismatch`), so the scene counts, the code viewer and the review
  list what would land.
- **TOFU and its limits.** The key id is `hex(sha256(pubkey)[0..8])`; the store
  (`known_publishers` in `settings.json`) is keyed by the id recomputed from
  the public key, never the declared one (a store an older build keyed by the
  declared id is re-keyed once on first read), and the verdict compares the
  stored public key with the manifest's. A publisher name is self-declared and
  never verified; the same key under a new name warns, and a known name
  (trimmed, case-folded, whitespace collapsed) under an unknown key warns "a
  publisher you know as X is using a different key" (`publisher_verdict`). The
  `device` on a pack is always `Mac`; the computer name is never read. The
  trust screen draws the publisher verdict first and the "Manifest signature
  valid" tick below it, saying files are checked against the signed list as
  they are unpacked and that this proves the pack is whole, not who made it.
  Continue is the primary button only for a publisher this Mac already knows
  under this key; a first-time, renamed or re-keyed publisher gets Cancel as
  the primary button.
- **Review before Continue.** The trust screen lists every requested Website
  origin a pack carries, read from its scene sidecars and hash-checked (`read_pack_scene_docs`,
  `src/packs/packReview.ts`), so nothing is reviewed after the files land. A
  project, template or preset a pack adds or replaces loses that slug's F-001
  grant and its place in this session's allow set
  (`workspace::forget_project_trust`), so the next open asks again; the allow
  goes first, so a failed settings write still asks.
- **What is stripped on import.** Any entry with a `.claude` segment is dropped at
  staging, and so is a hidden file inside an item (`.mcp.json`), each listed on the summary
  (`pack/paths.rs`, `is_dropped_entry`). Every `CLAUDE.md`, `CLAUDE.local.md` and
  `AGENTS.md` at any depth in a landing project, template, preset or brand is
  removed and the author's text saved to `NOTES.md`, shown on the summary, with
  bytes that aren't UTF-8 counted as the author's; a project-shaped item's root
  gets the app's default (`pack/apply.rs`). `__MACOSX`,
  `.DS_Store` and `._*` are ignored. Export never packs `exports/`, `.git/`,
  `.claude/`, `.kb/`, the kb shim, the emoji cache, originals, tap preferences or
  `assets/_meta.json`, which names what a person imported (`pack/scan.rs`,
  `is_excluded`). An edited `CLAUDE.md` and any `CLAUDE.local.md`, `AGENTS.md` or
  `NOTES.md` stay out unless ticked on the export screen, since a person's notes
  may hold anything. Import writes files and never
  compiles: the first open hits the Allow gate.
- **Caps and paths** (`pack/limits.rs`, `pack/paths.rs`): 50,000 entries, 8 GiB
  total, 4 GiB per entry, a 200:1 ratio per entry, path depth 16, path length
  512 bytes, manifest 8 MiB; a structural path validator refuses control, bidi
  and zero-width characters, absolute paths, `..`, dotted folders and files,
  drive letters and extensions outside each kind's allow-list; symlinks and any
  non-regular file are refused; staging is a fresh folder under
  `<workspace>/.kookaburra/import-staging/` removed on drop, and refused before
  it exists when the signed file total would take the volume under 2 GB
  (`check_staging_space`). Per-kind payload
  caps (`limits::kind_cap`: fonts 64 MiB, 3D models 512 MiB, images 256 MiB,
  audio 512 MiB, text 16 MiB, video 4 GiB) are checked against the central
  directory before consent and against the stream while staging; an
  `object.json` `glb` or `thumbnail` path must sit beside the manifest
  (`objects::validate_object_rel`, `isObjectRel`).
- **Review before apply.** The trust screen shows the scene code and website
  origins (loopback flagged as session-only), read from the pack's signed
  sidecars, never the manifest; the summary shows the author's notes.

## Saved secrets

The app keeps one secret: the pack signing key, in the login Keychain and
never synchronised, with the 0600 file fallback described above. Everything else is the
user's: Claude Code's login lives in `~/.claude`, which the app never touches;
website logins live in the Website data store. No password, token or key is
printed by the app or written to its logs.

## Managed preferences

Five keys in the domain `com.mpalmes.kookaburracut`, honoured only when a
configuration profile forces them (`src-tauri/src/managed.rs`): `DisableClaude`,
`DisableLiveWebsites`, `AllowedPublisherKeyIds`, `DisableUpdateCheck` and
`WorkspaceRoot`. Settings marks each affected row "Managed by your organisation".
The key table and a sample profile are in `docs/mdm.md`.

## Release integrity

A release is a signed `v*` tag on `main`; `.github/workflows/release.yml`
builds it in separate jobs, each on a fresh runner.

- **Build, with no signing secret in reach.** The build job checks that the tag
  is signed by a key in `main`'s `.github/allowed_tag_signers` (read from `main`,
  never from the tagged tree) and sits on `main`. Before any dependency or
  repository script runs, it unpacks the licensed device models from a private
  repository's `age`-encrypted archive. It then refuses any glb that does not match
  `src/assets/models/licensed.sha256`, builds the ffmpeg sidecar from sources
  pinned by SHA-256 and commit (`scripts/build-ffmpeg-sidecar.sh`), fetches the
  beat model against its pins, runs `pnpm tauri build --no-sign` and uploads the
  unsigned app with its SHA-256.
  Its only secrets are the read-only token for that private repository and the
  archive's decryption key; neither can sign anything. The toolchain is pinned:
  `rust-toolchain.toml`, an exact Node in `engines`, pnpm through corepack
  against the hash in `packageManager`, and cmake, nasm and pkgconf from SHA-256
  pinned releases (`scripts/install-build-tools.sh`). The runner image and its
  default Xcode still float, so `build-info.txt` records them. The job uploads that
  file and a digest of every bundle file as its own artefact, which the sign
  job never touches.
- **Sign, in the protected `release` environment.** Behind a required reviewer
  (one, the maintainer, who can approve their own run) and limited to `v*` tags,
  the sign job checks the payload's digest against the
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
  the updater signature verifies against `plugins.updater.pubkey`; `latest.json`
  names the same signature and version; the signed binary runs
  `edit caps` and `check flashes` on a film its bundled ffmpeg renders; and,
  before that binary runs, every file in the zip's app and the updater tar's
  app equals the build job's record with signatures stripped, file list
  included, so a file the sign job adds or changes fails it. Only the seal and
  the notarisation ticket that signing adds are left out.
- **Publish.** `SHA256SUMS` over the DMG, the zip, the updater tar,
  `latest.json`, `build-info.txt` and a copy of this file as it stood at the
  tag; a GitHub build provenance attestation over the DMG, zip, tar and
  `build-info.txt`; a static notes body naming the Team ID; a draft release a
  person publishes. The in-app updater sees a release only once it is
  published.
- **Updater.** `plugins.updater.requireSignedVersion` is on: the app refuses a
  signature whose trusted comment does not bind the announced version, so a
  manifest re-pointed at an older signed archive cannot roll an install back.
  The manifest's notes are never rendered.
- **Repository controls.** `scripts/release.sh` only tags: it refuses unless on
  `main` equal to `origin/main` and this file's first line names the version
  being tagged, prints the commits and the tag-key files changed since the
  previous tag, asks y/N, signs the tag and verifies it against
  `.github/allowed_tag_signers` before pushing; the build job checks the same
  line. Every pull request's head commit
  must be signed by a key in `main`'s `.github/allowed_signers`, or in its tag
  list when it changes `.github/`, a script the release pipeline runs, a lock
  file, `package.json`, `patches/`, `tauri.conf.json` or a build config or pin
  file (`.github/workflows/signers.yml`, run from the default branch's copy). A
  job with no secret fetches the head as data and checks it (`Head commit
  signed`); for a pull request into `main`, a second job posts that verdict as
  `Signed head`, a check run of a GitHub App that holds only Checks write. Its
  private key lives in the `signed-head` environment, which only `main` can
  use, so a workflow a pull request adds can't post as the app. Only the
  head commit is checked, `main` requires no approving review, and everything
  else, including `src/`, `build.rs` and `vite.config.ts`, changes under the
  commit key and is built into what the sign job signs.
  `CODEOWNERS` names the maintainer; `audit.yml` runs
  `pnpm audit` and `cargo deny check advisories` on every pull request
  and weekly. Every workflow but `scorecard.yml` starts from `permissions: {}` or
  `contents: read` (`scorecard.yml` starts from `read-all`, and its one job
  narrows to `security-events` and `id-token`). Every workflow
  pins actions to a commit SHA and sets `persist-credentials: false`.
- **Verify an install.** On the release page's files:

  ```bash
  shasum -a 256 -c SHA256SUMS --ignore-missing
  for f in KookaburraCut-<version>.dmg build-info.txt; do
    gh attestation verify "$f" --repo michael-palmes/kookaburra-cut \
      --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
      --source-ref refs/tags/v<version> --deny-self-hosted-runners
  done
  grep '^commit=' build-info.txt                          # the same commit as the next line
  git ls-remote https://github.com/michael-palmes/kookaburra-cut 'refs/tags/v<version>^{}'
  codesign -dvv "/Applications/Kookaburra Cut.app"       # flags=0x10000(runtime), Authority=Developer ID Application
  spctl -a -t exec -vv "/Applications/Kookaburra Cut.app" # source=Notarized Developer ID
  ```

One maintainer holds admin rights on the repository and is the only reviewer on
the `release` environment, so this pipeline rests on one account. A hardware
security key on the account makes a takeover harder, and a Touch ID tag key in
the Mac's Secure Enclave can't be copied off the Mac, while the promptless commit
key, which agents use, can't tag. Neither stops an account that has been taken
over: the list the tag key is checked against lives in the repository, and an
admin can change it and approve the run.

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
- Bridge request signing: the queue is 0700 and same-user processes are out of
  scope, so it has no authentication beyond the user account.
- Sealing the trust state: `trustedProjects`, `websiteOriginGrants` and
  `knownPublishers` are plain JSON under the 0600 file mode. An HMAC under a
  Keychain secret can't serve headless exports, and after the stage worker a forged
  grant buys only a sandboxed render; native consent closes the webview path.
- A token on the autorun launch variables: `KOOKABURRA_ACTION` and its set are
  honoured in release builds, which is the same-user case above.
- A sandbox for the agent. Its allow and deny rules, hooks and reach checks bound
  its own tools and ask a person; a script a misled agent runs can still read a
  file.
- The still checks on app icons: `import_app_icon` takes only the extension list.
- A second reviewer on the `release` environment, a required review on `main` and
  a pinned runner image and Xcode (`build-info.txt` records both).
- Requiring the app's `Signed head` check. Until the `main` ruleset requires it,
  pinned to the app, in place of `Head commit signed`, a job a pull request adds
  can report under that name, GitHub doesn't say which result counts, and a
  stolen commit key may get past the tag-key rule.
