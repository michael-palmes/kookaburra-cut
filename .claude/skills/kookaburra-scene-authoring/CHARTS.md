# Charts (v14)

The full chart reference for scene authoring. Load this file only when a task actually
touches a chart; `SKILL.md` carries the rules and `REFERENCE.md` the one-paragraph
summary. Everything here is sidecar-driven: the TSX stays one line.

## The one-line TSX

```tsx
<Chart />
```

`<Chart />` reads the scene's sidecar `chart` block (via `useSceneChart()`), resolves
every default, and mounts itself. A scene whose TSX never mounts a chart still renders
its block (the host-side `ChartFallback`), so adding the block to ANY scene's sidecar
is enough. One chart per scene.

## The sidecar block, with every resolved default

```jsonc
"chart": {
  "type": "column",             // column | stackedColumn | bar | stackedBar |
                                // line | area | stackedArea | pie
  "dimension": "2d",            // 2d | 3d (panel mounts coerce to 2d)
  "mount": "hero",              // hero | staged | panel

  "data": {                     // REQUIRED (with type); everything else may be absent
    "categories": ["April", "May", "June", "July"],
    "series": [
      { "id": "s1", "name": "Region 1", "values": [17, 26, 53, 96] },
      { "id": "s2", "name": "Region 2", "values": [55, 43, 70, 58], "colour": "#f0a848" }
    ]
  },

  "palette": null,              // optional named colour scheme id (list below);
                                // absent takes the theme's chartColors

  "style": {
    "preset": "boardroom",      // appearance preset, table below
    "depth": 0.5,               // 3D extrusion, 0..1
    "gap": 1,                   // space between category groups, in bar widths
    "cornerRadius": 0.25,
    "rotation": [0, 0],         // hero 3D tilt/turn degrees; FRONT ON by default
    "innerRadius": 0,           // pie only; > 0 makes a donut (0.55 reads well)
    "offset": [0, 0],           // hero nudge, world units
    "scale": 1                  // hero size multiplier, 0.2..3
  },

  "axis": {
    "value": { "name": null, "min": null, "max": null, "steps": 4,
      "format": { "decimals": null, "separator": true, "prefix": "", "suffix": "", "compact": false },
      "gridlines": { "visible": true, "style": "hair" },   // hair | dashed | none
      "labels": true },
    "category": { "name": null, "labels": true }
  },

  "labels": {
    "legend": { "visible": true, "position": "bottom" },   // top | bottom | trailing
    "values": { "visible": true, "location": "above",      // above | inside | below
      "format": { "decimals": 0, "separator": true, "prefix": "", "suffix": "", "compact": false },
      "countUp": true }
  },

  "animation": {
    "preset": "rise",           // build-in preset, table below
    "delivery": "cascade",      // all | series | cascade (element by element)
    "staggerMs": 60, "durationMs": 900,
    "from": "start"             // start | end | centre | edges | shuffle (seeded)
  },

  "track": { ... }              // keyframed data, section below; absent = static
}
```

Null means auto (axis min/max nice themselves; `decimals: null` trims to at most 2).
`compact: true` prints 1.2k / 3.4M / 1.2B, the finance default for big values.
A pie charts the FIRST series only; categories become slices; extra series stay dormant
so switching types keeps data.

## Mounts

- **hero** (default): the chart is the scene. Layout is automatic against the safe
  frame; the scene's `text.title` gets its band reserved so they never collide. Nudge
  with `style.offset`, resize with `style.scale`. Front-on by default; author
  `rotation: [18.5, -18.1]` for the Keynote presentation tilt.
- **staged**: the chart stands among devices/text at a `placement`
  (`{position, rotationDeg, scale, ground}`, the Device shape) at 3.3 x 2.2 world
  units. Use for "chart beside the phone" compositions.
- **panel**: the 2D chart lives inside the scene's overlay panel column. Needs BOTH
  `chart.mount: "panel"` AND the frame block's slot: `"frame": { "chart": {} }`
  (options: `{ "height": 0.62, "position": "below" | "replace" }`). See "Scene
  overlays" in `REFERENCE.md` for the frame block itself.

## Appearance presets (`style.preset`)

| Tier | Ids | Voice |
| --- | --- | --- |
| classic | `boardroom` (default), `print`, `paperCut`, `terminal` | Matte, editorial, grid-forward |
| studio | `studio`, `gradientRise`, `glass`, `velvet`, `horizon` | Gloss, gradients, transmission glass |
| market | `midnightGold`, `neonLedger`, `pulseGlass` | Premium finance and crypto: metallic, neon edges, glass + glow |

Authored `style` scalars COMPOSE with the preset (cornerRadius scales it, depth scales
glass thickness); the preset never overwrites them. Dark-first presets (glass, the
market tier) relax automatically on light themes.

## Build-in presets (`animation.preset`)

| Tier | Ids |
| --- | --- |
| core | `rise` (default), `draw`, `sweep`, `fadeUp`, `wipe`, `pop` |
| signature | `ticker`, `trace`, `assemble`, `bloom`, `drop`, `orbitBuild`, `wave` |
| market | `marketPulse`, `surge`, `momentum`, `ledger`, `allocation`, `breakout` |

