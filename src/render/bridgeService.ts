import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { invalidateChangedClips } from "../engine/clips";
import { awaitSceneHostsCommitted, captureFrameRgba, captureScreenshot } from "../engine/exporter";
import { type AspectName, FORMATS, type FormatSpec, FPS } from "../engine/format";
import { libraryPreviewFormat } from "../engine/libraryPreviewPoint";
import {
  bumpWorkspaceReloadToken,
  isEditableProjectId,
  type LoadedProject,
  loadProject,
  nativeProjectSlug,
  projectIdForNativeSlug,
  refreshBundledProjectAssets,
  sceneFileStem,
} from "../engine/project";
import { setProjectAssetRevision } from "../engine/projectAssetRevision";
import { awaitProjectCommitted } from "../engine/themePreviews";

/** The render window's half of the capture bridge: claim one request per tick, load (or reload) the target project into this window's own canvas, render the frame through the deterministic export path and respond, all without touching the editor realm. Requests with an explicit --scene may target any project on disk; playhead requests (no scene) need the editor's open project, whose id/aspect/playhead arrive via the pushed editor context. Idle ticks drain the thumb queue instead (fast tier: same path, small buffer), parked while the editor is playing. */

interface BridgeRequest {
  version: number;
  id: string;
  project?: string | null;
  scene?: string | null;
  at?: number | null;
  requestedAtMs: number;
}

/** Mirror of bridge.rs's EditorContext. */
interface EditorContext {
  projectId: string | null;
  aspect: string;
  currentMs: number;
  exportLocked: boolean;
  playing: boolean;
}

/** Mirror of render_win.rs's ThumbTake. */
interface ThumbTake {
  slug: string;
  generation: number;
  stem: string;
  stamp: string;
  remaining: number;
}

interface PresetPosterTake {
  slug: string;
  revision: string;
  atMs: number | null;
  slot: number;
  sceneFile: string;
  aspect: AspectName;
}

const BRIDGE_COMMANDS = { begin: "begin_bridge_screenshot", save: "save_bridge_screenshot" };

/** Fast-tier thumb width; matches the legacy preview-canvas thumbs. */
const THUMB_WIDTH = 640;

interface LoadedState {
  project: LoadedProject;
  fingerprint: string | null;
  formatName: string;
}

