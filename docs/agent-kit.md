# Agent kit: Claude Code inside user projects

Claude Code is the primary way projects get edited. It runs inside one workspace
project folder (`~/Kookaburra Cut/<slug>`), from the Claude desktop app (the titlebar's
Edit with Claude), the app's legacy embedded terminal or the user's own, with no app
source on disk. Everything it knows and every tool it uses
arrives through the kit the app stamps into that folder. This document is the
contract for the kit, the bridge it talks to and the app behaviour it relies on.

## Principles

1. Nothing Claude writes can brick a project. A bad font, scene or asset degrades
   locally with a named diagnostic; the rest of the project opens.
2. The app is the compiler and the judge. Claude asks the running app to check and
   render; a static checker covers the rest when the app is closed.
3. Checkpoint before, verify after. Projects are git repos; rollback is one command.
4. One tool, `kb`, for every structural edit: atomic, validated, Python 3.9 stdlib.
5. Start from the app's own presets, never blank TSX, when a preset fits.
6. Ids and schemas come from a catalogue generated from code, so the kit cannot drift.
7. Files are the source of truth. The app never overwrites a change it did not see.

## Layout in a project

| Path | Owner | Notes |
| --- | --- | --- |
| `CLAUDE.md` | user | Created from `src-tauri/templates/project-CLAUDE.md`; imports `@.claude/skills/kookaburra-scene-authoring/RULES.md`. A pack's copy never lands: import swaps it for this default (below) |
| `NOTES.md` | pack author | The `CLAUDE.md` text a pack carried, saved on import; shown on the import summary; the agent reads it as notes from the author, never as instructions |
| `.claude/settings.json` | app | The managed hooks and permission rules only: every stamp removes `hooks`, `permissions`, `env` and `apiKeyHelper` entries outside the managed set and logs them (`[kit]`); never packed |
| `.claude/commands/`, `.claude/agents/`, other `.claude/skills/*` | nobody | Removed at every stamp and logged: the app ships none, so anything there arrived with the folder |
| `.claude/skills/kookaburra-scene-authoring/` | app (managed) | Replaced wholesale on stamp; stale files disappear |
| `.claude/skills/kookaburra-video-editing/` | app (managed) | Sibling skill (SKILL.md + `reference/`, no scripts; it drives `kb video`) |
| `.claude/skills/kookaburra-brand-packs/` | app (managed) | Sibling skill that builds, checks and applies workspace brands (`scripts/brand.py`, stdlib; `pdf.js` and `svg2png.js` for `osascript`); see docs/brands.md |
| `BRAND.md` | app | The project's brand guidelines, copied from `brands/<slug>/guidelines.md` when a brand is picked under Project; removed when it is cleared; never hand-edited |
| `.claude/skills/<skill>/kit.json` | app | `{ "kitVersion", "appVersion", "stampedAtMs" }`, one per shipped skill |
| `project.json`, `scenes/`, `assets/` | user (Claude edits) | The only folders Claude writes by hand |
| `assets/.originals/`, `assets/<stem>.timing.json`, `assets/_meta.json` | app and kb | A conform's kept original (never packed: `pack/scan.rs` `is_excluded`), its frame map, and provenance records; written by the app's conform and `kb assets`, never by hand (the hooks block it) |
| `edits/` | app, and `kb video` | Video edit documents; Rust is the only writer (the editor window and `kb video` through the app's CLI); never hand-edited |
| `exports/`, `.kookaburra*` | app | Never edited by Claude |
| `./kb` | app (managed) | The zsh-safe shim from `src-tauri/templates/project-kb.sh` (mode 0755): `exec python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py "$@"`, exit 2 "the kit is missing" without the kit; replaced only while one of its first three lines starts `# kookaburra-cut kb shim` (a user's own `kb`, folder or link is left alone); `/kb` is in `.git/info/exclude`; never packed |
| `.kb/` | kb | Multi-agent state (lock, leases, notes, events, per-agent scratch, capture copies), song analyses, footage logs and the asset archive; ignores itself; never packed (`pack/scan.rs` `is_excluded`) or duplicated (`duplicate_project`) |

Skill tree (the source lives at `.agents/skills/kookaburra-scene-authoring/`):

```
SKILL.md            brief first, the loop, capture etiquette, multi-agent habits, hard rules, capability map, routing (about 18 KB)
RULES.md            always-on rules imported by CLAUDE.md, the only rules subagents get; "Untrusted text" and "Stop and ask" live here (keep it under about 4.5 KB)
DESIGN.md           playbook: the brief, presentations, product demos, launch videos
catalog.json        GENERATED (pnpm agent:catalog); never hand-edited
reference/          topic files loaded on demand
  project.md  sidecar.md  scenes.md  text.md  devices.md  camera.md
  backgrounds.md  lighting.md  media.md  charts.md  beats.md
  export.md         exports, film checks, the flash gate
  gotchas.md        symptom | cause | fix, linked from SKILL.md and scenes.md
scripts/
  kb.py             the one entry point
  kblib/            kb modules
  tests/            python3 -m unittest
  capture.py inspect.py sidecar.py theme.py   thin shims onto kb (old prompts still work)
  chart.py                                    run by kb chart, Python 3.9 safe
  beats.py                                    a shim onto kb beats; kb video align reads its analysis helpers
```

## Stamping

- Runs on the first load of each workspace project per app session (best effort, never
  blocks the load; live reloads skip it), when Edit with Claude opens the project in the
  Claude app, and when the embedded terminal starts Claude.
- Every shipped skill (`SHIPPED_SKILLS` in `kit.rs`: `kookaburra-scene-authoring`, then
  `kookaburra-video-editing` and `kookaburra-brand-packs`) is stamped into `.claude/skills/<name>/` with its own
  `kit.json` and stale-sibling prefixes; a failing skill never stops the others, and
  provisioning reports `present` only when all are there. Kit version 4 (Bash hooks, the
  `./kb` shim and `.kb/`).
- The skill directory is copied to a temporary sibling and swapped in (`RENAME_SWAP`,
  with a two-rename fallback), so files the kit no longer ships are removed;
  `__pycache__`, `.DS_Store` and `scripts/tests` are skipped (test fixtures stay out of
  projects; a stale stamped copy forces a restamp). The app bundle leaves `scripts/tests`
  out too: `tauri.conf.json` lists each skill's files and folders, and a `kit.rs` test
  fails when a shipped file is not bundled. Dev builds restamp when the shipped tree
  differs byte for byte (never mid-session for nothing, since a hook may be running
  `kb.py`); release builds restamp when `kit.json`'s `appVersion` differs. Both restamp when
  any stamped file's SHA-256 differs from the shipped file's or from the `files` record
  `kit.json` carries (`{ "<kit-relative path>": "<sha256>" }`, written at stamp time), so a
  deleted, truncated or same-size edited `kb.py` heals on the next load. Declining
  the trust prompt stamps nothing. Code: `src-tauri/src/kit.rs`.
- `CLAUDE.md`: written when missing. When it still matches a previous default
  template (whitespace-normalised; every past default lives in
  `src-tauri/templates/claude-md-history/`) it is replaced with the current one.
  Otherwise, when it lacks the RULES import, the import line is inserted after its
  first heading. Nothing else in a user-edited `CLAUDE.md` is touched. Changing the
  template means archiving the old one first (a test pins its digest).
- `./kb`: the shim (`stamp_shim`), written from `src-tauri/templates/project-kb.sh` with mode
  0755 when missing, and rewritten (content or mode) while it carries the marker; any other
  `kb` at the project root is the user's and is never touched. kb adds `/kb` to
  `.git/info/exclude` with its other entries, so the shim never lands in a user's commit.
- `.claude/settings.json`: created when missing, and app-owned. Every stamp replaces
  `hooks` with the managed set (identified by a command containing
  `kookaburra-scene-authoring/scripts/kb.py hook`), keeps only the managed
  `permissions.allow` rules (the template's git rules and the set below) and drops every
  other `permissions` key, `env` and `apiKeyHelper`; each removal is logged as `[kit]`
  with the path and value. Other keys (`model`, say) are left. An unparseable file is left
  alone. The file is only rewritten when its content changes, and then with sorted keys.
  Before the settings, the stamp removes `.claude/commands/`, `.claude/agents/` and any
  `.claude/skills/*` the app does not ship, logging them. Nothing a folder arrives with can
  configure the agent; what the person wants the agent told goes in `CLAUDE.md`, which
  Claude Code reads as instructions and the stamp leaves alone past the RULES import.

Managed settings:

```json
{
  "permissions": {
    "allow": [
      "Bash(./kb *)",
      "Bash(python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
      "Bash(python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
      "Read(~/Kookaburra Cut/_bridge/**)",
      "Read(~/Kookaburra Cut/themes/**)",
      "Read(~/Kookaburra Cut/brands/**)",
      "Read(//Applications/Kookaburra Cut.app/Contents/Resources/**)"
    ]
  },
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [
      { "type": "command", "timeout": 20,
        "command": "[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook session-start" }] }],
    "PreToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "timeout": 20, "command": "<guard> || python3 -I <kb.py> hook pre-edit" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 10, "command": "<guard> || python3 -I <kb.py> hook bash-pre" }] }],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "timeout": 30, "command": "<guard> || python3 -I <kb.py> hook post-edit" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 30, "command": "<guard> || python3 -I <kb.py> hook bash-post" }] }],
    "PostToolUseFailure": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 30, "command": "<guard> || python3 -I <kb.py> hook bash-post" }] }]
  }
}
```

`<kb.py>` is `"$CLAUDE_PROJECT_DIR"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py` and `<guard>` is
`[ ! -f <kb.py> ]`, written out in full in every command as SessionStart shows. A Bash command that exits
non-zero fires PostToolUseFailure, not PostToolUse, so `bash-post` is wired to both.

Each command is guarded so a missing `kb.py` exits 0 and never blocks an edit; `kb.py`
itself fails open (exit 0) when its modules are missing mid-swap. Hooks only run once the user has accepted Claude Code's workspace trust for the folder.

## kb

`./kb <command>` (the shim; `python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py`
underneath), run from the project folder (it also finds the project by walking up from the cwd, or from
`$CLAUDE_PROJECT_DIR`). Python 3.9, standard library only, `from __future__ import
annotations` in every module, and `kb.py` inserts its own directory into `sys.path`
(isolated mode drops it). Output, exit codes, errors and writes follow "kb conventions"
below. Every write is atomic (temp file in the same folder, then rename), compare-and-swap
under the project lock (`kblib.lock`) and re-validated after writing.

| Command | Does |
| --- | --- |
| `status` | App alive (heartbeat), version, open project, aspect, exporting; this project's last load result; kit version; checkpoint state; a leading STOP banner when the project is a linked git worktree (`--json`: `worktree` is `{ path, main }` or null) |
| `context` | The SessionStart text: status, scene roster, last load errors, the five rules that matter most (under 4 KB) |
| `scenes` | Roster: index, stem, name, duration, transition, text, overrides (replaces `inspect.py`) |
| `check [--app] [--render] [files...]` | Static checks (below); `--app` adds the running app's real compile, load and font checks; `--render` also renders each scene once; `check film ...` hands its arguments to `kblib/film` (`run(ctx, rest)`) |
| `capture [--scene S] [--at SEC\|POS] [--aspect A] [--frames S@SEC,S@POS,POS,bars:A-B,beats:A-B] [--sheet] [--width N \| --scale F] [--probe X,Y[,X,Y...]] [--out DIR \| --no-copy]` | Frames from the running app (one frame native, several or a sheet at a 1280 px long edge); prints the paths of copies in `.kb/captures/`; `--sheet` adds one contact-sheet PNG; `--probe` returns exact pixel values ("The capture service"). A musical position resolves against `audio.grid` to the scene that owns it (mid-transition, the one the editor shows as current); with `--scene` a position outside it is exit 1; `bars:`/`beats:` ranges expand to downbeats or beats, 48 frames at most; answers carry `position` and `projectMs` |
| `verify [--scene S]... [--aspect A] [--no-render] [--film]` | Every check before calling the work done, one step at a time (below) |
| `debug contexts`, `debug lose-context [--window render\|editor]` | Every window's WebGL contexts; force a context loss to exercise the stall recovery (the editor only in dev builds) |
| `scene add <stem> [--preset P \| --copy S] [--after S \| --at N] [--duration MS] [--name N]` | New scene, unique stem and `defineScene` id, registered once; presets insert through the app when it runs, else copy from the app bundle |
| `scene duplicate S`, `scene move S --to N`, `scene remove S`, `scene set S [--duration MS \| --duration-bars N \| --cut-at POS [--align end\|mid]] [--transition TYPE[:MS] [--ripple]]` | Manifest-safe scene operations; remove moves files to the macOS Trash. A `--cut-at` position pins the cut (`cutAt`, `align`: the app's `engine/sceneCuts.ts`, mirrored by `kblib/film/timeline.py` and pinned by `timeline-vectors.json`), so its length re-resolves on every grid, transition or scene-list write; a time, `--duration` and `--duration-bars` write whole ms and unpin. With a grid, `--transition` keeps later cuts in place (`keep_cuts_for_transition`, the transition picker's plan) unless `--ripple`, and the reply names any cut a write moved off the beat. `at` caches refresh in the same transaction |
| `timeline`, `timeline apply PLAN [--ripple]` | Every scene's start, end, cut and transition in bars and ms, flagging off-beat cuts, scenes shorter than their transitions, keys outside their scene and cuts that left a beat since the last checkpoint (`kblib/cuts.py`; `check` and `status` share that drift lint). `apply` writes a JSON or markdown plan's cuts and transitions in one checkpointed write (the plan shape is in the kit's `reference/beats.md`) |
| `doc S get [path]`, `doc S set path value`, `doc S unset path`, `doc S merge JSON` | Sidecar edits by dotted path; values parsed as JSON else string (`--string` forces a string, reading `\n`, `\t` and `\\`); enums validated against the catalogue; `get` prints the raw value (`--json`: `{ file, path, value }`). The detach rule (`beats.model.settle_written` over `timed_slots`): a key `tMs` or a screen or media video `startMs` the write moved off its `at` loses the `at`, and every remaining `at` refreshes its time; `merge` never detaches, so an `at` stays unless the patch nulls it (arrays replace whole, so a rewritten field without `at` gets its `at` back). A string `at` this write adds where the app takes no position (chart or layered screenshot keys, taps, anything but the timed slots, `cameraKicks` and `room` keys) is exit 2 `usage` (`stray_positions`) |
| `project get [path]`, `project set path value`, `project unset path` | `project.json` fields other than `scenes` (`get --json`: `{ path, value }`) |
| `theme list`, `theme show [id]`, `theme set path value` | Bundled tokens from the catalogue; workspace themes editable (`show --json`: `{ id, bundled, path, theme }`) |
| `brand list`, `brand show [NAME]`, `brand use NAME`, `brand clear`, `brand icons [--search TERM] [--sheet] [--brand NAME] [--category C] [--all] [--limit N] [--cell PX]` | Workspace brands (docs/brands.md); `use` matches a name, slug or `ws:` id and applies it as the Project picker does (`brand`, default theme, headline and body fonts, `BRAND.md`); `clear` drops `brand` and `BRAND.md`; `icons` searches the brand's library by name, tag and path, and `--sheet` writes contact sheets to `.kb/thumbs/` (`--json`: `items`, `total`, `sheets`, `shownOnSheets`) |
| `fonts safe`, `fonts check REF...`, `fonts list` | Bundled faces are always safe; `check` and `list` use the app's real parser when it runs, else a static verdict (`--json`: `faces`, `results`, `families` or the static `bundled` and `pinned`) |
| `presets [list \| show SLUG]` | Scene presets with what they show and a preview image path to Read (`--json`: `presets`) |
| `catalog [FAMILY] [--search Q]` | Query `catalog.json` (`--json`: `families`; a family's raw entries as `{ family, items }`, or `{ family, value }` when it is not a list; a search's `items`) |
| `assets list`, `assets add PATH [--name N] [--dir D] [--no-conform] [--max-size N] [--allow-blank]`, `assets add-folder DIR [--dedupe] [--thumbs WxH] [--limit N] [--dir D] [--no-conform] [--max-size N] [--allow-blank]`, `assets probe ASSET [--deep]`, `assets conform ASSET [--repoint]`, `assets replace NAME FILE [--keep-old archive\|trash\|none] [--as-new]`, `assets unused [--kind K] [--archive [DIR]]`, `assets restore [ID \| --list]`, `assets meta NAME [--set K=V]` | Media in (never overwrites, renames on collision; `--name` keeps the source's extension; a video the app's probe flags, or that both decoders disagree on once decoded, is conformed through `<exe> media conform`, gated on `edit caps.media`; stills and SVGs as in "Stills on the way in" below), a whole folder (`assets add-folder`, below), the decode verdict (`ok`, `suspect`, `ffmpeg-misdecodes`; the container's own `elst`/`stts`/`ctts` parse without the app, AVFoundation's view with it; an edit opening inside a sample is `ffmpeg-misdecodes` on both sides, `mp4box.rs` and `mp4box.py` replaying one `edit-start-vectors.json`), an in-place conform (`--repoint` turns a `.mov` into `<stem>.mp4` and rewrites literals), an in-place replace with the old bytes in `.kb/archive/`, the app's shared in-use rule (`unused`, archived and restorable; `media.rs` and `asset_refs.py` replay one `asset-ref-vectors.json`), and `assets/_meta.json` provenance (`list --json`: `assets`, each with a conformed clip's timing and provenance folded in). Code: `kblib/assets_cli.py`, `assets.py`, `asset_folder.py`, `asset_ops.py`, `imagefile.py`, `svgsafe.py`, `contact.py`, `conform.py`, `mp4box.py`, `asset_refs.py`, `archive.py`, `asset_meta.py` |
| `checkpoint [MESSAGE] [--scene S]... [--files P]...`, `history [--scene S]`, `undo [REV] [--scene S \| --all]`, `diff [REV] [--scene S]` | Git checkpoints of `project.json`, `scenes/` and `edits/`, or only some scenes' files; `undo` checkpoints first, so it is itself undoable, never trashes `edits/`, and names any render it leaves stale (`history --json`: `checkpoints`, each with `atMs`). See Coordination |
| `lease S [--ttl 2h] [--note T] [--for NAME]`, `lease S --release [--force]`, `leases [--all]` | Opt-in scene leases (`lease --json`: `scene`, `action`, `lease`; `leases --json`: `leases`) |
| `note "TEXT" [--scene S]`, `notes [--all]` | Shared notes in `.kb/notes.md` (`notes --json`: `notes`, `total`) |
| `events [--follow] [--since 10m\|CURSOR\|all] [--kinds ...] [--all-agents] [--exit-after S]` | The coordination feed (`--json` without `--follow`: `events`, `cursor`) |
| `video ...` | Video editing (below): edit documents, renders, re-points, cleanup, fit, review (`list --json`: `edits`) |
| `plan COMMAND ...` | A structural command's dry run: `writes`, `refusals`, `notes`; writes nothing (below) |
| `export [--aspect A] [--preset ID] [--fps 30\|60] [--short-edge N] [--poster-frame on\|off\|app] [--verify] [--headless] [--allow-flashes] [--timeout S] [--progress-every S]` | The finished film, exactly as the app's Export button makes it ("kb export") |
| `verify-export FILE [--no-sheet] [--no-flashes] [--allow-flashes] [--loudness-target LUFS] [--standard wcag\|itu\|both]` | Check an exported film against what the project asked for ("Film checks and verify-export") |
| `sync-check FILE [--bpm N [--offset MS]] [--poster-frame auto\|on\|off] [--threshold PCT] [--window MS]` | Each cut and big picture change against its nearest beat, in ms ("kb sync-check") |
| `hook session-start \| pre-edit \| post-edit \| bash-pre \| bash-post` | Hook entry points (stdin JSON from Claude Code); any other event exits 0, so an older kit is safe with newer settings |
| `beats [--scene S]`, `beats set-grid (--from-analysis [--force] \| --bpm B --offset MS) [--beats-per-bar N]`, `beats set-downbeat AT [--bar N]`, `beats clear-grid`, `beats cue set ID POS \| rm ID`, `beats section set ID --from POS --to POS [--label L] \| rm ID`, `beats resolve POS [--scene S]` | The authored beat grid (`audio.grid`, `cues`, `sections`) and musical positions (`kblib/beats/`, mirroring `src/engine/musicTime.ts` through `kblib/music.py`, pinned by `music-vectors.json` from `pnpm agent:vectors`). Without a grid it shows the analysis's detected beats (`beatSource: "detected"`). Every write validates as `sanitiseAudioMusic` does and rewrites each sidecar's `at` caches in the same transaction (a sidecar leased to someone else is left, with a note) |
| `song analyse [--force] [--tracker nn\|dsp] [--lyrics] [--accept] [--dry-run]` | The app's song analyser through `<exe> song analyse` (works with the app closed): tempo fit, downbeat, sections, breaths, stabs, lyrics on request; cached by the audio's SHA-256 and copied to `.kb/song/<sha12>.json`; `project.json` changes only with `--accept` (`set-grid --from-analysis`, refused for a drifting tempo). Code: `kblib/song.py` |
| `chart ...` | Delegates to `scripts/chart.py`, arguments untouched |

As built (`scripts/kblib/`):

- `doc`, `project` and `theme set` refuse a write that would add errors (exit 1, nothing
  written) unless `--force`. `doc` and `theme set` stamp `staggerExact: true` on a text
  spec whose `staggerMs` they turn to 0 (the inspector's rule).
- The app's font verdicts from `fonts` and `check` responses are cached in
  `~/Kookaburra Cut/_bridge/font-verdicts.json`; static checks honour them, so a
  vetted face stops warning and a failed one is an error naming its fallback.
- `scene remove` and `undo` checkpoint a dirty tree first; `undo` with no revision
  returns to the last checkpoint.
- `scene add --preset` goes through the app's `insertPreset` when it runs (the app picks
  the stem and id from the name), else copies from the bundle; an existing unregistered
  `scenes/<stem>.tsx` is registered rather than overwritten.
- Bridge waits default to 120 s for captures and 300 s for `check` (600 s with
  `--render`), queue included: kb sends the end of that wait as `deadlineAtMs`, and the
  app drops or stops a request whose client gave up. On a large media-heavy project in a
  dev build a cold capture answers in about 10 s, a warm one or an aspect switch in about
  2 s; a 48-frame sheet at the default 1280 px costs a ninth of the old 4K one.
- `kb capture` copies its PNGs into `.kb/captures/<YYYYmmdd-HHMMSS>-<agent>/` with
  readable names (`05-feature@1.5s.png`, `sheet.png`); `path`, `paths`, each frame's `path`
  and `sheetPath` name the copies and `bridgePath`, `bridgePaths`, `bridgeSheetPath` keep
  the app's originals (pruned after an hour). `--out DIR` copies there instead (inside the
  reach below), `--no-copy` skips it; each agent's newest 40 folders are kept, and past 1 GB
  the oldest go, never one under an hour old.
- **kb reach** (`kblib/reach.py`). kb runs with no permission prompt, so it is the boundary.
  Writes it makes on the agent's behalf outside the project (`capture --out`,
  `assets unused --archive DIR`, and the CLI's `render --out`) land only inside the project,
  its workspace, `~/Kookaburra Cut`, or a folder one of the app's own native dialogs
  returned this session; anything else is exit 2 (`usage`) naming the allowed roots. The
  app keeps those folders in memory (`PickedFolders`, fed by every folder dialog and the
  Save dialog's parent, forgotten on quit) and publishes them in the heartbeat as
  `pickedDirs`, which kb and the headless CLI read. Reads of a path the agent names
  (`assets add`, `assets add-folder`, `assets replace`, `chart set-data`, `doc merge @file`, `verify-export FILE`)
  are silent inside the workspace, announced on stderr with the resolved path and size
  outside it (`kb: reading /Users/x/Desktop/deck.csv (812 bytes) from outside the
  workspace`), and refused outright for `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`,
  `~/Library/Keychains`, `.env*`, `.netrc`, `*.pem`, `*.p12`, `*.key` and shell history
  files.
- **Stills on the way in** (`kblib/imagefile.py`). An imported still is untrusted. Its header
  is read with no decoder and capped first (256 MB, 16384 px a side, 100 MP), so a
  decompression bomb never reaches one; what the first bytes say decides the format, whatever
  the name says. The stage reads raw pixel values (`decode_png`, and `createImageBitmap` with
  `colorSpaceConversion: "none"`), so a non-sRGB ICC profile, CMYK pixels and an EXIF
  orientation would each draw wrong and only show up in a frame: `prepare` bakes them into
  plain sRGB, upright pixels through `sips`, which is ImageIO, the decoder WebKit itself uses
  (kb never decodes WebP or JPEG itself; off macOS it can only read PNG, and refuses others,
  exit 2). `sips` can't write WebP or GIF, so one that has to change becomes a PNG. A fully
  transparent or one-colour result is refused (`refuse_blank`, `--allow-blank`), measured on
  a 64 px reduction with a tolerance of 3 levels. Provenance is recorded only when kb changed
  the bytes, with `origin.sourceSha256`, so adding the same file the same way lands nothing
  new. Images in the app's own drop path are not checked.
- **SVGs** (`kblib/svgsafe.py`). AppKit's parser reads a `file://` image straight off the disk
  into the raster, so the rasteriser (the brand skill's `svg2png.js`) never sees the source. The
  source is parsed with expat and rewritten to a temp copy from an allowlist of drawing
  elements: no script, `foreignObject`, event handler, DOCTYPE or processing instruction, and no
  `href`, `url()` or `@import` that leaves the document (`#fragment` and a raster `data:` URI
  stay). Whatever a person would notice missing is named in a warning. Malformed XML, a root
  that isn't `<svg>`, an external or nested entity, and files past the size, depth or expansion
  caps are refused. `kb assets add` and `brand.py images` share it.
- **`assets add-folder`** (`kblib/asset_folder.py`). `reach.guard_read` guards the folder, which
  is announced once, and refuses one that holds the project or sits inside `assets/`. The walk
  never follows a link, in or out, and skips hidden names, credentials (`denied_reason`, per
  file) and other file types. It stops before copying anything past 500 media files without
  `--limit` (2000 at most), 20000 entries, 12 levels, 32 GB in total or the free disk; one file
  over 16 GB is refused alone. Files land through `assets.add_file`, keeping the folder's shape
  under `--dir` in slugged names, and refused ones are collected (exit 1, `invalid`, with the
  whole report in the envelope). SVGs rasterise in one `osascript` per 80, split down when one
  hangs or crashes so the file at fault fails alone, and provenance is one write at the end. `--dedupe` hashes a file against the batch, `origin.sourceSha256` and, only
  where the size matches, `assets/` and `assets/.originals/`. `--thumbs WxH` and `kb brand icons
  --sheet` draw sheets in plain Python (`kblib/contact.py`), on the surface each picture suits,
  into `.kb/thumbs/<time>-<tag>/` (the newest 20 kept), so they are never in `assets/`, a pack or
  project history.
- **Output escaping** (`kblib/util.py` `clean_text`). Every string kb prints (`emit`,
  `emit_err`, `emit_json` leaves and keys, the export stream, hook `additionalContext` and
  deny reasons, `KbError` messages and `Report` issues) has its control characters (newline
  and tab excepted) and Unicode format characters (bidi controls and tag characters
  included) escaped as `\uXXXX` or `\UXXXXXXXX`, and is capped at 500 characters with a
  ` …[+N chars]` marker (per line for text output). A scene named with an OSC 52 sequence
  reaches the agent as `\u001B]52...`. The bridge applies the same rule to every response
  it writes (`src-tauri/src/clean_text.rs`, in `write_response_value`).
- `kb.py` never writes bytecode into the kit: it points `sys.pycache_prefix` at
  `$TMPDIR/kb-pyc/<sha1 of kit.json>[:12]` (a folder it owns, mode 0700; otherwise no bytecode at
  all), so the stdlib and `kblib` compile once per stamp. It fails open for hooks when its modules
  are missing.
- `--json` is one envelope everywhere (`ok_envelope`, or `emit_ok` in modules not handed a
  context). The old bare arrays moved under keys: `history` to `checkpoints`, `fonts safe` to
  `faces`, the static `fonts check` to `results`, `presets` to `presets`, `catalog --search`
  to `items`, `assets list` to `assets`, `video list` to `edits`. A report that exits 1
  (`check`, a scene write whose check fails, a failing `fonts check`, a search with no hits)
  is `ok: false` with `code` and `error`; argparse's usage errors print the error envelope too.
- `doc`, `project` and `theme set` re-apply their op to the fresh document through
  `mutate_json` (workspace themes skip the project lock); scene operations and offline preset
  inserts plan on a transaction from a fresh `project.json` (asset copies included); kb
  video's re-points, start and follow writes and duration syncs use `mutate_json`; `undo`
  holds the project lock around its checkout. Structural `--json` results list `writes` and
  `dryRun`; `checkpoint --dry-run` and `undo --dry-run` only read git.
- Exit 3 so far: the project lock or an edit lock held (`locked`, with `holder`), a write
  that kept conflicting (`conflict`), a git timeout (`transient`), `.git/index.lock` held past
  the backoff (`index-locked`, with `lockAgeMs`).

`kb verify` (`kblib/verify.py`) runs, in order, each as `{ name, ok, ms, errors, warnings,
skipped?, paths?, transient?, retryAfterMs?, code? }` under `steps`:

1. `static`: the static check, scoped to `--scene` files when given.
2. `app`: `check --app --render` (`--no-render`: load only); skipped with a note when no
   instance serves this project, and then `captures` and `handoffs` skip too.
3. `captures`: each scene's first and last solo frames (after its incoming transition,
   one frame before its outgoing one), at most 16 frames a request, one request at a time,
   at the 1280 px long edge (`width` sent explicitly) with a 64-point probe grid and a
   contact sheet per request (`sheet-N.png` when there are several), copied into one
   `.kb/captures/` folder. Skipped after a transient app step.
4. `handoffs`: the mean probed luminance step across each seam between neighbouring
   captured scenes, through `film/handoffs.flag_seams`: a cut of ΔL 0.10 or more next to
   a scene under 1 s warns, and four such cuts inside one second warn as a strobe. Warnings
   only, like `check film handoffs`.
5. `flashes`: the flash check of the newest `exports/` film only when its mtime is newer
   than `project.json`, `scenes/**` and `assets/**`; else skipped, naming the newer file.
   `--film` replaces it with `export` (`./kb export --fps 30 --short-edge 720
   --allow-flashes --json` as a child process, progress on stderr) and `film` (`check film
   --file` on that export, in process). The draft moves to `.kb/verify/<stamp>/` (the last 5
   kept), and any Custom export already in `exports/` is held aside meanwhile and put back, so
   the draft never replaces a film of the user's.

Exit 1 when any step has errors, else 3 when a step was transient (`retryAfterMs` at the
top level), else 0; skipped steps pass, and the text summary says when only the static
check ran.

`kb plan COMMAND ...` (`kblib/plan.py`) parses the command with kb's own parser, refuses
anything outside scene add, duplicate, move, remove and set, doc set, unset and merge,
project set and unset, theme set, assets add, conform, replace, unused, restore and meta,
checkpoint, undo and lease (exit 2; beats and song writes take their own `--dry-run`), runs it
in process with `dry_run` and `json` set and its stdout captured, and reports `{ plan,
argv, writes: [{ path, action: create | modify | trash | delete, base, refusal? }],
refusals, notes, dryRun: true }`. A dry run that raises an exit-1 `leased`,
`others-changed`, `invalid` or `conflict` error becomes a refusal on its file's write;
lease plans synthesise the `.kb/leases/<stem>.json` write (`delete` for a release). Exit
1 when anything would be refused, else 0. Text: one line per write, then refusals and
notes.

Static checks: `project.json` (valid JSON, version, required fields, files exist, no
duplicate entries, transitions and options, formats, theme id, audio file); sidecars
(JSON, version, unknown top-level keys, enum values, font refs, asset paths exist with
exact case and a supported extension; a missing `assets/<stem>.mp4` whose original sits in
`assets/.originals/` with no `<stem>.timing.json` yet is a conform still landing, so `info`,
not an error; a text spec's `staggerMs: 0` without `staggerExact` warns where a granularity
default would replace it, in workspace themes too); TSX (imports only `@kookaburra/toolkit`, one
`export default defineScene(`, a literal id unique in the project, no wall clock,
timers, `Math.random`, DOM or drei `Html`, no React hooks, which the toolkit does not
export; unknown `ease("...")` names warn). Devices warn when the heartbeat's build lacks
their model, and when TSX passes `position`, `rotationDeg` or `ground` to a `Device` in a
scene whose sidecar has a `deviceLayout`. Errors exit 1; warnings print but pass; `info` lines are notes only.

- **Music.** `audio.grid`, `cues` and `sections` under `sanitiseAudioMusic`'s rules (what the
  app drops is an error); `bar:` values with no grid, and a grid whose `source.sha256` is not
  the soundtrack's, warn. Each `at` on a camera, rig, lighting, device-track or comparison key,
  or beside a screen or media video's `startMs`: bad syntax or range, or a start it can't apply
  to (an image, `startOn: "open"`, a pre-roll beside `inMs`), is an error, no grid or an
  unknown cue warns, and a time that is not where the `at` lands warns (the app rewrites it on
  load). An `at` on a chart or layered screenshot key warns (the app ignores it).
- **Device media keys** (`devices[].media`, `coverMedia`, `compare.b.media`/`coverMedia`), as
  `parseDeviceMediaKeys` judges them: a key the app drops is an error; an unknown key, a speed
  outside the inspector's 0.25 to 6, an inert `posterMs` and timing keys on an edit's render
  warn; with a probed length (kb video's probe cache) `inMs` at or past the end is an error and
  `outMs` past it a warning.
- **Camera kicks.** `cameraKicks` as the app parses them (bad fields error, unknown fields
  warn, an unresolvable position warns), plus a warning for an orbit kick that pulls out in a
  scene staging `<DepthStage>`.
- **Assets** (full check only, a 2 s budget, `kblib/assets_check.py`): a scene video ffmpeg
  misdecodes warns (from `kb assets probe`'s verdict cache, else the container's sample
  tables; a conformed mezzanine is never flagged), and a stale `assets/_meta.json` record is
  `info`.

Hooks:

- `session-start` prints `context`. Never fails the session. When the project or the
  hook's `cwd` is a linked git worktree (its `.git` is a file pointing into
  `.git/worktrees/`), a STOP banner leads: the app never sees a worktree, so the agent
  must edit nothing and ask for a session in the project folder itself. The `cwd` check
  matters because a desktop worktree session can carry the main folder as
  `CLAUDE_PROJECT_DIR`. Detection reads files only (`worktree_of` in `project.py`).
- `pre-edit` blocks (exit 2 with a reason) writes to app-owned paths, to the managed
  kit, to anything inside a linked git worktree of a project (the same STOP text) and to
  kb's state files (`.kb/lock`, `.kb/.gitignore`, `.kb/leases/**`, `.kb/events*.jsonl`,
  `.kb/notes*.md`, `.kb/agents/*/identity.json` and `seen.json`; scratch under
  `.kb/agents/<name>/` and `.kb/captures/` is allowed), and to the asset records
  (`assets/_meta.json`, `assets/**/*.timing.json`, anything under `assets/.originals/`),
  each reason naming the kb command to use (`kblib/hookfast.py` `asset_record_reason`). An edit to a scene leased to
  someone else is denied with `permissionDecision: "deny"`, naming the holder, the expiry
  and how to bind or leave a note; the holder's own edit renews the lease. Before the first
  write of a session into `project.json` or `scenes/` it makes a checkpoint when the tree
  has changes since the last one. When `.git/index.lock` stops that checkpoint, the edit
  goes ahead with plain `additionalContext` saying so and naming the last checkpoint, no
  session marker is written (the next write tries again), and `checkpoint.skipped` is
  journalled.
- `post-edit` journals `files.changed` (`via: "edit"`) and runs the static check scoped to
  the edited file (plus the manifest cross-checks). Errors the edit introduced exit 2 so
  Claude sees them and fixes them; errors the file already had (snapshotted by `pre-edit`,
  keyed by the tool call) and warnings go back as `additionalContext`. It must finish in
  about a second; it never calls the app.
- `bash-pre` and `bash-post` run from `kblib/hookfast.py`, which `kb.py` dispatches to
  before importing `kblib.cli` (standard library only; `check` loads only once a command
  changed something). On `/usr/bin/python3` 3.9 with the bytecode cache warm a Bash hook
  costs about 58 ms when nothing changed (the bare interpreter is about 48 ms) and about
  80 ms when a sidecar changed; the first run after a stamp compiles (about 105 ms).
  - `bash-pre` stamps `project.json`, `scenes/**` and `edits/*.json` (`<st_mtime_ns>:<size>`;
    dotfiles, `*.tmp` and `*.kbtmp` skipped) into `$TMPDIR/kb-hooks/bash-<sha1(root, tool_use_id)>.json`.
    It binds every `--agent NAME` a kb call passes to the hook's session and agent id, before
    kb runs. It denies a command that names `scenes/<stem>` of a scene leased to someone else
    (globs included) and visibly writes it: a redirection, `tee`, `mv`, `rm`, `touch`, a `cp`
    or `install` destination, `sed -i`, `perl -i`, a heredoc, `write_text` or `open(..., 'w')`.
    It denies the same visible writes to an asset record (a glob expands as the shell would,
    relative paths resolve from the hook's `cwd`; `sed -i` and Python writes count when they
    name one; a read, a `cp` out of `assets/.originals/` and kb-only commands pass). It makes the session checkpoint before a command that visibly writes `scenes/` or
    `project.json` or runs a kb write, and records the errors the scene files and `project.json`
    it names already have. kb-only commands and `run_in_background` calls take no snapshot.
  - `bash-post` diffs the stamps, drops files other callers journalled meanwhile and the
    caller's own kb writes (kb checked those), journals
    `files.changed` (`via: "bash"`) and runs the scoped check on the changed sources (the
    full check past 20 files). Errors in the changed files, a change to `edits/` without
    `kb video`, and a change to a scene leased to someone else (journalled `lease.violated`)
    exit 2 with stderr; errors a named file already had, and warnings, come back as
    `additionalContext`. After PostToolUseFailure it replies only through `additionalContext`.
    Only files the command names get that baseline (a script or glob writes others), which is
    why Edit, Write and `kb doc` stay the preferred way to change scene files.

## kb conventions

Every kb command, including new ones, follows these rules. Code: `scripts/kblib/util.py`
(`KbError`, `ok_envelope`, exit constants), `scripts/kblib/lock.py` (writes).

- **Invocation.** `./kb <command>` from the project folder. Never store kb in a shell
  variable (zsh does not split it). Hook paths never import `kblib.cli`.
- **Global flags.** `--json` on every command. `--agent NAME` names the caller (`KB_AGENT`
  only in a plain terminal: an allow rule does not match past a `VAR=` prefix, and kb ignores
  it while `CLAUDECODE` is set, so an inherited value never names every agent alike).
  `--dry-run` and `--wait [SECONDS]` on every structural command (scene add, duplicate, move,
  remove and set; doc set, unset and merge; project set and unset; theme set; assets add,
  add-folder, conform, replace, unused, restore and meta; beats set-grid, set-downbeat, clear-grid, cue and
  section; song analyse; checkpoint; undo); `./kb plan <command ...>` is the same dry run for
  the ones it covers.
- **Output.** Plain text for people. `--json` prints exactly one object on stdout:
  `{ "ok": true, "command": "scene add", ...payload }`. A streaming command
  (`events --follow`, `export`) prints one compact object per line, the final object
  last. Lists go under a plural key (`scenes`, `checkpoints`, `items`), never as a bare
  array. Keys are camelCase, times integer ms (`atMs`, `durationMs`), paths
  project-relative with `/`, except files an agent should Read (capture copies, contact
  sheets, verify's sheets and frames, an export's `path`), which stay absolute so Read takes
  them as printed. Diagnostics go to stderr. A report that exits 1 (problems found)
  is `ok: false` and carries `code` and `error` like a failure.
- **Failures.** In `--json` mode a failure prints
  `{ "ok": false, "command", "code", "error", "hint", "retryAfterMs"?, ...data }` on
  stdout, and the text (`kb: <error>` then `  hint: <hint>`) on stderr either way.
- **Exit codes.**
  - 0 ok.
  - 1 problems: errors found, a write that would add errors, a lease or scope refusal,
    a flash failure. Rerunning unchanged gives the same answer.
  - 2 usage or environment: bad arguments, no app, no git, trust or an update needed,
    GPU wedged. A person must act.
  - 3 transient, safe to rerun unchanged after `retryAfterMs`: app busy, request not
    yet claimed, throttled, GPU stalled (the render window was recycled), project lock,
    edit lock or `index.lock` held, a write that kept conflicting.
- **Errors.** `raise KbError(message, exit_code, kind=, hint=, retry_after_ms=, data=)`.
  `message` is one sentence naming the file or scene; `hint` is the single next step,
  as a command where one exists; `kind` is a stable kebab-case id printed as the
  envelope's `code`: `usage`, `env`, `no-app`, `needs-trust`, `invalid`, `leased`,
  `others-changed`, `conflict`, `locked`, `index-locked`, `app-busy`, `bridge-timeout`,
  `gpu-stalled`, `gpu-wedged`, `throttled`, `too-large`, `flashes`, `no-grid` (a musical
  position, `--duration-bars` or `--cut-at` with no `audio.grid`; exit 1). Each kind has a
  default hint (`DEFAULT_HINTS`). Never print a traceback.
- **Writes.** Every write to `project.json`, `scenes/**` or `.kb/**` goes through
  `kblib.lock`. A read-modify-write uses `mutate_json(project, rel, fn)`: `fn` gets a fresh
  copy (None when the file is absent) and returns the new document, or None to leave it. A
  multi-file change uses `transact(project, op, fn)`, which runs `fn(tx)` under the lock
  and re-runs it on a conflict; `with project_txn(project, op, dry_run=..., caller=...) as
  tx:` is its single attempt (a conflict raises `Conflict`, exit 3). `tx.read(rel)` gives
  bytes plus the base hash (`absent` when missing); `tx.write_json`, `tx.write_text`
  (`create_only=` needs the name still free), `tx.copy_in` and `tx.trash` plan. The commit
  takes `.kb/lock` (`flock`, 10 s, `--wait SECONDS`), calls `leases.guard(project, caller,
  rels)`, verifies every base, writes new files first and `project.json` last (trashing
  after), takes back its own new files when a later write loses its race, and calls
  `events.journal(project, "files.changed", caller, rels, via="kb")`; both hooks are
  skipped while those modules do not exist. A hash is the lowercase hex SHA-256 of the
  bytes (the app's rule), re-checked right before each rename. When someone saved in
  between, `fn` is re-applied to the fresh document up to 3 times, then exit 3; a pinned
  `--base`, or a scene addressed by an index that moved, refuses at once (exit 1, kind
  `conflict`). A dry run takes no lock, writes nothing and returns `writes: [{ path, action:
  create | modify | trash, base }]`, where a write a lease would refuse carries `refusal: { code:
  "leased", error, holder, untilMs }` (`leases.check`, which touches nothing). Never hold the lock while waiting on the app or
  ffmpeg; take an edit lock before the project lock. Workspace themes are shared across
  projects: compare-and-swap only.
- **New commands** live in their own module with `register(sub, common, Formatter)`;
  `cli.py` gains one import and one call. Commands never re-implement lease checks;
  the transaction does them.

## Coordination (several agents)

Several Claude agents may edit one project at once. kb makes that safe; the app needs no
part in it. State lives in the project's `.kb/` folder, which ignores itself (`.kb/.gitignore`
holds `*`, and kb adds `.kb/` to `.git/info/exclude`), works without git, and is left out of
packs and duplicates.

```
.kb/lock                        flock for every kb write
.kb/leases/<stem>.json          one file per leased scene
.kb/events.jsonl                newline JSON, rotated at 1 MiB (events.1.jsonl kept)
.kb/notes.md                    shared notes, rotated at 256 KB
.kb/agents/<name>/              identity.json, seen.json, the agent's scratch
.kb/captures/<stamp>[-<agent>]/ capture copies, newest 40 per agent, 1 GB (never under 1 h old)
.kb/song/<sha12>.json           kb song analyse's copy of the app's analysis
.kb/footage/<name>.json         kb video log (sheets in .kb/footage/<name>/, pairs in .kb/footage/pairs/)
.kb/archive/<id>/<rel>          files kb assets replace and unused moved aside; index.jsonl beside them
.kb/thumbs/<time>-<tag>/        contact sheets from kb assets add-folder --thumbs and kb brand icons --sheet; the newest 20 kept
```

- **Identity.** A caller is `{ name, session, agentId }` (`kblib/identity.py`). kb run from
  Bash knows `name` (`--agent`, default `session-<first 8 of CLAUDE_CODE_SESSION_ID>`, or
  `user` outside Claude Code) and `session`. Hooks know `session` and `agentId` (`main` outside a
  subagent) but no name. The Bash pre-hook sees both a `--agent NAME` command and the
  agent id, and writes `.kb/agents/<name>/identity.json` (`{ session, agentId, atMs }`)
  before kb runs; kb then takes the bound agent id for its own caller when the session
  matches (`leases.resolve`), so Edit and Write checks can tell subagents of one session
  apart. The defaults (`session-<id>`, `user`, `claude`) count as no name.
- **Holder rule** (`leases.is_holder`). A caller holds a lease when its session and agent id
  equal the holder's (an unbound holder, agent id null, must also have the caller's name),
  or the binding of the holder's name equals the caller, or the caller has no name, its
  session is the holder's and both the holder's and the caller's agent id are null or `main`
  (a lease the main agent took covers the main agent only, never its subagents).
