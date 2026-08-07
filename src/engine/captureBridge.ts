import { invoke } from "@tauri-apps/api/core";
import { useClockStore } from "./clock";
import { isExporting } from "./exportState";
import type { FormatSpec } from "./format";
import type { LoadedProject } from "./project";

/** The editor's half of the capture bridge (src-tauri/src/bridge.rs). Captures are served by the hidden render window (src/render/bridgeService.ts), never on the editor's canvas; this side only watches for pending requests, pushes the editor context the service needs (open project, aspect, playhead, export lockout) and ensures the window exists. Chrome-side polling is the fingerprint-poll precedent; scene code never runs wall-clock timers. */

/** One poll tick: cheap no-op (one file count) until a request is actually pending. */
export async function ensureCaptureService(ctx: {
  project: LoadedProject | null;
  format: FormatSpec;
  exporting: boolean;
}): Promise<void> {
  let pending = 0;
  try {
    pending = await invoke<number>("bridge_pending_count");
  } catch {
    return;
  }
  if (pending === 0) return;
  // Context first, ensure second: a freshly created window must never claim before the context lands.
  await invoke("set_editor_context", {
    context: {
      projectId: ctx.project?.id ?? null,
      aspect: ctx.format.name,
      currentMs: useClockStore.getState().currentMs,
      exportLocked: ctx.exporting || isExporting(),
    },
  }).catch((e) => console.warn("[bridge] context push failed:", e));
  await invoke("ensure_render_window").catch((e) =>
    console.warn("[bridge] ensure render window failed:", e),
  );
}
