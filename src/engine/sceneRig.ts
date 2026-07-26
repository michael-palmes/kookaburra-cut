/** Per-SCENE camera RIG: free-flight pose keyframes stored in a scene's sidecar `cameraRig` block and sampled in SCENE-LOCAL time. A separate block behind `cameraMode`, so the orbit sampler (sceneCamera.ts) is untouched and projects without a rig render byte-identically. Pure (no three.js, no clock reads) like every sampler here, with hand-rolled directional maths: poses interpolate through a CANONICAL form (position + unit forward + aim distance), which is what lets a 180 degree pan-in-place turn without the look point sweeping through the camera. See docs/determinism.md. */
import { viewBasis } from "./cameraProject";
import { ease, isEaseName } from "./ease";
import { CAMERA } from "./format";
import { catmullRom, catmullRomTangent, lerp, lerp3 } from "./keyframes";
import type {
  SceneDoc,
  SceneDocRigAim,
  SceneDocRigKey,
  SceneDocRigPose,
  SceneDocRigSegment,
} from "./sceneDocSchema";

type V3 = [number, number, number];
type RV3 = readonly [number, number, number];

/** Object-aim ids for the two singleton bindables (devices bind by their own id). */
export const VIDEO_WINDOW_AIM_ID = "videoWindow";
export const LAYERED_SCREENSHOT_AIM_ID = "layeredScreenshot";

/** Authored fov range; clamped at normalise time only, so the sampler stays a pure mix and a clamp can never kink a segment mid-flight. */
export const RIG_FOV_MIN = 15;
export const RIG_FOV_MAX = 90;

/** Below this a vector is treated as having no direction (a look point sitting on the camera, a tangent on a stationary path). */
const DEGENERATE = 1e-9;
/** What a degenerate aim looks down: the scene-space "into the screen" axis. */
const DEGENERATE_FORWARD: V3 = [0, 0, -1];

const sub3 = (a: RV3, b: RV3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: RV3, b: RV3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: RV3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: RV3, b: RV3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: RV3, b: RV3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a: RV3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

/** Unit vector, or null when the input is too short to have a direction. */
function normalize3(v: RV3): V3 | null {
  const l = len3(v);
  return l < DEGENERATE ? null : [v[0] / l, v[1] / l, v[2] / l];
}

/** The basis axis least aligned with `v`, first minimum winning (x, then y, then z), so the antipodal slerp axis is a pure function of its input rather than floating-point luck. */
function leastAlignedAxis(v: RV3): V3 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ax <= ay && ax <= az) return [1, 0, 0];
  return ay <= az ? [0, 1, 0] : [0, 0, 1];
}

/** Spherical interpolation of two UNIT vectors. Near-parallel inputs (dot > 0.9995) take a normalised lerp, which is where the sin(theta) division would blow up; near-antipodal inputs (dot < -0.9999) rotate about a deterministically chosen perpendicular, because the great circle is otherwise ambiguous. EXPORT CONTRACT. */
export function slerpUnit(a: RV3, b: RV3, t: number): V3 {
  const d = Math.min(1, Math.max(-1, dot3(a, b)));
  if (d > 0.9995) return normalize3(lerp3(a, b, t)) ?? [a[0], a[1], a[2]];
  if (d < -0.9999) {
    const axis = normalize3(cross3(a, leastAlignedAxis(a)));
    if (!axis) return [a[0], a[1], a[2]];
    const angle = t * Math.PI;
    // Rodrigues with the axis perpendicular to `a`, so the k·v term vanishes.
    return add3(scale3(a, Math.cos(angle)), scale3(cross3(axis, a), Math.sin(angle)));
  }
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  return add3(scale3(a, Math.sin((1 - t) * theta) / s), scale3(b, Math.sin(t * theta) / s));
}

/** Distance interpolates LOGARITHMICALLY, so a 6 -> 1 push covers even ground per unit of eased progress instead of crawling at the end; a non-positive end has no log and degrades to linear. */
export function mixAimDistance(a: number, b: number, t: number): number {
  if (a <= 0 || b <= 0) return lerp(a, b, t);
  return a * (b / a) ** t;
}

