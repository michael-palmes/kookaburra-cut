---
name: kookaburra-scene-authoring
description: Authoring rules for Kookaburra Cut video scenes. Use when creating or editing a scene (.tsx in projects/<project>/scenes/), editing a scene document (scenes/*.json sidecar), adding a project, editing a theme (theme.json), or using toolkit primitives (Device, AnimatedHeadline, AnimatedCounter, VideoClip, ImageCard, LayeredScreenshot, SceneStage, DeviceMockup). Also use whenever the user refers to what is ON SCREEN or IN A SCENE ("what's in this scene", "what does it look like", "can you see", "check the video", "why does it look wrong"), or you need to see a rendered frame: the capture script under "Seeing your work" is how you look. Also use when animation should follow the project's soundtrack: beat data access and beat-matched authoring live in BEATS.md beside this file. Triggers on "new scene", "add a scene", "edit scene", "animate text", "build a project", "Kookaburra Cut scene", "device scene", "change the text", "scene document", "theme", "backdrop", "staging", "font", "screenshot stack", "layered screenshot", "stack of screens", "add media", "app screenshots", "overlay", "cutout", "panel", "chip", "slide", "slide deck", "slides", "screenshot", "capture", "what's on screen", "look at the scene", "beat", "beats", "sync to music", "cut on the beat", "match the music", "soundtrack", "bpm", "beat markers".
---

# kookaburra-scene-authoring

How to author scenes for Kookaburra Cut so they render identically in preview and in deterministic export.

## When to use

- Creating a scene file under `projects/<project>/scenes/*.tsx`
- Editing an existing scene or its animations
- Adding or wiring a project (`project.json`)
- Reaching for any `@kookaburra/toolkit` primitive

## Where you are

You are normally running inside ONE workspace project folder (`~/Kookaburra Cut/<project>`),
opened from the app's embedded terminal. The app the user runs is PACKAGED: Kookaburra Cut's
source tree is not on their machine, and `src/`, `docs/` or repo paths mentioned here are
background for you, not places to read. Stay inside the current project folder; do not
search the workspace, home folder or wider disk unless the user gives you a specific path.

## The determinism contract (why these rules exist)

Export steps a manual clock frame-by-frame and reads pixels off ONE WebGL canvas. Frame N must be a pure function of the timeline value `t`. Anything that reads wall-clock time, animates the DOM, or renders asynchronously breaks byte-identical re-export. Every rule below traces to that.

## Instructions

1. **Default-export `defineScene`.** Every scene file is exactly one `export default defineScene({ id, durationMs, Scene })`. Never export a bare component — the engine discovers scenes by this contract and `/new-scene` registers them in `project.json`. *One exception:* the module named by `project.json`'s `persistent` field (the v3 hoisted-morph layer) default-exports a plain component — see "Persistent (morph) modules" in `REFERENCE.md`. **Scene entries are 1:1 with files:** never register the same scene file (or sidecar) in `project.json`'s `scenes` twice unless the user explicitly asks; two entries sharing a file load one sidecar into both scenes (titles and subtitles collide) and the loader refuses the manifest. To repeat a scene, copy the TSX and sidecar to a fresh stem first.
2. **Drive animation from the timeline, never the wall clock.** Read time with `useTimeline()` and compute values from `localMs` / `progress`. Never call `requestAnimationFrame`, `setTimeout`, `setInterval`, `Date.now()`, `performance.now()`, or `new Date()`. Instead: derive every animated value from `useTimeline()`, or register tweens on the global anime.js timeline.
3. **Render text only through toolkit primitives.** Use `AnimatedHeadline` / `AnimatedCounter` (troika SDF in WebGL). Never use HTML/DOM text, drei `<Html>`, or CSS for exported pixels — WebKit cannot deterministically capture the DOM. The available primitives are fixed by this app version: work within `AnimatedHeadline`/`AnimatedCounter` rather than inventing a new text path.
4. **Read colours, type and motion from tokens.** Get them via `useTheme()` (e.g. `theme.colors.accent`, `theme.motion.durations.base`). Never hard-code a hex colour or pixel duration in a scene. Themes are JSON documents (v8 · schema v2): bundled `kookaburra-*` ship inside the app, user themes at `~/Kookaburra Cut/themes/<slug>/theme.json` (`ws:<slug>` ids). Text faces are theme typography (`FontRef {family, weight}`); pick them on `AnimatedHeadline` via `face="headline"|"body"` and fills via `color="text"|"muted"|"accent"`, never raw hexes or font URLs. ANY Font Book family works as a `FontRef` (theme level) or via the sidecar's `<textKey>Font` (per element); the app pins the font file into the workspace on first use, so exports stay deterministic (see "Fonts" in `REFERENCE.md`). Always pass `textKey` (the `useSceneText` key) so the app's Edit-text panel can restyle the field; a non-default design fill belongs in `defaultColor` (not `color`, which pins the fill against app edits).
5. **Stage themed scenes with `<SceneStage>`.** Wrap the scene's content in `<SceneStage>` — it mounts the theme's lighting rig, backdrop (cyclorama floor / gradient / image, all exact-colour) and real key-light shadows when staged, and tells device/hero primitives to stand their bundled lit sets down (`useSceneStaged()`). Never hand-roll lights in a themed scene; a stage under a legacy theme (no `lighting` block) degrades to the primitives' own lighting. Per-scene looks come from the SIDECAR: `themeId` (full theme swap), `backdrop`, partial `lighting` — not from TSX edits.
6. **Lay out against `useFormat()`, not fixed numbers.** Read `aspect`, `frame` and `safe` from `useFormat()` so one scene serves 16:9 / 9:16 / 1:1. Branch on `format.aspect < 1` for portrait rather than writing per-format files. **`frame`/`safe` are measured at the content plane `z=0`** — content offset toward the camera projects LARGER (a caption at `z=1` sits 25% further from centre than its `y` suggests and can silently clip at frame edges). Keep laid-out content at `z=0`, and visually check exports in BOTH orientations: `Verify ×2` proves byte-stability, never framing.
7. **Reference assets by relative path inside the project.** Put media in `projects/<project>/assets/` and reference it relatively (e.g. `assets/feature.mp4`). Never use absolute paths or remote URLs — they are not portable or deterministic. To ADD media the user points at elsewhere, COPY the file into `assets/` first (the app's own pickers do the same, including its Global-screenshots tab). Before referencing any asset, CHECK it: the file exists at the exact path (case-sensitive), its extension is supported (images png/jpg/jpeg/webp/gif; videos mp4/mov/m4v/webm), and for videos `ffprobe` it (duration for `follow-media`, width/height sanity). New projects ship starter media: `assets/sample-screenshot-1..4.jpg` and `assets/app-icon.png` — use them for placeholders instead of generating anything. Before deleting or renaming an asset, grep every `scenes/*.json` and `scenes/*.tsx` for its path; a dangling reference degrades to a missing card/screen with only a console note.
8. **Route machine-editable values through the scene document** (`scenes/<stem>.json` beside the TSX — see "Scene documents" in `REFERENCE.md`). ALL user-visible strings come from the sidecar text map via `useSceneText(key, fallback)` — that is what makes the app's "Edit text" work on your scene. Scaffolded device scenes read their devices from `useSceneDevices()`; edit the sidecar (text, device model/colour/media, motion, shadow, **camera track** — orbit keys/segments, see "Per-scene camera tracks" in `REFERENCE.md` — the v8 staging fields **`themeId`/`backdrop`/`lighting`**, the scene's display **`name`**, and the v11 fields **`background`** (camera-locked fill — colour/gradient/image, or a looping VIDEO since v12 · M4, scene-doc only) and **`textAnimation`** (whole-spec text motion — what the app's Text-motion panel writes; explicit TSX preset props override it unless `textAnimationForce: true` — the panel's Override — so prefer sidecar-driven motion on scaffolded scenes), and the **`layeredScreenshot`** block + **`animatedTrack`** (the 3D screenshot stack and which ONE keyed track animates the scene — see "Layered screenshot" in `REFERENCE.md` for the schema, the terminal editing recipes and full inspector parity), and the **`frame`** block (the scene overlay: a camera-locked panel with a shaped cutout the scene renders through — "overlay", "cutout" or "slide" in user speak; see "Scene overlays (the frame block)" in `REFERENCE.md`)), not the TSX, for those changes. The TSX stays the composition. When you change a `follow-media` scene's video source in the sidecar, also update the scene's `durationMs` in `project.json` to the new video's length (ffprobe). A scene without a sidecar is legal — it just shows no editing affordances.
9. **Preview, then look.** The app the user has open IS the preview: it live-reloads within about a second of any `.tsx` or sidecar save. Before declaring done, run the validation loop below, then capture a frame (see "Seeing your work") and look at it. The same applies in reverse: when the user asks what a scene shows, how it looks, or whether something is visible, CAPTURE A FRAME AND LOOK rather than inferring from the files.

## Helper scripts

Bundled beside this skill (`.claude/skills/kookaburra-scene-authoring/scripts/`, python3),
run from the project folder; prefer these over opening files one by one:

```bash
python3 .claude/skills/kookaburra-scene-authoring/scripts/inspect.py
    # project summary: scenes, durations, sidecar text and overrides in one shot
python3 .claude/skills/kookaburra-scene-authoring/scripts/sidecar.py 01-hero set text.title "Ship faster"
    # get / set / unset any sidecar value by dotted path (values parsed as JSON, else string)
python3 .claude/skills/kookaburra-scene-authoring/scripts/theme.py show
    # resolved theme + tokens; `set colors.accent "#ff5a36"` edits workspace themes
python3 .claude/skills/kookaburra-scene-authoring/scripts/capture.py --scene 2 --at 1.5
    # a rendered frame from the RUNNING app (see "Seeing your work")
python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py --scene 2
    # soundtrack beat times in scene-local ms (see "Matching the soundtrack")
```

## Seeing your work

The app cannot show you pixels directly; capture a frame and Read the PNG:

```bash
python3 .claude/skills/kookaburra-scene-authoring/scripts/capture.py
    # current playhead of this project, at the app's current aspect
python3 .claude/skills/kookaburra-scene-authoring/scripts/capture.py --scene 01-hero --at 1.5
```

This asks the RUNNING Kookaburra Cut app for a deterministic frame (the export
path, so what you see is what exports) and prints the PNG path. It captures the
project currently open in the app window; if that is a different project than
this folder, ask the user to open this one first. If the app is exporting, the
script retries briefly on its own.

## Matching the soundtrack

When a project has a soundtrack and the ask involves beats, rhythm or "sync to
the music", read `BEATS.md` beside this file BEFORE authoring: it covers getting
beat times via `scripts/beats.py` (bpm, key moments and the beat grid in
scene-local ms), hard cuts on beats (`"jump"` camera segments) versus smooth
moves that land on beats, spacing rules, and the `audio.markers` override block.

## Validation loop

There is no build tool in this folder; the app compiles workspace scenes itself.

1. Save the file. The app reloads within about a second.
2. If the stage shows the red error panel ("This project can't load right now"),
   that text is the exact compile error with file and line; fix it and the panel
   clears on the next save.
3. Once clean, capture a frame (see "Seeing your work") and look at it before
   declaring the change done.

If a scene looks right in preview but differs on re-export, the cause is almost always a wall-clock read or an unpreloaded font/asset.

## Example

```tsx
import { defineScene, AnimatedHeadline, SceneStage, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "hello",
  durationMs: 3000,
  Scene() {
    const title = useSceneText("title", "Hello");
    return (
      <SceneStage>
        <AnimatedHeadline text={title} textKey="title" from={0} to={600} position={[0, 0, 0]} />
      </SceneStage>
    );
  },
});
```

See `REFERENCE.md` for the full primitive + token catalogue; this project's own `scenes/` folder has real worked examples.
