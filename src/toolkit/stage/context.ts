import { createContext, useContext } from "react";

/** Stage state for the mounted scene: non-null inside a `<SceneStage>` whose theme (merged with the sidecar's staging overrides) actively lights the scene; created inside the canvas subtree (bridges within the r3f reconciler, the SceneContext rule). */
export interface SceneStageState {
  /** True when the stage's key light casts real shadow maps (the hybrid decision: a floor/backdrop is present AND the shadow technique is "map"); staged primitives set `castShadow`/`receiveShadow` from this, and `Device`'s procedural blob shadow defaults to "none" so the two systems never double-shadow. */
  mapShadows: boolean;
  /** World y of the staged floor plane when the resolved backdrop is a floor, else null (nothing to ground on). */
  floorY: number | null;
}

export const SceneStageContext = createContext<SceneStageState | null>(null);

/** True inside an actively-lighting `<SceneStage>`; the staged primitives' bundled lit sets (inline rig + one-shot `<Environment>`) stand down by default, though an explicit `lit` prop still wins. */
export function useSceneStaged(): boolean {
  return useContext(SceneStageContext) !== null;
}

/** True when the mounted stage renders real shadow maps (see `SceneStageState`). */
export function useStageMapShadows(): boolean {
  return useContext(SceneStageContext)?.mapShadows ?? false;
}

/** World y of the staged floor when the mounted stage resolves a floor backdrop, else null. */
export function useStageFloorY(): number | null {
  return useContext(SceneStageContext)?.floorY ?? null;
}
