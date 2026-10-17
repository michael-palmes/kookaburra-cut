# Camera

Each scene can animate its own camera in scene-local ms. Two sidecar blocks exist:
`camera` (orbit) and `cameraRig` (free flight); `cameraMode` picks which drives the
scene (absent is orbit). Switching never deletes the other block, and `rig` with no rig
keys falls through to the orbit track. The default camera sits at z = 5 looking at the
origin, 45 degree field of view. Track rules (keys, segments, holds, eases, `jump`):
reference/sidecar.md.

## Orbit track (`camera`)

A pose is an orbit around a target, not a raw position:
`{ target: [x, y, z], azimuthDeg, elevationDeg, distance }`. `target [0,0,0]`, azimuth 0,
elevation 0, distance 5 is exactly the default camera. Positive azimuth orbits toward
screen right; positive elevation rises above the target. Poses interpolate as orbit
parameters (an arc); angles as plain numbers (author 350 to 370, not 350 to 10).

```json
"camera": {
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { "target": [0, 0, 0], "azimuthDeg": -12, "elevationDeg": 4, "distance": 5.6 } },
    { "id": "k2", "tMs": 1100, "pose": { "target": [0, 0, 0], "azimuthDeg": 0, "elevationDeg": 0, "distance": 5 } },
    { "id": "k3", "tMs": 3000, "pose": { "target": [0, -0.3, 0], "azimuthDeg": 18, "elevationDeg": 8, "distance": 3.2 } }
  ],
  "segments": [
    { "from": "k1", "to": "k2", "ease": "outCubic" },
    { "from": "k2", "to": "k3", "ease": "jump" }
  ]
}
```

Settle in, hold, then a jump cut to a close-up at 3000 ms: a `jump` segment IS the hold
before the cut. A lone key with no segments is a static reframe.

## Free flight (`cameraRig`)

Set `"cameraMode": "rig"`. A pose is a position plus an aim:

```json
"cameraMode": "rig",
"cameraRig": {
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { "position": [-2.8, 0.9, 5.6], "aim": { "mode": "tangent", "at": [-1, 0.5, 3.6] } } },
    { "id": "k2", "tMs": 1400, "pose": { "position": [1.2, 0.4, 2.2], "aim": { "mode": "point", "at": [0, -0.2, 0] }, "fov": 34, "rollDeg": -6 } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "inOutQuad", "easeLens": "inCubic" }]
}
```

| Field | Meaning |
| --- | --- |
| `aim.mode` | `point` (fixed world point), `tangent` (look along the path), `object` (`{ mode, id, at }` following a device id, a media id, `videoWindow` or `layeredScreenshot`) |
| `aim.at` | Required on every mode: the baked look point used when a tangent or binding fails |
| `fov` | Optional, clamped 15..90; absent keeps the project track's fov |
| `rollDeg` | Bank; absent or 0 is level |
| `continueFromPrevious` | First key only: start where the previous scene's camera ended |
| segment `smooth` | Absent means the path curves through neighbouring keys; `false` is a straight dolly |
| segment `easePosition`, `easeRotation`, `easeLens`, `easeDof` | Per-channel ease overrides (a dolly zoom lags its lens) |

`<DepthStage>` (reference/scenes.md) gives a rig layers to fly through.

## Presets

The app's camera presets write ordinary keys you can tune. `./kb catalog camera.presets --json` prints
each one's exact track for a 4 s scene from the default pose; scale the times to the
scene and offset from the current framing.

| Preset | Mode | Move |
| --- | --- | --- |
| `push-in` | orbit | Ease closer without changing the angle (distance x1.18 to x0.84, `inOutCubic`) |
| `orbit-round` | orbit | A full 360 turn back to the start (`linear`) |
| `crane-down` | rig | Drop 1.6 units while holding the subject (`inOutQuad`, straight) |
| `fly-through` | rig | Curved flight into the scene looking along the path (four keys, `linear`) |
| `parallax-slide` | rig | Truck 3.6 units sideways with the aim held (`inOutSine`, straight) |
| `dolly-zoom` | rig | Pull back while the lens narrows (`easeLens: "inCubic"`) |

