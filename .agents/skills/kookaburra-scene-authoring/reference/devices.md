# Devices, layouts, 3D objects, before/after

Devices are sidecar data. Any scene renders its sidecar `devices` with no TSX change;
scenes built from device presets read them with `useSceneDevices()` and
`<Device {...d} />`. Start from a preset: `device`, `deviceonly`, `hero-device`,
`comparison`, `duo-unfold`, `feature-compare`.

## The devices block

```json
"devices": [
  {
    "id": "hero",
    "model": "iphone-17-pro",
    "colour": "deep-blue",
    "media": { "src": "assets/demo.mp4", "kind": "video", "startMs": 300 },
    "placement": { "position": [1.4, -0.2, 0], "rotationDeg": [-6, -14, 0], "scale": 1, "ground": true },
    "motion": { "preset": "float", "amplitude": 0.08, "hz": 0.3 },
    "shadow": "long"
  }
]
```

| Field | Values |
| --- | --- |
| `id` | Stable, unique in the scene; tracks, layouts and camera aims reference it |
| `model` | Device id (table); unknown or unavailable ids render as `android` without rewriting the file |
| `colour` | A colour id for that model, or `custom:#rrggbb` (a tint that keeps the finish structure) |
| `media` | `{ src, kind: "video" \| "image", startMs?, fit?: "cover", startOn?: "open" }`; cover-cropped to the screen |
| `placement` | `position` (world units), `rotationDeg` (DEGREES), `scale` (times the auto-fit), `ground` (stand on a staged floor) |
| `motion` | `{ preset, ...params }` (table) |
| `motionBlur` | `{ enabled, amount? }`: keep this device sharp or scale its trail under motion blur (reference/camera.md) |
| `shadow` | Presentation shadow (table); default `soft` |
| `lidDeg` | Laptops: lid angle, 0 closed (default 90, authored open 110) |
| `foldDeg`, `coverMedia`, `bothScreensOn`, `foldTransition` | Foldables (below) |

- Auto-fit: phones and tablets fit to 2.6 units tall, the laptop to 3.4 wide. Scale
  multiplies that. Hosts without TSX draw devices at 0.92 (landscape) or 0.8
  (portrait) of their placement scale.
- Screen videos play from `startMs` (scene-local) and HOLD their first frame before
  and their last frame after; they do not loop. Make the scene no longer than the
  clip, use `duration.mode: "follow-media"` (reference/media.md), or fit the clip to the
  scene with `./kb video fit <edit> --scene S --slot device:<id>` (kookaburra-video-editing).
- Rotation reads best small: front on `[0, 0, 0]`, editorial `[-6, 14, 0]`, mirrored
  `[-6, -14, 0]`.
- Lighting: under `<SceneStage>` the theme lights devices. Without a stage each Device
  brings its own light set, so several devices over-light; stage the scene.

## Models

| Id | Form | Colours |
| --- | --- | --- |
| `iphone-17-pro` | phone | `silver`, `cosmic-orange`, `deep-blue` |
| `iphone-15-pro` | phone | `natural-titanium`, `blue-titanium`, `white-titanium`, `black-titanium` |
| `iphone-duo` | foldable | `star-white`, `night-sky` |
| `ipad-pro-13` | tablet (landscape) | `silver`, `space-black` |
| `macbook-pro-16` | laptop | `silver`, `space-grey` |
| `android` | phone | `graphite`, `black`, `white` |

Every model except `android` is licensed and may be missing from a build; it then
renders as Android. `./kb catalog devices --json` lists screen aspects, sizes and each
display's measured rect. Match media to the screen: phones are portrait (about 1206 x
2622), the iPad landscape, the MacBook about 16:10 (1.547).

## Overlays on the screen: `DeviceScreenAnchor`

Pin anything to a point on a device's screen with `DeviceScreenAnchor` as a child of
`Device`. Never measure the screen off a capture: the anchor reads committed
measurements of the model this build actually renders, so it stays right when a
licensed model is missing and the Android stands in (a different body, its screen
further forward and off centre).

