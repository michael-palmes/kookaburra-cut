# Scene sidecars

Every scene may have `scenes/<stem>.json` beside `scenes/<stem>.tsx` (keyed by FILE
stem, never the `defineScene` id). The sidecar holds everything the app's inspector
edits; the TSX is the composition. Both reload live. A scene without a sidecar is
legal. A sidecar that is not valid JSON, or has a `version` other than 1, is ignored
whole (the scene renders bare); `./kb check` names it. Inside a valid sidecar a bad field
drops alone with a warning.

## Editing

```bash
./kb doc 02-demo get                        # whole sidecar
./kb doc 02-demo get devices                # one key
./kb doc 02-demo set name "Live demo"
./kb doc 02-demo set textStyle.titleSize 1.2
./kb doc 02-demo set background '{"type":"shader","shader":"mesh-gradient","themeColors":true}'
./kb doc 02-demo unset textLook
```

- Values parse as JSON, else as a string (`--string` keeps `"true"` or `"42"` a string).
- Paths walk objects and array indexes: `./kb doc 02-demo set devices.0.media.src assets/new.mp4`.
- `./kb doc S merge '<json>'` is a JSON merge patch: objects merge, `null` deletes, arrays
  replace whole (`@file.json` reads the patch from a file).
- Every write is validated; one that would add errors is refused with the reason.
- Never re-mint existing ids (devices, media, keys): the app and the gizmos select by id.

## Keys

| Key | What it is | Read |
| --- | --- | --- |
| `version` | Always `1` | |
| `name` | Display name in pickers and the inspector | |
| `duration` | `{ "mode": "manual" }` or follow-media (the app syncs the manifest duration to a video) | media.md |
| `text` | Code-owned and embedded copy for `useSceneText` | text.md |
| `managedText` | Inspector-owned items: title, subtitle, bullets, icon | text.md |
| `textLayout` | `{ "align": "left" \| "center" \| "right" }` | text.md |
| `textStyle` | `<key>Color/Font/Size/OffsetX/OffsetY/LineHeight/RotationDeg` | text.md |
| `headerIcon` | Emoji or `assets/` image above a plain scene's title | text.md |
| `textAnimation`, `textAnimationForce`, `textAnimationOverrides` | Text motion | text.md |
| `textLook`, `textLookForce`, `textLookOverrides` | Text style | text.md |
| `themeId` | Whole theme swap for this scene | project.md |
| `background` | Camera-locked fill (colour, gradient, image, video, shader, 3D) | backgrounds.md |
| `backdrop` | World-space staging (floor, gradient, image) | backgrounds.md |
| `lighting` | Scene lighting layer and keyframes | lighting.md |
| `devices`, `deviceLayout`, `deviceTrack` | Devices, arrangement, keyframes | devices.md |
| `objects` | Staged 3D objects | devices.md |
| `compare` | Before/after comparison | devices.md |
| `camera`, `cameraMode`, `cameraRig` | Orbit track, mode switch, free-flight rig | camera.md |
| `motionBlur` | Scene override of the project's motion blur | camera.md |
| `media` | Images and videos (stage, overlay, window hosts) | media.md |
| `layeredScreenshot` | 3D stack of app screens | media.md |
| `terminal`, `website` | Terminal and website panels | media.md |
| `chart` | One data chart | charts.md |
| `frame` | Overlay panel with a cutout | below |
| `stills` | Stills export marks | below |
| `animatedTrack` | Which keyed track the timeline lane edits | below |
| `images`, `videoWindow` | LEGACY, read forward into `media`. Never author | media.md |

Unknown keys and invalid fields are ignored at load and dropped the next time the app
writes the sidecar, so never park notes or experiments in a sidecar.

## What renders without TSX

The host mounts these for EVERY scene, so adding the sidecar block is enough:
`background`, `media`, `devices` (unless the TSX calls `useSceneDevices`), `objects`,
`layeredScreenshot`, `chart`, a title/subtitle from `text.title`/`text.subtitle` or
`managedText` (unless the TSX renders those keys), and compare chips. `backdrop`,
theme lighting and real shadows need a `<SceneStage>` in the TSX.

## Keyed tracks (shared model)

`camera`, `cameraRig`, `deviceTrack`, `lighting`, `compare.track`, `chart.track` and
`layeredScreenshot.animation` all use one shape:

```json
{
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { } },
    { "id": "k2", "tMs": 1200, "pose": { } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "inOutCubic" }]
}
```

- `tMs` is scene-local. Keys at least 17 ms apart.
- Between and outside segments the value HOLDS the latest key at or before t (before
  the first key: the first key). A lone key is a static pose.
