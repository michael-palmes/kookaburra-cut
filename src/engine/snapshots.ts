import { invoke } from "@tauri-apps/api/core";
import { awaitEmojiRastersIdle } from "../toolkit/text/emojiRaster";
import { awaitVideoFramesReady } from "./clips";
import { NO_SHUTTER, useClockStore } from "./clock";
import { downscaleRgba } from "./downscale";
import {
  canvasCommittedClockMs,
  canvasCommittedProject,
  canvasCommittedShutterSeq,
  canvasHandle,
  setCapturingPreview,
} from "./exportBridge";
import { awaitTextSync } from "./exporter";
import { isExporting } from "./exportState";
import { hideGizmoHandles } from "./gizmoRegistry";
import { type LoadedProject, nativeProjectSlug, parseProjectId } from "./project";
import { assertContextHeld, readFrameOrThrow } from "./readback";
import { stage } from "./stageHandle";
import { isStageWorker } from "./stageRealm";

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
      setTimeout(poll, 32);
    };
    poll();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Borrows the preview clock for one or more captures: guards re-entrancy and exports, runs `fn`, then gives the scrub position back, but only while the clock still sits on this capture's own last seek. If anything else wrote it mid-capture (an export took it and writing would poison the run, the post-add focus seek landed, the user scrubbed), the newer position wins. Returns null when capture isn't possible right now. */
export async function withBorrowedClock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (capturing || isExporting() || !stageReady()) return null;
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
  isCurrent: () => boolean = () => true,
): Promise<Uint8Array | null> {
  if (!isCurrent()) return null;
  const clock = useClockStore.getState();
  clock.setCurrentMs(tMs);
  if (clock.shutter !== NO_SHUTTER) clock.setShutter(NO_SHUTTER);
  noteBorrowedSeek(tMs);
  // From a window the stage paints and encodes; the clock write above reaches it through the mirror before the request.
  if (!isStageWorker()) {
    const bytes = await stage().snapshot(tMs, width, format);
    return isCurrent() ? bytes : null;
  }
  return snapshotRun(tMs, width, format, isCurrent);
}

/** True once a stage (or this realm's own canvas) can paint. */
function stageReady(): boolean {
  if (isStageWorker()) return !!canvasHandle.current;
  try {
    stage();
    return true;
  } catch {
    return false;
  }
}

/** The stage worker's capture: waits for the tree to commit `tMs` (null: paint what is there), settles streamed textures and text, paints one preview frame with the gizmos hidden and encodes the downscaled buffer. */
export async function snapshotRun(
  tMs: number | null,
  width: number,
  format: "png" | "jpeg",
  isCurrent: () => boolean = () => true,
): Promise<Uint8Array | null> {
  if (tMs === null) return paintAndReadCanvas(width, format);
  const shutterSeq = useClockStore.getState().shutterSeq;
  // A paused blur pass can leave objects mid-shutter at this same instant, where the clock stamp alone is already current.
  const committed = () =>
    canvasCommittedClockMs() === tMs && canvasCommittedShutterSeq() === shutterSeq;
  if (!(await waitFor(committed, 1000))) return null;
  // The commit stamp is the React commit; clip textures stream in asynchronously, so give them a settle beat.
  await delay(200);
  if (isExporting() || !canvasHandle.current || !isCurrent()) return null;
  // Text meshes freshly committed by this seek (a theme's font swap, a scene first entered here) may still be typesetting; headless windows never fire rAF, so nothing else kicks or completes them and a lone forced paint reads glyphs one capture late (the invisible-Playfair-title theme-preview bug). Kick and await quiescence exactly like the export loop, then give onSync-driven commits (mask-reveal bounds) a beat to land.
  await awaitVideoFramesReady(canvasHandle.current.scene);
  if (isExporting() || !canvasHandle.current || !isCurrent()) return null;
  await awaitTextSync(canvasHandle.current.scene);
  await awaitEmojiRastersIdle();
  await delay(50);
  if (isExporting() || !canvasHandle.current || !isCurrent()) return null;
  // Then force one synchronous preview render; the on-demand GL render is normally rAF-driven and WKWebView suspends rAF for occluded windows (the AFK lesson), so a headless `kookaburra:run --action theme-previews` would otherwise capture a stale buffer.
  return paintAndReadCanvas(width, format);
}

