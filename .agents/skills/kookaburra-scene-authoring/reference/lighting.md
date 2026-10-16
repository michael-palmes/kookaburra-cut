# Lighting, environments, tone mapping

Lighting is data, never scene code. Do not mount lights in TSX for themed scenes: the
sidecar `lighting` block renders through `<SceneStage>` (the sun, lights and fixtures)
and the environment applies per scene. Lighting affects lit materials (devices, 3D
objects, lit 3D looks, extruded text); troika text, flat images and shader backgrounds
ignore it.

Determinism cannot see a wrongly lit frame: always capture and look after a lighting
change, and crop your attention to the subject, not the backdrop.

## Three layers

`theme.lighting` then `project.json` `lighting` then the scene sidecar `lighting`. Each
PRESENT field fully replaces the layer below; `lights`, `fixtures` and `fills` replace
WHOLESALE (no merge by id). Absent everywhere keeps the theme's simple rig.

```json
"lighting": {
  "environment": { "source": "kookaburra:sunset", "intensity": 0.9, "rotationDeg": 0 },
  "sun": { "azimuthDeg": -60, "elevationDeg": 12, "intensity": 2.6, "kelvin": 2900, "angularDeg": 0.6 },
  "ambient": 0.3,
  "shadow": { "technique": "map", "softness": 0.35, "opacity": 0.4, "mapSize": 2048, "bias": -0.0005, "color": "#3a2a18" }
}
```

That is the `golden-hour` preset. `kb catalog lighting.presets --json` holds every preset's full spec;
write one into the sidecar and tune from there:

| Preset | Look |
| --- | --- |
| `soft-studio` | Clean, even, e-commerce hero. The safe default |
| `hard-keynote` | Single hard key, deep falloff, stage feel |
| `neon-corridor` | Fluorescent fly-through; tubes do the work |
| `golden-hour` | Warm low sun, long shadows, launch-film warmth |
| `dark-rim` | Near-black; the product defined by edge light (accent rims) |
| `clinical-white` | Flat, shadowless, spec-sheet clarity |

## Fields

| Field | Meaning |
| --- | --- |
| `environment` | Reflections: `{ source, intensity, rotationDeg }`. Sources: `kookaburra:ferndale-studio`, `monochrome-studio`, `story-studio`, `warehouse`, `night-city`, `sunset`, `cyclorama`, `dawn`, `interior` (all `kookaburra:`), `kookaburra:softbox`, `none` (no reflections, unlike absent which inherits), or `assets/<file>.hdr` / `.exr` (a missing file fails the load). Never a visible background |
| `sun` | Key light: `azimuthDeg`, `elevationDeg`, `intensity`, colour, `angularDeg` (apparent size 0..90, real sun 0.53; larger is softer shadows), `castShadow` (true), `enabled` (true) |
| `ambient`, `ambientColor` | Flat fill amount and tint |
| `lights` | Free lights (below), max 16 lights in a scene including the sun and fixture lights |
| `fixtures` | Visible emissive geometry that also lights (below) |
| `shadow` | `{ technique: "map" \| "none", softness 0..1, opacity 0..1, mapSize, bias, color, enabled, catchBackdrop }`; real shadows need a staged backdrop |
| `animationEnabled` | `false` mutes the keyframes without deleting them |
| `keys`, `segments` | Lighting keyframes (below) |

Colour on the sun, lights and fixtures: `kelvin` (1000..20000) wins, then `colorToken`
(a theme colour name, so a theme swap restyles the rig), then `color` (hex), else white.
Prefer kelvin: 2700 to 3200 warm, 5600 daylight, 6500+ cool.

## Free lights

```json
"lights": [
  { "id": "key2", "type": "spot", "intensity": 6, "kelvin": 5600, "angleDeg": 30, "penumbra": 0.5,
    "castShadow": true, "placement": { "mode": "orbit", "azimuthDeg": -40, "elevationDeg": 35, "distance": 6 } }
]
```

| Type | Needs | Notes |
| --- | --- | --- |
| `directional` | `id`, `intensity`, `placement` | Parallel; may `castShadow` |
| `point` | same | Omni; `distance`, `decay`; never casts shadows |
| `spot` | + `angleDeg` (FULL cone, 1..179), `penumbra` 0..1 | May `castShadow` |
| `area` | + `width`, `height` | Soft rectangle; lights only Standard and Physical materials; no shadows; costly over large surfaces |

