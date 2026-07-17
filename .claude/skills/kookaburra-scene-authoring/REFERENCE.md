# Kookaburra Cut toolkit reference

Full catalogue of `@kookaburra/toolkit` primitives, hooks and design tokens. Loaded on demand by the `kookaburra-scene-authoring` skill.

## Table of contents

- [Scene registration](#scene-registration)
- [Scene documents (sidecars)](#scene-documents-sidecars)
- [Per-scene camera tracks](#per-scene-camera-tracks-v7--m5)
- [Themes & staging](#themes--staging-v8)
- [Hooks](#hooks)
- [Text primitives](#text-primitives)
- [Group lockups (AnimatedGroup)](#group-lockups-animatedgroup-v11--m5)
- [Media + device primitives](#media--device-primitives)
- [Transition helpers](#transition-helpers)
- [Design tokens](#design-tokens)
- [Status by phase](#status-by-phase)

## Scene registration

```ts
defineScene(cfg: { id: string; durationMs: number; Scene: React.ComponentType }): SceneModule
```

Every scene file: `export default defineScene({ ... })`.

## Scene documents (sidecars)

**This is the authoritative schema section (v1).** Every scene MAY have a sidecar
`scenes/<stem>.json` beside its TSX (`scenes/03-hero.tsx` → `scenes/03-hero.json` — keyed
by FILE stem, never by the `defineScene` id). The sidecar holds everything
machine-editable; the TSX stays the composition. The app UI and Claude both edit sidecars;
in-app writes are atomic + version-guarded (`write_scene_doc`), and any on-disk edit
live-reloads the preview via the fingerprint poll. A scene without a sidecar renders
normally and simply shows no editing affordances.

```jsonc
{
  "version": 1,                              // REQUIRED; this build understands 1
  "name": "Hero demo",                       // display name — pickers, the inspector header and the
                                             // playback-bar labels show it; absent = the scene's largest
                                             // mounted text, else the file stem (v13)
  "duration": { "mode": "follow-media", "sourceDeviceId": "d1" },  // or { "mode": "manual" }
  "text": {                                  // EVERY user-visible string (rule 7); values may
    "headline": "Ship faster"                // carry \n (real line breaks); title scenes use
  },                                         // the reserved "title"/"subtitle" pair (TitleBlock)
  "textLayout": { "align": "center" },       // left|center|right — consumed by TitleBlock;
                                             // inert on scenes that position text by hand
  "textStyle": { "titleColor": "#e8f0ff", "subtitleColor": "#9aa4b5" },
                                             // raw-hex fills keyed <textKey>Color, the one
                                             // exception to "colours stay tokens": consumed by any
                                             // text primitive given the matching textKey (TitleBlock
                                             // owns title/subtitle); inert keys are harmless
                                             // (the textLayout pattern)
  "devices": [                               // array from day one — UI edits [0]
    {
      "id": "d1",                            // stable per-scene id
      "model": "iphone-15-pro",              // catalog id, e.g. iphone-17-pro, macbook-pro-16
      "colour": "natural-titanium",          // catalog colour id
      "media": { "src": "assets/demo.mp4", "kind": "video", "startMs": 0, "fit": "cover" },
      "placement": { "position": [0, -0.3, 0], "rotationDeg": [0, 0, 0], "scale": 1 },
      "motion": { "preset": "none" },        // opt-in: none|turntable|float|tilt-reveal|push-in (+ params)
      "shadow": "soft",                      // soft | long | sun | none ("sun" = the Rotato-style
                                             // 45° silhouette sweep on a flat plane behind the device)
      "lidDeg": 90                           // laptops only: lid opening in degrees (0 closed, default 90)
    }
  ],
  "camera": {                                // per-scene track — see "Per-scene camera tracks"
    "keys": [
      { "id": "k1", "tMs": 0, "pose": { "target": [0,0,0], "azimuthDeg": 0, "elevationDeg": 0, "distance": 5 } }
    ],
    "segments": [ { "from": "k1", "to": "k2", "ease": "inOutQuad" } ]  // ease: engine/ease.ts name or "jump"
  }
}
```

Rules for Claude:

- **Structured changes go in the sidecar** (text, device model/colour/media, motion
  preset, shadow, camera keys); **composition changes go in the TSX** (layout, extra
  primitives, custom motion). Both hot-reload.
- `duration.mode: "follow-media"` means the app keeps the scene's `project.json`
  `durationMs` synced to the source video's length. If YOU swap that video's `src`,
  update `durationMs` in `project.json` too (ffprobe the new file; seconds → ms).
- `project.json` stays the sequencing source of truth — the sidecar never stores duration.
- Malformed sidecars degrade to "no doc" with a console warning; never rely on partial
  parsing. Bump nothing: `version` stays `1` until the schema changes upstream.

## Per-scene camera tracks (v7 · M5)

The sidecar's `camera` field animates the camera for THIS scene only, in **scene-local
milliseconds**, sampled by `engine/sceneCamera.ts` at both render seams. Prefer it over
the project-level `camera` in `project.json` for anything scoped to one scene; the project track
remains for project-wide moves and is the only owner of `fov`.

**Poses are orbits, not raw positions.** A key's `pose` is
`{ target, azimuthDeg, elevationDeg, distance }` — the camera sits on a sphere around
`target`, looking at it. `azimuthDeg: 0, elevationDeg: 0, distance: 5, target: [0,0,0]`
is exactly the default camera. Positive azimuth orbits toward +X (screen right);
positive elevation rises above the target. Poses interpolate as orbit parameters (an
arc), and angles interpolate as plain numbers — `350 → 10` swings back 340°, it does
NOT wrap; author continuous values.

**Keys + segments.**

- `keys`: `{ id, tMs, pose }` at scene-local times. Between/outside segments the camera
  **holds** the latest key at/before `t` (before the first key: the first key). A lone
  key with no segments = a static whole-scene reframe.
- `segments`: `{ from, to, ease }` join two key **ids**, `from.tMs < to.tMs`, ordered and
  non-overlapping. Adjacent animations **share the boundary key id** — editing that one
  key moves both segments (this is the intended model; don't duplicate near-identical
  keys).
- `ease`: any `engine/ease.ts` name — `linear`, the 8 families Sine/Quad/Cubic/Quart/
  Quint/Expo/Circ/Back × in/out/inOut (e.g. `inOutQuad`, the default), or `"jump"` (hold
  `from` for the whole segment, snap to `to` exactly at the segment end — the jump cut).
- Gaps between segments are legal (the camera holds); keys past the scene end are legal
  (sampling clamps at the end — a straddling segment cuts mid-flight).
- Invalid keys/segments degrade with a console warning; unknown eases render as the
  default. The UI edits the same track (mini-timeline + move tools) — expect ids like
  `k1`, `k2` from either author.

Worked example — settle in, hold, then a jump cut to a close-up:

```jsonc
"camera": {
  "keys": [
    { "id": "k1", "tMs": 0,    "pose": { "target": [0,0,0], "azimuthDeg": -12, "elevationDeg": 4, "distance": 5.6 } },
    { "id": "k2", "tMs": 1100, "pose": { "target": [0,0,0], "azimuthDeg": 0,   "elevationDeg": 0, "distance": 5 } },
    { "id": "k3", "tMs": 3000, "pose": { "target": [0,-0.3,0], "azimuthDeg": 18, "elevationDeg": 8, "distance": 3.2 } }
  ],
  "segments": [
    { "from": "k1", "to": "k2", "ease": "outCubic" },  // settle to the default pose
    { "from": "k2", "to": "k3", "ease": "jump" }       // hold k2, snap to the close-up at 3000ms
  ]
}
```

(`jump` holds the `from` pose for the segment's whole span and lands `to` exactly at the
`to` key's time — a jump segment IS the hold before the cut, no extra keys needed.)

## Themes & staging (v8)

A theme is a JSON document (schema v2): bundled `kookaburra-*` in `src/theme/builtin/`, user
themes at `~/Kookaburra Cut/themes/<slug>/theme.json` (id `ws:<slug>`; the folder slug is the
identity). Required blocks: `colors` `typography` `motion`; optional: `gradients`
`textAnimation` `lighting` `environment` `backdrop` `background` `effects` — an ABSENT
optional block resolves to the legacy code path (that absence is the byte-identity
guarantee for pre-v8 projects; `kookaburra-default`/`kookaburra-fx` have none of them). Editing a
bundled theme is not a thing — duplicate it (Theme mode, or copy the JSON) and edit the
copy.

```tsx
<SceneStage floorY={-1.5}>{children}</SceneStage>
```

Mounts the theme's lighting rig (`lighting.key` + `fills` + `ambient` on a fixed orbit
sphere — EXPORT CONTRACT constants) and the resolved backdrop (sidecar `backdrop` ??
theme's): cyclorama `floor` / `gradient` plane / `image` plane, all UNLIT exact-colour
(`toneMapped:false`) with `ShadowMaterial` catchers. Real key-light shadow maps run ONLY
when a backdrop is staged AND `lighting.shadow.technique === "map"` (the hybrid rule —
everywhere else devices keep their procedural blob shadows). `useSceneStaged()` tells a
primitive whether a stage owns the lighting (Device/HeroObject stand their bundled lit
sets down). Environments (`environment.source`: bundled `kookaburra:*` HDRI/Lightformer ids)
apply at the compositor seam per scene — never mount drei `<Environment>` in a staged scene.

### Fixed background (v11)

`background` is a CAMERA-LOCKED, frame-filling layer drawn behind ALL world content —
separate from `backdrop` so the two compose (a fixed image can sit behind a shadowed
cyclorama). The vocabulary: `colors.background` clears the frame · `background` is a
camera-locked fill over that clear · `backdrop` is world-space staging. It never moves,
no matter what the camera does (orbits, pans, fov ramps); an optional `parallax`
(0–0.5; 0.03–0.1 is tasteful) drifts it at that fraction of the content's screen motion
— note a pure orbit AT the origin produces no drift (the anchor stays centred); pan the
camera target to see it. Set it on a theme (picked with the theme) or per scene in the
sidecar (whole-value override; `{"type":"none"}` cancels the theme's layer):

```jsonc
// theme.json or scenes/<stem>.json — the fills, all cover-crop centred:
"background": { "type": "color", "color": "#101418" }
"background": { "type": "gradient", "gradient": "backdrop", "parallax": 0.03 }  // names a theme gradient
"background": { "type": "image", "src": "assets/bg.jpg", "parallax": 0.05 }     // or "kookaburra:loft-studio" (bundled)

// VIDEO fill (v12 · M4) — SCENE-DOC ONLY (themes are workspace-shared and can't
// reference project assets; a theme carrying one degrades to no background). Rides the
// deterministic clip frame pipeline (pre-extracted CFR frames, pure clock sampling).
// LOOPS by default; `"loop": false` holds the last frame instead (one knob). While the
// clip's first extraction runs, the scene shows its resolved underlay (never black).
"background": { "type": "video", "src": "assets/bg-loop.mp4" }
"background": { "type": "video", "src": "assets/bg-loop.mp4", "loop": false, "parallax": 0.03 }

// A gradient background may instead carry a SELF-CONTAINED inline spec (theme-independent
// — what the app's gradient picker writes; `spec` wins over `gradient` when both exist).
// GradientSpec (theme gradients too): type "linear"|"radial" (radial = centre→corners,
// angleDeg ignored); space "oklch" = perceptual stop interpolation (absent = the legacy
// per-channel sRGB path — BYTE-FROZEN, never flip it on an existing theme casually: it
// re-renders that project). The 24 curated presets live in src/theme/gradientPresets.ts;
// user-saved presets in ~/Kookaburra Cut/gradients/<slug>.json ({version:1, name, spec}).
"background": { "type": "gradient", "spec": {
  "type": "linear", "angleDeg": 180, "space": "oklch",
  "stops": [["#DCE9F5", 0], ["#F1DED4", 1]]
} }

// ANIMATED fill: a vendored paper-design GLSL effect on the fixed quad (theme-safe, no
// asset references). `shader` is one of: "mesh-gradient" | "simplex-noise" | "swirl" |
// "neuro-noise" | "warp" | "smoke-ring" (src/toolkit/stage/shaders/; the last two sample
// the shared randomizer DataTexture, built synchronously — no preload barrier).
// `u_time` reads the ABSOLUTE project clock
// (scaled by `speed`, clamped 0-4), so the motion runs continuously across scene cuts
// whenever neighbouring scenes share the spec; a dissolve between identical specs is
// seamless, slide/wipe transitions displace the pattern at the seam (expected). `colors`
// fill the effect's slots in order; `params` are the effect's own knobs (see each def's
// `params` table); `scale` zooms the pattern (0.1-4). The pattern lays out against the
// EXPORT format pixels, so preview and export match.
"background": { "type": "shader", "shader": "mesh-gradient", "speed": 1,
                "colors": ["#DCE9F5", "#F1DED4", "#6F93A8", "#101418"] }
```

One image serves every aspect (centre cover-crop — pick images with safe centres).
Backgrounds mount on EVERY scene via the scene host — staged or not — so a
`background` spec (sidecar or theme) always renders; only backdrops/lighting/shadows
need an authored `<SceneStage>`. Image sources: project-relative `assets/…` or
bundled `kookaburra:<name>`.

Sidecar staging fields (all optional; the app writes them from the inspector's Scene
tab — the Theme and Background drill-ins; the unified Background editor writes
colour/gradient through to BOTH `background` and `backdrop` on staged scenes, and its
Staging toggle writes `backdrop: {type:"none"}` to reveal image/video fills):

```jsonc
{
  "themeId": "kookaburra-neon",              // full theme swap for THIS scene
  "backdrop": { "type": "gradient", "gradient": "backdrop" },  // or none/floor/image;
                                             // gradient also takes an inline "spec"
                                             // (a GradientSpec, wins over the name)
  "background": { "type": "image", "src": "assets/bg.jpg", "parallax": 0.05 },  // v11 fixed layer
  "lighting": { "key": { "azimuthDeg": 40 }, "shadow": { "opacity": 0.3 } },  // partial merge
  "textAnimation": { "in": "fade-scale", "out": "none", "staggerMs": 90,
                     "stagger": "word", "shine": true },  // v11 whole-spec text motion
  "textAnimationForce": true  // v11 · M6: sidecar/theme spec BEATS TSX animation props
}
```

Typography is `FontRef {family, weight}` resolved through the bundled OFL registry →
workspace-pinned system fonts (auto-pinned by copy on first project load) → Inter. Theme
`textAnimation` (`{in, out, staggerMs, stagger?, startScale?, shine?, direction?,
delivery?}`) drives AnimatedHeadline's default preset path — see Text primitives. Fonts note: troika shares ONE SDF atlas across all
fonts and `preloadAppFonts` claims cells SEQUENTIALLY in canonical order — adding or
reordering bundled faces is a REBASE EVENT (docs/determinism.md "Fonts").

## Hooks

```ts
useTimeline(): { localMs: number; globalMs: number; progress: number }
useFormat(): { width: number; height: number; aspect: number;
               safe: { top: number; right: number; bottom: number; left: number } }
useTheme(): Theme

// Scene-document hooks (v7 · M2) — read the mounted scene's sidecar:
useSceneText(key: string, fallback?: string): string   // text map lookup ("" default)
useSceneDevices(): SceneDeviceProps[]                  // devices array, Device-spreadable
useSceneDoc(): SceneDoc | null                         // the raw document (rarely needed)
```

`useTimeline`/`useFormat`/`useTheme` read the editor store, so they work inside the r3f
`<Canvas>` (React context created OUTSIDE the canvas does not bridge into the Canvas
reconciler — that is why they are store-backed). The scene-document hooks are backed by a
context created INSIDE the canvas subtree (`SceneHost` provides it), which is why they do
bridge. Devices from the sidecar render as `{devices.map((d) => <Device key={d.id} {...d} />)}`.

## Text primitives

```ts
<AnimatedHeadline
  text: string
  from?: number          // in-animation start, ms (default 0)
  to?: number            // in-animation end, ms (default 600)
  preset?: TextPresetName     // "fade" | "fade-up" | "blur-in" | "slide" | "mask-reveal"
                              // | "fade-scale" | "twist-scale" (v11·M3) | "none"
                              // default: the THEME's textAnimation.in — omit unless overriding
  outPreset?: TextPresetName  // out preset; plays only when outAt is set (default theme out)
  outAt?: number              // out start, ms; plays over the same duration as the in
  stagger?: "char" | "word"   // v8·M4: per-unit stagger (one mesh, per-glyph shader)
  staggerMs?: number          // per-unit delay; default theme textAnimation.staggerMs
  ease?: EaseName             // v8·M4: engine/ease names; default theme motion.easings.standard
  // ── the motion pack (v11·M3) ────────────────────────────────────────────────
  startScale?: number         // fade-scale: starts here, lands at 1 (0.8 grows in, 1.15
                              // settles down; clamped 0.05–4; default 0.8)
  shine?: boolean             // fade-scale: a soft white 45° band sweeps ONCE across the
                              // WHOLE element during the scale-in, masked to the glyphs
                              // (fixed look — no params)
  direction?: "from-left" | "from-right"  // twist-scale: entry side (default from-left;
                              // a 60° perspective card turn around Y, scaling from 0.92)
  delivery?: "all-at-once" | "by-paragraph" | "by-paragraph-group"
                              // all-at-once FORCES the whole-block path even when the
                              // theme staggers. Paragraphs = \n; groups = blank lines
                              // (v11·M4: paragraphs stagger for real — default delays
                              // 160/260ms; shine stays ONE band over the whole element).
  // preset "scatter-scale" (v11·M4b): per-CHARACTER 3D entrance — each glyph starts
  // close to the camera (huge, edge glyphs off-screen), rolled counter-clockwise
  // 30–40°, offset on a whole-element counter-clockwise tilt arc, then settles with
  // seeded-random per-char delays/speeds (deterministic hash — never Math.random) and
  // a short initial fade.
  // Defaults to char granularity (35ms spread); delivery="all-at-once" collapses it to
  // one block unit. Out mirrors back toward the camera.
  face?: "headline" | "body"  // which theme font face (default headline)
  color?: "text" | "muted" | "accent"  // theme colour TOKEN (never raw hexes). Setting it
                              // PINS the fill: the sidecar can't override and the app's
                              // Edit-text swatch disappears. On sidecar-driven scenes
                              // prefer textKey + defaultColor.
  textKey?: string            // the sidecar key this headline renders (the useSceneText
                              // key). Enables the app-editable fill (the scene doc's
                              // textStyle.<textKey>Color) and gives the field a colour
                              // swatch in Edit text. ALWAYS set it on scaffolded and
                              // default-project scenes.
  defaultColor?: "text" | "muted" | "accent"  // fill when neither color nor the sidecar
                              // set one (default "text"): the design default that stays
                              // app-editable
  position?: [x, y, z]
  fontSize?: number      // default 0.6
  // ── layout ──────────────────────────────────────────────────────────────────
  textAlign?: "left" | "center" | "right"  // per-line alignment inside the block
                              // (visible on multi-line text only; troika default left)
  anchorX?: "left" | "center" | "right"    // where `position` sits on the block's X
                              // axis (default center, the legacy contract)
  maxWidth?: number           // wrap width in world units; unset = no wrapping,
                              // \n is the only line break
/>
// With NOTHING configured (legacy themes have no textAnimation), the original v0 linear
// reveal runs verbatim — do not add presets to scenes in pre-v8 projects.
```

Multi-line text: sidecar strings may carry `\n` (the Edit text panel's textareas insert
them); troika lays real line breaks out and the by-paragraph deliveries split on them.
Caveat: `stagger="char"`/`"word"` unit ordering walks the X axis and is line-UNAWARE, so
on multi-line text prefer `delivery="by-paragraph"`/`"by-paragraph-group"` (the `-y`-axis
walk) or accept odd cross-line ordering.

### TitleBlock

The standard top-of-scene text block: title + optional subtitle, theme-scale sizing,
safe-area alignment. Prefer it over hand-positioning two `AnimatedHeadline`s.

```ts
<TitleBlock
  title: string               // useSceneText("title", ...)
  subtitle?: string           // useSceneText("subtitle", ""); empty RECENTRES the title
  align?: "left" | "center" | "right"  // beats the sidecar's textLayout.align;
                              // default center; left/right anchor against the safe area
  from?: number               // title reveal window (default 200)
  to?: number                 // (default 900)
  fontSize?: number           // title size; default portrait 0.34 / landscape 0.56;
                              // the subtitle sits four modular-scale steps down
                              // (theme.typography.scale, its first real consumer)
  position?: [x, y, z]        // offset added after alignment
  maxWidth?: number           // wrap width for both lines
  titleColor?: "text" | "muted" | "accent" | string   // token or raw hex; beats the
                              // sidecar's textStyle.titleColor (default the text token)
  subtitleColor?: "text" | "muted" | "accent" | string // default muted; beats
                              // textStyle.subtitleColor
  subtitleDelayMs?: number    // subtitle stagger behind the title (default 350)
/>
// Sidecar: `textLayout: { align }` steers alignment app-side when the scene doesn't
// hard-code the prop (inert on scenes that position text by hand, the backdrop pattern).
// `textStyle: { titleColor, subtitleColor }` steers the fills the same way (raw hex).
```

**Emoji and symbols just work** in `AnimatedHeadline`/`AnimatedCounter` text — no special
syntax. Colour emoji (🚀, ZWJ sequences, skin tones) render as system Apple Color Emoji
composited in-canvas and animate as one unit under stagger; text-default symbols (→ ✓ ★ ⌘)
render as SDF glyphs in the text colour. Write them straight into sidecar text. Workspace
projects cache emoji rasters in `assets/.emoji-cache/` (write-once, deterministic); bundled
projects should not use emoji. `ExtrudedText` (3D) stays ASCII-only.

The preset table (v11 · M6 — the full vocabulary):

| Preset | Motion | Params | Notes |
|---|---|---|---|
| `none` | plain linear reveal | — | the v0 ramp |
| `fade` | opacity fade | — | |
| `fade-up` | fade + rise into place | — | |
| `blur-in` | sharpen out of a soft blur | — | subtle scale pop |
| `slide` | slide in from the left | — | |
| `mask-reveal` | left→right wipe | — | per-unit sweep under stagger |
| `fade-scale` | grow/settle to size | `startScale` (0.05–4, default 0.8) · `shine` | shine = ONE soft white 45° band across the whole element, scale-in only |
| `twist-scale` | perspective card turn to rest | `direction` from-left/from-right | 60° entry, fixed |
| `scatter-scale` | per-CHARACTER 3D entrance from the camera | — (constants are contract) | defaults to char granularity; `all-at-once` collapses it |

Delivery / stagger (how the text arrives): `stagger: "char" | "word"` (per-glyph shader
path), or `delivery: "all-at-once" | "by-paragraph" | "by-paragraph-group"` (paragraphs
split on `\n`, groups on blank lines — a pure text convention, no schema). All-at-once
FORCES the whole-block path. `staggerMs` is the per-unit delay; defaults per granularity
(char 35 · word 90 · paragraph 160 · group 260). NOTE: a spec's `stagger` is only
consulted when its `staggerMs > 0` — always write a real delay with char/word.

**Resolution order (v11): explicit TSX prop > sidecar `textAnimation` (whole spec) >
theme `textAnimation` > built-in default.** The app's edit-bar "Text motion" panel and
the wizard chips write the SIDECAR spec — so a scene whose headlines carry explicit
`preset`/`stagger` props ignores the picker (capability follows the resolution order;
prefer sidecar-driven motion on scaffolded scenes so the app's controls stay live).
EXCEPTION: the sidecar's `textAnimationForce: true` (v11 · M6 — what the panel's
"Override" writes after detecting coded motion) flips the order for that scene: text
primitives IGNORE their own TSX animation props and follow the sidecar/theme spec
(timing props `from`/`to`/`outAt` and layout props keep applying). When Claude is asked
to make a scene's motion app-editable, prefer REMOVING the TSX preset props over
leaving the force flag set.

```ts

<ImageCard                    // v8·M4: flat colour-exact image plane (icons/logos/stills)
  src: string                 // project-relative asset path; PNG alpha = the shape
  position?: [x, y, z]
  width?: number              // world units; height follows the image aspect (default 1)
  from?: number; to?: number  // optional linear fade-in window, ms
/>

<AnimatedCounter
  from: number
  to: number
  durationMs: number
  format?: (n: number) => string   // default: rounded integer
  position?: [x, y, z]
  fontSize?: number      // default 0.5
/>
```

Both render troika SDF text via drei `<Text>`. **Font caveat:** the default font + unicode data load from a CDN. For offline determinism, bundle a local `.woff` and `preloadFont` it before frame 0 (see `docs/determinism.md`).

## Group lockups (AnimatedGroup) — v11 · M5

```ts
<AnimatedGroup                // icon + text LOCKUPS animated as ONE unit
  from?: number               // in start, ms (default 0)
  to?: number                 // in end, ms (default 600)
  outAt?: number              // out start; plays over the same duration as the in
  preset?: TextPresetName     // the SAME preset library as AnimatedHeadline; the group is
                              // ONE unit (granularity forced null — scatter-scale on a
                              // group is the whole-lockup move; delivery never splits it)
  outPreset?: TextPresetName
  ease?: EaseName
  startScale?: number         // fade-scale params, as on the headline
  shine?: boolean             // fade-scale: ONE band sweeps the WHOLE lockup — icon
                              // (masked to PNG alpha), headline glyphs AND counter digits
  direction?: "from-left" | "from-right"  // twist-scale entry side
  position?: [x, y, z]
  em?: number                 // world units per em for offset presets (default 0.6)
  extent?: [w, h]             // group extent the shine band sweeps (default [4, 2.25]) —
                              // size it to cover the lockup's group-local footprint
/>
```

Rules and conventions:

- **The pivot is the group's ORIGIN** — centre the lockup on the group (children placed
  symmetrically around `[0,0,0]` via their `position` props). Never rely on measured
  bounds for centring; texture/typeset load timing is a determinism smell.
- **The compose rule:** child presets COMPOSE — alphas multiply, transforms nest. Group
  `fade-scale` + a per-word staggered headline inside is the hero case. Children with
  `preset="none"` ride their legacy path and simply inherit the group's alpha.
- **Which children participate:** `ImageCard`, `AnimatedHeadline` (all paths) and
  `AnimatedCounter` multiply the group alpha into their own opacity and catch the group
  shine. Other primitives (Device, VideoClip, shapes) render inside the group TRANSFORM
  but ignore group alpha/shine. Custom primitives can join via `useGroupAnimation()`.
- **Shine band limitation:** the band is computed in group space from `extent` and folded
  into each child by its own `position` prop only — it ignores child rotation/scale and
  deeper nesting. Keep lockup children axis-aligned, positioned directly on the group.
- **Explicit child shine wins:** a child with its own `shine` keeps its own band; the
  group band takes the slot otherwise (one band per text element).
- Theme/sidecar `textAnimation` defaults apply to a bare `<AnimatedGroup>` exactly as
  they do to a headline; nothing configured anywhere → a plain positioned group.

## Media + device primitives

```ts
<Device
  model="iphone-15-pro"  // catalog id (DEVICE_CATALOG): iphone-15-pro | iphone-17-pro | macbook-pro-16
  colour?               // catalog colour id, e.g. "blue-titanium" (default: the model's)
  media?                // { src, kind: "video"|"image", startMs?, fit?: "cover" } on the SCREEN
  placement?            // { position?, rotationDeg? (DEGREES), scale? (× auto-fit) }
  motion?               // { preset: "none"|"turntable"|"float"|"tilt-reveal"|"push-in", ...params }
  shadow?               // "soft" (default) | "long" | "none" — deterministic ground shadows
  lidDeg?               // laptops only: lid opening in degrees (0 closed; default 90)
  lit?                  // default true; pass false for every Device after the first in a scene
/>                                                    // Phase v7 · M1 — implemented + gated
```

`Device` (v7 · M1) is the device+media pillar: a licensed, real-name catalog handset with
media on its screen. Video rides the SAME deterministic clip pipeline as `VideoClip`
(`useClipTexture` — pre-extracted CFR-60 PNGs, clock-sampled, preamble-awaited); images ride
the texture cache. Media is cover-cropped in the screen mesh's UVs. Motion presets are pure
clock functions; shadows are procedural `DataTexture` gradients (drei `ContactShadows` is
nondeterministic — never swap it in). Colour variants are the vendor's authored per-material
factors — exact replacements, not tints. **Light rigs add up:** the first `Device` in a scene
brings the lit set; pass `lit={false}` to every additional one. Scaffolded scenes get their
device array from the sidecar via `useSceneDevices()` — prefer editing the sidecar over
hard-coding `Device` props (skill rule 7). Unknown model/colour ids degrade with a console
error, never a crash. Gate project: `ws:device-video-spike`.

```ts
<VideoClip
  src                    // project-relative source, e.g. "assets/clip.mp4"
  startMs                // when the clip starts, in ms (local scene time)
  fit?                   // "contain" (default, letterbox) | "cover" (fill + crop)
  position?              // [x, y, z]
  scale?                 // default 1
/>                                                    // Phase v2 — implemented
<DeviceMockup
  model="phone-generic"  // bundled handset glTF (toolkit-shipped, keyed by name)
  screen                 // project-relative image on the screen, e.g. "assets/screen.png"
  rotation? position?    // base rotation (radians) / position
  scale?                 // multiplier on the auto-fit scale (default 1)
  spinDegPerSec?         // optional idle spin about Y — pure fn of the timeline
/>                                                    // Phase v3/v4 — PREVIEW spike
```

`VideoClip` (v2) plays a video **deterministically**: the ffmpeg sidecar pre-extracts the source to a constant-frame-rate (60fps) PNG sequence, cached under `$APPDATA` by source hash; the primitive samples `frameIndex = floor((localMs − startMs) / 1000 × 60)` off the clock (clamped, so it **holds the first frame before the clip starts and the last frame after it ends**) and binds it as a texture. Never use `HTMLVideoElement` seeking. Put the source in the project's `assets/` and reference it relatively. Extraction runs on demand (first preview or export) and is cached. Audio is not yet handled (exports are silent).

`DeviceMockup` (v3/v4) is the LEGACY pre-catalog device primitive (bundled glTF + static screen image, auto-fit, lit set) — kept for old projects; **prefer `Device` for all new scenes**. The bundled handset model is the LICENSED vendor asset (`src/assets/models/README.md` — gitignored, present locally only); the accurate-branded-model trade-dress decision is recorded in docs/decisions.md.

## 3D primitives (v3 · M4)

```ts
<ExtrudedText
  text: string
  from? to?              // reveal window, ms (default 0–600): rise + tilt settle, transform-only
  position? rotation?    // base transform (radians); the reveal tilt settles onto rotation[0]
  fontSize?              // default 0.6
  depth?                 // extrusion depth, world units (default fontSize * 0.25)
  bevel?                 // default true
  tone?                  // "text" (default) | "accent" | "muted" — theme colour token
  lit?                   // default true: bundles the shared LightRig
/>
<ParticleField
  count? seed?           // instanced scatter drawn from createSeededRandom(seed) (defaults 200 / 1)
  bounds?                // scatter half-extents (default [6, 3.5, 2])
  size? drift? twinkle?  // base radius / upward wrap drift (u/s) / scale-pulse fraction
  tone? position?        // unlit material — no rig needed; pops under bloom
/>
<WireGrid
  size? divisions?       // extent (default 12) / cells per side (default 24), local XZ plane
  amplitude? wavelength? speed?   // travelling-wave params (CPU-displaced, pure clock fn)
  tone? opacity? position? rotation?
/>
<Ribbon
  seed? points? bounds?  // control curve drawn from createSeededRandom(seed)
  radius?                // tube radius (default 0.05)
  from? to?              // grow window, ms — animates drawRange only (default 0–1500)
  tone? lit? position? rotation?
/>
<HeroObject
  model="handset"        // bundled hero glTF, keyed by name (dev placeholder = the DeviceMockup glb)
  position? rotation? scale?
  spinDegPerSec?         // idle spin about Y — pure fn of the timeline
  floatAmplitude? floatHz?   // gentle vertical bob (default off / 0.5 cps)
  lit?                   // default true: LightRig + one-shot Environment
/>
```

Determinism rules baked into these (details: `docs/determinism.md`, "3D primitives — v3 · M4"): all randomness comes from `createSeededRandom` (exported from the toolkit — **never `Math.random`** in scenes), the seed AND the primitives' internal draw order are export contract, per-frame motion is CPU-written during commit, and every family has a preamble preload barrier (`preloadText3dFonts` / `preloadHeroModels`). **Light rigs add up**: when stacking several `lit` primitives, mount one `<LightRig />` at the scene root and pass `lit={false}` to each.

## 3D objects library (foundation)

The registry for reusable 3D objects, dual-source like themes: bundled manifests register
in `src/toolkit/objects/registry.ts` (explicit imports, pinned in unit tests); user objects
live at `~/Kookaburra Cut/objects/<slug>/` (folder-per-slug: `object.json` + the glb +
an optional `thumbnail.png`), referenced by `ws:<slug>` ids. `resolveObject(id)` /
`listObjects()` never throw — broken manifests degrade with a warning.

```jsonc
// ~/Kookaburra Cut/objects/<slug>/object.json
{
  "version": 1,
  "id": "desk-lamp",                       // re-stamped ws:<slug> on read
  "name": "Desk lamp",
  "glb": "object.glb",                     // relative to this folder
  "thumbnail": "thumbnail.png",            // optional picker art
  "fitHeight": 2.0,                        // world-unit auto-fit target (optional)
  "licence": { "name": "CC0", "redistributable": true },  // false = never commit the binary
  "tags": ["prop", "studio"]
}
```

**Hard requirements for any object glb** (the device-model contract): no Draco/KTX2
compression (CDN decoders break offline deterministic export — `gltf-transform optimize
--compress false`, webp textures ≤ 2048), metres scale, +Z front. Non-redistributable
binaries stay gitignored (the licensed phone-glb precedent). Before any scene USES an
object in an export, it needs the double preload barrier (`useGLTF.preload` + an awaited
`GLTFLoader.loadAsync`) wired into the exporter preamble — the render primitive and
preload plumbing land with the first shipped objects.

## Transition helpers

Pure functions of `SceneTime`; apply the result to a `<group>` or material.

```ts
fade(t: SceneTime, range: [startMs, endMs]): { opacity: number }
slide(t: SceneTime, range: [startMs, endMs], axis: "x" | "y"): { offset: number }
```

## Cross-scene transitions (project.json)

Declared on the INCOMING scene: `"transition": { "type", "durationMs", ... }` — the scene
starts early by the (clamped) overlap. Ten types (v10 · M2); unknown types degrade to
`crossfade` with a console warning. All params are optional (defaults shown); every value
is clamped on load.

| type | family | params (beyond `durationMs`) | notes |
|---|---|---|---|
| `crossfade` | mix | — | display-domain dissolve |
| `dip` | mix | `color` (sRGB hex; default theme background) | out → colour → in |
| `slide` | move | `direction` [1,0] | both scenes move 1:1 (a classic push) |
| `wipe` | mask | `direction` [1,0] | hard reveal line |
| `blur` | mix | `intensity` 0.05 | 25-tap spiral blur dissolve, peaks mid-fade |
| `push` | move | `direction` [1,0] · `parallax` 0.5 | outgoing lags — cover/reveal depth |
| `zoom` | mix | `intensity` 0.35 · `center` [0.5,0.5] | counter-scaled dissolve |
| `whip` | move | `direction` [1,0] · `intensity` 0.12 | full-travel push under 16-tap directional blur |
| `luma` | mask | `shape` "linear"\|"radial"\|"iris" · `softness` 0.08 · `center` · `direction` (linear) | procedural ramp, soft edge |
| `glitch` | mix | `intensity` 0.5 · `blocks` [24,14] · `steps` 12 | hashed block displacement + RGB split; every block lands on B by progress 0.85 |

`direction` is one of the four unit axes. Gate project: `projects/transition-spike` (all
eight non-slide/wipe seams); `ws:launch-2026` keeps slide/wipe coverage.

## Project manifest v3 fields (effects · camera · persistent)

Beyond `scenes`, a `project.json` can declare (all optional — omitting them keeps the project on the
byte-identical composer-free paths):

```jsonc
{
  "themeId": "kookaburra-fx",                     // a theme WITH `effects` enables postprocessing
  "scenes": [{ "file": "…", "durationMs": 2500,
    "effects": { "bloom": { "intensity": 1.8 },              // per-scene overrides (lerped
                 "lut": { "url": "assets/grade.cube",        //  across transitions; LUT url
                          "intensity": 0.75 } } }],          //  snaps at progress ≥ 0.5)
  "camera": [                                  // global-clock keyframes; per-property lerp+clamp
    { "tMs": 0, "position": [0, 0, 5.5], "fov": 46 } ],
  "persistent": "scenes/persistent-orb.tsx"    // hoisted morph module (below)
}
```

All of a project's `.cube` LUTs must share one `LUT_3D_SIZE`. See `docs/determinism.md`.

## Persistent (morph) modules — v3 · M3

The ONE exception to the `defineScene` rule: the module named by `project.json`'s `persistent`
field default-exports a **plain component**. It mounts once in a `<PersistentLayer>` outside
every scene — `useTimeline()` there returns **global** time — so it tweens continuously across
scene seams (the shared-element morph). The compositor owns its visibility (it never ghosts
into transition targets, and effects grade it like scene content).

```tsx
import { type SharedKeyframe, sampleSharedTransform, useTheme, useTimeline } from "@kookaburra/toolkit";

const TRACK: SharedKeyframe[] = [
  { tMs: 0, position: [-0.85, 0.9, 0.4], scale: 0.5, opacity: 0 },
  { tMs: 2500, position: [0, -1.05, 0.4], scale: 1.15, opacity: 0.95 },
];

export default function PersistentOrb() {
  const t = sampleSharedTransform(TRACK, useTimeline().globalMs);
  return (
    <mesh position={t.position} rotation={t.rotation} scale={t.scale}>
      {/* geometry + theme-token material; opacity from t.opacity */}
    </mesh>
  );
}
```

`sampleSharedTransform(track, globalMs)` is pure — per-property linear interpolation across the
keys that define it, clamped outside the keyed range. All other scene rules still apply
(timeline-only motion, tokens, `useFormat`, no DOM).

## Design tokens

Defined in `src/theme/tokens.ts`, read via `useTheme()`:

| Path | Example |
| --- | --- |
| `colors.background` | `#0b0f14` |
| `colors.text` | `#f5f7fa` |
| `colors.accent` | `#3ad1c4` |
| `colors.muted` | `#8a97a6` |
| `gradients.brand` | CSS gradient string |
| `typography.headline` / `.body` | `Inter` |
| `typography.scale` | `1.25` |
| `motion.durations.{fast,base,slow}` | `200 / 500 / 900` ms |
| `motion.easings.{standard,emphasized}` | `outQuad` / `outExpo` |

Add new tokens here; never hard-code values in scenes.

`EaseName` ∈ `linear | inOutQuad | outQuad | inOutCubic | outCubic | outExpo | inOutExpo`.

## Status by phase

| Primitive / feature | Phase | State |
| --- | --- | --- |
| `AnimatedHeadline`, `AnimatedCounter` | v0 | basic reveal/count (stagger/ease TODO) |
| Deterministic export loop | v0 | implemented (`src/engine/exporter.ts`); byte-identical confirmed |
| Multi-format selection | v1 | implemented — 16:9 / 9:16 / 1:1 via `useFormat` |
| Cross-scene transitions | v1 | implemented — crossfade / dip / slide / wipe |
| `VideoClip` | v2 | implemented — `Verify ×2` at 60fps ✓ |
| Postprocessing (bloom · vignette · grain · 3D LUT) | v3 · M1 | implemented + gated — theme/per-scene `effects` params |
| Per-project camera track | v3 · M2 | implemented + gated — `camera` keyframes in `project.json` |
| Persistent morph layer | v3 · M3 | implemented + gated — `persistent` module + `sampleSharedTransform` |
| 3D primitives (extruded text · hero · shapes) | v3 · M4 | implemented + gated |
| `DeviceMockup` | v4 | implemented (legacy — prefer `Device`); model licensed 2026-07-05 |
| ProRes export (`prores_ks` 422 HQ) | v5 | implemented + gated |
| `Device` (catalog + media screens + presets + shadows) | v7 · M1 | implemented + gated — `ws:device-video-spike` project |
| Scene documents (sidecars, `useSceneText`/`useSceneDevices`, scaffolder) | v7 · M2 | implemented |
| Per-scene camera track (orbit keys/segments, mini-timeline UI) | v7 · M5 | implemented |