/** Undefined fov means "inherit the project-level track", so two unauthored ends stay undefined; a single authored end mixes against the base fov rather than snapping. */
function mixFov(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return lerp(a ?? CAMERA.fov, b ?? CAMERA.fov, t);
}

/** The interpolation form: a direction plus a distance rather than a look POINT, which is what makes a pan-in-place rotate instead of dragging its aim across the camera. */
export interface CanonicalPose {
  position: V3;
  /** Unit look direction. */
  forward: V3;
  /** How far along `forward` the aim point sits. */
  aimDistance: number;
  rollDeg: number;
  /** Undefined when the key authored no fov. */
  fov: number | undefined;
}

/** The applied pose a rig sample produces. `fov` is absent when neither end of the sample authored one, leaving it to the project-level track. */
export interface RigPose {
  position: V3;
  lookAt: V3;
  fov?: number;
  rollDeg: number;
}

export function toCanonical(pose: SceneDocRigPose): CanonicalPose {
  const delta = sub3(pose.aim.at, pose.position);
  const distance = len3(delta);
  const degenerate = distance < DEGENERATE;
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    forward: degenerate ? [...DEGENERATE_FORWARD] : scale3(delta, 1 / distance),
    aimDistance: degenerate ? 1 : distance,
    rollDeg: pose.rollDeg ?? 0,
    fov: pose.fov,
  };
}

export function fromCanonical(c: CanonicalPose): RigPose {
  return {
    position: [c.position[0], c.position[1], c.position[2]],
    lookAt: add3(c.position, scale3(c.forward, c.aimDistance)),
    fov: c.fov,
    rollDeg: c.rollDeg,
  };
}

/** An applied pose read back into canonical form (the Present blend and cross-scene continuity both hand back poses, not authored keys). */
export function rigPoseToCanonical(pose: RigPose): CanonicalPose {
  const delta = sub3(pose.lookAt, pose.position);
  const distance = len3(delta);
  const degenerate = distance < DEGENERATE;
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    forward: degenerate ? [...DEGENERATE_FORWARD] : scale3(delta, 1 / distance),
    aimDistance: degenerate ? 1 : distance,
    rollDeg: pose.rollDeg,
    fov: pose.fov,
  };
}

/** Eased progress per channel: position covers position, rotation covers the aim direction, aim distance and roll, lens covers fov. All three are the segment's own ease unless a channel override says otherwise. */
export interface ChannelProgress {
  position: number;
  rotation: number;
  lens: number;
}

/** Mix two canonical poses channel by channel. `forwardA`/`forwardB` override the endpoints' look directions, which is how a tangent-aim key substitutes the path tangent for its baked one. EXPORT CONTRACT. */
export function mixCanonical(
  a: CanonicalPose,
  b: CanonicalPose,
  e: ChannelProgress,
  forwardA: RV3 = a.forward,
  forwardB: RV3 = b.forward,
): CanonicalPose {
  return {
    position: lerp3(a.position, b.position, e.position),
    forward: slerpUnit(forwardA, forwardB, e.rotation),
    aimDistance: mixAimDistance(a.aimDistance, b.aimDistance, e.rotation),
    rollDeg: lerp(a.rollDeg, b.rollDeg, e.rotation),
    fov: mixFov(a.fov, b.fov, e.lens),
  };
}

/** Blend two APPLIED poses through the canonical form (the Present return leg). */
export function mixRigPose(a: RigPose, b: RigPose, t: number): RigPose {
  const e: ChannelProgress = { position: t, rotation: t, lens: t };
  return fromCanonical(mixCanonical(rigPoseToCanonical(a), rigPoseToCanonical(b), e));
}

/** A normalized segment: key ids resolved to the SHARED key objects, `smooth` resolved, and the spline's shaping neighbours pinned. */
export interface SceneRigSegment {
  from: SceneDocRigKey;
  to: SceneDocRigKey;
  /** An `engine/ease.ts` name (`ease()` degrades unknown names at sample time). */
  ease: string;
  /** Resolved from the sidecar's optional flag: absent means smooth. */
  smooth: boolean;
  /** Position of the key before `from`, REFLECTED through `from` at the path's start (see `reflect`). */
  before: V3;
  /** Position of the key after `to`, reflected through `to` at the path's end. */
  after: V3;
  easePosition?: string;
  easeRotation?: string;
  easeLens?: string;
}