- **Leases.** Opt-in, one file per scene: `.kb/leases/<stem>.json` holds `{ version: 1, scene,
  files: ["scenes/<stem>.tsx", "scenes/<stem>.json"], holder: { name, session, agentId },
  assignedBy, takenAtMs, renewedAtMs, untilMs, note }`. `./kb lease S --agent A [--ttl 2h]
  [--note T]` takes or renews; `--for NAME` assigns it to NAME (holder session and agent id
  null) without binding anyone, and NAME claims it with its own `./kb lease S --agent NAME`;
  `--release` (the holder or the assigner), and `--release --force` breaks someone else's
  (journalled `lease.broken`). TTL 2 h by default, 12 h at most (a longer `--ttl` is capped
  with a note); the holder's kb writes and Edit or Write calls renew it by its own TTL once
  under half is left. Expired leases are ignored everywhere and pruned when kb next takes a
  lease; `scene remove` releases the removed scene's. Someone else's lease is exit 1, `code:
  "leased"`, with `holder` and `untilMs` in the envelope; a dry run reports it in the write's
  `refusal` (and in `tx.refusals` / `Mutation.refusals`) instead of failing. Edit and Write
  to a scene leased to someone else are denied (`permissionDecision: "deny"`); a Bash
  command that visibly writes one is denied too, and any other Bash change to it is reported
  after the fact (exit 2, `lease.violated`). A scene's `project.json` entry is not leased.
