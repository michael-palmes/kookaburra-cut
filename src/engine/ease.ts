/** Deterministic easing curves, named after anime.js v4's built-in eases so scene documents read familiarly but implemented as pure closed-form functions (the camera track and motion presets must be pure functions of the clock). The exact curve values are part of the export contract, so changing any formula (or `BACK_OVERSHOOT`) is a breaking change to every committed project; guarded by golden values in ease.test.ts, like the seeded RNG. `jump` is the "jump cut": holds the start value for the whole segment and snaps to the end value exactly at the segment's end keyframe. */

const HALF_PI = Math.PI / 2;
/** Penner's classic back-ease overshoot constant. */
const BACK_OVERSHOOT = 1.70158;
const BACK_INOUT = BACK_OVERSHOOT * 1.525;

/** Maps eased progress `t ∈ [0, 1]` → eased value (0 → 0, 1 → 1; `jump` excepted at t < 1). */
export type EaseFn = (t: number) => number;

const IN: Record<string, EaseFn> = {
  Sine: (t) => 1 - Math.cos(t * HALF_PI),
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t * t * t * t,
  Quint: (t) => t * t * t * t * t,
  Expo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  Circ: (t) => 1 - Math.sqrt(1 - t * t),
  Back: (t) => (BACK_OVERSHOOT + 1) * t * t * t - BACK_OVERSHOOT * t * t,
};

function out(fn: EaseFn): EaseFn {
  return (t) => 1 - fn(1 - t);
}

function inOut(fn: EaseFn): EaseFn {
  return (t) => (t < 0.5 ? fn(2 * t) / 2 : 1 - fn(2 - 2 * t) / 2);
}

/** The easing families exposed to the UI/scene documents (each as in / out / inOut). */
export const EASE_FAMILIES = [
  "Sine",
  "Quad",
  "Cubic",
  "Quart",
  "Quint",
  "Expo",
  "Circ",
  "Back",
] as const;
export type EaseFamily = (typeof EASE_FAMILIES)[number];

export type EaseName = "linear" | "jump" | `${"in" | "out" | "inOut"}${EaseFamily}`;

/** The scene-document / UI default (the camera picker's "Default"). */
export const DEFAULT_EASE: EaseName = "inOutQuad";

function buildTable(): Record<EaseName, EaseFn> {
  const table = {
    linear: (t: number) => t,
    jump: (t: number) => (t >= 1 ? 1 : 0),
  } as Record<EaseName, EaseFn>;
  for (const family of EASE_FAMILIES) {
    const base = IN[family];
    table[`in${family}`] = base;
    table[`out${family}`] = out(base);
    // inOutBack composes with the wider overshoot constant, per the Penner canon that anime.js and CSS easings follow, not a straight mirror of inBack.
    table[`inOut${family}`] =
      family === "Back"
        ? (t: number) =>
            t < 0.5
              ? ((2 * t) ** 2 * ((BACK_INOUT + 1) * 2 * t - BACK_INOUT)) / 2
              : ((2 * t - 2) ** 2 * ((BACK_INOUT + 1) * (2 * t - 2) + BACK_INOUT) + 2) / 2
        : inOut(base);
  }
  return table;
}

const EASES: Record<EaseName, EaseFn> = buildTable();

/** Every valid ease name (stable order: linear, jump, then in/out/inOut per family). */
export const EASE_NAMES = Object.keys(EASES) as EaseName[];

export function isEaseName(name: string): name is EaseName {
  return name in EASES;
}

/** Evaluates the named ease at progress `t`, clamped to [0, 1]; unknown names fall back to `DEFAULT_EASE` (a scene document edited by hand must degrade, not crash). */
export function ease(name: string, t: number): number {
  const fn = (isEaseName(name) ? EASES[name] : EASES[DEFAULT_EASE]) as EaseFn;
  return fn(t < 0 ? 0 : t > 1 ? 1 : t);
}
