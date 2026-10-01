import { bytesToHex, hexToBytes, hexToOklch, mixOklch, oklchToBytes } from "../../../theme/oklch";
import type { GradientSpec, Theme, ThemeBackground } from "../../../theme/tokens";
import { SHADER_BACKGROUNDS } from "../shaders";
import { deriveThemeShaderColors } from "../shaders/themePreset";

type Rgb = [number, number, number];

/** Samples along the frame's middle row when a gradient backing collapses to one tone. */
export const BACKING_HORIZON_SAMPLES = 33;

/** The shader slot label that names an effect's ground (grids, swirl, neuro noise, smoke ring). */
export const SHADER_BACK_SLOT_LABEL = "Back";

/** Mirrors `gradientTexture`: radial t reaches 1 at the square's corners. */
const RADIAL_EXTENT = Math.SQRT1_2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (c: Rgb) => c.every(Number.isFinite);

function meanHex(colours: Rgb[]): string | null {
  if (colours.length === 0 || !colours.every(finite)) return null;
  const sum: Rgb = [0, 0, 0];
  for (const c of colours) for (let i = 0; i < 3; i++) sum[i] += c[i];
  return bytesToHex(sum.map((v) => Math.round(v / colours.length)) as Rgb);
}

/** The gradient's middle row (v 0.5) averaged in sRGB bytes, each sample interpolated exactly as the fixed raster does (`gradientTexture`: per-channel sRGB, or OKLCH when `space` asks). */
export function gradientHorizonTone(spec: GradientSpec): string | null {
  const oklch = spec.space === "oklch";
  const stops = [...spec.stops]
    .sort((a, b) => a[1] - b[1])
    .map(([hex, pos]) => ({ hex, rgb: hexToBytes(hex), pos }));
  if (stops.length === 0 || !stops.every((s) => finite(s.rgb))) return null;
  const a = (spec.angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const extent = 0.5 * (Math.abs(dx) + Math.abs(Math.cos(a))) || 1;
  const samples: Rgb[] = [];
  for (let i = 0; i < BACKING_HORIZON_SAMPLES; i++) {
    const u = i / (BACKING_HORIZON_SAMPLES - 1) - 0.5;
    const t =
      spec.type === "radial"
        ? Math.min(1, Math.abs(u) / RADIAL_EXTENT)
        : clamp01(((u * dx) / extent) * 0.5 + 0.5);
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].pos && t <= stops[s + 1].pos) {
        lo = stops[s];
        hi = stops[s + 1];
        break;
      }
    }
    const span = hi.pos - lo.pos;
    const k = span > 0 ? clamp01((t - lo.pos) / span) : 0;
    samples.push(
      oklch
        ? oklchToBytes(mixOklch(hexToOklch(lo.hex), hexToOklch(hi.hex), k))
        : (lo.rgb.map((c, j) => c + (hi.rgb[j] - c) * k) as Rgb),
    );
  }
  return meanHex(samples);
}

/** A shader fill's ground: its `Back` slot when the effect has one, else the sRGB mean of every colour it draws. Colours resolve exactly as FixedShader does (Theme preset, explicit, slot fallbacks, extras up to `maxColors`). */
export function shaderBackingTone(
  spec: Extract<ThemeBackground, { type: "shader" }>,
  theme: Theme,
): string | null {
  const def = SHADER_BACKGROUNDS[spec.shader];
  if (!def) return null;
  const source =
    (spec.themeColors ? deriveThemeShaderColors(spec.shader, theme) : null) ?? spec.colors;
  const named = def.colorSlots.map((slot, i) => source?.[i] ?? slot.fallback);
  const back = def.colorSlots.findIndex((slot) => slot.label === SHADER_BACK_SLOT_LABEL);
  if (back >= 0) return named[back];
  const extras = (source ?? []).slice(named.length, def.maxColors ?? named.length);
  return meanHex([...named, ...extras].map(hexToBytes));
}

/** The one sRGB hex a 3D look fades toward: a flat backing as is, a gradient's horizon row (distance fades converge on the middle of the frame), a shader's ground, and the frame clear colour (`colors.background`) for no backing, image and video. Pure. */
export function resolveScene3dBackingTone(
  backing: ThemeBackground | undefined,
  theme: Theme,
): string {
  const clear = theme.colors.background;
  switch (backing?.type) {
    case "color":
      return backing.color;
    case "gradient": {
      const spec =
        backing.spec ?? (backing.gradient ? theme.gradients?.[backing.gradient] : undefined);
      return (spec && gradientHorizonTone(spec)) ?? clear;
    }
    case "shader":
      return shaderBackingTone(backing, theme) ?? clear;
    default:
      return clear;
  }
}
