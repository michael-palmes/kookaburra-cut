---
name: kookaburra-video-editing
description: Edits the videos inside a Kookaburra Cut project as the app's own video-editor documents, so the user can open every change in the editor. Covers trim, cut, split, reorder, speed up or slow down, freeze and hold frames, stills, tap highlights, blur, pixelate or solid privacy masks, removing dead time, fitting to an exact length or a scene, landing a moment on a beat, and frame grabs and contact sheets to check the result. Use when asked to trim, cut, shorten, "make this video shorter", "cut the dead time", remove idle, pauses or loading, speed up, slow down, retime, "fit to 8 seconds", freeze frame, "hold the last frame", edit a screen recording or simulator recording, add a tap highlight, blur, redact, "hide the email", add a privacy mask, pixelate, "land on the beat", or use the video editor.
when_to_use: Load before changing what a video shows, when or how fast (anything under edits/ or an assets/*-edited.mp4). Scene layout, devices and which scene shows a video stay with kookaburra-scene-authoring.
allowed-tools: Bash(./kb video *), Bash(python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py video *)
---

# Editing videos in a Kookaburra Cut project

## Where you are

The project's videos are edited by the app's own video editor. You drive the same editor from the
terminal with `./kb video`, so every change is an edit document the user can open, tweak and undo:

- `edits/<name>.json`: the edit (clips, speeds, freezes, taps, masks). Only `./kb video` writes it.
- `assets/<name>-edited.mp4`: its render, made by the app's own renderer (`./kb video render`).
- Sources in `assets/` never change. Cuts, speeds and masks live in the edit, not the file.
- `./kb video open <name>` opens the edit in the app's editor window (the app must be running).

Run `./kb video X` from the project folder: the same `./kb` as the scene skill (`./kb status`,
`./kb capture`, `./kb undo`), never through a shell variable or alias.
Editing and rendering work with the app closed; opening the editor and live refresh need it open.

## The clocks

| Clock | What it counts | Seen in |
| --- | --- | --- |
| Source ms | Position in the recording file | `--src [SID@]T`, analysis intervals, taps, masks |
| Timeline | Position in the edited video | `--at T`, frames, sheets, fit targets |
| Scene-local | Ms into a scene; the video starts at its slot's `startMs` | `./kb beats --scene`, `--scene-at` |
| Capture seconds | Seconds into a scene | `./kb capture --scene S --at T` |

Convert with `./kb video map NAME (--at T | --src S | --tap ID | --scene-at T --scene S)`, never by
hand: cuts, speeds and freezes bend every mapping. Bare numbers are seconds; `2500ms`, `1:02.5`,
`f150` (output frame), `end` and `end-2s` also work.

## The loop

1. `./kb status`, then `./kb video list` (edits, lengths, render state, which scenes play them). New
   recording: `./kb video new assets/<file>` (or `--for <scene>:<slot>` to edit what a slot plays).
2. Look first: `./kb video sheet NAME` and Read the PNG. `./kb video analyse NAME` for dead time.
3. Plan with `--dry-run` (every mutation takes it) and read the printed timeline.
4. Apply. Cleanup, fit, align, cut, keep and remove checkpoint first; `./kb undo` restores the doc.
5. Review: `./kb video sheet NAME --seams` (or `--changes`), `./kb video frames NAME --at T,...`;
   Read every PNG. Fix and repeat.
6. Render: `./kb video render NAME` (Bash `run_in_background` when it is long; `--draft` is a quick
   half-size review copy).
7. Use: `./kb video render NAME --use --scene S [--slot P]`, or `./kb video use NAME --scene S` after
   a render. Follow-media scenes resync their length.
8. `./kb check --app`, then `./kb capture --scene S --frames S@T,... --sheet` and Read the sheet
   (`./kb verify --scene S` runs every check before you call it done).
9. Report in plain words: the length before and after, what changed on screen, that `./kb undo`
   rolls the edit back and `./kb video open NAME` shows it in the editor.

## What to run for what

| The user wants | Run |
| --- | --- |
| Dead time gone, "make it shorter" | `./kb video cleanup NAME --dry-run`, Read the changes sheet, then `./kb video cleanup NAME` |
| An exact length, or the scene's length | `./kb video fit NAME --to 8`, or `--scene 3 [--slot device]` |
| A tap or moment on a beat | `./kb video align NAME --tap t1 --beat 4 --scene 3` |
| A range gone | `./kb video cut NAME 3-5.5` (timeline) or `--src s1:30-42` (source, every copy) |
| A shorter start or end | `./kb video trim NAME first --head 1.2`, `./kb video trim NAME last --tail 2` |
| Faster or slower | `./kb video speed NAME c2 2`, `./kb video speed NAME --range 4-9 1.5` |
| A freeze, a held last frame | `./kb video freeze NAME --at 3 --hold 1.5`, `./kb video freeze NAME --at end --hold 2` |
| Recordings joined, a title still | `./kb video append NAME assets/b.mov`, `./kb video insert NAME assets/logo.png --at 0 --hold 1.5` |
| Tap highlights | `./kb video taps suggest NAME`, check a gridded frame, then `./kb video tap add NAME --src s1@T --pos X,Y` |
| Something hidden (email, name, token) | `./kb video mask add NAME --at T --rect X,Y,W,H --until T2 --style blur`, then `./kb video frames NAME --mask m1` |
| "What does it show?" | `./kb video sheet NAME`, `./kb video frames NAME --at T --grid` |

## Hard rules

- Never write `edits/*.json` with Edit or Write (the hook blocks it): the app's renderer is its
  only writer, hash-checked against an open editor. Use the commands or `./kb video apply NAME plan.json`.
- Never run ffmpeg into `assets/`, and never re-encode or overwrite a source: scenes and edits
  point at it. `./kb video render` makes `assets/<name>-edited.mp4`; review copies stay in `_bridge`.
- Plan JSON keys ending in `Ms` are integer milliseconds. Clips need 100 ms of source and holds
  100 ms; anything shorter is refused, so cut a little more or a little less.
- Render before a scene uses an edit. `./kb video render NAME --use ...` does both in order; never
  leave a scene pointing at a render that does not exist.
- Judge by looking, not by the numbers: Read a sheet before and after every change. Analysis
  mistakes reading time for idle; `--keep A-B` protects a moment, `--skip iN` an interval.
- Masks: check them on the draft render with `./kb video frames NAME --mask m1` (span edges, every
  key, the zoom), then Read `./kb video sheet NAME --count 24` for the same detail appearing elsewhere.
- Renders are silent. The project soundtrack is the only audio; never promise recorded sound.
- Prefer changing the edit over a scene's duration: transitions, beats and later scenes hang off
  it. A follow-media scene's length IS its video's length.
- Cleanup applies and reports. Default normal; use `--gentle` when the user mentions reading,
  tutorials or "keep it natural", `--aggressive` only when asked for tight.
- Tap candidates are guesses. Add one only after Reading a gridded frame at its moment
  (`./kb video frames NAME --src s1@T --grid`) and seeing the touch; cleanup never adds taps.
- Never end a turn with `./kb video validate NAME` failing or a scene pointing at a missing render.
- In a git worktree (`./kb status` opens with STOP) edit nothing and say so.
- With other agents: pass `--agent <name>` to every kb command. A plain `./kb undo` refuses when
  it would revert another agent's files; leave a `./kb note` rather than editing a recording a
  scene leased to someone else plays.
- Recording notes and memory drift from the footage: take times from `./kb video analyse` and
  `./kb video frames`, never from notes.

## Defaults

- New edit: one clip of the whole source; output size and fps from the source, 60 fps for
  variable-frame-rate (Simulator) recordings.
- Cleanup: normal strength; keeps 400 ms before the first action, 1 s after the last, 1 s of
  reading after each screen change; loading sped to at most 4x.
- Fit: auto strategy, ending where the outgoing transition starts (`--end scene-end` to run on).
- Tap: target style, blue, size 1.25, visible 550 ms; aligning a tap lands it 83 ms early.
- Mask: solid black, 3 s of timeline from where it starts; strength 0.5 for blur and pixelate.
- Frames of an edit come from a draft render (taps and masks drawn); `--predict` is instant but
  shows the source frame without them.

## Cheat sheet

| Command | Does |
| --- | --- |
| `list`, `show NAME [--at T]`, `validate NAME`, `usages [NAME]`, `caps` | Inspect |
| `map NAME (--at T \| --src S \| --tap ID \| --scene-at T)` | Convert between clocks |
| `new SRC [--name N] [--for S:SLOT]`, `reset NAME --yes` | Start or rebuild an edit |
| `split --at T`, `cut A-B`, `keep A-B[@Nx]`, `trim`, `speed`, `freeze`, `hold`, `remove`, `move`, `insert`, `append` | Clip edits |
| `tap add\|move\|retime\|remove\|style\|list` | Tap highlights |
| `mask add\|key\|hold\|unkey\|offset\|set\|span\|remove\|list` | Privacy masks |
| `apply NAME PLAN\|@file\|-` | A JSON plan, all or nothing |
| `analyse NAME\|SRC [--range A-B]` | Black, lead-in/out, static, blink, loading, typing, screen changes, tap candidates |
| `cleanup NAME [--gentle\|--aggressive] [--keep A-B] [--skip iN] [--dry-run]` | Remove dead time |
| `fit NAME (--to T \| --scene S) [--anchor SRC@T] [--strategy auto\|trim\|speed\|hold]` | Exact length |
| `align NAME (--src T \| --tap ID) (--at T \| --beat N \| --moment N \| --scene-at T)` | Land a moment |
| `frames NAME\|SRC (--at \| --src \| --tap \| --mask) [--grid] [--zoom x,y,w,h] [--overlay taps,masks]` | PNGs to Read |
| `sheet NAME\|SRC [--count N \| --every T \| --seams \| --compare \| --changes]` | Contact sheet to Read |
| `taps suggest NAME` | Likely taps, with the commands to check and add each |
| `render NAME [--use --scene S --slot P] [--draft]`, `use NAME --scene S`, `durations`, `open NAME` | Output |

Every command takes `--json`. Exit 0 ok, 1 a problem (read the message), 2 environment (app CLI
missing or too old, app closed for `open`, a worktree), 3 transient (another kb command holds the
edit, or the app is busy: wait `retryAfterMs` and rerun).

## Routing

- reference/edit-doc.md: the document, ids, limits, clock formulas, frame grid, letterbox, tap
  and mask geometry, stills, naming.
- reference/cleanup.md: what cleanup cuts and never cuts, the strength table, reading the report.
- reference/fit.md: exact lengths, strategies, anchors, align and beats, scene slots.
- reference/review.md: frames, grids, zooms, overlays, sheets, seam diffs, where files go.
- reference/recipes.md: worked requests from start to finish.
- Scenes, devices, captures and beats: the kookaburra-scene-authoring skill.
