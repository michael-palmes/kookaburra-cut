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
| Decoration content | An image or a line of text, the string on the spec | Positioned art, not body copy: several decorations each need their own string, and none belongs in the document's text map. |
| Transitions | The whole frame transitions with the scene | Each slide carries its own title and chip, so the frame change *is* the slide change. |
| Shapes | rect, rounded-rect, squircle, circle, capsule, none | Superellipse squircle is its own SDF, not a rounded rect. `none` removes the cutout: the panel fills the whole frame, no scene shows through, `side`/`size`/`inset`/`radius` are no-ops, and content centres by default. |
| Colour | Theme tokens, with a custom override | Overlays restyle with the theme, one-off brand colours still possible. |
| Panel fill | Colour, gradient, image, transparent | The panel is the slide's surface, so it needs the stage's fill vocabulary; animated shaders and 3D looks need extra render-target passes and are deferred. |
| Cutout vs fill (2026-08-23) | The cutout SHAPE alone decides whether the world renders through a window; the fill only decides what paints outside it | Layout and render must agree. `SceneHost` narrows `useFormat()` on the shape, so a transparent panel that rendered full-bleed laid a scene out for a window it never got. |

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
export type FrameShape = "rect" | "rounded-rect" | "squircle" | "circle" | "capsule" | "none";
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

/** One positioned mark: an image or a line of text, EXACTLY one of src/text. */
export interface FrameDecorationSpec {
  id: string;
  /** Project-relative asset path. */
  src?: string;
  /** The text decoration's line; lives here, not in the doc's `text` map. */
  text?: string;
  /** Text fill: theme token or hex. Text only. */
  colour?: string;
  /** Theme face for text; default "headline". */
  face?: "headline" | "body";
  /** Explicit font ("Family" or "Family@weight") replacing the face. Text only; joins the export font preload like `chart.font`. */
  font?: string;
  /** Line spacing as a multiple of the font size (0.8..2); absent means the font's normal. Text only. */
  lineHeight?: number;
  /** Frame-relative centre, -1..1 on both axes. */
  position: [number, number];
  /** An image's width, or text's font size, as a fraction of the frame width. */
  size: number;
  /** "circle" crops to a disc, for avatars. Images only. */
  shape?: "none" | "circle";
  layer?: "above" | "below";
}

/** The panel fill beyond a flat colour; a plain string is still a colour. */
export type FramePanelBackground =
  | { type: "transparent" }
  | { type: "color"; color: string }
  /** `gradient` names a theme gradient, `spec` is an inline one; `spec` wins. */
  | { type: "gradient"; gradient?: string; spec?: GradientSpec }
  /** Project-relative asset path, cover-cropped to the frame. */
  | { type: "image"; src: string };

export interface FrameSpec {
  enabled?: boolean;
  cutout: FrameCutoutSpec;
  /** Theme token id, a hex override, or a fill object. */
  background?: string | FramePanelBackground;
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
carrying its own `cutout` can also create a frame on a scene where the deck
declares none (how `overlaypanel` scenes work).

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
chip) stacks directly beneath it, so the lower panel stays clear for a breakout
illustration. Each block's height is budgeted (the title's from a greedy
word-wrap simulation over per-character advance classes, biased slightly wide
(`framePanelText.ts`); the subtitle at a two-line worst case, since troika wraps
async) and the stack scales by one factor to fit the column, so the header and
body never overlap. Bullets and titles are short by design here, like the
reference decks; a very long title is capped and shrunk by the fit scale rather
than measured.

Bullets are the sidecar `bullets` string split on newlines, one reveal-staggered
line each, sized well under the title as small body copy. Left-aligned bullets
hang: the marker draws as its own node at the column edge and the text wraps
inside `col.width - indent`, so continuation lines clear the marker. The indent
is the measured advance of the old `"•  "` prefix (marker + gap + marker, less
one marker, since troika drops a line's trailing whitespace from its width), so
an unwrapped bullet keeps its geometry to the pixel. Centre and right alignment
keep the single string, markers riding with the text.

The header icon takes the sidecar's `textStyle.iconSize` multiplier (the app's
Size % field beside the icon picker): `FrameIcon` applies it to the drawn mark,
and both the panel budget and the in-world `TitleBlock` stack scale with it.
`TitleBlock`'s no-subtitle recentre counts that stack, so an icon scene centres
on the whole block rather than on the title alone.

The chip is a rounded
rectangle (an SDF injected into a `MeshBasicMaterial`, the `ImageCard` precedent)
sized to its measured label at a fixed reference height (about 64px on a 1080p
frame: a 30px label, a 10px corner), filled with the chip colour (a theme token, a
hex, or the accent default) and labelled in whichever of the theme's
text/background reads better on that fill. The chip's mark comes from a curated
bundled icon set (Lucide designs pre-rasterised to white-on-transparent PNGs,
`chipIcons.ts`): `resolveChipIconId` maps the set ids (plus the legacy `✓` /
`checkmark` aliases) to a texture that `FrameSymbol` draws as a tinted quad, so
no SVG is rasterised at runtime and the export stays byte-identical. Anything
else, and the panel icon, route by `isAssetReference`: a project asset path
(`assets/...` or an image extension) draws through `ImageCard`, anything else (an
emoji) as text.

