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

## Aim modes

A free pose points the camera one of three ways. All three store `at`, the
baked look point, which is what every fallback lands on:

- **Point**: look at a fixed world position.
- **Tangent**: look along the path the camera travels. Four rules, in order:
  inside a smoothed segment it is the analytic spline derivative; inside a
  straight segment it is the segment's chord; a held key outside any segment
  has no path; and a near-zero derivative or chord (a pair of keys that don't
  move) has none either. Each of those falls back to the baked `at`.
- **Object**: follow something staged — a device by its id, the video window, or
  the screenshot stack. The binding resolves at LOAD; the editor rebakes `at`
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
- **Per-channel easing** — optional overrides for Position, Rotation and Lens.
  "Same as segment" writes nothing at all, so sidecars stay clean. A dolly zoom
  uses this: the lens lags the move, which is the whole trick.

## Tools and shortcuts

Open animation mode from the camera pill. The mode switch decides which tools
are offered:

| Mode | Tools | Keys | Modifier while dragging |
| --- | --- | --- | --- |
| Orbit | Orbit, Pan, Zoom | O / P / Z | ⌥ orbit, ⌘ pan, ⌃ zoom |
| Free | Move, Forward, Look, Tilt | M / F / L / T | ⌥ look, ⌘ move, ⌃ forward |

Field of view is a stepper, never a drag tool. Move is grab-style and holds a
point or object aim, so moving reframes; Forward dollies exponentially and stops
at an aim-distance floor; Look swings the aim about the camera and rewrites the
aim to a point (a deliberate, visible consequence); Tilt banks the frame.

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
for a vertical one, the oversized backing stage for a video window. It is
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
