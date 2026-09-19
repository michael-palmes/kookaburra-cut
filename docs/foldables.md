# Foldables

How a folding device works in Kookaburra Cut: two displays, a hinge you can pose
and keyframe, and the auto screen power that follows it. The iPhone Duo is the
first; everything here is keyed on the catalogue's `fold` spec, so a second
foldable is a catalogue entry and an asset export, not new engine work.

Read this before touching `src/toolkit/device/foldPose.ts`,
`src/engine/foldTransition.ts`, `src/engine/deviceScreens.ts`,
`src/ui/inspector/foldEditorModel.ts` or `scripts/blender-duo-prepare.py`.

## The model

A foldable's catalogue entry (`src/toolkit/device/catalog.ts`) adds three things
to a normal device:

| Field | Meaning |
| --- | --- |
| `screen` | The primary display, as on every device. On a foldable it is the **inside** one |
| `coverScreen` | The **outside** display, lit when the device is closed |
| `fold` | The hinge: the glb clip to sample, the open and default angles, which side the static half sits on, a half's width, and which edge of the outside display meets the hinge |

Primary plus cover was chosen over a list of screens: `media` is read at about
twenty five sites, and the inside display matches the open body's aspect, which
layout and object presets already lean on.

`form: "foldable"` drives the glyphs. It is **not** a laptop: only
`form === "laptop"` means that. `lid` presence still means "has a lid control".

## The sidecar

```jsonc
{
  "devices": [{
    "id": "hero",
    "model": "iphone-duo",
    "media":      { "src": "assets/inside.mp4",  "kind": "video", "startOn": "open" },
    "coverMedia": { "src": "assets/outside.mp4", "kind": "video" },
    "foldDeg": 0,                  // 0 closed, 180 open flat (the default)
    "bothScreensOn": false,        // true lights both displays at every angle
    "foldTransition": { "switchDeg": 45 }
  }],
  "deviceTrack": {
    "keys": [
      { "id": "k1", "tMs": 900,  "pose": { "hero": { "foldDeg": 0 } } },
      { "id": "k2", "tMs": 2200, "pose": { "hero": { "foldDeg": 180 } } }
    ],
    "segments": [{ "from": "k1", "to": "k2", "ease": "inOutCubic" }]
  },
  "compare": { "b": { "coverMedia": { "hero": { "src": "assets/after-out.mp4", "kind": "video" } } } }
}
```

- `foldDeg` is absolute, like `lidDeg`: a key that omits it holds the other
  end's, so one keyed angle still eases from the device's own.
- `SCENE_DOC_VERSION` stays 1. `parseDeviceTrack` and `parseCompare` are
  allowlists, so a new pose or side B field must be added to the parser or it is
  dropped on load and erased on the next save.
- An empty display is black. There is no mirroring and no wallpaper.
- Every read and write of a display's media goes through
  `src/engine/deviceScreens.ts` (`deviceSlotMedia`, `compareSlotMedia`, their
  setters, `deviceVideoSources`, `deviceHasFollowVideo`). Do not grow a second
  `coverMedia` branch anywhere else. Its side B setter mutates in place, because
  callers hold references to `compare.b`.
- Rust needs no media changes: unused-media, copy and pack scans walk every JSON
  string. `remint_scene_doc_ids` does remap `compare.b.coverMedia` and the device
  track's pose keys, so a duplicated scene keeps its fold animation.

## The rig and the clip

`scripts/blender-duo-prepare.py` exports the glb (details in
`src/assets/models/README.md`). The contract the app relies on:

- One clip, named by `fold.clip`, keyed **one frame per degree**: frame 0 closed,
  frame 180 open flat, so clip time is `foldDeg / fold.degPerSecond`.
- The camera half is baked static (the root bone is counter-keyed and the script
  asserts it at every frame). Closed and open therefore both face glTF +Z.
- A fan of fractional bend bones curves the inside display through the hinge
  instead of creasing it.

`Device` samples the clip's tracks directly in a layout effect
(`bindFoldClip`): no `AnimationMixer`, which carries state between frames, and no
`useFrame`, which does not fire during export. A pose is a pure function of the
angle. Only a device with a `fold` spec pays for `SkeletonUtils.clone`; every
other device keeps `scene.clone(true)` and an untouched scene graph. Skinned
meshes set `frustumCulled = false`, since they cull against rest-pose bounds.

Keyframe eases such as back and elastic overshoot, so the angle is clamped to
the hinge's travel where it is applied (`clampFoldDeg`).

