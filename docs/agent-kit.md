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
below. Every write is atomic (temp file in the same folder, then rename), compare-and-swap
under the project lock (`kblib.lock`) and re-validated after writing.

| Command | Does |
| --- | --- |
| `status` | App alive (heartbeat), version, open project, aspect, exporting; this project's last load result; kit version; checkpoint state; a leading STOP banner when the project is a linked git worktree (`--json`: `worktree` is `{ path, main }` or null) |
| `context` | The SessionStart text: status, scene roster, last load errors, the five rules that matter most (under 4 KB) |
| `scenes` | Roster: index, stem, name, duration, transition, text, overrides (replaces `inspect.py`) |
| `check [--app] [--render] [files...]` | Static checks (below); `--app` adds the running app's real compile, load and font checks; `--render` also renders each scene once; `check film ...` hands its arguments to `kblib/film` (`run(ctx, rest)`) |
| `capture [--scene S] [--at T] [--aspect A] [--frames S@T,...] [--sheet]` | Frames from the running app; prints PNG paths; `--sheet` adds one contact-sheet PNG |
| `scene add <stem> [--preset P \| --copy S] [--after S \| --at N] [--duration MS] [--name N]` | New scene, unique stem and `defineScene` id, registered once; presets insert through the app when it runs, else copy from the app bundle |
| `scene duplicate S`, `scene move S --to N`, `scene remove S`, `scene set S [--duration MS] [--transition TYPE[:MS]]` | Manifest-safe scene operations; remove moves files to the macOS Trash |
| `doc S get [path]`, `doc S set path value`, `doc S unset path`, `doc S merge JSON` | Sidecar edits by dotted path; values parsed as JSON else string; enums validated against the catalogue; `get` prints the raw value (`--json`: `{ file, path, value }`) |
| `project get [path]`, `project set path value`, `project unset path` | `project.json` fields other than `scenes` (`get --json`: `{ path, value }`) |
| `theme list`, `theme show [id]`, `theme set path value` | Bundled tokens from the catalogue; workspace themes editable (`show --json`: `{ id, bundled, path, theme }`) |
| `fonts safe`, `fonts check REF...`, `fonts list` | Bundled faces are always safe; `check` and `list` use the app's real parser when it runs, else a static verdict (`--json`: `faces`, `results`, `families` or the static `bundled` and `pinned`) |
| `presets [list \| show SLUG]` | Scene presets with what they show and a preview image path to Read (`--json`: `presets`) |
| `catalog [FAMILY] [--search Q]` | Query `catalog.json` (`--json`: `families`; a family's raw entries as `{ family, items }`, or `{ family, value }` when it is not a list; a search's `items`) |
| `assets list`, `assets add PATH [--name N]`, `assets probe ASSET` | Copy media in (never overwrites, renames on collision), probe with the app's bundled ffprobe (`list --json`: `assets`) |
| `checkpoint [MESSAGE]`, `history`, `undo [REV]`, `diff` | Git checkpoints of `project.json`, `scenes/` and `edits/`; `undo` checkpoints first, so it is itself undoable, never trashes `edits/`, and names any render it leaves stale (`history --json`: `checkpoints`, each with `atMs`) |
| `video ...` | Video editing (below): edit documents, renders, re-points, cleanup, fit, review (`list --json`: `edits`) |
| `export [--aspect A] [--preset ID] [--verify] [--headless] ...` | The finished film, exactly as the app's Export button makes it (below) |
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
  that kept conflicting (`conflict`), a git timeout (`transient`).

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
  only in a plain terminal: an allow rule does not match past a `VAR=` prefix, and kb ignores
  it while `CLAUDECODE` is set, so an inherited value never names every agent alike).
  `--dry-run` and `--wait [SECONDS]` on every structural command (scene add, duplicate, move,
  remove and set; doc set, unset and merge; project set and unset; theme set; assets add;
  checkpoint; undo); `./kb plan <command ...>` is the same dry run.
