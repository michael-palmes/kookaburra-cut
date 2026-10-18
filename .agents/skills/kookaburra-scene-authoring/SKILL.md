---
name: kookaburra-scene-authoring
description: Edit Kookaburra Cut video projects safely and see the result. Use for ANY change in this project folder (project.json, scenes/*.tsx, scenes/*.json sidecars, assets/) and for any question about what is on screen. Triggers on new scene, edit scene, text, title, font, theme, colour, brand, background, shader, 3D background, device, phone, laptop, mockup, screen recording, screenshot stack, image, video, chart, graph, camera move, depth of field, motion blur, lighting, transition, timing, duration, music, beats, overlay, slide, panel, before/after, comparison, stills, PDF handout, presentation, product demo, launch video, release notes, export, render the film, flashes, "what's in this scene", "how does it look", "check the video".
when_to_use: Load before editing any project file, before answering what a scene shows (capture a frame and look), and when planning a video, deck or demo (then read DESIGN.md).
allowed-tools: Bash(./kb *), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/kb.py *)
---

# Kookaburra Cut projects

## Where you are

You are in ONE project folder (`~/Kookaburra Cut/<slug>`). There is no app source here and
nothing to build or run: the Kookaburra Cut app is the compiler, preview and exporter. It
watches this folder and reloads within about 2 s of a save. You edit files; the app renders.

- `project.json`: scene order, durations, transitions, theme, aspects, music.
- `scenes/<stem>.tsx`: composition (what is mounted where). `scenes/<stem>.json`: the
  sidecar, everything the app's inspector edits (copy, devices, camera, background...).
- `assets/`: media, referenced as `assets/<file>`.
- `edits/`: video edits, changed only through `./kb video` (load the kookaburra-video-editing skill).
- `.kb/`: kb's own state (lock, leases, notes, events, capture copies); yours to write is
  only your scratch folder `.kb/agents/<name>/`.
- Never touch `exports/`, `.kookaburra*` or `.claude/skills/` (app-owned).

Never work from a git worktree (a path containing `.claude/worktrees/`, or `./kb status`
opening with STOP). The app cannot see one, so previews, captures and exports all miss
your edits, and copying files across or switching the project's branch only spreads the
mess. Edit nothing; ask the user to start a new session directly in the project folder
with worktrees turned off. Projects need no git workflow of their own: `./kb checkpoint`
and `./kb undo` replace branches, commits and stashes.

Run every kb command from the project folder as `./kb <command>` (the app keeps that
script in place). Never put kb in a shell variable or alias: zsh does not split it. Exit 0
ok; 1 problems (fix what it names); 2 usage or environment (tell the user); 3 transient
(wait `retryAfterMs`, then rerun unchanged). `--json` on any command prints one object.

## The loop (every change)

1. `./kb status`: is the app running, which project and aspect it shows, last load
   result, leases and notes from other agents. Fix any listed load error first; if it
   opens with STOP (a git worktree), stop there and do what it says.
2. `./kb checkpoint "before <what>"` before edits that touch several files (git of
   project.json, scenes/ and edits/, not assets). `./kb undo` rolls back, and checkpoints
   first, so an undo can itself be undone.
3. Edit, in this order of preference:
   - Sidecar first: `./kb doc <scene> set <path> <value>` (validated, atomic).
   - New scene: `./kb scene add <stem> --preset <slug>` (`./kb presets` lists them). Presets
     carry tuned sidecars; never start from blank TSX when a preset fits.
   - TSX only for composition the sidecar cannot express, with Edit or Write.
   Change scene files with Edit, Write or `./kb doc`, never sed, Python or heredocs: the
   Bash check only runs after the command, and only knows earlier errors in files it names.
4. `./kb check --app` (the app's real compile, load, fonts and assets; `--render` also
   renders each scene once).
5. `./kb capture --scene <s> --at <seconds>` and Read the PNG. When layout changed, capture
   a landscape AND a portrait aspect (`--aspect 16:9`, `--aspect 9:16`).
   `--frames 1@0.5,2@1.2 --sheet` captures several frames plus one contact sheet.
6. Look hard (legibility, safe areas, overlap, colour), fix, repeat.
7. Before calling the work done: `./kb verify` (static check, the app's load and render,
   each scene's first and last frames, the handoffs between them, and the flashes of a
   fresh export) and Read the sheets it lists. Never end a turn with the project failing
   to load: `./kb status` must be clean, or `./kb undo` back to the checkpoint and say so.

When the user asks what a scene shows or how it looks: capture and look. Never infer
visuals from code. With no app running, kb checks are static only: ask the user to open
the app, and never claim the preview matches the files.

## Capturing

- One frame renders at the aspect's native size; several frames or a sheet at a 1280 px
  long edge. Keep that default; `--scale 0.5` or `--width N` makes them smaller.
- At most 16 frames a request, and one request at a time: never run captures in parallel
  Bash calls. Big batches are what stall the GPU.
- Exact colours: `--probe x,y[,x,y...]` returns the pixel values; never judge a hex by
  reading a PNG.
- kb copies every PNG into `.kb/captures/<time>-<agent>/` and prints those paths: Read them.
- `GPU stalled` (exit 3): the render window recycled itself; wait `retryAfterMs`, rerun
  with fewer or smaller frames. `GPU wedged` (exit 2): stop capturing and ask the user to
  quit and reopen Kookaburra Cut.

## Working with other agents

Several agents may edit one project at once. kb keeps them apart when each one says who
it is:

- Pass `--agent <name>` to every kb command (one short name per agent, such as `alpha`).
- `./kb lease <scene> --agent <name>` before editing a scene. Edit and Write to a scene
  leased to someone else are denied: leave them a `./kb note "..." --scene <scene>`
  instead. `./kb leases` and `./kb notes` show the state.
- `./kb plan <command ...>` before a structural change (scene add, move, remove, set, doc,
  project, undo): it lists the writes and refusals and writes nothing.
- `./kb checkpoint --scene <scene>` and `./kb undo --scene <scene>` keep history to your own
  scenes; a plain undo refuses when it would revert another agent's files.
- Scratch files go in `.kb/agents/<name>/`.
- The lead agent runs `./kb events --follow` as a Claude Code Monitor (each line is one
  event: leases, notes, loads, exports, GPU stalls). It ends after 29 minutes with a
  `follow.end` cursor; re-arm it with `./kb events --follow --since <cursor>`.

## Hard rules

- Scenes import ONLY from `@kookaburra/toolkit`. No `react`, `three`, drei, anime.js,
  relative files or other scenes. React hooks (`useMemo`, `useState`, `useEffect`,
  `useRef`) are unavailable; r3f intrinsics (`<group>`, `<mesh>`, geometries,
  materials, lights) work.
- One `export default defineScene({ id, durationMs, Scene })` per file, with a literal
  `id` unique in the project.
- Motion is a pure function of `useTimeline().localMs` (scene-local ms), shaped with the
  toolkit's `ramp`, `ease`, `sampleKeys` and `stampScale`. `progress` is
  PROJECT-wide; never use it for scene motion. No `Date`, `performance.now`,
  `requestAnimationFrame`, timers or `Math.random` (use `createSeededRandom`).
- Text only through toolkit primitives (AnimatedHeadline, TitleBlock, BrandLockup,
  AnimatedCounter, ExtrudedText). Never DOM, HTML or drei `Html`.
- Colours, type and motion from `useTheme()` tokens; per-element exceptions go in the
  sidecar `textStyle`, never hard-coded in TSX.
- Lay out with `useFormat()`: `frame` and `safe` are world units at z = 0; branch on
  `aspect < 1` for portrait.
- Assets live in `assets/` (copy in with `./kb assets add`); exact case; images png, jpg,
  jpeg, webp; videos mp4, mov, m4v, webm.
- Fonts: bundled families are always safe (`./kb fonts safe`). Any other Font Book family
  needs `./kb fonts check "Family@weight"` first; a face that fails silently falls back.
- `./kb doc` paths walk objects and array indexes (`devices.0.colour`); a write that
  would add errors is refused, so read the message instead of forcing it.
- Never re-encode, trim or overwrite media with ffmpeg: scenes and edits point at the
  file. Edited versions come from `./kb video render` (`assets/<name>-edited.mp4`).

## Live edits

The app being open is fine and expected. Every save reloads within about 2 s. A scene
that fails to compile or load becomes an error card ("This scene can't load", the file
and the first error line) while the rest of the project opens; `./kb status` names it.
Export, stills and verify refuse while any card exists. If a reload fails outright the
app keeps the last good project under a danger banner. Fix the file and the next save
recovers. Never tell the user to close or reopen the app as a fix, unless kb reports
GPU wedged. If kb reports the project needs trust (a project not open in the app, edited
since the user last allowed it), ask the user to open it once in the app.

## Capability map

| To change | Edit | Read | Ids |
| --- | --- | --- | --- |
| Words, titles, bullets | `text` or `managedText` | reference/text.md | |
| One line's font, size, colour, nudge | `textStyle.<key>Font/Size/Color/OffsetY` | reference/text.md | `./kb fonts safe` |
| How text arrives, text style | `textAnimation`, `textLook` | reference/text.md | `textMotion`, `textLooks` |
| Whole look | `themeId` (project or scene) | reference/project.md | `themes` |
| Background, floor | `background`, `backdrop` | reference/backgrounds.md | `backgrounds.shaders`, `backgrounds.scene3d` |
| Lighting, exposure | `lighting`; project `render` | reference/lighting.md | `lighting.presets` |
| Phones, laptops, tablets | `devices`, `deviceLayout`, `deviceTrack` | reference/devices.md | `devices`, `deviceShadows` |
| Before/after wipe | `compare` | reference/devices.md | `compare.presets` |
| Camera moves, depth of field, motion blur | `camera`, `cameraRig`, key `dof`, `motionBlur` | reference/camera.md | `camera.presets`, `camera.motionBlur`, `eases` |
| Images, videos, screenshot stacks | `media`, `layeredScreenshot`, video `background` | reference/media.md | `mediaMotion` |
| Tiled split field, tap pulses on a scene or screen | `mosaic`, `taps` | reference/media.md | |
| Trim, speed, freeze, taps, blur inside a video | `./kb video` | kookaburra-video-editing skill | |
| Charts and numbers | `chart` | reference/charts.md | `charts.styles`, `charts.animations` |
| Slide panel, overlay, stills, PDF | `frame`, `stills` | reference/sidecar.md | `chipIcons` |
| Order, duration, transitions, music | `./kb scene`, `project.json` | reference/project.md | `transitions` |
| Sync to the soundtrack | camera keys, text timing | reference/beats.md | |
| New scene, custom 3D composition | `./kb scene add`, TSX | reference/scenes.md | `presets`, `toolkit.exports` |
| The finished film, flash safety | `./kb export`, `./kb verify-export`, `./kb check film` | reference/export.md | `exportPresets` |
| Constants shared by scenes (palette, timings) | `project.json` `shared`, `useProjectShared` | reference/project.md | |

Ids: `./kb catalog <family>` (nested families are dotted, such as `backgrounds.shaders`
or `lighting.presets`; `--json` prints full entries; `--search <word>` finds ids).

## Routing

DESIGN.md before planning a video, deck, demo or launch. What happens inside a recording
(cuts, speed, freezes, taps, privacy masks, fitting it to a scene or a beat): load the
kookaburra-video-editing skill. Something behaves oddly (stale preview, a fade word by
word, colours off, a stall): reference/gotchas.md first. Topic files in reference/:
project (project.json, themes, transitions, music, effects), sidecar (every key,
overlays, stills, keyed tracks), scenes (TSX), text (copy, fonts, motion, looks),
devices (devices, layouts, objects, before/after), camera, backgrounds, lighting, media,
charts, beats, export (exports, film checks, the flash gate), gotchas (symptom, cause,
fix). Worked examples: `./kb presets show <slug>`, and template scenes under the app's
Resources folder (`./kb status` prints it): `projects/<template>/scenes/`.

## kb cheat sheet

| Command | Does |
| --- | --- |
| `./kb status`, `./kb context` | App, open project, aspect, last load errors, leases, notes; session summary |
| `./kb scenes` | Roster: index, stem, name, duration, transition, text |
| `./kb check [--app] [--render] [files]` | Static checks; `--app` real compile and load |
| `./kb capture [--scene S] [--at T] [--aspect A] [--frames S@T,...] [--sheet] [--scale F] [--probe X,Y]` | Rendered PNGs to Read |
| `./kb verify [--scene S] [--aspect A] [--no-render] [--film]` | Every check before calling the work done |
| `./kb scene add <name> --preset P [--after S \| --at N] [--duration MS] [--name N]` | Insert a preset scene, numbered stem (or `--copy S`); default position is the end |
| `./kb scene duplicate S`, `move S --to N`, `remove S`, `set S --duration MS --transition TYPE:MS\|none --ease E` | Manifest-safe scene operations (indexes 0-based) |
| `./kb doc S get [path]`, `set path value [--string]`, `unset path`, `merge JSON` | Sidecar edits; values parse as JSON, else string; merge is a JSON merge patch |
| `./kb project get [path]`, `./kb project set path value` | project.json fields other than scenes |
| `./kb theme list`, `show [id]`, `set path value` | Themes and tokens |
| `./kb fonts safe`, `check REF...`, `list` | Font safety |
| `./kb presets [list \| show SLUG]` | Scene presets with preview images |
| `./kb catalog [FAMILY] [--search Q]` | Ids and enums from the app's registries |
| `./kb assets list`, `add PATH [--name N]`, `probe ASSET` | Media in, never overwriting; ffprobe |
| `./kb plan <command ...>` | What a structural command would write or refuse; writes nothing |
| `./kb checkpoint [MSG] [--scene S]`, `history`, `undo [REV] [--scene S]`, `diff` | Git safety net |
| `./kb lease S`, `leases`, `note TEXT [--scene S]`, `notes`, `events [--follow]` | Several agents: who edits what, messages, the event feed |
| `./kb export [--aspect A] [--preset ID]`, `./kb verify-export FILE`, `./kb check film` | The finished film and its checks (reference/export.md) |
| `./kb beats ...`, `./kb chart ...` | Soundtrack beats; chart data and keys |
| `./kb video ...` | Edit recordings: cuts, speed, taps, masks, fit (kookaburra-video-editing skill) |
| `./kb debug contexts` | The app's WebGL contexts, when captures keep stalling |
