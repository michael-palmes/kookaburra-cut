# Charts

A **chart** is one data visual per scene: eight types (column, stacked column, bar,
stacked bar, line, area, stacked area, pie), flat or extruded, driven entirely from
the scene sidecar's `chart` block and edited in the app. Everything the chart does
is a pure function of (data, config, theme, format, scene-local time), so preview
and export cannot drift.

Design reference: Keynote's chart inspector for the controls and its "Magic Chart"
for keyframed data, but with motion tuned for product launch films rather than
slideware.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Hosting | Three mounts: hero, staged, panel | A chart is sometimes the whole scene, sometimes furniture beside a device, sometimes overlay panel content. |
| Coverage | All eight types in 2D and 3D | Taste is enforced by presets, not by withholding types. |
| Data editing | Grid, paste and CSV import | The sidecar owns the numbers; import is an edit-time act. |
| Data motion | Keyframed value snapshots on the shared KeyedTrack | The Magic Chart idea on the app's own timeline, with the same lane semantics as camera and compare. |
| Series colours | Per-series override, else one of 10 named schemes, else theme `chartColors`, else a derived OKLCH ramp | A chart often wants its own colours without restyling the whole scene; user themes without a curated palette still read on light and dark. |
| Chart type (typeface) | One face for the WHOLE chart: block `chart.font`, else the project's `typography.chart`, else the theme faces | Data wants a numerals face (often a mono or a grotesk) that the rest of the deck does not; splitting it per label would only invite a chart that disagrees with itself. |
| Number formatting | Hand-rolled, no `Intl` | Locale data varies across macOS versions, which would break byte-identical export. |
| Appearance | 15 presets in four tiers, resolved to one surface | No renderer ever sees a preset id, so the 2D and 3D paths cannot disagree. |
| Build-in | 19 presets in three tiers, sampled per element | A preset is a row of channel parameters, never bespoke motion code. |
| One per scene | One `chart` block | Mirrors `layeredScreenshot` / `videoWindow` / `compare`. |

## Architecture

### One core, three mounts

```
src/toolkit/chart/
  layout.ts        pure layout maths        -> ChartLayout (0..1 plot rect, x right, y up)
  format.ts        number presentation      -> one formatter for axes, values, counters
  palette.ts       series colours           -> override > scheme > theme chartColors > ramp
  paletteSchemes.ts colour scheme catalogue -> 10 named six-swatch sets
  stylePresets.ts  appearance catalogue     -> one ChartStyleSurface (2D facet, 3D facet, shared)
  animation.ts     build-in catalogue       -> ChartRevealSampler (per element, per series)
  mount.ts         placement maths          -> hero / staged / panel rects, fixed scale
  Chart.tsx        the host                 -> resolves, samples, mounts
  Chart2D.tsx      flat renderer            -> Bars2D, Lines2D, Pie2D (+ chart2dMath)
  Chart3D.tsx      lit renderer             -> bars3d, ribbon3d, pie3d, axes3d (+ space3d, surface3d)
  reveal.ts        build-state clamps       -> the seam both renderers read channels through
```

`src/engine/sceneChart.ts` sits between the sidecar and the toolkit: it resolves the
authored block into a fully defaulted `ResolvedChart` (every field present, so the
renderers never null-check) and samples the data track. It is pure: no clock, no
three.js.

| Mount | Where it draws | Placement |
| --- | --- | --- |
| `hero` | The scene's own frame | The safe rect, less the scene headline's band, less the bands its own furniture reserves. |
| `staged` | Among devices, objects and text | A `DevicePlacement` pose at `CHART_STAGED_SIZE` (3.3 x 2.2 world units), with the `TransformControls` gizmo while the Position drill is open. |
| `panel` | Inside an overlay panel column | A world rect handed over by `FramePanel`; always 2D. |

### Sidecar-driven

`useSceneChart()` resolves the block and registers the scene as a consumer
(`chartRegistry.ts`, the videoWindow pattern). When a scene's TSX never mounts a
chart, `ChartFallback` draws it host-side instead, so a `chart` block renders with no
scene code at all. The fallback calls `MountedChart` rather than `<Chart />`, which
would register it as its own consumer and cycle its render gate.

## The `chart` sidecar block

Parsed in `sceneDocSchema.ts` under the degrade-don't-crash contract: only a missing
`data.series` array drops the block whole, an unknown `type` falls back to `column`,
and every other malformed field drops alone with a console warning. Defaults are NOT
applied at parse time, so absence stays legible in the file; `sceneChart.ts` owns
them.