- Adjacent segments share their boundary key id; do not duplicate near-identical keys.
- `ease`: `linear`, `jump` (hold `from`, snap to `to` at the segment end: a cut), or
  `in|out|inOut` + `Sine Quad Cubic Quart Quint Expo Circ Back` (for example
  `outCubic`). Unknown eases fall back to `inOutQuad`.
- Angles interpolate as plain numbers: 350 to 10 swings back 340 degrees.

`animatedTrack` picks the lane the app's timeline edits: `camera` (absent), `compare`,
`chart`, `lighting` or `layeredScreenshot`. Only `layeredScreenshot` changes playback:
the stack animation plays and the camera track stands down (its keys stay). Without
it a stack shows its rest pose. Other tracks always play.

## Overlays: the `frame` block

A camera-locked panel with a shaped cutout the scene renders through: what users call an
overlay, a cutout, a slide or a panel. `project.json` `frame` is the deck default for
every scene; a sidecar `frame` merges over it. A sidecar frame WITH a `cutout` stands
alone (no deck needed). A sidecar `cutout` replaces the deck's outright.

```json
"frame": {
  "cutout": { "shape": "rounded-rect", "radius": 0.12, "size": 0.56, "side": "end", "inset": 0.04 },
  "background": "accent",
  "icon": "assets/app-icon.png",
  "chip": { "label": "New", "icon": "circle-check", "colour": "accent" },
  "textAlign": "left",
  "claimsSceneText": true,
  "decorations": [
    { "id": "t1", "text": "Since 2019", "colour": "muted", "face": "body",
      "position": [0.4, -0.55], "size": 0.05, "rotationDeg": -6, "layer": "above" }
  ]
}
```

| Field | Values |
| --- | --- |
| `enabled` | `false` hides the frame on this scene (keeps the styling) |
| `cutout.shape` | `rect`, `rounded-rect`, `squircle`, `circle`, `capsule`, `none` (full panel, no window) |
| `cutout.size` | Share of the split axis the window takes (default 0.56) |
| `cutout.side` | `start` (left or top) or `end` (right or bottom); wide frames split left/right, square and tall split top/bottom, so one config serves every aspect |
| `cutout.inset` | Margin as a fraction of the shorter frame edge (default 0.04) |
| `cutout.radius` | Corner radius for `rounded-rect` (default 0.12) |
| `background` | Theme token (`accent`, `muted`, `text`, `background`), a hex, or `{type: "transparent" \| "color" \| "gradient" \| "image"}` |
| `icon` | Emoji or `assets/` image above the title; `""` hides an inherited icon |
| `chip` | `{ label, icon?, colour? }`; icon is a chip icon id (`./kb catalog chipIcons`), an emoji or an asset |
| `chart` | `true`, `false` or `{ height, position: "below" \| "replace" }`: hosts the scene's `chart` with `mount: "panel"` |
| `decorations` | Images (`src`, `shape: "circle"` optional) or text (`text`, `colour`, `face`, `font`, `lineHeight`); `position` -1..1 frame-relative, `size` a fraction of frame width (image width or font size), `layer` `above` (over the window) or `below` |
| `textAlign` | `left`, `center`, `right` |
| `claimsSceneText` | default `true`: the panel takes the scene's title, subtitle and bullets and suppresses the in-world headline; `false` keeps the panel as chrome only |

- `shape: "none"` is the full-panel slide; give it copy or it is a flat fill.
- A transparent panel paints no surface: the scene shows full-bleed behind the content.
- Text sizes: `textStyle.chipSize`, `textStyle.iconSize`, `textStyle.frameIconSize`
  (multipliers), plus the normal title/subtitle styles.
- Bullets come from a managed bullets item (or legacy `text.bullets` split on new lines).

Presets: `overlaystart`, `overlayend`, `overlaypanel`.

## Stills (PDF handout and PNG images)

The app exports stills as a PDF (one page per still, searchable text) or a zip of PNGs.
Which frames become pages is sidecar data:

```json
"stills": { "marksMs": [2400, 5200] },
"camera": { "keys": [{ "id": "k3", "tMs": 3000, "pose": { }, "still": true }], "segments": [] }
```

- Absent `stills`: one automatic still at the scene's settled moment (after text,
  camera, device, chart and media motion land).
- `marksMs`: whole, unique, ascending scene-local ms; any mark replaces the automatic
  still. Keep marks clear of transitions (the nearest clean frame is used instead).
- `"exclude": true` leaves the scene out.
- `"still": true` on a `camera` or `cameraRig` key marks that key's frame, only on the
  block that drives the scene, and never under `animatedTrack: "layeredScreenshot"`.
  Delete the field to unmark; never write `false`.
- A hand-rolled TSX animation the app cannot see may be caught mid-move by the
  automatic still: add a mark instead. Check a mark with `./kb capture --scene S --at <ms/1000>`.
