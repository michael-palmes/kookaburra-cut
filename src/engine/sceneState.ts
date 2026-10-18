import { Color, MathUtils, type Scene, type Texture } from "three";
import type { LightingSpec, Theme } from "../theme/tokens";
import {
  environmentCacheKey,
  NONE_SOURCE,
  resolveSceneEnvironment,
  sceneMirrorRequest,
} from "./environments";
import type { SceneDoc } from "./sceneDocSchema";
import {
  type CompareBLightingTrackSet,
  type FrameLightingPlan,
  type LightingTrack,
  resolveFrameLighting,
} from "./sceneLighting";
import { type RoomTrack, roomPoseAt, sampleRoom } from "./sceneRoom";
import type { Resolved } from "./sceneTimeline";

/** Per-scene render state at the compositor seam: values that live on the root three `Scene` (background, environment) and therefore cannot vary per scene by mounting things inside scene groups. Mirrors the per-scene camera plan: projects using no v8/v9 theme feature build a null state list and the compositor never touches `scene.background`/`scene.environment` (the byte-identical legacy path, where the background is the Canvas-root colour and the environment is the lit primitives' studio environment, if any), while an opted-in project gets an explicit state every frame, per offscreen target on transition frames (the stale-state lesson: no inheritance across scenes). See docs/determinism.md. */

export interface SceneRenderState {
  /** The scene's theme background (`Color.set` reads the hex as sRGB → linear working space). */
  background: Color;
  /** The environments CACHE KEY (see `environmentCacheKey`), resolved to a PMREM texture at apply time; `"none"` means explicitly no reflections; absent keeps the scene on the shared environment (see below). */
  environmentSource?: string;
  environmentIntensity?: number;
  environmentRotationDeg?: number;
}

/** The frame's plan, same shape/semantics as `FrameCameraPlan` (solo | a/b + overlay). */
export interface FrameSceneStatePlan {
  solo?: SceneRenderState;
  a?: SceneRenderState;
  b?: SceneRenderState;
  /** The DOMINANT scene's state (progress < 0.5 ? A : B) for the persistent-overlay draw. */
  overlay?: SceneRenderState;
}

/** The root scene's environment values before the plan touched anything this frame, captured once per `renderComposited` call; scenes whose theme declares no environment (or sources still loading in preview) apply this explicitly every frame since they must never inherit the previous render target's themed environment (the stale-state lesson), and the lit primitives' studio environment keeps working through it. */
export interface SharedEnvironmentSnapshot {
  environment: Texture | null;
  intensity: number;
  rotationYRad: number;
}

/** The v9 lighting inputs to the scene-state build; absent everywhere means the v8 behaviour verbatim. */
export interface SceneStateLightingInputs {
  projectId?: string;
  projectLighting?: LightingSpec;
  sceneDocs?: readonly (SceneDoc | undefined)[];
}

/** Does this project opt into theme-driven scene state? True when any scene swaps the theme (per-scene backgrounds), the project theme itself carries a v8 block, or any v9 layer declares a lighting environment; false means the whole seam is a no-op (legacy projects, all standing baselines). */
export function usesThemedSceneState(
  projectTheme: Theme,
  sceneThemes: readonly Theme[],
  lighting?: SceneStateLightingInputs,
): boolean {
  if (projectTheme.lighting || projectTheme.environment || projectTheme.backdrop) return true;
  if (sceneThemes.some((t) => t !== projectTheme)) return true;
  if (lighting?.projectLighting?.environment) return true;
  return (lighting?.sceneDocs ?? []).some(
    (doc) =>
      doc?.room ||
      doc?.lighting?.environment ||
      doc?.lighting?.fixtures?.some((f) => f.envMirror === true),
  );
}

/** Prebuilds one state per scene (colours parsed once, no per-frame allocation), or null when the project doesn't opt in. */
export function buildSceneRenderStates(
  projectTheme: Theme,
  sceneThemes: readonly Theme[],
  lighting?: SceneStateLightingInputs,
): SceneRenderState[] | null {
  if (!usesThemedSceneState(projectTheme, sceneThemes, lighting)) return null;
  return sceneThemes.map((t, i) => {
    const state: SceneRenderState = { background: new Color(t.colors.background) };
    const doc = lighting?.sceneDocs?.[i];
    const env = resolveSceneEnvironment(t, lighting?.projectLighting, doc);
    if (env) {
      state.environmentSource = environmentCacheKey(lighting?.projectId, env.source);
      state.environmentIntensity = env.intensity;
      state.environmentRotationDeg = env.rotationDeg;
    }
    // Env-mirror fixtures replace the scene's environment with the content-keyed bake (see environments.ts); intensity/rotation still apply at the seam.
    const mirror = sceneMirrorRequest(lighting?.projectId, t, lighting?.projectLighting, doc);
    if (mirror) {
      state.environmentSource = mirror.key;
      state.environmentIntensity = env?.intensity ?? 1;
      state.environmentRotationDeg = env?.rotationDeg ?? 0;
    }
    return state;
  });
}