- **Output.** Plain text for people. `--json` prints exactly one object on stdout:
  `{ "ok": true, "command": "scene add", ...payload }`. A streaming command
  (`events --follow`, `export`) prints one compact object per line, the final object
  last. Lists go under a plural key (`scenes`, `checkpoints`, `items`), never as a bare
  array. Keys are camelCase, times integer ms (`atMs`, `durationMs`), paths
  project-relative with `/`. Diagnostics go to stderr. A report that exits 1 (problems found)
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
  `gpu-stalled`, `gpu-wedged`, `throttled`, `too-large`, `flashes`. Each kind has a
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
  create | modify | trash, base }]`. Never hold the lock while waiting on the app or
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
.kb/captures/<stamp>[-<agent>]/ capture copies, newest 40 folders, 1 GB at most
```

- **Identity.** A caller is `{ name, session, agentId }` (`kblib/identity.py`). kb run from
  Bash knows `name` (`--agent`, default `session-<first 8 of CLAUDE_CODE_SESSION_ID>`, or
  `user` outside Claude Code) and `session`. Hooks know `session` and `agentId` (`main` outside a
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
  `editdoc.mutate` takes a per-edit lock (`kblib.lock.FileLock`), applies ops, validates and
  saves through the CLI's `edit save --base`, rebasing up to three times on a conflict, then
  exit 3; `repoint` mirrors `applyEditRepoint` and the follow-media duration sync on the raw
  sidecar with guarded `mutate_json` writes; `appcli` finds the CLI (`KB_APP_BIN`, the live
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
It never panics (a short buffer is counted and skipped) and costs about 4.3 ms per 4K RGBA
frame with both standards. Two feeders: `<exe> check flashes`, and a read-only tap in every
export's `push_frame` (after the bytes reach ffmpeg; a failure makes the report "flash check
unavailable", never a failed export). `finish_export` keeps the tap's verdict for
`export_flash_report`, and writes `<export file>.flashes.json` beside a film with flagged
moments (a clean re-export removes it); the Export button then shows a persistent warning
with the timecodes, and `kb export` gets the report in its answer.

- **Cells.** 64 along the long edge, the short edge in proportion; pixels sampled at a
  stride of about 16 per cell edge, linearised (sRGB for WCAG, 2.4 power for ITU, whose
  20 and 160 cd/m² of a 200 cd/m² display are the same 0.10 and 0.80), averaged per cell;
  relative luminance 0.2126R + 0.7152G + 0.0722B.
- **Transitions.** A per-cell swing tracker with a 0.02 hysteresis. A general transition
  changes ΔL by 0.10 or more with the darker side below 0.80; a red one has a saturated
  red end (R / (R + G + B) of 0.8 or more, linear), Δu'v' over 0.2 and, as an
  implementation choice that keeps near-black noise out, WCAG 2.0's (R - G - B) x 320
  changing by more than 20. Same-sign transitions within 66 ms group into one.
- **Area.** WCAG: the best 21 x 16 cell window (341 x 256 px at 1024 x 768, upright in
  portrait) at 25%; ITU: 25% of the frame. A compact flash over 12.5% of the frame
  therefore fails WCAG but passes ITU.
- **Verdict.** More than six opposing transitions in any 1 s (more than three flashes)
  fails; five or six, or more than six at 15 to 25% area, warns. Patterns come later.

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

## kb export

`./kb export` makes the finished film exactly as the app's Export button does, so Claude can
finish and check its own work. Code: `scripts/kblib/exporting.py`, `src-tauri/src/bridge_export.rs`,
`src/ui/useBridgeExport.ts`, `src/engine/bridgeExport.ts`.

`kb export [--aspect A] [--preset ID] [--fps 30|60] [--short-edge N] [--poster-frame on|off|app]
[--verify] [--headless] [--allow-flashes] [--timeout 3600] [--progress-every 10] [--json]`

- **Only the open project.** The editor must show this project; on the Welcome screen or another
  project the app answers `notOpen` or `wrongProject` (exit 2, kinds `not-open`, `wrong-project`).
  While the person is mid-edit (a pointer down, a text field focused outside the embedded
  terminal), the Export window is open, or an export, Verify, stills export or theme preview
  runs, it answers busy; kb retries for 30 s (never past `--timeout`), then exits 3 (`app-busy`).
- **Sync first.** Once accepted the editor stops playback, settles its own sidecar writes, and
  waits up to 20 s until the reload poll's baseline matches the disk and the reload it asked for
  is on stage. A failed last reload refuses (`stale` with `reloadFailed`, exit 1); so does a source
  whose hash no longer matches kb's `sources` (exit 3, rerun).
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
  the file and its record are kept) unless `--allow-flashes`; warnings print and exit 0.
- **The record.** Every finished export saves `_bridge/exports/<slug>/<sha16>.json` (schema under
  "Film checks and verify-export"; the newest 50 per project stay), so `kb verify-export` checks
  the file against what was asked for.
- Other answers: `invalid` (bad aspect, preset or rate; exit 2), `refused` (error-card scenes or a
  dropped LUT; exit 1), `gpuStalled` (exit 3), `gpuWedged` (exit 2, quit and reopen),
  `verifyMismatch` (exit 1), `acceptTimeout` and `interrupted` (exit 3). The envelope's `code` is
  the kb kind; `appCode` keeps the app's.

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
  (120 s) requests are deleted by any serving instance whoever they were for, and an
  instance that does not serve never touches `requests/`.
- **Responses** carry `servedBy: { pid, bundleId, build, appVersion, workspaceRoot }`
  (stamped by Rust on render-window answers, native answers and parse errors; a body that
  already has one keeps it). kb discards an answer whose root is not the project's
  (exit 2, `no-app`), fails fast (exit 2, `no-app`) when no live instance serves the
  project's root, naming the live ones, their roots and why each does not serve, and
  fails fast when the addressed pid exits while it waits.
- **Health.** The serving instance's heartbeat carries `health`: queue depth and order,
  the in-flight request, render-window liveness and beat age, recycles, the GPU state
  (`stalled`, `stalledUntilMs`, `wedged`), live WebGL contexts per window, and per-client
  usage. kb prints the queue position and an estimate while it waits.

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
  },
  "exportJob": null,
  "health": null
}
```

Two more fields locate the presets: `presetsDir` (holds `<slug>/`) and
`presetPreviewsDir` (holds `<slug>.jpg`); in dev the posters live under `src/assets`.
`playheadMs` is an integer and `openProject` is null on the Welcome screen. The editor
reports `lastLoad` after every load attempt (`set_last_load`); `warnings` includes
healed scene ids and dropped LUTs. `rootSource` is `settings`, `env`
(`KOOKABURRA_WORKSPACE_ROOT`) or `none`; `checkout` is `{ path, worktree }` for a debug
build, else null. `health` (serving instances only, `src-tauri/src/bridge_health.rs`)
and `exportJob` are null until their features fill them.

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
  "scene": "03-feature-checks", "at": 1.5, "aspect": "9:16",
  "frames": [{ "scene": "3", "at": 2.0 }], "sheet": true,
  "render": false,
  "refs": ["Menlo@400"], "listFamilies": false,
  "preset": "title", "position": 4, "name": "Highlights" }
```

