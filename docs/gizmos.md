# Gizmos

A **gizmo** is direct manipulation over the preview: drag an item on the stage
instead of typing numbers into the inspector. Every gizmo is editor chrome, it
writes exactly what its inspector fields write, and it is kept out of exported
pixels by construction.

Two families do all the work: a restyled drei `TransformControls` for items that
live in the 3D scene, and one DOM layer for items whose editing is honestly 2D.
Everything else (visibility, pointer routing, the write contract) is shared.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| 3D gizmo | Restyled drei `TransformControls`, one seam | A custom gizmo buys nothing; `PivotControls` stays dead (its pivot-matrix offset broke scale and rotate maths). |
| 2D gizmo | One `Gizmo2D` layer, hosts supply geometry and writes | Text, hero charts and decorations differ only in coordinate space and target field. |
| Visibility | Section scoped: outlines on every item of the open section, handles on the selected one | The canvas follows the inspector, so a click never jumps sections. |
| Selection | Canvas click selects, and the inspector mirrors it | One selection per domain, in a store, both surfaces read it. |
| Camera override | Holding ⌘, ⌃ or ⌥ claims the drag for the camera | Matches the existing mid-drag modifier tools; Shift is reserved for the rotate snap. |
| Guides | Yellow alignment lines, 2D only | Frame centre, safe edges and other items are meaningful in screen space, not in the world. |
| Text rotation | A new `textStyle.<key>RotationDeg` | Move and size already had sidecar fields; tilt did not. |
| Undo | Exactly one history entry per drag | A drag is one act, however many frames it ticks through. |
| Out of scope | Lights and fixtures (helpers stay read only), panel charts (layout driven), cutout-hosted text, layered screenshot and video window (their own overlays) | Nothing here has free placement to drag, or it already has a bespoke surface. |

## The two families

| Item | Family | Host | Modes | Writes |
| --- | --- | --- | --- | --- |
| Staged object | 3D | `ObjectPrimitive` → `SceneGizmo` | move / rotate / scale | `objects[].placement` |
| Device | 3D | `DeviceGizmo` → `SceneGizmo` | move / rotate / scale | `deviceLayout` delta, else `devices[].placement` |
| Stage image | 3D | `StageImageGizmo` → `SceneGizmo` | move / rotate / scale | `images[].stage` |
| Staged chart | 3D | `Chart.tsx` (`StagedChart`) → `SceneGizmo` | move / rotate / scale | `chart.placement` |
| Scene text, per key | 2D | `TextGizmo` → `Gizmo2D` | move / size / rotate | `textStyle.<key>OffsetX,OffsetY,Size,RotationDeg` |
| Hero chart | 2D | `ChartHeroGizmo` → `Gizmo2D` | move / scale | `chart.style.offset`, `chart.style.scale` |
| Overlay image | 2D | `OverlayImageGizmo` → `Gizmo2D` | move / resize / rotate | `images[].overlay` |
| Panel decoration | 2D | `DecorationGizmo` → `Gizmo2D` | move / resize / rotate | `frame.decorations[].position,size,rotationDeg` |

`SceneGizmo` (`src/engine/SceneGizmo.tsx`) is the only place drei's
`TransformControls` is mounted: one `size` (`GIZMO_SIZE`, 1.8), one palette, one
registration. The palette swap runs once at mount (three-stdlib builds every
mode's materials up front) and is keyed by each material's own colour rather than
by handle name, because one material serves several handles. It writes
`tempColor` as well as `color`, since the stock gizmo restores handles from
`tempColor` every frame. The canvas-side palette is `src/engine/gizmoTokens.ts`
and mirrors the `--gizmo-*` custom properties in `styles.css` by hand: three
cannot read CSS variables.

The device is the awkward one. No group inside `Device` carries the whole
placement pose (float, spin and the intro presets ride between them), so
`DeviceGizmo` attaches the control to an invisible proxy group mounted as a
sibling of the device root, which does. The drag flows back through React state
(the clock re-renders `Device` every frame and would stomp a mutated group), and
the proxy re-syncs only when the COMMITTED placement changes, so the handles hold
the drag across the async sidecar write instead of snapping back for it. The
write result is acknowledged by commit id: success releases the matching local
preview after the committed document lands, and failure restores only that
device. A comparison's B side cannot consume the acknowledgement.

`Gizmo2D` (`src/ui/gizmo/Gizmo2D.tsx`) draws a box per item, four corner resize
handles, a rotate knob and the guides, and owns the pointer plumbing. It owns no
write path and no coordinate system: a host supplies each item's live frame (a
rotated rectangle in client pixels, recomputed once per animation frame) and
receives gestures back. That one recompute covers playback, a scrub, a camera
keyframe, a rig pose, a transition, a live preview mid-drag, a window resize and
troika's first typeset landing.

