# Scene TSX

TSX is for composition: what is mounted, where, and custom motion the sidecar cannot
express. Copy, devices, camera, backgrounds and styling belong in the sidecar so the
app's inspector stays live. Start new scenes from a preset (`kb scene add <stem>
--preset <slug>`) and adapt; write TSX from scratch only for bespoke compositions.

## Contract

```tsx
import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "launch-title",
  durationMs: 3000,
  Scene() {
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={150} to={800} />
      </SceneStage>
    );
  },
});
```

- Exactly one `export default defineScene({ id, durationMs, Scene })`. `id` is a
  literal string unique in the project (the app heals duplicates by renaming, which
  rewrites your file). `Scene` takes no props; read everything through hooks.
- File stems are `NN-name` (`03-pricing.tsx`); the sidecar shares the stem.
- The manifest's `durationMs` wins. A scene cannot read its own duration, so time
  motion from the start in absolute ms, and keep any end-relative timing in sync
  with `project.json`.
- Register new files with `kb scene add` (or `kb scene duplicate`), never by hand-
  editing two places.

## Import surface

Only `@kookaburra/toolkit` resolves (`kb catalog toolkit.exports` lists every export). No
`react`, `three`, `@react-three/*`, anime.js, relative imports or other scenes; JSX
needs no React import. Consequences:

- No `useMemo`, `useState`, `useEffect`, `useRef`, `useFrame`. Compute per render
  (cheap) or once at module scope (static data, seeded randomness).
- r3f intrinsics work: `<group>`, `<mesh>`, `<planeGeometry>`, `<ringGeometry>`,
  `<boxGeometry>`, `<meshBasicMaterial>`, `<meshStandardMaterial>`, lights. Colours
  as hex strings from theme tokens.
- Motion curves come from the toolkit: `ramp`, `ease`, `sampleKeys`, `stampScale`
  (below). Ease names are the catalogue's (`./kb catalog eases`).
- `import type { ... } from "@kookaburra/toolkit"` is fine (`SceneDoc`, `V3`, ...).

## Hooks

| Hook | Returns |
| --- | --- |
| `useTimeline()` | `{ localMs, globalMs, progress }`. `localMs` is scene time: drive ALL motion from it. `progress` is the whole PROJECT 0..1. |
| `useFormat()` | `{ width, height, aspect, frame: { width, height }, safe: { top, right, bottom, left } }`; frame and safe in world units at z = 0 |
| `useTheme()` | Tokens: `colors.{background,text,accent,muted}`, `typography.{headline,body,scale}`, `motion.durations.{fast,base,slow}`, `motion.easings`, `chartColors`, `gradients` |
| `useSceneText(key, fallback?, role?)` | Sidecar copy for a text key; `role` `"embedded"` for positioned labels that must never become managed text |
| `useSceneDevices()` | Sidecar devices as `<Device>` props, layout resolved per aspect |
| `useSceneDoc()` | The raw sidecar, or null |
| `useSceneChart()`, `useSceneObjects()`, `useSceneLayeredScreenshot()` | Those blocks (calling one stops the host fallback for it) |
| `useSceneStaged()` | Whether a `SceneStage` owns lighting here |
| `useDepthBand()`, `useRigTrack()` | Inside `DepthStage`: the slot rect; the scene's rig track |
| `useProjectShared(path?, fallback?)` | `project.json` `shared` constants: `useProjectShared("palette.accent", theme.colors.accent)`; no path returns the whole block (reference/project.md) |
| `useTextMetrics(textKey, text, opts?)` | `{ width, height, ascent, descent, lines }` of the block an `AnimatedHeadline` with those props draws (sidecar overrides included), or null for a frame while its font loads; size pills and underlines with it (reference/text.md) |
| `useSceneCamera()` | The scene camera's pose this frame: `{ position, lookAt, fov, rollDeg? }` |
| `useCameraFrame(z?)` | `{ width, height, center }`: the world rectangle the scene camera sees on the plane at depth `z` this frame (reference/camera.md) |

Plain helpers: `measureText(text, { font, fontSize })` measures without a text key, and
`frameAtDepth(format, z)` gives the default camera's visible `{ width, height }` at depth `z`.

## Layout

- The camera sits at z = 5 looking at the origin with a 45 degree vertical field of
  view, so the frame is 4.142 units tall at z = 0 in every aspect; width is
  `4.142 * aspect` (16:9: 7.364; 9:16: 2.330). reference/project.md has every aspect.
- Place laid-out content at z = 0. Content nearer the camera projects LARGER and can
  clip (z = 1 sits 25% further from centre than its y suggests).
- Safe rectangle: x within `frame.width / 2 - safe.left`, y within
  `frame.height / 2 - safe.top`.
- One scene serves every aspect: branch on `aspect < 1` for portrait sizes and
  positions; never write per-aspect files. Check both with `kb capture --aspect`.
- Typical sizes: TitleBlock title 0.56 (landscape) / 0.34 (portrait); AnimatedHeadline
  default 0.6; body copy 0.2 to 0.28; a fitted phone is 2.6 units tall.

## Motion helpers

```tsx
import {
  defineScene,
  liftColour,
  Pill,
  RoundedRect,
  ramp,
  sampleKeys,
  stampScale,
  useFormat,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const pop = stampScale();
const SLIDE = [
  { tMs: 0, x: -1.2, opacity: 0 },
  { tMs: 700, x: 0, opacity: 1, ease: "outCubic" },
  { tMs: 2200, x: 0, opacity: 1 },
  { tMs: 2600, x: 1.2, opacity: 0, ease: "inCubic" },
];

export default defineScene({
  id: "feature-card",
  durationMs: 3000,
  Scene() {
    const { localMs } = useTimeline();
    const { colors } = useTheme();
    const { frame } = useFormat();
    const card = sampleKeys(SLIDE, localMs);
    const w = Math.min(frame.width * 0.6, 3.2);
    const bar = w * 0.8 * ramp(localMs, 900, 1800, "inOutCubic");
    return (
      <group position={[card.x, 0, 0]}>
        <RoundedRect
          width={w}
          height={1.6}
          radius={0.16}
          color={liftColour(colors.background, colors.text, 0.08)}
          strokeWidth={0.02}
          strokeColor={colors.muted}
          opacity={card.opacity}
        />
        <Pill
          width={1.2}
          height={0.3}
          color={colors.accent}
          position={[0, 0.3, 0.01]}
          scale={pop(localMs - 600)}
          opacity={card.opacity}
        />
        <Pill
          width={bar}
          height={0.08}
          color={colors.accent}
          position={[-w * 0.4 + bar / 2, -0.4, 0.01]}
          opacity={card.opacity}
        />
      </group>
    );
  },
});
```

- `ramp(localMs, startMs, endMs, ease?, opts?)`: eased 0 to 1 through a window (time
  clamped, `linear` by default); an empty window steps at `startMs`.
- `ease(name, t, { overshoot }?)` and `easeFn(name, opts?)`: the named curves (the
  camera's and text presets'). `overshoot` widens the Back family (`outBack` for small
  pops). Unknown names fall back to `inOutQuad`, and `./kb check` warns on them.
- `sampleKeys(keys, localMs, { ease }?)`: keys `{ tMs, ease?, ...values }` in any order.
  Holds the first key before it and the last after it; each key's `ease` shapes the
  segment ARRIVING at it (default `linear`). Numbers and equal-length number arrays
  (positions) interpolate; strings and other values switch at the key.
- `stampScale({ from, peak, inMs, settleMs }?)` returns `ms => scale`: 0 to 1.12 over
  180 ms (outCubic), back to 1 over 260 ms (inOutSine). Pass ms since the stamp starts.
- `clamp01(x)`, `lerp(a, b, t)` for the rest.
- `RoundedRect` (`width`, `height`, `radius`, `color`, `opacity`, `strokeWidth`,
  `strokeColor`, `position`, `rotation`, `scale`, `renderOrder`) and `Pill` (radius is
  half the shorter side) are flat and colour-exact; size, radius and colours animate
  freely (no geometry rebuild). Fills default to the theme accent, strokes to the text
  colour.
- Per-frame geometry pitfall: never animate geometry `args` (a growing radius in
  `args` rebuilds the geometry every frame). Build a unit geometry once and animate
  `scale`, `position`, `rotation` or material `opacity`.
- Flat graphic colours: `toneMapped={false}` keeps a token colour exact; lit
  materials (`meshStandardMaterial`) respond to the scene's lighting and tone mapping.
- `fade(useTimeline(), [startMs, endMs])` gives `{ opacity }`;
  `slide(time, [startMs, endMs], "x")` gives `{ offset }` 1 to 0 (the axis argument is
  ignored: apply the offset yourself).
- Randomness: `createSeededRandom(seed)` at module scope, for example
  `const rand = createSeededRandom(7); const DOTS = Array.from({ length: 40 }, () => [rand() * 2 - 1, rand()]);`.
  Never `Math.random`, `Date`, `performance.now`, timers or `requestAnimationFrame`.

## Staging

- `<SceneStage floorY={-1.5}>` mounts the theme's lights, the backdrop (sidecar
  `backdrop` beats the theme's) and real shadows on a staged floor. Wrap themed scenes
  in it; it also tells devices and hero objects to drop their own light sets.
- `<DepthStage foreground={...} content={...} midground={...} backdrop={...} />` gives
  a camera rig layers at z 1.8, 0, -2.4 and -5.5, each sized to stay full-bleed
  through the scene's camera travel (`useDepthBand()` inside a slot).
- Backgrounds mount on every scene without TSX (reference/backgrounds.md).

## Toolkit primitives

| Primitive | Use |
| --- | --- |
| `TitleBlock`, `AnimatedHeadline`, `BrandLockup`, `AnimatedCounter`, `ManagedTextStack`, `ExtrudedText` | Text (reference/text.md) |
| `AnimatedGroup` | Animate an icon + text lockup as one unit with the text presets |
| `Device`, `DeviceMockup` (legacy) | Devices (reference/devices.md) |
| `ImageCard`, `VideoClip`, `LayeredScreenshot`, `VideoWindow` (legacy) | Media (reference/media.md) |
| `Chart` | The sidecar chart (reference/charts.md) |
| `StagedObject`, `HeroObject` | 3D objects |
| `ParticleField`, `WireGrid`, `Ribbon` | Seeded generative shapes on the clock |
| `RoundedRect`, `Pill` | Flat cards, badges, chips and bars (Motion helpers above) |
| `SceneStage`, `DepthStage`, `LightRig` | Staging and light |

Generative shapes (all motion from the clock, randomness from `seed`):

- `<ParticleField count={200} seed={1} bounds={[6, 3.5, 2]} size drift twinkle tone="accent" />`
- `<WireGrid size={12} divisions={24} amplitude wavelength speed tone opacity position rotation />`
- `<Ribbon seed={1} points bounds radius={0.05} from={0} to={1500} tone lit />`
- `<ExtrudedText text from to position rotation fontSize depth bevel tone lit textKey />`
  (rotation in radians; bundled faces only)
- `<HeroObject model="handset" position rotation scale spinDegPerSec floatAmplitude floatHz lit />`

Light rigs add up: with several lit primitives and no `SceneStage`, mount one
`<LightRig />` and pass `lit={false}` to each.

`<AnimatedGroup from to outAt preset outPreset ease startScale shine direction position em extent>`
animates its children as ONE unit (the group origin is the pivot; place children
symmetrically around [0, 0, 0]). `ImageCard`, `AnimatedHeadline` and `AnimatedCounter`
inside it take the group's fade and shine, `RoundedRect` and `Pill` its fade; other
primitives ride its transform only.

## Persistent module

`project.json` `"persistent": "scenes/persistent-orb.tsx"` mounts ONE module across all
scenes. It default-exports a plain component (not `defineScene`), and `useTimeline()`
there returns global time. `sampleSharedTransform(track, globalMs)` interpolates
`{ tMs, position, rotation, scale, opacity }` keys. All other rules apply.

## Fixing failures

| Symptom | Cause and fix |
| --- | --- |
| "user scenes may import only @kookaburra/toolkit" | A non-toolkit import; remove it |
| "must default-export defineScene" | Missing or bare default export |
| `useMemo is not defined` (or any React hook) | Hooks unavailable; compute inline or at module scope |
| "This scene can't load" card; `kb status` lists the file | Compile, evaluate or export failed: read the phase and first error line, fix, `kb check --app` |
| Error with scene index -1 | The `persistent` module failed |
| Export or stills refuse | An error card exists somewhere; `kb status` names it |
| Fine in preview, differs on export | A wall-clock read, `Math.random`, or an asset added after load |
| Clipped at the edges in portrait | Fixed x positions; derive from `frame` and `safe`, capture `--aspect 9:16` |
