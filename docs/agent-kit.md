# Agent kit: Claude Code inside user projects

Claude Code is the primary way projects get edited. It runs inside one workspace
project folder (`~/Kookaburra Cut/<slug>`), from the app's embedded terminal or the
user's own, with no app source on disk. Everything it knows and every tool it uses
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
| `CLAUDE.md` | user | Created from `src-tauri/templates/project-CLAUDE.md`; imports `@.claude/skills/kookaburra-scene-authoring/RULES.md` |
| `.claude/settings.json` | user, with managed keys | The app merges its managed hooks and permission rules in; user entries are never removed |
| `.claude/skills/kookaburra-scene-authoring/` | app (managed) | Replaced wholesale on stamp; stale files disappear |
| `.claude/skills/kookaburra-scene-authoring/kit.json` | app | `{ "kitVersion", "appVersion", "stampedAtMs" }` |
| `project.json`, `scenes/`, `assets/` | user (Claude edits) | The only folders Claude writes |
| `exports/`, `edits/`, `.kookaburra*` | app | Never edited by Claude |

Skill tree (the source lives at `.agents/skills/kookaburra-scene-authoring/`):

```
SKILL.md            the loop, hard rules, capability map, routing table (about 7 KB)
RULES.md            always-on rules imported by CLAUDE.md (safety + live-edit contract)
DESIGN.md           playbook: presentations, product demos, launch videos
catalog.json        GENERATED (pnpm agent:catalog); never hand-edited
reference/          topic files loaded on demand
  project.md  sidecar.md  scenes.md  text.md  devices.md  camera.md
  backgrounds.md  lighting.md  media.md  charts.md  beats.md
scripts/
  kb.py             the one entry point
  kblib/            kb modules
  tests/            python3 -m unittest
  capture.py inspect.py sidecar.py theme.py   thin shims onto kb (old prompts still work)
  chart.py beats.py                           kept, Python 3.9 safe
```

## Stamping

- Runs on every workspace project load (best effort, never blocks the load) and when
  the embedded terminal starts Claude.
- The skill directory is copied to a temporary sibling and swapped in (`RENAME_SWAP`,
  with a two-rename fallback), so files the kit no longer ships are removed;
  `__pycache__` and `.DS_Store` are skipped. Dev builds restamp when the shipped tree
  differs byte for byte (never mid-session for nothing, since a hook may be running
  `kb.py`); release builds restamp when `kit.json`'s `appVersion` differs. Declining
  the trust prompt stamps nothing. Code: `src-tauri/src/kit.rs`.
- `CLAUDE.md`: written when missing. When it still matches a previous default
  template (whitespace-normalised; every past default lives in
  `src-tauri/templates/claude-md-history/`) it is replaced with the current one.
  Otherwise, when it lacks the RULES import, the import line is inserted after its
  first heading. Nothing else in a user-edited `CLAUDE.md` is touched. Changing the
  template means archiving the old one first (a test pins its digest).
- `.claude/settings.json`: created when missing. Managed hooks are identified by a
  command containing `kookaburra-scene-authoring/scripts/kb.py hook`; the stamp removes
  them and re-adds the current set. Managed `permissions.allow` entries are added when
  missing. An unparseable file is left alone. The file is only rewritten when its
  content changes, and then with sorted keys.

Managed settings:

```json
{
  "permissions": {
    "allow": [
      "Bash(python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
      "Bash(python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
      "Read(~/Kookaburra Cut/_bridge/**)",
      "Read(~/Kookaburra Cut/themes/**)",
      "Read(//Applications/Kookaburra Cut.app/Contents/Resources/**)"
    ]
  },
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [
      { "type": "command", "timeout": 20,
        "command": "[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook session-start" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [
      { "type": "command", "timeout": 20,
        "command": "[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook pre-edit" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [
      { "type": "command", "timeout": 30,
        "command": "[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook post-edit" }] }]
  }
}
```

