# Before/after comparisons

One scene rendered twice and composited under an animatable mask: side A
("before") is the scene itself, side B ("after") is the same scene with the
`compare.b` overrides applied. Each side carries its own theme, background,
staging, lighting and screen media; only finished pixels mix (the cross-theme
transition rule). The divider is data, sampled on the CPU, never
time-derived in GLSL.

## The sidecar block

Everything lives in the scene document's `compare` field (side A is the doc
itself; deleting the block leaves a valid plain scene):

```jsonc
"compare": {
  "b": {                       // the after side; absent fields match side A
    "media": { "d2": { "src": "assets/after.mp4", "kind": "video" } },
    "themeId": "kookaburra-midnight",
    "background": { "type": "shader", "shader": "mesh-gradient" },
    "backdrop": { "type": "floor", "color": "#101820" },
    "lighting": { /* LightingSpec, replaces the scene layer for side B */ }
  },
  "mask": {
    "type": "linear",          // linear | circle | radial | blend
    "angleDeg": 90,            // linear: the LINE's angle (90 = vertical)
    "center": [0.5, 0.5],      // circle/radial: uv centre
    "softness": 0              // feathered edge half-width; 0 = hard
  },
  "value": 0.5,                // static divider when the track has no keys
  "track": {                   // the divider's keyed track (the camera model)
    "keys": [{ "id": "k1", "tMs": 0, "pose": { "value": 1 } }],
    "segments": [{ "from": "k1", "to": "k2", "ease": "inOutCubic" }]
  },
  "chrome": {
    "line": { "width": 4, "colour": "accent", "softness": 0 },
    "grip": true,              // linear masks only
    "chips": true,             // labels from text.beforeLabel / text.afterLabel
    "tint": { "b": "accent", "amount": 0.08 }
  }
}
```

Rules:

- `media` is keyed by device id and remaps that device's screen on side B.
- Chrome colours are THEME TOKEN names (`background | text | accent |
  muted`), resolved against the scene's theme at plan build; sizes are
  1080-tall reference pixels so they hold across aspects.
- **Value semantics:** the divider's position along the mask's field with
  side A on the origin side. On the default vertical divider, value 0.3
  puts the line 30% in from the left with the before on its left. Circle
  and radial grow the AFTER window with value. `blend` reads value as the
  after's opacity. Revealing the after over time travels 1 to 0 on linear
  masks; a mirrored story is reciprocal keys or the angle plus 180.
- The track rides the shared KeyedTrack model: eased interpolation inside a
  segment, the latest key HOLDS outside (the camera semantics), the static
  `value` with no keys. The divider lane shows in the timeline dock on
  every comparison scene, STACKED above the camera (or stack) lane: each
  lane is labelled, the divider's diamonds and segments carry their own
  colour, and each has its own Add-animation button. `animatedTrack:
  "compare"` is accepted but vestigial (the block's presence decides).
- Sampling and derivation live in `engine/sceneCompare.ts`; the mask
  catalogue in `engine/compareCatalog.ts`; presets in
  `engine/comparePresets.ts`.

## How it renders

- Project load derives side B's doc and theme
  (`LoadedProject.compareBDocs`/`compareBThemes`); the app mounts a second
  `SceneHost` per comparison scene (side "b"), so per-side state scopes
  through the ordinary host machinery. In-memory sidecar patches re-derive
  both (the empty-after lesson: anything derived from docs at load must
  re-derive in `handleDocChanged` or reload).
- The compositor's compare branch reuses the transition machinery's A/B
  target pools: side A renders to target A, side B to target B (same camera
  pose, per-side root-scene state and lighting), then the compare material
  masks them. Chrome (line, grip, tints) is procedural SDF in the same
  pass; chips are troika text mounted INSIDE each side's subtree, so the
  mask clips a chip with its own half and its opacity fades by
  `compareCoverageAt` (the exact shader field maths).
- SDR composites in the display domain via `sampleDisplay`; the HDR (fx)
  variant tone-maps both samples, composites in display space and inverts
  back through the exact ACES pair.
- Persistent layers hide during the side renders and draw once over the
  composite (the transition ghosting rule).

## Interop rules (v1)

- **Transitions** preserve each active scene's full comparison. Each scene
  composites its Before and After sides first, then the boundary transition
  blends the finished scene pixels. Hard cuts show the comparison to the edge.
- **Overlays (frames)** do not compose with the compare branch; a framed
  comparison renders full-bleed.
- **Tone mapping/exposure** is the project's display transform on both
  sides (the one renderer-level knob; a deliberate v1 call).
- **Per-side keyframed lighting** is not sampled per side (static per-side
  lighting via `b.lighting` works; lighting keyframe tracks stay
  index-keyed).
- **Duration:** `follow-media` counts `compare.b.media` videos beside each
  device's own, pinned or not, and follows the longest, so neither
  recording cuts short.
- **Memory:** a comparison holds an MSAA A/B pair for its whole scene (not
  a transition's brief window); export-time `releaseIdlePools` releases
  untouched pools between windows, and the all-aspect fixture verifies are
  the standing footprint evidence.

## Authoring

The `comparison` scene kind scaffolds the two-device pair (labels
`beforeLabel`/`afterLabel`, devices at x -0.85/0.85 with opposing 12-degree
yaws, scale 0.85; the template compresses x and scale in portrait). For a
masked split on any scene: add the block above, or use the inspector's Add
comparison (Scene tab), which seeds a visible default (line + chips). The
Scene inspector's Before/After selector routes Theme, Background, Staging,
Lighting and device-video actions to that side. After values write through
`compare.b`; clearing an override returns that field to Before. Comparison
video actions target device screens only.

## Gate fixture

`fixtures/compare-spike` (bundled, no prefix): a null-control plain scene,
a static two-theme split with shader backgrounds on both sides, a feathered
60-degree eased sweep, a circle window, a ghost blend and a full-chrome
scene. Baselines live in docs/determinism.md; the null control pins the
solo fast path byte-identically.