## Section-scoped visibility

`gizmoSections.ts` maps inspector drill ids to gizmo domains by prefix
(`device` → devices, `image` → images, `objects`, `chart`, `text`,
`frame.decorations`), reading the whole drill stack top down so a drill carrying
another family's id (Shadow lives under Device as `style.shadow`) still reads as
the section the user drilled through. `useGizmoSectionOpen(domain)` is a boolean
selector, so moving between drills inside one family re-renders nothing.

While a section is open:

- **Every item of that domain draws an outline.** `SceneOutline` draws corner
  brackets (three arms per corner for a box, two for a flat rectangle such as the
  staged chart; arm length is 0.28 of the shortest half-extent, so a 0.07-deep
  phone never draws arms longer than it is deep). White at 0.35 idle and 0.6
  hovered, accent at 0.9 on the selected item.
- **The item is click-to-select.** Beside the brackets sits an invisible
  (`visible={false}`) hit mesh with r3f pointer events. Three's raycaster ignores
  `visible` and every scene is mounted at once, so both the cursor and the
  pointer-down check `nodeDrawn` (an ancestor-visibility walk) first: an
  off-playhead scene's hit box must not advertise a click that pointer-down then
  refuses.
- **The selected item shows handles.** 3D hosts mount `SceneGizmo`; the 2D layer
  shows resize handles and the rotate knob on the selected box only.
- **Selection is mirrored.** A canvas click writes the domain store, and the
  inspector follows: the device pills change, the Text drill scrolls to the key
  and marks it with a left rule. Touching a text field selects that key, so the
  handles follow the caret.

A comparison's B side gets no edit target anywhere. It mounts the same items at
the same scene index, so a write from there would land on the A doc.

## Pointer routing

The whole batch hangs off one pure function, `routePointer`
(`src/ui/gizmo/gizmoRouting.ts`):

| Condition (first match wins) | Owner |
| --- | --- |
| A camera drag is in flight | camera |
| A gizmo drag is in flight | gizmo |
| No camera tool armed | gizmo |
| ⌘, ⌃ or ⌥ held | camera |
| A gizmo handle is under the pointer | gizmo |
| Otherwise | camera |

A drag in flight never changes owner: a modifier pressed mid-drag must not yank
the pointer away, in either direction. Shift is deliberately excluded from the
override, it is the rotate snap.

Two mechanisms enforce the table, because the two families sit on opposite sides
of the camera tool surface.

**3D handles are BELOW it.** `TransformControls` listens on the canvas, so the
camera overlay has to stand down: `useGizmoYield` hover-raycasts the registered
pickers and the overlay takes `.is-inert` (`pointer-events: none`) when the
router says "gizmo". Its listeners sit on `window` in the capture phase, because
an inert overlay stops receiving its own events, and hover is re-tested at the
parked pointer whenever the tool arms (tools arm from the keyboard, with no
pointermove) or the pickable set changes. As a second line of defence the overlay
also bails on `gizmoClaimedPointer()`, which reads the pointer-down latch
synchronously, so a stale hover can never fly the camera on top of a gizmo drag.

**2D layers are ABOVE it.** `.gizmo-layer` is `pointer-events: none` and only
`.gizmo-hit` children turn events back on, so handle drags never reach the camera
overlay and empty-area drags fall through to it with no code at all. While a
camera tool is armed and no drag is in flight, a held override adds
`.camera-override`, which stands the hit elements down too. The layer stands up
whole (`pointer-events: auto`) for the length of a rotate drag: a captured pointer
does not carry its cursor, so the layer has to be hit-testable for the rotate
cursor to hold.

Inside a 2D drag, ⌃ suppresses snapping and hides the guides, and Shift snaps a
rotation to 15°.

## Registries and coordinate spaces

Two module registries, both the `sceneHostRegistry` idiom (a `Map`, plain
functions, no store, keyed by a per-instance `useId` so mount churn cannot clobber
entries). Neither is READ by the export path, and only one is written from it:
`AnimatedHeadline` and `Chart` publish into `gizmoTargetRegistry` on every mount,
an export included, so registration has to stay cheap. `gizmoRegistry` is written
only by `SceneGizmo`, which an export never mounts. Every reader is editor chrome
or preview capture.

| Registry | Published by | Read by | Carries |
| --- | --- | --- | --- |
| `gizmoRegistry.ts` | `SceneGizmo` | The camera overlay's yield hook, `SceneOutline`, preview capture | Domain, item id, scene index, the ACTIVE mode's picker group, the control root, a claim callback |
| `gizmoTargetRegistry.ts` | `AnimatedHeadline`, `Chart` (hero mounts) | `TextGizmo`, `ChartHeroGizmo` | The node whose `matrixWorld` places the item, plus its measured local rect |