### Panel fill

`background` carries the panel's surface. A plain string is a colour (theme token
or hex, the shape every existing sidecar uses); the object form adds three more
routes, all resolved on the CPU in `overlayPlan.ts` and painted by the one slide
pass:

| Fill | Render |
| --- | --- |
| `color` (or a plain string) | `panelColor` uniform, the flat fill. Unset = the neutral surface lifted off the scene's backdrop. |
| `gradient` | Baked once by the stage's `gradientTexture` (same pixels as a background gradient), cached in `overlayPanelTexture.ts` and stretched over the frame, so the effective angle is per-aspect exactly as `FixedGradient`'s is. |
| `image` | The project asset, cover-cropped per aspect (`fixedCoverCrop`), so one asset serves all four formats. Settled before frame 0 by `preloadOverlayPanelImages`. |
| `transparent` | No surface of its own. With a SHAPED cutout the slide pass runs exactly as it does for an opaque panel (the world composes into the cutout) and the region outside takes the scene's own backdrop, proxied flat by `overlayPlan.ts`, so the panel reads as absent rather than as a surface. With `shape: "none"` there is no window to compose into, so there is no slide pass at all: the scene renders full-bleed (the legacy path, byte for byte) and only the panel's content draws over it. |

The sampled routes ride one `panelMode` branch in `overlayShader.ts`; mode 0 is
the flat colour path, arithmetically untouched, so every existing frame keeps its
bytes. Fill textures are hardware-sRGB uploads sampled through `sampleDisplay`,
which recovers their stored bytes exactly (the stage's exact-colour discipline).
A gradient that names a theme gradient the theme lacks, or an image that cannot
resolve, degrades to the flat colour, never to nothing.

### Decorations

Decorations are positioned marks in the panel: `position` is frame-relative
(-1..1 on both axes), `size` is a fraction of the frame width, and `layer` orders
them. They draw in the panel's over-slide pass, so they always sit above the
cutout scene: `above` (the default) draws over the editorial text and may cross
the cutout edge (the breakout), `below` tucks behind the text as a panel
flourish. True behind-the-cutout layering would need the slide pass split into
panel-fill, below-decorations and an alpha scene key, and is deferred (the locked
decision is "above everything").

Each decoration carries exactly one of `src` or `text`, and `FrameDecoration`
routes on that the way `FrameIcon` routes an icon:

| Route | Render |
| --- | --- |
| `src` | A `MeshBasicMaterial` plane sized by the texture's natural aspect; `shape: "circle"` crops to a disc (an SDF alpha on the plane uv, expecting a roughly square source). Textures are drei-cached and never mutated (so sharing an asset across scenes is safe) and settle in the export preamble via `preloadProjectImages`. |
| `text` | One `AnimatedHeadline` (troika, the theme's `face` or an explicit `font`, filled by `colour` or the text token), `size` being the FONT size as a fraction of the frame width, `lineHeight` spacing multi-line text (0.8..2, absent = the font's normal). Shape does not apply. A `font` naming a system face joins the export preload set but, like `chart.font`, is not carried by packs. |

Decoration text lives on the spec, not in the document's `text` map: it is
positioned art, not body copy, and several decorations each need their own
string. It carries no `textKey`, so no `textStyle.*` override touches it. Both
routes honour `rotationDeg`; a text decoration's rotation and layer band ride a
wrapping group, whose order is the render list's GROUP order, so a text
decoration sits over an image one in the same band.

The inspector's decoration gizmo boxes a text decoration from the panel's troika
measurement cache (`measuredPanelTextBlock`), falling back to the advance
estimate until the typeset lands. That measurement is DOM-side only: the render
path needs none, since a text decoration's font size comes straight from `size`.

### A fresh overlay

`FramePanel` bails when the panel has no text, icon, chip, chart or decoration,
but that only stands the CONTENT down: `renderFramedScene` still paints the panel
fill and keys the scene through the cutout, so a scaffolded overlay reads as a
slide from the first insert. Nothing is seeded to prop it up (the starter `"New"`
chip is gone from all three scaffold sites: `scene_doc.rs`, the inspector's
`addOverlay` and `.claude/commands/new-scene.md`).

The one exception is the full-panel variant (`cutout: { shape: "none" }`), which
has no window to read: with no copy it would be a flat fill and nothing else, so
the scaffolder seeds `text.title` there when the author gave none.

## Determinism

This is an export-path change and gates through `docs/determinism.md`.

- **Null-for-legacy.** The overlay path is gated exactly like effects: a project
  that declares no frame never allocates the target and never enters
  `composeSlide`, so the legacy `gl.render` fast path stays byte-identical.
  `ws:launch-2026` 16:9 must stay EQUAL.
- **GLSL3.** The cutout shader is a `ShaderMaterial` and needs its own
  `out vec4 fragColor` declaration.
- **Assets.** Decoration and icon images must be preloaded in the export
  preamble, alongside `preloadCatalogModels`, or the first frames race. Image
  panel fills ride the same rule through `preloadOverlayPanelImages`, since the
  compositor samples them at the render seam and cannot suspend.
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
