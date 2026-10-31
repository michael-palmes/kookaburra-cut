import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useClockStore } from "../engine/clock";
import { useEffectsStore } from "../engine/effectsStore";
import type { FormatSpec } from "../engine/format";
import { glContextCensus, onGlContextLoss } from "../engine/glContexts";
import type { LoadedProject } from "../engine/project";
import { stageOrNull } from "../engine/stageHandle";
import { StageView } from "../stage/StageView";
import { useEditorStore } from "../store/editorStore";
import { markCanvasFailed, renderLoadedProject, startBridgeService } from "./bridgeService";
import { startHeartbeat } from "./heartbeat";

/** The hidden render window: the same engine canvas tree as the editor, mounted by its own stage worker, minus every interactive piece: no compositor driver, no preview clock, frameloop "never". Renders happen only when the bridge service drives the deterministic capture path through the stage; the heartbeat is the liveness watchdog and carries this realm's WebGL census. Any unexpected context loss reports to Rust, which recycles the window. */
export function RenderApp() {
  const [, setProject] = useState<LoadedProject | null>(null);

  // The realm-local half of App's applyLoadedProject: exactly the store writes the canvas tree reads, then the project itself to the stage.
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
    void stageOrNull()?.applyProject(loaded);
  }, []);

  useEffect(
    () =>
      startHeartbeat(() => ({ census: glContextCensus(), loadedProject: renderLoadedProject() })),
    [],
  );
  useEffect(() => startBridgeService(apply), [apply]);
  useEffect(
    () =>
      onGlContextLoss((loss) => {
        void invoke("render_report_gpu_event", {
          reason: loss.lossClass === "eviction" ? "eviction" : "contextLost",
          deliberate: loss.lossClass === "deliberate",
        }).catch(() => {});
      }),
    [],
  );
  // The stage's own losses (its context lives in the worker) report the same way, and a stage that never starts poisons the window as a failed canvas did, so Rust recycles it.
  useEffect(() => {
    const stage = stageOrNull();
    if (!stage) return;
    let mounted = true;
    stage.ready.catch((error: unknown) => {
      // A stage disposed before it started (StrictMode's first mount, in dev) has not failed.
      if (!mounted) return;
      console.warn("[render-gl] the stage failed to start:", error);
      markCanvasFailed(error);
      void invoke("render_report_gpu_event", { reason: "canvasFailed", deliberate: false }).catch(
        () => {},
      );
    });
    const stopLossReports = stage.subscribeContextLost(() => {
      markCanvasFailed("the stage lost its context");
      void invoke("render_report_gpu_event", { reason: "contextLost", deliberate: false }).catch(
        () => {},
      );
    });
    return () => {
      mounted = false;
      stopLossReports();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <StageView stageRole="render" frameloop="never" dpr={1} />
    </div>
  );
}
