/** The fluid gradient as a shape fill: any shader background's fragment, rewritten so a shape's own shader can sample it per fragment at its SCREEN position, so every filled shape looks through one shared gradient. The pattern lays out against the export format (never the live canvas) and its time is the absolute project clock read per draw, the background's own rules (docs/determinism.md, "The fixed background"). Its display-domain output decodes to linear and leaves through three's own output encode, so a filled shape lands in every render target exactly like a flat `RoundedRect`. */

import { useMemo } from "react";
import { type IUniform, Vector2 } from "three";
import { useClockStore } from "../../engine/clock";
import { bytesToHex, hexToBytes, hexToOklch, mixOklch, oklchToBytes } from "../../theme/oklch";
import type { Theme } from "../../theme/tokens";
import { SHADER_BACKGROUNDS } from "../stage/shaders";
import { getShaderNoiseTexture } from "../stage/shaders/noiseTexture";
import type { ShaderBackgroundDef } from "../stage/shaders/types";
import { FRAGMENT_MAIN_MARKER, FRAGMENT_OUT_MARKER } from "../stage/shaders/wrap";

/** A fluid fill for `RoundedRect`, `Pill` and `DotField`. Every field is optional: `true` (or `{}`) is the mesh gradient in colours drawn from the theme accent. */
export interface FluidFill {
  /** A shader background id (`kb catalog backgrounds`); default "mesh-gradient", the fluid one. */
  shader?: string;
  /** Hex colours or theme tokens (`text`, `muted`, `accent`, `background`); absent derives deep, mid and highlight shades from the theme accent. */
  colors?: readonly string[];
  /** The shader's own params by name (the background inspector's sliders); absent takes each default. */
  params?: Readonly<Record<string, number>>;
  /** Flow speed on the project clock (default 0.4). */
  speed?: number;
  /** Pattern zoom, 1 being the background's own: lower shows more of the gradient inside a small shape (default 0.6). */
  scale?: number;
}

export interface ResolvedFluidFill {
  def: ShaderBackgroundDef;
  /** Display-domain 0-1 RGBA, the background convention. */
  colors: [number, number, number, number][];
  params: Record<string, number>;
  speed: number;
  scale: number;
  /** A stable identity for the material memo. */
  key: string;
}

export const FLUID_FILL_DEFAULT_SHADER = "mesh-gradient";
export const FLUID_FILL_DEFAULT_SPEED = 0.4;
export const FLUID_FILL_DEFAULT_SCALE = 0.6;

// The accent ramp: OKLCH lightness steps and the highlight's pull toward white (pinned: moving one recolours every default fill).
const DEEP_L = 0.16;
const SHADE_L = 0.07;
const SHADE_HUE_DEG = 12;
const HIGHLIGHT_MIX = 0.85;
const L_RANGE = { lo: 0.18, hi: 0.98 };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TOKENS = ["text", "muted", "accent", "background"] as const;
type Token = (typeof TOKENS)[number];

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** A theme token (`text`, `muted`, `accent`, `background`) or hex as a hex; null for anything else. */
export function themeColourHex(theme: Theme, value: string): string | null {
  const v = value.trim();
  if ((TOKENS as readonly string[]).includes(v)) return theme.colors[v as Token] ?? null;
  return HEX.test(v) ? v : null;
}

/** Deep, mid, highlight and a hue-shifted shade of the theme accent: the cobalt-to-ice value material, in any brand colour. */
export function accentFluidColours(accent: string): string[] {
  const base = hexToOklch(HEX.test(accent) ? accent : "#3a67b8");
  const at = (l: number, c = base.c, h = base.h) =>
    bytesToHex(
      oklchToBytes({ l: Math.min(L_RANGE.hi, Math.max(L_RANGE.lo, l)), c: Math.max(0, c), h }),
    );
  const white = { l: 1, c: 0, h: base.h };
  const highlight = mixOklch(base, white, HIGHLIGHT_MIX);
  return [
    at(base.l - DEEP_L),
    at(base.l),
    at(highlight.l, highlight.c),
    at(base.l - SHADE_L, base.c, (base.h + SHADE_HUE_DEG) % 360),
  ];
}

