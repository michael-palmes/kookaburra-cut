/** Per-SCENE camera track: orbit-pose keyframes stored in a scene's sidecar document, sampled in SCENE-LOCAL time. Pure (no three.js, no clock reads), mirroring sceneTimeline.ts, so preview and export agree by construction. A pose orbits a target (`fov` is deliberately not part of it, the project-level track owns fov); segments join keys by id with an ease, and outside a segment the camera holds the latest key at/before `t`. Byte-identity invariant: `resolveFrameCameras` returns null when no scene declares a track, so projects without scene tracks render byte-identically. See docs/determinism.md. */
import {
  baseCameraPose,
  type CameraKeyframe,
  type CameraPose,
  sampleCameraTrack,
} from "./cameraTrack";
import {
  carryDof,
  type EffectiveDof,
  holdDof,
  mixDof,
  normalizeDocDof,
  type ResolvedDof,
  type TrackDof,
} from "./dof";
import { ease, isEaseName } from "./ease";
import { lerp, lerp3 } from "./keyframes";
import type {
  SceneDoc,
  SceneDocCameraKey,
  SceneDocCameraPose,
  SceneDocRigPose,
} from "./sceneDocSchema";
import { normalizeSceneRig, type SceneRigTrack, sampleSceneRig } from "./sceneRig";
import type { ActiveScene, Resolved } from "./sceneTimeline";

/** A normalized segment: key ids resolved to the SHARED key objects, times validated. */
export interface SceneCameraSegment {
  from: SceneDocCameraKey;
  to: SceneDocCameraKey;
  /** An engine/ease.ts name (`ease()` degrades unknown names to the default at sample time). */
  ease: string;
  /** Focus-channel ease override; absent means the segment's own `ease`. */
  easeDof?: string;
}

/** A validated, sorted scene camera track (keys ascending; segments ordered, non-overlapping). */
export interface SceneCameraTrack {
  keys: SceneDocCameraKey[];
  segments: SceneCameraSegment[];
  /** Track-level dof summary; null/absent when no key authors a dof block. */
  dof?: TrackDof | null;
  /** Per-key EFFECTIVE dof after carry-forward, keyed by key id (normalise-time product). */
  dofByKey?: Map<string, EffectiveDof | null>;
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
    const pose = { ...key.pose };
    const dofAuthored = normalizeDocDof(key.pose.dof, (message) =>
      console.warn(`[sceneCamera] ${source}: camera key "${key.id}" ${message}`),
    );
    if (dofAuthored) pose.dof = dofAuthored;
    else delete pose.dof;
    // Negative times can't be authored in the UI; clamp hand-edited ones rather than drop.
    keys.push({ ...key, tMs: key.tMs < 0 ? 0 : key.tMs, pose });
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.tMs - b.tMs);

  // Effective dof per key, carry-forward semantics identical to the rig's (sceneRig.ts).
  let dofMode: TrackDof["mode"] | null = null;
  let dofCarried: EffectiveDof | null = null;
  let dofActive = false;
  const dofByKey = new Map<string, EffectiveDof | null>();
  for (const key of keys) {
    const authored = key.pose.dof;
    if (authored?.mode && dofMode && authored.mode !== dofMode) {
      console.warn(
        `[sceneCamera] ${source}: dof mode is per scene; key "${key.id}" "${authored.mode}" ignored`,
      );
    }
    if (authored && dofMode === null) dofMode = authored.mode ?? "depth";
    dofCarried = carryDof(dofCarried, authored);
    if (dofCarried && dofCarried.blur > 0) dofActive = true;
    dofByKey.set(key.id, dofCarried);
  }
  const dof: TrackDof | null = dofMode ? { mode: dofMode, active: dofActive } : null;

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
    let easeDof: string | undefined;
    if (seg.easeDof !== undefined) {
      if (isEaseName(seg.easeDof)) easeDof = seg.easeDof;
      else {
        console.warn(
          `[sceneCamera] ${source}: unknown easeDof "${seg.easeDof}" — falling back to the segment's`,
        );
      }
    }
    segments.push({ from, to, ease: seg.ease, easeDof });
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
  return { keys, segments: ordered, dof, dofByKey };
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

