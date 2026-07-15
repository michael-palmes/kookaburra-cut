# NOTICE

Six of the effects in this directory (`meshGradient.ts`, `simplexNoise.ts`, `swirl.ts`,
`neuroNoise.ts`, `warp.ts`, `smokeRing.ts`) are adapted from
[paper-design/shaders](https://github.com/paper-design/shaders), copyright Paper Design,
licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).

Source files: `shaders/mesh-gradient.ts`, `shaders/simplex-noise.ts`, `shaders/swirl.ts`,
`shaders/neuro-noise.ts`, `shaders/warp.ts`, `shaders/smoke-ring.ts`, and shared snippets
from `shader-utils.ts`.

## Adaptations

- **GLSL3 fragment shape.** Stripped `#version 300 es` and `precision mediump float;`
  (three's `ShaderMaterial` with `glslVersion: GLSL3` supplies those); the source's own
  `out vec4 fragColor;` declaration and writes are KEPT — this three version does not
  alias `gl_FragColor` for GLSL3 custom shaders (the transitionShader convention).
- **Hash patch.** The source's `proceduralHash21` (`hash21`) and the `colorBandingFix` dither
  line both build pseudo-randomness from chained `fract()`/`fract(sin())` floating-point ops,
  whose precision is driver-defined and violates this engine's determinism contract. Both are
  replaced with the house PCG-style integer hash used by the glitch transition
  (`src/engine/transitionShader.ts`'s `hash01`), keeping the original function name and
  signature so the copied fragment bodies are otherwise untouched. `hash21` floors its `vec2`
  input through `ivec2` before the `uvec2` cast (float-to-uint is undefined for negatives per
  the GLSL ES spec; float-to-int-to-uint is well-defined); the dither line hashes
  `gl_FragCoord.xy` directly, which is always non-negative.
- Vertex sizing uniforms (`u_resolution`, `u_scale`, `u_rotation`, `u_offsetX/Y`) and `u_time`
  are owned by the engine quad and excluded from each def's `uniforms()` output, even where a
  fragment still declares them for its own use (anti-aliasing, or unused source boilerplate).
- **Noise texture.** `warp.ts` and `smoke-ring.ts` sample `uniform sampler2D u_noiseTexture` for
  their base hash. Each def sets `noise: true` and excludes `u_noiseTexture` from `uniforms()`;
  the engine attaches the shared texture (the GLSL `sampler2D` declaration is kept). The
  randomizer image itself was decoded from the source's embedded PNG into raw RGBA bytes at
  vendor time (`noiseTexture.ts`'s `NOISE_B64`) so the `DataTexture` builds synchronously, no
  async decode or export preload barrier. `shader-utils.ts`'s `textureRandomizerR` (a plain
  texture lookup, not a float hash, so no PCG patch needed) is copied byte-identical into
  `utils.ts` for smoke-ring; warp's own texture-sampling helper (`randomG`) is inline in its
  fragment body, matching the source.
