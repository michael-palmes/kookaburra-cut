/** Depth of field: the pure maths and types shared by both camera samplers. A `dof` block rides a camera key's pose (rig and orbit alike); fields carry FORWARD along the track from the last key that authored them, so a rack focus restates only `focus`. Normalise time produces per-key EFFECTIVE values (clamped, carried); sample time mixes the segment's two effective ends and resolves autofocus against the frame's live aim distance. Pure (no three.js, no clock reads) like every sampler here. See docs/determinism.md. */
import { lerp } from "./keyframes";

/** The blur families a scene can pick (track-level, first authored key wins). Depth and split read scene depth through the CoC; the rest are screen-space. */
export type DofMode = "depth" | "tilt" | "soft" | "radial" | "directional" | "split";

/** Sidecar `dof` value on a camera key's pose. Every field optional: an absent field inherits the last authored value along the track; a key with no `dof` at all changes nothing. */
export interface SceneDocDof {
  /** Which blur family the scene uses; track-level, first authored key wins. */
  mode?: DofMode;
  /** Blur strength 0..1; 0 contributes nothing (and a track that never exceeds 0 stays off the composer). */
  blur?: number;
  /** Depth/split modes: full-sharp band around the focus plane, world units. */
  range?: number;
  /** Depth/split modes: manual focus distance in world units; "auto" (or never authored) follows the pose's aim distance. */
  focus?: number | "auto";
  /** Tilt mode: screen-fraction height of the sharp band, 0..1. */
  band?: number;
  /** Tilt and split modes: band/divider offset from screen centre, -1..1. */
  offset?: number;
  /** Tilt, directional and split modes: band/smear/divider rotation in degrees. */
  angleDeg?: number;
  /** Soft mode: highlight halation lift, 0..1. */
  glow?: number;
  /** Radial mode: streak centre offset from screen centre, -1..1 each axis. */
  centerX?: number;
  centerY?: number;
  /** Depth/split modes: anamorphic oval squeeze of the bokeh discs, 1 (round) to 2. */
  squeeze?: number;
  /** Split mode: the second focus distance in world units (always manual). */
  focusB?: number;
}

/** A key's effective dof after clamping and carry-forward (a normalise-time product, stored on the normalized pose). */
export interface EffectiveDof {
  blur: number;
  range: number;
  /** Manual focus distance, or null for autofocus. */
  focus: number | null;
  band: number;
  offset: number;
  angleDeg: number;
  glow: number;
  centerX: number;
  centerY: number;
  squeeze: number;
  focusB: number;
}

/** Track-level summary decided once at normalise time. */
export interface TrackDof {
  mode: DofMode;
  /** True when any key's effective blur exceeds 0: what routes the scene through the composer. */
  active: boolean;
}

/** The fully-resolved dof a frame sample carries (autofocus already applied). */
export interface ResolvedDof {
  mode: DofMode;
  blur: number;
  focus: number;
  range: number;
  band: number;
  offset: number;
  angleDeg: number;
  glow: number;
  centerX: number;
  centerY: number;
  squeeze: number;
  focusB: number;
}

/** Which blur families a set of camera tracks activates; the composer's chain-shape key, so it must stay project-stable (docs/determinism.md). */
export interface DofUnion {
  depth: boolean;
  tilt: boolean;
  soft: boolean;
  radial: boolean;
  directional: boolean;
  split: boolean;
}

/** Authoring clamps, applied at normalise time only so the sampler stays a pure mix (fov's rule). EXPORT CONTRACT. */
export const DOF_BLUR_MAX = 1;
export const DOF_RANGE_MAX = 10;
export const DOF_FOCUS_MIN = 0.05;
export const DOF_FOCUS_MAX = 50;
export const DOF_ANGLE_MAX = 90;
export const DOF_SQUEEZE_MAX = 2;

/** Defaults a field holds until some key authors it. `range` 1 keeps roughly a device's depth sharp; `band` 0.35 is the classic tilt strip; `focusB` 2 is a plausible second plane until the key sets one. */
export const DOF_DEFAULTS: EffectiveDof = {
  blur: 0,
  range: 1,
  focus: null,
  band: 0.35,
  offset: 0,
  angleDeg: 0,
  glow: 0.6,
  centerX: 0,
  centerY: 0,
  squeeze: 1,
  focusB: 2,
};