/** Force one synchronous render and box-filter the preserved GL buffer down to a PNG/JPEG. Throws rather than encode a frame the GPU never delivered (`readFrameOrThrow`: a lost context, or an all-zero readback from a GPU process stalled past WebKit's sync-IPC timeout, which left the black chart and aurora cards). */
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

  const gl = canvasHandle.current.gl.getContext();
  const srcWidth = gl.drawingBufferWidth;
  const srcHeight = gl.drawingBufferHeight;
  const scale = Math.min(1, width / Math.max(1, srcWidth));
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(srcWidth * scale));
  target.height = Math.max(1, Math.round(srcHeight * scale));
  const ctx = target.getContext("2d");
  if (!ctx) return null;
  // Read the preserved buffer back like the export does and box-filter it in JS: a one-step drawImage shrink aliased thin lines into dashes.
  const rgba = new Uint8Array(srcWidth * srcHeight * 4);
  const where = `preview capture ${srcWidth}x${srcHeight}`;
  readFrameOrThrow(gl, srcWidth, srcHeight, rgba, where);
  const pixels = downscaleRgba(rgba, srcWidth, srcHeight, target.width, target.height, true);
  ctx.putImageData(new ImageData(pixels, target.width, target.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    format === "jpeg"
      ? target.toBlob(resolve, "image/jpeg", 0.85)
      : target.toBlob(resolve, "image/png"),
  );
  if (!blob) return null;
  // The encode is GPU-process work too, so a relaunch during it voids the tile.
  assertContextHeld(gl, where);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Captures the canvas as it is right now, no clock write, no seek, no borrow (the Scene-tab header preview's fallback when no cached thumb exists). Because nothing touches the playhead, the clock-borrow blip class can't occur; the export guards still apply. Null when capture isn't possible right now. */
export async function captureCurrentFrame(width: number): Promise<Uint8Array | null> {
  if (capturing || isExporting() || !stageReady()) return null;
  if (!isStageWorker()) {
    return stage()
      .snapshot(null, width, "jpeg")
      .catch((e) => {
        console.warn("[snapshot] capture failed:", e);
        return null;
      });
  }
  return paintAndReadCanvas(width, "jpeg").catch((e) => {
    console.warn("[snapshot] capture failed:", e);
    return null;
  });
}

export interface SnapshotSaved {
  projectId: string;
  path: string;
  mtimeMs: number | null;
}

export function canCaptureSnapshot(projectId: string): boolean {
  const { scope } = parseProjectId(projectId);
  return scope === "workspace";
}

/** Saves a representative frame to the project's snapshot or the library item's authoritative poster. */
export async function captureSnapshot(
  project: LoadedProject,
  onSaved?: (snapshot: SnapshotSaved) => void,
): Promise<boolean> {
  if (!canCaptureSnapshot(project.id)) return false;
  const isCurrent = () => canvasCommittedProject() === project;
  if (!isCurrent()) return false;
  const slug = nativeProjectSlug(project.id);
  const written = await withBorrowedClock(async () => {
    const bytes = await captureFrameAt(
      Math.round(project.totalMs * SNAPSHOT_POINT),
      SNAPSHOT_WIDTH,
      "png",
      isCurrent,
    );
    if (!bytes || !isCurrent() || isExporting()) return false;
    const saved = await invoke<Omit<SnapshotSaved, "projectId">>("write_snapshot", bytes, {
      headers: { "x-kookaburra-slug": slug },
    });
    onSaved?.({ projectId: project.id, ...saved });
    return true;
  }).catch((e) => {
    console.warn("[snapshot] capture failed:", e);
    return false;
  });
  return written ?? false;
}
