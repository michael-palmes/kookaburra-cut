import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { invalidateChangedClips } from "../engine/clips";
import { captureFrameRgba } from "../engine/exporter";
import { type AspectName, FORMATS, type FormatSpec, FPS } from "../engine/format";
import { libraryPreviewFormat } from "../engine/libraryPreviewPoint";
import {
  clearRenderErrors,
  projectRenderErrors,
  type SceneLoadError,
} from "../engine/loadDiagnostics";
import { insertPresetScene } from "../engine/presetInsert";
import { listAllPresets, refreshUserPresets } from "../engine/presets";
import {
  bumpWorkspaceReloadToken,
  isEditableProjectId,
  isWorkspaceBackedProjectId,
  isWorkspaceProjectId,
  type LoadedProject,
  loadProject,
  nativeProjectSlug,
  projectIdForNativeSlug,
  refreshBundledProjectAssets,
  sceneFileStem,
} from "../engine/project";
import { setProjectAssetRevision } from "../engine/projectAssetRevision";
import { awaitProjectCommitted } from "../engine/themePreviews";
import { serveFontsRequest } from "./bridgeFonts";
import {
  BRIDGE_KINDS,
  type BridgeRequest,
  buildCheckReport,
  type CheckAsset,
  collectAssetRefs,
  frameScene,
  requestFormat,
  requestFrames,
  resolvePresetRef,
  responseVersion,
  trustDeniedSlug,
  trustSentence,
} from "./bridgeRequests";
import { ContactSheet } from "./contactSheet";

/** The render window's half of the bridge (docs/agent-kit.md, "The bridge (v2)"): claim one request per tick, load (or reload) the target project into this window's own canvas and serve it (capture, check, fonts, insertPreset) through the deterministic export path, all without touching the editor realm. The editor's open project loads under the editor's session trust; any other loads stored-only and never prompts here. Playhead captures (no scene) need the editor's open project, whose id/aspect/playhead arrive via the pushed editor context. Idle ticks drain the thumb queue instead (fast tier: same path, small buffer), parked while the editor is playing. */

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
  contentRevision: string;
  atMs: number | null;
  slot: number;
  sceneFile: string;
  aspect: AspectName;
}

const BRIDGE_COMMANDS = { begin: "begin_bridge_screenshot", save: "save_bridge_screenshot" };

/** Fast-tier thumb width; matches the legacy preview-canvas thumbs. */
const THUMB_WIDTH = 640;