```jsonc
"chart": {
  "type": "column",             // column | stackedColumn | bar | stackedBar |
                                // line | area | stackedArea | pie
  "dimension": "2d",            // 2d | 3d (a panel mount coerces to 2d)
  "mount": "hero",              // hero | staged | panel
  "placement": {                // staged only, the DevicePlacement shape
    "position": [0, 0, 0], "rotationDeg": [0, 18, 0], "scale": 1, "ground": true
  },

  "data": {
    "categories": ["April", "May", "June", "July"],
    "series": [
      { "id": "s1", "name": "Region 1", "values": [17, 26, 53, 96] },
      { "id": "s2", "name": "Region 2", "values": [55, 43, 70, 58], "colour": "#f0a848" }
    ],
    "source": "assets/q3.csv"   // informational: nothing reads it at render time
  },

  "palette": "reef",            // optional named colour scheme; absent takes the theme's
  "font": "IBM Plex Mono@500",  // optional face for ALL text in this chart; absent takes
                                // the project's chart font, then the theme faces

  "style": {
    "preset": "boardroom",      // appearance preset id
    "depth": 0.5,               // 3D extrusion depth, 0..1
    "gap": 1,                   // gap between category groups, in bar widths
    "cornerRadius": 0.25,       // 0..1 of half the bar width
    "rotation": [0, 0],         // hero 3D presentation tilt, X/Y degrees; front on by default
    "innerRadius": 0,           // pie only; > 0 makes a donut
    "offset": [0, 0],           // hero nudge off the fitted centre, world units
    "scale": 1                  // hero size multiplier, 0.2..3
  },

  "axis": {
    "value": {
      "name": null, "min": null, "max": null, "steps": 4,
      "format": { "decimals": null, "separator": true, "prefix": "", "suffix": "",
                  "compact": false },
      "gridlines": { "visible": true, "style": "hair" },   // hair | dashed | none
      "labels": true
    },
    "category": { "name": null, "labels": true }
  },

  "labels": {
    "legend": { "visible": true, "position": "bottom" },   // top | bottom | trailing
    "values": { "visible": true, "location": "above",      // above | inside | below
                "format": { "decimals": 0, "separator": true, "prefix": "",
                            "suffix": "", "compact": false },
                "countUp": true,
                "offsetY": 0,                              // nudge, in value font sizes, + is up
                "background": null }                       // absent = the preset's own pill
  },

  "animation": {
    "preset": "rise",           // build-in preset id
    "delivery": "cascade",      // all | series | cascade
    "staggerMs": 60, "durationMs": 900,
    "from": "start"             // start | end | centre | edges | shuffle
  },

  "track": {                    // keyframed data; absent means static values
    "keys": [
      { "id": "k1", "tMs": 0,    "pose": { "values": [[17,26,53,96],[55,43,70,58]] } },
      { "id": "k2", "tMs": 3000, "pose": { "values": [[24,31,60,120],[48,50,66,71]] } }
    ],
    "segments": [{ "from": "k1", "to": "k2", "ease": "inOutQuad" }]
  }
}
```

Every value above is the resolved default (`CHART_STYLE_DEFAULTS`,
`CHART_AXIS_FORMAT_DEFAULTS`, `CHART_VALUE_FORMAT_DEFAULTS`,
`CHART_ANIMATION_DEFAULTS` in `sceneChart.ts`), except `type` and `data`, which are
required, and `mount`, which defaults to `hero`. Value-label decimals default to 0,
so a counting label lands on exactly the printed value; axis labels default to auto
decimals. `background` is the one field whose ABSENCE is load-bearing (see
"Value labels").

Resolution rules worth knowing:

- **Rectangular by construction.** Categories and every series row normalise to one
  length (the authored categories, else the longest series), so any sampled matrix is
  rectangular. A missing series `id` becomes `s<n>`, a missing `name` takes the id,
  and a non-numeric cell reads as 0.
- **Pie charts the first series.** Slices are the categories. Extra series keep their
  data and grey out in the inspector.
- **Bar orientation is resolved once.** `bar` and `stackedBar` run horizontally; the
  layout hands both renderers marks with `x`/`width` running right and `y`/`height`
  running up, whatever the type.
