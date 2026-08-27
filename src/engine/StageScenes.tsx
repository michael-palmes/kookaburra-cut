import { Suspense, useMemo } from "react";
import { ChartFallback } from "../toolkit/chart/ChartFallback";
import { CompareChips } from "../toolkit/compare/CompareChips";
import { DevicesFallback } from "../toolkit/device/Device";
import { AssetBoundary } from "../toolkit/media/AssetBoundary";
import { LayeredScreenshotFallback } from "../toolkit/media/LayeredScreenshot";
import { SceneMediaFallback } from "../toolkit/media/SceneMedia";
import { ObjectsFallback } from "../toolkit/objects/ObjectPrimitive";
import { SceneBackground } from "../toolkit/stage/FixedBackdrop";
import { TextFallback } from "../toolkit/text/TitleBlock";
import { FramePanel } from "./FramePanel";
import { PersistentLayer } from "./PersistentLayer";
import { type LoadedProject, sceneMountKey } from "./project";
import { SceneHost } from "./SceneHost";
import { ProjectIdContext, ProjectLightingContext } from "./sceneContext";
import {
  animatedFixtureLightIds,
  buildCompareBLightingTracks,
  buildLightingTracks,
} from "./sceneLighting";

/** The canvas scene tree both windows mount: scene hosts (plus comparison side-B twins), the persistent layer and the overlay frame panels, moved verbatim from App so the editor and the hidden render window cannot drift. Window-specific companions (PreviewClock, CompositorDriver, the commit stamps) mount beside it, never inside. */
export function StageScenes({ project }: { project: LoadedProject | null }) {
  const animatedFixtureLightSets = useMemo(
    () =>
      (() => {
        if (!project) return null;
        const tracks = buildLightingTracks(
          project.sceneThemes,
          project.projectLighting,
          project.sceneDocs,
        );
        const afterTracks = buildCompareBLightingTracks(
          project.sceneThemes,
          project.compareBThemes,
          project.projectLighting,
          project.sceneDocs,
        );
        return {
          a: tracks.map(animatedFixtureLightIds),
          b: tracks.map((track, index) =>
            animatedFixtureLightIds(afterTracks.owned[index] ? afterTracks.tracks[index] : track),
          ),
        };
      })(),
    [project],
  );
  return (
    <ProjectIdContext.Provider value={project?.id ?? null}>
      <ProjectLightingContext.Provider value={project?.projectLighting ?? null}>
        <Suspense fallback={null}>
          {project?.scenes.map((scene, i) => {
            const slot = project.slots[i];
            const SceneComponent = scene.Scene;
            return (
              <SceneHost
                key={sceneMountKey(project.id, project.sceneFiles[i])}
                index={i}
                id={project.sceneFiles[i]}
                startMs={slot.startMs}
                durationMs={slot.durationMs}
                doc={project.sceneDocs[i]}
                theme={project.sceneThemes[i]}
                frame={project.sceneFrames[i]}
                animatedFixtureLightIds={animatedFixtureLightSets?.a[i]}
              >
                {/* The backstop boundary: an uncontained scene render error degrades to an empty scene, never a torn-down canvas tree; the host's group/registry stay mounted. */}
                <AssetBoundary label={`scene ${i + 1}`}>
                  {/* The fixed background mounts host-side for every scene, staged or not, so Background picks never depend on the scene authoring a <SceneStage> (staging/lighting stays opt-in). */}
                  <SceneBackground />
                  <SceneComponent />
                  <SceneMediaFallback />
                  {/* Host-side fallbacks so Add device / Add text work on scenes whose TSX never wires the sidecar hooks; the registries suppress them when it does. */}
                  <DevicesFallback />
                  <ObjectsFallback />
                  <LayeredScreenshotFallback />
                  <ChartFallback />
                  <TextFallback />
                  <CompareChips />
                </AssetBoundary>
              </SceneHost>
            );
          })}
          {/* Comparison side-B hosts: the same scene component mounted again with side B's derived doc and theme, so per-side media/background/lighting scope through the normal host machinery; the compositor renders the pair to its A/B targets and masks them. */}
          {project?.scenes.map((scene, i) => {
            const bDoc = project.compareBDocs[i];
            if (!bDoc) return null;
            const slot = project.slots[i];
            const SceneComponent = scene.Scene;
            return (
              <SceneHost
                key={`${sceneMountKey(project.id, project.sceneFiles[i])}:b`}
                index={i}
                side="b"
                id={project.sceneFiles[i]}
                startMs={slot.startMs}
                durationMs={slot.durationMs}
                doc={bDoc}
                theme={project.compareBThemes[i]}
                frame={project.sceneFrames[i]}
                animatedFixtureLightIds={animatedFixtureLightSets?.b[i]}
              >
                <AssetBoundary label={`scene ${i + 1} after`}>
                  <SceneBackground />
                  <SceneComponent />
                  <SceneMediaFallback />
                  <DevicesFallback />
                  <ObjectsFallback />
                  <LayeredScreenshotFallback />
                  <ChartFallback />
                  <TextFallback />
                  <CompareChips />
                </AssetBoundary>
              </SceneHost>
            );
          })}
          {/* The persistent (hoisted morph) layer mounts once as a sibling of the scene hosts, outside every SceneContext, so it reads global time and tweens across scene seams. The compositor owns its per-frame visibility. */}
          {project?.persistent && (
            <PersistentLayer key={`${project.id}:persistent`}>
              <project.persistent />
            </PersistentLayer>
          )}
          {/* Overlay panels: one per framed or terminal-carrying scene, siblings of the scene hosts so they lay out against the full frame (not the cutout). The compositor draws the active scene's panel over its composited slide. */}
          {project?.scenes.map((_, i) => {
            const frame = project.sceneFrames[i];
            if (!frame && !project.sceneDocs[i]?.terminal) return null;
            const slot = project.slots[i];
            return (
              <FramePanel
                key={`${sceneMountKey(project.id, project.sceneFiles[i])}:panel`}
                index={i}
                startMs={slot.startMs}
                durationMs={slot.durationMs}
                doc={project.sceneDocs[i]}
                theme={project.sceneThemes[i]}
                frame={frame ?? undefined}
              />
            );
          })}
        </Suspense>
      </ProjectLightingContext.Provider>
    </ProjectIdContext.Provider>
  );
}