/** Hex to display-domain 0-1 RGBA, opaque (the background's `hexToRgba`). */
function srgbRgba(hex: string): [number, number, number, number] {
  const [r, g, b] = hexToBytes(hex);
  return [r / 255, g / 255, b / 255, 1];
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Resolves a fill against the theme: null for no fill. An unknown shader warns once and takes the mesh gradient; colours a shader's fixed slots can't hold cycle, and an array shader takes exactly the colours given. Pure. */
export function resolveFluidFill(
  fill: FluidFill | boolean | null | undefined,
  theme: Theme,
): ResolvedFluidFill | null {
  if (!fill) return null;
  const spec: FluidFill = fill === true ? {} : fill;
  let id = spec.shader ?? FLUID_FILL_DEFAULT_SHADER;
  if (!Object.hasOwn(SHADER_BACKGROUNDS, id)) {
    warnOnce(`shader:${id}`, `[fill] unknown shader "${id}", using "${FLUID_FILL_DEFAULT_SHADER}"`);
    id = FLUID_FILL_DEFAULT_SHADER;
  }
  const def = SHADER_BACKGROUNDS[id];
  const given = (spec.colors ?? [])
    .map((c) => (typeof c === "string" ? themeColourHex(theme, c) : null))
    .filter((c): c is string => c !== null);
  const source = given.length > 0 ? given : accentFluidColours(theme.colors.accent);
  const count = def.maxColors ? Math.min(def.maxColors, source.length) : def.colorSlots.length;
  const hexes = Array.from({ length: count }, (_, i) => source[i % source.length]);
  const params: Record<string, number> = {};
  for (const [key, p] of Object.entries(def.params)) {
    params[key] = Math.min(p.max, Math.max(p.min, finite(spec.params?.[key], p.default)));
  }
  const speed = finite(spec.speed, FLUID_FILL_DEFAULT_SPEED);
  const scale = Math.max(0.05, finite(spec.scale, FLUID_FILL_DEFAULT_SCALE));
  return {
    def,
    colors: hexes.map(srgbRgba),
    params,
    speed,
    scale,
    key: JSON.stringify([id, hexes, params, speed, scale]),
  };
}

/** `resolveFluidFill` memoised on the spec's JSON, so an inline object prop keeps one material across frames. */
export function useResolvedFluidFill(
  fill: FluidFill | boolean | null | undefined,
  theme: Theme,
): ResolvedFluidFill | null {
  const specKey = fill ? JSON.stringify(fill) : "";
  return useMemo(
    () => (specKey ? resolveFluidFill(JSON.parse(specKey) as FluidFill | true, theme) : null),
    [specKey, theme],
  );
}

const IN_OBJECT = "in vec2 v_objectUV;";
const IN_PATTERN = "in vec2 v_patternUV;";

/** The def's fragment as a callable: `vec4 kkFluid(vec2 st)` returns its display-domain colour at `st`, the frame position from -0.5 to 0.5 (centre 0, the background quad's `uv - 0.5`). The varyings the def reads become globals kkFluid sets with the background vertex shader's own maths, so a fill and a background of the same spec draw the same pattern. */
export function fluidFillFunction(fragment: string): string {
  const body = fragment
    .replace(FRAGMENT_OUT_MARKER, "vec4 fragColor;")
    .replace(FRAGMENT_MAIN_MARKER, "void kkFluidMain() {")
    .replace(IN_OBJECT, "vec2 v_objectUV;")
    .replace(IN_PATTERN, "vec2 v_patternUV;");
  const globals =
    (fragment.includes(IN_OBJECT) ? "" : "vec2 v_objectUV;\n") +
    (fragment.includes(IN_PATTERN) ? "" : "vec2 v_patternUV;\n");
  return `${globals}${body}
uniform vec2 u_kkFrame;
uniform float u_kkScale;
vec4 kkFluid(vec2 st) {
  vec2 ws = u_kkFrame / max(u_kkFrame.x, u_kkFrame.y);
  v_objectUV = (st * ws) / u_kkScale;
  v_patternUV = ((st * u_kkFrame) / u_kkScale) * 0.01;
  kkFluidMain();
  return fragColor;
}
vec3 kkSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;
}

/** The vertex-side line a fill needs: hand the fragment its clip position, divided per fragment so the screen position stays exact under perspective. */
export const FLUID_CLIP_VARYING = "vKkClip";

/** The fragment's screen position for kkFluid, from the clip varying. */
export const FLUID_SCREEN_ST = `(0.5 * ${FLUID_CLIP_VARYING}.xy / ${FLUID_CLIP_VARYING}.z)`;

/** Static uniforms for a resolved fill at the export format; `u_time` is written per draw by `writeFluidTime`. */
export function fluidFillUniforms(
  fill: ResolvedFluidFill,
  format: { width: number; height: number },
): Record<string, IUniform> {
  return {
    ...fill.def.uniforms(fill.colors, fill.params),
    // The shared randomiser builds synchronously (a DataTexture), so no export barrier is needed.
    ...(fill.def.noise ? { u_noiseTexture: { value: getShaderNoiseTexture() } } : {}),
    u_time: { value: 0 },
    u_resolution: { value: new Vector2(format.width, format.height) },
    u_kkFrame: { value: new Vector2(format.width, format.height) },
    u_kkScale: { value: fill.scale },
  };
}

/** The flow's clock: the ABSOLUTE project time, so the pattern runs on across cuts and every filled shape in a frame agrees. */
export function fluidTimeSeconds(currentMs: number, speed: number): number {
  return (currentMs / 1000) * speed;
}

/** An `onBeforeRender` writer for a fill material's time. */
export function writeFluidTime(uniforms: Record<string, IUniform>, speed: number): void {
  const u = uniforms.u_time;
  if (u) u.value = fluidTimeSeconds(useClockStore.getState().currentMs, speed);
}