/** An orbit sample with its resolved dof (autofocus = the pose's distance to target). */
export interface SceneCameraSample {
  pose: SceneDocCameraPose;
  dof: ResolvedDof | null;
}

/** Sample a normalized track at scene-local time, dof included. Inside a segment ([from, to), the end instant belongs to the hold rule, which is what makes `jump` land its target exactly at the segment end): eased interpolation of the orbit parameters (angles interpolate as plain numbers, no shortest-arc wrapping, so authored values are honoured verbatim). Outside a segment: hold the latest key at/before `t`, clamping to the first key before it. */
export function sampleSceneCameraWithDof(
  track: SceneCameraTrack,
  localMs: number,
): SceneCameraSample {
  for (const seg of track.segments) {
    if (localMs >= seg.from.tMs && localMs < seg.to.tMs) {
      const p = (localMs - seg.from.tMs) / (seg.to.tMs - seg.from.tMs);
      const pose = mixPose(seg.from.pose, seg.to.pose, ease(seg.ease, p));
      let dof: ResolvedDof | null = null;
      if (track.dof) {
        const mixedDof = mixDof(
          track.dofByKey?.get(seg.from.id) ?? null,
          track.dofByKey?.get(seg.to.id) ?? null,
          ease(seg.easeDof ?? seg.ease, p),
          pose.distance,
        );
        if (mixedDof) dof = { mode: track.dof.mode, ...mixedDof };
      }
      return { pose, dof };
    }
  }
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  const pose = { ...held.pose, target: [...held.pose.target] as [number, number, number] };
  let dof: ResolvedDof | null = null;
  if (track.dof) {
    const heldDof = holdDof(track.dofByKey?.get(held.id) ?? null, pose.distance);
    if (heldDof) dof = { mode: track.dof.mode, ...heldDof };
  }
  return { pose, dof };
}

