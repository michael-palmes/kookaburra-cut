/** Per-SCENE camera track: orbit-pose keyframes stored in a scene's sidecar document, sampled in SCENE-LOCAL time. Pure (no three.js, no clock reads), mirroring sceneTimeline.ts, so preview and export agree by construction. A pose orbits a target (`fov` is deliberately not part of it, the project-level track owns fov); segments join keys by id with an ease, and outside a segment the camera holds the latest key at/before `t`. Byte-identity invariant: `resolveFrameCameras` returns null when no scene declares a track, so projects without scene tracks render byte-identically. See docs/determinism.md. */
import {
  baseCameraPose,
  type CameraKeyframe,
  type CameraPose,
  sampleCameraTrack,
} from "./cameraTrack";
import { ease, isEaseName } from "./ease";
import { lerp, lerp3 } from "./keyframes";
import type { SceneDoc, SceneDocCameraKey, SceneDocCameraPose } from "./sceneDocSchema";
import type { ActiveScene, Resolved } from "./sceneTimeline";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** A normalized segment: key ids resolved to the SHARED key objects, times validated. */
export interface SceneCameraSegment {
  from: SceneDocCameraKey;
  to: SceneDocCameraKey;
  /** An engine/ease.ts name (`ease()` degrades unknown names to the default at sample time). */
  ease: string;
}

/** A validated, sorted scene camera track (keys ascending; segments ordered, non-overlapping). */
export interface SceneCameraTrack {
  keys: SceneDocCameraKey[];
  segments: SceneCameraSegment[];
}

/** Orbit → view: position on the sphere around `target`, looking at `target`; azimuth 0 / elevation 0 puts the camera on the target's +Z axis (the base pose). */
export function orbitToView(pose: SceneDocCameraPose): {
  position: [number, number, number];
  lookAt: [number, number, number];
} {
  const az = pose.azimuthDeg * DEG2RAD;
  const el = pose.elevationDeg * DEG2RAD;
  const cosEl = Math.cos(el);
  return {
    position: [
      pose.target[0] + pose.distance * cosEl * Math.sin(az),
      pose.target[1] + pose.distance * Math.sin(el),
      pose.target[2] + pose.distance * cosEl * Math.cos(az),
    ],
    lookAt: [pose.target[0], pose.target[1], pose.target[2]],
  };
}

/** View → orbit (the move tools' inverse). Degenerate zero-distance → angles 0. */
export function orbitFromView(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): SceneDocCameraPose {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    target: [target[0], target[1], target[2]],
    azimuthDeg: distance === 0 ? 0 : Math.atan2(dx, dz) * RAD2DEG,
    elevationDeg: distance === 0 ? 0 : Math.asin(dy / distance) * RAD2DEG,
    distance,
  };
}

/** The scene-default pose (Reset target; Add-animation's seed when a scene has no track): the shared base camera expressed as an orbit, i.e. `{ target: [0,0,0], azimuthDeg: 0, elevationDeg: 0, distance: 5 }` with today's CAMERA config. */
export function defaultOrbitPose(): SceneDocCameraPose {
  const base = baseCameraPose();
  return orbitFromView(base.position, base.lookAt);
}

const finite3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

function validPose(pose: unknown): pose is SceneDocCameraPose {
  const p = pose as SceneDocCameraPose | undefined;
  return (
    !!p &&
    typeof p === "object" &&
    finite3(p.target) &&
    Number.isFinite(p.azimuthDeg) &&
    Number.isFinite(p.elevationDeg) &&
    Number.isFinite(p.distance)
  );
}

/** Validate + normalize a sidecar `camera` value (degrade-don't-crash, like parseSceneDoc): bad keys/segments drop with a console note, never throw. Returns null when nothing keyed survives, so the scene has NO track and falls back like any other scene. */
export function normalizeSceneCamera(
  raw: SceneDoc["camera"],
  source: string,
): SceneCameraTrack | null {
  if (!raw) return null;
  const keys: SceneDocCameraKey[] = [];
  const seen = new Set<string>();
  for (const key of raw.keys ?? []) {
    if (!key || typeof key.id !== "string" || !Number.isFinite(key.tMs) || !validPose(key.pose)) {
      console.warn(`[sceneCamera] ${source}: invalid camera key — dropped`);
      continue;
    }
    if (seen.has(key.id)) {
      console.warn(`[sceneCamera] ${source}: duplicate camera key id "${key.id}" — dropped`);
      continue;
    }
    seen.add(key.id);
    // Negative times can't be authored in the UI; clamp hand-edited ones rather than drop.
    keys.push(key.tMs < 0 ? { ...key, tMs: 0 } : key);
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.tMs - b.tMs);

  const byId = new Map(keys.map((k) => [k.id, k]));
  const segments: SceneCameraSegment[] = [];
  for (const seg of raw.segments ?? []) {
    const from = seg ? byId.get(seg.from) : undefined;
    const to = seg ? byId.get(seg.to) : undefined;
    if (!from || !to || from.tMs >= to.tMs) {
      console.warn(`[sceneCamera] ${source}: invalid camera segment — dropped`);
      continue;
    }
    if (typeof seg.ease === "string" && !isEaseName(seg.ease)) {
      console.warn(`[sceneCamera] ${source}: unknown ease "${seg.ease}" — will render as default`);
    }
    segments.push({ from, to, ease: seg.ease });
  }
  segments.sort((a, b) => a.from.tMs - b.from.tMs);
  const ordered: SceneCameraSegment[] = [];
  for (const seg of segments) {
    const prev = ordered[ordered.length - 1];
    if (prev && seg.from.tMs < prev.to.tMs) {
      console.warn(`[sceneCamera] ${source}: overlapping camera segment — dropped`);
      continue;
    }
    ordered.push(seg);
  }
  return { keys, segments: ordered };
}