- **Scale.** `steps` (1..20) is exact when both bounds are manual and a tick-density
  target when either is auto (d3's nice domain, then `d3-array` ticks). Stacked types
  clamp negatives to 0; plain types keep them and the axis extends below zero.
- **Panel is always flat.** Both the parser and the host coerce a panel-mounted chart
  to `2d`.

## Layout and fit

- **Hero.** `chartHeroRect` takes the safe frame and gives up a band for the scene's
  headline (mirrored from the scaffolded template's own title metrics, capped at 40
  per cent of the safe height). A 2D chart then shrinks by the furniture bands
  `chart2dInsets` reserves, settled over three fixed passes: a terminating fixpoint,
  never a convergence loop. A 3D chart is built at the available size and scaled so
  its tilted bounding box (plot, plus a symmetric 0.16 furniture allowance, plus the
  extrusion) fits again. Both stand at `DEPTH_BANDS.content`. A hero 3D chart
  centres its full content block (plot plus both label stacks, with a front-plane
  perspective allowance) in the rect; the plot builds at `CHART_3D_PLOT_HEIGHT` of
  the rect so the fit holds near scale 1 and fills most of the frame width. New chart
  scenes scaffold with `backdrop: { "type": "none" }`, so the chart floats on the
  scene background; on a floor-staged theme, lift the chart with `style.offset`
  (the Placement group) so the label stack clears the floor. `style.offset` nudges either
  dimension off the fitted pose in world units and `style.scale` multiplies the
  fitted scale (the inspector's Placement group).
- **Furniture bands are estimated, not measured.** Label widths come from a
  character-count estimate (`CHART_GLYPH_ADVANCE`), so the plot rect is a pure
  function of its inputs with no typeset round trip. Reserved space and drawn space
  cannot disagree, because the mount reserves with exactly the appearance the
  renderer draws with.
- **Staged.** `placement` semantics match `Device`: the layout stamp wins over the
  scalars, rotations are degrees, and `ground` rests the plot's base on the stage
  floor when the scene stages one.

## Appearance presets

Fifteen presets in four tiers (`stylePresets.ts`, `CHART_STYLE_PRESET_IDS` is the
carousel order). Every row is stated as deltas against `boardroom`, and
`resolveChartStyle` folds the preset, the authored `style` scalars and the theme into
ONE `ChartStyleSurface` (a flat facet, a lit facet, and the treatments that cross
both). Nothing downstream reads `style.preset`.

| Tier | Id | Intent |
| --- | --- | --- |
| classic | `boardroom` | Matte flat colour, hairline gridlines, generous whitespace: the default and the null case. |
| classic | `print` | Ultra minimal: thin marks, no gridlines, the axis reduced to a baseline. |
| classic | `paperCut` | Editorial flat, no shine, each series stepping in lightness so layers read as cut paper. |
| classic | `terminal` | Grid-forward ledger: square corners, dense ticks, everything on the rule. |
| studio | `studio` | Soft top-light gloss, gentle radius, value labels in pills. |
| studio | `gradientRise` | Vertical gradient fills, no gridlines, labels floating clear: fintech landing page. |
| studio | `glass` | Frosted translucent solids with clearcoat edges, built for dark stages. |
| studio | `velvet` | High clearcoat over saturated fills, soft shadow, nothing sharp. |
| studio | `horizon` | Area first: a strong vertical ramp, no axis line, whitespace doing the framing. |
| market | `midnightGold` | Deep stage, gold-leaning metal under a clearcoat: the premium finance shot. |
| market | `neonLedger` | Dark-first ledger: glowing edges, dashed hairlines, numerals carrying weight. |
| market | `pulseGlass` | Glass and glow over a rising ramp: the crypto hero, the only preset running both. |
| dark | `nightEditorial` | Restrained night editorial: fine rules, matte marks and a barely luminous edge. |
| dark | `launchGlow` | Luminous launch dashboard: rising fill, strong points and bright dimensional edges. |
| dark | `obsidian` | Premium dimensional material: dense metal, broad clearcoat and a sculpted bevel without glow. |

Merge rules, per authored field:

- `preset`: picks the base surface; an unknown id degrades to `boardroom`, warned once.
- `cornerRadius`: **scales**, never replaces. Renderers take
  `style.cornerRadius * surface.cornerRadiusScale`, and resolve caps the scale so the
  product can never pass 1.
- `innerRadius`: a donut narrows `pieGapScale` (the same angular gap opens wider at
  the inner edge).
- `depth`: scales the 3D refraction `thickness`, so glass tracks the solid it passes
  through.
- `gap`: no surface effect at all. Layout owns it.
- Theme: a dark-first surface (transmission, emissive edge or metalness) relaxes its
  glow, refraction and metalness on a light theme, where they read as grime.

`chartGradientRamp` builds the vertical fill ramp from the series colour mixed toward
the theme background in OKLCH (stop colours only; the renderers build their write-once
`DataTexture` from them). `chartStackSurface` gives stack segments a matte finish
under `interiorFlatStacks`, so a tall stack is not a column of highlights.

## Build-in presets

Nineteen presets in three tiers (`animation.ts`, `CHART_ANIMATION_PRESET_IDS` is the
picker order). A preset is a row of channel parameters; `buildChartRevealSampler`
turns one row plus the authored delivery, stagger and duration into a pure function of
`(seriesIndex, categoryIndex)` closed over the current scene-local time.

| Tier | Id | Behaviour |
| --- | --- | --- |
| core | `rise` | Bars grow from the baseline, outExpo, soft cascade. The default. |
| core | `draw` | The stroke draws left to right, then the fill and labels come up behind it. |
| core | `sweep` | Slices iris open out of their own start angles. |
| core | `fadeUp` | The whole chart lifts and fades in as one (the `lift` entrance). |
| core | `wipe` | A per-series mask reveal along the category axis. |
| core | `pop` | A small overshoot with an emphasis pulse on landing. |
| signature | `ticker` | Bars rise with per-bar overshoot and settle while labels count up. |
| signature | `trace` | Draw-on with a glowing leading head travelling the polyline. |
| signature | `assemble` | Stack segments fall in from beyond the axis and stack, tight overlap. |
| signature | `bloom` | Slices sweep in with a pop past full and a pulse on landing. |
| signature | `drop` | Gravity in: the arrival lands early and the tail squashes and releases. |
| signature | `orbitBuild` | The standard rise on a long stagger, made to pair with a camera rig move. |
| signature | `wave` | A sine ripple added across the category axis on top of the stagger. |
| market | `marketPulse` | Draw-on with the final point pulsing once the series completes. |
| market | `surge` | The line draws flat along the baseline, then lifts left to right. |
| market | `momentum` | Bars rise, then a shine band sweeps across their faces. |
| market | `ledger` | Stacks build bottom-up per category, the cascade rank order itself. |
| market | `allocation` | The pie sweeps in, then each slice pulses once in order. |
| market | `breakout` | Additive: the final category arrives late with the overshoot, a pulse and a shine. |

**Applicability and degrade.** Each preset declares the types it was designed for. A
family it does not cover WHOLE hands over to that family's core default (bars to
`rise`, lines to `draw`, pie to `sweep`), so `draw` on a column plays `rise` and
`ticker` on a pie plays `sweep`. An unknown preset id degrades to `rise`, warned once.

**Delivery vocabulary** (orthogonal to the preset): `delivery` is `all`, `series` or
`cascade`; `from` is `start`, `end`, `centre`, `edges` or `shuffle`. Shuffle is a
seeded `unitHash01` order, never `Math.random`, with ties broken by index.
`staggerMs` is multiplied by the preset's own `staggerScale`.

**Channels.** The sampler hands each element `{ grow, alpha, count, pulse, shine,
drop }` and each series `{ draw, headX, alpha }`. `count` is the clamped, monotone
channel a value label prints against, so a label never runs past its true value while
`grow` overshoots. `drop` is the per-element entrance a scaling channel cannot carry
(`fall`), and `lift` moves the whole chart instead, applied by the host
(`chartEnterOffset`). `revealAt` clamps everything (grow is capped at
`CHART_GROW_MAX`, 1.06), so no preset can invert a mark or push alpha past opaque.

`chartAnimationEndMs` reports the whole build including tails (post-build pulses,
shine sweeps, the breakout beat), which is what the timeline shows and what "the build
has finished" means.

## Palette

Precedence: per-series `colour` override, then the block's named `palette` scheme,
then the theme's curated `chartColors` swatch at that index, then a derived ramp.
Indices wrap at every step, and a malformed hex falls through to the next source
rather than painting a broken mark. With no `palette` the resolution is the
pre-scheme one exactly, hex for hex, which is what keeps the gate EQUAL.

- **Named schemes** (`paletteSchemes.ts`) are ten hand-tuned six-swatch sets:
  Reef, Sunrise, Eucalypt, Outback, Harbour, Orchid, Citrus, Vivid, Muted, Slate.
  A scheme is background-agnostic, unlike a theme palette curated against one
  background, so every swatch has to hold on the darkest and the lightest bundled
  theme at once. That pins them all into a mid-tone luminance band: the schemes
  differ by hue family and chroma rather than tone, and none runs to neon-bright or
  pastel-pale (Vivid and Muted are the high and low chroma ends of that band, not
  light and dark ones). The contract, pinned by `paletteSchemes.test.ts`: 3:1
  against every bundled theme background, neighbouring swatches separated in OKLab
  (the two-series case), every pair in a set tellable apart, and no two schemes
  collapsing onto each other.
- An unknown scheme id warns once and falls through to the theme, the same degrade
  an unknown appearance preset takes.
- `chartColors` is an optional theme field (hex strings, six by convention). Every
  bundled theme ships a hand-picked palette; a malformed entry drops alone.
- The derived ramp (`derivedChartPalette`) is seeded from `colors.accent`: hue rotates
  in 60 degree steps, lightness sits in a band chosen by the background (bright on
  dark themes, deep on light), with a minimum contrast against the background and a
  chroma walk that keeps every swatch in gamut. Pure, so the same theme gives the same
  hexes on every machine.
- A pie indexes colours by CATEGORY, since it is one series split into slices; every
  renderer reads through `chartColourAt`, so a mark can never disagree with its legend
  entry.
- `seriesLightnessStep` (the `paperCut` treatment) steps each successive series away
  from the background in OKLCH lightness, applied in `chartColours` at mount time.

## Typography

Precedence, resolved in `chartFace` (`mount.ts`) and applied by `ChartLabel`:

1. The block's own `chart.font` ("Family" or "Family@weight", the sidecar font-string
   format `textStyle.<key>Font` uses).