/** The pose-only sampler every existing call site uses. */
export function sampleSceneCamera(track: SceneCameraTrack, localMs: number): SceneDocCameraPose {
  return sampleSceneCameraWithDof(track, localMs).pose;
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

/** The pose a scene's camera holds after its last key: what the NEXT scene continues from. Null when the scene drives nothing. */
export function finalScenePose(
  tracks: SceneCameraTracks | null | undefined,
): SceneDocRigPose | null {
  if (!tracks) return null;
  if (tracks.mode === "rig" && tracks.rig) {
    const keys = tracks.rig.keys;
    const sample = sampleSceneRig(tracks.rig, keys[keys.length - 1].tMs);
    const pose: SceneDocRigPose = {
      position: sample.position,
      aim: { mode: "point", at: sample.lookAt },
    };
    if (sample.fov !== undefined) pose.fov = sample.fov;
    if (sample.rollDeg) pose.rollDeg = sample.rollDeg;
    return pose;
  }
  if (!tracks.orbit) return null;
  const keys = tracks.orbit.keys;
  const view = orbitToView(sampleSceneCamera(tracks.orbit, keys[keys.length - 1].tMs));
  return { position: view.position, aim: { mode: "point", at: view.lookAt } };
}

/** Normalize every scene doc's camera once per project load (index-aligned with the slots). A scene whose animated track is the layered screenshot contributes nothing (its keys stay on disk untouched; the toggle just stands the camera down). The rig is only normalized under `cameraMode: "rig"`, so an orbit-mode scene carrying a stale rig block costs nothing and warns about nothing.
 *
 * A rig whose earliest key sets `continueFromPrevious` has that key's pose REPLACED at load with the previous scene's final applied pose. It is a load-time substitution and nothing else: `resolveFrameCameras`, the compositor and the export loop are all untouched. The walk runs forward, so a chain of continuing scenes resolves correctly and cannot cycle. */
export function buildSceneCameraTracks(
  sceneDocs: readonly (SceneDoc | undefined)[],
): (SceneCameraTracks | null)[] {
  const tracks: (SceneCameraTracks | null)[] = [];
  for (let i = 0; i < sceneDocs.length; i++) {
    const doc = sceneDocs[i];
    if (!doc || doc.animatedTrack === "layeredScreenshot") {
      tracks.push(null);
      continue;
    }
    const source = `scene ${i}`;
    const orbit = normalizeSceneCamera(doc.camera, source);
    let rigRaw = doc.cameraMode === "rig" ? doc.cameraRig : undefined;
    if (rigRaw && continuesFromPrevious(rigRaw)) {
      const previous = i > 0 ? finalScenePose(tracks[i - 1]) : null;
      if (!previous) {
        console.warn(
          `[sceneCamera] ${source}: continueFromPrevious has no previous camera to continue — ignored`,
        );
      } else {
        rigRaw = withEarliestKeyPose(rigRaw, previous);
      }
    }
    tracks.push(sceneCameraTracks(orbit, normalizeSceneRig(rigRaw, source, doc)));
  }
  return tracks;
}

/** The earliest-by-time key, which is the only one the flag is legal on. */
function earliestKeyIndex(raw: NonNullable<SceneDoc["cameraRig"]>): number {
  let best = -1;
  for (let i = 0; i < raw.keys.length; i++) {
    const key = raw.keys[i];
    if (!key || !Number.isFinite(key.tMs)) continue;
    if (best < 0 || key.tMs < raw.keys[best].tMs) best = i;
  }
  return best;
}

function continuesFromPrevious(raw: NonNullable<SceneDoc["cameraRig"]>): boolean {
  const i = earliestKeyIndex(raw);
  return i >= 0 && raw.keys[i].continueFromPrevious === true;
}

/** Substitute the earliest key's pose BEFORE normalising, so the spline's shaping neighbours are computed from the pose that will actually render. */
function withEarliestKeyPose(
  raw: NonNullable<SceneDoc["cameraRig"]>,
  pose: SceneDocRigPose,
): NonNullable<SceneDoc["cameraRig"]> {
  const i = earliestKeyIndex(raw);
  if (i < 0) return raw;
  return {
    ...raw,
    keys: raw.keys.map((key, index) => (index === i ? { ...key, pose } : key)),
  };
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
  /** The PROJECT's dof union (constant across frames, a pure function of the tracks): which blur families the composer chain must build. Null when no scene's driving track has active dof. */
  dofUnion?: { depth: boolean; tilt: boolean } | null;
}

/** Which dof families any scene's DRIVING track activates (rig mode reads the rig block, orbit mode the orbit block, matching `poseFor`). Constant per project load, so the composer chain it keys stays project-stable. */
export function dofUnionOf(
  tracks: readonly (SceneCameraTracks | null)[] | null | undefined,
): { depth: boolean; tilt: boolean } | null {
  let depth = false;
  let tilt = false;
  for (const scene of tracks ?? []) {
    if (!scene) continue;
    const dof = scene.mode === "rig" ? scene.rig?.dof : scene.orbit?.dof;
    if (!dof?.active) continue;
    if (dof.mode === "depth") depth = true;
    else tilt = true;
  }
  return depth || tilt ? { depth, tilt } : null;
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
        dof: rig.dof,
      };
    }
    if (!scene.orbit) return fallback;
    const sample = sampleSceneCameraWithDof(scene.orbit, active.localMs);
    const view = orbitToView(sample.pose);
    return {
      position: view.position,
      lookAt: view.lookAt,
      fov: fallback.fov,
      dof: sample.dof ?? undefined,
    };
  };

  const dofUnion = dofUnionOf(tracks);
  const tr = resolved.transition;
  if (resolved.active.length < 2 || !tr) {
    return { solo: poseFor(resolved.active[resolved.active.length - 1]), dofUnion };
  }
  const byIndex = new Map(resolved.active.map((s) => [s.index, s]));
  const from = byIndex.get(tr.fromIndex);
  const to = byIndex.get(tr.toIndex);
  if (!from || !to) {
    return { solo: poseFor(resolved.active[resolved.active.length - 1]), dofUnion };
  }
  const a = poseFor(from);
  const b = poseFor(to);
  return { a, b, overlay: tr.progress < 0.5 ? a : b, dofUnion };
}