## Staying centred

With the camera half static, a closed device covers only that half.
`foldCentreOffset` shifts the device by half a panel on a smooth
cos²(θ/2) curve, so it sits on its own origin both closed and open. The exact
bounds centre kinks at 90°, which reads as a jolt in motion. Camera aims and
grounding stay valid because the visible mass stays on the group origin.

`layoutWidth` is the **open** width: layout presets reserve the open footprint.
Height is fold-invariant, so height-fit from the rest pose is safe.

## Auto screen power

`foldScreenLevels` (`src/engine/foldTransition.ts`) hands brightness from the
outside display to the inside one across a window around the switch angle:

| Constant | Value | Meaning |
| --- | --- | --- |
| `FOLD_SWITCH_DEG` | 45 | Default handover angle, overridable per device as `foldTransition.switchDeg` |
| `FOLD_POWER_WINDOW_DEG` | 15 | Half-width of the smoothstep handover |

The switch angle is clamped a window's width from both ends, so closed is always
wholly the outside display and open wholly the inside one. `bothScreensOn`
returns 1 for both. These constants are export contract.

The level reaches a display through its material colour. Video binds land
asynchronously, after `Device` has set the frame's brightness, so
`ScreenVideo.onBound` reads a level ref instead of forcing white. Never set a
screen material's colour directly.

## Start when opened

`media.startOn: "open"` (inside display only) counts the video's `startMs` from
the moment the fold first reaches the switch angle. `foldOpenedAtMs` steps the
frames that will actually render rather than solving the ease, so it is exact
and survives eases that overshoot. A device that starts open resolves to 0; one
that never opens falls back to the plain start delay.

## Shadows

The projector casts a foldable as two upright panels (`foldSlabs` in
`shadowProjector.ts`): the camera half static, the cover half yawed about the
vertical hinge that runs down their shared inner-face plane
(`shadow.fold.hingeZ`). Both ride the auto-centre shift. The yaw basis is its own
branch, so every other device's arithmetic is literally unchanged, and a test
pins legacy slabs deep-equal. The sun hull stays inside `SUN_HULL_MAX` through
the whole fold.

## The inspector

The device drill-in shows one media group per display ("Inside screen",
"Outside screen"; single-screen devices keep "Screen") and a **Fold** group:

- four presets, Closed 0, Flex 90, Book 120 and Open 180, beside a 0 to 180
  slider;
- **Unfold** and **Fold**, which add a tuned pair of keys at the playhead
  (1.3 s, `inOutCubic`) seeded with what every device is showing, so nothing else
  moves; they refuse inside an existing animation;
- foldable poses, a rotation and an angle together: Book upright, Tent, Back.
  Tent is solved, not eyeballed (hinge horizontal on top, the panels' bisector
  straight down) and switches both screens on, since it faces the outside display
  out while folded past the power switch;
- Keep both screens on, and on the inside display, Start when opened.

Once a scene keyframes its devices the keys own the fold, so a plain write to
the device would show nothing. `foldEditorModel.ts` routes every edit to the key
nearest the playhead, the way a gizmo drag shapes an animation, and the slider
shows that key's angle rather than an in-between value it could not set.

## Clean builds

Without the licensed glb the Duo is hidden from pickers and a saved one renders
as the portrait Android. `fallbackScreenMedia` then leads with `coverMedia`,
because the inside media is landscape and would crop badly.

## Authoring tips

- For the "app grows into the big screen" look, make the outside media match the
  right-hand portion of the inside media, as the `duo-unfold` preset's sample
  clips do.
- Landscape Simulator recordings carry a rotation flag rather than rotated
  pixels. The media probe honours it (`display_dimensions` in `media.rs`).
- Media is fixed to its panel, so in Tent the outside media appears sideways.
  Record it rotated if that pose matters.
- Two videos double the clip decode cost, the measured preview bottleneck. Probe
  before blaming anything else.

## Adding another foldable

1. Export a glb that meets the clip contract above, with distinct material names
   for the two displays, and assert names, UVs, skin and clip post-build.
2. Add the catalogue entry with `coverScreen`, `fold`, `shadow.fold` and measured
   `layoutWidth` (open), then the `modelUrl.ts` constant (named `*_GLB`, which the
   release guard reads) and the availability row.
3. Render card art from the built glb if a finish is derived.
4. Gate: a fixture Verify ×2, then `pnpm gate:merge`.
