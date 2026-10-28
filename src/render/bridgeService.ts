import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { projectAssetsStamp, refreshWorkspaceAssets } from "../engine/assetRevisions";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { invalidateChangedClips } from "../engine/clips";
import { canvasHandle } from "../engine/exportBridge";
import { captureFrameRgba } from "../engine/exporter";
import { type AspectName, FORMATS, type FormatSpec, FPS } from "../engine/format";
import { glContextCensus, tagGlCanvas } from "../engine/glContexts";
import { libraryPreviewFormat } from "../engine/libraryPreviewPoint";
import {
  clearRenderErrors,
  projectRenderErrors,
  type SceneLoadError,
} from "../engine/loadDiagnostics";
import { mediaChangedSlug } from "../engine/mediaChangedEvent";
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
import { renderRange, type SceneTextBox, safeAreaBox } from "../engine/rangeRender";
import { GpuStallError } from "../engine/readback";
import { awaitProjectCommitted } from "../engine/themePreviews";
import { serveFontsRequest } from "./bridgeFonts";
import {
  BRIDGE_KINDS,
  type BridgeRequest,
  buildCheckReport,
  type CheckAsset,
  captureFormat,
  collectAssetRefs,
  frameLabel,
  frameScene,
  isNativeBridgeKind,
  MAX_REQUEST_UNITS,
  type ProbeSample,
  parseProbes,
  RANGE_MAX_STRIPS,
  rangeFormat,
  rangePlan,
  rangeUnits,
  requestCaptureFormat,
  requestFormat,
  requestFrames,
  resolvePresetRef,
  responseVersion,
  samplePixels,
  shiftFlashReport,
  stripFrames,
  trustDeniedSlug,
  trustSentence,
  unitsFor,
} from "./bridgeRequests";
import { ContactSheet } from "./contactSheet";

/** The render window's half of the bridge (docs/agent-kit.md, "The bridge (v2)"): claim one request per tick, load (or reload) the target project into this window's own canvas and serve it (capture, check, fonts, insertPreset, the render window's debug ops) through the deterministic export path, all without touching the editor realm. Captures render at `captureFormat` (sheets and multi-frame at a 1280 long edge) while the store keeps the native format, check the client still waits before every frame, and sample `probe` points from the readback. A GPU stall on any path (capture, check render, thumbs, posters) answers `gpuStalled` once and stops this window; Rust recycles it. A media-changed broadcast marks the clip cache dirty; the next tick sweeps it before claiming, so a capture after an in-place re-render shows the new frames. The editor's open project loads under the editor's session trust; any other loads stored-only and never prompts here. Playhead captures (no scene) need the editor's open project, whose id/aspect/playhead arrive via the pushed editor context. Idle ticks drain the thumb queue instead (fast tier: same path, small buffer), parked while the editor is playing. */

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

const smallFormat = (format: FormatSpec): FormatSpec =>
  captureFormat(format, { width: THUMB_WIDTH });

let canvasFailure: string | null = null;
let loadedProjectId: string | null = null;

/** The stage canvas never started (RenderApp's boundary): every request from here on is a stall. */
export function markCanvasFailed(error: unknown): void {
  canvasFailure = error == null ? null : String(error);
}

/** The project this window has loaded, for its beat. */
export function renderLoadedProject(): string | null {
  return loadedProjectId;
}

/** Why `error` is a GPU stall (the canvas is poisoned), or null for a content failure. */
export function stallReason(error: unknown): string | null {
  if (error instanceof GpuStallError) return error.reason;
  if (canvasFailure !== null) return "canvasFailed";
  if (error instanceof Error && error.message.startsWith("Export bridge not mounted")) {
    return "notMounted";
  }
  return null;
}

const reportStall = (reason: string) =>
  invoke("render_report_gpu_event", { reason, deliberate: false }).catch(() => {});

interface Liveness {
  live: boolean;
  reason?: string;
}

/** The client gave up or an export started mid-render: stop and answer it once. */
class RenderStopped extends Error {
  constructor(readonly reason: string | undefined) {
    super(`render stopped: ${reason ?? "cancelled"}`);
  }
}

const stoppedBody = (reason: string | undefined) =>
  reason === "busy"
    ? { ok: false, busy: true, error: "Kookaburra Cut started exporting; retry shortly" }
    : {
        ok: false,
        cancelled: true,
        error: "the client stopped waiting, so the app stopped rendering this request",
      };

interface LoadedState {
  project: LoadedProject;
  fingerprint: string | null;
  /** The asset stamp at load (null when unreadable): an asset-only change reloads without recompiling. */
  assetStamp: string | null;
  formatName: string;
}

