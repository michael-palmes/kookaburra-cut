---
name: kookaburra-lighting-authoring
description: Authoring and extending Kookaburra Cut's v9 scene lighting - the three-layer LightingSpec (theme, project, scene), the sun, free lights and their World/Camera/Subject spaces, emissive light fixtures and repeat arrays, HDRI environments, lighting keyframes, presets, and the display transform (tone mapping + exposure). Use when asked to "light a scene", "add a light", "make a corridor", "add an HDRI", "change the environment", "add a lighting preset", "animate the lighting", "change tone mapping or exposure", or when touching src/engine/sceneLighting.ts, src/engine/fixtures.ts, src/engine/lightingState.ts, src/engine/renderSettings.ts, src/toolkit/lighting/, src/toolkit/stage/StageLights.tsx, or a sidecar's `lighting` block.
---

# kookaburra-lighting-authoring

Lighting is per-scene AUTHORED DATA, not scene code. It lives in each scene's sidecar
(`scenes/<stem>.json`) under `lighting`, is edited through the inspector's Lighting section,
and renders through `<SceneStage>`. Scene TSX should never mount lights directly.

## Read this first: determinism cannot see an orientation bug

Verify compares run to run, so a frame that renders consistently WRONG passes cleanly. Seven
render bugs in this batch did exactly that: area lights emitting sideways out of their own
tubes, rim lights aimed backwards at the lens, housings sitting across the aperture they were
meant to back. Every one verified EQUAL.

**Any change to a lighting render path needs a frame grab.** That is what `ws:lighting-audit`
exists for: 9 scenes (env mirror, housed props, the shadow cap, one per preset) staging the
same four subjects, so only the `lighting` block varies. Re-shoot it after any lighting
render-path change:

```bash
pnpm kookaburra:run --action export --project ws:lighting-audit --aspect 16:9 --codec libx264
# then pull mid-scene frames (1000ms scenes, 60fps) and LOOK at them
```

It is deliberately not in a gate. It is the human check the gate structurally cannot perform.

Fixture design matters: subjects must be matte solids that show falloff plus one glossy solid
for reflections. A device alone is a bad test subject, because a handset is mostly its own
unlit screen texture, so a completely broken light type still looks fine.

And measure as well as look. Whole-frame luminance is swamped by a large flat backdrop, so crop
to the subjects: a dead accent rim showed up as saturation 10.7 against 18.0 on the matte
sphere when the whole frame said the two were 0.99 similar.

## The contract (why these rules exist)

- **Null-for-legacy is non-negotiable.** Absent at all three layers must resolve to the
  pre-v9 code path VERBATIM. `ws:launch-2026` staying EQUAL is the proof.
- **Three layers, whole-field replacement.** `theme.lighting` → `project.json` `lighting` →
  the scene sidecar's `lighting`. Each PRESENT field fully replaces the one below, and lists
  (`lights`, `fixtures`, `fills`) replace WHOLESALE. There is no merge-by-id.
- **Caps are identical in preview and export.** `MAX_SCENE_LIGHTS` 16, `MAX_SHADOW_CASTERS` 4,
  `FIXTURE_MAX_COUNT` 64, `SUN_ANGULAR_REFERENCE` 8. They live in `engine/sceneLighting.ts`
  (`format.ts` re-exports them, but cannot own them: it imports the editor store, which reaches
  the theme registry, which imports the parsers, and that cycles). A cap that differed between
  the two paths would break determinism by definition.
- **Never `Math.random()`.** Fixture jitter draws from `createSeededRandom` (`engine/rng.ts`)
  keyed on a djb2 hash of the fixture id plus the instance index. The sequence is export
  contract: a different hash re-rolls every jittered corridor.
- **The Kelvin fit is export contract.** `engine/kelvin.ts` is Tanner Helland's fit, vendored
  and pinned with golden values. Swapping it for a library rebases every lit project.

## Colour: kelvin | token | hex

Resolved in that order, then white. Kelvin is the primary control; `colorToken` names a theme
colour (so a theme swap restyles the rig); `color` is a hex escape hatch. An unknown token
warns and falls through rather than dropping the light.

## Light spaces, and which way things point

| Space | Meaning | Azimuth 0 |
|---|---|---|
| `world` | Fixed in the scene | From the origin along +Z |
| `camera` | Rides the camera rigidly | The camera's +Z axis, BEHIND the lens (cameras look down -Z) |
| `subject` | Orbits what the camera looks at | From the subject TOWARD the camera (a front light) |

**Camera and subject space resolve at the compositor seam, per render target**
(`engine/lightingState.ts`, `applyRelativeLights`). A transition frame renders A and B with
different cameras, so a shared resolve is right in preview and in solo export and wrong only on
transition frames. Never resolve relative lights in a React effect.

**No `target` means aim at the SUBJECT, not at the space's origin.** This is the rule that kills
`camera`-space rim lights if you get it wrong, because the camera-space origin IS the camera: a
defaulted aim points every rim backwards at the lens and lights nothing. World space already has
its origin at the subject and subject space is defined by it, so the default makes all three
spaces agree that no target means aim at the thing. An explicit `target` still reads in the
light's own space.

