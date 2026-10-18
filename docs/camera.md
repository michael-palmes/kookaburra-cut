# Camera

How a scene's camera is authored and what it guarantees. The determinism
contract lives in `docs/determinism.md` ("Per-scene camera", "Camera rig"); the
locked calls and their whys are in `docs/decisions.md`. This page is the
authoring view.

## Two modes

A scene picks one, via `cameraMode` in its sidecar:

| Mode | Block | A pose is | Good for |
| --- | --- | --- | --- |
| **Orbit** (default, absent `cameraMode`) | `camera` | `{ target, azimuthDeg, elevationDeg, distance }` | Turntables, push-ins, anything circling a subject |
| **Free** (`cameraMode: "rig"`) | `cameraRig` | `{ position, aim, fov?, rollDeg? }` | Fly-throughs, cranes, parallax slides, dolly zooms |

Switching modes never deletes the other block's keys, and a scene in Free mode
with no rig keys falls straight through to its orbit track, so flipping the
switch before authoring anything cannot move the camera. The precedence is
**rig, then orbit, then the project-level track, then the base pose**.

Convert between them from the Camera drill-in. Orbit to free is always
available and never moves the shot. Free to orbit is offered only when every
key aims at a point or an object (a tangent aim has no target to orbit) and
drops fov and roll, which orbit has nowhere to keep.

## Composition order

Every frame's camera is composed in one fixed order, in `engine/sceneCamera.ts`
and `engine/cameraKicks.ts`, identically in preview, export, captures, stills
and Present:

1. **Mode select.** `cameraMode` picks the block; rig mode with no rig keys
   falls through to orbit (`sceneCameraTracks`). A scene whose animated track is
   the layered screenshot contributes no camera at all, kicks included.
2. **Fallbacks.** Rig, then orbit, then the project-level track sampled at
   global time, then the base pose. A project with no scene
   track and no kick anywhere skips the plan and runs the legacy
   `applyCameraTrack`.
3. **Fov and roll ownership.** Fov comes from a rig key that authors it, else
   the project-level track; orbit poses never own fov. Only rig keys carry roll.