/** Starts the claim loop; returns its stop function. `apply` lands a loaded project in this window's stores and React tree (RenderApp owns that state). */
export function startBridgeService(
  apply: (loaded: LoadedProject, format: FormatSpec) => void,
): () => void {
  let busy = false;
  let current: LoadedState | null = null;
  // Set by the first stall: this window's canvas can't be trusted again, and Rust is about to destroy it.
  let poisoned: string | null = null;
  let mediaDirty = false;
  const dirtySlugs = new Set<string>();
  const ready = invoke("render_reset_preset_posters");

  /** Every load is stored-only: this window cannot ask for consent, and the editor's own writes keep the open project's grant current natively. */
  const loadForBridge = (targetId: string): Promise<LoadedProject> =>
    loadProject(targetId, { trustMode: "stored-only" });

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
    const assetStamp = editable && !sourceRevision ? await projectAssetsStamp(targetId) : null;
    const sameSources =
      current?.project.id === targetId &&
      current.fingerprint === fingerprint &&
      (fingerprint !== null || !editable);
    if (current && sameSources && current.assetStamp === assetStamp) {
      if (current.formatName !== format.name) {
        const project = { ...current.project };
        current = null;
        apply(project, format);
        await awaitProjectCommitted(project);
        current = { project, fingerprint, assetStamp, formatName: format.name };
      }
    } else {
      if (sourceRevision) {
        setProjectAssetRevision(targetId, sourceRevision);
        await refreshBundledProjectAssets(targetId);
        await invalidateChangedClips();
      }
      if (sameSources) {
        // Assets only (a file replaced in place): new revisions and clips, the compiled sources kept.
        await refreshWorkspaceAssets(targetId);
        await invalidateChangedClips();
      } else {
        bumpWorkspaceReloadToken();
      }
      const loaded = sourceRevision
        ? await loadProject(targetId, { trustMode: "stored-only", readSavedThemes: true })
        : await loadForBridge(targetId);
      apply(loaded, format);
      await awaitProjectCommitted(loaded);
      current = { project: loaded, fingerprint, assetStamp, formatName: format.name };
    }
    loadedProjectId = current.project.id;
    return current.project;
  };

  /** A load or render failed: the next request reloads cold. */
  const forget = () => {
    current = null;
    loadedProjectId = null;
  };

  /** Whether `error` stalled the GPU; the first one poisons this window. */
  const noteStall = (error: unknown): string | null => {
    const reason = stallReason(error);
    if (reason && !poisoned) poisoned = reason;
    return reason;
  };

  const contextFormat = (context: EditorContext | null): FormatSpec =>
    FORMATS[(context?.aspect ?? "16:9") as AspectName] ?? FORMATS["16:9"];

  const respond = (request: BridgeRequest, body: Record<string, unknown>) =>
    invoke("bridge_write_response", {
      id: request.id,
      jsonText: JSON.stringify({ version: responseVersion(request), id: request.id, ...body }),
    }).catch((e) => console.warn("[render-bridge] response write failed:", e));

  /** A workspace project the editor does not have open is served only once the person allows it (one native dialog per project per session, held in Rust); a refusal answers the request. */
  const allowedProject = async (
    request: BridgeRequest,
    targetId: string,
    context: EditorContext | null,
    kind: string,
  ): Promise<boolean> => {
    if (!isWorkspaceProjectId(targetId) || targetId === context?.projectId) return true;
    const slug = nativeProjectSlug(targetId);
    const allowed = await invoke<boolean>("bridge_confirm_project", {
      slug,
      kind,
      client: request.client ?? null,
    }).catch(() => false);
    if (allowed) return true;
    await respond(request, {
      ok: false,
      declined: true,
      error: `the person did not allow Claude to use "${targetId}" (it is not the project open in Kookaburra Cut); ask them to open it in the app, or to allow it when the app asks`,
    });
    return false;
  };

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
    const servedAt = Date.now();
    const native = requestFormat(request.aspect, context?.aspect);
    const format = requestCaptureFormat(request, native);
    const units = unitsFor(frames.length, format);
    if (units > MAX_REQUEST_UNITS) {
      await respond(request, {
        ok: false,
        tooLarge: true,
        units,
        maxUnits: MAX_REQUEST_UNITS,
        error: `this capture costs ${units} units (${frames.length} frame(s) at ${format.width}x${format.height}); one request takes at most ${MAX_REQUEST_UNITS}`,
        hint: "drop --scale/--width, use the default sheet size",
      });
      return;
    }
    const probes = parseProbes(request.probe, format);
    if (!(await allowedProject(request, targetId, context, "capture"))) return;
    // The store keeps the native format (layout, safe areas); only the capture buffer is scaled.
    const project = await ensureLoaded(targetId, native);
    const sheet = request.sheet
      ? new ContactSheet(frames.length, format.width, format.height)
      : null;
    const shots: {
      scene: string;
      at: number;
      tMs: number;
      path: string;
      index: number;
      probes?: ProbeSample[];
    }[] = [];
    const renderStart = Date.now();
    const times = frames.map((frame) =>
      resolveScreenshotTimeMs(
        project,
        frame.scene ?? undefined,
        frame.at ?? undefined,
        isOpen ? context?.currentMs : undefined,
      ),
    );
    const live = async (n: number) => {
      const state = await invoke<Liveness | null>("bridge_request_live", {
        id: request.id,
        frame: n,
      }).catch(() => null);
      if (state && !state.live) throw new RenderStopped(state.reason);
    };
    const keep = async (
      n: number,
      tMs: number,
      rgba: Uint8Array,
      width: number,
      height: number,
      texts?: SceneTextBox[],
    ) => {
      const frame = frames[n];
      // Probes read the readback already in memory, before the PNG save.
      const sampled = probes.length ? samplePixels(rgba, width, height, probes) : undefined;
      await invoke(BRIDGE_COMMANDS.begin, {
        width,
        height,
        name: n === 0 ? request.id : `${request.id}-${n}`,
      });
      const path = await invoke<string>(BRIDGE_COMMANDS.save, rgba);
      const where = frameScene(project, frame.scene, tMs);
      sheet?.draw(n, rgba, width, height, frameLabel(project, tMs, where));
      shots.push({
        scene: where.scene,
        at: where.at,
        tMs: Math.round(tMs),
        path,
        index: where.index,
        ...(sampled ? { probes: sampled } : {}),
        ...(texts ? { texts } : {}),
      });
    };
    try {
      if (request.texts) {
        // One frame at a time, so clips extract only each instant, as captureFrameRgba does; each frame also reports the text it shows.
        for (const [n, tMs] of times.entries()) {
          await live(n);
          await renderRange(
            exportOptions(project, format),
            [tMs],
            (f) => keep(n, f.tMs, f.rgba, f.width, f.height, f.texts),
            { texts: true },
          );
        }
      } else {
        for (const [n, tMs] of times.entries()) {
          await live(n);
          const { rgba, width, height } = await captureFrameRgba(
            exportOptions(project, format),
            tMs,
          );
          await keep(n, tMs, rgba, width, height);
        }
      }
    } catch (e) {
      if (!(e instanceof RenderStopped)) throw e;
      await respond(request, stoppedBody(e.reason));
      return;
    }
    const renderMs = Date.now() - renderStart;
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
      size: { width: format.width, height: format.height },
      nativeSize: { width: native.width, height: native.height },
      ...(request.texts ? { safe: safeAreaBox(native) } : {}),
      timing: {
        queuedMs: request.requestedAtMs > 0 ? Math.max(0, servedAt - request.requestedAtMs) : null,
        renderMs,
        perFrameMs: Math.round(renderMs / shots.length),
      },
      // Provenance for hash disputes: this surface is visually exact but not hash-exact against the cold-boot screenshot (docs/determinism.md).
      surface: "render-window",
    });
  };

  /** A span through the export path at a check size: the flash detector over every frame, a preview clip of PNG frames, or both; flagged moments come back with before, at and after frames. */
  const serveRange = async (request: BridgeRequest, context: EditorContext | null) => {
    const targetId = request.project ?? context?.projectId ?? null;
    if (!targetId) {
      await respond(request, {
        ok: false,
        error: "no project is open in Kookaburra Cut; pass a project",
      });
      return;
    }
    const flashes = request.flashes !== false;
    const clip = request.clip === true;
    if (!flashes && !clip) {
      await respond(request, { ok: false, error: "a ranged render needs flashes, clip or both" });
      return;
    }
    const servedAt = Date.now();
    const native = requestFormat(request.aspect, context?.aspect);
    const format = rangeFormat(native, request.width);
    const project = await ensureLoaded(targetId, native);
    const plan = rangePlan(request, project.totalMs);
    const units = rangeUnits(plan.frames.length, format);
    if (units > MAX_REQUEST_UNITS) {
      await respond(request, {
        ok: false,
        tooLarge: true,
        units,
        maxUnits: MAX_REQUEST_UNITS,
        error: `this ranged render costs ${units} units (${plan.frames.length} frames at ${format.width}x${format.height}); one request takes at most ${MAX_REQUEST_UNITS}`,
        hint: "check a shorter span (kb splits a long one), or drop --width",
      });
      return;
    }
    const opts = { ...exportOptions(project, format), fps: plan.fps };
    const live = async (n: number) => {
      const state = await invoke<Liveness | null>("bridge_request_live", {
        id: request.id,
        frame: n,
      }).catch(() => null);
      if (state && !state.live) throw new RenderStopped(state.reason);
    };
    const savePng = async (rgba: Uint8Array, width: number, height: number, n: number) => {
      const png = await rgbaToPng(rgba, width, height);
      if (!png) throw new Error("could not encode a ranged frame");
      return await invoke<string>("bridge_write_sheet", png, {
        headers: { "x-kookaburra-id": request.id, "x-kookaburra-frame": String(n) },
      });
    };
    const clipPaths: string[] = [];
    let report: Record<string, unknown> | null = null;
    const renderStart = Date.now();
    try {
      if (flashes) {
        await invoke("range_flash_begin", {
          width: format.width,
          height: format.height,
          fps: plan.fps,
          standard: request.standard ?? null,
        });
      }
      await renderRange(opts, plan.times, async ({ index, rgba, width, height }) => {
        await live(index);
        if (flashes) await invoke("range_flash_push", rgba);
        if (clip) clipPaths.push(await savePng(rgba, width, height, index));
      });
      if (flashes) {
        report = shiftFlashReport(
          await invoke<Record<string, unknown>>("range_flash_finish"),
          plan.times[0],
        );
      }
    } catch (e) {
      if (flashes) await invoke("range_flash_finish").catch(() => null);
      if (!(e instanceof RenderStopped)) throw e;
      await respond(request, stoppedBody(e.reason));
      return;
    }
    const renderMs = Date.now() - renderStart;
    const issues = (report?.issues as { startMs: number }[] | undefined) ?? [];
    const flagged = issues
      .slice(0, RANGE_MAX_STRIPS)
      .map((issue) => stripFrames(plan, issue.startMs));
    const stripFrameSet = [...new Set(flagged.flat())].sort((a, b) => a - b);
    const stripPaths = new Map<number, string>();
    if (stripFrameSet.length > 0) {
      // Frame numbers past the clip's own, so the two never share a name.
      const base = plan.frames[plan.frames.length - 1] + 1;
      await renderRange(
        opts,
        stripFrameSet.map((k) => (k * 1000) / plan.fps),
        async ({ index, rgba, width, height }) => {
          stripPaths.set(stripFrameSet[index], await savePng(rgba, width, height, base + index));
        },
      );
    }
    await respond(request, {
      ok: true,
      project: project.id,
      format: format.name,
      size: { width: format.width, height: format.height },
      nativeSize: { width: native.width, height: native.height },
      fps: plan.fps,
      startMs: plan.startMs,
      endMs: plan.endMs,
      firstFrame: plan.frames[0],
      frames: plan.frames.length,
      ...(report ? { flashes: report } : {}),
      ...(clip ? { clip: { paths: clipPaths, fps: plan.fps } } : {}),
      strips: flagged.map((frames, issue) => ({
        issue,
        frames: frames.map((k, i) => ({
          role: ["before", "at", "after"][i],
          frame: k,
          tMs: Math.round((k * 1000) / plan.fps),
          path: stripPaths.get(k) ?? null,
        })),
      })),
      timing: {
        queuedMs: request.requestedAtMs > 0 ? Math.max(0, servedAt - request.requestedAtMs) : null,
        renderMs,
        perFrameMs: Math.round(renderMs / plan.frames.length),
      },
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
    if (!(await allowedProject(request, targetId, context, "check"))) return;
    let project: LoadedProject;
    try {
      project = await ensureLoaded(targetId, format);
    } catch (e) {
      if (trustDeniedSlug(e) || stallReason(e)) throw e;
      forget();
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
          // A stall is the GPU's, not this scene's: stop and answer it once.
          if (stallReason(e)) throw e;
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
    if (!(await allowedProject(request, targetId, context, "insertPreset"))) {
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
    // An app write into a project the user had allowed keeps it allowed: Rust re-stamps the grant as part of the copy.
    const inserted = await insertPresetScene({
      destSlug,
      presetProjectId: entry.projectId,
      position: request.position ?? undefined,
      name: request.name?.trim() || undefined,
      trustMode: "stored-only",
    });
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

  /** The render window's debug ops: lose-context on its own stage (Rust recycles it, no backoff), and in dev builds spawn-contexts to see which context WebKit evicts past 16. */
  const serveDebug = async (request: BridgeRequest) => {
    const op = request.op ?? "";
    if (op === "lose-context" && (request.window ?? "render") === "render") {
      const gl = canvasHandle.current?.gl;
      if (!gl) {
        await respond(request, { ok: false, error: "the render window's stage is not mounted" });
        return;
      }
      await respond(request, { ok: true, op, window: "render", lost: true, recycling: true });
      poisoned = "debug";
      gl.forceContextLoss();
      return;
    }
    if (op === "spawn-contexts") {
      if (!import.meta.env.DEV) {
        await respond(request, { ok: false, error: "spawn-contexts runs only in dev builds" });
        return;
      }
      const n = Math.min(32, Math.max(1, Math.round(request.n ?? 17)));
      const held: WebGLRenderingContext[] = [];
      for (let i = 0; i < n; i++) {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        tagGlCanvas(canvas, `spawned-${i}`);
        const gl = canvas.getContext("webgl");
        if (gl) held.push(gl);
      }
      // WebKit's evictions arrive as webglcontextlost events after the creating call returns.
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const census = glContextCensus();
      for (const gl of held) gl.getExtension("WEBGL_lose_context")?.loseContext();
      await respond(request, { ok: true, op, n, created: held.length, census });
      return;
    }
    await respond(request, {
      ok: false,
      error: `debug op "${op}" isn't served by the render window (lose-context, spawn-contexts)`,
    });
  };

  const serveRequest = async (request: BridgeRequest): Promise<void> => {
    const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
    const kind = request.kind ?? "capture";
    if (poisoned) {
      await respond(request, {
        ok: false,
        gpuStalled: true,
        reason: poisoned,
        error: `GPU stalled (${poisoned}): this render window can't render again; Kookaburra Cut is recycling it`,
      });
      return;
    }
    try {
      if (isNativeBridgeKind(kind)) {
        await respond(request, {
          ok: false,
          error: `${kind} is served natively by the app, never by the render window`,
        });
        return;
      }
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
        case "range":
          return await serveRange(request, context);
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
        case "debug":
          return await serveDebug(request);
        default:
          await respond(request, {
            ok: false,
            error: `unknown request kind "${kind}"; this app serves ${BRIDGE_KINDS.join(", ")}`,
          });
      }
    } catch (e) {
      // A failed load poisons nothing: drop the cached project so the next request reloads cold.
      forget();
      const stalled = noteStall(e);
      if (stalled) {
        // Rust fills in recycled, retryAfterMs, wedged and the hint, then recycles this window.
        await respond(request, { ok: false, gpuStalled: true, reason: stalled, error: String(e) });
        return;
      }
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
      forget();
      const stalled = noteStall(e);
      if (stalled) {
        // The job is dropped with the window; the editor asks again for thumbs it still lacks.
        await reportStall(stalled);
        return false;
      }
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
      forget();
      const stalled = noteStall(error);
      if (stalled) {
        // Back in the queue for the next window, never marked failed.
        await finish(true).catch(() => false);
        await reportStall(stalled);
        return false;
      }
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

  /** Inside the busy guard, so a sweep never runs under a capture that is reading frames. */
  const sweepChangedMedia = async () => {
    if (!mediaDirty) return;
    mediaDirty = false;
    const slugs = [...dirtySlugs];
    dirtySlugs.clear();
    try {
      await Promise.all(slugs.map((slug) => refreshWorkspaceAssets(`ws:${slug}`)));
      await invalidateChangedClips();
    } catch (e) {
      console.warn("[render-bridge] media sweep failed:", e);
    }
  };

  const tick = async (): Promise<void> => {
    await ready;
    await sweepChangedMedia();
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
      if (poisoned) return;
      const context = await invoke<EditorContext | null>("get_editor_context").catch(() => null);
      const served =
        (await servePresetPoster(context, true)) ||
        (!poisoned && (await serveThumb(context))) ||
        (!poisoned && (await servePresetPoster(context)));
      if (!served || poisoned) return;
      await sweepChangedMedia();
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
  const mediaListening = listen<unknown>("kookaburra://media-changed", (event) => {
    mediaDirty = true;
    const slug = mediaChangedSlug(event.payload);
    if (slug) dirtySlugs.add(slug);
  });
  const timer = window.setInterval(run, 1000);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    void listening.then((unlisten) => unlisten()).catch(() => {});
    void mediaListening.then((unlisten) => unlisten()).catch(() => {});
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
    music: project.music,
    theme: project.theme,
    sceneThemes: project.sceneThemes,
    projectLighting: project.projectLighting,
    sceneFrames: project.sceneFrames,
    compareBDocs: project.compareBDocs,
    compareBThemes: project.compareBThemes,
    roomThemes: project.roomThemes,
    motionBlur: project.renderSettings.motionBlur,
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
