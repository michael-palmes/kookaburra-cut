import { Color, MathUtils, type Scene, type Texture } from "three";
import type { Theme } from "../theme/tokens";
import type { Resolved } from "./sceneTimeline";

/** Per-scene render state at the compositor seam: values that live on the root three `Scene` (background, environment) and therefore cannot vary per scene by mounting things inside scene groups. Mirrors the per-scene camera plan: projects using no v8 theme feature build a null state list and the compositor never touches `scene.background`/`scene.environment` (the byte-identical legacy path, where the background is the Canvas-root colour and environments are drei's last-mount-wins), while an opted-in project gets an explicit state every frame, per offscreen target on transition frames (the stale-state lesson: no inheritance across scenes). See docs/determinism.md. */

export interface SceneRenderState {
  /** The scene's theme background (`Color.set` reads the hex as sRGB → linear working space). */
  background: Color;
  /** `theme.environment.source`, resolved to a PMREM texture at apply time via `engine/environments.ts`; absent keeps the scene on the shared environment (see below). */
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

/** The root scene's environment values before the plan touched anything this frame, captured once per `renderComposited` call; scenes whose theme declares no environment (or sources still loading in preview) apply this explicitly every frame since they must never inherit the previous render target's themed environment (the stale-state lesson), and legacy drei `<Environment>` mounts keep working through it. */
export interface SharedEnvironmentSnapshot {
  environment: Texture | null;
  intensity: number;
  rotationYRad: number;
}

/** Does this project opt into theme-driven scene state? True when any scene swaps the theme (per-scene backgrounds) or the project theme itself carries a v8 block; false means the whole seam is a no-op (legacy projects, all standing baselines). */
export function usesThemedSceneState(projectTheme: Theme, sceneThemes: readonly Theme[]): boolean {
  if (projectTheme.lighting || projectTheme.environment || projectTheme.backdrop) return true;
  return sceneThemes.some((t) => t !== projectTheme);
}

/** Prebuilds one state per scene (colours parsed once, no per-frame allocation), or null when the project doesn't opt in. */
export function buildSceneRenderStates(
  projectTheme: Theme,
  sceneThemes: readonly Theme[],
): SceneRenderState[] | null {
  if (!usesThemedSceneState(projectTheme, sceneThemes)) return null;
  return sceneThemes.map((t) => {
    const state: SceneRenderState = { background: new Color(t.colors.background) };
    if (t.environment) {
      state.environmentSource = t.environment.source;
      state.environmentIntensity = t.environment.intensity;
      state.environmentRotationDeg = t.environment.rotationDeg;
    }
    return state;
  });
}

/** The frame's state plan: solo scenes get `solo`, transition frames get per-target `a`/`b` plus the dominant scene's `overlay`; undefined only when the project didn't opt in (null states) or nothing is active. */
export function resolveFrameSceneStates(
  states: readonly SceneRenderState[] | null,
  resolved: Resolved,
): FrameSceneStatePlan | undefined {
  if (!states || resolved.active.length === 0) return undefined;
  const tr = resolved.transition;
  if (tr && resolved.active.length >= 2) {
    const a = states[tr.fromIndex];
    const b = states[tr.toIndex];
    return { a, b, overlay: tr.progress < 0.5 ? a : b };
  }
  const idx = resolved.active[resolved.active.length - 1].index;
  return { solo: states[idx] };
}

/** Writes one scene's state onto the shared root scene immediately before its render; `resolveEnvironment` is injected (engine/environments.ts in production, a fake in unit tests) and may return null while a source is still loading, in which case the shared snapshot applies instead. */
export function applySceneRenderState(
  scene: Scene,
  s: SceneRenderState,
  sharedEnv: SharedEnvironmentSnapshot,
  resolveEnvironment: (source: string) => Texture | null,
): void {
  scene.background = s.background;
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
