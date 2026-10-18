/** Camera kicks: attack, hold, release pushes added at render on whichever pose drives a scene (rig, orbit, the project track or the base pose). Pure functions of scene-local time, never expanded into keys. Null-for-legacy is structural: outside every window, or with a channel absent, `applyCameraKicks` hands back the base pose object itself, because the tan/atan round trip is not bit-exact. See docs/camera.md ("Composition order"). */

import { viewBasis } from "./cameraProject";
import type { CameraPose } from "./cameraTrack";
import { DEFAULT_ENVELOPE_EASE, envelopeAt, envelopeLengthMs } from "./envelope";
import { type ProjectMusic, resolveSceneLocalMs } from "./musicTime";
import type { SceneDocCameraKick, SceneDocTimePosition } from "./sceneDocSchema";

/** A kick with its `at` resolved to scene-local ms and its envelope defaults filled in. */
export interface CameraKick {
  /** Scene-local ms the kick starts: a numeric `at` as authored, a position resolved and rounded. */
  atMs: number;
  /** The authored `at`, kept for display (a position stays `"bar:13"`). */
  at: SceneDocTimePosition;
  /** Its position in the sidecar's `cameraKicks` (the tie-break after `atMs`). */
  index: number;
  id?: string;
  zoom?: number;
  offset?: readonly [number, number, number];
  rollDeg?: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  ease: string;
}

/** What a scene's musical kick positions resolve against: the project's music and the scene's slot start (project ms). */
export interface CameraKickScope {
  music?: ProjectMusic;
  sceneStartMs: number;
}

/** The fov range a kick can push the lens to (the rig's authored range). */
export const KICK_FOV_MIN = 15;
export const KICK_FOV_MAX = 90;

const NO_MUSIC: ProjectMusic = { startOffsetMs: 0, cues: {}, sections: {} };
const DEG2RAD = Math.PI / 180;

const nonNegative = (v: number | undefined) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** Resolves a sidecar's `cameraKicks` for one scene, ordered by start then authored index; null when none survive. An `at` that can't resolve (no grid, an unknown cue) drops its kick with one warning through `warn`. The resolved times live only here: the doc keeps its authored `at`. */
export function resolveCameraKicks(
  raw: readonly SceneDocCameraKick[] | undefined,
  scope: CameraKickScope | undefined,
  warn?: (message: string) => void,
): CameraKick[] | null {
  if (!raw || raw.length === 0) return null;
  const resolved: CameraKick[] = [];
  raw.forEach((entry, index) => {
    if (!entry || !Number.isFinite(entry.releaseMs)) return;
    let atMs: number;
    if (typeof entry.at === "number") {
      if (!Number.isFinite(entry.at)) return;
      atMs = entry.at;
    } else {
      const r = resolveSceneLocalMs(
        String(entry.at),
        scope?.music ?? NO_MUSIC,
        scope?.sceneStartMs ?? 0,
      );
      if (!r.ok) {
        warn?.(`camera kick ${entry.id ?? index + 1} at "${entry.at}": ${r.message}, dropped`);
        return;
      }
      atMs = r.projectMs;
    }
    const kick: CameraKick = {
      atMs,
      at: entry.at,
      index,
      attackMs: nonNegative(entry.attackMs),
      holdMs: nonNegative(entry.holdMs),
      releaseMs: nonNegative(entry.releaseMs),
      ease: entry.ease ?? DEFAULT_ENVELOPE_EASE,
    };
    if (entry.id !== undefined) kick.id = entry.id;
    if (entry.zoom !== undefined) kick.zoom = entry.zoom;
    if (entry.offset !== undefined) kick.offset = entry.offset;
    if (entry.rollDeg !== undefined) kick.rollDeg = entry.rollDeg;
    if (kick.zoom === undefined && kick.offset === undefined && kick.rollDeg === undefined) return;
    resolved.push(kick);
  });
  if (resolved.length === 0) return null;
  return resolved.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
}

