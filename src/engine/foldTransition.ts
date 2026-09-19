/** How a foldable's two displays behave as it folds: a pure function of the hinge angle (0 closed, 180 open flat), so any pose or keyframe gets it for free and an exported frame never depends on what came before. Every constant here is export contract. */

/** Options a scene may set on a foldable; all optional, all clamped at resolve time. */
export interface DeviceFoldTransitionSpec {
  /** The hinge angle where power hands over from the outside display to the inside one. */
  switchDeg?: number;
}

export const FOLD_SWITCH_DEG = 45;
/** Half-width of the power handover around the switch angle. */
export const FOLD_POWER_WINDOW_DEG = 15;
const FOLD_OPEN_DEG = 180;

/** Display brightness, 0 off to 1 lit. */
export interface FoldScreenLevels {
  main: number;
  cover: number;
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** The switch angle, held far enough from both ends that closed is always wholly the outside display and open wholly the inside one. */
export function resolveFoldSwitchDeg(spec: DeviceFoldTransitionSpec | undefined): number {
  const raw = spec?.switchDeg;
  const deg = typeof raw === "number" && Number.isFinite(raw) ? raw : FOLD_SWITCH_DEG;
  return Math.min(FOLD_OPEN_DEG - FOLD_POWER_WINDOW_DEG, Math.max(FOLD_POWER_WINDOW_DEG, deg));
}

/** Auto power: the outside display is lit while closed and the inside one while open, handing over across the window so a fold never pops. `bothOn` is the scene's override for poses that show both. */
export function foldScreenLevels(
  foldDeg: number,
  spec: DeviceFoldTransitionSpec | undefined,
  bothOn: boolean,
): FoldScreenLevels {
  if (bothOn) return { main: 1, cover: 1 };
  const at = resolveFoldSwitchDeg(spec);
  const main = smoothstep(at - FOLD_POWER_WINDOW_DEG, at + FOLD_POWER_WINDOW_DEG, foldDeg);
  return { main, cover: 1 - main };
}

/** When a fold first carries the device to the switch angle, in scene-local ms: where an inside video marked `startOn: "open"` begins, so the app appears to carry on as the device opens. Steps the frames that will actually render instead of solving the ease, so it is exact and survives eases that overshoot. 0 when it starts open; null when it never opens that far (the caller falls back to the plain start delay). `untilMs` is the last key's time: the angle holds after it. */
export function foldOpenedAtMs(
  foldDegAt: (localMs: number) => number,
  untilMs: number,
  switchDeg: number,
  fps: number,
): number | null {
  const lastFrame = Math.ceil((Math.max(0, untilMs) / 1000) * fps);
  for (let frame = 0; frame <= lastFrame; frame++) {
    const localMs = (frame * 1000) / fps;
    if (foldDegAt(localMs) >= switchDeg) return localMs;
  }
  return null;
}
