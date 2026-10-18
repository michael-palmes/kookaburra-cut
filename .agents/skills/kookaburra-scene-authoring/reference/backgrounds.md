# Backgrounds and staging

Three layers, back to front:

1. `colors.background` (theme): clears the frame.
2. `background`: a camera-locked fill (or a world-space 3D look) behind all content.
   Renders on EVERY scene with no TSX. Set it on the theme or per scene in the sidecar.
3. `backdrop`: world-space staging (cyclorama floor, gradient or image plane) that
   catches real shadows. Needs `<SceneStage>` in the TSX.

A sidecar `background` or `backdrop` replaces the theme's whole; `{ "type": "none" }`
cancels it. The inspector's "Apply to all" writes the same value into every scene and
records it in `project.json` `appliedBackground` so new scenes inherit it.

## background

| Type | Fields | Notes |
| --- | --- | --- |
| `none` | | Cancels the theme layer |
| `color` | `color` (hex), `parallax` | |
| `gradient` | `gradient` (a theme gradient name) or `spec` (inline, wins), `parallax` | |
| `image` | `src` (`assets/...` or `kookaburra:loft-studio`, `kookaburra:linen-intelligence`, `kookaburra:velvet-physics`), `parallax` | Cover-cropped, centred: pick images with safe centres |
| `video` | `src`, `loop` (default true; false holds the last frame), `fit` (`"fit"` letterboxes; absent fills), `parallax` | Sidecar only, never in a theme |
| `shader` | `shader`, `colors`, `themeColors`, `speed`, `scale`, `params`, `parallax`, `preset` | Animated GLSL fill |
| `scene3d` | `look`, `colors`, `themeColors`, `speed`, `params`, `backing`, `preset` | World-space 3D geometry |

- `parallax` 0..0.5 drifts the fill at that fraction of the content's screen motion
  (0.03 to 0.1 is tasteful). A pure orbit about the origin shows none; pan to see it.
- Inline gradient spec: `{ "type": "linear" | "radial", "angleDeg": 180, "space": "oklch", "stops": [["#DCE9F5", 0], ["#F1DED4", 1]] }`.
  `angleDeg` 180 puts the first stop on top; radial runs centre to corners; `oklch`
  interpolates perceptually (use it for new work). 24 curated specs:
  `./kb catalog backgrounds.gradients --json` (Teal Drift, Midnight Ink, Gilded Dusk...).
- Theme gradient names (often `brand`, `backdrop`) are listed per theme in
  `./kb catalog themes --json`.

## Shader backgrounds

`speed` (0..4) multiplies the ABSOLUTE project clock, so neighbouring scenes that share
the same spec flow continuously across a cut or crossfade. `colors` fill the slots in
order; `themeColors: true` derives them from the theme (explicit colours are then
ignored, and the fill follows theme swaps). `scale` (0.1..4) zooms the pattern.

| Shader | Colours | Params |
| --- | --- | --- |
| `mesh-gradient` | 4 (up to 10) | distortion, swirl, grainMixer, grainOverlay |
| `simplex-noise` | 5 (up to 10) | stepsPerColor, softness |
| `swirl` | 4 (up to 10) | bandCount, twist, center, proportion, softness, noiseFrequency, noise |
| `neuro-noise` | 3 | brightness, contrast |
| `warp` | 4 (up to 10) | proportion, softness, shape, shapeScale, distortion, swirl, swirlIterations |
| `smoke-ring` | 2 (up to 10) | thickness, radius, innerShape, noiseScale, noiseIterations |
| `dot-grid` | 3 | density, dotSize, pulse, waveWidth, driftAngle |
| `graph-grid` | 4 | density, lineWeight, highlightWidth, fillDensity, cadence |
| `horizon-grid` | 3 | horizon, density, lineWeight, glow, fade |
| `hex-grid` | 3 | density, lineWeight, glow, softness, cadence |

Each shader has nine presets: `p1`..`p5` light (black text reads), `p6`..`p9` dark
(white text reads), every stop checked for contrast. Apply one the way the inspector
does, copying its `colors`, `speed`, `scale` and `params` plus `"preset": "<id>"`
(param ranges and preset values: `./kb catalog backgrounds.shaders --json`):

```json
"background": { "type": "shader", "shader": "mesh-gradient", "preset": "p6",
  "colors": ["#0c1827", "#244460", "#3e648a", "#152a3f"], "speed": 0.5,
  "params": { "distortion": 0.8, "swirl": 0.1 } }
```

## 3D backgrounds (`scene3d`)

Real geometry staged outside the content volume with a keep-out clearance and distance
fades, so it parallaxes with camera moves and rigs and never clips text or devices.
Motion runs on the absolute clock like shaders. `backing` is the 2D background behind
the geometry (a colour, gradient, image or shader; never another scene3d).

| Family | Looks (* responds to scene lighting) |
| --- | --- |
| Grids and fields | grid-plain, grid-shell, grid-hall, contour-field, point-swell, dust-drift |
| Abstract forms | drift-slabs*, orb-field*, halo-rings*, skyline-prisms* |
| Lines and engraving | engraved-hills, guilloche-medallion, hiroshige-rain, plexus-loom, pulsar-ridges |
| Painted and printed | blue-and-gold, ink-ranges, lily-pond, paper-theatre, pop-up-terrace, shadow-lace, wash-dome |
| Art history | colour-court, cubist-facets, seigaiha-tide, tessera-dome |
| Deco and architecture | iris-screen, oculus-rotunda, sunburst-terrazzo, sunset-proscenium |
| Texture and atmosphere | aurora-veil, caustic-pool, clerestory-shafts, frosted-panes, mezzotint-sky, riso-dunes |
| Kinetic | box-kites, calder-mobiles, flip-disc-floor, helix-spinners, long-exposure, louvre-ring, origami-tide, pendulum-ring, rain-canopy, sand-table, shylight-blooms, skeleton-clockwork, wind-wands |

Each look has nine presets (`p1`..`p5` light, `p6`..`p9` dark; values in
`./kb catalog backgrounds.scene3d --json`). Applying one writes:

```json
"background": { "type": "scene3d", "look": "grid-plain", "preset": "p7",
  "colors": ["#765137"], "speed": 0.7,
  "params": { "spacing": 1.7, "height": -1.5, "clearRadius": 5, "fadeRadius": 50, "drift": 0.7, "opacity": 0.9 },
  "backing": { "type": "color", "color": "#17110d" } }
```

Some presets carry `matchingLighting` in the catalogue: a lighting rig tuned for the
look. To use it, copy those fields into the scene's `lighting` (reference/lighting.md).
Lit looks need light to read; unlit looks keep exact colours.

## backdrop (needs SceneStage)

| Type | Fields |
| --- | --- |
| `none` | No staging |
| `floor` | `color` (hex), `filletRadius`: a cyclorama that catches real shadows |
| `gradient` | `gradient` (theme name) or `spec` |
| `image` | `src`, `fit` (`cover` default, `contain`) |

Real cast shadows need a staged backdrop AND a lighting `shadow` with
`technique: "map"` (reference/lighting.md). The floor sits at y = -1.5 by default
(`<SceneStage floorY={...}>`); devices with `placement.ground` stand on it. A solid
backdrop can hide a `background` image or video: set `backdrop: {"type": "none"}` to
reveal it.

## Choosing

DESIGN.md "Backgrounds" covers taste. Quick rules: one background family per video;
share an identical shader or 3D spec across consecutive scenes for continuity; keep
busy looks low-contrast behind text; dark presets with light themes read poorly, so
match the preset mode to the theme mode.