## Depth of field

A `dof` block rides any key's pose in either mode. Fields carry forward from the last
key that set them, so a rack focus restates only `focus`. The first authored `mode` is
the scene's; blur animates, the mode does not.

```json
"pose": { "target": [0, 0, 0], "azimuthDeg": 0, "elevationDeg": 0, "distance": 4.4,
          "dof": { "mode": "depth", "blur": 0.6, "range": 0.8, "focus": "auto" } }
```

| Mode | Look | Fields |
| --- | --- | --- |
| `depth` | Blur by distance from the focus plane (default) | `blur` 0..1, `range` 0..10 sharp band, `focus` 0.05..50 or `"auto"`, `squeeze` 1..2 |
| `tilt` | Tilt-shift: sharp screen band | `blur`, `band` 0..1, `offset` -1..1, `angleDeg` |
| `soft` | Dream: diffusion with highlight glow | `blur`, `glow` 0..1 |
| `radial` | Burst: zoom streaks from a centre | `blur`, `centerX`, `centerY` -1..1 |
| `directional` | Swipe: smear along an angle | `blur`, `angleDeg` -90..90 |
| `split` | Split diopter: two focus planes | `blur`, `range`, `focus`, `focusB`, `offset`, `angleDeg`, `squeeze` |

- `focus` absent or `"auto"` follows the aim distance (orbit: the distance to target),
  so the subject stays sharp through a move.
- Everything blurs by its true depth, text and screens included: keep text you need
  legible on the focus plane. `blur: 0` frames are unchanged. Inspector depth presets:
  Subtle (blur 0.25, range 2), Cinematic (0.6, 1.2), Macro (0.9, 0.5).

## Motion blur

Real motion blur: each blurred frame averages renders across its shutter, so it is
exact for everything that moves (glyphs, devices, shaders), and exports take longer
on moving frames only. Three layers, absent everywhere is off:

```json
"render": { "motionBlur": { "enabled": true, "shutterDeg": 180, "samples": 8, "camera": true, "objects": true } }
```

- `project.json` `render.motionBlur`: `shutterDeg` 0..360 (Crisp 90, Film 180,
  Smooth 270, Smear 360), `samples` 4 / 8 / 16 (Quick, Standard, Fine; a floor:
  fast camera sweeps take up to 32 automatically), `camera`
  (blur from camera moves), `objects` (blur from things moving on their own).
- Sidecar `motionBlur` `{ enabled, shutterDeg, camera, objects }`: each present field
  replaces the project's, so a scene can switch blur on while the project is off, or
  `{ "enabled": false }` keep one scene sharp. Samples stay project-wide.
- A key's `pose.shutterDeg` overrides the shutter from that key on, eased with the
  Lens channel (`easeLens`), the `fov` pattern: crank one whip-pan key to 360.
- Per item, `motionBlur: { "enabled": false }` keeps it sharp and
  `{ "enabled": true, "amount": 1.5 }` scales its trail (0..2): on `devices[]`,
  `media[]`, `textAnimation` (and per-key overrides), `chart.animation` and
  `layeredScreenshot`. In code, wrap motion in `<MotionBlur amount={0}>`.

Always sharp: backgrounds' own animation (world-space 3D looks still take camera
blur), overlay chrome, device screen video frames and counters. Jump cuts and
scene cuts never smear. Stills exports and Present never blur. Streaky text
presets (blur-in, converge, vapor) already fake a smear: lower their `amount`.
Check a blurred frame with `./kb capture`, which renders the export's blur.

## Present loops

`camera.presentLoop` or `cameraRig.presentLoop`: `{ "mode": "jump" }` or
`{ "mode": "smooth", "blendMs": 2000 }` repeats the track while a Present slideshow
holds on the scene. Preview and export always play once.

## Project-level camera

`project.json` `camera` keys (`{ tMs, position, fov, lookAt }` on the global clock)
move the camera across the whole project and own `fov`. Prefer per-scene tracks.

## Beats

Land keys on the soundtrack: `./kb beats --scene <s>` prints beat times in scene-local
ms (reference/beats.md).