/** Where a kick's envelope returns to zero, scene-local ms. */
export function cameraKickEndMs(kick: CameraKick): number {
  return kick.atMs + envelopeLengthMs(kick);
}

/** The latest kick end (0 with none). */
export function cameraKicksEndMs(kicks: readonly CameraKick[] | null | undefined): number {
  let end = 0;
  for (const kick of kicks ?? []) end = Math.max(end, cameraKickEndMs(kick));
  return end;
}

/** Instants a kick's envelope jumps rather than moves: a zero attack snaps on at `at`, a zero release snaps off at the end, and the `jump` ease does both at the attack and release ends. Motion blur never samples across one. */
export function cameraKickBreaks(kicks: readonly CameraKick[] | null | undefined): number[] {
  const breaks: number[] = [];
  for (const kick of kicks ?? []) {
    if (envelopeLengthMs(kick) <= 0) continue;
    const jump = kick.ease === "jump";
    if (kick.attackMs === 0 || jump) breaks.push(kick.atMs + kick.attackMs);
    if (kick.releaseMs === 0 || jump) breaks.push(cameraKickEndMs(kick));
  }
  return breaks;
}

/** The instants each kick sits at full strength: the start of its hold, and its end when it holds. Overscan sizing samples these. */
export function cameraKickPeaks(kicks: readonly CameraKick[] | null | undefined): number[] {
  const peaks: number[] = [];
  for (const kick of kicks ?? []) {
    if (envelopeLengthMs(kick) <= 0) continue;
    peaks.push(kick.atMs + kick.attackMs);
    if (kick.holdMs > 0) peaks.push(kick.atMs + kick.attackMs + kick.holdMs);
  }
  return peaks;
}

/** Adds the kicks live at `localMs` to `pose`. With B the pose's view basis and eᵢ each envelope: position and look point shift together by B·Σ eᵢ·offsetᵢ; fov becomes `2·atan(tan(fov/2) / Π(1 + (zoomᵢ − 1)·eᵢ))` clamped 15..90; roll adds Σ eᵢ·rollDegᵢ. Kicks apply in their resolved order. A channel no live kick moves is left as it was, and when none moves the SAME pose object comes back. */
export function applyCameraKicks(
  pose: CameraPose,
  kicks: readonly CameraKick[] | null | undefined,
  localMs: number,
): CameraPose {
  if (!kicks || kicks.length === 0) return pose;
  let shift: [number, number, number] | null = null;
  let magnify = 1;
  let roll = 0;
  for (const kick of kicks) {
    const e = envelopeAt(localMs - kick.atMs, kick);
    if (e === 0) continue;
    if (kick.offset) {
      shift ??= [0, 0, 0];
      shift[0] += e * kick.offset[0];
      shift[1] += e * kick.offset[1];
      shift[2] += e * kick.offset[2];
    }
    if (kick.zoom !== undefined) magnify *= 1 + (kick.zoom - 1) * e;
    if (kick.rollDeg !== undefined) roll += e * kick.rollDeg;
  }
  const moves = shift !== null && (shift[0] !== 0 || shift[1] !== 0 || shift[2] !== 0);
  if (!moves && magnify === 1 && roll === 0) return pose;
  const next: CameraPose = { ...pose };
  if (moves && shift) {
    const b = viewBasis(pose);
    const d = [0, 1, 2].map((i) => b.x[i] * shift[0] + b.y[i] * shift[1] + b.z[i] * shift[2]);
    next.position = [pose.position[0] + d[0], pose.position[1] + d[1], pose.position[2] + d[2]];
    next.lookAt = [pose.lookAt[0] + d[0], pose.lookAt[1] + d[1], pose.lookAt[2] + d[2]];
  }
  if (magnify !== 1) {
    const fov = (2 * Math.atan(Math.tan((pose.fov * DEG2RAD) / 2) / magnify)) / DEG2RAD;
    next.fov = Math.min(KICK_FOV_MAX, Math.max(KICK_FOV_MIN, fov));
  }
  if (roll !== 0) next.rollDeg = (pose.rollDeg ?? 0) + roll;
  return next;
}
