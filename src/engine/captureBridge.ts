import { invoke } from "@tauri-apps/api/core";
import { useClockStore } from "./clock";
import { isExporting } from "./exportState";
import type { FormatSpec } from "./format";
import type { LoadedProject } from "./project";

/** The editor's half of the capture bridge (src-tauri/src/bridge.rs). Captures are served by the hidden render window (src/render/bridgeService.ts), never on the editor's canvas; this side only watches for pending requests, pushes the editor context the service needs (open project, aspect, playhead, export lockout) and ensures the window exists. Chrome-side polling is the fingerprint-poll precedent; scene code never runs wall-clock timers. */

/** One poll tick: push the context (cheap, keeps playback/lockout fresh for a draining thumb queue), then ensure the window only when work is actually pending. Context lands before ensure, so a freshly created window can never claim before it. */
export async function ensureCaptureService(ctx: {
  project: LoadedProject | null;
  format: FormatSpec;
  exporting: boolean;
  playing: boolean;
}): Promise<void> {
  await invoke("set_editor_context", {
    context: {
      projectId: ctx.project?.id ?? null,
      aspect: ctx.format.name,
      currentMs: useClockStore.getState().currentMs,
      exportLocked: ctx.exporting || isExporting(),
      playing: ctx.playing,
    },
  }).catch(() => {});
  const [requests, thumbs] = await Promise.all([
    invoke<number>("bridge_pending_count").catch(() => 0),
    invoke<number>("thumbs_pending_count").catch(() => 0),
  ]);
  if (requests === 0 && thumbs === 0) return;
  await invoke("ensure_render_window").catch((e) =>
    console.warn("[bridge] ensure render window failed:", e),
  );
}