/** The stand-in for a missing spline neighbour: the far endpoint mirrored through the near one. Duplicating the endpoint instead (the other standard trick) would give a two-key segment a smoothstep speed profile on top of its ease and a ZERO start tangent, which a tangent aim then can't read. Reflection makes a neighbourless smooth segment exactly its straight lerp. EXPORT CONTRACT. */
function reflect(near: RV3, far: RV3): V3 {
  return [2 * near[0] - far[0], 2 * near[1] - far[1], 2 * near[2] - far[2]];
}

/** A validated, sorted rig track (keys ascending; segments ordered, non-overlapping). */
export interface SceneRigTrack {
  keys: SceneDocRigKey[];
  segments: SceneRigSegment[];
}

const finite3 = (v: unknown): v is V3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

function validAim(raw: unknown): raw is SceneDocRigAim {
  const aim = raw as SceneDocRigAim | undefined;
  if (!aim || typeof aim !== "object" || !finite3(aim.at)) return false;
  if (aim.mode === "point" || aim.mode === "tangent") return true;
  return aim.mode === "object" && typeof aim.id === "string" && aim.id.length > 0;
}

function validRigPose(raw: unknown): raw is SceneDocRigPose {
  const pose = raw as SceneDocRigPose | undefined;
  return (
    !!pose &&
    typeof pose === "object" &&
    finite3(pose.position) &&
    validAim(pose.aim) &&
    (pose.fov === undefined || Number.isFinite(pose.fov)) &&
    (pose.rollDeg === undefined || Number.isFinite(pose.rollDeg))
  );
}

/** Where a bound object sits in the scene: a device by its own id, else the two singletons. Placement is read, never written: rebaking `at` when the object moves is the inspector's job (`sceneRigConvert.ts`), so the engine stays pure. */
export function resolveAimTarget(id: string, doc: SceneDoc | undefined): V3 | null {
  if (!doc) return null;
  const device = doc.devices?.find((d) => d.id === id);
  if (device) {
    const at = device.placement?.position;
    return finite3(at) ? [at[0], at[1], at[2]] : [0, 0, 0];
  }
  if (id === VIDEO_WINDOW_AIM_ID && doc.videoWindow) return [0, 0, 0];
  if (id === LAYERED_SCREENSHOT_AIM_ID && doc.layeredScreenshot) {
    const pan = doc.layeredScreenshot.pose.pan;
    return [pan[0], pan[1], 0];
  }
  return null;
}