2. The project's chart font, `typography.chart` in `project.json`.
3. The theme's `typography.body`, or `typography.headline` where the appearance
   preset's `fontEmphasis` is `headline`.

A chart font replaces BOTH theme faces, so it covers tick labels, category labels,
axis names, value labels and legend entries at once, and emphasis stops changing the
family. Only the family and weight change: sizes stay the chart's own metrics.

The project default rides the existing typography merge: `parseProjectTypography`
folds `typography.chart` onto every resolved theme (project and per-scene alike), so
`theme.typography.chart` is what the renderer reads. That slot is injected by the
project load, never parsed out of a `theme.json`.

**The preload seam.** The export preamble preloads exactly the refs the project
declares, and a face first typeset mid-run claims cells in the shared SDF atlas late
(docs/determinism.md, "Fonts"), so both new sources must join that set:
`collectThemeFontRefs` now takes `typography.chart` beside headline and body (which
covers the project default), and `collectSceneDocFontRefs` takes `chart.font` beside
the `textStyle.<key>Font` overrides. Both collectors feed `ensureFontRefsPinned` +
`preloadAppFonts` in `project.ts` AND `exportPreamble` in `exporter.ts`; a chart font
that skipped them would export a fallback face nondeterministically. The inspector
pins and preloads the picked face before it writes the sidecar, so the preview lands
the same face immediately.