Each command is guarded so a missing `kb.py` exits 0 and never blocks an edit; `kb.py`
itself fails open (exit 0) when its modules are missing mid-swap. Hooks only run once the user has accepted Claude Code's workspace trust for the folder.

## kb

`python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py <command>`, run from the
project folder (it also finds the project by walking up from the cwd, or from
`$CLAUDE_PROJECT_DIR`). Python 3.9, standard library only, `from __future__ import
annotations` in every module, and `kb.py` inserts its own directory into `sys.path`
(isolated mode drops it). Exit codes: 0 ok, 1 problems found or the operation failed,
2 usage or environment (for example the app is needed but not running). Every write is
atomic (temp file in the same folder, then rename) and re-validated after writing.
`--json` gives machine output wherever a command reports.

| Command | Does |
| --- | --- |
| `status` | App alive (heartbeat), version, open project, aspect, exporting; this project's last load result; kit version; checkpoint state |
| `context` | The SessionStart text: status, scene roster, last load errors, the five rules that matter most (under 4 KB) |
| `scenes` | Roster: index, stem, name, duration, transition, text, overrides (replaces `inspect.py`) |
| `check [--app] [--render] [files...]` | Static checks (below); `--app` adds the running app's real compile, load and font checks; `--render` also renders each scene once |
| `capture [--scene S] [--at T] [--aspect A] [--frames S@T,...] [--sheet]` | Frames from the running app; prints PNG paths; `--sheet` adds one contact-sheet PNG |
| `scene add <stem> [--preset P \| --copy S] [--after S \| --at N] [--duration MS] [--name N]` | New scene, unique stem and `defineScene` id, registered once; presets insert through the app when it runs, else copy from the app bundle |
| `scene duplicate S`, `scene move S --to N`, `scene remove S`, `scene set S [--duration MS] [--transition TYPE[:MS]]` | Manifest-safe scene operations; remove moves files to the macOS Trash |
| `doc S get [path]`, `doc S set path value`, `doc S unset path`, `doc S merge JSON` | Sidecar edits by dotted path; values parsed as JSON else string; enums validated against the catalogue |
| `project get [path]`, `project set path value` | `project.json` fields other than `scenes` |
| `theme list`, `theme show [id]`, `theme set path value` | Bundled tokens from the catalogue; workspace themes editable |
| `fonts safe`, `fonts check REF...`, `fonts list` | Bundled faces are always safe; `check` and `list` use the app's real parser when it runs, else a static verdict |
| `presets [list \| show SLUG]` | Scene presets with what they show and a preview image path to Read |
| `catalog [FAMILY] [--search Q]` | Query `catalog.json` |
| `assets list`, `assets add PATH [--name N]`, `assets probe ASSET` | Copy media in (never overwrites, renames on collision), probe with the app's bundled ffprobe |
| `checkpoint [MESSAGE]`, `history`, `undo [REV]`, `diff` | Git checkpoints of `project.json` and `scenes/`; `undo` checkpoints first, so it is itself undoable |
| `hook session-start \| pre-edit \| post-edit` | Hook entry points (stdin JSON from Claude Code) |
| `beats ...`, `chart ...` | Delegate to the existing scripts |

As built (`scripts/kblib/`):

- `doc`, `project` and `theme set` refuse a write that would add errors (exit 1, nothing
  written) unless `--force`.
- The app's font verdicts from `fonts` and `check` responses are cached in
  `~/Kookaburra Cut/_bridge/font-verdicts.json`; static checks honour them, so a
  vetted face stops warning and a failed one is an error naming its fallback.
- `scene remove` and `undo` checkpoint a dirty tree first; `undo` with no revision
  returns to the last checkpoint.
- `scene add --preset` goes through the app's `insertPreset` when it runs (the app picks
  the stem and id from the name), else copies from the bundle; an existing unregistered
  `scenes/<stem>.tsx` is registered rather than overwritten.
