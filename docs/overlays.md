# Overlays

An **overlay** is a full-frame panel locked to the camera, with a shaped cutout
through which the scene renders. It turns a project into a slide deck: the
cutout carries the product visual, the panel carries the title, bullets, a
status chip, an icon and decorations.

Design references: a large rounded window on one side, an editorial text column
on the other, and an illustration that deliberately breaks out over the window
edge.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scope | Project-level default, per-scene override | The frame is a deck property, but title slides and full-bleed scenes need exceptions. |
| Content | Title, subtitle, bullets, chip, icon, decorations | The overlay owns the whole editorial surface, so nothing has to align across two layers. |
| Aspects | Auto-restack | One config serves all four aspects, honouring the one-scene-serves-all-aspects rule. |
| Scene text | Overlay claims it, scene headline auto-hides | Single source of truth stays the sidecar `text` record. |
| Centring | Fit: the cutout becomes the design frame | Existing scenes compose correctly with no edits. |
| Decorations | Draw above everything, may cross the cutout edge | The breakout is what makes the layout read as designed. |
| Transitions | The whole frame transitions with the scene | Each slide carries its own title and chip, so the frame change *is* the slide change. |
| Shapes | rect, rounded-rect, squircle, circle, capsule | Superellipse squircle is its own SDF, not a rounded rect. |
| Colour | Theme tokens, with a custom override | Overlays restyle with the theme, one-off brand colours still possible. |

## Architecture

### The render-target approach

The cutout is **not** a camera trick. The scene renders to its own target at the
cutout's aspect, and that texture is composited into the cutout region.

```
per scene:
  1. render scene -> sceneTarget (sized to the cutout's pixel rect)
       effects (bloom/grain/LUT) apply here, to the scene only
  2. compose slide at full frame resolution:
       a. panel background fill
       b. decorations with layer "below"
       c. sceneTarget sampled through the cutout SDF mask
       d. text column: icon, title, subtitle, bullets, chip
       e. decorations with layer "above" (may cross the cutout edge)
  3. -> default framebuffer, or -> A/B target when transitioning
```

Rejected alternative: a camera projection offset (`setViewOffset`). It desyncs
`FixedBackdrop`, which sizes itself from `cam.fov`/`cam.aspect`
(`FixedBackdrop.tsx:137`), and it fights the invariant documented at
`exporter.ts:402` that the resize guard is the sole owner of `cam.aspect`.

The render-target approach needs no camera maths at all. The scene is handed a
viewport whose aspect simply *is* the cutout's, so:

- `computeFormat` narrows naturally, and `format.frame`/`format.safe` are correct
  for every primitive with no indirection layer.
- `FixedBackdrop` sizes correctly, because `cam.aspect` is genuinely the cutout's.
- `Device`'s `TARGET_WORLD_HEIGHT` auto-fit lands the device inside the cutout.
- Orbit is correct, because the cutout really is the scene's frame.

It is also cheaper than full-frame rendering (the target is smaller), and the
panel and typography draw in a separate full-resolution pass, so text stays crisp
regardless of cutout size.

### Reused machinery

| Need | Existing code |
| --- | --- |
| Render target creation, MSAA | `makeTarget`, `compositor.ts:88` |
| Fullscreen composite quad | `quadScene`/`quadCamera`, `compositor.ts:184` |
| Shape SDF and soft edges | `sdRoundBox` + smoothstep coverage, `Device.tsx:361` |
| Shape selection by uniform | `SHAPE_ID` pattern, `transitionShader.ts:29` |
| Camera-locked quad | `FixedBackdrop.tsx:111`, the mirror of this feature |
| Emoji icon | `EmojiQuads.tsx`, `emojiRaster.ts` (write-once raster cache) |
| Sidecar read/write, undo | `useSceneDocPatch`, `writeSceneDoc` |

### Naming

