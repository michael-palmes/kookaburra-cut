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
| `.claude/skills/kookaburra-video-editing/` | app (managed) | Sibling skill (SKILL.md + `reference/`, no scripts; it drives `kb video`) |
| `.claude/skills/<skill>/kit.json` | app | `{ "kitVersion", "appVersion", "stampedAtMs" }`, one per shipped skill |
| `project.json`, `scenes/`, `assets/` | user (Claude edits) | The only folders Claude writes by hand |
| `edits/` | app, and `kb video` | Video edit documents; Rust is the only writer (the editor window and `kb video` through the app's CLI); never hand-edited |
| `exports/`, `.kookaburra*` | app | Never edited by Claude |
| `./kb` | app (managed) | The zsh-safe shim: `exec python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py "$@"`; replaced only while it still carries its marker line |
| `.kb/` | kb | Multi-agent state (lock, leases, notes, events, per-agent scratch, capture copies); ignores itself; never packed or duplicated |

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

- Runs on the first load of each workspace project per app session (best effort, never
  blocks the load; live reloads skip it) and when the embedded terminal starts Claude.
- Every shipped skill (`SHIPPED_SKILLS` in `kit.rs`: `kookaburra-scene-authoring`, then
  `kookaburra-video-editing`) is stamped into `.claude/skills/<name>/` with its own
  `kit.json` and stale-sibling prefixes; a failing skill never stops the others, and
  provisioning reports `present` only when all are there. Kit version 3.
- The skill directory is copied to a temporary sibling and swapped in (`RENAME_SWAP`,
  with a two-rename fallback), so files the kit no longer ships are removed;
  `__pycache__`, `.DS_Store` and `scripts/tests` are skipped (test fixtures stay out of
  projects; a stale stamped copy forces a restamp). The app bundle leaves `scripts/tests`
  out too: `tauri.conf.json` lists each skill's files and folders, and a `kit.rs` test
  fails when a shipped file is not bundled. Dev builds restamp when the shipped tree
  differs byte for byte (never mid-session for nothing, since a hook may be running
  `kb.py`); release builds restamp when `kit.json`'s `appVersion` differs or the stamped
  tree no longer has the shipped files at their shipped sizes (a deleted or truncated
  file heals without reading the kit's contents). Declining
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
(isolated mode drops it). Output, exit codes, errors and writes follow "kb conventions"
below. Every write is atomic (temp file in the same folder, then rename) and
re-validated after writing.

| Command | Does |
| --- | --- |
| `status` | App alive (heartbeat), version, open project, aspect, exporting; this project's last load result; kit version; checkpoint state; a leading STOP banner when the project is a linked git worktree (`--json`: `worktree` is `{ path, main }` or null) |
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
| `checkpoint [MESSAGE]`, `history`, `undo [REV]`, `diff` | Git checkpoints of `project.json`, `scenes/` and `edits/`; `undo` checkpoints first, so it is itself undoable, never trashes `edits/`, and names any render it leaves stale |
| `video ...` | Video editing (below): edit documents, renders, re-points, cleanup, fit, review |
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
- Bridge waits default to 120 s for captures and 300 s for `check` (600 s with
  `--render`). On a large media-heavy project in a dev build a cold capture answers in
  about 10 s, a warm one or an aspect switch in about 2 s, and a cold 48-frame sheet in
  about a minute.
- `kb.py` never writes bytecode, and fails open for hooks when its modules are missing.

Static checks: `project.json` (valid JSON, version, required fields, files exist, no
duplicate entries, transitions and options, formats, theme id, audio file); sidecars
(JSON, version, unknown top-level keys, enum values, font refs, asset paths exist with
exact case and a supported extension); TSX (imports only `@kookaburra/toolkit`, one
`export default defineScene(`, a literal id unique in the project, no wall clock,
timers, `Math.random`, DOM or drei `Html`, no React hooks, which the toolkit does not
export). Errors exit 1; warnings print but pass.

Hooks:

- `session-start` prints `context`. Never fails the session. When the project or the
  hook's `cwd` is a linked git worktree (its `.git` is a file pointing into
  `.git/worktrees/`), a STOP banner leads: the app never sees a worktree, so the agent
  must edit nothing and ask for a session in the project folder itself. The `cwd` check
  matters because a desktop worktree session can carry the main folder as
  `CLAUDE_PROJECT_DIR`. Detection reads files only (`worktree_of` in `project.py`).
- `pre-edit` blocks (exit 2 with a reason) writes to app-owned paths, to the managed
  kit and to anything inside a linked git worktree of a project (the same STOP text).
  Before the first write of a session into `project.json` or `scenes/` it makes a
  checkpoint when the tree has changes since the last one.
- `post-edit` runs the static check scoped to the edited file (plus the manifest
  cross-checks). Errors the edit introduced exit 2 so Claude sees them and fixes them;
  errors the file already had (snapshotted by `pre-edit`, keyed by the tool call) and
  warnings go back as `additionalContext`. It must finish in about a second; it never
  calls the app.

## kb conventions

Every kb command, including new ones, follows these rules. Code: `scripts/kblib/util.py`
(`KbError`, `ok_envelope`, exit constants), `scripts/kblib/lock.py` (writes).

- **Invocation.** `./kb <command>` from the project folder. Never store kb in a shell
  variable (zsh does not split it). Hook paths never import `kblib.cli`.
- **Global flags.** `--json` on every command. `--agent NAME` names the caller (`KB_AGENT`
  only in a plain terminal: an allow rule does not match past a `VAR=` prefix).
  `--dry-run` on every structural command; `./kb plan <command ...>` is the same dry run.
- **Output.** Plain text for people. `--json` prints exactly one object on stdout:
  `{ "ok": true, "command": "scene add", ...payload }`. A streaming command
  (`events --follow`, `export`) prints one compact object per line, the final object
  last. Lists go under a plural key (`scenes`, `checkpoints`, `items`), never as a bare
  array. Keys are camelCase, times integer ms (`atMs`, `durationMs`), paths
  project-relative with `/`. Diagnostics go to stderr.
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
  `gpu-stalled`, `gpu-wedged`, `throttled`, `too-large`, `flashes`. Each kind has a
  default hint (`DEFAULT_HINTS`). Never print a traceback.
- **Writes.** Every write to `project.json`, `scenes/**` or `.kb/**` goes through
  `kblib.lock`. A read-modify-write uses `mutate_json(project, rel, fn)`; a multi-file
  change uses `with project_txn(project, op, dry_run=..., caller=...) as tx:` with
  `tx.read(rel)` (bytes plus base hash, `absent` when missing), `tx.write_json`,
  `tx.write_text(create_only=)` and `tx.trash`. The transaction takes `.kb/lock`
  (`flock`, 10 s, `--wait SECONDS`), checks leases, verifies each base hash (lowercase
  hex SHA-256 of the bytes, the app's rule) right before each rename, writes new files
  first and `project.json` last, and journals one `files.changed` event. When someone
  saved in between, `fn` is re-applied to the fresh document up to 3 times, then exit 3;
  a pinned `--base`, or a scene addressed by an index that moved, refuses at once. Never
  hold the lock while waiting on the app or ffmpeg; take an edit lock before the
  project lock. Workspace themes are shared across projects: compare-and-swap only.
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
.kb/captures/<stamp>[-<agent>]/ capture copies, newest 40 folders, 1 GB at most
```

- **Identity.** A caller is `{ name, session, agentId }`. kb run from Bash knows `name`
  (`--agent`, default `session-<first 8 of CLAUDE_CODE_SESSION_ID>`, or `user` outside
  Claude Code) and `session`. Hooks know `session` and `agentId` (`main` outside a
  subagent). The Bash pre-hook sees both a `--agent NAME` command and the subagent id,
  and binds them in `.kb/agents/<name>/identity.json`, so Edit and Write checks can tell
  subagents of one session apart.
- **Leases.** Opt-in. `./kb lease S --agent A [--ttl 2h] [--note T]` takes or renews;
  `--for NAME` assigns one to another agent; `--release`, and `--release --force` breaks
  someone else's (journalled). TTL 2 h by default, 12 h at most, renewed by the holder's
  writes once under half is left; expired leases are ignored. Edit and Write to a scene
  leased to someone else are denied (`permissionDecision: "deny"` with the holder and
  expiry); a Bash command that visibly writes one (`sed -i`, `>`, `tee`, `cp`, `mv`, a
  heredoc, `write_text`, `open(..., 'w')`) is denied too, and any other change to it is
  reported after the fact. kb's own writes check leases in the transaction.
- **Scoped history.** `./kb checkpoint [MSG] --scene S` commits only S's files;
  `./kb undo --scene S [REV]` restores only `scenes/S.tsx`, `scenes/S.json` and S's own
  `project.json` entry (by compare-and-swap). A plain `undo` refuses, naming the files,
  when the journal or a lease shows another agent changed files since its target;
  `--all` overrides. `index.lock` is retried with backoff (50 ms doubling to 1.6 s), then
  exit 3; a hook that skips its checkpoint says so in `additionalContext`.
- **Events.** `./kb events [--follow] [--since 10m|CURSOR|all] [--kinds ...] [--all-agents]
  [--exit-after SECONDS]` prints one compact object per line:
  `{ "v": 1, "id", "atMs", "kind", "by": { name, session, agentId }, ...}`. kb journals
  `checkpoint`, `checkpoint.skipped`, `undo`, `lease.*`, `note`, `files.changed`; the
  follower adds app events read from heartbeat and progress-file changes (`load`,
  `export.*`, `render.stalled`, `render.recovered`, `app.opened`, `app.closed`). A follow
  ends with `{ "kind": "follow.end", "cursor" }` so a re-armed Claude Code Monitor resumes.
- **Notes.** `./kb note "TEXT" [--scene S]` appends to `.kb/notes.md`; every agent's next
  `./kb status` shows up to three unseen notes.

## kb video

`kb video` edits the app's own video-editor documents (`edits/<name>.json`) so the user
can open every change in the editor (`kb video open`). The `kookaburra-video-editing`
skill is its playbook. Code: `scripts/kblib/video/`.

- Engine: `editmath`/`editops` mirror `src/engine/editMath.ts`, `editMasks.ts` and
  `editOps.ts` exactly (`js_round` half up, the same check order and error codes);
  `editdoc.mutate` takes a per-edit lock, applies ops, validates and saves through the
  CLI's `edit save --base`, rebasing up to three times on a conflict; `repoint` mirrors
  `applyEditRepoint` and the follow-media duration sync on the raw sidecar with
  hash-checked, guarded writes; `appcli` finds the CLI (`KB_APP_BIN`, the live
  heartbeat's `cliPath`, the installed bundle after its `Info.plist` gate, then
  `_bridge/cli.json` last, so a leftover dev build never shadows the installed app).
- Commands: `list`, `show`, `map`, `usages`, `validate`, `caps`; `new`, `reset`;
  `split`, `cut`, `keep`, `trim`, `speed`, `freeze`, `hold`, `remove`, `move`, `insert`,
  `append`; `tap ...`, `mask ...`; `apply PLAN` (all or nothing); `analyse`, `cleanup`,
  `taps suggest`, `fit`, `align`; `frames`, `sheet`; `render`, `use`, `durations`,
  `open`. Bare times are seconds; `--at` is timeline time, `--src` source time.
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
  fails vitest. The Rust barcode fixtures (`fixtures/video-conformance/`, an `#[ignore]`
  test) pin which source frame the render shows at every output frame.
- Hooks keep Edit and Write out of `edits/` and both managed skill folders; `kb video`
  is the only way an agent changes an edit.

## The bridge (v2)

File-drop queue under the FIXED `~/Kookaburra Cut/_bridge/` (never a relocated root;
`KOOKABURRA_BRIDGE_DIR`, an absolute path, redirects it for tests only, and kb reads
`KB_BRIDGE_DIR`, then `KOOKABURRA_BRIDGE_DIR`).

### Instances and addressing

Several app instances can run on one machine (the packaged app, a dev build, acceptance
bundles, autoruns). Each decides once at start whether it serves the bridge, in order:

1. An autorun never serves.
2. `KOOKABURRA_BRIDGE=0` turns serving off; `KOOKABURRA_BRIDGE=1` turns it on.
3. An overridden workspace root (`KOOKABURRA_WORKSPACE_ROOT`), a non-production bundle id,
   or a debug build from a linked git worktree does not serve.
4. Everything else serves: the packaged app and a dev build from the main checkout.

- **Heartbeats are per process:** `_bridge/apps/<pid>.json` (the `app.json` body below plus
  `startedAtMs`, `bundleId`, `exePath`, `checkout`, `rootSource`, `bridge: { serving,
  reason }`, `primary`, `exportJob`, `health`), written by every interactive instance,
  serving or not, removed on exit, and pruned by others when its pid is dead or it is
  10 min old. `app.json` stays for older kits, written only by the elected primary.
- **Election.** Among live serving instances on the project's workspace root, kb picks the
  one with the project open, then a release build over a dev build, then the earliest
  start, then the lowest pid, and addresses it by pid. Not an error; `kb status` warns
  when two instances share a root and lists every live instance with the reason a passive
  one does not serve.
- **Requests** carry `workspaceRoot`, `projectPath`, `instancePid` and `client` (the
  agent name). An instance claims only a request addressed to its pid; else one whose
  `workspaceRoot` is its own root (compared by device and inode); else (old kits) one
  whose `projectPath` or `<root>/<slug>` matches, the rule the native loop already used.
  The pending count the editor uses to spawn the render window applies the same rule,
  and an instance that does not serve never touches `requests/`.
- **Responses** carry `servedBy: { pid, bundleId, build, appVersion, workspaceRoot }`. kb
  discards an answer whose root is not the project's (exit 2), and fails fast (exit 2)
  when no live instance serves the project's root, naming the live ones.
- **Health.** The serving instance's heartbeat carries `health`: queue depth and order,
  the in-flight request, render-window liveness and beat age, recycles, the GPU state
  (`stalled`, `stalledUntilMs`, `wedged`), live WebGL contexts per window, and per-client
  usage. kb prints the queue position and an estimate while it waits.

### Heartbeat: `_bridge/app.json`

Written atomically by the interactive app at most every 2 s while it runs (any view),
from the editor's tick and from a native thread every 5 s (the webview's timers are
throttled while the app is hidden), removed on exit; autorun instances never write it.

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
  "kinds": ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit"],
  "cliPath": "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
  "cliVersion": 1,
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

