/** How a foldable's two displays behave as it folds: a pure function of the hinge angle (0 closed, 180 open flat), so any pose or keyframe gets it for free and an exported frame never depends on what came before. Every constant here is export contract. */

/** Options a scene may set on a foldable; all optional, all clamped at resolve time. */
export interface DeviceFoldTransitionSpec {
  /** The hinge angle where power hands over from the outside display to the inside one. */
  switchDeg?: number;
  /** The blur handover (default on): the interface blurs and dims off the outside display and clears across the inside one as it opens. Off leaves the plain brightness handover. */
  enabled?: boolean;
  /** 0 to 1, scaling the whole effect (default 1); 0 is the plain handover. */
  intensity?: number;
  /** 0 to 1 multipliers on the blur radius and the dimming depth alone (default 1). */
  blur?: number;
  darken?: number;
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

// ── The blur handover ────────────────────────────────────────────────────────
// Read off Apple's own footage. While a fold carries the device across the power switch, the moving panel's content is drawn FLAT as seen from a fixed eye in front (so a horizon stays level across the hinge while the panel's edges converge, and the panel is black where that content runs out), and a front sweeps the moving panel with everything beyond it progressively blurred and dimmed. The outside display loses its picture from its free edge back to the hinge and is gone by edge-on; the inside display's swinging half only faces the viewer past that, and clears from the hinge outwards. The static half is normal throughout. At rest there is no handover at all: a held Book or Flex pose is simply lit and sharp.

/** Fixed kernel size, and the largest blur radius as a fraction of ONE panel's width (about 6 mm on the Duo). */
export const FOLD_BLUR_TAPS = 32;
export const FOLD_BLUR_MAX_RADIUS = 0.08;
/** The handover ramp, measured off Apple's footage along a uniform row: one smooth ramp across the moving panel, its far end pinned just past the panel's free edge (`EDGE`, in panel widths from the hinge) and its near end retreating towards the hinge as the panel turns away from home: `EDGE - SPAN * (turn / KNEE_DEG) ^ POWER`. Both displays obey it, each by its own turn from home, which is why the swinging half mirrors the outside display. */
export const FOLD_RAMP_EDGE = 1.05;
export const FOLD_RAMP_SPAN = 0.8;
export const FOLD_RAMP_KNEE_DEG = 45;
export const FOLD_RAMP_POWER = 0.45;
/** The picture softens before it dims (at 45 degrees the hinge side is already soft while still bright): the blur's ramp starts this far ahead of the dimming's, in panel widths, and saturates in half the distance. Dimming stops just short of black, as measured (about 12% left at the free edge). */
export const FOLD_BLUR_AHEAD = 0.35;
/** The lead eases in over the panel's first degrees from home, so a panel AT home is exactly untouched. */
export const FOLD_BLUR_AHEAD_BY_DEG = 15;
export const FOLD_BLUR_LEAD = 2;
export const FOLD_DARKEN_MAX = 0.9;
/** How far onto the static half the ramp is allowed to fade out, in panel widths: the static half stays normal. */
export const FOLD_STATIC_GUARD = 0.12;
/** The outside display is lit until it nears edge-on, then off: past that it faces away. */
export const FOLD_COVER_OFF_FROM_DEG = 75;
export const FOLD_EDGE_ON_DEG = 90;
/** How much of the range the flat projection takes to ease in and out, so a fold that starts or stops part way never pops. */
export const FOLD_FLAT_EASE = 0.06;
/** The fixed front eye's distance from the display, in display heights: about arm's length. */
export const FOLD_EYE_HEIGHTS = 2.7;

/** One display's shader state. `coord = offset + scale * u` maps the panel's horizontal UV onto the hinge axis (0 at the hinge, positive along the moving panel to 1 at its free edge, negative onto a static half). The ramp rises from `front` over `ramp` panel widths. */
export interface FoldScreenState {
  /** Overall brightness, 0 off to 1 lit. */
  level: number;
  front: number;
  /** Where the blur's ramp starts: `front`, less its lead. */
  softFront: number;
  ramp: number;
  offset: number;
  scale: number;
  /** Peak blur radius as a fraction of THIS display's width, and peak dimming 0 to 1. */
  blur: number;
  darken: number;
  /** 0 to 1: how far the content is drawn flat from the front eye rather than laid on the panel. All three at 0 means sample the media untouched. */
  flat: number;
}

export interface FoldScreensState {
  main: FoldScreenState;
  cover: FoldScreenState;
}

/** The fold animation in progress: the angles at its more closed and more open ends. */
export interface FoldRange {
  closedDeg: number;
  openDeg: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const settled = (level: number): FoldScreenState => ({
  level,
  front: 0,
  softFront: 0,
  ramp: 1,
  offset: 0,
  scale: 0,
  blur: 0,
  darken: 0,
  flat: 0,
});

/** Where the ramp starts for a panel turned `turnDeg` from its home pose: past the free edge at home (nothing touched), behind the hinge by the time it is edge-on. */
export function foldRampFront(turnDeg: number): number {
  const turn = Math.max(0, turnDeg) / FOLD_RAMP_KNEE_DEG;
  return FOLD_RAMP_EDGE - FOLD_RAMP_SPAN * turn ** FOLD_RAMP_POWER;
}

/** The scene's transition options with defaults applied and every number clamped. */
export function resolveFoldTransition(
  spec: DeviceFoldTransitionSpec | undefined,
): Required<DeviceFoldTransitionSpec> {
  const unit = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 1;
  return {
    switchDeg: resolveFoldSwitchDeg(spec),
    enabled: spec?.enabled !== false,
    intensity: unit(spec?.intensity),
    blur: unit(spec?.blur),
    darken: unit(spec?.darken),
  };
}

/** Both displays at a hinge angle. `range` is the fold animation in progress, or null at rest. The handover only plays while a fold carries the device across the switch angle, measured as its progress through THAT fold, so it reverses on closing and always finishes clean wherever the fold stops. Otherwise (at rest, switched off, zero intensity, both screens held on, or a fold that never changes which display is lit) this is exactly `foldScreenLevels`. `anchorSide` is the static half's x sign and `coverHingeLeft` whether the outside display's hinge is on its media's left, both from the catalogue. */
export function foldScreensAt(
  foldDeg: number,
  range: FoldRange | null,
  spec: DeviceFoldTransitionSpec | undefined,
  bothOn: boolean,
  anchorSide: -1 | 1,
  coverHingeLeft: boolean,
): FoldScreensState {
  const o = resolveFoldTransition(spec);
  const plain = foldScreenLevels(foldDeg, spec, bothOn);
  const crosses = range !== null && range.closedDeg < o.switchDeg && range.openDeg > o.switchDeg;
  if (!range || !crosses || bothOn || !o.enabled || o.intensity === 0) {
    return { main: settled(plain.main), cover: settled(plain.cover) };
  }
  const progress = clamp01((foldDeg - range.closedDeg) / (range.openDeg - range.closedDeg));
  // Each display's turn from its own home, as if this fold ran the hinge's whole travel: the outside one from closed, the swinging half from flat.
  const coverTurn = progress * FOLD_OPEN_DEG;
  const swingTurn = (1 - progress) * FOLD_OPEN_DEG;
  const flat =
    o.intensity *
    smoothstep(0, FOLD_FLAT_EASE, progress) *
    (1 - smoothstep(1 - FOLD_FLAT_EASE, 1, progress));
  const moving = (turnDeg: number) => {
    const front = foldRampFront(turnDeg);
    const softFront = front - FOLD_BLUR_AHEAD * smoothstep(0, FOLD_BLUR_AHEAD_BY_DEG, turnDeg);
    return { front, softFront, ramp: Math.max(1e-4, FOLD_RAMP_EDGE - front), flat };
  };

  const cover: FoldScreenState = {
    ...moving(coverTurn),
    level: 1 - smoothstep(FOLD_COVER_OFF_FROM_DEG, FOLD_EDGE_ON_DEG, coverTurn),
    offset: coverHingeLeft ? 0 : 1,
    scale: coverHingeLeft ? 1 : -1,
    blur: FOLD_BLUR_MAX_RADIUS * o.intensity * o.blur,
    darken: FOLD_DARKEN_MAX * o.intensity * o.darken,
  };
  const main: FoldScreenState = {
    ...moving(swingTurn),
    level: smoothstep(0, FOLD_FLAT_EASE, progress),
    // The hinge is mid display: the swinging half runs 0 to 1, the static half 0 to -1.
    offset: anchorSide > 0 ? 1 : -1,
    scale: anchorSide > 0 ? -2 : 2,
    // Two panels wide, so half the fraction is the same physical softness as the outside display.
    blur: (FOLD_BLUR_MAX_RADIUS * o.intensity * o.blur) / 2,
    darken: FOLD_DARKEN_MAX * o.intensity * o.darken,
  };
  return { main, cover };
}

/** What one panel position shows, mirroring the shader so tests can pin the look: the blur radius (as a fraction of the display's width) and the brightness multiplier at horizontal UV `u`. */
export function foldSampleAt(state: FoldScreenState, u: number): { radius: number; gain: number } {
  if (state.blur === 0 && state.darken === 0) return { radius: 0, gain: state.level };
  const coord = state.offset + state.scale * u;
  const guard = 1 - smoothstep(0, FOLD_STATIC_GUARD, -coord);
  const dim = smoothstep(0, state.ramp, coord - state.front) * guard;
  const soft = smoothstep(0, state.ramp, coord - state.softFront) * guard;
  return {
    radius: state.blur * Math.min(1, soft * FOLD_BLUR_LEAD),
    gain: state.level * (1 - dim * state.darken),
  };
}
