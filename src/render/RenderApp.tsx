import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useState } from "react";
import { useClockStore } from "../engine/clock";
import { useEffectsStore } from "../engine/effectsStore";
import { ExportBridge, ProjectCommitStamp } from "../engine/exportBridge";
import { CAMERA, type FormatSpec, SHADOW_MAP_TYPE } from "../engine/format";
import { ensureRectAreaLightUniforms } from "../engine/lightingState";
import type { LoadedProject } from "../engine/project";
import { RenderSettingsApplier } from "../engine/RenderSettingsApplier";
import { StageScenes } from "../engine/StageScenes";
import { useEditorStore } from "../store/editorStore";
import { startBridgeService } from "./bridgeService";
import { startHeartbeat } from "./heartbeat";

/** The hidden render window: the same engine canvas as the editor (ExportBridge, RenderSettingsApplier, StageScenes) minus every interactive piece: no CompositorDriver, no PreviewClock, frameloop "never". Renders happen only when the bridge service drives the deterministic capture path; the heartbeat stays as the liveness watchdog. */
export function RenderApp() {
  const [project, setProject] = useState<LoadedProject | null>(null);
  const theme = useEditorStore((s) => s.theme);

  // The realm-local half of App's applyLoadedProject: exactly the store writes the canvas tree reads.
  const apply = useCallback((loaded: LoadedProject, format: FormatSpec) => {
    useEditorStore.getState().setTheme(loaded.theme);
    useEditorStore.getState().setFormat(format);
    useEffectsStore
      .getState()
      .setProjectEffects(
        loaded.effects,
        loaded.effectOverrides,
        loaded.sceneEffectDefaults,
        loaded.renderSettings,
      );
    useClockStore.getState().setDurationMs(loaded.totalMs);
    setProject(loaded);
  }, []);

  useEffect(() => startHeartbeat(), []);
  useEffect(() => startBridgeService(apply), [apply]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas
        frameloop="never"
        dpr={1}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        shadows={{ enabled: true, type: SHADOW_MAP_TYPE }}
        onCreated={({ gl }) => {
          ensureRectAreaLightUniforms();
          console.warn(
            "[render-gl] context:",
            JSON.stringify(gl.getContext().getContextAttributes()),
            `maxSamples=${gl.capabilities.maxSamples}`,
            `extColorBufferFloat=${gl.extensions.has("EXT_color_buffer_float")}`,
          );
        }}
        camera={{ position: CAMERA.position, fov: CAMERA.fov }}
      >
        <color attach="background" args={[theme.colors.background]} />
        <ExportBridge />
        <RenderSettingsApplier />
        <ProjectCommitStamp project={project} />
        <StageScenes project={project} />
      </Canvas>
    </div>
  );
}