`gizmoHandleAt(ndc)` raycasts only the active mode's picker group (three's
raycaster ignores `visible`, so the idle modes would hit too), against the live
preview camera and the canvas box, never an overlay's box, so the NDC it uses is
the NDC r3f's own event raycaster would use.

Three coordinate spaces are in play:

- **The 3D family needs none.** `TransformControls` owns its own projection and
  hit testing.
- **World-space 2D items project through the LIVE camera.** Scene text and hero
  charts take the node's `matrixWorld` and project four corners plus the node
  origin (which is the rotate and resize pivot), so a box tracks a rig pose, a
  camera keyframe and a transition. Drags invert by ray-plane intersection at the
  item's own z, which is exact under any pose. `frameFromQuad` fits the best
  rotated rectangle: exact whenever the projection is affine (every default
  framing), a mild approximation under a rolled or heavily tilted rig.
- **Panel-space items use a fixed linear map.** The compositor draws the overlay
  panel from the BASE pose, so decorations map their `-1..1` position straight
  onto the stage rect, and panel headlines map world units against
  `format.frame` (`panelToStagePx`). No camera is involved. A panel group is left
  hidden between compositor passes, so the drawn check for panel text stops its
  ancestor walk at the panel.
- **Cutout-hosted text is excluded.** It renders into a cutout-sized target at a
  different `camera.aspect` and is then keyed into the cutout's pixel rect, so the
  stage camera is not the projection that put it on screen. The Text drill still
  edits it numerically.

## What a drag writes

Everything lands in the scene sidecar, in the same fields and at the same
precision as the inspector's own controls.

| Gizmo | Field | Precision and range |
| --- | --- | --- |
| Object / staged chart | `placement.position,rotationDeg,scale` | The group is read back at pointer-up, so the doc lands exactly what is on screen; scale is uniformised to the furthest-moved axis |
| Device | `deviceLayout` delta `offset,rotationDeg,scale` when a layout block is live, else `placement` | `committed = authored + (dragged - rendered)`, scale multiplying; 3dp positions, 1dp degrees, 3dp scale, minimum scale 0.01 |
| Stage image | `images[].stage.position,rotationDeg,size` | 2dp positions and size, 1dp degrees, clamped to the inspector ranges |
| Overlay image | `images[].overlay.position,size,rotationDeg` | 2dp positions and size, 1dp degrees, clamped to the inspector ranges |
| Text | `<key>OffsetX/OffsetY`, `<key>Size`, `<key>RotationDeg` | 2dp world units, whole percent (0.01..10 multiplier), 1dp degrees; a neutral value deletes the key so the scene's own layout resurfaces |
| Hero chart | `chart.style.offset`, `chart.style.scale` | 2dp, clamped to the resolver's own ±20 and 0.2..3, so a drag can never write a value the resolver would silently clamp back |
| Decoration | `position`, `size`, `rotationDeg` | Size clamped 0.02..1.5 of the frame width |

Differencing the device drag against the RENDERED pose (what the gizmo started
from) rather than the authored numbers is what survives everything the render does
on top: the portrait scale factor, templates' frozen multipliers, the layout
resolver's composition and the ground clamp.

Text rotation is the one new field. It writes the TURN the pointer made, not the
box's screen angle, so a tilt the scene itself authored stays out of the sidecar.

**One history entry per drag**, by two routes:

- 3D hosts post a `pendingCommit` to their domain store rather than writing the
  doc themselves, because `patchDoc` lives in the inspector's DOM tree, not the
  canvas. `SceneTab` subscribes, clears the pending commit (even for another
  scene, so an unclaimed drag is dropped rather than landing late) and writes
  once.
- Overlay images use the same Image-store route as Stage images. Live ticks stay
  in `previewPlacement`, and pointer-up posts one `pendingCommit`, so changing
  host never changes the image's history contract.
- Image motion is neutralised on all mounted editor sides while the Image domain
  owns the Stage, keeping comparison renders, outlines, hit areas and handles on
  the authored placement. Leaving the domain restores sampled motion immediately.
- Device motion is neutralised on all mounted editor sides while the Device
  domain owns the Stage for the same reason. Export always samples the authored
  motion.
- Other 2D hosts share `useGizmoDocWrite`: every tick previews in memory (no disk
  write, no history) so the item tracks the pointer, and pointer-up lands one
  `writeSceneDoc` plus one `pushHistory` against the doc the drag STARTED from, so
  undo returns to the pose before the drag, not to the last preview tick.

