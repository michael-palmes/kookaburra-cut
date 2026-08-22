# Before/after comparisons

One scene rendered twice and composited under an animatable mask: side A
("before") is the scene itself, side B ("after") is the same scene with the
`compare.b` overrides applied. Each side carries its own theme, background,
staging, lighting, screen media, device colour and device shadow; only finished
pixels mix (the cross-theme transition rule). The divider, its position and its
angle both, is data sampled on the CPU, never time-derived in GLSL.

## The sidecar block

Everything lives in the scene document's `compare` field (side A is the doc
itself; deleting the block leaves a valid plain scene):

```jsonc
"compare": {
  "b": {                       // the after side; absent fields match side A
    "media": { "d2": { "src": "assets/after.mp4", "kind": "video" } },
    "deviceAppearance": {
      "d2": { "colour": "silver", "shadow": "long" }
    },
    "themeId": "kookaburra-midnight",
    "background": { "type": "shader", "shader": "mesh-gradient" },
    "backdrop": { "type": "floor", "color": "#101820" },
    "lighting": { /* LightingSpec, replaces the scene layer for side B */ }
  },
  "mask": {
    "type": "linear",          // linear | circle | radial | blend
    "angleDeg": 90,            // linear: the LINE's STATIC angle, 90 = vertical
    "center": [0.5, 0.5],      // circle/radial: uv centre
    "softness": 0              // feathered edge half-width; 0 = hard, not blend
  },
  "value": 0.5,                // static divider when the track has no keys
  "track": {                   // the divider's keyed track (the camera model)
    // pose.angleDeg is optional and overrides mask.angleDeg from that key on
    "keys": [{ "id": "k1", "tMs": 0, "pose": { "value": 1, "angleDeg": 60 } }],
    "segments": [{ "from": "k1", "to": "k2", "ease": "inOutCubic" }]
  },
  "chrome": {
    "line": { "width": 4, "colour": "accent", "softness": 0 },
    // linear masks only; `true` is the legacy chevrons handle at size 1
    "grip": { "size": 1, "style": "chevrons" },
    "chips": true,             // real text content: text.beforeLabel / text.afterLabel
    "tint": { "b": "accent", "amount": 0.08 }
  }
}
```

Rules:

- `media` is keyed by device id and remaps that device's screen on side B.
- `deviceAppearance` is keyed by device id and may override only `colour` and
  `shadow`. Model, placement, motion and lid remain shared with side A.
- Chrome colours are THEME TOKEN names (`background | text | accent |
  muted`), resolved against the scene's theme at plan build; sizes are
  1080-tall reference pixels so they hold across aspects. `line.colour`
  also takes a `#rrggbb` hex, which resolves to itself (the picker writes
  hex; old token docs keep resolving exactly as before). Three-digit hex
  is rejected at parse, since `hexToSrgb` reads six.
- **Grip styles:** `chrome.grip.style` is `chevrons` (the default ring and
  chevrons), `dot` (a filled circle), `bar` (a rounded pill riding the
  line) or `arrows` (two outward arrowheads, no ring), with `size` a
  multiplier on the reference radius. `grip: true` still means chevrons at
  size 1. The catalogue is `COMPARE_GRIP_CATALOG`
  (`engine/compareCatalog.ts`) and the shader dispatch ids are
  `COMPARE_GRIP_ID`; style 0 keeps the pre-style expressions character for
  character, so legacy grips export byte-identically.
- **Value semantics:** the divider's position along the mask's field with
  side A on the origin side. On the default vertical divider, value 0.3
  puts the line 30% in from the left with the before on its left. Circle
  and radial grow the AFTER window with value. `blend` reads value as the
  after's opacity. Revealing the after over time travels 1 to 0 on linear
  masks; a mirrored story is reciprocal keys or the angle plus 180.
- **Angle semantics:** `mask.angleDeg` is the STATIC line angle. A key may
  carry its own `pose.angleDeg`, which overrides it from that key on and
  tweens with the value, so a linear divider can rotate as it reveals. Keys
  without one hold the static angle, which is what keeps angle-free docs
  exporting byte-identically. Angle interpolates numerically, with no
  shortest-path wrap: 350 to 10 travels backwards through 180.
