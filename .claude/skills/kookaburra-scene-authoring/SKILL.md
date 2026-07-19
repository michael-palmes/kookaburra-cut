---
name: kookaburra-scene-authoring
description: Authoring rules for Kookaburra Cut video scenes. Use when creating or editing a scene (.tsx in projects/<project>/scenes/), editing a scene document (scenes/*.json sidecar), adding a project, editing a theme (theme.json), or using toolkit primitives (Device, AnimatedHeadline, AnimatedCounter, VideoClip, ImageCard, SceneStage, DeviceMockup). Triggers on "new scene", "add a scene", "edit scene", "animate text", "build a project", "Kookaburra Cut scene", "device scene", "change the text", "scene document", "theme", "backdrop", "staging", "font".
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

1. **Default-export `defineScene`.** Every scene file is exactly one `export default defineScene({ id, durationMs, Scene })`. Never export a bare component — the engine discovers scenes by this contract and `/new-scene` registers them in `project.json`. *One exception:* the module named by `project.json`'s `persistent` field (the v3 hoisted-morph layer) default-exports a plain component — see "Persistent (morph) modules" in `REFERENCE.md`.
2. **Drive animation from the timeline, never the wall clock.** Read time with `useTimeline()` and compute values from `localMs` / `progress`. Never call `requestAnimationFrame`, `setTimeout`, `setInterval`, `Date.now()`, `performance.now()`, or `new Date()`. Instead: derive every animated value from `useTimeline()`, or register tweens on the global anime.js timeline.
3. **Render text only through toolkit primitives.** Use `AnimatedHeadline` / `AnimatedCounter` (troika SDF in WebGL). Never use HTML/DOM text, drei `<Html>`, or CSS for exported pixels — WebKit cannot deterministically capture the DOM. Need a new text behaviour? Add a toolkit primitive (see `/kookaburra-skill-creator` and `src/toolkit/text/`), don't inline DOM.
4. **Read colours, type and motion from tokens.** Get them via `useTheme()` (e.g. `theme.colors.accent`, `theme.motion.durations.base`). Never hard-code a hex colour or pixel duration in a scene. Themes are JSON documents (v8 · schema v2): bundled `kookaburra-*` ship inside the app, user themes at `~/Kookaburra Cut/themes/<slug>/theme.json` (`ws:<slug>` ids). Text faces are theme typography (`FontRef {family, weight}`); pick them on `AnimatedHeadline` via `face="headline"|"body"` and fills via `color="text"|"muted"|"accent"`, never raw hexes or font URLs. ANY Font Book family works as a `FontRef` (theme level) or via the sidecar's `<textKey>Font` (per element); the app pins the font file into the workspace on first use, so exports stay deterministic (see "Fonts" in `REFERENCE.md`). Always pass `textKey` (the `useSceneText` key) so the app's Edit-text panel can restyle the field; a non-default design fill belongs in `defaultColor` (not `color`, which pins the fill against app edits).
5. **Stage themed scenes with `<SceneStage>`.** Wrap the scene's content in `<SceneStage>` — it mounts the theme's lighting rig, backdrop (cyclorama floor / gradient / image, all exact-colour) and real key-light shadows when staged, and tells device/hero primitives to stand their bundled lit sets down (`useSceneStaged()`). Never hand-roll lights in a themed scene; a stage under a legacy theme (no `lighting` block) degrades to the primitives' own lighting. Per-scene looks come from the SIDECAR: `themeId` (full theme swap), `backdrop`, partial `lighting` — not from TSX edits.
6. **Lay out against `useFormat()`, not fixed numbers.** Read `aspect`, `frame` and `safe` from `useFormat()` so one scene serves 16:9 / 9:16 / 1:1. Branch on `format.aspect < 1` for portrait rather than writing per-format files. **`frame`/`safe` are measured at the content plane `z=0`** — content offset toward the camera projects LARGER (a caption at `z=1` sits 25% further from centre than its `y` suggests and can silently clip at frame edges). Keep laid-out content at `z=0`, and visually check exports in BOTH orientations: `Verify ×2` proves byte-stability, never framing.
7. **Reference assets by relative path inside the project.** Put media in `projects/<project>/assets/` and reference it relatively (e.g. `assets/feature.mp4`). Never use absolute paths or remote URLs — they are not portable or deterministic.
8. **Route machine-editable values through the scene document** (`scenes/<stem>.json` beside the TSX — see "Scene documents" in `REFERENCE.md`). ALL user-visible strings come from the sidecar text map via `useSceneText(key, fallback)` — that is what makes the app's "Edit text" work on your scene. Scaffolded device scenes read their devices from `useSceneDevices()`; edit the sidecar (text, device model/colour/media, motion, shadow, **camera track** — orbit keys/segments, see "Per-scene camera tracks" in `REFERENCE.md` — the v8 staging fields **`themeId`/`backdrop`/`lighting`**, the scene's display **`name`**, and the v11 fields **`background`** (camera-locked fill — colour/gradient/image, or a looping VIDEO since v12 · M4, scene-doc only) and **`textAnimation`** (whole-spec text motion — what the app's Text-motion panel writes; explicit TSX preset props override it unless `textAnimationForce: true` — the panel's Override — so prefer sidecar-driven motion on scaffolded scenes)), not the TSX, for those changes. The TSX stays the composition. When you change a `follow-media` scene's video source in the sidecar, also update the scene's `durationMs` in `project.json` to the new video's length (ffprobe). A scene without a sidecar is legal — it just shows no editing affordances.
9. **Preview, then verify.** Scrub in the app (`pnpm tauri dev`) or `/preview <project>`. Before declaring done, run the validation loop below and fix until clean.

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
```

## Validation loop

Run and fix until all pass:

```bash
pnpm build      # tsc --noEmit + vite build — typechecks scenes (projects/ is in tsconfig)
pnpm test       # vitest — determinism/format unit tests
pnpm lint       # biome check .
```

If a scene looks right in preview but differs on re-export, the cause is almost always a wall-clock read or an unpreloaded font/asset (see `docs/determinism.md`).

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

See `REFERENCE.md` for the full primitive + token catalogue, and `projects/showcase-tour/scenes/01-pacific-open.tsx` for a worked example.
