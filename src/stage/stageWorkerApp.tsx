import "../engine/glContexts";
import { createRoot, extend, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { Texture, TextureLoader } from "three";
import { configureTextBuilder } from "troika-three-text";
import { create } from "zustand";
import { getAutoRunConfig, initAutoRunConfig, runAutoRun } from "../engine/autorun";
import { CompositorDriver } from "../engine/CompositorDriver";
import { useClockStore } from "../engine/clock";
import { installDevPerformanceDrain } from "../engine/devPerformance";
import { useEffectsStore } from "../engine/effectsStore";
import { canvasHandle, ExportBridge } from "../engine/exportBridge";
import { awaitSceneHostsCommitted } from "../engine/exporter";
import { CAMERA, SHADOW_MAP_TYPE } from "../engine/format";
import { tagGlCanvas } from "../engine/glContexts";
import { ensureRectAreaLightUniforms } from "../engine/lightingState";
import { type LoadedProject, loadProject } from "../engine/project";
import { RenderSettingsApplier } from "../engine/RenderSettingsApplier";
import { StageScenes } from "../engine/StageScenes";
import { useEditorStore } from "../store/editorStore";
import { preloadAppFonts } from "../theme/fonts";
import type { StageInitMessage } from "./spikeMessages";

/** SPIKE (scene isolation, Phase 1): the engine canvas tree mounted on an OffscreenCanvas inside the worker, then the ordinary autorun driven from here. The tree is the editor's (ExportBridge, RenderSettingsApplier, CompositorDriver, StageScenes) minus the DOM-only pieces (StagePointer, the terminal and website overlays). */

const useStageStore = create<{ project: LoadedProject | null }>(() => ({ project: null }));

/** Worker-side twin of App's PreviewClock: a clock write invalidates the demand loop so playback renders through the compositor. */
function PreviewClock() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(
    () =>
      useClockStore.subscribe((state, prev) => {
        if (state.currentMs !== prev.currentMs) invalidate();
      }),
    [invalidate],
  );
  return null;
}

function StageTree() {
  const project = useStageStore((s) => s.project);
  const theme = useEditorStore((s) => s.theme);
  return (
    <>
      <color attach="background" args={[theme.colors.background]} />
      <PreviewClock />
      <ExportBridge />
      <RenderSettingsApplier />
      {project && (
        <CompositorDriver
          projectId={project.id}
          slots={project.slots}
          cameraTrack={project.cameraTrack}
          sceneDocs={project.sceneDocs}
          theme={project.theme}
          sceneThemes={project.sceneThemes}
          projectLighting={project.projectLighting}
          sceneFrames={project.sceneFrames}
          compareBDocs={project.compareBDocs}
          compareBThemes={project.compareBThemes}
          roomThemes={project.roomThemes}
          motionBlur={project.renderSettings.motionBlur}
          music={project.music}
          commitStamp={project}
        />
      )}
      <StageScenes project={project} />
    </>
  );
}

function bitmapOptions(): {
  premultiplyAlpha: PremultiplyAlpha;
  colorSpaceConversion: ColorSpaceConversion;
} {
  const mode = import.meta.env.VITE_STAGE_BITMAP ?? "none";
  return {
    premultiplyAlpha: mode.startsWith("premultiply")
      ? "premultiply"
      : mode.startsWith("default")
        ? "default"
        : "none",
    colorSpaceConversion: mode.endsWith("-nocolor") ? "none" : "default",
  };
}

