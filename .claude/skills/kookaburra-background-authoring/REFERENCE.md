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

Sidecar (`projects/preview-lab/scenes/bgp-<shader>-<pid>.json`) mirroring the preset exactly
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
`projects/preview-lab/project.json` with `"durationMs": 1000`.

Naming contract (pinned by `optionPreviews.test.ts`): `bg-<shader>` renders a CLIP set,
`bgp-<shader>-<pid>` renders a STILL set, both keyed by their stem in
`src/assets/option-previews/`.

## NOTICE entry (vendored ports only)

Add the upstream file to the source list in `src/toolkit/stage/shaders/NOTICE.md` and one
bullet per behavioural adaptation (hash patch, stripped uniforms, texture handling). Original
GLSL needs no entry.