`placement`: `{ "mode": "orbit", azimuthDeg, elevationDeg, distance }` or
`{ "mode": "point", "position": [x, y, z] }`. At most 4 shadow casters including the sun.

| `space` | Meaning |
| --- | --- |
| `world` (default) | Fixed in the scene; azimuth 0 points from the origin along +Z (toward the default camera) |
| `camera` | Rides the camera; azimuth 0 is behind the lens |
| `subject` | Orbits what the camera looks at; azimuth 0 is a front light |

No `target` aims at the SUBJECT in every space; an explicit `target` is in the light's
own space. Rim lights: `dark-rim` places two accent area lights in `camera` space at
`[-2.4, 0.4, -2.5]` and `[2.4, 0.4, -2.5]` aimed at `[0, 0, -4]` (beside and just in front
of a subject at the default distance); copy that pattern.

## Fixtures

```json
"fixtures": [
  { "id": "tubes", "form": "tube", "size": [3.2, 0.06], "kelvin": 4200, "emissive": 3.5, "lightIntensity": 14,
    "placement": { "mode": "point", "position": [0, 2.4, 0] }, "rotationDeg": [-90, 0, 0],
    "repeat": { "count": 8, "spacing": 2.4, "axis": "z" } }
]
```

| Form | `size` |
| --- | --- |
| `tube` | [length, diameter] |
| `panel` | [width, height] |
| `ring` | [outer diameter, thickness] |
| `strip` | [length, width] |
| `bulb` | [diameter, unused] |
| `neon-sign` | [width, height]; `shape` `line`, `circle` or `rect` |
| `tube-stand`, `ring-light`, `led-strip` | Housed practicals, as tube, ring, strip |

- `emissive` above 1 crosses the bloom threshold; a fixture reads hot only when the
  theme has bloom (`effects.bloom`). Fixtures ignore exposure and tone mapping.
- `lightIntensity` 0 makes it purely decorative. `envMirror: true` adds crisp
  reflections on glossy surfaces (static world-space fixtures).
- Cores run along local X and emit toward -Z (toward the camera) unrotated. A ceiling
  batten is `rotationDeg: [-90, 0, 0]`.
- `repeat`: `count` along `axis` at `spacing`, optional `mirrorAxis`, seeded `jitter`
  0..1. Over the 64-instance budget a run thins evenly rather than truncating.

## Keyframes

```json
"keys": [
  { "id": "k1", "tMs": 0, "pose": { "sun": { "elevationDeg": 8, "kelvin": 2600 } } },
  { "id": "k2", "tMs": 4000, "pose": { "sun": { "elevationDeg": 40, "kelvin": 5600 }, "ambient": 0.45 } }
],
"segments": [{ "from": "k1", "to": "k2", "ease": "inOutSine" }]
```

Poses are sparse: `ambient`, `environmentIntensity`, `environmentRotationDeg`,
`sun.{azimuthDeg, elevationDeg, intensity, kelvin}`, `lights.<id>.{intensity, kelvin, placement}`,
`fixtures.<id>.{emissive, lightIntensity, placement}`. Absent fields keep the base.
Colours interpolate through kelvin when both ends set it. Only the scene layer
animates. `animatedTrack: "lighting"` puts the track on the app's lane.

## Display transform

`project.json` `render`: `{ "toneMapping": "aces" | "agx" | "neutral" | "linear", "exposure": 1 }`
(exposure 0.25..4). `aces` (default) is filmic contrast; `agx` rolls highlights off
more softly with truer saturated colour; `neutral` keeps product colours closest;
`linear` is flat and clips. Applies to the whole project. The same block's `motionBlur`
is in reference/camera.md.

## Recipes

- Product hero: `soft-studio`, then lower `ambient` to 0.25 and add one `dark-rim` style
  rim light for edge definition.
- Launch drama: `hard-keynote` or `dark-rim` with a dark theme and bloom.
- Day to night: two lighting keys (sun elevation and kelvin down, ambient down,
  environment intensity down), or a `compare.b.lighting` for a wipe.