`kb` treats the app as running when `updatedAtMs` is under 30 s old and the pid is
alive. It never uses `pgrep` (it matches unrelated processes and misses others).

`cliPath` is the app's own executable (the headless edit CLI, below) and `cliVersion`
its CLI version. Interactive builds also write `_bridge/cli.json`
(`{ path, appVersion, build, cli, writtenAtMs }`) once at setup and never delete it, so
`kb` can still find a dev build's CLI while the app is closed (it only uses it when no
installed app qualifies).

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

Native kinds. `mediaChanged` and `openEdit` are claimed by a Rust loop
(`spawn_native_bridge`, 300 ms poll) rather than the render window, which never claims
them and never spawns for them. Both take `project: "ws:<slug>"` and the optional
`projectPath`. An instance only claims a request for a project in its own workspace
(`projectPath` must resolve to `<root>/<slug>`, else the slug folder must exist), so with
two apps open the right one answers; a request no running app can serve waits until
`kb` times out.

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

## Headless edit CLI

The app binary doubles as a headless CLI: `<exe> edit <command>` returns before Tauri or
AppKit start (no Dock icon, no window), so `kb video` renders with the app closed using
the same Rust code as the editor window. `<exe>` is
`Kookaburra Cut.app/Contents/MacOS/kookaburra-cut`; the bundle's `Info.plist` carries
`KookaburraEditCli = 1`, and `kb` never executes a bundle binary without it (an older GUI
binary given `edit caps` would launch the whole app). Code: `src-tauri/src/cli.rs`
over the app-free cores in `edit.rs`, `media.rs` and `tools.rs`.

