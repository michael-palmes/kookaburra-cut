# Charts

One data chart per scene, entirely sidecar-driven. Adding a `chart` block to ANY
scene's sidecar renders it; a chart scene's TSX is at most `<Chart />` (plus a title).
Presets: `chart` (3D starter), `chart-reveal` (titled column chart with counting labels).

## The block (resolved defaults; `palette` and `font` shown as examples)

```json
"chart": {
  "type": "column",
  "dimension": "2d",
  "mount": "hero",
  "data": {
    "categories": ["April", "May", "June", "July"],
    "series": [
      { "id": "s1", "name": "Region 1", "values": [17, 26, 53, 96] },
      { "id": "s2", "name": "Region 2", "values": [55, 43, 70, 58] }
    ]
  },
  "palette": "harbour",
  "font": "Inter@600",
  "style": { "preset": "boardroom", "depth": 0.5, "gap": 1, "cornerRadius": 0.25,
             "rotation": [0, 0], "innerRadius": 0, "offset": [0, 0], "scale": 1 },
  "axis": {
    "value": { "name": null, "min": null, "max": null, "steps": 4, "trim": true, "labels": true,
               "format": { "decimals": null, "separator": true, "prefix": "", "suffix": "", "compact": false },
               "gridlines": { "visible": true, "style": "hair" } },
    "category": { "name": null, "labels": true }
  },
  "labels": {
    "legend": { "visible": true, "position": "bottom" },
    "values": { "visible": true, "location": "above", "countUp": true, "offsetY": 0,
                "format": { "decimals": 0, "separator": true, "prefix": "", "suffix": "", "compact": false } }
  },
  "animation": { "preset": "rise", "delivery": "cascade", "staggerMs": 60, "durationMs": 900, "from": "start" }
}
```

Only `type` and `data` are required. `null` means auto (axis bounds nice themselves;
`decimals: null` trims to at most 2 places).

| Field | Values |
| --- | --- |
| `type` | `column`, `stackedColumn`, `bar`, `stackedBar`, `line`, `area`, `stackedArea`, `pie` |
| `dimension` | `2d`, `3d` (a panel mount is always flat) |
| `mount` | `hero` (the chart is the scene), `staged` (among devices at `placement`), `panel` (inside an overlay panel) |
| `placement` | Staged only: `{ position, rotationDeg, scale, ground }` like a device; chart is 3.3 x 2.2 units |
| `palette` | Colour scheme id (below); absent uses the theme's `chartColors` |
| `font` | One face for all chart text; else `project.json` `typography.chart`, else theme faces |
| `style.preset` | Appearance preset (below); authored scalars compose with it |
| `style.rotation` | Hero 3D tilt and turn in degrees; `[18.5, -18.1]` is the presentation tilt |
| `style.innerRadius` | Pie only; above 0 makes a donut (0.55 reads well) |
| `style.offset`, `style.scale` | Hero nudge (world units) and size (0.2..3) |
| `axis.value.trim` | Cut lines and areas at a manual bound instead of overrunning |
| `axis.value.gridlines.style` | `hair`, `dashed`, `none` |
| `labels.legend.position` | `top`, `bottom`, `trailing` |
| `labels.values.location` | `above`, `inside`, `below` |
| `labels.values.offsetY` | Nudge in value font sizes, up to plus or minus 4 |
| `labels.values.background` | Present (even `{}`) forces a chip: `{ colour, opacity (0.86), radius (0.5) }`; flat charts only |
| `format.compact` | `1.2k`, `3.4M`, `1.2B` |
| `animation.delivery` | `all`, `series`, `cascade` |
| `animation.from` | `start`, `end`, `centre`, `edges`, `shuffle` (seeded) |
| `animation.motionBlur` | `{ enabled, amount? }` for the build-in under motion blur (reference/camera.md) |