function mixPose(a: SceneDocCameraPose, b: SceneDocCameraPose, t: number): SceneDocCameraPose {
  return {
    target: lerp3(a.target, b.target, t),
    azimuthDeg: lerp(a.azimuthDeg, b.azimuthDeg, t),
    elevationDeg: lerp(a.elevationDeg, b.elevationDeg, t),
    distance: lerp(a.distance, b.distance, t),
  };
}

/** Sample a normalized track at scene-local time. Inside a segment ([from, to), the end instant belongs to the hold rule, which is what makes `jump` land its target exactly at the segment end): eased interpolation of the orbit parameters (angles interpolate as plain numbers, no shortest-arc wrapping, so authored values are honoured verbatim). Outside a segment: hold the latest key at/before `t`, clamping to the first key before it. */
export function sampleSceneCamera(track: SceneCameraTrack, localMs: number): SceneDocCameraPose {
  for (const seg of track.segments) {
    if (localMs >= seg.from.tMs && localMs < seg.to.tMs) {
      const p = (localMs - seg.from.tMs) / (seg.to.tMs - seg.from.tMs);
      return mixPose(seg.from.pose, seg.to.pose, ease(seg.ease, p));
    }
  }
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return { ...held.pose, target: [...held.pose.target] };
}

/** Normalize every scene doc's camera once per project load (index-aligned with the slots). A scene whose animated track is the layered screenshot contributes no camera track (its keys stay on disk untouched; the toggle just stands the camera down). */
export function buildSceneCameraTracks(
  sceneDocs: readonly (SceneDoc | undefined)[],
): (SceneCameraTrack | null)[] {
  return sceneDocs.map((doc, i) =>
    doc?.animatedTrack === "layeredScreenshot"
      ? null
      : normalizeSceneCamera(doc?.camera, `scene ${i}`),
  );
}

export function hasSceneCameraTracks(
  tracks: readonly (SceneCameraTrack | null)[] | null | undefined,
): boolean {
  return !!tracks?.some(Boolean);
}

/** The camera plan for one frame when scene tracks are in play (null → legacy path). */
export interface FrameCameraPlan {
  /** Solo frames: the single pose to apply before renderComposited. */
  solo?: CameraPose;
  /** Transition frames: per-target poses + the dominant scene's for the persistent overlay. */
  a?: CameraPose;
  b?: CameraPose;
  overlay?: CameraPose;
}

/** Resolve the frame's camera plan. Null whenever the PROJECT has no scene tracks (the seams then run today's exact path, `applyCameraTrack`, preserving byte-identity for every existing project). When any scene has a track, EVERY frame gets an explicit plan (untracked scenes fall back to the project-level track sample, else the base pose) so the camera never inherits a stale pose from a neighbouring scene; `fov` always comes from the project-level track. */
export function resolveFrameCameras(
  tracks: readonly (SceneCameraTrack | null)[] | null | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  resolved: Resolved,
  globalMs: number,
): FrameCameraPlan | null {
  if (!tracks || !hasSceneCameraTracks(tracks)) return null;
  if (resolved.active.length === 0) return null;

  const fallback = sampleCameraTrack(projectTrack ?? [], globalMs);
  const poseFor = (active: ActiveScene): CameraPose => {
    const track = tracks[active.index];
    if (!track) return fallback;
    const view = orbitToView(sampleSceneCamera(track, active.localMs));
    return { position: view.position, lookAt: view.lookAt, fov: fallback.fov };
  };

  const tr = resolved.transition;
  if (resolved.active.length < 2 || !tr) {
    return { solo: poseFor(resolved.active[resolved.active.length - 1]) };
  }
  const byIndex = new Map(resolved.active.map((s) => [s.index, s]));
  const from = byIndex.get(tr.fromIndex);
  const to = byIndex.get(tr.toIndex);
  if (!from || !to) return { solo: poseFor(resolved.active[resolved.active.length - 1]) };
  const a = poseFor(from);
  const b = poseFor(to);
  return { a, b, overlay: tr.progress < 0.5 ? a : b };
}
