# Background and theme colour requirements

The rules for every colour that ships in an animated (shader) background preset, a gradient
preset or a theme. The intent behind all of them: **the text or device is the star of the
show**. A background supports the foreground; it never competes with it.

## The contract

1. **Every preset targets exactly one text colour.** Light presets carry black text
   (`textColor: "#000000"`), dark presets carry white text (`textColor: "#ffffff"`).
2. **Every colour stop passes WCAG AA (4.5:1) against that text colour on its own.** The fill
   animates under the text, so any stop can sit behind any glyph on some frame. Averages and
   "mostly light" mixes do not count; the worst stop is the contract.
3. **Authoring bands (stricter than AA, enforced by vitest):**
   - Light preset stops: relative luminance **>= 0.30**
   - Dark preset stops: relative luminance **<= 0.125**

   The bands guarantee at least 6:1 against the pure text colour. The margin is deliberate:
   bundled themes use softened text tokens (near-white `#f5f7fa`, near-black `#23272c`), which
   cost roughly a third of the contrast ratio against a mid-band background. The softest
   bundled token (`#dce4f2`) needs dark stops at or below 0.127 to hold AA; the 0.125 cap is
   that limit with a hair of margin.
4. **Subtle, but visible.** Keep saturation muted and speeds around 0.3 to 0.5 with gentle
   params. Subtlety is not flatness though: a preset needs 2.5:1 to 3:1 contrast between its
   darkest and lightest stop or the motion disappears entirely. For dark presets keep the base
   stops deep (0.005 to 0.02) and let the accent stops reach the top of the band; for light
   presets span roughly 0.5 to 0.9. Give each preset in a pack its own parameter personality
   (band count, twist, softness, steps, shape) so presets differ in character, not just hue.
   If a background draws the eye before the headline does, it is too bold.

Relative luminance and contrast are the WCAG 2.x definitions; the reference implementation
lives in `src/toolkit/stage/shaders/presets.test.ts`.

## Preset structure

Each shader background ships **9 presets**: `p1` to `p5` light, `p6` to `p9` dark, in that
order. Ids are shader-scoped. Data lives in `src/toolkit/stage/shaders/presets.ts`; the
inspector applies a preset wholesale (colours, speed, params land explicitly in the scene
sidecar), so rendering never reads the preset module.

**Naming voice:** Australian nature, one or two words per look, unique across the whole pack.
Light names lean coastal and botanical (Shell Beach, Wattle, Jacaranda, Ghost Gum); dark names
lean night and deep country (Bass Strait, Nullarbor Night, Ironbark, Red Centre).

**Defaults:** each shader's `colorSlots[].fallback` values are its first dark preset (`p6`),
so a freshly picked background reads correctly with white text on the default dark theme. A
vitest pins the match.

## Themes

- `theme.colors.background` is the frame-clear colour only; the animated/gradient `background`
  block is a separate camera-locked fill drawn over it. Keep them tonally consistent.
- Theme text tokens are near-black or near-white, never pure. Any background a theme bundles
  must satisfy the contract above against that theme's text token, not just pure black/white.
- Gradient presets (`src/theme/gradientPresets.ts`) follow the same `mode` + `textColor`
  contract: 5 stops, every stop AA against the declared text colour.

## Enforcement and regeneration

- `src/toolkit/stage/shaders/presets.test.ts` enforces counts, ordering, the luminance bands,
  AA contrast, the fallback pin and param bounds.
- `src/engine/optionPreviews.test.ts` pins the `bgp-*` preview-lab fixtures to the preset data;
  fixtures and presets must change together.
- After changing preset data: regenerate the committed picker thumbnails with
  `pnpm kookaburra:run --action option-previews`, then eyeball a few stills. Verify proves
  determinism, not correctness; only your eyes prove a palette looks right.
- Preset data is data, not a render code path: colour-only changes do not need Verify runs
  (see "Gate economy" in CLAUDE.md).