- stdout carries exactly one JSON object (`render`: JSON lines); stderr is diagnostics
  only; keys are alphabetical. Errors are `{ ok: false, code, error }`. Exit 0 ok, 1
  operation failed (`invalid`, `exists`, `conflict`, `missing`, `ffmpeg`, `version`,
  `corrupt`), 2 usage or environment (`usage`, `env`), 130 interrupted.
- `--project D` is always an absolute project folder; the CLI never reads the workspace
  root. ffmpeg and ffprobe resolve beside the executable, app data from the bundle
  identifier, the hardware toggle from settings.

| Command | Does |
| --- | --- |
| `caps` | CLI version, app version, build, commands, doc versions, ffmpeg/ffprobe paths and filters, hardware video, tap styles/colours/sizes, mask styles, limits |
| `probe --project D --source R` (or `--file ABS`) | The app's probe (rotation-aware size, `vfr`, `editFps`, `nbFrames`) |
| `create --project D --source R [--name N] [--reuse \| --force]` | The editor's default document for that source; an existing doc is `exists` unless `--reuse` or `--force` (backs up to `.json.bak`) |
| `validate --project D (--name N \| --doc -)` | Parse, mask rules and a render dry run: `{ ok, hash, version, totalFrames, durationMs, fps, width, height, clips, taps, errors, warnings }` |
| `save --project D --name N --doc - --base H\|absent` | The only doc writer outside the editor: serde strictness, version stamping, base-hash check (`conflict` when stale) |
| `render --project D (--name N \| --doc -) [--out ABS] [--software] [--draft \| --scale F] [--expect-hash H]` | `--name` alone renders `assets/<name>-edited.mp4`; `--out` is a review render outside `assets/` (`--draft` = half size, ultrafast) |