const smallFormat = (format: FormatSpec): FormatSpec => ({
  name: format.name,
  width: THUMB_WIDTH,
  height: Math.round((THUMB_WIDTH * format.height) / format.width / 2) * 2,
});

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

  /** The editor's open project runs under its session trust (the re-stamp the editor's own reload makes); anything else loads stored-only, so this window never shows a trust prompt. */
  const loadForBridge = async (targetId: string): Promise<LoadedProject> => {
    if (isWorkspaceBackedProjectId(targetId)) {
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      if (context?.projectId === targetId) {
        await invoke("trust_project", { slug: nativeProjectSlug(targetId) }).catch(() => {});
      }
    }
    return loadProject(targetId, { trustMode: "stored-only" });
  };

  /** Load (or reload) `targetId` unless the mounted tree already holds these sources (an unreadable fingerprint proves nothing, so it reloads). A load never depends on the aspect, so a format change re-applies the same load under a fresh identity: errored scene boundaries retry and the project stamp is the commit barrier. */
  const ensureLoaded = async (
    targetId: string,
    format: FormatSpec,
    sourceRevision?: string,
  ): Promise<LoadedProject> => {
    const editable = isEditableProjectId(targetId);
    const fingerprint =
      sourceRevision ??
      (editable
        ? await invoke<string>("project_fingerprint", { slug: nativeProjectSlug(targetId) }).catch(
            () => null,
          )
        : null);
    if (
      current?.project.id === targetId &&
      current.fingerprint === fingerprint &&
      (fingerprint !== null || !editable)
    ) {
      if (current.formatName !== format.name) {
        const project = { ...current.project };
        current = null;
        apply(project, format);
        await awaitProjectCommitted(project);
        current = { project, fingerprint, formatName: format.name };
      }
    } else {
      if (sourceRevision) {
        setProjectAssetRevision(targetId, sourceRevision);
        await refreshBundledProjectAssets(targetId);
        await invalidateChangedClips();
      }
      bumpWorkspaceReloadToken();
      const loaded = sourceRevision
        ? await loadProject(targetId, { trustMode: "stored-only", readSavedThemes: true })
        : await loadForBridge(targetId);
      apply(loaded, format);
      await awaitProjectCommitted(loaded);
      current = { project: loaded, fingerprint, formatName: format.name };
    }
    return current.project;
  };

  const contextFormat = (context: EditorContext | null): FormatSpec =>
    FORMATS[(context?.aspect ?? "16:9") as AspectName] ?? FORMATS["16:9"];

  const respond = (request: BridgeRequest, body: Record<string, unknown>) =>
    invoke("bridge_write_response", {
      id: request.id,
      jsonText: JSON.stringify({ version: responseVersion(request), id: request.id, ...body }),
    }).catch((e) => console.warn("[render-bridge] response write failed:", e));

  const serveCapture = async (request: BridgeRequest, context: EditorContext | null) => {
    const targetId = request.project ?? context?.projectId ?? null;
    if (!targetId) {
      await respond(request, {
        ok: false,
        error:
          "no project is open in Kookaburra Cut; open one (or pass --scene with an explicit project) and retry",
      });
      return;
    }
    const frames = requestFrames(request);
    const isOpen = targetId === context?.projectId;
    if (!isOpen && frames.some((frame) => frame.scene === null)) {
      await respond(request, {
        ok: false,
        error: `requested project "${targetId}" isn't open (currently open: "${context?.projectId ?? "none"}"); playhead captures need the open project, or pass --scene to capture any project`,
      });
      return;
    }
    const format = requestFormat(request.aspect, context?.aspect);
    const project = await ensureLoaded(targetId, format);
    const sheet = request.sheet
      ? new ContactSheet(frames.length, format.width, format.height)
      : null;
    const shots: { scene: string; at: number; tMs: number; path: string; index: number }[] = [];
    for (const [n, frame] of frames.entries()) {
      const tMs = resolveScreenshotTimeMs(
        project,
        frame.scene ?? undefined,
        frame.at ?? undefined,
        isOpen ? context?.currentMs : undefined,
      );
      const { rgba, width, height } = await captureFrameRgba(exportOptions(project, format), tMs);
      await invoke(BRIDGE_COMMANDS.begin, {
        width,
        height,
        name: n === 0 ? request.id : `${request.id}-${n}`,
      });
      const path = await invoke<string>(BRIDGE_COMMANDS.save, rgba);
      const where = frameScene(project, frame.scene, tMs);
      sheet?.draw(
        n,
        rgba,
        width,
        height,
        `${where.index}  ${where.scene}  @ ${where.at.toFixed(2)}s`,
      );
      shots.push({
        scene: where.scene,
        at: where.at,
        tMs: Math.round(tMs),
        path,
        index: where.index,
      });
    }
    let sheetPath: string | undefined;
    if (sheet) {
      const png = await sheet.png();
      if (!png) throw new Error("could not encode the contact sheet");
      sheetPath = await invoke<string>("bridge_write_sheet", png, {
        headers: { "x-kookaburra-id": request.id },
      });
    }
    await respond(request, {
      ok: true,
      path: shots[0].path,
      paths: shots.map((shot) => shot.path),
      frames: shots,
      ...(sheetPath ? { sheetPath } : {}),
      project: project.id,
      tMs: shots[0].tMs,
      format: format.name,
      // Provenance for hash disputes: this surface is visually exact but not hash-exact against the cold-boot screenshot (docs/determinism.md).
      surface: "render-window",
    });
  };

  const serveCheck = async (request: BridgeRequest, context: EditorContext | null) => {
    const targetId = request.project ?? context?.projectId ?? null;
    if (!targetId) {
      await respond(request, {
        ok: false,
        error: "no project is open in Kookaburra Cut; pass a project",
      });
      return;
    }
    const format = requestFormat(request.aspect, context?.aspect);
    let project: LoadedProject;
    try {
      project = await ensureLoaded(targetId, format);
    } catch (e) {
      if (trustDeniedSlug(e)) throw e;
      current = null;
      await respond(request, {
        ok: false,
        error: String(e),
        project: targetId,
        scenes: [],
        fonts: [],
        assets: [],
        warnings: [],
        rendered: false,
      });
      return;
    }
    let assets: CheckAsset[] = [];
    if (isWorkspaceBackedProjectId(project.id)) {
      const paths = [
        ...new Set(
          [...project.sceneDocs, ...project.compareBDocs].flatMap((doc) => collectAssetRefs(doc)),
        ),
      ];
      if (paths.length > 0) {
        assets = await invoke<CheckAsset[]>("bridge_check_assets", {
          slug: nativeProjectSlug(project.id),
          paths,
        });
      }
    }
    const renderErrors: SceneLoadError[] = [];
    if (request.render) {
      clearRenderErrors(project.id);
      for (const [index, slot] of project.slots.entries()) {
        try {
          await captureFrameRgba(
            exportOptions(project, smallFormat(format)),
            Math.round(slot.startMs + slot.durationMs / 2),
          );
        } catch (e) {
          renderErrors.push({
            index,
            file: project.sceneFiles[index] ?? "",
            phase: "render",
            message: String(e),
          });
        }
      }
      renderErrors.push(...projectRenderErrors(project.id));
    }
    const report = buildCheckReport({ project, renderErrors, assets });
    await respond(request, { ...report, project: project.id, rendered: Boolean(request.render) });
  };

  const serveInsertPreset = async (request: BridgeRequest, context: EditorContext | null) => {
    const targetId = request.project ?? context?.projectId ?? null;
    if (!targetId || !isWorkspaceProjectId(targetId)) {
      await respond(request, {
        ok: false,
        error: "insertPreset needs a workspace project (ws:<folder>)",
      });
      return;
    }
    if (!request.preset?.trim()) {
      await respond(request, { ok: false, error: "insertPreset needs a preset" });
      return;
    }
    await refreshUserPresets().catch(() => []);
    const entry = resolvePresetRef(request.preset, listAllPresets());
    if (!entry) {
      await respond(request, {
        ok: false,
        error: `no scene preset "${request.preset}"; \`kb presets\` lists them`,
      });
      return;
    }
    if (entry.sceneCount !== 1) {
      await respond(request, { ok: false, error: `preset "${entry.name}" isn't a single scene` });
      return;
    }
    const destSlug = nativeProjectSlug(targetId);
    // An app write into a project the user had allowed keeps it allowed; the open project re-stamps on the editor's own reload.
    const keepTrust =
      targetId !== context?.projectId &&
      (await invoke<boolean>("is_project_trusted", { slug: destSlug }).catch(() => false));
    const inserted = await insertPresetScene({
      destSlug,
      presetProjectId: entry.projectId,
      position: request.position ?? undefined,
      name: request.name?.trim() || undefined,
      trustMode: "stored-only",
    });
    if (keepTrust) await invoke("trust_project", { slug: destSlug }).catch(() => {});
    await respond(request, {
      ok: true,
      project: targetId,
      preset: entry.projectId,
      file: inserted.file,
      index: inserted.index,
      id: inserted.sceneId,
      name: inserted.name ?? request.name?.trim() ?? entry.name,
    });
  };

  const serveRequest = async (request: BridgeRequest): Promise<void> => {
    const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
    const kind = request.kind ?? "capture";
    try {
      if (kind !== "fonts" && context?.exportLocked) {
        await respond(request, {
          ok: false,
          busy: true,
          error: "Kookaburra Cut is exporting right now; retry shortly",
        });
        return;
      }
      switch (kind) {
        case "capture":
          return await serveCapture(request, context);
        case "check":
          return await serveCheck(request, context);
        case "fonts": {
          const result = await serveFontsRequest({
            refs: request.refs ?? undefined,
            listFamilies: request.listFamilies ?? undefined,
          });
          await respond(request, { ok: false, ...result });
          return;
        }
        case "insertPreset":
          return await serveInsertPreset(request, context);
        default:
          await respond(request, {
            ok: false,
            error: `unknown request kind "${kind}"; this app serves ${BRIDGE_KINDS.join(", ")}`,
          });
      }
    } catch (e) {
      // A failed load poisons nothing: drop the cached project so the next request reloads cold.
      current = null;
      const denied = trustDeniedSlug(e);
      await respond(
        request,
        denied
          ? { ok: false, needsTrust: true, error: trustSentence(denied) }
          : { ok: false, error: String(e) },
      );
    }
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
      const thumbFormat = smallFormat(format);
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

  const servePresetPoster = async (
    context: EditorContext | null,
    priorityOnly = false,
  ): Promise<boolean> => {
    if (!context || context.exportLocked || context.playing) return false;
    const take = await invoke<PresetPosterTake | null>("render_take_preset_poster", {
      priorityOnly,
    });
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
        take.contentRevision,
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
      await serveRequest(request);
      return;
    }
    // Drain the whole thumb queue in one tick: the claim interval is timer-clamped (~2s hidden), so a job-per-tick cadence would stack seconds of idle wait between thumbs. Context re-reads keep the playback/export parking live mid-drain, and a capture request arriving mid-drain takes over.
    for (;;) {
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      if (
        !(await servePresetPoster(context, true)) &&
        !(await serveThumb(context)) &&
        !(await servePresetPoster(context))
      )
        return;
      const next = await invoke<BridgeRequest | null>("bridge_claim_request").catch(() => null);
      if (next) {
        await serveRequest(next);
        return;
      }
    }
  };

  let stopped = false;
  const run = () => {
    if (busy || stopped) return;
    busy = true;
    void tick().finally(() => {
      busy = false;
    });
  };
  const listening = listen("kookaburra://library-preview-queued", run);
  void listening.then(run).catch(() => {});
  const timer = window.setInterval(run, 1000);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    void listening.then((unlisten) => unlisten()).catch(() => {});
  };
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
