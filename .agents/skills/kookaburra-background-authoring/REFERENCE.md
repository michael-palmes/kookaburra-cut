# kookaburra-background-authoring — reference

Templates and exact shapes for shipping a new animated background. The colour rules (bands,
counts, naming voice, theme interplay) live in `docs/backgrounds.md`.

## ShaderBackgroundDef skeleton

```ts
// src/toolkit/stage/shaders/<name>.ts
import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";

const fragment = /* glsl */ `
uniform vec2 u_resolution;   // declared for the fragment's own use; the engine quad writes it
uniform float u_time;
uniform vec4 u_colorBack;
uniform vec4 u_colorFront;
out vec4 fragColor;          // REQUIRED: GLSL3 here does not alias gl_FragColor

void main() {
  // ... effect body ...
  fragColor = vec4(color, 1.0);
}
`;

export const myEffect: ShaderBackgroundDef = {
  id: "my-effect",
  name: "My effect",
  fragment,
  colorSlots: [
    // Fallbacks are the first DARK preset's colours (p6); presets.test.ts pins the match.
    { label: "Back", fallback: "#0d1826" },
    { label: "Front", fallback: "#406285" },
  ],
  params: {
    intensity: { label: "Intensity", default: 0.5, min: 0, max: 1, step: 0.01 },
  },
  uniforms(colors, params) {
    // Exclude u_time, u_resolution, u_scale, u_rotation, u_offsetX/Y and u_noiseTexture.
    return {
      u_colorBack: { value: colors[0] ?? [0, 0, 0, 1] },
      u_colorFront: { value: colors[1] ?? [1, 1, 1, 1] },
      u_intensity: { value: params.intensity },
    } satisfies Record<string, IUniform>;
  },
};
```

Registration in `index.ts`: add the def to `SHADER_BACKGROUNDS` and its id to
`SHADER_BACKGROUND_IDS`.

## The PCG hash patch (determinism)

Replace any chained `fract()`/`fract(sin())` hash with the house integer hash, keeping the
vendored function's name and signature. Do not write a new one: interpolate the exported
`hash21` GLSL snippet from `src/toolkit/stage/shaders/utils.ts` into the fragment (see
`meshGradient.ts` for the pattern):

```glsl
// Source (driver-defined precision, NOT deterministic):
// float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// utils.ts's hash21 (PCG-style integer hash, exact across compiles):
float hash21(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p)));  // float->uint is undefined for negatives; go via ivec2
  uint h = v.x * 374761393u ^ v.y * 668265263u ^ 2246822519u;
  h ^= h >> 13;
  h *= 1274126177u;
  h ^= h >> 16;
  return float(h & 0x00FFFFFFu) / 16777216.0;
}
```

Texture-based noise (`textureRandomizerR` in `utils.ts`) is a plain lookup into the shared
`DataTexture` and needs no patch; set `noise: true` on the def instead.

## Preset entry shape

```ts
// presets.ts — 9 per shader: p1-p5 light (black text), p6-p9 dark (white text).
{
  id: "p6",
  name: "Bass Strait",       // Australian nature voice, unique across the whole pack
  mode: "dark",
  textColor: "#ffffff",
  colors: ["#0d1826", "#26425c", "#406285", "#16293c"],
  speed: 0.4,
  params: { distortion: 0.7, swirl: 0.12 },
},
```

`presets.test.ts` enforces: 9 presets, id order `p1..p9`, modes light x5 then dark x4,
`textColor` pure black/white by mode, every stop's relative luminance inside the band
(light >= 0.30, dark <= 0.125) and AA against the text colour, fallbacks equal to the first
dark preset, params inside the def's min/max, speed/scale inside the schema clamps.

## Preview-lab fixture pair

Sidecar (`fixtures/preview-lab-bg-<shader>/scenes/bgp-<shader>-<pid>.json`) mirroring the preset exactly
(speed defaults to 1 when the preset omits it):

```json
{
  "version": 1,
  "name": "Background preset — <shader> <Name>",
  "background": {
    "type": "shader",
    "shader": "<shader>",
    "colors": ["#0d1826", "#26425c", "#406285", "#16293c"],
    "speed": 0.4,
    "params": { "distortion": 0.7, "swirl": 0.12 },
    "preset": "p6"
  }
}
```

Scene stub (`bgp-<shader>-<pid>.tsx`), unstaged and empty on purpose:

```tsx
import { defineScene } from "@kookaburra/toolkit";

export default defineScene({
  id: "lab-bgp-<shader>-<pid>",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
```

Also add one `bg-<shader>` pair (same stub shape, sidecar with just `shader` + `speed`, no
colours) for the type card's motion clip, and register every fixture in
the lab's own `fixtures/preview-lab-bg-<shader>/project.json` with `"durationMs": 1000`.

Naming contract (pinned by `optionPreviews.test.ts`): `bg-<shader>` renders a CLIP set,
`bgp-<shader>-<pid>` renders a STILL set, both keyed by their stem in
`src/assets/option-previews/`.

### 3D looks: generate, never hand-write

Scene3d labs are written from preset data, so never edit them by hand (a hand edit drifts from
the presets and the next run overwrites it):

```bash
node scripts/gen-bg3d-preview-labs.ts <look-id> [...]   # or --all; Node 24+ type stripping
git diff --stat fixtures/                                # untouched looks must show no diff
```

