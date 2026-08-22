import { invoke } from "@tauri-apps/api/core";
import { useClockStore } from "./clock";
import { canvasCommittedClockMs, canvasHandle, setCapturingPreview } from "./exportBridge";
import { awaitTextSync } from "./exporter";
import { isExporting } from "./exportState";
import { hideGizmoHandles } from "./gizmoRegistry";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "./project";

/** Preview-frame capture off the live canvas, used by welcome snapshots and scene thumbs. UI niceties, not part of the export path: nothing here runs during an export/autorun, every failure is silent (cards keep their placeholders), and the determinism contract is untouched (the preview clock is borrowed and restored). */

/** Representative moment for the welcome card: in far enough for content, before any outro. */
const SNAPSHOT_POINT = 0.38;
const SNAPSHOT_WIDTH = 640;

let capturing = false;
let lastSeekMs: number | null = null;

/** Records a clock write made under the borrowed clock, so the restore can tell this capture's own seeks from someone else's write. Called by `captureFrameAt`; exported for tests. */
export function noteBorrowedSeek(tMs: number): void {
  lastSeekMs = tMs;
}

/** Timer-based wait (never rAF; WKWebView suspends rAF when occluded). */
function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - startedAt > timeoutMs) return resolve(false);
      window.setTimeout(poll, 32);
    };
    poll();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Borrows the preview clock for one or more captures: guards re-entrancy and exports, runs `fn`, then gives the scrub position back, but only while the clock still sits on this capture's own last seek. If anything else wrote it mid-capture (an export took it and writing would poison the run, the post-add focus seek landed, the user scrubbed), the newer position wins. Returns null when capture isn't possible right now. */
export async function withBorrowedClock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (capturing || isExporting() || !canvasHandle.current) return null;
  const prevMs = useClockStore.getState().currentMs;
  capturing = true;
  lastSeekMs = null;
  try {
    return await fn();
  } finally {
    const cur = useClockStore.getState().currentMs;
    if (!isExporting() && lastSeekMs !== null && cur === lastSeekMs) {
      useClockStore.getState().setCurrentMs(prevMs);
    }
    capturing = false;
  }
}

/** Seeks to `tMs`, waits for the canvas tree to commit (plus a settle beat for streamed-in textures), and downscales the preserved GL buffer to a PNG, or a JPEG when `format` says so (theme previews use JPEG to stay small). Caller must hold the borrowed clock (`withBorrowedClock`); worst case the frame is slightly stale, which only affects card art. */
export async function captureFrameAt(
  tMs: number,
  width: number,
  format: "png" | "jpeg" = "png",
): Promise<Uint8Array | null> {
  const clock = useClockStore.getState();
  clock.setCurrentMs(tMs);
  noteBorrowedSeek(tMs);
  if (!(await waitFor(() => canvasCommittedClockMs() === tMs, 1000))) return null;
  // The commit stamp is the React commit; clip textures stream in asynchronously, so give them a settle beat.
  await delay(200);
  if (isExporting() || !canvasHandle.current) return null;
  // Text meshes freshly committed by this seek (a theme's font swap, a scene first entered here) may still be typesetting; headless windows never fire rAF, so nothing else kicks or completes them and a lone forced paint reads glyphs one capture late (the invisible-Playfair-title theme-preview bug). Kick and await quiescence exactly like the export loop, then give onSync-driven commits (mask-reveal bounds) a beat to land.
  await awaitTextSync(canvasHandle.current.scene);
  await delay(50);
  if (isExporting() || !canvasHandle.current) return null;
  // Then force one synchronous preview render; the on-demand GL render is normally rAF-driven and WKWebView suspends rAF for occluded windows (the AFK lesson), so a headless `kookaburra:run --action theme-previews` would otherwise capture a stale buffer.
  return paintAndReadCanvas(width, format);
}

/** Force one synchronous render and downscale the preserved GL buffer to PNG/JPEG. */
async function paintAndReadCanvas(
  width: number,
  format: "png" | "jpeg",
): Promise<Uint8Array | null> {
  if (!canvasHandle.current) return null;
  // Editor chrome must not bake into a cached thumb or welcome card: the outlines and light helpers ride HELPER_LAYER (dropped from the camera for this frame), the gizmo handles draw on layer 0 and are hidden outright.
  const restoreGizmos = hideGizmoHandles();
  setCapturingPreview(true);
  try {
    canvasHandle.current.advance(performance.now());
  } finally {
    setCapturingPreview(false);
    restoreGizmos();
  }

  const source = canvasHandle.current.gl.domElement;
  const scale = Math.min(1, width / Math.max(1, source.width));
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const ctx = target.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    format === "jpeg"
      ? target.toBlob(resolve, "image/jpeg", 0.85)
      : target.toBlob(resolve, "image/png"),
  );
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Captures the canvas as it is right now, no clock write, no seek, no borrow (the Scene-tab header preview's fallback when no cached thumb exists). Because nothing touches the playhead, the clock-borrow blip class can't occur; the export guards still apply. Null when capture isn't possible right now. */
export async function captureCurrentFrame(width: number): Promise<Uint8Array | null> {
  if (capturing || isExporting() || !canvasHandle.current) return null;
  return paintAndReadCanvas(width, "jpeg");
}

/** Welcome-card snapshot: one representative frame to `.kookaburra/snapshots/<slug>.png`; returns whether a snapshot was written. */
export async function captureSnapshot(project: LoadedProject): Promise<boolean> {
  if (!isWorkspaceProjectId(project.id)) return false;
  const slug = workspaceSlug(project.id);
  const written = await withBorrowedClock(async () => {
    const bytes = await captureFrameAt(
      Math.round(project.totalMs * SNAPSHOT_POINT),
      SNAPSHOT_WIDTH,
    );
    if (!bytes) return false;
    await invoke("write_snapshot", bytes, { headers: { "x-kookaburra-slug": slug } });
    return true;
  }).catch((e) => {
    console.warn("[snapshot] capture failed:", e);
    return false;
  });
  return written ?? false;
}