- A pie charts the FIRST series; categories become slices.
- Stacked types clamp negatives to 0; plain types draw them below the axis.
- Past 12 categories or 6 series a chart stops reading well (it still renders).
- No emoji in chart labels; use plain `$` and `%`.
- Panel mount needs both `chart.mount: "panel"` and the overlay slot
  `frame.chart: true` (or `{ "height": 0.62, "position": "below" | "replace" }`).
- New chart scenes stage with `backdrop: { "type": "none" }`. On a floor theme lift the
  chart with `style.offset: [0, 0.4]`.

## Appearance presets (`style.preset`)

| Tier | Ids | Voice |
| --- | --- | --- |
| classic | `boardroom` (default), `print`, `paperCut`, `terminal` | Matte, editorial, grid-forward |
| studio | `studio`, `gradientRise`, `glass`, `velvet`, `horizon` | Gloss, gradients, glass |
| market | `midnightGold`, `neonLedger`, `pulseGlass` | Premium finance and crypto |
| dark | `nightEditorial`, `launchGlow`, `obsidian` | Dark-stage editorial and luminous dashboards |

Dark-first presets relax automatically on light themes.

## Build-in presets (`animation.preset`)

| Tier | Ids |
| --- | --- |
| core | `rise` (default), `draw`, `sweep`, `fadeUp`, `wipe`, `pop` |
| signature | `ticker`, `trace`, `assemble`, `bloom`, `drop`, `orbitBuild`, `wave` |
| market | `marketPulse`, `surge`, `momentum`, `ledger`, `allocation`, `breakout` |

`rise` fits everything; `draw`, `trace` and `marketPulse` want lines or areas (the last
two carry a glowing head); `ticker` counts with an overshoot-and-settle; `ledger`
builds stacks bottom-up; `allocation` is the portfolio pie; `drop` lands 3D columns
with a squash. A preset on a type it does not cover degrades to that family's default.
`kb catalog charts.animations --json` lists the types each preset was designed for.

## Colours

Precedence: a series `colour` (brand data only, such as a competitor's colour), then
`palette`, then the theme's `chartColors`, then a ramp off the accent. Schemes (six
mid-tone swatches that hold on light and dark themes): `reef`, `sunrise`, `eucalypt`,
`outback`, `harbour`, `orchid`, `citrus`, `vivid`, `muted`, `slate`.

## Keyframed data (`track`)

Values morph mid-scene; structure (series and category counts) never keyframes.

```json
"track": {
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { "values": [[17, 26, 53, 96], [55, 43, 70, 58]] } },
    { "id": "k2", "tMs": 3000, "pose": { "values": [[24, 31, 60, 120], [48, 50, 66, 71]] } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "inOutQuad" }]
}
```

`pose.values` is the full matrix, series-major. The value axis pins to the envelope of
every key, so nothing clips or jitters. The build-in plays against the first pose, then
segments morph. `animatedTrack: "chart"` puts the track on the app's lane.

## kb chart

```bash
kb chart 03-results show                          # type, presets, data table, keys
kb chart 03-results seed                          # starter block on a scene without one
kb chart 03-results set-data assets/q3.csv        # first row categories, first column series
kb chart 03-results set-data --inline "Q1,Q2;Direct,10,20;Partner,5,8"
kb chart 03-results add-key 2500 --ease outQuad   # key holding the current values
kb doc 03-results set chart.style.preset neonLedger
kb doc 03-results set chart.axis.value.format '{"prefix": "$", "compact": true}'
```

`set-data` replaces the data and removes any data track. CSV, TSV or TXT.

## Recipes

- Safe default: `boardroom` + `rise`, 2D hero, legend bottom.
- Money: `labels.values.format: { "prefix": "$", "compact": true }` with `ticker`.
- Crypto or markets: `neonLedger` + `marketPulse` on a line, dark theme.
- Chart beside a phone: `mount: "staged"`, `placement: { "position": [1.8, 0, 0], "rotationDeg": [0, -12, 0], "scale": 0.8 }`.
- Capture in landscape AND portrait: hero charts refit, but long category labels crowd
  portrait.
