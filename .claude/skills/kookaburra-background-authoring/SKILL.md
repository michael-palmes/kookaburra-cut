---
name: kookaburra-background-authoring
description: Ships a new animated background for Kookaburra Cut end to end, shader (2D) or scene3d (world-space 3D look), whether ported from paper-design/shaders or written from scratch. Covers the ShaderBackgroundDef anatomy, GLSL3 + determinism patches (PCG hash, engine-owned uniforms, noise texture), the scene3d look contract, the 9 AA colour presets, preview-lab fixtures and incremental thumbnail regeneration. Use when asked to "add a background", "new animated background", "new shader background", "new 3D background", "port a paper-design shader", "add or change background presets", or when touching src/toolkit/stage/shaders/ or src/toolkit/stage/scene3d/.
---

# kookaburra-background-authoring

Ship a new animated background: one GLSL3 effect, nine AA-safe presets, committed preview
thumbnails, all deterministic. Colour rules live in `docs/backgrounds.md`; templates for every
file live in this skill's `REFERENCE.md`.

## When to use

- Adding a new shader background (vendored port or original GLSL)
- Adding or re-tuning a shader's colour presets
- Editing anything under `src/toolkit/stage/shaders/`

## The contract (why these rules exist)

- **Determinism.** Backgrounds render on the export path, so every fragment op must be
  bit-reproducible across runs. Driver-defined float tricks (`fract(sin())` hashes) break
  byte-identical export; the house PCG integer hash does not.
- **Foreground first.** Every preset colour stop must hold WCAG AA alone against the preset's
  text colour (black for light, white for dark), because the fill animates under the text.
  Bands, counts and naming voice: `docs/backgrounds.md`.

## Instructions

1. **Create the def** at `src/toolkit/stage/shaders/<name>.ts` exporting a
   `ShaderBackgroundDef` (skeleton in REFERENCE.md). The fragment is a GLSL3 body: no
   `#version` or `precision` lines (three prepends them), but it MUST declare and write its own
   `out vec4 fragColor;`. This three version does not alias `gl_FragColor` for GLSL3 custom
   shaders; forgetting the declaration renders black, not an error.
2. **Patch out float-hash randomness.** Replace any `fract(sin(dot(...)))` style hash with the
   PCG-style integer hash from `src/engine/transitionShader.ts` (`hash01`), keeping the source
   function's name and signature so the rest of the fragment stays untouched. Floor `vec2`
   inputs through `ivec2` before the `uvec2` cast (float-to-uint is undefined for negatives).
3. **Leave engine-owned uniforms out of `uniforms()`.** `u_time`, `u_resolution`, `u_scale`,
   `u_rotation`, `u_offsetX/Y` and `u_linearOut` are written by the engine quad. If the effect
   needs texture noise, set `noise: true`, keep the `sampler2D u_noiseTexture` declaration and
   exclude it too; the engine attaches the shared `DataTexture` from `noiseTexture.ts`. Never
   embed a new image; decode to raw bytes at vendor time like `NOISE_B64`. The fragment writes
   display-domain colour raw; the engine wraps `main()` (`shaders/wrap.ts`) so compositor
   render targets receive linear light instead (`wrap.test.ts` pins the rewrite markers).
4. **Register it** in `src/toolkit/stage/shaders/index.ts`: add to `SHADER_BACKGROUNDS` and to
   `SHADER_BACKGROUND_IDS` (the inspector's display order).
5. **If ported, record the attribution.** Add the source file to
   `src/toolkit/stage/shaders/NOTICE.md` plus a bullet per behavioural adaptation. Original
   GLSL needs no NOTICE entry.
6. **Author the 9 presets** in `presets.ts`: `p1` to `p5` light, `p6` to `p9` dark, Australian
   nature names unique across the pack, every stop inside the luminance bands (light >= 0.30,
   dark <= 0.125), muted saturation, speeds around 0.3 to 0.5. Keep 2.5:1 to 3:1 between each
   preset's darkest and lightest stop (flatter than that and the motion disappears) and give
   every preset its own parameter personality, not just a hue swap. Set the def's
   `colorSlots[].fallback` to the `p6` colours; a vitest pins the match.
7. **Add the preview fixtures** in a NEW `projects/preview-lab-bg-<shader>/` project (the
   option-previews action discovers lab projects by directory prefix; a vitest guards the
   pairing): one `bg-<shader>` pair (the type
   card's motion clip), one `bg-<shader>-light` pair (the light-theme card, mirroring p1) and
   nine `bgp-<shader>-p1..p9` pairs (preset tiles), each a trivial `.tsx` plus a sidecar whose
   `background` block mirrors the preset exactly (templates in REFERENCE.md). Register all
   eleven in the lab's own `project.json`. `optionPreviews.test.ts` fails on any drift between
   fixtures and presets.
8. **Validate, then regenerate thumbnails.**

   ```bash
   pnpm build && pnpm test && pnpm lint          # fix and rerun until clean
   pnpm kookaburra:run --action option-previews  # renders ONLY stale sets (manifest diff)
   ```

   The run hashes fixtures against `src/assets/option-previews/manifest.json` and captures
   only stale sets, so a new shader renders its own eleven sets in its own small lab project;
   `--all` forces a full re-record (engine-change refreshes).

   Then eyeball the new stills in `src/assets/option-previews/`. Verify proves determinism,
   not correctness; a black tile means a missing `out vec4 fragColor;` or a bad uniform.
9. **Gate it.** A new shader is a new render code path: run the standard gate pair from
   CLAUDE.md (feature-matched project Verify x2 in 16:9, plus `ws:launch-2026` 16:9 EQUAL as
   the null-for-legacy proof). Preset colour changes alone are data and need no Verify.

## 3D looks (scene3d)

World-space animated backgrounds live in `src/toolkit/stage/scene3d/` (registry `index.ts`,
presets `presets.ts`); the contract is in `docs/backgrounds.md` ("3D backgrounds"). The same
shipping flow applies, with these differences:

1. A look is a React component receiving `{ colors, params, speed }`, mounted inside the
   scene's identity group. Motion comes from `useTimeline()` only (commit-phase CPU updates or
   whole-group transforms); seeded randomness via `createSeededRandom` with a fixed seed.
2. Stay OUT of the content volume (x/y roughly +-4/+-2, z -6..9): keep-out clearances and
   distance fades, tag the root `userData.kookaburraBg3d` (the perf probe's `no-bg3d` pass).
   Floors want a small stage-courtesy clearing (~4u), not a content-radius ring.
3. Unlit looks hold exact colours (`toneMapped: false`); `lit: true` looks use standard
   materials with an `ABSTRACT_EMISSIVE` floor so they read on unlit scenes.
4. Presets carry geometry `colors` plus a flat `backing` hex; bands and AA apply to ALL of
   them (`scene3d/presets.test.ts`). Fixtures include a static elevated camera pose
   (`segments: []` is REQUIRED beside `keys` or the block drops whole).
5. Thin 1px lines vanish at tile size and can whisper at 4K: densify geometry and push dark
   lines toward the 0.125 cap before reaching for preview tricks; eyeball at BOTH scales via
   an `ws:` spike screenshot.