**Not carried by packs.** Pack font closure reads theme typography and sidecar
`textStyle.<key>Font` only, so a `.kbpack` does not yet carry a system font named by
`chart.font` or `typography.chart` (`src-tauri/src/pack/deps.rs`). A bundled family is
unaffected; a system face falls back on the receiving machine.

## Number formatting

`format.ts` is hand-rolled and deliberately free of `Intl`: locale data varies across
macOS versions, which would break byte-identical export. One formatter serves axis
labels, value labels and the counting channel, so a counting label settles on exactly
the printed static value.

- `decimals`: `null` is auto (trailing zeros trimmed, at most 2 places); a number is
  fixed, clamped to 0..4.
- `separator`: thousands grouping, always a comma.
- `prefix` / `suffix`: free strings, applied around the digits.
- `compact`: `k` / `M` / `B`, never auto-enabled. Auto decimals print one place in
  compact; an authored `decimals` is honoured in compact too. The unit is chosen after
  rounding, so 999,999 settles on `1M` rather than `1000.0k`.
- Order is sign, prefix, digits, unit, suffix, so a negative dollar million reads
  `-$1.2M`. A value that rounds to nothing prints `0`, never `-0`, so a counter
  crossing zero does not flicker a sign.
- Non-finite input prints as zero, matching how the layout reads broken cells.