- Bridge waits default to 240 s for captures and 300 s for `check` (600 s with
  `--render`): a cold first load of a large project mounts every scene and can take
  minutes; warm captures take seconds.
- `kb.py` never writes bytecode, and fails open for hooks when its modules are missing.

Static checks: `project.json` (valid JSON, version, required fields, files exist, no
duplicate entries, transitions and options, formats, theme id, audio file); sidecars
(JSON, version, unknown top-level keys, enum values, font refs, asset paths exist with
exact case and a supported extension); TSX (imports only `@kookaburra/toolkit`, one
`export default defineScene(`, a literal id unique in the project, no wall clock,
timers, `Math.random`, DOM or drei `Html`, no React hooks, which the toolkit does not
export). Errors exit 1; warnings print but pass.

Hooks:

- `session-start` prints `context`. Never fails the session.
- `pre-edit` blocks (exit 2 with a reason) writes to app-owned paths and to the managed
  kit. Before the first write of a session into `project.json` or `scenes/` it makes a
  checkpoint when the tree has changes since the last one.
- `post-edit` runs the static check scoped to the edited file (plus the manifest
  cross-checks). Errors exit 2 so Claude sees them and fixes them; warnings go back as
  `additionalContext`. It must finish in about a second; it never calls the app.

## The bridge (v2)

File-drop queue under the FIXED `~/Kookaburra Cut/_bridge/` (never a relocated root).

### Heartbeat: `_bridge/app.json`

Written atomically by the interactive app at most every 2 s while it runs (any view),
removed on exit; autorun instances never write it.

```json
{
  "version": 2,
  "pid": 87186,
  "appVersion": "0.19.0",
  "build": "release",
  "updatedAtMs": 1792020000000,
  "workspaceRoot": "/Users/x/Kookaburra Cut",
  "resourcesDir": "/Applications/Kookaburra Cut.app/Contents/Resources",
  "openProject": "ws:product-tour",
  "aspect": "16:9",
  "playheadMs": 61000,
  "exporting": false,
  "playing": false,
  "kinds": ["capture", "check", "fonts", "insertPreset"],
  "lastLoad": {
    "project": "ws:product-tour",
    "ok": true,
    "atMs": 1792019990000,
    "error": null,
    "sceneErrors": [{ "index": 12, "file": "scenes/224-x.tsx", "phase": "compile", "message": "line 4: ..." }],
    "fontIssues": [{ "ref": "Menlo@400", "message": "unknown cmap table format 6", "fallback": "Inter@400" }],
    "warnings": []
  }
}
```

Two more fields locate the presets: `presetsDir` (holds `<slug>/`) and
`presetPreviewsDir` (holds `<slug>.jpg`); in dev the posters live under `src/assets`.
`playheadMs` is an integer and `openProject` is null on the Welcome screen. The editor
reports `lastLoad` after every load attempt (`set_last_load`); `warnings` includes
healed scene ids and dropped LUTs.

`kb` treats the app as running when `updatedAtMs` is under 15 s old and the pid is
alive. It never uses `pgrep` (it matches unrelated processes and misses others).

### Requests and responses

`requests/<id>.json` (written via a dot-prefixed temp file, then renamed); the answer
lands in `responses/<id>.json`. A request without `kind` is a v1 capture.

```json
{ "version": 2, "id": "0001792020000000-123-abc", "kind": "capture",
  "project": "ws:<slug>", "requestedAtMs": 1792020000000,
  "scene": "03-feature-checks", "at": 1.5, "aspect": "9:16",
  "frames": [{ "scene": "3", "at": 2.0 }], "sheet": true,
  "render": false,
  "refs": ["Menlo@400"], "listFamilies": false,
  "preset": "title", "position": 4, "name": "Highlights" }
```