`requestedAtMs` is optional (the file's age stands in), `scene` is an index or a file
stem, and an unparseable request gets an immediate error response from a serving
instance. A request without `kind` and with `version` below 2 is answered as
`version: 1`, so old kits keep working. The address fields are optional (old kits send
none); kb adds `workspaceRoot` to every request, `projectPath` when the request is about
its own project, `instancePid` unless the elected app is an older one, and `client` when
the caller names one. Unknown fields are ignored.

Every response carries `{ "version": 2, "id", "ok", "error"?, "busy"?, "needsTrust"?,
"servedBy" }` plus its kind's payload. `busy` applies to every kind except `fonts` while
exporting. kb retries a busy answer until its timeout, then exits 3 (`app-busy`); an
unclaimed or unanswered request exits 3 (`bridge-timeout`); `needsTrust` exits 2
(`needs-trust`). `kb capture` and `kb check` print `served by Kookaburra Cut ... (build,
pid, bundle id)` on stderr.

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
  (`clientPid`, unless `detach`) cancels the export; `bridge_export_reset`, which the main window
  calls on mount, fails an export left in the slot by a reload (`interrupted`) and stops its encode.
- `cancelExport` (`target`: the export's id, absent = the running one): `{ ok, cancelled, state:
  idle | cancelled | cancelling, target? }`. An export the editor has not taken yet is answered
  `cancelled` at once; a running one is told through `kookaburra://bridge-export-cancel` (the
  editor aborts), `ExportState::cancel()` stops the encode 15 s later if it is still running,
  and Rust answers `cancelled` for it 15 s after that.