`overlay` is already taken in the compositor: `FrameCameraPlan.overlay`
(`sceneCamera.ts:182`) and `ComposerState.overlayPass` (`effects.ts:41`) both
mean the persistent layer during a transition. Overlay stays the product-facing
name; in code this feature is `Frame` (`src/toolkit/frame/`), with the compositor
stage called `composeSlide`.

## Schema

Project-level default in `project.json`, per-scene override in the sidecar. The
scene value merges over the project value, and `enabled: false` opts a scene out.

```ts
export type FrameShape = "rect" | "rounded-rect" | "squircle" | "circle" | "capsule";
export type FrameSide = "start" | "end";

export interface FrameCutoutSpec {
  shape: FrameShape;
  /** Corner radius as a fraction of the shorter cutout edge, rounded-rect only. */
  radius?: number;
  /** Fraction of the frame's long axis the cutout occupies, 0..1. */
  size?: number;
  /** Which side the cutout sits on: left/top for "start", right/bottom for "end". */
  side?: FrameSide;
  /** Margin between cutout and frame edge, fraction of the shorter frame edge. */
  inset?: number;
}

export interface FrameChipSpec {
  label: string;
  /** Theme token id ("accent", "muted", ...) or a hex override. */
  colour?: string;
  /** Emoji or a project-relative asset path. */
  icon?: string;
}

export interface FrameDecorationSpec {
  id: string;
  /** Project-relative asset path. */
  src: string;
  /** Frame-relative centre, -1..1 on both axes. */
  position: [number, number];
  /** Width as a fraction of the frame width. */
  size: number;
  /** "circle" crops to a disc, for avatars. */
  shape?: "none" | "circle";
  layer?: "above" | "below";
}

export interface FrameSpec {
  enabled?: boolean;
  cutout: FrameCutoutSpec;
  /** Theme token id, or a hex override. */
  background?: string;
  /** Emoji or asset path, sits above the title. */
  icon?: string;
  chip?: FrameChipSpec;
  decorations?: FrameDecorationSpec[];
  textAlign?: SceneTextAlign;
  /** Overlay claims the scene's title/subtitle/bullets. Default true. */
  claimsSceneText?: boolean;
}

/** What a scene sidecar may carry: `cutout` is optional, so a scene can restyle the colour or chip without restating the shape. */
export interface FrameOverrideSpec extends Omit<FrameSpec, "cutout"> {
  cutout?: FrameCutoutSpec;
}
```

`project.json` carries a `FrameSpec` (a `cutout` is required: with no shape there
is nothing to render through). A scene sidecar carries a `FrameOverrideSpec`,
merged over the deck's by `mergeFrameSpec`. An override's `cutout`, when present,
replaces the deck's outright rather than merging field by field, so a scene
picking a new shape never inherits a radius meant for another one. An override
alone cannot create a frame where the deck declares none.

### Text source

Title, subtitle and bullets come from the scene's existing
`text?: Record<string, string>` record, under the keys `title`, `subtitle` and
`bullets`. Bullets are **one newline-separated string**, not an array, so the
`Record<string, string>` type is unchanged and the existing text inspector and
`textStyle` per-key overrides keep working untouched.

When `claimsSceneText` is true (the default), the scene's own `TitleBlock` is
suppressed and the same keys render in the overlay's text column.

## Layout

The author picks a `side`, never an axis. The axis follows the aspect, so one
config serves all four formats:

| Aspect | Axis | `side: "start"` |
| --- | --- | --- |
| 16:9 | horizontal | cutout left, text right |
| 1:1 | vertical | cutout top, text below |
| 4:5 | vertical | cutout top, text below |
| 9:16 | vertical | cutout top, text below |

The cutout rect is a pure function of `(aspect, size, side, inset)`, unit-tested
and golden-pinned like `fixedQuadSize`, since it feeds the export contract.

### Panel content