const roomBackgrounds = new Map<string, Color>();

/** A roomed scene's state carries its room colour as the background, sampled at that target's own scene-local time. */
function roomedState(
  states: readonly SceneRenderState[],
  rooms: readonly (RoomTrack | null)[] | null | undefined,
  index: number,
  resolved: Resolved,
): SceneRenderState {
  const state = states[index];
  const track = rooms?.[index];
  const active = track ? resolved.active.find((s) => s.index === index) : undefined;
  const colour = track && active ? sampleRoom(track, active.localMs).colour : null;
  if (!colour || !state) return state;
  let background = roomBackgrounds.get(colour);
  if (!background) {
    background = new Color(colour);
    roomBackgrounds.set(colour, background);
  }
  return { ...state, background };
}

/** The frame's state plan: solo scenes get `solo`, transition frames get per-target `a`/`b` plus the dominant scene's `overlay`; undefined only when the project didn't opt in (null states) or nothing is active. Null `rooms` returns the prebuilt states untouched. */
export function resolveFrameSceneStates(
  states: readonly SceneRenderState[] | null,
  resolved: Resolved,
  rooms?: readonly (RoomTrack | null)[] | null,
): FrameSceneStatePlan | undefined {
  if (!states || resolved.active.length === 0) return undefined;
  const tr = resolved.transition;
  if (tr && resolved.active.length >= 2) {
    const a = rooms ? roomedState(states, rooms, tr.fromIndex, resolved) : states[tr.fromIndex];
    const b = rooms ? roomedState(states, rooms, tr.toIndex, resolved) : states[tr.toIndex];
    return { a, b, overlay: tr.progress < 0.5 ? a : b };
  }
  const idx = resolved.active[resolved.active.length - 1].index;
  return { solo: rooms ? roomedState(states, rooms, idx, resolved) : states[idx] };
}

/** Everything the per-frame state and lighting resolve reads, built once per project or run. */
export interface FramePlanInputs {
  sceneStates: readonly SceneRenderState[] | null;
  lightingTracks: readonly (LightingTrack | null)[] | null | undefined;
  compareBLightingTracks?: CompareBLightingTrackSet | null;
  /** Null unless some scene has a room: today's path. */
  roomTracks?: readonly (RoomTrack | null)[] | null;
}

export interface ResolvedFramePlans {
  statePlan?: FrameSceneStatePlan;
  lightingPlan?: FrameLightingPlan;
}

/** The ONE state + lighting resolve preview, export and Present share, so the three can't drift; rooms feed both, per target at its own scene-local time. */
export function resolveFramePlans(inputs: FramePlanInputs, resolved: Resolved): ResolvedFramePlans {
  const rooms = inputs.roomTracks ?? null;
  return {
    statePlan: resolveFrameSceneStates(inputs.sceneStates, resolved, rooms),
    lightingPlan:
      resolveFrameLighting(
        inputs.lightingTracks,
        resolved,
        inputs.compareBLightingTracks,
        rooms ? roomPoseAt(rooms) : undefined,
      ) ?? undefined,
  };
}

/** Writes one scene's state onto the shared root scene immediately before its render; `resolveEnvironment` is injected (engine/environments.ts in production, a fake in unit tests) and may return null while a source is still loading, in which case the shared snapshot applies instead. `"none"` clears the environment explicitly (no reflections, never the shared fallback). */
export function applySceneRenderState(
  scene: Scene,
  s: SceneRenderState,
  sharedEnv: SharedEnvironmentSnapshot,
  resolveEnvironment: (source: string) => Texture | null,
): void {
  scene.background = s.background;
  if (s.environmentSource === NONE_SOURCE) {
    scene.environment = null;
    scene.environmentIntensity = 1;
    scene.environmentRotation.set(0, 0, 0);
    return;
  }
  const themed = s.environmentSource ? resolveEnvironment(s.environmentSource) : null;
  if (themed) {
    scene.environment = themed;
    scene.environmentIntensity = s.environmentIntensity ?? 1;
    scene.environmentRotation.set(0, MathUtils.degToRad(s.environmentRotationDeg ?? 0), 0);
  } else {
    scene.environment = sharedEnv.environment;
    scene.environmentIntensity = sharedEnv.intensity;
    scene.environmentRotation.set(0, sharedEnv.rotationYRad, 0);
  }
}
