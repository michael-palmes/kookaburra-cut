import type { Theme } from "../theme/tokens";
import type { SceneDoc } from "./sceneDocSchema";
import type { SceneRenderState } from "./sceneState";
import type { Resolved } from "./sceneTimeline";

/** The before/after comparison engine: pure helpers deriving side B's doc from the base (side A), normalising the compare block (mask, divider track, chrome with theme-token colours resolved), and resolving the per-frame divider. The compositor renders side A and side B to the transition machinery's A/B targets and composites them under the mask; both preview and export resolve through `resolveCompareFrame` so they cannot drift. Divider values are CPU-computed here, never time-derived in GLSL (the transition invariant). See docs/determinism.md. */

export type CompareMaskType = "linear" | "circle" | "radial" | "blend";

/** Shader-ready mask-type ids (pinned by the catalogue test; the compare fragment dispatches on them). */
export const COMPARE_MASK_ID: Record<CompareMaskType, number> = {
  linear: 0,
  circle: 1,
  radial: 2,
  blend: 3,
};

/** Resolved chrome: colours are sRGB hex (token names resolved against side A's theme), sizes in 1080-tall reference pixels; zero width/size means off. */
export interface CompareChrome {
  lineWidth: number;
  lineColor: string;
  lineSoftness: number;
  gripSize: number;
  chips: boolean;
  tintA: string | null;
  tintB: string | null;
  tintAmount: number;
}