It writes `fixtures/preview-lab-bg-<look>/`: `project.json` plus 11 pairs, `bg-<look>` (p6,
2000ms clip), `bg-<look>-light` (p1 clip) and `bgp-<look>-p1..p9` (1000ms stills), then runs
Biome over the JSON. The camera follows `def.previewCamera`: `static` holds one elevated pose
(the grids default), `sweep` orbits the clip from -35 to 35 degrees (every other family).
Rerun it after any preset change, then `--action option-previews`.

### Capture version pins

`OPTION_PREVIEW_VERSION` (`src/engine/optionPreviews.ts`) is hashed into every set's staleness
key, so bumping it re-records all ~400 sets (about 2 hours on a loaded machine; set
`KOOKABURRA_RUN_TIMEOUT=7200` or the default 2400 s kills the run). Bump it only for capture or
renderer changes that alter every tile, never for a single look: a look's own fixture edits
already mark just its sets stale. `THEME_PREVIEW_VERSION` (`src/engine/themePreviews.ts`) does
the same for the theme previews (`--action theme-previews`).

## 3D look folder

A new look lives in `src/toolkit/stage/scene3d/looks/<id>/` and is discovered with no
registration (it sorts after the built-in ten by family, then name):

```ts
// looks/<id>/index.ts
import type { Scene3dBackgroundDef, Scene3dBackgroundPreset } from "../../types";
import { MyLook } from "./MyLook";

export const look: Scene3dBackgroundDef = {
  id: "<id>",                 // must equal the folder name
  name: "My look",
  family: "lines",            // SCENE3D_FAMILIES: lines, painted, history, deco, atmosphere, kinetic
  colorSlots: [
    { label: "Lines", fallback: "#3b5c7d" },          // fallbacks = p6 colours
    { label: "Lamps", fallback: "#8a7a50", glow: true }, // at most 2 glow slots
  ],
  params: { drift: { label: "Drift", default: 1, min: 0, max: 3, step: 0.05 } },
  Component: MyLook,
};

export const presets: Scene3dBackgroundPreset[] = [/* p1..p5 light, p6..p9 dark */];
```

Keep module evaluation free of DOM and canvas work (the generator imports the registry in
Node), and never import `../../index` or `../../presets` at runtime (a cycle). An optional
preset `lighting` block (static v9 fields: `sun`, `ambient`, `lights`, `fixtures`,
`environment`, `shadow`) must survive `normalizeLighting` unchanged.

The component receives `{ colors, params, speed, backing }`. `backing` is the scene's backing
as one sRGB hex (`scene3d/backing.ts`): a flat colour as is, a gradient's middle (horizon) row,
a shader's `Back` slot or its colours' mean, else the frame clear colour. Fade distance and
haze toward it with the kit's `backingMix` instead of fading alpha (alpha fades blend
differently on the canvas and on compositor targets) or guessing a tone, and never add a colour
slot that duplicates the backing (the inspector's Backing control then does nothing visible):

```ts
export function MyLook({ colors, params, speed, backing }: Scene3dLookProps) {
  // uniforms: { uBacking: lookColorUniform("#0d1219") }, then in a layout effect:
  // mats.floor.uniforms.uBacking.value.set(backing);
  // GLSL: ${LOOK_GLSL_BACKING} above main(), then
  // col = backingMix(col, uBacking, haze); gl_FragColor = vec4(col, 1.0);
}
```

`backingMix` blends in display space, so a converted alpha fade keeps its canvas curve. Keep
alpha for coverage (line AA, sub-pixel and text-calm fades) and for haze over the look's own
translucent parts (Blue and gold's glow shell). Details: `scene3d/kit/README.md` ("Backing
tone").

## Look lab (iterate here, confirm in the app)

The autorun screenshot boots the whole app per frame and queues behind every other agent's run.
Iterate in the look lab instead: it mounts the real look (`FixedBackdrop` with the preset's
scene3d spec) under the scene providers and the app's renderer settings in headless Chrome, and
writes a contact sheet in about ten seconds. Details and flags: `tools/look-lab/README.md`.

```bash
node tools/look-lab/sheet.mjs --look <id>                  # p1 + p6, five cameras + 9:16, t 8 s
node tools/look-lab/sheet.mjs --look <id> --grid           # nine presets as picker stills: variety, legibility
node tools/look-lab/sheet.mjs --look <id> --compare 4,8    # motion row: |t8 - t4| with mean and % moved
node tools/look-lab/sheet.mjs --look <id> --presets p6 --params lineWidth=3 --out <scratch>/a.png
```

1. Read the PNG after every change. Exit 1 means the page logged errors (shader compile errors,
   a throwing material, React errors), printed under the sheet with the failing GLSL line; fix
   them before judging the look. Warnings print too: clear them, the app logs the same ones.
2. Judge text readability on the `front` and 9:16 columns (the stand-in headline sits where the
   atlas puts it), stage clearance on `wide` and `far`, the cutaway on `behind`.
3. Check thin lines at export scale with `--width 1920 --ss 2 --cams lab --tall none`: tiles
   keep the export format, so pixel-sized effects shrink with the tile like the picker previews.
4. Confirm at the end with one or two `pnpm kookaburra:run --action screenshot` frames (an
   atlas or spike scene). The lab matched the engine within one code value on the pilot looks,
   but it skips transitions, effects, real devices, companion lighting and WKWebView itself.

## NOTICE entry (vendored ports only)

Add the upstream file to the source list in `src/toolkit/stage/shaders/NOTICE.md` and one
bullet per behavioural adaptation (hash patch, stripped uniforms, texture handling). Original
GLSL needs no entry.
