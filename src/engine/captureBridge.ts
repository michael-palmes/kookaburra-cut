import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../store/editorStore";
import { resolveScreenshotTimeMs } from "./autorun";
import { useClockStore } from "./clock";
import { captureScreenshot } from "./exporter";
import { isExporting } from "./exportState";
import { FPS } from "./format";
import type { LoadedProject } from "./project";

/** The frontend half of the capture bridge (src-tauri/src/bridge.rs): claim one request per tick, answer it from the RUNNING app via the deterministic export path, and always respond so `capture.py` never waits out a claimed request. Chrome-side polling is the fingerprint-poll precedent; scene code never runs wall-clock timers. */

interface BridgeRequest {
  version: number;
  id: string;
  project?: string | null;
  scene?: string | null;
  at?: number | null;
  requestedAtMs: number;
}

const BRIDGE_COMMANDS = { begin: "begin_bridge_screenshot", save: "save_bridge_screenshot" };

/** One poll tick. `setExporting` toggles App's LOCAL exporting state (the Export button's), standing the interactive preview loop down for the capture's duration; a plain `isExporting()` guard would leave the preview's own renders racing the capture's GL state. */
export async function pollCaptureBridge(ctx: {
  project: LoadedProject | null;
  exporting: boolean;
  setExporting: (v: boolean) => void;
}): Promise<void> {
  let request: BridgeRequest | null = null;
  try {
    request = await invoke<BridgeRequest | null>("bridge_claim_request");
  } catch {
    return;
  }
  if (!request) return;
  const id = request.id;
  const respond = (body: Record<string, unknown>) =>
    invoke("bridge_write_response", {
      id,
      jsonText: JSON.stringify({ version: 1, id, ...body }),
    }).catch((e) => console.warn("[bridge] response write failed:", e));

  const project = ctx.project;
  if (!project) {
    await respond({ ok: false, error: "no project is open in Kookaburra Cut; open one and retry" });
    return;
  }
  const wanted = request.project ?? undefined;
  if (wanted && wanted !== project.id) {
    await respond({
      ok: false,
      error: `requested project "${wanted}" isn't open (currently open: "${project.id}"); open it in Kookaburra Cut and retry`,
    });
    return;
  }
  if (ctx.exporting || isExporting()) {
    await respond({
      ok: false,
      busy: true,
      error: "Kookaburra Cut is exporting right now; retry shortly",
    });
    return;
  }

  try {
    const tMs = resolveScreenshotTimeMs(
      project,
      request.scene ?? undefined,
      request.at ?? undefined,
      useClockStore.getState().currentMs,
    );
    const format = useEditorStore.getState().format;
    ctx.setExporting(true);
    let path: string;
    try {
      path = await captureScreenshot(
        {
          projectId: project.id,
          fps: FPS,
          durationMs: project.totalMs,
          slots: project.slots,
          cameraTrack: project.cameraTrack,
          sceneDocs: project.sceneDocs,
          theme: project.theme,
          sceneThemes: project.sceneThemes,
          projectLighting: project.projectLighting,
          sceneFrames: project.sceneFrames,
          compareBDocs: project.compareBDocs,
          compareBThemes: project.compareBThemes,
          codec: "libx264",
          format,
        },
        tMs,
        id,
        BRIDGE_COMMANDS,
      );
    } finally {
      ctx.setExporting(false);
    }
    await respond({
      ok: true,
      path,
      project: project.id,
      tMs: Math.round(tMs),
      format: format.name,
    });
  } catch (e) {
    await respond({ ok: false, error: String(e) });
  }
}