`requestedAtMs` is optional (the file's age stands in), `scene` is an index or a file
stem, and an unparseable request gets an immediate error response. A request without
`kind` and with `version` below 2 is answered as `version: 1`, so old kits keep working.

Every response carries `{ "version": 2, "id", "ok", "error"?, "busy"?, "needsTrust"? }`
plus its kind's payload. `busy` applies to every kind except `fonts` while exporting.

- `capture`: `path` (first frame), `paths`, `frames: [{ scene, at, tMs, path, index }]`
  (`scene` is the resolved stem, `at` seconds into it), a top-level `tMs`, `sheetPath`
  when asked, `project`, `format`, `surface: "render-window"`. Files are `<id>.png`,
  `<id>-N.png` and `<id>-sheet.png`; at most 48 frames. `aspect` overrides the editor's
  aspect for this request only; an unknown aspect is an error.
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

Trust: a request for the project open in the editor runs under the editor's session
trust (the same re-stamp the editor already does on every load). Any other project
loads stored-only; when its sources changed since the user allowed it, the response is
`ok: false, needsTrust: true` with a sentence telling the user to open it once.

## Load safety

- **Fonts.** Every non-bundled face is vetted with troika's own parser
  (`src/theme/fontVet.ts`: parse, basic Latin lookups, a glyph walk, metrics) before
  troika sees it, including in the export preamble. A face that fails is swapped for
  the theme face of the nearest weight (else Inter) and a `fontIssue` names it
  (`src/theme/fontSafety.ts`). The troika patch makes `codeToGlyph` take the first
  present subtable of a readable format (0, 4, 12; format 6 only as a last resort)
  instead of throwing; across 969 installed faces every face that worked keeps
  identical glyph ids and 67 more now work (Menlo, Helvetica Neue, Lucida Grande).
- **Scenes.** A scene that fails to read, compile, evaluate or default-export loads as
  an error card (camera-locked WebGL, bundled Inter, deterministic) and is recorded in
  `sceneErrors`; the rest of the project opens. A broken persistent module is recorded
  with `index: -1`. Export, stills and verify refuse while any scene is an error card,
  naming the files; an autorun screenshot still writes its PNG but exits 1. Render-time
  errors caught by the asset boundary are recorded too.
- **LUTs.** A LUT that fails to load is dropped with a warning (`loadWarnings`).
- **Failed reloads.** A live reload that fails keeps the last good project on stage
  with a persistent banner, not a toast, and the app makes no writes from that stale
  state.
- **Trust.** Declining the trust prompt explains what happened instead of silently
  returning to Welcome.

Types: `src/engine/loadDiagnostics.ts`; `LoadedProject.sceneErrors` and
`LoadedProject.fontIssues`.

## Live edits (conflict-aware app)

- Every app write to a sidecar or `project.json` carries the content hash it was based
  on. Rust refuses the write when the file on disk no longer matches. The app then
  reloads, re-applies the user's pending patch to the fresh document when it can, and
  otherwise drops it with a toast that names the scene.
- The reload poll keeps a per-file baseline. An app write updates only its own file's
  entry, so an outside change landing at the same moment still triggers a reload.
- Undo and redo refuse an entry whose file changed outside the app since, and say so.
- Index-based manifest commands also take the expected scene file and refuse on a
  mismatch, so a delete can never bin the wrong scene.
- After its own writes in a trusted session the app re-stamps trust, so a restart does
  not re-prompt for the user's own edits.

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
`deviceLayouts`, `camera` (`presets`, `dof`), `compare`, `charts`, `chipIcons`,
`bulletMarkers`, `fonts` (`bundled`), `sceneDoc` (`version`, `keys`),
`projectManifest` (`version`, `keys`), `toolkit` (`imports`, `exports`), `presets`,
`templates`. Every entry has an `id`; most have `label` and a one-line `summary`.

## Verification

- Python: `pnpm test:kit` (unittest; part of `pnpm test`).
- Load safety and live edits touch the load and render paths: gate with
  `pnpm gate:merge` (both EQUAL), plus a workspace fixture holding an unsafe font and a
  broken scene to prove the project opens, `check` names both and export refuses.