- The track rides the shared KeyedTrack model: eased interpolation inside a
  segment, the latest key HOLDS outside (the camera semantics), the static
  `value` and angle with no keys. Position and angle come off ONE walk
  (`compareSampleAt`), under the one ease, so they can never resolve from
  different segments. The divider lane shows in the timeline dock on
  every comparison scene, STACKED above the camera (or stack) lane: each
  lane is labelled, the divider's diamonds and segments carry their own
  colour, and each has its own Add-animation button. A seeded key copies
  the applied pose, carrying an angle only on tracks that already animate
  one. `animatedTrack: "compare"` is accepted but vestigial (the block's
  presence decides).
- `softness` feathers the mask edge, so `blend` has nothing to feather: it
  cross-fades whole frames, and both the shader and `compareCoverageAt`
  ignore softness there (the catalogue's `hasSoftness` is false, and the
  drill hides the row).
- Sampling and derivation live in `engine/sceneCompare.ts`
  (`compareSampleAt` returns the value and angle pair, `compareValueAt` is
  the value-only convenience); the mask catalogue in
  `engine/compareCatalog.ts`, whose per-mask `needsAngle`, `needsCenter`,
  `hasSoftness`, `hasLine` and `hasGrip` flags gate the drill's rows (the
  same file holds the grip-style catalogue); presets in
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
  masks them, its sweep uniform taking the frame's sampled angle. Chrome
  (line, grip, tints) is procedural SDF in the same pass; chips are troika
  text mounted INSIDE each side's subtree, so the mask clips a chip with
  its own half and its opacity fades by `compareCoverageAt` on the same
  sampled value and angle (the exact shader field maths).
- **Chips are text content.** With `chrome.chips` on, `beforeLabel` and
  `afterLabel` join the Content list as their own rows ("Before label",
  "After label") and open the standard text drill, which writes copy to
  `text` and typography to the usual `textStyle.<key>Color/Font/Size/
  OffsetX/OffsetY/LineHeight/RotationDeg` keys. `engine/compareChipText.ts`
  owns the contract (keys, defaults, row labels, style resolution) and
  `CompareChips` applies it by the managed-text renderer's rules, so an
  unstyled chip draws its coded defaults byte for byte. The chips are
  HOST CHROME: they never enter `managedText.items`, so the safe-area
  stack cannot render them and no structural action can move or delete
  them; clearing a chip's copy hides it. The drill's chips toggle stays
  the show/hide.
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
Device, Theme, Background and Lighting inspectors each show a Before/After
selector. The scene overview exposes Change and Edit video actions for both
sides through a compact Before/After picker, while Device exposes those actions
for its selected side. The Device selector also routes colour and shadow, with
After inheriting Before until it is explicitly changed. After values write
through `compare.b`; choosing Match before clears that override. Comparison
video actions target device screens only.

The Comparison drill runs the mask row and its parameters, then Animation,
Motion presets, Divider line and Labels. Every mask option, motion chip and
chrome toggle wears a leading line icon (`ui/inspector/compareIcons.tsx`: one
16px grid at 1.5px stroke in `currentColor`, the glyph maps pinned complete
against the mask and preset catalogues). Rows the mask cannot use never
render: Edge softness hides on Ghost (`blend`), the line width and colour rows
hide without a line, and the whole Divider line group hides when the mask has
neither line nor grip.

Animation is the in-inspector alternative to hand-editing keys: From / to,
Start / length in ms, Ease, plus Animate the angle (linear masks only) with
Angle from / to. Every field writes the WHOLE track through the doc funnel,
two keys (`k1`, `k2`) joined by one eased segment, whole ms and clamped to the
scene, so the result stays hand-tunable in the lane (the camera-preset rule).
With no keys the fields seed from the static divider (From = `value`, To = 0,
Start = 0, length 85% of the scene). A track of at most two keys and one
segment reads back into the fields; a richer one (Peek then commit, Sweep and
settle, hand edits) shows its key count and the warning that the next field
edit replaces it. Leaving the angle toggle off writes no `pose.angleDeg`, so a
plain divider stays angle-free. The field-to-track mapping lives in
`ui/inspector/compareAnimationModel.ts`.

Motion presets lead with Manual, which clears the keys (`compare.track`
undefined, one history entry) and brings the static Divider slider back; the
comparison and its lane stay, which is what separates Manual from Remove
comparison. Manual is disabled with no keys; the other four chips write their
keys as before.

## Gate fixture

`fixtures/compare-spike` (bundled, no prefix): a null-control plain scene,
a static two-theme split with shader backgrounds on both sides, a feathered
60-degree eased sweep, a circle window, a ghost blend and a full-chrome
scene. Baselines live in docs/determinism.md; the null control pins the
solo fast path byte-identically.