- **Scoped history.** `./kb checkpoint [MSG] --scene S [--files P]` stages `git add -A --
  <paths>` and commits `git commit --only` with `checkpoint(S): MSG [agent]`, so other
  agents' staged and unstaged work stays out (paths are `scenes/S.tsx` and `.json`, kept when
  on disk, in the index or in HEAD; `--files` takes paths under the tracked set). Every kb
  checkpoint holds the project lock. `./kb undo --scene S [REV]` targets HEAD when S's files
  are dirty, else the parent of the last commit that touched them; it makes a scoped
  checkpoint first, checks out only S's files, trashes only S's own files, and splices S's
  own `project.json` entry (everything but `file`) from the target by compare-and-swap. A
  scene that did not exist at the target is refused (exit 1, hint `./kb scene remove S`);
  when S's entry was removed since, or the manifest version changed, it says so and leaves
  `project.json` alone. A plain `undo` refuses (exit 1, `others-changed`, `files: [{ path, by
  }]`) only when the journal's last `files.changed` writer of a file since the target is
  someone else, or another agent leases it; otherwise it behaves as before, and `--all`
  overrides. A dry run lists the same refusals.
- **index.lock.** `git.run` retries a failure naming `index.lock` after 50, 100, 200, 400,
  800 and 1600 ms, then exits 3 (`index-locked`) with a hint naming the lock's age (past
  60 s it may be stale; kb never deletes it). A hook that skips its session checkpoint says
  so in `additionalContext` and journals `checkpoint.skipped`.