/** Starts the claim loop; returns its stop function. `apply` lands a loaded project in this window's stores and React tree (RenderApp owns that state). */
export function startBridgeService(
  apply: (loaded: LoadedProject, format: FormatSpec) => void,
): () => void {
  let busy = false;
  let current: LoadedState | null = null;
  const ready = invoke("render_reset_preset_posters");

  /** Load (or reload) `targetId` at `format` unless the mounted tree is already exactly that. */
  const ensureLoaded = async (
    targetId: string,
    format: FormatSpec,
    sourceRevision?: string,
  ): Promise<LoadedProject> => {
    const fingerprint =
      sourceRevision ??
      (isEditableProjectId(targetId)
        ? await invoke<string>("project_fingerprint", { slug: nativeProjectSlug(targetId) }).catch(
            () => null,
          )
        : null);
    if (
      !current ||
      current.project.id !== targetId ||
      current.fingerprint !== fingerprint ||
      current.formatName !== format.name
    ) {
      if (sourceRevision) {
        setProjectAssetRevision(targetId, sourceRevision);
        await refreshBundledProjectAssets(targetId);
        await invalidateChangedClips();
      }
      bumpWorkspaceReloadToken();
      const loaded = sourceRevision
        ? await loadProject(targetId, { trustMode: "stored-only", readSavedThemes: true })
        : await loadProject(targetId);
      apply(loaded, format);
      await awaitProjectCommitted(loaded);
      await awaitSceneHostsCommitted(loaded.slots.length);
      current = { project: loaded, fingerprint, formatName: format.name };
    }
    return current.project;
  };

  const contextFormat = (context: EditorContext | null): FormatSpec =>
    FORMATS[(context?.aspect ?? "16:9") as AspectName] ?? FORMATS["16:9"];

  const serveCapture = async (request: BridgeRequest): Promise<boolean> => {
    const id = request.id;
    const respond = (body: Record<string, unknown>) =>
      invoke("bridge_write_response", {
        id,
        jsonText: JSON.stringify({ version: 1, id, ...body }),
      }).catch((e) => console.warn("[render-bridge] response write failed:", e));

    try {
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      if (context?.exportLocked) {
        await respond({
          ok: false,
          busy: true,
          error: "Kookaburra Cut is exporting right now; retry shortly",
        });
        return true;
      }
      const targetId = request.project ?? context?.projectId ?? null;
      if (!targetId) {
        await respond({
          ok: false,
          error:
            "no project is open in Kookaburra Cut; open one (or pass --scene with an explicit project) and retry",
        });
        return true;
      }
      if (!request.scene && targetId !== context?.projectId) {
        await respond({
          ok: false,
          error: `requested project "${targetId}" isn't open (currently open: "${context?.projectId ?? "none"}"); playhead captures need the open project, or pass --scene to capture any project`,
        });
        return true;
      }

      const format = contextFormat(context);
      const project = await ensureLoaded(targetId, format);
      const tMs = resolveScreenshotTimeMs(
        project,
        request.scene ?? undefined,
        request.at ?? undefined,
        targetId === context?.projectId ? context.currentMs : undefined,
      );
      const path = await captureScreenshot(
        exportOptions(project, format),
        tMs,
        id,
        BRIDGE_COMMANDS,
      );
      await respond({
        ok: true,
        path,
        project: project.id,
        tMs: Math.round(tMs),
        format: format.name,
        // Provenance for hash disputes: this surface is visually exact but not hash-exact against the cold-boot screenshot (docs/determinism.md).
        surface: "render-window",
      });
    } catch (e) {
      // A failed load poisons nothing: drop the cached project so the next request reloads cold.
      current = null;
      await respond({ ok: false, error: String(e) });
    }
    return true;
  };

  const serveThumb = async (context: EditorContext | null): Promise<boolean> => {
    if (context?.exportLocked || context?.playing) return false;
    const take = await invoke<ThumbTake | null>("render_take_thumb_job").catch(() => null);
    if (!take) return false;
    try {
      const format = contextFormat(context);
      const project = await ensureLoaded(projectIdForNativeSlug(take.slug), format);
      const index = project.sceneFiles.findIndex((f) => sceneFileStem(f) === take.stem);
      const slot = project.slots[index];
      if (!slot) return true;
      const thumbFormat: FormatSpec = {
        name: format.name,
        width: THUMB_WIDTH,
        height: Math.round((THUMB_WIDTH * format.height) / format.width / 2) * 2,
      };
      const tMs = Math.round(slot.startMs + slot.durationMs / 2);
      const { rgba, width, height } = await captureFrameRgba(
        exportOptions(project, thumbFormat),
        tMs,
      );
      const png = await rgbaToPng(rgba, width, height);
      if (!png) return true;
      await invoke("write_scene_thumb", png, {
        headers: {
          "x-kookaburra-slug": take.slug,
          "x-kookaburra-stem": take.stem,
          "x-kookaburra-stamp": take.stamp,
        },
      });
      await emit("kookaburra://thumbs-updated", { slug: take.slug });
    } catch (e) {
      current = null;
      console.warn(`[render-bridge] thumb ${take.slug}/${take.stem} failed:`, e);
    }
    return true;
  };

  const servePresetPoster = async (context: EditorContext | null): Promise<boolean> => {
    if (!context || context.exportLocked || context.playing) return false;
    const take = await invoke<PresetPosterTake | null>("render_take_preset_poster");
    if (!take) return false;
    const finish = (retry: boolean) =>
      invoke<boolean>("render_finish_preset_poster", {
        slug: take.slug,
        revision: take.revision,
        slot: take.slot,
        retry,
      });
    const deferred = async () => {
      const latest = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      return !latest || latest.exportLocked || latest.playing;
    };
    try {
      const format = libraryPreviewFormat(take.aspect);
      const project = await ensureLoaded(
        projectIdForNativeSlug(take.slug),
        FORMATS[take.aspect],
        take.revision,
      );
      const scene = project.sceneFiles.findIndex(
        (file) => file.replace(/^\.\//, "") === take.sceneFile.replace(/^\.\//, ""),
      );
      if (scene < 0) throw new Error("The saved scene was removed. Recapture this slot.");
      if (take.atMs !== null && (take.atMs < 0 || take.atMs > project.slots[scene].durationMs))
        throw new Error("The saved time is outside this scene. Recapture this slot.");
      if (await deferred()) {
        await finish(true);
        return false;
      }
      const tMs = resolveScreenshotTimeMs(
        project,
        String(scene),
        take.atMs == null ? undefined : take.atMs / 1000,
      );
      const { rgba, width, height } = await captureFrameRgba(exportOptions(project, format), tMs);
      const png = await rgbaToPng(rgba, width, height);
      if (!png) throw new Error("could not encode preset poster");
      if (await deferred()) {
        await finish(true);
        return false;
      }
      await invoke("write_preset_poster", png, {
        headers: {
          "x-kookaburra-slug": take.slug,
          "x-kookaburra-revision": take.revision,
          "x-kookaburra-slot": String(take.slot),
        },
      });
    } catch (error) {
      current = null;
      const owned = await finish(false).catch(() => false);
      if (owned)
        await emit("kookaburra://library-preview-failed", {
          projectId: take.slug,
          slot: take.slot,
          error: String(error),
        });
      console.warn(`[render-bridge] preset poster ${take.slug} failed:`, error);
    }
    return true;
  };

  const tick = async (): Promise<void> => {
    await ready;
    let request: BridgeRequest | null = null;
    try {
      request = await invoke<BridgeRequest | null>("bridge_claim_request");
    } catch {
      return;
    }
    if (request) {
      await serveCapture(request);
      return;
    }
    // Drain the whole thumb queue in one tick: the claim interval is timer-clamped (~2s hidden), so a job-per-tick cadence would stack seconds of idle wait between thumbs. Context re-reads keep the playback/export parking live mid-drain, and a capture request arriving mid-drain takes over.
    for (;;) {
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      if (!(await serveThumb(context)) && !(await servePresetPoster(context))) return;
      const next = await invoke<BridgeRequest | null>("bridge_claim_request").catch(() => null);
      if (next) {
        await serveCapture(next);
        return;
      }
    }
  };

  const timer = window.setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => {
      busy = false;
    });
  }, 1000);
  return () => window.clearInterval(timer);
}

function exportOptions(project: LoadedProject, format: FormatSpec) {
  return {
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
    codec: "libx264" as const,
    format,
  };
}

/** GL readback rows are bottom-up; flip while packing into ImageData, then PNG-encode via a scratch 2D canvas (the same encoder the legacy preview-canvas thumbs used; thumbs are stamp-gated, never hash-gated). */
async function rgbaToPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    image.data.set(
      rgba.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes),
      y * rowBytes,
    );
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