Renders (editor and CLI alike) stage in the hidden folder `<dir>/.kc-render/` and rename
on success, so a failed render keeps the previous good file. A canonical render writes
`edits/.renders/<name>.json` (`{ docHash, output, lane, frames, durationMs, width,
height, fps, atMs }`), which the editor and `kb` use to tell a fresh render from a stale
one.

Loads: the render window keeps one loaded project and reuses it for captures, checks
and scene thumbnails while its id and source fingerprint are unchanged (so `check` then
`capture` loads once); an aspect change switches the mounted tree's format in place.

Trust: a request for the project open in the editor runs under the editor's session
trust (the same re-stamp the editor already does on every load). Any other project
loads stored-only; when its sources changed since the user allowed it, the response is
`ok: false, needsTrust: true` with a sentence telling the user to open it once.

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
- After its own writes in a trusted session the app re-stamps trust, so a restart does
  not re-prompt for the user's own edits.
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
`deviceLayouts`, `camera` (`presets`, `dof`, `motionBlur`), `compare`, `charts`, `chipIcons`,
`bulletMarkers`, `fonts` (`bundled`), `sceneDoc` (`version`, `keys`),
`projectManifest` (`version`, `keys`), `toolkit` (`imports`, `exports`), `presets`,
`templates`. Every entry has an `id`; most have `label` and a one-line `summary`.

## Verification

- Python: `pnpm test:kit` (unittest; part of `pnpm test`); `pnpm test:kit:e2e` with
  `KB_E2E_APP_BIN=<kookaburra-cut binary>` runs `kb video` against the real CLI.
- Rust: `cargo test -- --ignored edit_` renders through the real sidecar (CLI end to
  end, core vs CLI byte-identical, barcode conformance, masks).
- Load safety and live edits touch the load and render paths: gate with
  `pnpm gate:merge` (both EQUAL), plus a workspace fixture holding an unsafe font and a
  broken scene to prove the project opens, `check` names both and export refuses.
