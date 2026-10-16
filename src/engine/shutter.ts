import { ease } from "./ease";
import type { SceneCameraTracks } from "./sceneCamera";

// Pure shutter maths for the motion blur lane; everything here is EXPORT CONTRACT (docs/determinism.md).

/** The sample counts a project may pick (Quick, Standard, Fine). Powers of two by design, though the lane's integer sums stay exact at any count. */
export const SHUTTER_SAMPLE_COUNTS = [4, 8, 16] as const;
export type ShutterSamples = (typeof SHUTTER_SAMPLE_COUNTS)[number];

export const SHUTTER_DEG_MAX = 360;
export const SHUTTER_DEG_DEFAULT = 180;
export const SHUTTER_SAMPLES_DEFAULT: ShutterSamples = 8;

/** Sample times nudged off a break land this far before it, inside the half-open segment that precedes it. */
const BEFORE_BREAK_MS = 1e-6;

/** The open shutter's span for one frame: `deg / 360` of the frame interval. */
export function shutterWindowMs(shutterDeg: number, fps: number): number {
  if (!(fps > 0) || !Number.isFinite(shutterDeg)) return 0;
  const deg = Math.min(SHUTTER_DEG_MAX, Math.max(0, shutterDeg));
  return (deg / 360) * (1000 / fps);
}

/** The stratified, centred sample table in window units: `(k + 0.5) / n - 0.5`, so samples straddle the frame instant symmetrically and never repeat the window edges. */
export function shutterUnitOffsets(samples: number): number[] {
  const n = Math.max(1, Math.floor(samples));
  return Array.from({ length: n }, (_, k) => (k + 0.5) / n - 0.5);
}

/** Times where a camera track snaps rather than moves: the end of any segment with a `jump` channel, and any key not reached by a segment (a held key switching). A shutter window never samples across one. */
export function cameraBreaks(tracks: SceneCameraTracks | null | undefined): number[] {
  if (!tracks) return [];
  const breaks = new Set<number>();
  if (tracks.mode === "rig" && tracks.rig) {
    const reached = new Set<string>();
    for (const seg of tracks.rig.segments) {
      const eases = [seg.easePosition, seg.easeRotation, seg.easeLens].map((e) => e ?? seg.ease);
      if (eases.includes("jump")) breaks.add(seg.to.tMs);
      else reached.add(seg.to.id);
    }
    tracks.rig.keys.forEach((key, i) => {
      if (i > 0 && !reached.has(key.id)) breaks.add(key.tMs);
    });
  } else if (tracks.orbit) {
    const reached = new Set<string>();
    for (const seg of tracks.orbit.segments) {
      if (seg.ease === "jump") breaks.add(seg.to.tMs);
      else reached.add(seg.to.id);
    }
    tracks.orbit.keys.forEach((key, i) => {
      if (i > 0 && !reached.has(key.id)) breaks.add(key.tMs);
    });
  }
  return [...breaks].sort((a, b) => a - b);
}

/** Clamps one sample's scene-local time into the scene (`[0, durationMs]`) and onto the frame's side of any break: a sample past a break that the centre has not reached stops just before it, and a sample before a break the centre has passed stops on it. */
export function clampSampleMs(
  centreMs: number,
  sampleMs: number,
  durationMs: number,
  breaks: readonly number[],
): number {
  let t = Math.min(Math.max(sampleMs, 0), Math.max(0, durationMs));
  for (const b of breaks) {
    if (b > centreMs && t >= b) t = Math.min(t, b - BEFORE_BREAK_MS);
    else if (b <= centreMs && t < b) t = Math.max(t, b);
  }
  return t;
}

function keyShutter(authored: number | undefined, sceneDeg: number): number {
  if (authored === undefined || !Number.isFinite(authored)) return sceneDeg;
  return Math.min(SHUTTER_DEG_MAX, Math.max(0, authored));
}

/** The camera's shutter angle at scene-local time: a key's `shutterDeg` overrides the scene's, mixed under the Lens ease inside a segment (an unauthored end mixes against the scene's angle, the fov rule) and held outside one. */
export function sampleShutterDeg(
  tracks: SceneCameraTracks | null | undefined,
  localMs: number,
  sceneDeg: number,
): number {
  const block = tracks?.mode === "rig" ? tracks.rig : tracks?.orbit;
  if (!block || block.keys.length === 0) return sceneDeg;
  for (const seg of block.segments) {
    if (localMs >= seg.from.tMs && localMs < seg.to.tMs) {
      const p = (localMs - seg.from.tMs) / (seg.to.tMs - seg.from.tMs);
      const lens = "easeLens" in seg ? (seg.easeLens ?? seg.ease) : seg.ease;
      const a = keyShutter(seg.from.pose.shutterDeg, sceneDeg);
      const b = keyShutter(seg.to.pose.shutterDeg, sceneDeg);
      return a + (b - a) * ease(lens, p);
    }
  }
  let held = block.keys[0];
  for (const key of block.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return keyShutter(held.pose.shutterDeg, sceneDeg);
}