Taste notes: `rise` fits everything; `draw`/`trace`/`marketPulse` want lines or areas
(`trace` and `marketPulse` carry a glowing head); `ticker` counts values up with an
overshoot-and-settle, the earnings look; `ledger` builds stacks bottom-up per category;
`allocation` is the portfolio-split pie; `drop` lands 3D columns with a squash. A preset
on a type it does not cover degrades to that family's default (never an error).
`from: "shuffle"` is a seeded order, deterministic across exports.

## Series colours

Precedence: per-series `colour` override, then the block's `palette` scheme, then the
theme's `chartColors` (all bundled themes carry six curated swatches), then a derived
ramp off the theme accent. DO NOT hard-code series colours in scenes for design
reasons; the override exists for brand data (for example a competitor's brand colour)
only. Reach for a `palette` scheme instead when a chart wants its own colours.

Scheme ids: `reef`, `sunrise`, `eucalypt`, `outback`, `harbour`, `orchid`, `citrus`,
`vivid` (high chroma), `muted` (low chroma), `slate` (cool neutrals). Every scheme is
six mid-tone swatches that hold on light AND dark theme backgrounds, so a scheme never
needs re-picking when the scene's theme changes. An unknown id falls back to the theme.

## Keyframed data (the track)

Values morph mid-scene; structure (series/category counts) never keyframes.

```jsonc
"track": {
  "keys": [
    { "id": "k1", "tMs": 0,    "pose": { "values": [[17,26,53,96],[55,43,70,58]] } },
    { "id": "k2", "tMs": 3000, "pose": { "values": [[24,31,60,120],[48,50,66,71]] } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "inOutQuad" }]
}
```

- `pose.values` is the full matrix, series-major, matching `data` row lengths.
- The value axis pins to the envelope across ALL keys, so bars never clip and ticks
  never jitter during a morph.
- The build-in plays against the first pose, then segments morph; a gap between
  segments holds.
- `chart.py <stem> add-key 2500` appends a key holding the current values (edit the
  numbers after); the app edits the same track on its timeline lane.

## Helper script

```bash
python3 .claude/skills/kookaburra-scene-authoring/scripts/chart.py 03-results show
python3 .claude/skills/kookaburra-scene-authoring/scripts/chart.py 03-results seed
python3 .claude/skills/kookaburra-scene-authoring/scripts/chart.py 03-results set-data assets/q3.csv
python3 .claude/skills/kookaburra-scene-authoring/scripts/chart.py 03-results add-key 2500 --ease outQuad
```

`set-data` takes the data modal's shape (first row categories, first column series
names) from a CSV/TSV, or `--inline "Q1,Q2;Direct,10,20;Partner,5,8"`. Scalar edits
stay with `sidecar.py` dotted paths:

```bash
python3 .claude/skills/kookaburra-scene-authoring/scripts/sidecar.py 03-results set chart.style.preset neonLedger
python3 .claude/skills/kookaburra-scene-authoring/scripts/sidecar.py 03-results set chart.animation.preset marketPulse
python3 .claude/skills/kookaburra-scene-authoring/scripts/sidecar.py 03-results set chart.axis.value.format '{"prefix": "$", "compact": true}'
```

## Recipes

**A chart scene from nothing** (preferred: `/new-scene <project> <name>` with the
`chart` kind; by hand:)

1. Scene TSX: the standard scaffold (`SceneStage` + optional `AnimatedHeadline` title
   + `<Chart />`), registered in `project.json`.
2. `chart.py <stem> seed`, then `set-data` with the real numbers.
3. Pick presets for the audience (`neonLedger` + `marketPulse` for crypto,
   `boardroom` + `rise` for the safe default).
4. Capture a frame and LOOK (`capture.py --scene <stem>`), in landscape AND portrait.

**Chart beside a device**: `chart.mount: "staged"`, then
`chart.placement: { "position": [1.8, 0, 0], "rotationDeg": [0, -12, 0], "scale": 0.8 }`
and let the device hold the other side.

**Counting money**: `labels.values.format: { "prefix": "$", "compact": true }` with
`animation.preset: "ticker"`. The counter lands on exactly the printed static value.

## Gotchas

- One chart per scene; a second block is not a thing. Two charts means two scenes or
  a staged chart beside other content.
- New chart scenes scaffold `backdrop: { "type": "none" }` (the chart floats on the
  scene background; users toggle the stage back on in the inspector). On a
  floor-staged theme, lift the chart clear of the floor with
  `chart.style.offset: [0, 0.4]` before reaching for anything else.
- Stacked types clamp negative values to 0; plain types chart them below the axis.
- Emoji do not render in chart labels (plain troika text); keep prefixes/suffixes to
  plain glyphs like `$` and `%`.
- 12 categories / 6 series is the taste ceiling the app warns at; the renderer keeps
  going but legibility drops.
- Never read the chart block and re-derive layout in TSX; the block is the single
  source and the app edits it live under your scene.
