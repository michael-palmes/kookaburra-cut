/** Pure resolution of the postprocessing params, no three.js/React/clock reads, so it unit-tests in isolation (mirrors clipFrame.ts vs the three-heavy clips.ts); the compositor feeds the resolved config to the EffectComposer wrapper (engine/effects.ts), and keeping this pure is what lets preview and export agree by construction. See docs/determinism.md. */
import type { EffectsConfig, EffectsOverride } from "../theme/tokens";

/** The grain seed for a frame: the integer frame index recovered from the clock. The export loop steps `tMs = frame * 1000 / fps`, so `round(tMs/1000*fps)` returns exactly `frame` (rounding absorbs float error), making grain a pure function of the frame + pixel coords, identical run to run (never `time`/`Math.random`). */
export function grainSeed(globalMs: number, fps: number): number {
  return Math.round((globalMs / 1000) * fps);
}

/** The "amount" field of each effect, the one that at 0 turns the effect off; used to fade an effect that exists on only one side of a transition in/out, rather than popping it. */
const AMOUNT_KEY = {
  bloom: "intensity",
  vignette: "darkness",
  lut: "intensity",
  grain: "intensity",
} as const;

const EFFECT_KEYS = ["bloom", "vignette", "lut", "grain"] as const;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Blend one effect present on A and/or B. Numeric fields lerp; string fields snap at t≥0.5. */
function blendOneEffect(
  key: (typeof EFFECT_KEYS)[number],
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  progress: number,
): Record<string, unknown> | undefined {
  if (a && b) {
    const out: Record<string, unknown> = {};
    for (const f of Object.keys(a)) {
      const av = a[f];
      const bv = b[f];
      out[f] =
        typeof av === "number" && typeof bv === "number"
          ? lerp(av, bv, progress)
          : progress >= 0.5
            ? bv
            : av;
    }
    return out;
  }
  const amount = AMOUNT_KEY[key];
  if (a) return { ...a, [amount]: lerp(a[amount] as number, 0, progress) };
  if (b) return { ...b, [amount]: lerp(0, b[amount] as number, progress) };
  return undefined;
}

/** Interpolates two resolved effect stacks across a cross-scene transition (`progress` 0->1). Shared effects lerp field-by-field; an effect on only one side fades its amount to/from 0 so it doesn't pop at the seam; non-numeric fields (a LUT url) snap at the midpoint since two 3D LUTs can't be blended. Pure, so effect frames stay a pure function of `t`. See docs/determinism.md. */
export function blendEffectParams(
  a: EffectsConfig,
  b: EffectsConfig,
  progress: number,
): EffectsConfig {
  const out: EffectsConfig = {};
  for (const k of EFFECT_KEYS) {
    const blended = blendOneEffect(
      k,
      a[k] as Record<string, unknown> | undefined,
      b[k] as Record<string, unknown> | undefined,
      progress,
    );
    if (blended !== undefined) out[k] = blended as never;
  }
  return out;
}

/** The base effect stack for a scene: a scene whose sidecar swaps the theme replaces the project-wide default wholesale with its own theme's stack (possibly empty, e.g. swapping to a plain theme turns effects off); manifest per-scene `effects` overrides still layer on top via `resolveEffectParams`. Scenes without a theme override use the project default. */
export function sceneBaseEffects(
  projectDefault: EffectsConfig,
  sceneDefaults: Record<number, EffectsConfig>,
  idx: number,
): EffectsConfig {
  return sceneDefaults[idx] ?? projectDefault;
}

/** Shallow-merge one effect's partial override onto its project default, returning a fresh object. */
function mergeEffect<T>(base: T | undefined, over: Partial<T> | undefined): T | undefined {
  if (!base && !over) return undefined;
  return { ...(base as object), ...(over as object) } as T;
}

/** Resolves the effect stack for a scene: the project-wide default (from the theme) with an optional per-scene override layered on top, field by field. An effect present in only one side survives; unspecified fields of an overridden effect keep the project default. Never mutates the inputs. */
export function resolveEffectParams(
  base: EffectsConfig,
  override?: EffectsOverride,
): EffectsConfig {
  if (!override) return { ...base };
  const out: EffectsConfig = { ...base };
  const keys = ["bloom", "vignette", "lut", "grain"] as const;
  for (const k of keys) {
    const merged = mergeEffect(base[k], override[k] as never);
    if (merged !== undefined) out[k] = merged as never;
  }
  return out;
}