- The heartbeat's `exportJob` is `{ id, origin: "bridge" | "button", stage, frame, total }`
  while an export runs (`id` is null for the app's own buttons), else null.

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
| `caps` | CLI version, app version, build, commands, `checks` (the `<exe> check` commands it serves), `autorun` (what a headless `kb export` may ask: actions, trust modes, poster, progress), doc versions, ffmpeg/ffprobe paths and filters, hardware video, tap styles/colours/sizes, mask styles, limits |
| `probe --project D --source R` (or `--file ABS`) | The app's probe (rotation-aware size, `vfr`, `editFps`, `nbFrames`) |
| `create --project D --source R [--name N] [--reuse \| --force]` | The editor's default document for that source; an existing doc is `exists` unless `--reuse` or `--force` (backs up to `.json.bak`) |
| `validate --project D (--name N \| --doc -)` | Parse, mask rules and a render dry run: `{ ok, hash, version, totalFrames, durationMs, fps, width, height, clips, taps, errors, warnings }` |
| `save --project D --name N --doc - --base H\|absent` | The only doc writer outside the editor: serde strictness, version stamping, base-hash check (`conflict` when stale) |
| `render --project D (--name N \| --doc -) [--out ABS] [--software] [--draft \| --scale F] [--expect-hash H]` | `--name` alone renders `assets/<name>-edited.mp4`; `--out` is a review render outside `assets/` (`--draft` = half size, ultrafast) |
| `check flashes --file ABS [--standard wcag\|itu\|both] [--fps N]` | `<exe> check`, same conventions: the flash detector over the film decoded at 1024 wide as rgb24 (`--fps` resamples; VFR files resample at their average rate): `{ ok, file, width, height, decode, report }`; exit 0 whenever the film was read, the verdict is `report.ok` |

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
`templates`, `exportPresets` (the Export modal's video rows: `aspects`, `favouredAspect`, `fps`,
`shortEdge`, `codec`, `container`, `loudnessTarget`, `lane`, `hardware`). Every entry has an
`id`; most have `label` and a one-line `summary`.

## Verification

- Python: `pnpm test:kit` (unittest; part of `pnpm test`); `pnpm test:kit:e2e` with
  `KB_E2E_APP_BIN=<kookaburra-cut binary>` runs `kb video` against the real CLI.
- Rust: `cargo test -- --ignored edit_` renders through the real sidecar (CLI end to
  end, core vs CLI byte-identical, barcode conformance, masks).
- Load safety and live edits touch the load and render paths: gate with
  `pnpm gate:merge` (both EQUAL), plus a workspace fixture holding an unsafe font and a
  broken scene to prove the project opens, `check` names both and export refuses.
