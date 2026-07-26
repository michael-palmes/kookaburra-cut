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
import { normalizeSceneRig, type SceneRigTrack, sampleSceneRig } from "./sceneRig";
import type { ActiveScene, Resolved } from "./sceneTimeline";

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

// The orbit <-> view pair moved to engine/orbit.ts when lights gained orbit placement; re-exported here so camera call sites stay put.
import { orbitFromView, orbitToView } from "./orbit";

export { orbitFromView, orbitToView };

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

/** Mix two orbit poses; the one copy, shared with the Present loop's return leg (two copies is how Present and the editor drift apart). Angles interpolate as plain numbers, no shortest-arc wrapping, so authored values are honoured verbatim. */
export function mixPose(
  a: SceneDocCameraPose,
  b: SceneDocCameraPose,
  t: number,
): SceneDocCameraPose {
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

/** One scene's camera, both blocks resolved. `mode` is "rig" only when the doc SAYS rig and the rig actually has keys, so flipping the switch before authoring anything falls through to orbit and the camera never jumps. */
export interface SceneCameraTracks {
  mode: "orbit" | "rig";
  orbit: SceneCameraTrack | null;
  rig: SceneRigTrack | null;
}

/** Assemble a scene's camera tracks from its two normalized blocks. The ONE place `mode` is decided, so the editor's live draft and the loaded project can't disagree about which block drives. */
export function sceneCameraTracks(
  orbit: SceneCameraTrack | null,
  rig: SceneRigTrack | null,
): SceneCameraTracks | null {
  if (!orbit && !rig) return null;
  return { mode: rig ? "rig" : "orbit", orbit, rig };
}

/** Wrap an orbit track alone (the orbit-only draft shape). */
export function orbitCameraTracks(orbit: SceneCameraTrack | null): SceneCameraTracks | null {
  return sceneCameraTracks(orbit, null);
}

/** Normalize every scene doc's camera once per project load (index-aligned with the slots). A scene whose animated track is the layered screenshot contributes nothing (its keys stay on disk untouched; the toggle just stands the camera down). The rig is only normalized under `cameraMode: "rig"`, so an orbit-mode scene carrying a stale rig block costs nothing and warns about nothing. */
export function buildSceneCameraTracks(
  sceneDocs: readonly (SceneDoc | undefined)[],
): (SceneCameraTracks | null)[] {
  return sceneDocs.map((doc, i) => {
    if (!doc || doc.animatedTrack === "layeredScreenshot") return null;
    const source = `scene ${i}`;
    const orbit = normalizeSceneCamera(doc.camera, source);
    const rig = doc.cameraMode === "rig" ? normalizeSceneRig(doc.cameraRig, source, doc) : null;
    return sceneCameraTracks(orbit, rig);
  });
}

export function hasSceneCameraTracks(
  tracks: readonly (SceneCameraTracks | null)[] | null | undefined,
): boolean {
  return !!tracks?.some(Boolean);
}

/** The last authored key time on whichever block drives this scene (Present anchors its first scene past it). */
export function sceneCameraEndMs(tracks: SceneCameraTracks | null | undefined): number {
  const keys = tracks?.mode === "rig" ? tracks.rig?.keys : tracks?.orbit?.keys;
  return keys?.[keys.length - 1]?.tMs ?? 0;
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

/** Resolve the frame's camera plan. Null whenever the PROJECT has no scene tracks (the seams then run today's exact path, `applyCameraTrack`, preserving byte-identity for every existing project). When any scene has a track, EVERY frame gets an explicit plan (untracked scenes fall back to the project-level track sample, else the base pose) so the camera never inherits a stale pose from a neighbouring scene. Per-scene precedence is rig -> orbit -> project -> base; `fov` comes from the project-level track unless a rig key authored one. */
export function resolveFrameCameras(
  tracks: readonly (SceneCameraTracks | null)[] | null | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  resolved: Resolved,
  globalMs: number,
): FrameCameraPlan | null {
  if (!tracks || !hasSceneCameraTracks(tracks)) return null;
  if (resolved.active.length === 0) return null;

  const fallback = sampleCameraTrack(projectTrack ?? [], globalMs);
  const poseFor = (active: ActiveScene): CameraPose => {
    const scene = tracks[active.index];
    if (!scene) return fallback;
    if (scene.mode === "rig" && scene.rig) {
      const rig = sampleSceneRig(scene.rig, active.localMs);
      return {
        position: rig.position,
        lookAt: rig.lookAt,
        fov: rig.fov ?? fallback.fov,
        rollDeg: rig.rollDeg,
      };
    }
    if (!scene.orbit) return fallback;
    const view = orbitToView(sampleSceneCamera(scene.orbit, active.localMs));
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
