import { createContext, type ReactNode, useMemo } from "react";
import type { CameraKeyframe } from "./cameraTrack";
import { useFormat } from "./format";
import { collectParseWarnings } from "./parseWarnings";
import type { LoadedProject } from "./project";
import { buildSceneCameraTracks, type SceneCameraTracks, sceneCameraTiming } from "./sceneCamera";
import { useSceneStageFloors } from "./stageRegistry";

/** The loaded project's scene camera tracks for `useSceneCamera`, built on first read (projects whose scenes never ask pay nothing) from the same inputs the render seams use. */
export interface SceneCameraTracksValue {
  tracks: () => readonly (SceneCameraTracks | null)[];
  projectTrack?: CameraKeyframe[];
}

export const SceneCameraTracksContext = createContext<SceneCameraTracksValue | null>(null);

/** Mounted wherever scenes mount (the shared scene tree, Present). The render seams already report the tracks' parse warnings, so this build collects and drops its own. */
export function SceneCameraTracksProvider({
  project,
  children,
}: {
  project: LoadedProject | null;
  children: ReactNode;
}) {
  const format = useFormat();
  const floorYs = useSceneStageFloors(project?.slots.length ?? 0);
  const value = useMemo<SceneCameraTracksValue | null>(() => {
    if (!project) return null;
    let built: (SceneCameraTracks | null)[] | null = null;
    return {
      projectTrack: project.cameraTrack,
      tracks: () => {
        built ??= collectParseWarnings(() =>
          buildSceneCameraTracks(project.sceneDocs, format, floorYs, sceneCameraTiming(project)),
        ).result;
        return built;
      },
    };
  }, [project, format, floorYs]);
  return (
    <SceneCameraTracksContext.Provider value={value}>{children}</SceneCameraTracksContext.Provider>
  );
}