/** Validate + normalize a sidecar `cameraRig` value (degrade-don't-crash, exactly `normalizeSceneCamera`'s contract): bad keys/segments drop with a console note, never throw. `doc` is the owning scene document, needed to resolve object aims. Returns null when nothing keyed survives, so the scene simply has no rig. */
export function normalizeSceneRig(
  raw: SceneDoc["cameraRig"],
  source: string,
  doc?: SceneDoc,
): SceneRigTrack | null {
  if (!raw) return null;
  const keys: SceneDocRigKey[] = [];
  const seen = new Set<string>();
  const warnedBindings = new Set<string>();
  for (const key of raw.keys ?? []) {
    if (
      !key ||
      typeof key.id !== "string" ||
      !Number.isFinite(key.tMs) ||
      !validRigPose(key.pose)
    ) {
      console.warn(`[sceneRig] ${source}: invalid rig key — dropped`);
      continue;
    }
    if (seen.has(key.id)) {
      console.warn(`[sceneRig] ${source}: duplicate rig key id "${key.id}" — dropped`);
      continue;
    }
    seen.add(key.id);
    const pose = { ...key.pose };
    if (pose.fov !== undefined) {
      const clamped = Math.min(RIG_FOV_MAX, Math.max(RIG_FOV_MIN, pose.fov));
      if (clamped !== pose.fov) {
        console.warn(
          `[sceneRig] ${source}: rig key "${key.id}" fov ${pose.fov} clamped to ${clamped}`,
        );
        pose.fov = clamped;
      }
    }
    if (pose.aim.mode === "object") {
      const at = resolveAimTarget(pose.aim.id, doc);
      if (at) {
        pose.aim = { ...pose.aim, at };
      } else if (!warnedBindings.has(pose.aim.id)) {
        warnedBindings.add(pose.aim.id);
        console.warn(
          `[sceneRig] ${source}: aim binding "${pose.aim.id}" is unresolved — using the baked point`,
        );
      }
    }
    // Negative times can't be authored in the UI; clamp hand-edited ones rather than drop.
    keys.push({ ...key, tMs: key.tMs < 0 ? 0 : key.tMs, pose });
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.tMs - b.tMs);

  const byId = new Map(keys.map((k) => [k.id, k]));
  const indexOf = new Map(keys.map((k, i) => [k.id, i]));
  const channel = (name: string | undefined, label: string): string | undefined => {
    if (name === undefined) return undefined;
    if (isEaseName(name)) return name;
    console.warn(
      `[sceneRig] ${source}: unknown ${label} "${name}" — falling back to the segment's`,
    );
    return undefined;
  };
  const segments: SceneRigSegment[] = [];
  for (const seg of (raw.segments ?? []) as SceneDocRigSegment[]) {
    const from = seg ? byId.get(seg.from) : undefined;
    const to = seg ? byId.get(seg.to) : undefined;
    if (!from || !to || from.tMs >= to.tMs) {
      console.warn(`[sceneRig] ${source}: invalid rig segment — dropped`);
      continue;
    }
    if (typeof seg.ease === "string" && !isEaseName(seg.ease)) {
      console.warn(`[sceneRig] ${source}: unknown ease "${seg.ease}" — will render as default`);
    }
    const i = indexOf.get(from.id) ?? 0;
    const j = indexOf.get(to.id) ?? keys.length - 1;
    segments.push({
      from,
      to,
      ease: seg.ease,
      smooth: seg.smooth !== false,
      before:
        i > 0 ? [...keys[i - 1].pose.position] : reflect(from.pose.position, to.pose.position),
      after:
        j + 1 < keys.length
          ? [...keys[j + 1].pose.position]
          : reflect(to.pose.position, from.pose.position),
      easePosition: channel(seg.easePosition, "easePosition"),
      easeRotation: channel(seg.easeRotation, "easeRotation"),
      easeLens: channel(seg.easeLens, "easeLens"),
    });
  }
  segments.sort((a, b) => a.from.tMs - b.from.tMs);
  const ordered: SceneRigSegment[] = [];
  for (const seg of segments) {
    const prev = ordered[ordered.length - 1];
    if (prev && seg.from.tMs < prev.to.tMs) {
      console.warn(`[sceneRig] ${source}: overlapping rig segment — dropped`);
      continue;
    }
    ordered.push(seg);
  }
  return { keys, segments: ordered };
}

/** The path direction at this instant, or null when there isn't one. Four rules, and they are the corner authors hit: inside a SMOOTHED segment it's the analytic spline derivative; inside a STRAIGHT one it's the segment chord; a held key outside any segment has no path at all; and a near-zero derivative or chord (a stationary key pair) has none either. Every null falls back to the key's baked `at`. */
function pathTangent(seg: SceneRigSegment, ePos: number): V3 | null {
  const from = seg.from.pose.position;
  const to = seg.to.pose.position;
  if (!seg.smooth) return normalize3(sub3(to, from));
  return normalize3(catmullRomTangent(seg.before, from, to, seg.after, ePos));
}

function sampleSegment(seg: SceneRigSegment, p: number): RigPose {
  const a = toCanonical(seg.from.pose);
  const b = toCanonical(seg.to.pose);
  const e: ChannelProgress = {
    position: ease(seg.easePosition ?? seg.ease, p),
    rotation: ease(seg.easeRotation ?? seg.ease, p),
    lens: ease(seg.easeLens ?? seg.ease, p),
  };
  const tangent =
    seg.from.pose.aim.mode === "tangent" || seg.to.pose.aim.mode === "tangent"
      ? pathTangent(seg, e.position)
      : null;
  const mixed = mixCanonical(
    a,
    b,
    e,
    seg.from.pose.aim.mode === "tangent" ? (tangent ?? a.forward) : a.forward,
    seg.to.pose.aim.mode === "tangent" ? (tangent ?? b.forward) : b.forward,
  );
  if (seg.smooth) {
    mixed.position = catmullRom(
      seg.before,
      seg.from.pose.position,
      seg.to.pose.position,
      seg.after,
      e.position,
    );
  }
  return fromCanonical(mixed);
}