/** A normalised comparison, precomputed once per doc: mask params with defaults baked, track keys sorted, chrome resolved. */
export interface CompareSpec {
  maskType: CompareMaskType;
  /** The divider LINE's angle in degrees (linear only; 90 = vertical divider sweeping horizontally). */
  angleDeg: number;
  /** Feathered edge half-width in normalised units; 0 = hard edge. */
  softness: number;
  /** Mask centre in uv (circle and radial). */
  center: [number, number];
  /** Static divider position, used when `keys` is empty. */
  value: number;
  /** Sorted (atMs ascending) divider keys; linear interpolation between them. */
  keys: readonly { atMs: number; value: number }[];
  chrome: CompareChrome;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A hex colour as display-sRGB components 0..1 (no colour management: the compare chrome blends in the display domain). Malformed hexes fall back to mid grey. */
export function hexToSrgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A chrome token resolved to hex against a theme; unknown tokens (or no theme) fall back to the accent. */
function tokenHex(token: string | undefined, theme: Theme | undefined, fallback: string): string {
  if (!theme) return fallback;
  const colours = theme.colors as unknown as Record<string, string>;
  return (token && colours[token]) || theme.colors.accent;
}

/** Normalise a doc's compare block, resolving chrome colours against the scene's (side A) theme; null when the doc has none. */
export function compareSpecOf(doc: SceneDoc | undefined, theme?: Theme): CompareSpec | null {
  const c = doc?.compare;
  if (!c) return null;
  const keys = [...(c.track?.keys ?? [])]
    .map((k) => ({ atMs: k.atMs, value: clamp01(k.value) }))
    .sort((a, b) => a.atMs - b.atMs);
  const chromeRaw = c.chrome;
  const line = chromeRaw?.line;
  const grip = chromeRaw?.grip;
  const tint = chromeRaw?.tint;
  const chrome: CompareChrome = {
    lineWidth: line ? (line.width ?? 4) : 0,
    lineColor: tokenHex(line?.colour, theme, "#6f93a8"),
    lineSoftness: line?.softness ?? 0,
    gripSize: grip ? (typeof grip === "object" ? (grip.size ?? 1) : grip ? 1 : 0) : 0,
    chips: chromeRaw?.chips === true,
    tintA: tint?.a ? tokenHex(tint.a, theme, "#6f93a8") : null,
    tintB: tint?.b ? tokenHex(tint.b, theme, "#6f93a8") : null,
    tintAmount: tint ? (tint.amount ?? 0.08) : 0,
  };
  return {
    maskType: c.mask?.type ?? "linear",
    angleDeg: c.mask?.angleDeg ?? 90,
    softness: c.mask?.softness ?? 0,
    center: c.mask?.center ?? [0.5, 0.5],
    value: clamp01(c.value ?? 0.5),
    keys,
    chrome,
  };
}

/** Sample the divider at a scene-local time: linear interpolation between keys, clamped to the end keys; the static value with no keys. */
export function compareValueAt(spec: CompareSpec, localMs: number): number {
  const keys = spec.keys;
  if (keys.length === 0) return spec.value;
  if (localMs <= keys[0].atMs) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localMs >= last.atMs) return last.value;
  for (let i = 1; i < keys.length; i++) {
    if (localMs <= keys[i].atMs) {
      const a = keys[i - 1];
      const b = keys[i];
      const t = b.atMs === a.atMs ? 1 : (localMs - a.atMs) / (b.atMs - a.atMs);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/** The mask's scalar field at a uv point, in the same normalised units the shader uses (linear: position along the sweep axis; circle: distance from centre over the far corner; radial: angle around the centre; blend has no field). Exported so the chips' fade shares the exact shader maths. */
export function compareFieldAt(spec: CompareSpec, uv: [number, number], aspect: number): number {
  if (spec.maskType === "linear") {
    const px = (uv[0] - 0.5) * aspect;
    const py = uv[1] - 0.5;
    const sweepRad = ((spec.angleDeg - 90) * Math.PI) / 180;
    const dx = Math.cos(sweepRad);
    const dy = Math.sin(sweepRad);
    const hi = 0.5 * (aspect * Math.abs(dx) + Math.abs(dy));
    return clamp01(0.5 + (0.5 * (px * dx + py * dy)) / Math.max(hi, 1e-5));
  }
  const qx = (uv[0] - spec.center[0]) * aspect;
  const qy = uv[1] - spec.center[1];
  if (spec.maskType === "radial") {
    return Math.atan2(qy, qx) * 0.15915494 + 0.5;
  }
  const cx = Math.max(spec.center[0], 1 - spec.center[0]) * aspect;
  const cy = Math.max(spec.center[1], 1 - spec.center[1]);
  return Math.hypot(qx, qy) / Math.max(Math.hypot(cx, cy), 1e-5);
}

/** How much side `side` covers a uv point, 0..1 (soft within the mask's feather band): side A holds where the field is BELOW the divider on linear masks and OUTSIDE the window on circle/radial; blend is the divider value itself. Chips fade by this. */
export function compareCoverageAt(
  spec: CompareSpec,
  value: number,
  uv: [number, number],
  aspect: number,
  side: "a" | "b",
): number {
  if (spec.maskType === "blend") return side === "a" ? 1 - value : value;
  const field = compareFieldAt(spec, uv, aspect);
  const band = Math.max(spec.softness, 0.04);
  const inA =
    spec.maskType === "linear"
      ? clamp01((value - field) / band + 0.5)
      : clamp01((field - value) / band + 0.5);
  return side === "a" ? inA : 1 - inA;
}

/** Derive side B's doc from the base: the base doc with `compare.b`'s overrides applied. The compare block itself stays (host-side chrome like the chips reads it from either side's doc); recursion is impossible since only project load derives, and only from base docs. Null when the doc has no compare block. */
export function deriveCompareBDoc(doc: SceneDoc | undefined): SceneDoc | null {
  const c = doc?.compare;
  if (!doc || !c) return null;
  const b = structuredClone(doc);
  const side = c.b;
  if (!side) return b;
  if (side.themeId !== undefined) b.themeId = side.themeId;
  if (side.background !== undefined) b.background = side.background;
  if (side.lighting !== undefined) b.lighting = side.lighting;
  if (side.media) {
    for (const device of b.devices ?? []) {
      const media = side.media[device.id];
      if (media) device.media = media;
    }
  }
  return b;
}

/** Everything the compositor needs for one compare frame: the divider sampled at the scene's local time, the whole normalised spec (mask + chrome), and each side's root-scene render state (absent when the project never opts into themed scene state). */
export interface CompareFrame {
  index: number;
  /** Divider position 0..1 along the mask's field (side A below it on linear masks). */
  value: number;
  spec: CompareSpec;
  stateA?: SceneRenderState;
  stateB?: SceneRenderState;
}

/** Resolve the frame's compare plan; null when the active scene has no comparison. Transition frames (two active scenes) deliberately resolve null: the compositor's transition path then blends side A only (the v1 interop rule; hard cuts show the full comparison). */
export function resolveCompareFrame(
  specs: readonly (CompareSpec | null)[],
  statesA: readonly SceneRenderState[] | null,
  statesB: readonly (SceneRenderState | null)[] | null,
  resolved: Resolved,
): CompareFrame | null {
  if (resolved.active.length !== 1) return null;
  const active = resolved.active[0];
  const spec = specs[active.index];
  if (!spec) return null;
  return {
    index: active.index,
    value: compareValueAt(spec, active.localMs),
    spec,
    stateA: statesA?.[active.index],
    stateB: statesB?.[active.index] ?? undefined,
  };
}