const DOF_MODES: readonly DofMode[] = ["depth", "tilt", "soft", "radial", "directional", "split"];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Validate + clamp one authored `dof` value (degrade-don't-crash: a non-finite field drops, the rest survive). Returns undefined when nothing usable remains. */
export function normalizeDocDof(
  raw: unknown,
  warn: (message: string) => void,
): SceneDocDof | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") {
    warn("dof is not an object — dropped");
    return undefined;
  }
  const dof = raw as SceneDocDof;
  const out: SceneDocDof = {};
  if (dof.mode !== undefined) {
    if (DOF_MODES.includes(dof.mode)) out.mode = dof.mode;
    else warn(`dof mode "${String(dof.mode)}" is unknown — dropped`);
  }
  const num = (
    value: number | undefined,
    label: string,
    lo: number,
    hi: number,
  ): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value)) {
      warn(`dof ${label} is not a number — dropped`);
      return undefined;
    }
    const clamped = clamp(value, lo, hi);
    if (clamped !== value) warn(`dof ${label} ${value} clamped to ${clamped}`);
    return clamped;
  };
  const blur = num(dof.blur, "blur", 0, DOF_BLUR_MAX);
  if (blur !== undefined) out.blur = blur;
  const range = num(dof.range, "range", 0, DOF_RANGE_MAX);
  if (range !== undefined) out.range = range;
  if (dof.focus === "auto") {
    out.focus = "auto";
  } else {
    const focus = num(dof.focus, "focus", DOF_FOCUS_MIN, DOF_FOCUS_MAX);
    if (focus !== undefined) out.focus = focus;
  }
  const band = num(dof.band, "band", 0, 1);
  if (band !== undefined) out.band = band;
  const offset = num(dof.offset, "offset", -1, 1);
  if (offset !== undefined) out.offset = offset;
  const angleDeg = num(dof.angleDeg, "angleDeg", -DOF_ANGLE_MAX, DOF_ANGLE_MAX);
  if (angleDeg !== undefined) out.angleDeg = angleDeg;
  const glow = num(dof.glow, "glow", 0, 1);
  if (glow !== undefined) out.glow = glow;
  const centerX = num(dof.centerX, "centerX", -1, 1);
  if (centerX !== undefined) out.centerX = centerX;
  const centerY = num(dof.centerY, "centerY", -1, 1);
  if (centerY !== undefined) out.centerY = centerY;
  const squeeze = num(dof.squeeze, "squeeze", 1, DOF_SQUEEZE_MAX);
  if (squeeze !== undefined) out.squeeze = squeeze;
  const focusB = num(dof.focusB, "focusB", DOF_FOCUS_MIN, DOF_FOCUS_MAX);
  if (focusB !== undefined) out.focusB = focusB;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One carry-forward step: the effective dof at a key given the previous key's and what this key authored. No authored block returns `previous` unchanged (reference equality is the "nothing keyed yet" signal). */
export function carryDof(
  previous: EffectiveDof | null,
  authored: SceneDocDof | undefined,
): EffectiveDof | null {
  if (!authored) return previous;
  const base = previous ?? DOF_DEFAULTS;
  return {
    blur: authored.blur ?? base.blur,
    range: authored.range ?? base.range,
    focus: authored.focus === "auto" ? null : (authored.focus ?? base.focus),
    band: authored.band ?? base.band,
    offset: authored.offset ?? base.offset,
    angleDeg: authored.angleDeg ?? base.angleDeg,
    glow: authored.glow ?? base.glow,
    centerX: authored.centerX ?? base.centerX,
    centerY: authored.centerY ?? base.centerY,
    squeeze: authored.squeeze ?? base.squeeze,
    focusB: authored.focusB ?? base.focusB,
  };
}

/** Focus interpolates LOGARITHMICALLY, in lockstep with `mixAimDistance` (sceneRig.ts) so a manual rack and an autofocus flight cover ground the same way; a non-positive end degrades to linear. EXPORT CONTRACT. */
export function mixFocusDistance(a: number, b: number, t: number): number {
  if (a <= 0 || b <= 0) return lerp(a, b, t);
  return a * (b / a) ** t;
}

/** Resolve one effective end for mixing: autofocus becomes the frame's live aim distance. */
function resolveEnd(e: EffectiveDof | null, autoDistance: number): ResolvedEnd {
  const eff = e ?? DOF_DEFAULTS;
  return { ...eff, focus: eff.focus ?? autoDistance };
}

type ResolvedEnd = Omit<ResolvedDof, "mode">;

/** Mix a segment's two effective ends at eased progress `t`. `autoDistance` is the frame's aim distance (rig: the mixed canonical's; orbit: the mixed pose's distance), so an auto end tracks the flight while a manual end holds its number. */
export function mixDof(
  a: EffectiveDof | null,
  b: EffectiveDof | null,
  t: number,
  autoDistance: number,
): ResolvedEnd | null {
  if (!a && !b) return null;
  const ra = resolveEnd(a, autoDistance);
  const rb = resolveEnd(b, autoDistance);
  return {
    blur: lerp(ra.blur, rb.blur, t),
    focus: mixFocusDistance(ra.focus, rb.focus, t),
    range: lerp(ra.range, rb.range, t),
    band: lerp(ra.band, rb.band, t),
    offset: lerp(ra.offset, rb.offset, t),
    angleDeg: lerp(ra.angleDeg, rb.angleDeg, t),
    glow: lerp(ra.glow, rb.glow, t),
    centerX: lerp(ra.centerX, rb.centerX, t),
    centerY: lerp(ra.centerY, rb.centerY, t),
    squeeze: lerp(ra.squeeze, rb.squeeze, t),
    // The second focus plane racks the same way the first does (log-space, the mixAimDistance rule).
    focusB: mixFocusDistance(ra.focusB, rb.focusB, t),
  };
}

/** The held (outside-any-segment) resolution of one effective dof. */
export function holdDof(e: EffectiveDof | null, autoDistance: number): ResolvedEnd | null {
  return e ? resolveEnd(e, autoDistance) : null;
}