A press that never moved a handle costs nothing anywhere: the 3D hosts
check a dragging flag set on the first `onObjectChange` (three-stdlib fires
`mouseUp` for a zero-movement press too), and `Gizmo2D` ends with a null
gesture.

A grounded device stays clamped for X, Z, rotation and scale drags. Once a Y
drag leaves the grounded start, the live preview follows the proxy and the one
commit clears `placement.ground`. Both raw placement and layout-delta writes
land at the exact visible Y.

## Export safety

This batch touches render-path files (`Device.tsx`, `ObjectPrimitive.tsx`,
`Chart.tsx`, `AnimatedHeadline.tsx`), so it gates through `docs/determinism.md`.
Five independent guards keep gizmos out of exported pixels:

1. **Mount gates.** A 3D gizmo mounts only while its domain store holds that
   selection and the section is open. The 2D layers mount only for a workspace
   project, with the matching section open, and never while exporting or in an
   autorun.
2. **Export state is held before `exportPreamble` clears the selections**
   (objects, charts, devices, images), so synchronous inspector repair cannot
   reselect one before frame zero. The lifecycle transition restores inspector
   selection after completion and releases safely on preload failure.
3. **Layer discipline.** Outline brackets ride `HELPER_LAYER`, which the exporter
   disables on the camera for the whole run; the click-to-select mesh is
   `visible={false}`, which `WebGLRenderer.projectObject` returns on, so it never
   enters a render list at all.
4. **`isExporting()` belts.** The device drag pose is ignored outright while
   exporting.
5. **The 2D layers are DOM.** They sit above the canvas, so `gl.readPixels` cannot
   see them.

Preview captures (scene thumbnails, welcome-card snapshots) read the same live
canvas the editor chrome draws into, so they scrub it for their one frame:
`setCapturingPreview` makes the compositor drop `HELPER_LAYER` from the camera,
and `hideGizmoHandles()` hides every registered control root (the handles draw on
layer 0, which no camera filter reaches) and restores each one's previous
`visible`.

The rotation field is null-for-legacy: a `RotationDeg` that is absent or 0 adds
NO rotation prop on any of `AnimatedHeadline`'s three render paths, so an
untouched project's tree is unchanged, and rotation is deliberately not folded
into the layout inputs, so the title cascade and the panel column never reflow
around a tilt. Values are folded into (-180, 180] at parse time (`normaliseDeg`),
so a wrapped drag and a hand-typed 400 land on the same value. Each package gated
showcase-tour Verify ×2 in 16:9 EQUAL, including with the full text-rotation diff
in the tree.

## Where the code lives

| Concern | File |
| --- | --- |
| Shared mode type | `src/engine/gizmoMode.ts` |
| Palette, size, restyle | `src/engine/gizmoTokens.ts` (+ `--gizmo-*` in `src/styles.css`) |
| 3D control seam | `src/engine/SceneGizmo.tsx` |
| Picker registry, stage camera and rect, capture hide | `src/engine/gizmoRegistry.ts` |
| Outlines and click-to-select | `src/engine/SceneOutline.tsx`, `gizmoOutline.ts`, `gizmoVisibility.ts` |
| Section map | `src/engine/gizmoSections.ts` |
| 2D target registry | `src/engine/gizmoTargetRegistry.ts` |
| 2D layer, geometry, projection | `src/ui/gizmo/Gizmo2D.tsx`, `gizmo2dMath.ts`, `gizmo2dProject.ts` |
| Routing, modifiers, camera yield | `src/ui/gizmo/gizmoRouting.ts`, `modifierKeys.ts`, `useGizmoYield.ts` |
| Write helpers | `src/ui/gizmo/gizmoDocWrite.ts`, `textGizmoWrite.ts`, `chartGizmoWrite.ts`, `src/toolkit/device/gizmoCommit.ts` |
| Image writes | `src/toolkit/media/imageGizmoCommit.ts`, `src/engine/imageEditStore.ts` |
| Hosts | `src/ui/TextGizmo.tsx`, `src/ui/ChartHeroGizmo.tsx`, `src/ui/DecorationGizmo.tsx`, `src/ui/ImageOverlayGizmo.tsx`, `src/toolkit/device/DeviceGizmo.tsx`, `src/toolkit/media/StageImageGizmo.tsx`, `src/toolkit/objects/ObjectPrimitive.tsx`, `src/toolkit/chart/Chart.tsx` |

## Open edges

- Right-click over a live 3D handle no longer reaches the camera context menu
  while the overlay is inert.
- If playback slides the world under a parked pointer, the first gesture from
  that pixel can be dropped (never misrouted). Closing it would need a per-frame
  raycast during playback, which is not worth the cost.
- Layered screenshot and video window keep their own overlays; folding them onto
  `Gizmo2D` is a later job.