4. **Kicks.** The sidecar's `cameraKicks` add on top of whatever won
   (`applyCameraKicks`). `sceneCameraPose` returns steps 1 to 4 for one scene,
   the pose that renders. See [Kicks](#kicks).
5. **Shutter sampling.** Motion blur re-runs steps 1 to 4 at each sub-frame
   sample, so kicks blur for free. Samples never cross a camera break, and a
   kick's snap is one. Depth of field stays at the frame instant.
6. **Per-side poses in transitions.** Each side of a transition composes its
   own scene at its own local time; the persistent overlay takes the dominant
   side's pose.
7. **TSX groups are not the camera.** Moving a group in a scene's TSX moves
   content, never the camera. Code that needs the camera's pose calls
   `sceneCameraPose` (kicks included), never its own precedence.
8. **DepthStage overscan.** Bands size from the rig's 64 fixed samples plus
   each kick's peak. Orbit scenes get no overscan, so an orbit kick that pulls
   out (zoom below 1, an offset, roll) can show a band's edge.

## Kicks

A kick is a momentary push: an attack, hold and release envelope applied on
top of whichever pose drives the scene, in either mode or none. It is a pure
function of scene-local time and is never expanded into keys.

```json
"cameraKicks": [
  { "at": "bar:13", "zoom": 1.04, "releaseMs": 300 },
  { "at": 4200, "offset": [0, -0.05, 0], "rollDeg": 1.5, "attackMs": 40, "releaseMs": 500 }
]
```

| Field | Meaning |
| --- | --- |
| `at` | Scene-local ms, or a musical position (`bar:13.3`, `cue:drop`, `section:outro`, with a `+40ms` nudge) resolved against the project's `audio.grid`. The sidecar keeps the position; nothing writes the resolved ms back |
| `zoom` | Magnification at the peak, 0.25..4 (1.04 is 4% in), applied in tan space; fov clamps to 15..90 |
| `offset` | Camera-space shift at the peak (+x right, +y up, +z back), moving the look point with it |
| `rollDeg` | Bank added at the peak |
| `attackMs`, `holdMs`, `releaseMs` | The envelope; attack and hold default to 0 (a snap), release is required |
| `ease` | An `engine/ease.ts` name for both ramps; default `outQuad` |

- **Overlap.** Kicks sum (offsets and roll add, zooms multiply), applied in a
  fixed order: resolved `at`, then position in the list. Opposite rolls cancel.
- **Outside every window nothing changes.** The resolver hands back the very
  same pose object, so a scene with kicks renders its keyframes exactly as
  before whenever no kick is live.
- **Ends.** A scene's camera rests after its last key or its last kick's end,
  whichever is later: Present's first scene and the automatic still settle
  there. Continue from previous scene ignores kicks.
- **Motion blur.** A zero attack is a camera break, so the snap never ghosts
  and the release smears. So are a zero release and the `jump` ease's two snaps.
- **Lane.** Kicks show as read-only markers on the camera lane (their envelope
  glyph and span, with a tooltip naming the position and channels). Author
  them in the sidecar or with `kb doc`.
- **Unresolvable positions** (no grid, an unknown cue) drop that kick with one
  warning; the sidecar keeps it.

The toolkit's `pulse(time, times, { attackMs, holdMs, releaseMs, ease })` is
the same envelope for scene code: a 0..1 level at each time (beats from
`useBeatGrid()`, `useCues()` values), where overlapping pulses take the max.
Object motion blur shifts `useTimeline()`, so give a pulse an attack of at
least one frame (17 ms) or its rise ghosts across the shutter.

## Aim modes

A free pose points the camera one of three ways. All three store `at`, the
baked look point, which is what every fallback lands on:

- **Point**: look at a fixed world position.
- **Tangent**: look along the path the camera travels. Four rules, in order:
  inside a smoothed segment it is the analytic spline derivative; inside a
  straight segment it is the segment's chord; a held key outside any segment
  has no path; and a near-zero derivative or chord (a pair of keys that don't
  move) has none either. Each of those falls back to the baked `at`.
- **Object**: follow something staged (a device or a video media entry by its
  id, or the screenshot stack). The binding resolves at LOAD; the editor rebakes `at`
  whenever the bound object moves, in the same write and undo as the move. A
  binding whose object is gone keeps its last known point and shows a
  broken-link row with a "Bake to point" button, so a deleted device never
  breaks a shot.

## Interpolation

| Channel | How it interpolates | Why |
| --- | --- | --- |
| Orbit target / angles / distance | Plain numbers, no shortest-arc wrapping | Authored values are honoured verbatim, which is what lets `+360` read as a full turn |
| Free position | Lerp, or a centripetal Catmull-Rom when the segment smooths | Rig paths should curve out of the box |
| Aim direction | Slerp of unit vectors | A 180 degree pan-in-place rotates instead of dragging its aim through the camera |
| Aim distance | Logarithmic | A 6 to 1 push reads evenly rather than crawling at the end |
| Roll, fov | Lerp | Nothing subtler is wanted, and both are optional |
| Depth of field: focus (and split's `focusB`) | Logarithmic, in lockstep with aim distance | A manual rack covers ground the way an autofocus flight does |
| Depth of field: blur, range, tilt and style fields | Lerp | Strength, band, glow, centre, angle and squeeze ramps read evenly |

Smoothing shapes POSITION only; the aim still slerps, because splining that too
gives a wandering look direction that is very hard to author against. The eased
progress is the spline's parameter, so timing and path shape stay separate. At
a path's end, the missing neighbour is reflected rather than duplicated, which
makes a lone smooth segment exactly its straight lerp.

Orbit is untouched by all of this: it is separate code on a separate block, so
every project authored before rigs existed renders byte-identically.

## Segments

Each segment joins two keys with an ease (the `engine/ease.ts` names, plus
`jump`). In Free mode a segment also carries:

- **Smooth through keys** — ABSENT means smooth. Turn it off for a deliberate
  straight dolly; the ghost path draws dashed when nothing on the track smooths.
- **Per-channel easing** — optional overrides for Position, Rotation, Lens and
  Focus. "Same as segment" writes nothing at all, so sidecars stay clean. A
  dolly zoom uses this: the lens lags the move, which is the whole trick. A
  whip-pan with a slow focus catch-up is the Focus channel's version of it.

## Depth of field

A `dof` block rides a camera key's pose in BOTH modes, beside `fov`/`rollDeg`
on the rig and beside `distance` on orbit poses. Fields are sparse and carry
FORWARD along the track from the last key that authored them, so a rack focus
restates only `focus`; a key with no `dof` at all changes nothing. The first
authored `mode` ("depth", the default; "tilt"; or a style mode below) is the
scene's; blur can animate, the family cannot swap mid-flight.

- Depth mode: `blur` (0..1), `range` (world units of full sharpness around the
  focus plane) and `focus` (world units). Absent `focus` (or `"auto"`) follows
  the pose's aim distance, rig aim or orbit distance-to-target, recomputed per
  frame, so the aimed subject stays sharp through a whole move with zero keys.
  An object-aim rig autofocuses on the object as it and the camera travel.
  `squeeze` (1..2) ovalises the bokeh discs for the anamorphic look.
- Tilt mode: `blur`, `band` (screen-fraction sharp strip), `offset` (-1..1
  centre) and `angleDeg`. Screen space; depth is not involved.
- Soft mode ("Dream"): `blur` mixes a fixed-kernel diffusion over the sharp
  frame, `glow` (0..1) screen-lifts the blurred highlights. Screen space.
- Radial mode ("Burst"): `blur` scales zoom streaks toward `centerX`/`centerY`
  (-1..1 from screen centre, animatable). Screen space, fixed tap count.
- Directional mode ("Swipe"): `blur` scales a symmetric smear along
  `angleDeg`, screen-true at any aspect. Screen space, fixed tap count.
- Split mode: depth's fields plus `focusB` (a second, always-manual focus
  distance) held sharp at once across a screen divider (`offset` -1..1,
  `angleDeg`; the seam softness is fixed). Focus A still autofocuses; both
  distances rack logarithmically. The split-diopter shot.
- Everything blurs by its true depth, device screens and SDF text included
  (the exact-colour contract holds AT the focal plane, and whatever you focus
  on stays exact). Keep legibility-critical text on or near the focus plane.
- In a project with NO declared effects, dof never regrades the frame: every
  frame renders on the original byte-identical paths, and a pose with active
  blur is then blurred IN PLACE (the finished pixels are copied, the dof
  chain runs over them, depth comes from a dedicated pre-pass). A zero-blur
  frame is bit-identical to the composer-free path, so toggling dof can
  never shift colour or contrast. Projects WITH effects keep composer dof
  (the accepted effects look). Transition and comparison frames render each
  side with its OWN dof before the composite either way, so a rack rides
  into a crossfade instead of releasing at the cut.

The inspector's Depth-of-field group (both camera modes) shows the key's
EFFECTIVE values with the fov-style inherit affordances, a seven-way family
chip row, presets (Subtle, Cinematic, Macro; depth mode) and the Auto/Manual
focus switch. Gate fixture: `ws:dof-spike`; probe pass: `no-dof` (it covers
every mode, since all of them ride the same union).

## Motion blur

Shutter accumulation: a blurred frame averages renders at fixed sub-frame
instants inside its shutter window, so frame N stays a pure function of t (no
history; the escalation path `docs/determinism.md` already sanctioned). It is
exact for everything that moves, per-glyph text and shaders included, which a
velocity buffer is not.

- Settings layer like lighting: the manifest's `render.motionBlur`
  (`enabled`, `shutterDeg` 0..360, `samples` 4 / 8 / 16, `camera`, `objects`),
  then the sidecar `motionBlur` (each present field replaces the project's, so a
  scene can switch blur on while the project is off), then a key's
  `pose.shutterDeg` (the fov pattern, mixed under the Lens ease), then per-item
  `motionBlur: { enabled, amount }` on devices, media, the text animation spec,
  `chart.animation` and `layeredScreenshot`. Absent everywhere is off.
- The window is `shutterDeg / 360` of the frame interval at the run's own fps,
  centred on the frame, sampled at `(k + 0.5) / N - 0.5`. Samples clamp to the
  scene and never cross a camera break (a `jump` segment end, a held key), so a
  cut never ghosts. Transition progress stays on the frame instant, so whip and
  spin transitions are not blurred twice.
- The project's sample count is a floor: a fast camera sweep raises a frame's
  count (up to 32) until neighbouring copies sit within 0.002 frame heights, so
  a whip pan smears instead of strobing. Pure in t: the travel comes from the
  window-edge poses, never the rendered pixels.
- Camera blur re-samples the camera plan per sample inside one committed frame
  (no React work); the camera test is exact pose equality at the window edges.
  Focus (dof) keeps the frame instant's value.
- Object blur moves time per scene through the clock store's shutter sample:
  `useTimeline()` returns the frame instant plus the scene's offset times its
  scale (`MotionBlurContext`, an item's `motionBlur`, or `<MotionBlur amount>`).
  Scale 0 never re-renders. Backgrounds, overlay chrome, device screen clips,
  counters and comparison chips stay on the frame instant. The edge samples render
  first; when they match byte for byte (and the camera holds), the frame stops at two.
- The lane copies each finished canvas into a float pair as exact byte sums and
  writes the rounded mean back, so a still pixel averages to its own byte: the
  forced lane with a zero window hashed `showcase-tour` unchanged.
- Preview: paused frames show the export's blur once the playhead rests (camera
  blur in one render pass, object blur building up one committed sample per
  frame); playback blurs the camera only, behind the Playback options toggle,
  never under Performance. Stills exports and Present never blur.

Gate fixture: `ws:motion-blur-spike`; probe pass: `no-motion-blur`.

## Tools and shortcuts

Open animation mode from the camera pill. The mode switch decides which tools
are offered:

| Mode | Tools | Keys | Modifier while dragging |
| --- | --- | --- | --- |
| Orbit | Orbit, Pan, Zoom | O / P / Z | ⌥ orbit, ⌘ pan, ⌃ zoom |
| Free | Move, Forward, Look, Tilt | M / F / L / T | ⌥ look, ⌘ move, ⌃ forward |

Field of view is a stepper, never a drag tool; in Free mode the stepper is
always on the pill. Move is grab-style and holds a point or object aim, so
moving reframes; Forward dollies exponentially and stops at an aim-distance
floor; Look swings the aim about the camera and rewrites the aim to a point (a
deliberate, visible consequence); Tilt banks the frame.

The pill carries two more Free-mode actions. **Add key** snapshots the applied
pose at the playhead as a single key, chained off the previous key with the
default ease (pose-and-snapshot: fly, then keep what you see). **Frame content**
refits the current key so everything the scene stages sits inside the frame,
keeping the view direction. Bounds come from the scene DOC (device placements,
video media, the screenshot stack, else the content plane), so the fit
resolves identically everywhere; content a scene's TSX places by hand is not
counted. The same button lives in the Camera drill-in.

## The ghost path

In Free mode the stage draws where the camera travels: a polyline (solid when
anything smooths, dashed when everything is straight), a dot per key, and a tick
at the playhead. Dots are draggable in the view plane and commit on release.
Keys behind the camera clamp to an edge marker rather than a wild coordinate.
Selecting a key outlines the rectangle THAT key frames, so each key composes
like a real shot.

All of it is DOM above the canvas, recomputed from the pose the seam would
apply. The export cannot see any of it by construction.

## The bounds advisory

Dots turn amber, and the drill-in shows a line, when a key's frame would run off
whatever the scene stages: the cyclorama's edges for a floor backdrop, the plane
for a vertical one. It is
ADVISORY, always: it never blocks an edit, never clamps a pose, and never stops
an export. A scene that stages nothing has nothing to warn about, and a scene
laid out in depth bands sizes itself, so it passes by construction.

## Depth bands

`<DepthStage>` gives a rig something to fly through: four named slots at pinned
depths — `foreground` (1.8), `content` (0), `midground` (-2.4), `backdrop`
(-5.5). Each band sizes its rect from the scene's own camera travel, so a layer
that fills the frame at rest still fills it at the far end of a flight. A scene
without a rig gets today's static sizing, so adding the container changes
nothing on its own.

```tsx
<DepthStage
  foreground={<ImageCard src="assets/leaf.png" position={[-2.9, 1.3, 0]} width={1.5} />}
  content={<Device model="iphone-15-pro" />}
  midground={<ImageCard src="assets/card.png" position={[2.4, 0.9, 0]} width={1.3} />}
  backdrop={<ImageCard src="assets/sky.png" position={[0, 0.4, 0]} width={5} />}
/>
```

## Presets

The drill-in offers six canned moves, each seeded from the pose the scene shows
now, so a reframed scene keeps its framing. Applying one replaces the track and
sets the mode in a single undo.

| Preset | Mode | What it does |
| --- | --- | --- |
| Push in | Orbit | Eases closer without changing the angle |
| Orbit round | Orbit | A full turn, back where it started |
| Crane down | Free | Drops height while holding the subject |
| Fly through | Free | Four smoothed keys with a tangent aim; reads best in bands |
| Parallax slide | Free | Trucks sideways with the aim held, so depth separates |
| Dolly zoom | Free | Distance against lens, with the lens lagging |

## Cross-scene continuity

The first key of a Free scene can set **Continue from previous scene**. At load,
that key's pose is replaced with the previous scene's final applied pose (an
orbit predecessor bakes through its view). It chains across any number of
scenes and cannot cycle, because the walk runs forward.

Be honest about what it gives you: a continuous camera **path**, not a
continuous **image**. Content still dissolves across a transition; the camera
simply doesn't jump.

## Present looping

A scene's camera track may declare `presentLoop`, which only the Present
window's slideshow mode reads. Preview and export always play the track once and
hold. `smooth` eases back to the first key over `blendMs` through a synthetic
return leg (no smoothing, no channel eases, the default ease); `jump` restarts
each cycle.