Two editors write two DIFFERENT fields and never share one object: the Axis tab's
Tick labels group formats the numbers along the axis (`axis.value.format`), the Series
tab's Value labels group formats the numbers riding the marks (`labels.values.format`).

## Value labels

The numbers riding the marks, `labels.values`. `visible`, `location` and `countUp`
place them; two more fields dress them, and neither touches axis tick labels.

- **`offsetY`, the nudge.** A vertical shift in VALUE FONT SIZES, positive lifting,
  clamped to ±`CHART_VALUE_OFFSET_MAX` (4). Font sizes rather than world units, so one
  authored nudge reads the same on a hero chart and a panel chart, in 2D and in 3D. The
  chip (below) moves with the number: 2D places the pill from the nudged anchor. 0
  places labels exactly where they always sat, in every family (bars, lines and areas,
  pie rims, and all three 3D families).
- **`background`, the chip.** Absent (the default) nothing changes: the appearance
  preset's `labelPill` alone decides whether a chip is drawn, in the colour
  `chartPillColour` derives from the theme. PRESENT, even bare (`{}`), it FORCES the
  chip on whatever the preset says, and each field overrides the derived pill:
  `colour` (theme token or hex, absent takes the derived one), `opacity` (0..1) and
  `radius` (fraction of the chip height, capped at the capsule 0.5). A bare block
  renders exactly like the preset's own pill, which
  `CHART_VALUE_BACKGROUND_DEFAULTS` pins by test.

`valueLabelPill` (`chart2dMath.ts`) is the one resolver, and `ChartPills` draws the
chips it returns: still ONE instanced mesh per run of labels, with the block's opacity
as the chip weight the shared default otherwise supplies.

**Flat charts only, for now.** A 3D chart takes the nudge but ignores `background`,
and the inspector hides the background controls for one. 3D value labels billboard by
rewriting `matrixWorld` in `onBeforeRender` (`billboardLabel.ts`), and an instanced
chip cannot ride that: three uploads `instanceMatrix` during `projectObject`, BEFORE
any `onBeforeRender` runs, so camera-composed instance matrices would land a frame
late. A per-label chip mesh would work but is a new render seam (a draw call per label,
per-chip geometry, its own depth and transparency ordering against the marks), so it
waits for its own change.

## The data track

Keyframed data is the Magic Chart model on the shared `KeyedTrack`: each key holds a
FULL `[series][category]` snapshot at a scene-local time, and segments interpolate
elementwise with an `engine/ease.ts` curve. Structure changes (adding a series or a
category) are edits to `data`, never keyframable.

- **Sampling** (`chartValuesAt`): inside a segment, eased elementwise interpolation;
  outside one, the latest key holds; before the track starts, the first key; with no
  keys at all, the block's static values. Always a fresh matrix.
- **Poses stretch onto the resolved shape.** A cell a pose does not define falls back
  to the static datum, so adding a series after keyframing renders it at its authored
  value rather than at zero.
- **Fixed scale.** `chartScaleBounds` runs layout once over `maxAcrossTrack` (the
  elementwise upper envelope of the static values and every key) and pins the value
  axis to it, so a morph never clips a mark or jitters the axis. A static chart keeps
  its natural nice ticks.
- **The build composes with the morph.** A tracked chart never settles
  (`chartSettleMs` is infinite), because its marks move every frame regardless.

## The panel mount

An overlay panel opens a chart slot in its `frame` block: `true` for the common case,
`false` to switch an inherited deck slot off, or an object carrying `height` (a
fraction of the column, 0.1..1) and `position` (`below` the text, or `replace`, which
gives the chart the whole column and stands the editorial content down).

`framePanelChartSlot` measures the band inside the already-padded column: full column
width, bottom-anchored, and the authored height is a REQUEST. The band gives way to
the panel's solved header plus its body and a gap rather than climbing into them,
whatever the alignment. The chart draws at the FULL frame format, not a narrowed one,
so every pixel-derived stroke width and SDF feather still holds; `FramePanel` simply
hands the host a world rect. See `docs/overlays.md` for the panel itself.

## Editing

- **Drill.** `chart.edit` (titled "Chart") splits Graph / Axis / Series on a
  `SegmentedRow`, with a Value / Category sub-pill on the Axis tab and a series detail
  screen (the LightEditor "detail of a list" pattern). Reads come from `resolveChart`,
  so every control shows the value that renders; writes patch only the field touched,
  so an untouched default never lands in the sidecar. Live slider and scrub ticks
  write history-less from a drag-start snapshot and settle to one history entry.
