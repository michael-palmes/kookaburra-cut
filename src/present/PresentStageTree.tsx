import { useThree } from "@react-three/fiber";
import { type ReactNode, Suspense, useEffect, useMemo } from "react";
import { useClockStore } from "../engine/clock";
import { FramePanel } from "../engine/FramePanel";
import { PersistentLayer } from "../engine/PersistentLayer";
import { type LoadedProject, sceneMountKey } from "../engine/project";
import { ProjectSharedContext } from "../engine/projectShared";
import { isSceneErrorCard } from "../engine/SceneErrorCard";
import { SceneHost } from "../engine/SceneHost";
import { sceneRenderErrorReporter } from "../engine/StageScenes";
import { sceneCameraTiming } from "../engine/sceneCamera";
import { SceneCameraTracksProvider } from "../engine/sceneCameraContext";
import {
  ProjectIdContext,
  ProjectLightingContext,
  ProjectMusicContext,
  projectMusicValue,
} from "../engine/sceneContext";
import { animatedFixtureLightIds, buildLightingTracks } from "../engine/sceneLighting";
import { buildRoomTracks } from "../engine/sceneRoom";
import { useEditorStore } from "../store/editorStore";
import { ChartFallback } from "../toolkit/chart/ChartFallback";
import { DevicesFallback } from "../toolkit/device/Device";
import { AssetBoundary } from "../toolkit/media/AssetBoundary";
import { LayeredScreenshotFallback } from "../toolkit/media/LayeredScreenshot";
import { SceneMediaFallback } from "../toolkit/media/SceneMedia";
import { ObjectsFallback } from "../toolkit/objects/ObjectPrimitive";
import { MosaicFallback } from "../toolkit/shapes/SplitField";
import { TapsFallback } from "../toolkit/shapes/TapRing";
import { SceneBackground } from "../toolkit/stage/FixedBackdrop";
import { SceneRoom, SceneRoomScope } from "../toolkit/stage/Room";
import { TextFallback } from "../toolkit/text/TitleBlock";
import { PresentCompositorDriver } from "./PresentCompositorDriver";
import { usePresentStore } from "./presentStore";

/** Keeps a long-held scene's clips inside useClipTexture's near gate. */
const ACTIVE_DURATION_EXTENSION_MS = 86_400_000;

/** Last child of the Suspense boundary: its effect runs after every scene subtree's effects in the same commit, so timing registrations are in place when this fires. */
function CommittedProbe() {
  useEffect(() => {
    usePresentStore.getState().setScenesCommitted(true);
    return () => usePresentStore.getState().setScenesCommitted(false);
  }, []);
  return null;
}

/** Re-renders one frame per clock change (the editor's PreviewClock, present flavour). */
function PresentClock() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    return useClockStore.subscribe((state, prev) => {
      if (state.currentMs !== prev.currentMs) invalidate();
    });
  }, [invalidate]);
  return null;
}

/** The project id and `shared` contexts Present's scene tree reads, as StageScenes provides them. */
function ProjectScope({ project, children }: { project: LoadedProject; children: ReactNode }) {
  return (
    <ProjectIdContext.Provider value={project.id}>
      <ProjectSharedContext.Provider value={project.projectShared ?? null}>
        <SceneCameraTracksProvider project={project}>{children}</SceneCameraTracksProvider>
      </ProjectSharedContext.Provider>
    </ProjectIdContext.Provider>
  );
}