Area lights have no `.target` in three, so they aim by rotating themselves (`aimSelf` →
`lookAt`). Directional and spot lights aim through a real target `Object3D`. Point lights do not
aim at all.

## Fixtures

Emissive geometry that also lights. The trick is `MeshBasicMaterial` with
`toneMapped={false}` and a colour scaled past 1.0, so it crosses the bloom threshold instead
of being compressed by the display transform. Consequences worth stating to the user:

- **A fixture needs bloom to read hot.** The section says so; it never auto-enables bloom.
- **Fixtures ignore exposure and the tone-mapping curve.** They are emitters, not surfaces
  (a stated decision in `docs/decisions.md`).
- **Area-paired forms light only Standard and Physical materials.** Troika text and shader
  backgrounds ignore them. That is three's LTC limitation, not a bug.
- **Over-budget fixtures THIN, they do not truncate.** A corridor lit only at the near end
  looks broken; every second tube looks deliberate.

### Axis conventions (get these wrong and the fixture lights the wrong way)

three's `RectAreaLight` puts `width` on local **+X**, `height` on local +Y, and emits along
local **−Z** (`WebGLLights.js`). Every fixture convention here follows from that:

- **Cores run along local X.** `CapsuleGeometry` is built on Y and rotated onto X
  (`fixtureGeometry`), so a tube's length matches the emitter's width axis with no correction
  on the light itself. Box forms (`strip`, `led-strip`) are already long on X.
- **Unrotated, a fixture emits toward −Z**, which faces the camera in a default stage. That is
  the right default for a practical prop standing in shot.
- **A ceiling batten is `rotationDeg: [-90, 0, 0]`**: the core stays along X and the emission
  swings from −Z down to −Y. The `neon-corridor` preset is the reference.
- **Housings sit on the side OPPOSITE the emission** (behind, on −Z for a camera-facing
  fixture) and must never enclose the core. A housing bigger than its core on every axis simply
  swallows the light, and a housing built on the wrong primitive axis ends up across the
  aperture. `CylinderGeometry` and `CapsuleGeometry` are both built on Y: if you want either
  lying flat behind a ring, rotate it, or use a torus in the same plane as the ring.

## Keyframes

`lighting.keys` + `lighting.segments`, sampled in SCENE-LOCAL time exactly like the camera
track, and editable from the inspector's animation rows. Sparse poses interpolate against the
resolved base, so a key setting only `sun.intensity` leaves everything else alone. Colours
interpolate through KELVIN when both endpoints define it. Interpolating an orbit key against a
position key is undefined: the rule is to hold the FROM endpoint.

This reverses the pre-v9 "scene motion of light is out of scope" line. The rule that survives,
restated in `docs/determinism.md`: **every lighting value is a pure function of the resolved
timeline position; nothing reads the wall clock and nothing accumulates across frames.**

## Adding a bundled HDRI

1. Download the 1k EXR into the HDRI working folder (Poly Haven, CC0):
   `https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/1k/<slug>_1k.exr`
2. Add `<id> <slug>_1k.exr` to the `MAP` in `scripts/prepare-hdri.sh`.
3. `pnpm assets:hdri`: it SKIPS anything already committed, and bakes the picker thumbnail
   into `src/assets/hdri-thumbs/<id>.jpg` via `scripts/hdri-thumb.py`.
4. Register the id in `BUNDLED_HDRI` (`engine/environments.ts`) with a `?url` import, add the
   picker tile in `LightingSection.tsx`, and record the slug in `src/assets/hdri/README.md`.

**Never re-convert a committed `.hdr`.** The Blender build is a determinism boundary, so
re-running the script over an existing file silently changes its bytes and rebases every
project lighting through it. `--force` exists for a deliberate rebase and needs its own gate.

A user `.hdr`/`.exr` in a project's `assets/` works too. A missing one THROWS at resolve time
rather than degrading to no reflections: warning instead would ship a differently lit export
that verify would happily certify (the AssetBoundary lesson). Bundled sources degrade and warn.

## Preview-only surfaces

Light helpers and gizmos must never reach an exported frame, and the failure is SILENT: a helper
drawn into both verify runs is EQUAL and passes. Two independent guards, both required:

1. Components mount only while the inspector's Lighting drill is open (never true in an autorun).
2. Everything sits on `HELPER_LAYER` (`engine/lightEditStore.ts`), which the export camera
   explicitly disables and the preview driver enables per frame.

Autoruns never open the inspector, so the mount gate hides the layer gate. Screenshot or export
WITH the section open before trusting either.

## Gates

Per change: `showcase-tour` Verify ×2 in 16:9. Feature work also verifies
`ws:lighting-spike-fable`, and any render-path change re-shoots `ws:lighting-audit` by eye.
Current baselines live in `docs/determinism.md`.

`ws:` fixtures live in `~/Kookaburra Cut/`, NOT the repo, so they are shared across worktrees: a
parallel session editing one silently changes another's baseline with no commit to blame. Gate
hard on bundled projects (`projects/showcase-tour`), which are per-worktree and immune, and
treat shared `ws:` hashes as advisory when more than one worktree is live.

Plan and rationale: `~/Documents/Projects/Personal/Kookaburra Cut/Post Go Live Improvements/3`.
