import { createContext, useContext } from "react";
import type { Theme } from "../theme/tokens";
import type { SceneDoc } from "./sceneDocSchema";

/** Per-scene placement on the global timeline (supplied by `<SceneHost>`, read by `useTimeline()`); created inside the canvas subtree so it bridges within the r3f reconciler. */
export interface SceneTimeContext {
  index: number;
  startMs: number;
  durationMs: number;
}

/** Null outside any scene → `useTimeline()` falls back to project time (localMs === globalMs). */
export const SceneContext = createContext<SceneTimeContext | null>(null);

export function useSceneContext(): SceneTimeContext | null {
  return useContext(SceneContext);
}

/** The id of the project owning the mounted canvas tree; deliberately not the editor store, since on a project switch the store's `projectId` updates one render before old scenes unmount, which would resolve a still-mounted asset consumer (e.g. `VideoClip`) against the wrong project's folder. Null outside the app tree falls back to the store. */
export const ProjectIdContext = createContext<string | null>(null);

/** The mounted scene's sidecar document, supplied by `<SceneHost>` from `LoadedProject.sceneDocs` and read by `useSceneText`/`useSceneDevices`; null when the scene has no sidecar, which then renders exactly as before. */
export const SceneDocContext = createContext<SceneDoc | null>(null);

/** The mounted scene's resolved theme (the project theme unless the sidecar overrides `themeId`); `useTheme()` reads this first, falling back to the editor store for UI chrome, which deliberately keeps the project theme since per-scene render state is applied at the compositor seam instead. */
export const SceneThemeContext = createContext<Theme | null>(null);