/** Sample a normalized rig at scene-local time, returning the APPLIED pose (the authored-key accessor the inspector wants is a separate thing; don't conflate them). Semantics match the orbit sampler exactly: segments are half-open `[from, to)` so `jump` lands its target at the segment end, and outside a segment the camera holds the latest key at/before `t`, clamping to the first key before it. Smoothing shapes POSITION only, because splining the aim as well gives a wandering look direction that is very hard to author against. */
export function sampleSceneRig(track: SceneRigTrack, localMs: number): RigPose {
  for (const seg of track.segments) {
    if (localMs >= seg.from.tMs && localMs < seg.to.tMs) {
      return sampleSegment(seg, (localMs - seg.from.tMs) / (seg.to.tMs - seg.from.tMs));
    }
  }
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return fromCanonical(toCanonical(held.pose));
}

/** How many evenly spaced samples summarise a rig's travel. FIXED and documented: the envelope feeds SIZING maths, which must land on the same numbers in preview and export, so it can never depend on frame rate or scene length. EXPORT CONTRACT. */
export const ENVELOPE_SAMPLES = 64;

/** Cap on the overscan factor: a band the camera crosses goes edge-on and would ask for an infinite rect it can never usefully fill. */
export const OVERSCAN_CAP = 4;

/** How much a full-bleed layer at depth `z` must be oversized to stay full-bleed for this rig's whole travel: at each of the fixed samples the camera's four frustum corner rays (roll and aim direction included, via the same basis the overlay projects through) intersect the layer's plane, and the widest hit sets the rect. `minimum` keeps an existing constant as the floor, so a rig can only ever ask for MORE, never shrink what a rig-less scene renders. Pure sizing maths, evaluated once per scene, never per frame. */
export function rigOverscan(
  track: SceneRigTrack,
  frame: { width: number; height: number },
  z = 0,
  minimum = 1,
  fallbackFov = CAMERA.fov,
): number {
  const first = track.keys[0].tMs;
  const last = track.keys[track.keys.length - 1].tMs;
  const span = last - first;
  const aspect = frame.width / frame.height;
  let halfW = 0;
  let halfH = 0;
  for (let i = 0; i < ENVELOPE_SAMPLES; i++) {
    // A zero-span track (one key, or every key at the same instant) samples that one pose.
    const t = span <= 0 ? first : first + (span * i) / (ENVELOPE_SAMPLES - 1);
    const pose = sampleSceneRig(track, t);
    const fov = pose.fov ?? fallbackFov;
    const basis = viewBasis({ ...pose, fov });
    const tanV = Math.tan((fov * Math.PI) / 360);
    const [px, py, pz] = pose.position;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const d: [number, number, number] = [
          -basis.z[0] + sx * tanV * aspect * basis.x[0] + sy * tanV * basis.y[0],
          -basis.z[1] + sx * tanV * aspect * basis.x[1] + sy * tanV * basis.y[1],
          -basis.z[2] + sx * tanV * aspect * basis.x[2] + sy * tanV * basis.y[2],
        ];
        // A corner that never reaches the plane sees past it; no rect covers that, so it asks nothing.
        if (Math.abs(d[2]) < 1e-6) continue;
        const along = (z - pz) / d[2];
        if (along <= 0) continue;
        halfW = Math.max(halfW, Math.abs(px + d[0] * along));
        halfH = Math.max(halfH, Math.abs(py + d[1] * along));
      }
    }
  }
  return Math.max(
    minimum,
    Math.min(OVERSCAN_CAP, Math.max(halfW / (frame.width / 2), halfH / (frame.height / 2))),
  );
}

/** The rig's default pose: the base camera expressed as a free pose (the Reset target, and the seed when Free mode is switched on with nothing authored). */
export function defaultRigPose(): SceneDocRigPose {
  return {
    position: [...CAMERA.position] as V3,
    aim: { mode: "point", at: [0, 0, CAMERA.contentZ] },
  };
}