- **Events.** `.kb/events.jsonl` holds one compact object per line, under 4 KB (long lists
  keep their first 8 plus `<key>More`): `{ "v": 1, "id": "<atMs>-<pid>-<rand>", "atMs",
  "kind", "by": { name, session, agentId }, ...}`. Appends are one `O_APPEND` `write()` with
  no lock; past 1 MiB kb rotates it to `events.1.jsonl` under the lock. kb journals
  `checkpoint`, `checkpoint.skipped`, `undo`, `lease.taken`, `lease.released`, `lease.broken`,
  `lease.violated`, `note` and `files.changed` (`via: "kb" | "edit" | "bash"`).
  `./kb events [--follow] [--since 10m|CURSOR|all] [--kinds ...] [--all-agents] [--exit-after
  SECONDS]` starts from the caller's saved cursor (`seen.json`), else the last 10 minutes
  (or now, when following); drops the caller's own events and `files.changed` unless asked;
  and, with `--follow`, waits on a kqueue (a 0.5 s poll elsewhere), flushes every line,
  follows rotation by inode, and stops after `--exit-after` (1740 s, under the Monitor's 30
  minutes) with `{ "kind": "follow.end", "cursor": "<inode>:<offset>" }`. The follower also
  synthesises app events from the serving instance's heartbeat once a second (the app never
  writes into a project): `load` (this project's `lastLoad` changed), `export.started`,
  `export.progress` (every 10 %), `export.done` (from `exporting` and `exportJob`),
  `render.stalled` and `render.recovered` (`health.gpu.stalled`), `app.opened` and
  `app.closed`, each `by: { name: "app" }`.
- **Notes.** `./kb note "TEXT" [--scene S]` appends `- YYYY-MM-DD HH:MM · <agent> · <scene>: text`
  (one line) to `.kb/notes.md`, rotated past 256 KB to `notes.1.md`, and journals `note`.
  `./kb notes` lists the newest 30 (`--all`: both files). Each agent's
  `.kb/agents/<name>/seen.json` (`{ notesOffset, notesInode, eventsCursor }`) records what it
  has read: `./kb status` prints the count of unseen notes from other agents and the newest
  three, each capped at 160 characters, then marks them seen, plus the leases line
  (`Leases: 06-feature alpha (yours, 1h52m) · 04-proof beta (40m)`); `--json` adds `leases`
  and `notes`. The session-start context carries the leases line and the newest two notes.
  `.kb/agents/<name>/` is the agent's scratch (created on binding).

## kb video

`kb video` edits the app's own video-editor documents (`edits/<name>.json`) so the user
can open every change in the editor (`kb video open`). The `kookaburra-video-editing`
skill is its playbook. Code: `scripts/kblib/video/`.

- Engine: `editmath`/`editops` mirror `src/engine/editMath.ts`, `editMasks.ts` and
  `editOps.ts` exactly (`js_round` half up, the same check order and error codes);
  `editdoc.mutate` takes a per-edit lock (`kblib.lock.FileLock`), applies ops, validates and
  saves through the CLI's `edit save --base`, rebasing up to three times on a conflict, then
  exit 3; `repoint` mirrors `applyEditRepoint` and the follow-media duration sync on the raw
  sidecar with guarded `mutate_json` writes; `appcli` finds the CLI (`KB_APP_BIN`, the live
  heartbeat's `cliPath`, the installed bundle after its `Info.plist` gate, then
  `_bridge/cli.json` last, so a leftover dev build never shadows the installed app).
- Commands: `list`, `show`, `map`, `usages`, `validate`, `caps`; `new`, `reset`;
  `split`, `cut`, `keep`, `trim`, `speed`, `freeze`, `hold`, `remove`, `move`, `insert`,
  `append`; `tap ...`, `mask ...`; `crop`, `zoom`; `apply PLAN` (all or nothing); `analyse`,
  `cleanup`, `taps suggest`, `fit`, `align`; `log`, `pair`; `frames`, `sheet`; `render`, `use`,
  `durations`, `open`. Bare times are seconds; `--at` is timeline time, `--src` source time.
- Masks, crop and zoom (edit doc v3): `mask add|set ... --fade-in D --fade-out D` (source time,
  `none` a hard edge, fitting the span), and `--until-scene T --scene S [--slot P]` on `mask add`,
  `set` and `span`, which maps scene time back through the slot's `startMs`, `inMs` and `speed`
  (and the edit's clips when the slot plays the render); refused for backgrounds, `startOn` and
  looping slots (exit 2). `crop NAME CLIP --rect x,y,w,h | --aspect 9:16 [--centre x,y] |
  --clear` and `zoom NAME CLIP --at T [--rect] [--ease linear|smooth] | --remove T | --move T
  --to T2 | --clear`. Apply plans take `setClipCrop`, `setZoomKey`, `removeZoomKey`,
  `setZoomKeyEase`, `moveZoomKey` and `setMaskFade`. Gated on `edit caps`: fades need
  `mask.fades`, crop and zoom need `crop`/`zoom` and `docVersion.write` 3; with an older CLI kb
  refuses the flags and ANY write to a doc that already has them (exit 2), since that CLI would
  drop them on save. `fit`, `cleanup` and edit-side `align` keep static crops and one-box zooms
  and refuse a gliding zoom (exit 1).
- Retimed slots: a device screen with source timing keys (`inMs`, `outMs`, `speed`, `loop`,
  `posterMs`) is tagged `retimed` in `usages` (`--json`: `timing`, `retimed`, `startMs`), and
  `map --scene-at` maps through its timing. `fit --scene` and scene-target `align` refuse it
  (exit 1). `render --use` and `use` drop those keys and a negative `startMs` from the
  slot (`repoint.py`, mirrored by `repointVectors.ts`), and the follow-media length of a timed
  screen is `startMs + (min(outMs, length) - inMs) / speed`, one pass of a loop, at least 17 ms.
- Footage log (`log`, `pair`; `kblib/video/footage.py`, `labels.py`): one extra full-rate
  decode (54-wide grey frames plus 6 x 480 row profiles) cached beside the analysis; holds,
  changes, scrolls, money frames and notes aligned to the changes; results in `.kb/footage/`
  through the project lock. An unconformed file ffmpeg misdecodes is refused unless
  `--allow-misdecode` (judged by `kblib.conform.video_verdict`, as `kb assets probe` judges it:
  the container's tables, plus the app's `media probe` when `edit caps` lists `media`). `align --beat` reads the authored grid
  when one exists, else the analysis.
- `render`: lock, validate, refuse (or `--wait`) while the app exports a project that
  uses the output, CLI render with `--expect-hash`, check the frame count, `mediaChanged`
  to a running app, then the optional re-point and the follow-media duration sync.
  `--draft` renders a half-size review copy outside `assets/`.
- Smart passes run the bundled ffmpeg directly: `analyse` (packet gaps on VFR sources,
  then one scaled decode for black, freeze, scene changes and change boxes) caches by
  content hash; `cleanup` applies source-range ops at normal strength by default and
  writes nothing unless kb's plan lands exactly on its simulation; `fit`/`align` land on
  the render's exact frame grid; tap candidates are only listed (`taps suggest`).
- Scratch: `~/Kookaburra Cut/_bridge/video/<slug>/` (`analysis/`, `drafts/`, `frames/`,
  `sheets/`, `locks/`), readable under the managed `Read(~/Kookaburra Cut/_bridge/**)`
  rule; every `kb video` call prunes it (last three drafts per edit, 24 h, 1 GB).
- Conformance: `pnpm agent:vectors` regenerates `edit-vectors.json` (editOps, editMath,
  editMasks) and `repoint-vectors.json` (re-points, follow-media sources) from the real
  TypeScript; `pnpm test:kit` replays them through the Python mirror, and a stale file
  fails vitest. `theme-merge-vectors.json` does the same for theme `extends`
  (`src/theme/extends.ts`, mirrored by `kblib/themes.py` and `src-tauri/src/theme.rs`). The Rust barcode fixtures (`fixtures/video-conformance/`, an `#[ignore]`
  test) pin which source frame the render shows at every output frame.
- Hooks keep Edit and Write out of `edits/` and both managed skill folders; `kb video`
  is the only way an agent changes an edit.

## Film checks and verify-export

`kb verify-export FILE` and `kb check film` judge a finished export, never the editor.
Code: `scripts/kblib/film/` (stdlib Python over the bundled ffmpeg and ffprobe, found as
`kb video` finds them) and the flash detector, `src-tauri/src/flashes.rs`.

`kb verify-export FILE [--no-sheet] [--no-flashes] [--allow-flashes] [--loudness-target LUFS]
[--standard wcag|itu|both] [--json]`:

- **Expectations.** The export record for these exact bytes when `kb export` saved one,
  else static: the aspect from the button's name (`<slug>-<aspect>[-<preset>|-custom][ N].<ext>`),
  the size from the catalogue's `aspects` and the short-edge rule (`out_dims` in `encode.rs`),
  60 fps for High quality (a preset's rate once the catalogue lists `exportPresets`), frames
  = round(total ms x fps / 1000) plus one when the file has exactly one more (a poster
  frame), audio exactly when `project.json` has `audio`.
- **Audio.** `ebur128=peak=true`: integrated loudness more than 1 LU off `--loudness-target` (or
  the record's or the catalogue preset's target) warns, as does a true peak over -1 dBTP.
- **Frames.** Each scene's first, settled-in (after its incoming transition), named
  (`stills.marksMs`, `still: true` camera keys, else the midpoint) and last frame, extracted
  by index into contact sheets sized for Read, with a legend.
- **Colour.** Four 24 px corner patches at a 3% inset on each scene's settled frame
  (`crop,scale=1:1:flags=area` piped as rgb24). Flat backgrounds (a sidecar `color`
  background, or a theme with none, no staged backdrop, no effects) are compared with
  CIEDE2000, warning over 2; elsewhere the colours are only reported. Never fails.
- **Exit.** 1 for any mismatch (kind `failed`), 1 with kind `flashes` on a flash failure
  unless `--allow-flashes`, 2 without the app's ffmpeg or a readable file.

The export record (`_bridge/exports/<slug>/<sha16>.json`, written by `kb export`, matched
by the full hash):

```json
{ "version": 1, "sha256": "<64 hex>", "path": "/Users/x/Kookaburra Cut/<slug>/exports/<slug>-16x9.mp4",
  "project": "ws:<slug>", "aspect": "16:9", "preset": "kookaburra-standard", "lane": "frozen",
  "codec": "libx264", "fps": 60, "width": 3840, "height": 2160, "posterFrame": true,
  "frames": 3901, "totalMs": 65000, "audio": true, "loudnessTarget": null,
  "timeline": [{ "index": 0, "stem": "01-a", "startMs": 0, "endMs": 4000, "durationMs": 4000,
                 "transitionIn": null }],
  "flashes": null, "exportedAtMs": 1792020000000, "appVersion": "0.19.0" }
```

`frames` includes the poster frame; `lane` is `frozen` or `spec`; `timeline` is the
export's own `buildSceneTimeline` (`transitionIn` as `{ type, durationMs, ... }` or null);
`flashes` is the export tap's report when it ran.

`kb check film [flashes colour handoffs pacing] [--file F] [--standard wcag|itu|both]
[--allow-flashes] [--no-sheet] [--json]` (all four by default; `flashes` and `handoffs` need
`--file`, and a named one without it is exit 2):

- `flashes`: the flash report below, exit 1 kind `flashes` on a failure unless allowed.
- `colour`: the tone-mapping warning (effects with tone mapping other than neutral or
  linear shift flat colours), plus the swatches with `--file`.
- `handoffs`: per seam, the outgoing scene's last solo frame and the incoming one's first
  (a cut's two sides, or either side of a transition, labelled with its type), the seam
  diff and the luminance step; a hard cut of ΔL 0.10 or more next to a scene under 1 s
  warns, and four such cuts inside a second warn as a strobe.
- `pacing` (static): words per scene from `text` and `managedText` against 3 a second, the
  longest stretch with no camera, rig, device, chart or lighting key (warning over 6 s),
  scenes under 334 ms.
- `safe-areas` is not in this version (it needs the app's text measurement).

Flash detection is one Rust core fed frame by frame: `FlashDetector::new(width, height,
fps, standards)`, `push_rgba(&[u8], bottom_up)` (or `push_rgb`), `finish() -> FlashReport`.
It never panics (a short buffer is counted and skipped) and costs about 4.4 ms per 4K RGBA
frame with both standards (5.3 ms at worst on a camera fly-through). Two feeders: `<exe> check flashes`, and a read-only tap in every
export's `push_frame` (after the bytes reach ffmpeg; a failure makes the report "flash check
unavailable", never a failed export). `finish_export` keeps the tap's verdict for
`export_flash_report`, and writes `<export file>.flashes.json` beside a film with flagged
moments (a clean re-export removes it); the Export button then shows a persistent warning
with the timecodes, and `kb export` gets the report in its answer.

- **Cells.** 64 along the long edge, the short edge in proportion; pixels sampled at a
  stride of about 16 per cell edge, linearised (sRGB for WCAG, 2.4 power for ITU, whose
  20 and 160 cd/m² of a 200 cd/m² display are the same 0.10 and 0.80), averaged per cell;
  relative luminance 0.2126R + 0.7152G + 0.0722B.
- **Regions.** Flashes are counted per region, never across the frame: every position of
  the WCAG window (21 x 16 cells, 341 x 256 px at 1024 x 768, upright in portrait), and for
  ITU the whole frame plus three-quarter windows and full-width and full-height halves (a
  quarter of the screen flashing anywhere fits inside one).
- **Transitions.** A region's mean signal (relative luminance, or (R - G - B) for red) is
  tracked as swings with a small hysteresis. A swing is a transition when enough of the
  region's cells changed by the threshold in its direction between its two ends: ΔL 0.10
  or more with the darker side below 0.80; for red, a saturated red end (R / (R + G + B)
  of 0.8 or more, linear), Δu'v' over 0.2 and, as an implementation choice that keeps
  near-black noise out, WCAG 2.0's (R - G - B) x 320 changing by more than 20. "Enough"
  is 25% (15% warns) of the window for WCAG and of the whole frame for ITU, and the mean
  must move as far as that share would move it.
- **Motion.** A moving object's leading edge darkens cells while its trailing edge lightens
  others, so a region's mean holds still and textures inside it cancel; an object entering
  and leaving a region is one flash per pass. A camera fly-through past dark tiles passes;
  a dark block crossing the same place four times a second over a quarter of the window
  fails. A pattern reversing in place (a checkerboard swapping) also cancels: patterns
  come later.
- **Verdict.** More than six opposing transitions of one region in any 1 s (more than
  three flashes) fails; five or six, or more than six at 15 to 25%, warns. A compact flash
  over 12.5% of the frame fails WCAG but passes ITU.

```json
{ "version": 1, "approximate": true, "standards": ["wcag-2.3.1", "itu-bt1702"], "source": "file",
  "fps": 60, "frames": 3901, "grid": [64, 36], "ok": false,
  "issues": [{ "type": "general", "standard": "wcag", "severity": "fail", "startMs": 41250,
               "endMs": 42250, "tc": "00:41.250", "scene": { "index": 7, "stem": "07-a", "localMs": 1250 },
               "flashesPerSecond": 4.5, "areaPct": 38.2, "region": [0.1, 0.2, 0.33, 0.33], "deltaL": 0.62,
               "hint": "hold each state at least 334 ms, or keep the change under 10% luminance" }],
  "gate": "app", "precheck": { "maxBadness": 9.56, "threshold": 6.4, "frames": 3901,
                               "candidates": [{ "startMs": 41000, "endMs": 42000, "badness": 9.56 }] } }
```

Times are file times; kb adds `scene` (after any poster frame), `gate` and `precheck`. kb
runs `check flashes` only when `edit caps` lists `checks: ["flashes"]` (an older binary
given `check` would start the whole app); otherwise the report is ffmpeg's pre-check alone,
`gate: "unavailable"`, and nothing fails. The pre-check is `photosensitivity=frames=<fps>:
bypass=1` read through `metadata=mode=print`; seconds with badness 6.4 or more are "look
here" (measured on full-frame strobes with a one-second window: 5.5 at three flashes a
second, 6.75 at 3.75, 8.7 at five). It works on a global grid and flags single cuts, so it
never gates.

- Outputs land in `_bridge/film/<slug>/<stamp>-<pid>-<kind>/` (frames and sheets); the
  newest 12 runs stay.
- Conformance: `pnpm agent:vectors` also writes `timeline-vectors.json` from the real
  `buildSceneTimeline`, `resolveOverlapMs`, `resolveAt` and `outgoingSceneTransitions`; a
  stale file fails vitest and `pnpm test:kit` replays it through `film/timeline.py`.
- Tests: `cargo test -- --ignored check_flashes_` runs the CLI through the real sidecar;
  `KB_E2E_APP_BIN=<binary> pnpm test:kit` runs kb against the real detector.
- `fixtures/flash-spike` (dev-only: a title, a crossfade, one second of 100 ms full-frame
  cuts, a 2 Hz control) is the parity and flash fixture, copied into a throwaway root;
  it joins no gate.

### kb sync-check

`kb sync-check FILE [--bpm N [--offset MS]] [--poster-frame auto|on|off] [--threshold PCT]
[--window MS] [--json]` (`kblib/film/sync.py`) times each cut and big picture change
against its nearest beat, in ms (positive is late). Exit 0 whatever it finds.

- **Clock.** Decoded presentation times (ffmpeg honours MP4 edit lists, so x264's B-frame
  delay and AAC priming cancel) from the audio stream's start, minus a leading poster frame
  (the record's `posterFrame`, else a frame count one over the project's at the file's rate).
- **Events.** Each 54 px grey frame's mean absolute change from the one before: 8% or more
  and twice the change before it, one per 120 ms. A timeline cut (the record's, else the
  project's) within two frames labels it a cut; a quieter cut is the biggest change there.
- **Beats.** The authored grid, else the analysed beats, else `--bpm` (none: exit 1, kind
  `invalid`). Events within a quarter beat give the median, worst, per-scene rows and the
  verdict: `in sync` inside the frame grid's 0 to 1000/fps ms (2 ms slack, 25 ms for
  analysed beats), else `late` or `early` with a warning.
- **Proof.** `cargo test --lib av_sync -- --nocapture` (`src-tauri/src/encode/av_sync_tests.rs`)
  pipes flashes and a click track through every lane's real argv and sidecar (legacy,
  spec with and without the poster, two-pass, x265, ProRes, VideoToolbox): each flash
  lands where `ceil(B x fps)` puts it, 0 to 33.3 ms late at 30 fps and 0 to 16.7 at 60. A
  reader that skips edit lists sees +45.3 ms more on 30 fps x264 (+12 at 60), and timing
  against the grid without taking off the poster frame adds one frame; neither is in the file.

## kb export

`./kb export` makes the finished film exactly as the app's Export button does, so Claude can
finish and check its own work. Code: `scripts/kblib/exporting.py`, `src-tauri/src/bridge_export.rs`,
`src/ui/useBridgeExport.ts`, `src/engine/bridgeExport.ts`.

`kb export [--aspect A] [--preset ID] [--fps 30|60] [--short-edge N] [--poster-frame on|off|app]
[--verify] [--headless] [--allow-flashes] [--timeout 3600] [--progress-every 10] [--json]`

- **Only the open project.** The editor must show this project; on the Welcome screen or another
  project the app answers `notOpen` or `wrongProject` (exit 2, kinds `not-open`, `wrong-project`).
  While the person is mid-edit (a pointer down, or a focused text field outside the embedded
  terminal that they typed in or changed in the last 10 s; a field left focused while idle does
  not count), the Export window is open, or an export, Verify, stills export or theme preview
  runs, it answers busy; kb retries for 30 s (never past `--timeout`), then exits 3 (`app-busy`).
- **Sync first.** Once accepted the editor stops playback, settles its own sidecar writes, and
  waits up to 20 s until the reload poll's baseline matches the disk and the reload it asked for
  is on stage. A failed last reload refuses (`stale` with `reloadFailed`, exit 1); so does a source
  whose hash no longer matches kb's `sources` (exit 3, rerun).
- **Edit safety.** kb first notes what the film renders from (project.json, the scene files and
  the music, as the editor loads them now) and that editing is safe: the export renders the loaded
  project, the reload poll pauses, and ffmpeg reads a copy of the music taken at the start
  (`snapshot_audio`), so edits saved meanwhile land in the next export. Once the film is done kb
  hashes the sources and the music again; any that changed come back as `staleSources` plus a
  warning to rerun.
- **A reloaded editor.** When the heartbeat's `health.editor.restartRecommended` is set, kb warns
  before it starts that a long export may fail until the app restarts.
- **The button's run.** The request maps through `choiceForRequest` (no flags = High quality, a
  preset row, or `--fps`/`--short-edge` as the Custom panel seeds them), `resolveVideoSelection`
  (loudness measured as the modal measures it, the poster frame from the app's setting unless
  `--poster-frame`), then App's `runVideoExport(sel)`, the function the Export button calls
  (`commitFormat`, `buildVideoExportOptions`, `exportProject`). Only the destination (always the
  project's `exports/`, canonical names), the abort signal and the callbacks differ, and none of
  them reach the bytes. The aspect defaults to the editor's, kept when the preset allows it, and
  the person's aspect comes back afterwards.
- **Verify.** `--verify` runs `verifyDeterminism` on the same options (two renders, same path) and
  refuses VideoToolbox lanes (exit 2). With `--poster-frame off` and no preset it is one 16:9 leg
  of the app's Verify x2 on the frozen libx264 path.
- **While it runs** an overlay over the stage reads "Claude is exporting, 42%" with the stage,
  frame, rate and ETA and the person's own Cancel; the titlebar's Cancel works too. Exit 1
  (`cancelled`) when the person cancels.
- **Progress.** One stdout line per stage change, else at most one per `--progress-every`
  seconds (`kb export: render 1234/3901 32% 4.1 fps eta 10m45s`), ending `kb export: done
  exports/<name>.mp4 sha256 1a2b3c4d... 3901 frames 65.02 s`. `--json` prints one compact object per
  line (`{ "event": "progress", ... }`, `{ "event": "note", ... }`) and the envelope last.
- **Cancel.** Ctrl-C, SIGTERM or `--timeout` sends `cancelExport`, waits up to 15 s for the
  export's answer, then exits 130 (interrupted) or 1 (`timeout`). If kb itself dies, the app
  cancels the export when `clientPid` exits.
- **Flash gate.** The answer carries the export tap's flash report. A failure exits 1 (`flashes`;
  the file and its record are kept) unless `--allow-flashes`; warnings print and exit 0. A
  flagged film also raises the Export button's persistent flash warning in the app, titled
  "Claude's export ..." so the person knows who ran it.
- **The record.** Every finished export saves `_bridge/exports/<slug>/<sha16>.json` (schema under
  "Film checks and verify-export"; the newest 50 per project stay), so `kb verify-export` checks
  the file against what was asked for.
- Other answers: `invalid` (bad aspect, preset or rate; exit 2), `refused` (error-card scenes or a
  dropped LUT; exit 1), `gpuStalled` (exit 3), `gpuWedged` (exit 2, quit and reopen),
  `verifyMismatch` (exit 1), `acceptTimeout` (exit 3) and `interrupted` (exit 2, `app-reloaded`:
  the editor's page died under the export, so rerunning without a restart fails again; the error
  names the frame, scene and render-rate trend, see "Export health"). The envelope's `code` is the
  kb kind; `appCode` keeps the app's.

### `--headless`

With the app closed, a packaged release bundle renders the film in the background:

1. Refused when any live instance serves this workspace (drop `--headless`) or a packaged app runs
   at all (its caches are shared), and for `--fps`/`--short-edge` (the Custom panel needs the editor).
2. The binary (found as `kb video` finds it) must answer `edit caps` with `build: "release"` and
   `autorun: { actions: ["export", "verify"], trust: ["stored-only"], poster: true, progress:
   true }`; an older one would auto-trust and ignore the new variables, so it is refused (exit 2).
3. A FIFO ticket in `~/Kookaburra Cut/_autorun/queue/`, exactly as `scripts/kookaburra-run.sh`
   takes one (`<12-digit epoch>-<pid>.json`, sorted names are the order, dead pids swept, another
   run never touched), then a run dir `_autorun/runs/kb-<utc>-<pid>/`.
4. `/usr/bin/caffeinate -dimsu <exe>` in its own process group (never `open`, which drops the
   environment) with `KOOKABURRA_ACTION=export|verify`, `KOOKABURRA_PROJECT=ws:<slug>`,
   `KOOKABURRA_ASPECT` (the project's first format, kept when the preset allows it),
   `KOOKABURRA_PRESET`, `KOOKABURRA_CODEC=libx264`, `KOOKABURRA_RESULT_DIR`,
   `KOOKABURRA_WORKSPACE_ROOT=<project parent>`, `KOOKABURRA_TRUST=stored-only`,
   `KOOKABURRA_POSTER=on|off|app` and `KOOKABURRA_PROGRESS=1`.
5. kb polls `progress.json` (written through `autorun_progress`), `last-run.json` and the pid. A
   cancel sends SIGTERM then SIGKILL to the group, removes stray `exports/.*.part.*` files and the
   ticket. kb hashes the file itself.
6. Stored-only trust never auto-trusts (kb is auto-allowed, so it must not launder consent): a
   project whose sources changed since the user allowed it answers `needsTrust`, exit 2 "open the
   project once in Kookaburra Cut".

Headless and editor exports of one project may differ at glyph edges (a cold boot against a warm
editor); never record baselines from `kb export`.

## The bridge (v2)

File-drop queue under the FIXED `~/Kookaburra Cut/_bridge/` (never a relocated root;
`KOOKABURRA_BRIDGE_DIR`, an absolute path, redirects it for tests only, and kb reads
`KB_BRIDGE_DIR`, then `KOOKABURRA_BRIDGE_DIR`).

### Instances and addressing

Several app instances can run on one machine (the packaged app, a dev build, acceptance
bundles, autoruns). Each decides once at start whether it serves the bridge, in order:

1. An autorun never serves.
2. `KOOKABURRA_BRIDGE=0` turns serving off; `KOOKABURRA_BRIDGE=1` turns it on (any other
   value is ignored with a warning).
3. An overridden workspace root (`KOOKABURRA_WORKSPACE_ROOT`), a non-production bundle id
   (production is `com.mpalmes.kookaburracut`), or a debug build from a linked git worktree
   (its checkout's `.git` is a file) does not serve.
4. Everything else serves: the packaged app and a dev build from the main checkout.

The role is decided once in `bridge::init` (pure `bridge_role`) and reported as
`bridge: { serving, reason }`; `reason` names why a passive instance does not serve, and an
opted-in one says so. Code: `src-tauri/src/bridge.rs`; `bridge_instance` returns the
identity, role, effective root and `rootSource` (the app's "not found" errors name it).

- **Heartbeats are per process:** `_bridge/apps/<pid>.json` (the `app.json` body below plus
  `startedAtMs`, `bundleId`, `exePath`, `checkout`, `rootSource`, `bridge: { serving,
  reason }`, `primary`, `exportJob`, `health`), written by every interactive instance,
  serving or not, removed on exit, and pruned by serving instances when its pid is dead or
  it is 10 min old. A passive instance writes only that file: never `app.json` or
  `cli.json`, and it never claims, prunes or runs the native loop.
- **`app.json`** stays for older kits and resource lookups, with the same body, written
  only by the primary: a serving instance takes it over when it is missing, unreadable,
  older than 30 s, from a dead or passive process, or from a writer that ranks below it
  (release over dev, then the earliest start, then the lowest pid; an older app without
  `startedAtMs` keeps it, so the two never fight).
- **Election.** Among live serving instances on the project's workspace root, kb picks the
  one with the project open, then a release build over a dev build, then the earliest
  start, then the lowest pid, and addresses it by pid. Not an error; `kb status` warns
  when two instances share a root and lists every live instance with the reason a passive
  one does not serve. kb reads live `apps/*.json` files, plus a live `app.json` whose pid
  has none (an older app: it serves everything it sees, so kb sends it no `instancePid`
  and only uses it when its `workspaceRoot` is the project's).
- **Requests** carry `workspaceRoot`, `projectPath`, `instancePid` and `client` (the
  agent name). An instance claims only a request addressed to its pid; else one whose
  `workspaceRoot` is its own root (compared by device and inode; a root that does not
  exist matches no instance); else (old kits) one whose `projectPath` or `<root>/<slug>`
  matches, the rule the native loop already used. One predicate (`claimable`) serves the
  render-window claim, the native loop and the pending count the editor uses to spawn the
  render window, so no instance keeps a window alive for another's requests. Stale
  requests (past `deadlineAtMs`, at most 1 h after sending; 120 s without one) are
  deleted by any serving instance whoever they were for, and an instance that does not
  serve never touches `requests/`.
- **Responses** carry `servedBy: { pid, bundleId, build, appVersion, workspaceRoot }`
  (stamped by Rust on render-window answers, native answers and parse errors; a body that
  already has one keeps it). kb discards an answer whose root is not the project's
  (exit 2, `no-app`), fails fast (exit 2, `no-app`) when no live instance serves the
  project's root, naming the live ones, their roots and why each does not serve, and
  fails fast when the addressed pid exits while it waits.
- **Health.** The serving instance's heartbeat carries `health`: queue depth and order,
  the in-flight request, render-window liveness and beat age, recycles, the GPU state
  (`stalled`, `stalledUntilMs`, `wedged`), live WebGL contexts per window, per-client
  usage, and the editor's reloads and memory (`editor`, see "Export health"). kb prints the
  queue position and an estimate while it waits (shape and rules in "The capture service").

### Heartbeat: `_bridge/apps/<pid>.json` and `app.json`

Written atomically by every interactive instance at most every 2 s while it runs (any
view), from the editor's tick and from a native thread every 5 s (the webview's timers are
throttled while the app is hidden), removed on exit; autorun instances never write either.
`app.json` is a copy of the primary's file.

```json
{
  "version": 3,
  "pid": 87186,
  "startedAtMs": 1792019000000,
  "updatedAtMs": 1792020000000,
  "appVersion": "0.19.0",
  "build": "release",
  "bundleId": "com.mpalmes.kookaburracut",
  "exePath": "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
  "checkout": null,
  "workspaceRoot": "/Users/x/Kookaburra Cut",
  "rootSource": "settings",
  "bridge": { "serving": true, "reason": null },
  "primary": true,
  "resourcesDir": "/Applications/Kookaburra Cut.app/Contents/Resources",
  "openProject": "ws:product-tour",
  "aspect": "16:9",
  "playheadMs": 61000,
  "exporting": false,
  "playing": false,
  "kinds": ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"],
  "cliPath": "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
  "cliVersion": 1,
  "lastLoad": {
    "project": "ws:product-tour",
    "ok": true,
    "atMs": 1792019990000,
    "error": null,
    "sceneErrors": [{ "index": 12, "file": "scenes/224-x.tsx", "phase": "compile", "message": "line 4: ..." }],
    "fontIssues": [{ "ref": "Menlo@400", "message": "unknown cmap table format 6", "fallback": "Inter@400" }],
    "warnings": [],
    "availableDevices": ["iphone-17-pro", "android"]
  },
  "exportJob": null,
  "health": null,
  "pickedDirs": ["/Users/x/Desktop/review"]
}
```

`pickedDirs` lists the folders the app's own dialogs returned this session ("kb reach").
Two more fields locate the presets: `presetsDir` (holds `<slug>/`) and
`presetPreviewsDir` (holds `<slug>.jpg`); in dev the posters live under `src/assets`.
`playheadMs` is an integer and `openProject` is null on the Welcome screen. The editor
reports `lastLoad` after every load attempt (`set_last_load`); `warnings` includes
healed scene ids and dropped LUTs. `availableDevices` names the device models this build
renders with their own glb; `./kb check` warns on a scene using any other, since it renders
as the Android fallback. `rootSource` is `settings`, `env`
(`KOOKABURRA_WORKSPACE_ROOT`) or `none`; `checkout` is `{ path, worktree }` for a debug
build, else null. `health` (serving instances only, `src-tauri/src/bridge_health.rs`, shape
in "The capture service") is null on a passive instance; `exportJob` is null until the
bridge export fills it.

`kb` treats an instance as running when `updatedAtMs` is under 30 s old and the pid is
alive. It never uses `pgrep` (it matches unrelated processes and misses others). Its
`live_heartbeat()` is the elected instance's body, so the video CLI lookup, presets and
`kb status` all follow the instance that serves the project.

`cliPath` is the app's own executable (the headless edit CLI, below) and `cliVersion`
its CLI version. Serving instances also write `_bridge/cli.json`
(`{ path, appVersion, build, cli, writtenAtMs }`) once at setup and never delete it, so
`kb` can still find a dev build's CLI while the app is closed (it only uses it when no
installed app qualifies).

### Requests and responses

`requests/<id>.json` (written via a dot-prefixed temp file, then renamed); the answer
lands in `responses/<id>.json`. A request without `kind` is a v1 capture.

```json
{ "version": 2, "id": "0001792020000000-123-abc", "kind": "capture",
  "project": "ws:<slug>", "requestedAtMs": 1792020000000,
  "workspaceRoot": "/Users/x/Kookaburra Cut", "projectPath": "/Users/x/Kookaburra Cut/<slug>",
  "instancePid": 87186, "client": "session-1a2b3c4d",
  "deadlineAtMs": 1792020120000, "retryOf": null,
  "scene": "03-feature-checks", "at": 1.5, "aspect": "9:16",
  "frames": [{ "scene": "3", "at": 2.0 }], "sheet": true,
  "width": 1280, "scale": null, "probe": [[100, 200], [640, 360]],
  "op": "lose-context", "window": "render",
  "render": false,
  "refs": ["Menlo@400"], "listFamilies": false,
  "preset": "title", "position": 4, "name": "Highlights" }
```

`requestedAtMs` is optional (the file's age stands in), `scene` is an index or a file
stem, and an unparseable request gets an immediate error response from a serving
instance. A request without `kind` and with `version` below 2 is answered as
`version: 1`, so old kits keep working. The address fields are optional (old kits send
none); kb adds `workspaceRoot` to every request, `projectPath` when the request is about
its own project, `instancePid` unless the elected app is an older one, and `client` (the
caller's name) and `deadlineAtMs` (when it stops waiting) always. Unknown fields are
ignored.

Every response carries `{ "version": 2, "id", "ok", "error"?, "busy"?, "needsTrust"?,
"servedBy" }` plus its kind's payload. `busy` applies to every kind except `fonts` while
exporting. kb retries a busy answer until its timeout, then exits 3 (`app-busy`); an
unclaimed or unanswered request exits 3 (`bridge-timeout`); `needsTrust` exits 2
(`needs-trust`). The capture service's answers (`gpuStalled`, `throttled`, `tooLarge`,
`cancelled`, `transient`) are in "The capture service". `kb capture` and `kb check` print
`served by Kookaburra Cut ... (build, pid, bundle id)` on stderr.

- `capture`: `path` (first frame), `paths`, `frames: [{ scene, at, tMs, path, index,
  probes? }]` (`scene` is the resolved stem, `at` seconds into it), a top-level `tMs`,
  `sheetPath` when asked, `project`, `format` (the aspect's name), `size` and `nativeSize`
  (`{ width, height }`), `timing: { queuedMs, renderMs, perFrameMs }`,
  `surface: "render-window"`. Files are `<id>.png`, `<id>-N.png` and `<id>-sheet.png`; at
  most 48 frames. `aspect` overrides the editor's aspect for this request only; an
  unknown aspect, a `scale` outside (0, 1] or a `width` that is not a whole number of
  pixels is an error.
- `check`: `project`, `scenes: [{ index, file, id, ok, phase?, error?, warnings }]`,
  `fonts: [{ ref, ok, error?, fallback? }]` (passing refs included),
  `assets: [{ path, ok, error? }]`, `warnings`, `rendered`. Built from a real load in
  the render window. `ok` is false when any scene, font or asset fails; `error` is set
  only when the load itself failed (the arrays are then empty). `scenes[].warnings`
  lists that scene's missing asset paths (workspace projects only). `render: true`
  also renders each scene's midpoint at 640 px wide and reports errors the asset
  boundary caught.
- `fonts`: served by `src/render/bridgeFonts.ts`: `results: [{ ref, ok, error?,
  fallback? }]` from `validateFontRefs` (which pins system faces into the workspace
  fonts folder), and `families: [{ family, weights, bundled }]` when `listFamilies`.
- `insertPreset`: `file`, `index`, `id`, `name`, `project`, `preset`. Uses the app's
  own preset copy (assets copied and renamed on collision, stem and ids minted, sidecar
  ids re-minted). `position` is a 0-based manifest index (absent appends); `name` also
  drives the minted stem and scene id.

Native kinds. `mediaChanged`, `openEdit`, `export` and `cancelExport` are claimed by a Rust loop
(`spawn_native_bridge`, 300 ms poll, serving instances only) rather than the render
window, which never claims them and never spawns for them. Both take
`project: "ws:<slug>"` and the optional `projectPath`. The loop claims through the same
`claimable` rule (the elected pid, else the same workspace root; for an old kit,
`projectPath` must be the same folder as `<root>/<slug>`, else the slug folder must
exist), so with two apps open the right one answers. kb refuses before sending when no
live instance serves the project's root; an old kit's request that no instance can serve
waits until it times out.

- `mediaChanged` (`paths: ["assets/x-edited.mp4"]`, optional `edit`): validates every
  path (outside `assets/` or `..` fails the request; missing files are listed), warms
  the media cache and emits `kookaburra://media-changed { slug, paths, edit, origin:
  "agent" }`. Response `{ project, paths, warmed, missing, deferred }`; never busy, and
  while exporting it skips the warm-up and answers `deferred: true`. The main window
  refreshes the project's assets and stale clip frames but runs no follow-media sync
  and no re-point for agent broadcasts (`kb` owns both); the render window marks itself
  dirty and invalidates before its next claim, so a capture after an in-place re-render
  shows the new frames.
- `openEdit` (`name`, optional `scene` index or stem): opens the video editor on that
  edit for any workspace project. Response `{ project, name, opened: "created" |
  "retargeted" | "focused", projectOpen }`; `focused` only raises the window (the
  editor keeps its state). Busy while exporting or while the editor renders another
  edit; an unresolvable `scene` or an unreadable doc is an error.
- `export` (`kb export`; the shared request type ignores its own fields, so Rust reads them
  back from the claimed file): `aspect`, `preset`, `fps`, `shortEdge`, `posterFrame` (null =
  the app's setting), `verify`, `clientPid`, `detach`, `sources` (`{ "project.json": "<sha256>",
  "scenes/<file>": ... }`). Rust validates the syntax, answers busy while an export runs or the
  slot is taken, refuses unless the editor context shows this project, emits
  `kookaburra://bridge-export` to `main` only and waits 10 s for `bridge_export_accept` (else
  `acceptTimeout`, exit 3), then for `bridge_export_finish`. The editor reports through
  `bridge_export_progress`; Rust writes `responses/<id>.progress.json` atomically, at most once
  a second plus each stage change:
  `{ version: 2, id, project, stage: waiting | syncing | preparing | render | pass1 | pass2 |
  finalising | hashing, run, runs, prepareStep, prepareSteps, prepareLabel, frame, total,
  percent, renderFps, elapsedMs, etaMs, updatedAtMs }` (rate and ETA come from the export's
  callbacks in the UI, never the render). The answer joins the editor's facts to Rust's own,
  which win: `{ ok, surface: "editor", project, aspect, preset, lane: frozen | spec, codec, fps,
  width, height, posterFrame, frames, durationMs, totalMs, timeline, verify: { identical, hashA,
  hashB } | null, path, bytes, sha256, flashes, warnings, elapsedMs }`, where `path` is the file
  `finish_export` recorded and `sha256` Rust's hash of it. Failures are `{ ok: false, code,
  error, hint?, busy?, retryAfterMs?, cancelled?, by?, reloadFailed? }`. The client's death
  (`clientPid`, unless `detach`) cancels the export. A main-window page load after the first
  (`export_health::on_main_page_load`, from Tauri's `on_page_load`) fails the export in the slot
  (`interrupted`, with `restartRecommended`) and stops its encode; `bridge_export_reset`, which the
  main window calls on mount, stays as the backstop.
- `cancelExport` (`target`: the export's id, absent = the running one): `{ ok, cancelled, state:
  idle | cancelled | cancelling, target? }`. An export the editor has not taken yet is answered
  `cancelled` at once; a running one is told through `kookaburra://bridge-export-cancel` (the
  editor aborts), `ExportState::cancel()` stops the encode 15 s later if it is still running,
  and Rust answers `cancelled` for it 15 s after that.
- The heartbeat's `exportJob` is `{ id, origin: "bridge" | "button", stage, frame, total }`
  while an export runs (`id` is null for the app's own buttons), else null.
- `debug` routes by `op`: `contexts` and a `lose-context` with `window: "editor"` are
  served here, from the reported censuses and an event to the main window;
  `lose-context` on the render window (the default) and the dev-only `spawn-contexts`
  (`n`, at most 32) go to the render window. Details in "The capture service".

### Export health

Code: `src-tauri/src/export_health.rs`. A video export that dies with its page (WebKit replacing
the editor's WebContent process, usually for memory) used to leave nothing behind and kept the
native export busy until a restart. Now:

- **Reloads stop the export.** Every main-window page load after the first cancels the native
  video or stills export, fails the bridge slot and counts a reload. One whose old WebContent pid
  is dead counts as `killed`. The new page shows the person a one-off notice
  (`take_export_interruption`: `{ percent, cause: memory | crash | reload }`).
- **The trace.** `start_export` takes the scene spans (`scenes: [{ id, startMs, endMs }]`) and
  begins a trace: one rate point a second from `push_frame`, and the sampler's memory readings.
  A failure's message names where it stopped: `frame 1235/2900 (42%), scene fold-open, render
  8.4 → 2.6 → 1.2 fps` (the rate over the first, middle and last 10 s). The exporter passes a
  real error to `cancel_export` as `reason` and appends the returned summary to the error; a
  plain cancel passes none and leaves no report.
- **`<export>.health.json`.** Written for every failure (editor reload, loop error, encode
  failure) beside where the film would land in the project's `exports/` (never Downloads):
  `{ version: 1, ok: false, reason: editorReloaded | failed | encodeFailed, error, output, fps,
  frame, framesWritten, total, posterFrame, scenes, renderFps, elapsedMs, rate: [[frames, ms]],
  peakMb: { editor, render, gpu, app }, memory: [...], hint, writtenAtMs }`. A later success at
  the same name removes it.
- **Memory.** A native sampler reads every 2 s the physical footprint (`proc_pid_rusage`, the
  figure WebKit's ~4 GB WebContent limit uses) of the editor's and render window's WebContent
  processes, WebKit's GPU process (`_gpuProcessIdentifier`), the app and the export's ffmpeg.
- **`health.editor`** in the heartbeat: `{ reloads, lastReload: { atMs, killed, editorMb, export }
  | null, restartRecommended, memoryMb: { editor, editorPeak, render, gpu, app }, sampledAtMs }`.
  `kb status` prints `Memory: editor page 1.8 GB (peak 2.4 GB), WebKit GPU 950 MB, ...` and,
  once a reload lost its page process or an export (`restartRecommended`), `EDITOR RELOADED n
  times ... ask the user to quit and reopen Kookaburra Cut before exporting`: such an editor slows
  down and fails long exports, and only a restart has been seen to fix it. A benign reload (a
  dev server's, or Reload preview) only notes the count.

### The capture service

The render window's queue, sizing, stall recovery and retention. Code:
`src-tauri/src/capture_service.rs` (pure parts tested there), `render_win.rs`,
`src/render/bridgeService.ts`, `bridgeRequests.ts`, `src/engine/glContexts.ts`; kb's side
is `kblib/queue.py` and `kblib/capture.py`. Bridge captures are never baselines.

- **Sizing.** One frame renders at the aspect's native size; several frames or a sheet at
  a 1280 px long edge. `width` (literal pixels) or `scale` (in (0, 1]) overrides; never
  upscaled, even dimensions, at least 64 on the short edge, the aspect's name kept. A
  probe without a size renders native. The store keeps the native format, so layout and
  safe areas are the export's; effects defined in pixels (bloom spread, blurs, hairlines)
  rasterise at the capture size. Thumbs use the same rule at 640 wide.
- **Probes.** `probe: [[x, y], ...]`, at most 64 points in the returned image (origin top
  left; out of bounds is an error), sampled from the readback before the PNG is saved:
  `{ x, y, rgba: [r, g, b, a], hex }` per point per frame. Exact against the PNG and what
  the exporter hands ffmpeg at the same time and size (sRGB, after tone mapping); not
  exact against a decoded MP4 or across sizes near edges.
- **Cost.** A capture costs frames x ceil(width x height / 921 600) units (a 4K frame is
  9, 1280x720 is 1); other kinds cost 1. A capture over 144 units is answered
  `{ ok: false, tooLarge: true, units, maxUnits, hint }` (kb exit 1, `too-large`).
- **Fair queue.** Among this instance's claimable render requests the window serves the
  client with the fewest units in the last minute first, then its oldest (`retryOf` keeps
  the original's place), ties by the oldest id. A client's fifth waiting capture or check,
  or one that would take it past 240 units in a minute (counting what it already queued),
  is answered at once `{ ok: false, throttled: true, retryAfterMs }`; kb waits that long
  within its deadline and resends, else exits 3 (`throttled`).
- **Deadlines and cancellation.** Freshness is `deadlineAtMs` capped at 1 h after
  sending, else the 120 s rule; with the `deadline` feature kb's claim window is its whole
  timeout (110 s for an older app). Before each frame the window calls
  `bridge_request_live(id, frame)`: when `.claimed/<id>.json` is gone (kb timed out) or
  the deadline passed it stops with `{ cancelled: true }`, and with `{ busy: true }` when
  an export started.
- **Stalls.** A `GpuStallError` (`readback.ts`: `contextLost` or `blankReadback`, the same
  message as before), "Export bridge not mounted" or a stage canvas that failed to start is
  a stall on every path: a capture or check answers `{ ok: false, gpuStalled: true,
  reason }` once (a render check stops at the first), and thumbs and posters report it
  (posters go back in their queue). Rust fills in `recycled`, `retryAfterMs`, `wedged`
  and `hint`, then destroys the window 200 ms later (`destroy`, so a hung page goes too)
  and answers any request still in flight. An unexpected WebGL loss the window sees
  outside a request (`render_report_gpu_event`) recycles it as well; each window's stall
  counts once. Backoff by recycles in the last 10 min: the 1st waits 0 s, the 2nd 15 s,
  the 3rd 60 s, and no window is created meanwhile (requests stay queued). A stall after
  three is **wedged**: no window, and the native loop answers this instance's render
  requests at once with `{ gpuStalled: true, wedged: true }` until 10 quiet minutes pass
  or the editor's Retry captures calls `capture_service_reset`. A debug lose-context
  recycles without counting. kb prints `kb: GPU stalled, render window recycled; retrying
  once`, waits `max(retryAfterMs, 2 s)` and resends with `retryOf`; a second stall exits 3
  (`gpu-stalled`), wedged exits 2 (`gpu-wedged`).
- **Watchdog.** A request in flight with no render beat for 45 s is answered
  `{ gpuStalled: true, reason: "hung" }` and the window destroyed. A beat whose `seq`
  dropped with no window created in between (wry reloaded the page after a WebContent
  kill) answers the request in flight `{ ok: false, transient: true, reason:
  "contentReload" }` (kb exit 3).
- **Silent windows.** A live render window that sent no first beat 30 s after its create (90 s in dev builds, for a cold Vite load),
  or that beat before but sent none for 45 s while render requests wait (counted from the
  later of its last beat and the wait's start), is destroyed and counted as a stall with
  reason `silent`, so the backoff and the wedged state apply as above; the native loop
  checks every 300 ms (`SilenceWatch`, `silent` in `capture_service.rs`). A tick more than
  20 s after the last one (the Mac slept) restarts the clocks, and a hidden page beats about
  every 2 s, so neither reads as silence. A quiet window with nothing waiting stays (idle
  teardown owns it). `renderWindow.restarting` is true from a recycle until a window made
  after it beats; while it is, or a backoff runs, kb's waiting line reads `kb: the app is
  restarting its render window after a GPU stall (try 2 of 3, in about 15 s)`.
- **Measured.** A killed GPU process recovers within seconds through a
  fresh window (3.9 s); one stopped for 90 s then resumed did not recover through fresh
  windows within 5 minutes, so wedged ("ask the user to quit and reopen") is the outcome.
- **Retention.** Responses live 60 min under a 2 GiB cap, pruned oldest first per
  response (its JSON and PNGs), never one under 2 min old, at most once a minute, and only
  by their owner: `servedBy.pid` is this instance or dead, or there is none.
- **WebGL census.** `src/engine/glContexts.ts`, imported right after `bootTrap` in every
  window entry, wraps `getContext` as a pure pass-through and records each context.
  `WEBGL_lose_context.loseContext` marks our own losses deliberate; one unexpected loss
  while 16 or more are live is an eviction (WebKit's "too many active WebGL contexts" line
  never reaches a page), two within a second or any below 16 is a GPU loss. The editor
  reports its census on its tick, the render window with its beat.
- **The editor.** A loss on the editor's stage canvas shows a persistent banner ("The GPU
  reset. The preview may be missing reflections, and exports stay paused until the
  preview reloads.") with Reload preview: pending edits settle, then the main webview
  reloads (the only fresh realm); live terminal sessions are named in a confirm, since they
  keep running but detach from the panel. Exports still refuse on a canvas that lost its
  context. A wedged GPU shows Retry captures. Rust emits `kookaburra://bridge-activity {
  active, id, kind, client, frames, queued }` on each claim and answer, and the playback
  bar shows "Claude capturing · N queued"; the preview is never throttled or paused.
- **Debug.** `kb debug contexts` answers natively from the reported censuses (it never
  opens a window): `{ op, cap, windows: { editor, render: { alive, ... } },
  webContentPids }`, each census with its `contexts: [{ owner, api, width, height, lost,
  lossClass, ageMs }]`. `kb debug lose-context` forces a loss on the render window (every
  build; it recycles at once); `--window editor` works in dev builds only and shows the
  banner. `scripts/gpu-stall-probe.sh` is the dev-only harness (lose-context, GPU process
  killed, stopped and resumed, 17 contexts) against a test instance; it prints one verdict
  line per scenario, and C lists every recycle and whether the GPU wedged.

`health` (the heartbeat's block; `queue.order` and `etaMs` are the picker's simulated
order and the estimate to each answer, from the last 32 capture durations):

```json
{
  "version": 1,
  "captureFeatures": ["scale", "width", "probe", "client", "deadline", "recycle", "debug"],
  "queue": { "depth": 2, "oldestAgeMs": 4200,
    "order": ["0001792020004000-311-c0ffee", "0001792020003000-207-beef01"],
    "etaMs": [3800, 6000],
    "inFlight": { "id": "0001792020000000-123-abc123", "kind": "capture", "client": "alpha",
      "frames": 12, "framesDone": 4, "units": 12, "startedAtMs": 1792019998000 },
    "unitMs": 400, "overheadMs": 1000, "samples": 20 },
  "renderWindow": { "alive": true, "beatAgeMs": 1900, "glMs": 3.1, "webContentPid": 2345,
    "createdAtMs": 1792019000000, "loadedProject": "ws:product-tour", "contentReloads": 0,
    "restarting": false, "recycles": 1,
    "lastRecycle": { "atMs": 1792019500000, "reason": "contextLost" } },
  "gpu": { "stalled": false, "stalledUntilMs": null, "wedged": false, "stallsLast10Min": 1,
    "editorLostAtMs": null },
  "webgl": { "cap": 16,
    "editor": { "live": 3, "lost": 0, "deliberate": 1, "evictions": 0, "gpuLosses": 0,
      "reportedAtMs": 1792019999000, "stageLostAtMs": null },
    "render": { "live": 2, "lost": 0, "deliberate": 0, "evictions": 0, "gpuLosses": 0,
      "reportedAtMs": 1792019999000 } },
  "clients": [{ "client": "alpha", "unitsLastMin": 60, "capPerMin": 240, "pending": 1 }]
}
```

`kb status` prints a GPU WEDGED or stalled line, the queue, the render window (with "no
beat yet" and "restarting after a GPU stall" when they apply) and the context counts from
it; `--json` passes `health` through. `lastRecycle.reason` is `contextLost`, `eviction`,
`blankReadback`, `canvasFailed`, `notMounted`, `hung`, `silent` or `debug`.

## Headless edit CLI

The app binary doubles as a headless CLI: `<exe> edit <command>` returns before Tauri or
AppKit start (no Dock icon, no window), so `kb video` renders with the app closed using
the same Rust code as the editor window. `<exe>` is
`Kookaburra Cut.app/Contents/MacOS/kookaburra-cut`; the bundle's `Info.plist` carries
`KookaburraEditCli = 1`, and `kb` never executes a bundle binary without it (an older GUI
binary given `edit caps` would launch the whole app). `<exe> media` (the ingest conform) and
`<exe> song` (the song analyser) follow the same conventions; kb calls them only once `edit
caps` lists `media` or `song`. Code: `src-tauri/src/cli.rs`, `cli_media.rs` and `cli_song.rs`
over the app-free cores in `edit.rs`, `media.rs`, `conform.rs`, `song/` and `tools.rs`.

- stdout carries exactly one JSON object (`render`: JSON lines); stderr is diagnostics
  only; keys are alphabetical. Errors are `{ ok: false, code, error }`. Exit 0 ok, 1
  operation failed (`invalid`, `exists`, `conflict`, `missing`, `ffmpeg`, `version`,
  `corrupt`), 2 usage or environment (`usage`, `env`), 130 interrupted.
- `--project D` is always an absolute project folder; the CLI never reads the workspace
  root. ffmpeg and ffprobe resolve beside the executable, app data from the bundle
  identifier, the hardware toggle from settings.

| Command | Does |
| --- | --- |
| `caps` | CLI version, app version, build, commands, `checks` (the `<exe> check` commands it serves), `autorun` (what a headless `kb export` may ask: actions, trust modes, poster, progress), `docVersion` (`read` 3, `write` [1, 2, 3]), `song` (`analysisVersion`, `trackers`), `media` (`version`, `commands`: probe, conform), `mask` (styles, `fades`), `crop`, `zoom`, ffmpeg/ffprobe paths and filters, hardware video, tap styles/colours/sizes, limits. kb gates every newer feature on these keys, never on the app version |
| `probe --project D --source R` (or `--file ABS`) | The app's probe (rotation-aware size, `vfr`, `editFps`, `nbFrames`) |
| `create --project D --source R [--name N] [--reuse \| --force]` | The editor's default document for that source; an existing doc is `exists` unless `--reuse` or `--force` (backs up to `.json.bak`) |
| `validate --project D (--name N \| --doc -)` | Parse, mask rules and a render dry run: `{ ok, hash, version, totalFrames, durationMs, fps, width, height, clips, taps, errors, warnings }` |
| `save --project D --name N --doc - --base H\|absent` | The only doc writer outside the editor: serde strictness, version stamping, base-hash check (`conflict` when stale) |
| `render --project D (--name N \| --doc -) [--out ABS] [--software] [--draft \| --scale F] [--expect-hash H]` | `--name` alone renders `assets/<name>-edited.mp4`; `--out` is a review render outside `assets/` (`--draft` = half size, ultrafast) |
| `check flashes --file ABS [--standard wcag\|itu\|both] [--fps N]` | `<exe> check`, same conventions: the flash detector over the film decoded at 1024 wide as rgb24 (`--fps` resamples; VFR files resample at their average rate): `{ ok, file, width, height, decode, report }`; exit 0 whenever the film was read, the verdict is `report.ok` |
| `media caps` | `<exe> media`, same conventions (`src-tauri/src/cli_media.rs`): `{ cli, commands, timingVersion, fps: 60, keepOriginal: [move, copy], exitCodes }` |
| `media probe --file ABS [--pts]` | `{ ok, file, kind, ffmpeg, avfoundation, verdict, reasons, conform: { recommended, why, refused } }`: each decoder's facts (frame rate, edit list, B-frames, colour, rotation) and the verdict (`ok`, `suspect`, `ffmpeg-misdecodes`); `refused` names why a file can't conform (HDR, 10-bit, an odd transform, unreadable). `--pts` decodes with both and adds their frame timestamps |
| `media conform --project D --source REL [--name N] [--keep-original move\|copy] [--force]` | The ingest conform: JSON lines (`start`, `progress`, then `done` with `rel`, `original`, `timing`, `inPlace`, `frames`, `durationMs`, `verdict`, `reasons`); the mezzanine stages in `assets/.kc-render/`, the original goes to `assets/.originals/`, the frame map to `assets/<stem>.timing.json`. A move that would strand references is `in-use` (kb re-points first, or `--keep-original copy`) |
| `song caps` | `<exe> song` (`cli_song.rs`): `{ commands, analysisVersion, trackers, model: { name, available }, ffmpeg, ffprobe }` |
| `song analyse --file ABS [--force] [--tracker nn\|dsp]` | The beat lane's analyser, decoded with the bundled ffmpeg: `{ file, cached, cachePath, analysis }`, writing the same `<sha>-v2.json` cache the app reads |

Renders (editor and CLI alike) stage in the hidden folder `<dir>/.kc-render/` and rename
on success, so a failed render keeps the previous good file. A canonical render writes
`edits/.renders/<name>.json` (`{ docHash, output, lane, frames, durationMs, width,
height, fps, atMs }`), which the editor and `kb` use to tell a fresh render from a stale
one.

Loads: the render window keeps one loaded project and reuses it for captures, checks
and scene thumbnails while its id and source fingerprint are unchanged (so `check` then
`capture` loads once); an aspect change switches the mounted tree's format in place.

Trust: every load is stored-only, since this window cannot show the consent sheet; the
editor's own writes keep the open project's grant current natively. When a project's
content changed since the user allowed it, the response is `ok: false, needsTrust: true`
with a sentence telling the user to open it once. Before that, a `capture`, `check`,
`insertPreset` or `openEdit` for a workspace project other than the editor's open one
asks the person in a native dialog ("Allow Claude to use another project?", naming the
project and the client), once per project per app session (`bridge_confirm_project`,
`BridgeGrants`); "Don't allow" answers `{ ok: false, declined: true }` and holds for a
minute, so a flood of requests cannot flood dialogs. The app's own thumbnails never ask.

## Load safety

- **Fonts.** Every non-bundled face is vetted with troika's own parser
  (`src/theme/fontVet.ts`: parse, basic Latin lookups, a glyph walk, metrics) before
  troika sees it, including in the export preamble. A face that fails is swapped for
  the theme face of the nearest weight (else Inter) and a `fontIssue` names it
  (`src/theme/fontSafety.ts`). A file that can't be read this time is not judged: the
  load records a `transient` font issue that blocks deliverables until a reload reads
  it, and the export preamble fails loudly rather than standing a face in. The troika
  patch makes `codeToGlyph` take the first
  present subtable of a readable format (0, 4, 12; format 6 only as a last resort)
  instead of throwing; across 969 installed faces every face that worked keeps
  identical glyph ids and 67 more now work (Menlo, Helvetica Neue, Lucida Grande).
- **Scenes.** A scene that fails to read, compile, evaluate or default-export loads as
  an error card (camera-locked WebGL, bundled Inter, deterministic) and is recorded in
  `sceneErrors`; the rest of the project opens. A broken persistent module is recorded
  with `index: -1`. Export, stills and verify refuse while any scene is an error card,
  naming the files; an autorun screenshot still writes its PNG but exits 1. Render-time
  errors caught by the asset boundary are recorded too.
- **LUTs.** A LUT that fails to load is dropped with a warning (`loadWarnings`) so the
  project opens, and deliverables refuse until it loads.
- **Export blockers.** Error cards, a dropped LUT and an unreadable font file all
  refuse export, stills and verify with one message naming each (`sceneErrorRefusal`
  over `sceneErrors` and `exportBlockers`).
- **Failed reloads.** A live reload that fails keeps the last good project on stage
  with a persistent banner, not a toast, and the app makes no writes from that stale
  state.
- **Trust.** Declining the trust prompt explains what happened instead of silently
  returning to Welcome.

Types: `src/engine/loadDiagnostics.ts`; `LoadedProject.sceneErrors`,
`LoadedProject.fontIssues`, `LoadedProject.loadWarnings` and
`LoadedProject.exportBlockers`.

## Live edits (conflict-aware app)

- Every app write to a sidecar or `project.json` carries the content hash it was based
  on. Rust refuses the write when the file on disk no longer matches, checked right
  before the rename under a process-wide write lock, through a temp file unique to the
  write (an outside writer can still land in that last instant: POSIX has no content
  compare-and-swap). The app then
  reloads, re-applies the user's pending patch to the fresh document when it can, and
  otherwise drops it with a toast that names the scene.
- The reload poll keeps a per-file baseline. An app write updates only its own file's
  entry, so an outside change landing at the same moment still triggers a reload.
- Undo and redo refuse an entry whose file changed outside the app since, and say so.
- Index-based manifest commands also take the expected scene file and refuse on a
  mismatch, so a delete can never bin the wrong scene.
- Every native writer of a consent-covered file (`project.json`, `scenes/**`, `CLAUDE.md`,
  `.claude/settings.json`) re-stamps a standing trust grant as part of the write, and a
  kb write landing while the project is open and trusted in this app session re-stamps on
  the reload (Rust recomputes the hash in `check_project_trust`). Content that changed
  while the project was closed asks again through the native sheet on the next open.
- Edit documents work the same way. `save_edit` carries the base hash and refuses a
  stale one; the editor window polls its doc's stamp (1 s and on focus, applied once two
  polls agree) and takes an outside change as ONE "Claude edit" undo step, merging any
  unsaved local edits three ways (remote wins a clash, and a toast names what it
  replaced). It defers while a pointer is down, a field is mid-edit or a render runs. A
  removed or unreadable doc shows the error panel and stops autosave until it reads
  again. Code: `src/editor/editLiveSync.ts`; the editor's operations are the pure
  `src/engine/editOps.ts`, which `kb video` mirrors.

Code: `src-tauri/src/live_edits.rs` (hashes, stamps, guards; `project_file_stamps`,
`project_file_hashes`), `read_scene_doc_entry` and the `base_hash`/`file` arguments in
`scene_doc.rs`; `src/engine/sceneDocBase.ts`, `sceneDocRebase.ts`, `sourceBaseline.ts`,
`historyReplay.ts`. A content hash is the lowercase hex SHA-256 of the file's bytes; a
refusal is an error starting `conflict:`.

## The catalogue

`catalog.json` is generated by `src/agentKit/catalog.ts` from the live registries
(`pnpm agent:catalog`), and a unit test fails when the committed file is stale. Top
level keys: `version`, `aspects`, `transitions`, `eases`, `textMotion`,
`textLooks`, `themes`, `backgrounds` (`types`, `shaders`, `scene3d`, `gradients`,
`images`), `lighting`, `effects`, `devices`, `deviceShadows`, `deviceMotion`,
`deviceLayouts`, `deviceMedia` (`keys`: every device screen media key with its type and
summary, from `DEVICE_MEDIA_KEYS`), `camera` (`presets`, `dof`, `motionBlur`), `compare`,
`charts`, `chipIcons`, `bulletMarkers`, `fonts` (`bundled`), `sceneDoc` (`version`, `keys`),
`projectManifest` (`version`, `keys`), `toolkit` (`imports`, `exports`), `presets`,
`templates`, `exportPresets` (the Export modal's video rows: `aspects`, `favouredAspect`, `fps`,
`shortEdge`, `codec`, `container`, `loudnessTarget`, `lane`, `hardware`), `samplePool` (the
bundled placeholder assets the app restores, which the in-use rule always keeps). Every entry
has an `id`; most have `label` and a one-line `summary`.

## Verification

- Python: `pnpm test:kit` (unittest, one process per module in parallel; part of
  `pnpm test`, `pnpm test:kit test_check` runs one module); `pnpm test:kit:e2e` with
  `KB_E2E_APP_BIN=<kookaburra-cut binary>` runs `kb video` against the real CLI.
- Rust: `cargo test -- --ignored edit_` renders through the real sidecar (CLI end to
  end, core vs CLI byte-identical, barcode conformance, masks).
- Load safety and live edits touch the load and render paths: gate with
  `pnpm gate:merge` (both EQUAL), plus a workspace fixture holding an unsafe font and a
  broken scene to prove the project opens, `check` names both and export refuses.