- **Graph tab order.** Edit data stays above the Graph / Axis / Series control, then
  the Graph tab carries Chart type, Dimension, Mount, Appearance, Colours, Font,
  Shape, Placement, Legend and Build in. The Colours group is a plain 2-up grid of
  CSS swatch tiles: a Theme tile
  first, showing what this scene's theme resolves, then the ten schemes. Nothing here
  is a captured preview, so the catalogue can grow without regenerating thumbnails.
- **Font.** One row in the text-field font idiom (the family when the block overrides,
  otherwise the project's chart family or "Theme font", with the `overridden` class
  only on a real override). It opens a font screen inside the drill, the series-detail
  pattern: the `FontPicker`, and a reset button back to the project font (or the theme
  faces) whenever the block sets one. The project default lives in the Project tab's
  Typography drill as a third slot beside Headline and Body.
- **Series tab.** The series list and its detail screen, then the Value labels group:
  visibility, location, format, count up, the Nudge slider (with Reset nudge, which
  DELETES the field rather than writing a zero), and the Background toggle whose ON
  writes the block with the shipped pill's own opacity and radius and whose OFF deletes
  it. Its colour row resets to the derived pill by clearing `colour` alone. A 3D chart
  shows a hint in place of the background rows.
- **Placement.** `chart.position` is the staged mount's drill (Move / Rotate / Scale
  pills plus scrub fields); the gizmo attaches to the posed group while it is open and
  posts its commit through `chartEditStore`.
- **Data modal.** A sheet over the canvas with the chart live behind it. The grid is
  header row = categories, first column = series names, numeric cells: keyboard first
  (arrows, Tab, Enter, type to overwrite, Escape reverts the cell), multi-cell TSV or
  CSV paste, structure edits from the header context menus. Edits commit on
  navigate or blur, never per keystroke. Soft guidance warns past 12 categories or 6
  series, and stacked types warn on negatives (they clamp to 0 at layout).
- **Timeline lane.** A scene with a chart block gets a data lane (a `TrackLane`,
  stacked above the camera lane while Animate scene is open) with full batch-11
  semantics: connected keyframes,
  junction diamonds, segment ease menus, ripple resize and duration clamping. There
  are no armed tools (a key IS a data snapshot), Add keyframe seeds the currently
  sampled values so adding never visibly moves the chart, and double-clicking a
  diamond opens the data modal on that key. Secondary chart and comparison lanes
  never open the stack themselves, and their hidden selections clear when Animate
  scene closes or the active scene changes.
- **Wizard and commands.** The New-scene wizard's `chart` kind adds a type picker, a
  2D/3D choice and a starter dataset, scaffolds `chart.tsx.tmpl` and seeds the block
  natively in `scene_doc.rs` (starter data only: style, axis, labels and animation stay
  absent so `resolveChart` owns every default). Chart scenes start at 5000 ms so the
  build and its counters have room to land. The palette carries `scene.addChart` and
  `scene.editChartData`.

## CSV import

- The modal's import button reads the picked file's text, and best-effort copies the
  bytes into the project's `assets/` through the native `import_chart_data` command
  (chart data extensions only: `.csv`, `.tsv`, `.txt`, deliberately outside
  `MEDIA_EXTENSIONS`, so chart data never surfaces in a media browser). The returned
  project-relative path lands in `data.source`, which is what makes Re-import silent
  later. When the copy fails, the bare filename is recorded and Re-import asks for the
  file again.
- Shape: first row category labels (the leading corner cell is ignored), first column
  series names, numeric cells. The same layout as the grid, so the mental model is
  one to one.
- The parser (`csv.ts`) is hand-rolled and dependency-free: quotes with `""` escapes,
  embedded commas and newlines, CRLF/CR/LF endings, and tab detection for the
  Numbers/Excel clipboard shape. Currency and grouping marks are stripped, accountancy
  parentheses read as negative, empty cells read as 0, and the first genuinely
  non-numeric cell fails the whole import with its spreadsheet reference (`C2`) rather
  than silently zeroing.
- Import is an edit-time act: the parsed values become the sidecar's own data, and
  nothing reads the CSV at render or export time.

## Determinism

This is an export-path feature and gates through `docs/determinism.md`.

- **Null-for-legacy.** A scene with no `chart` block resolves to `null`, the fallback
  renders nothing, and no chart code runs. `ws:launch-2026` 16:9 must stay EQUAL.