```tsx
<Device {...d}>
  <DeviceScreenAnchor u={0.5} v={0.1}>
    <RoundedRect width={0.7} height={0.16} radius={0.08} color={theme.colors.accent} />
  </DeviceScreenAnchor>
</Device>
```

- `u` runs 0 (left edge) to 1 (right), `v` 0 (top) to 1 (bottom): media pixel order.
  A point at pixel (x, y) of the screen's media is
  `mediaPixelToScreenUv(model, [x, y], { width, height })`, which allows for the cover crop.
- Children lie in the screen's plane (x right, y up, +z out of the glass) in the device's
  fitted units (a phone screen is about 1.15 x 2.5), and scale, float, turn and intro with
  the device. `lift` (default `SCREEN_LIFT`, 0.002) keeps them off the glass.
- Laptops: anchors ride the lid at any `lidDeg`. `iphone-duo`: anchor on the inside
  display's static right half (`u` above 0.56) at any fold, or on `display="cover"` closed.
- Taps on a sidecar device need no TSX: `"taps": [{ "at": 1200, "screenUv": [0.5, 0.62], "device": "d1" }]`
  pulses a ring at that screen point (reference/media.md, "Taps"). In TSX, put a
  `<TapRing at={1200} />` inside a `DeviceScreenAnchor`.
- Inside a Device, `useDeviceScreen()` gives `{ rect, coverRect, local(u, v) }`. Outside one,
  `deviceScreenPoint(model, u, v, { position, rotationDeg, scale })` is a static device's
  world point and `deviceScreenRect(model)` its rect.
- `./kb check` warns when a scene uses a model the running app renders as the Android
  fallback, and when TSX passes `position`, `rotationDeg` or `ground` to a `Device` in a
  scene with a `deviceLayout` (the layout owns the pose).

## Motion presets

| Preset | Motion | Params (defaults) |
| --- | --- | --- |
| `none` | Holds | |
| `push-in` | Starts at 86% and turned, eases to full framing | `durationMs` (1200) |
| `turntable` | Continuous spin about Y (sways instead in Present holds) | `degPerSec` (18) |
| `float` | Rises and settles above its rest pose | `amplitude` (0.12), `hz` (0.4) |
| `tilt-reveal` | Swings flush from a tilted start | `durationMs` (1000) |

## Shadows

| Id | Look | Lands on |
| --- | --- | --- |
| `soft` | Soft contact (default) | floor |
| `long` | Long and smooth, low rake | floor |
| `studio` | Twin studio, opposed key and fill | floor |
| `overhead` | Tabletop pool | floor |
| `backlight` | Thrown toward the camera | floor |
| `feather` | Pool only | floor |
| `window` | Wide and airy | floor |
| `wetfloor` | Short sharp forward fade | floor |
| `sun` | 45 degree sweep | plane behind |
| `drop` | App-store card offset | plane behind |
| `none` | No presentation shadow | |

The presentation shadow follows the device's real silhouette, lid and float. It is
independent of a staged floor's real shadows; use `none` when the stage's own shadow
is enough.

## Several devices: `deviceLayout`

```json
"deviceLayout": { "preset": "toe-in", "gap": 0.35, "devices": { "d2": { "offset": [0, 0, -0.3], "scale": 1.1 } } }
```

| Preset | Arrangement |
| --- | --- |
| `row` | Flat line-up facing the camera |
| `toe-in` | Row with outer devices turned toward centre |
| `arc` | Shallow arc, outer devices receding |
| `cascade` | Fanned cards stepping across and back |
| `hero` | Device 1 forward, the rest flanking behind |
| `depth-pair` | Two devices front and back (exactly 2, else `toe-in`) |

- While the block exists, each device's own `position`, `rotationDeg` and `scale` are
  ignored (`ground` still applies); delete the block to revert.
- `gap` is edge-to-edge world units at 16:9; narrower aspects compress the whole layout.
- Per-device deltas: `offset` and `rotationDeg` add, `scale` multiplies.
- Each distinct video is its own decode stream; two is comfortable.

## Keyframed devices: `deviceTrack`