/** Present's canvas tree, mounted by the Present window's stage worker: the slideshow or video scene hosts with their anchors, the panels, the hoisted morphs in video mode, and the present compositor driver. Moved verbatim out of PresentApp, which keeps only chrome. */
export function PresentStageTree({ project }: { project: LoadedProject | null }) {
  const theme = useEditorStore((s) => s.theme);
  const mode = usePresentStore((s) => s.mode);
  const deck = usePresentStore((s) => s.deck);
  const anchors = usePresentStore((s) => s.anchors);
  const animatedFixtureLightSets = useMemo(
    () =>
      project
        ? buildLightingTracks(project.sceneThemes, project.projectLighting, project.sceneDocs).map(
            animatedFixtureLightIds,
          )
        : [],
    [project],
  );
  const roomTracks = useMemo(
    () =>
      project
        ? buildRoomTracks(project.sceneDocs, {
            sceneThemes: project.sceneThemes,
            roomThemes: project.roomThemes,
            projectLighting: project.projectLighting,
            timing: sceneCameraTiming(project),
          })
        : null,
    [project],
  );
  const musicValue = useMemo(() => projectMusicValue(project), [project]);
  return (
    <>
      <color
        attach="background"
        args={[project?.theme.colors.background ?? theme.colors.background]}
      />
      <PresentClock />
      {project && <PresentCompositorDriver project={project} mode={mode} />}
      {project && (
        <ProjectScope project={project}>
          <ProjectLightingContext.Provider value={project.projectLighting ?? null}>
            <ProjectMusicContext.Provider value={musicValue}>
              <Suspense fallback={null}>
                {project.scenes.map((scene, i) => {
                  const slot = project.slots[i];
                  const SceneComponent = scene.Scene;
                  const active = mode === "slideshow" && deck.sceneIndex === i;
                  return (
                    <SceneHost
                      key={sceneMountKey(project.id, project.sceneFiles[i])}
                      index={i}
                      id={project.sceneFiles[i]}
                      startMs={mode === "slideshow" ? (anchors[i] ?? slot.startMs) : slot.startMs}
                      durationMs={
                        active ? slot.durationMs + ACTIVE_DURATION_EXTENSION_MS : slot.durationMs
                      }
                      doc={project.sceneDocs[i]}
                      theme={project.sceneThemes[i]}
                      frame={project.sceneFrames[i]}
                      animatedFixtureLightIds={animatedFixtureLightSets[i]}
                    >
                      <AssetBoundary
                        label={`scene ${i + 1}`}
                        resetKey={project}
                        onError={sceneRenderErrorReporter(project, i)}
                      >
                        {isSceneErrorCard(scene) ? (
                          <SceneComponent />
                        ) : (
                          <SceneRoomScope track={roomTracks?.[i] ?? null}>
                            <SceneBackground />
                            <SceneRoom />
                            <SceneComponent />
                            <SceneMediaFallback />
                            <DevicesFallback />
                            <ObjectsFallback />
                            <LayeredScreenshotFallback />
                            <ChartFallback />
                            <MosaicFallback />
                            <TapsFallback />
                            <TextFallback />
                          </SceneRoomScope>
                        )}
                      </AssetBoundary>
                    </SceneHost>
                  );
                })}
                {/* Hoisted morphs key off the authored global timeline, which a slideshow's steered clock no longer matches; video mode keeps them. */}
                {mode === "video" && project.persistent && (
                  <PersistentLayer key={`${project.id}:persistent`}>
                    <project.persistent />
                  </PersistentLayer>
                )}
                {project.scenes.map((_, i) => {
                  const frame = project.sceneFrames[i];
                  if (!frame && !project.sceneDocs[i]?.terminal && !project.sceneDocs[i]?.website) {
                    return null;
                  }
                  const slot = project.slots[i];
                  const active = mode === "slideshow" && deck.sceneIndex === i;
                  return (
                    <FramePanel
                      key={`${sceneMountKey(project.id, project.sceneFiles[i])}:panel`}
                      index={i}
                      startMs={mode === "slideshow" ? (anchors[i] ?? slot.startMs) : slot.startMs}
                      durationMs={
                        active ? slot.durationMs + ACTIVE_DURATION_EXTENSION_MS : slot.durationMs
                      }
                      doc={project.sceneDocs[i]}
                      theme={project.sceneThemes[i]}
                      frame={frame ?? undefined}
                    />
                  );
                })}
                <CommittedProbe />
              </Suspense>
            </ProjectMusicContext.Provider>
          </ProjectLightingContext.Provider>
        </ProjectScope>
      )}
    </>
  );
}