/** Image textures decode through fetch + createImageBitmap: three's ImageLoader needs an `<img>`, which the worker has not. Orientation follows the texture's `flipY` (read after the synchronous caller settled it, so glTF's `flipY = false` holds), alpha stays straight. */
function installWorkerTextureLoader(): void {
  (TextureLoader.prototype as unknown as { load: unknown }).load = function load(
    this: TextureLoader,
    url: string,
    onLoad?: (texture: Texture) => void,
    _onProgress?: unknown,
    onError?: (err: unknown) => void,
  ) {
    const texture = new Texture();
    const resolved = this.manager.resolveURL(this.path ? this.path + url : url);
    this.manager.itemStart(resolved);
    fetch(resolved)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${resolved}: HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) =>
        createImageBitmap(blob, {
          imageOrientation: texture.flipY ? "flipY" : "none",
          // Spike knob: VITE_STAGE_BITMAP picks the decode options under comparison.
          premultiplyAlpha: bitmapOptions().premultiplyAlpha,
          colorSpaceConversion: bitmapOptions().colorSpaceConversion,
        }),
      )
      .then(
        (bitmap) => {
          texture.image = bitmap;
          texture.needsUpdate = true;
          onLoad?.(texture);
          this.manager.itemEnd(resolved);
        },
        (err) => {
          console.warn(`[stage-worker] texture failed: ${resolved}`, err);
          onError?.(err);
          this.manager.itemError(resolved);
          this.manager.itemEnd(resolved);
        },
      );
    return texture;
  };
}

function apply(loaded: LoadedProject): void {
  useStageStore.setState({ project: loaded });
  useEditorStore.getState().setTheme(loaded.theme);
  useEffectsStore
    .getState()
    .setProjectEffects(
      loaded.effects,
      loaded.effectOverrides,
      loaded.sceneEffectDefaults,
      loaded.renderSettings,
    );
  const clock = useClockStore.getState();
  clock.setDurationMs(loaded.totalMs);
  clock.setCurrentMs(Math.min(clock.currentMs, loaded.totalMs));
}

const hop = () => new Promise<void>((r) => setTimeout(() => setTimeout(r, 0), 0));

export async function bootStage(init: StageInitMessage): Promise<void> {
  installDevPerformanceDrain();
  installWorkerTextureLoader();
  // `<Canvas>` extends the catalogue on import; a bare root must do it itself.
  extend(THREE as unknown as Parameters<typeof extend>[0]);
  await initAutoRunConfig();
  const config = getAutoRunConfig();
  if (!config) throw new Error("the stage worker spike runs under kookaburra:run only");
  console.warn(`[stage-worker] autorun ${config.action} ${config.project}`);
  // The atlas canvas is a WebGL OffscreenCanvas here, and WebKit's upload of one is not the raw copy an HTMLCanvasElement's is (jagged, speckled glyph edges); read the pixels back instead.
  configureTextBuilder({ sdfAtlasReadback: true });
  await preloadAppFonts();

  const root = createRoot(init.canvas);
  await root.configure({
    size: { width: init.width, height: init.height, top: 0, left: 0 },
    dpr: init.dpr,
    frameloop: "demand",
    gl: { preserveDrawingBuffer: true, antialias: true },
    shadows: { enabled: true, type: SHADOW_MAP_TYPE },
    camera: { position: CAMERA.position, fov: CAMERA.fov },
    onCreated: ({ gl }) => {
      ensureRectAreaLightUniforms();
      tagGlCanvas(gl.domElement, "stage");
      console.warn(
        "[gl] worker context:",
        JSON.stringify(gl.getContext().getContextAttributes()),
        `maxSamples=${gl.capabilities.maxSamples}`,
        `extColorBufferFloat=${gl.extensions.has("EXT_color_buffer_float")}`,
        `dpr=${gl.getPixelRatio()}`,
      );
    },
  });
  root.render(<StageTree />);

  useEditorStore.getState().setProjectId(config.project);
  useEditorStore.getState().setFormat(config.aspects[0]);
  const loaded = await loadProject(config.project);
  apply(loaded);
  await hop();
  for (let spins = 0; !canvasHandle.current; spins++) {
    if (spins > 500) throw new Error("the worker canvas never published its handle");
    await hop();
  }
  await awaitSceneHostsCommitted(loaded.slots.length);
  console.warn("[stage-worker] canvas handle ready, starting run");
  await runAutoRun(loaded, config, apply);
}