```json
"deviceTrack": {
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { "hero": { "offset": [0, -0.4, 0], "scale": 0.9 } } },
    { "id": "k2", "tMs": 1400, "pose": { "hero": { "offset": [0, 0, 0], "rotationDeg": [0, -18, 0] } } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "outCubic" }]
}
```

Poses are DELTAS on the resolved placement or layout: `offset` and `rotationDeg` add,
`scale` multiplies; `lidDeg` and `foldDeg` are absolute. Absent fields hold the rest
value. Motion presets layer on top. Track rules: reference/sidecar.md.

## Foldables (`iphone-duo`)

- `media` is the inside display, `coverMedia` the outside one.
- `foldDeg`: 0 closed to 180 open flat (default 180). Key it in `deviceTrack` for an
  unfold: `{ "foldDeg": 0 }` to `{ "foldDeg": 180 }`.
- Power hands from the outside display to the inside one around 45 degrees;
  `bothScreensOn: true` lights both at every angle.
- `foldTransition`: `{ switchDeg (45), enabled (true), intensity, blur, darken }`
  (0..1) shapes the blur handover between displays.
- `media.startOn: "open"` counts the inside video's `startMs` from the moment the fold
  opens. Preset: `duo-unfold`.

## 3D objects

```json
"objects": [{ "id": "o1", "objectId": "bitcoin-coin", "placement": { "position": [1.6, 0, 0], "rotationDeg": [0, 20, 0], "ground": true } }]
```

Bundled: `avocado`, `bitcoin-coin`, `candlestick`, `candlestick-amber`,
`ethereum-coin`. Workspace objects are `ws:<slug>` from
`~/Kookaburra Cut/objects/<slug>/object.json` (imported in the app). Objects auto-fit
to their manifest height; placement works like a device's. Unknown ids render nothing.
TSX may render them with `useSceneObjects()` and `<StagedObject spec={o} />`.

## Before and after: `compare`

Side A is the scene as authored; `compare.b` overrides side B; a mask reveals B.

```json
"compare": {
  "b": { "media": { "hero": { "src": "assets/home-new.jpg", "kind": "image" } } },
  "mask": { "type": "linear", "angleDeg": 70, "softness": 0.02 },
  "value": 0.9,
  "track": {
    "keys": [{ "id": "k1", "tMs": 800, "pose": { "value": 0.9 } }, { "id": "k2", "tMs": 3400, "pose": { "value": 0.1 } }],
    "segments": [{ "from": "k1", "to": "k2", "ease": "inOutCubic" }]
  },
  "chrome": { "line": { "width": 2, "colour": "muted" }, "grip": { "style": "dot", "size": 1 }, "chips": true }
},
"animatedTrack": "compare"
```

| Field | Values |
| --- | --- |
| `b.media`, `b.coverMedia` | Per device id screen media for side B |
| `b.deviceAppearance` | Per device id `{ colour, shadow }` |
| `b.themeId`, `b.background`, `b.backdrop`, `b.lighting` | Side B look (a day/night or light/dark story) |
| `mask.type` | `linear` (slider; `angleDeg` is the line, 90 vertical), `circle` (spotlight from `center`), `radial` (sweep around `center`), `blend` (ghost fade) |
| `mask.softness`, `mask.center` | Edge feather (default 0); centre (default [0.5, 0.5]) |
| `value` | Static divider 0..1 when there are no keys (default 0.5); revealing the after runs 1 to 0 |
| `track` | Keys of `{ value, angleDeg? }` |
| `chrome.line` | `{ width (4, in 1080p px), colour (token or hex), softness }` |
| `chrome.grip` | `true` or `{ style: chevrons \| dot \| bar \| arrows, size }`; linear masks only |
| `chrome.chips` | Before/After labels; copy in `text.beforeLabel` / `text.afterLabel` |
| `chrome.tint` | `{ a, b, amount (0.08) }` per-side tints (token or hex) |

Track presets (`./kb catalog compare.presets --json` has the exact keys for a 4 s scene): `reveal`,
`sweep-settle`, `peek`, `hold`. Set `animatedTrack: "compare"` so the app's lane edits
the divider.
