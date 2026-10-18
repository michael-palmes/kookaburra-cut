import { createContext, useContext } from "react";
import type { LightingSpec, Theme } from "../theme/tokens";
import type { FormatInfo } from "../toolkit/types";
import type { ProjectMusic } from "./musicTime";
import type { SceneDoc } from "./sceneDocSchema";

/** Per-scene placement on the global timeline (supplied by `<SceneHost>`, read by `useTimeline()`); created inside the canvas subtree so it bridges within the r3f reconciler. */
export interface SceneTimeContext {
  index: number;
  startMs: number;
  durationMs: number;
  /** Present only inside a comparison's side-B subtree; timing is identical to side A, so `useTimeline()` consumers never care. */
  side?: "b";
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

/** Fixture ids that must reserve paired lights because this host's active lighting track can raise them above zero. */
export const AnimatedFixtureLightIdsContext = createContext<ReadonlySet<string>>(new Set());

/** The project-default lighting layer (`LoadedProject.projectLighting`), the middle layer of theme -> project -> scene; provided beside `ProjectIdContext` inside the canvas so `SceneStage` resolves it per scene. Null when the manifest declares none, which resolves exactly as before. */
export const ProjectLightingContext = createContext<LightingSpec | null>(null);

/** The project's authored music (`LoadedProject.music`) plus each scene's authored slot start, so `useBeatGrid()` and `useCues()` measure scene-local time exactly as sidecar `at` positions do, even where a host steers the scene clock (Present's slideshow anchors). */
export interface ProjectMusicValue {
  music: ProjectMusic;
  sceneStartsMs: readonly number[];
}

/** Provided beside `ProjectLightingContext`; null when the project authors no grid, cues or sections, so the hooks return their empty values. */
export const ProjectMusicContext = createContext<ProjectMusicValue | null>(null);

/** The context value for a project, memoised by the caller per project. */
export function projectMusicValue(
  project: { music?: ProjectMusic; slots: readonly { startMs: number }[] } | null,
): ProjectMusicValue | null {
  if (!project?.music) return null;
  return { music: project.music, sceneStartsMs: project.slots.map((s) => s.startMs) };
}

/** The mounted scene's resolved theme (the project theme unless the sidecar overrides `themeId`); `useTheme()` reads this first, falling back to the editor store for UI chrome, which deliberately keeps the project theme since per-scene render state is applied at the compositor seam instead. */
export const SceneThemeContext = createContext<Theme | null>(null);

/** A scene-scoped format override, supplied by `<SceneHost>` only when the scene renders through an overlay cutout, so `useFormat()` lays the scene out as if the cutout were the whole frame; null everywhere else, where `useFormat()` falls back to the editor store's export format (byte-identical to before overlays). */
export const FormatContext = createContext<FormatInfo | null>(null);

/** True inside a scene whose overlay claims its title/subtitle text: `<SceneHost>` sets it, and `TitleBlock` renders null under it so the headline appears only in the overlay panel, never in-world. False everywhere else (no frame, or `claimsSceneText: false`), so unframed scenes are byte-identical. */
export const SceneTextClaimedContext = createContext<boolean>(false);