The panel splits into two zones, following the reference slides. The header
(icon, title, subtitle) anchors to the column top; the body (bullets, then the
chip) sits in the upper-middle, so the lower panel stays clear for a breakout
illustration. Each block's height is budgeted (the title's from an estimate of its
wrapped line count, the subtitle at a two-line worst case, since troika wraps
async) and the stack scales by one factor to fit the column, so the header and
body never overlap. Bullets and titles are short by design here, like the
reference decks; a very long title is capped and shrunk by the fit scale rather
than measured.

Bullets are the sidecar `bullets` string split on newlines, one reveal-staggered
line each, sized well under the title as small body copy. The chip is a rounded
rectangle (an SDF injected into a `MeshBasicMaterial`, the `ImageCard` precedent)
sized to its measured label, filled with the chip colour (a theme token, a hex, or
the accent default) and labelled in whichever of the theme's text/background reads
better on that fill. The icon and the chip's mark route by `isAssetReference`: a
project asset path (`assets/...` or an image extension) draws through `ImageCard`,
anything else (an emoji, a "✓" tick) draws as text.

### Decorations

Decorations are positioned images in the panel: `position` is frame-relative
(-1..1 on both axes), `size` is a fraction of the frame width, `shape: "circle"`
crops to a disc (an SDF alpha on the plane uv, expecting a roughly square source)
and `layer` orders them. They draw in the panel's over-slide pass, so they always
sit above the cutout scene: `above` (the default) draws over the editorial text
and may cross the cutout edge (the breakout), `below` tucks behind the text as a
panel flourish. True behind-the-cutout layering would need the slide pass split
into panel-fill, below-decorations and an alpha scene key, and is deferred (the
locked decision is "above everything"). Textures are drei-cached and never
mutated (so sharing an asset across scenes is safe) and settle in the export
preamble via `preloadProjectImages`.

## Determinism

This is an export-path change and gates through `docs/determinism.md`.

- **Null-for-legacy.** The overlay path is gated exactly like effects: a project
  that declares no frame never allocates the target and never enters
  `composeSlide`, so the legacy `gl.render` fast path stays byte-identical.
  `ws:launch-2026` 16:9 must stay EQUAL.
- **GLSL3.** The cutout shader is a `ShaderMaterial` and needs its own
  `out vec4 fragColor` declaration.
- **Assets.** Decoration and icon images must be preloaded in the export
  preamble, alongside `preloadCatalogModels`, or the first frames race.
- **Emoji.** The existing write-once raster cache is already the determinism
  source, no change needed.
- **Eyeball first.** Verify proves determinism, not correctness. Check a
  `--action screenshot` frame before recording any new baseline.

## Build order

1. **Geometry and schema.** `frameLayout.ts` (cutout rect maths, pure, unit
   tested), `FrameSpec` types, `parseFrameSpec` validation following the
   degrade-don't-crash contract in `sceneDocSchema.ts`.
2. **Render path.** The cutout SDF shader, `composeSlide`, and the gated
   integration into `renderComposited`. Ship with the panel and cutout only, no
   text. Gate: `ws:launch-2026` EQUAL.
3. **Text column.** Icon, title, subtitle, bullets, chip as troika text and
   emoji quads, plus scene-headline suppression.
4. **Decorations.** Positioned images with circle crop and above/below layering.
5. **Inspector.** A `frame` section in `sceneSections`, a shape and layout
   drill-in, colour picker over theme tokens, chip and decoration editors.
6. **Fixture and docs.** A `ws:overlay-spike` fixture project, baselines
   recorded, this doc updated with the shipped schema.

Phases 1 and 2 are the risky ones: the rest is additive on a proven seam.

## Open questions

- Should the cutout animate (morph shape or size) across a transition, or is it
  static per slide? Static is assumed for now.
- Do effects (bloom, grain) apply to the scene only, or to the composed slide?
  Scene-only is assumed, so grain does not land on the panel chrome.