- **Opt-in colour.** An absent `palette` resolves through exactly the pre-scheme
  ladder, so every existing chart keeps its hexes; the schemes are pinned data, so a
  chart that does name one is the same colours on every machine.
- **Purity.** Layout, formatting, palette derivation, style resolution and the build
  sampler read no clock, no `Math.random` and no `Intl`. The sampler is rebuilt every
  frame from the scene-local clock and is deliberately NOT memoised: it must be a new
  identity each frame or the instanced writers keying on it stop rewriting.
- **Geometry rests.** Past the build's settle the host drops the sampler to `null`, so
  value-keyed geometry rests on the full-reveal default. Bars grow through
  `instanceMatrix` and never rebuild; ribbons rewrite `position` in place and rebuild
  only when their coordinates actually move; pie geometry is keyed on the DRAWN arcs
  (`pieSweepKey`), so it rebuilds through a sweep or a morph and rests the moment the
  angles settle. Draw-on is a fragment X-clip against a uniform, never a rebuild.
- **Instancing is imperative.** Per-instance matrices, colours, alphas and shine are
  written in layout effects, never through r3f JSX prop diffing (per-instance colour
  through the reconciler is a known upstream bug).
- **The declared-face rule.** Chart text takes only faces something DECLARES: the
  block's `chart.font`, the project's `typography.chart`, or the theme's
  `typography.body` / `typography.headline` (the latter when the preset's
  `fontEmphasis` is `headline`). Never a synthesised weight. The export preamble
  preloads exactly the declared refs (`collectThemeFontRefs` +
  `collectSceneDocFontRefs`, both of which now take the chart sources), and a face
  first typeset mid-run would claim cells in the shared SDF atlas late. An unset
  `font` resolves through the pre-font ladder exactly, which keeps the gate EQUAL.
  The same caution applies to affixes: the glyph
  preload set covers Latin, digits and common punctuation, so an unusual prefix (a
  currency mark, for instance) is first typeset during the run; extend
  `PRELOAD_CHARACTERS` in `theme/fonts.ts` if a project needs it. Chart labels are
  plain troika text with no emoji substitution.
- **Coplanar layers** step apart by a fixed world epsilon (`CHART_2D_Z_STEP`) with
  explicit `renderOrder`, never `polygonOffset` (driver-dependent).
- **Billboarded labels** (3D ticks, bar values and pie values) recompose their
  `matrixWorld` from the render camera in `onBeforeRender`, a pure function of that
  frame's camera rather than a frame-loop billboard. TRAP: setting the prop shadows
  troika's OWN `onBeforeRender` on the instance (glyph sync plus binding the SDF atlas
  into the derived material), so `billboardLabel.ts` calls the inherited handler first.
  A bare handler leaves every billboarded label invisible while the flat ones draw.
- **Fat lines** take their `resolution` uniform once from the format's fixed pixel
  dimensions, never from a resize listener, so a stroke is the same fraction of the
  frame in preview and in export.
- **The gizmo never exports.** `exportPreamble` clears the chart edit selection, so a
  staged chart renders its bare transform.
- **Eyeball first.** Verify proves determinism, not correctness. Check an
  `--action screenshot` frame before recording any baseline.

Fixture: `ws:chart-spike`. Unit tests pin the pure halves (layout and ticks, stacking,
pie angles, 2D metrics, 3D geometry, formatting, palette derivation and the scheme
catalogue, style resolution, the animation sampler, mount fitting, CSV round trips,
track sampling).

## Preview-lab thumbnails

Chart cards read the committed option-preview sets, baked from dev-only preview-lab
projects by `pnpm kookaburra:run --action option-previews` (incremental: only stale sets
re-render, `--all` re-records everything).

| Picker | Set name | Kind | Lab project |
| --- | --- | --- | --- |
| Appearance carousel | `chart-<stylePreset>` | still (a settled chart) | `preview-lab-chart` |
| Build-in grid | `chartanim-<buildIn>` | clip plus poster, falling back to a still | `preview-lab-chart-anim` |
| New-scene kind grid | `kind-chart` | still | `preview-lab-stage` |

The stem-to-set mapping lives in `optionPreviewJobs` (`src/engine/optionPreviews.ts`) and
is mirrored by `scripts/option-preview-stale.mjs`; the two must move together. A missing
asset degrades to a swatch placeholder, never a broken card.
