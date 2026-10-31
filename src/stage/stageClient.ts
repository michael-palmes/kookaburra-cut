import { listen } from "@tauri-apps/api/event";
import { PerspectiveCamera } from "three";
import { inventoryImageRels, subscribeAssetChanges } from "../engine/assetRevisions";
import { reportAutoRunError } from "../engine/autorun";
import { applyMirroredClipStatus } from "../engine/clips";
import { useClockStore } from "../engine/clock";
import { useDepthStageRegistry } from "../engine/depthStageRegistry";
import type { ExportOptions } from "../engine/exporter";
import { setExporting } from "../engine/exportState";
import type { GizmoDomain } from "../engine/gizmoRegistry";
import type { GlCensus } from "../engine/glContexts";
import type { MemoryCensus } from "../engine/memoryCensus";
import type { PerfRow } from "../engine/perfProbe";
import {
  isWorkspaceBackedProjectId,
  type LoadedProject,
  nativeProjectSlug,
  resolveAssetUrl,
  resolveProjectHdrUrl,
  workspaceEnvironmentRels,
} from "../engine/project";
import { isSceneErrorCard } from "../engine/SceneErrorCard";
import { setMirroredSceneHosts } from "../engine/sceneHostRegistry";
import { setSceneModuleProvider } from "../engine/sceneModules";
import { useSceneTextRegistry } from "../engine/sceneTextRegistry";
import { type StageBoot, type StageHandle, setStage } from "../engine/stageHandle";
import type {
  CameraFrame,
  CommitStamps,
  Gizmo2DTargetFrame,
  GizmoPickerSummary,
  MirroredStore,
  PortMethod,
  SceneCompileEntry,
  SceneCompileResult,
  StageAssets,
  StageExportOptions,
  StagePointerEvent,
  StageProject,
  StageRole,
  StageSize,
  ToWindow,
  WindowNotice,
  WindowRequest,
  WorkerRequest,
} from "../engine/stageProtocol";
import { STAGE_PROTOCOL_VERSION } from "../engine/stageProtocol";
import { parseClipSourceKey } from "../engine/stageRealm";
import { useStageRegistry } from "../engine/stageRegistry";
import type { StillPageDigest, StillsSettings } from "../engine/stillsExport";
import { useTextKeyRegistry } from "../engine/textKeyRegistry";
import { windowNativePort } from "../engine/windowNativePort";
import { workspaceFontEntries } from "../theme/fonts";
import type { FrameRect } from "../toolkit/frame/frameLayout";
import { applyMirroredEmoji } from "../toolkit/text/emojiRaster";
import { mirroredStores } from "./mirroredStores";
import { mirrorStores, type StoreMirror } from "./storeMirror";

/**
 * The window's end of the stage protocol: spawns the stage worker on a canvas, forwards what
 * the canvas tree needs (stores, the clock, pointer events, the cutout, assets) and serves the
 * worker's native requests through the window's validated port. Engine modules reach it
 * through `stage()` (engine/stageHandle.ts). Every message from the worker is data: a
 * compromised scene can post anything, so nothing here acts on a message beyond what the
 * protocol names, and every port call is checked against the open project.
 */

const READY_TIMEOUT_MS = 90_000;

/** A request without its id: `Omit` distributes over the union here so each shape keeps its own fields. */
type RequestBody = WindowRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (value: unknown) => void;
}

export class StageClient implements StageHandle {
  readonly ready: Promise<void>;
  readonly element: HTMLCanvasElement;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private isReady = false;
  private failure: Error | null = null;
  private timeout: Error | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly queued: { go: () => void; reject: (error: Error) => void }[] = [];
  private bootState: StageBoot = { status: "starting" };
  private readonly bootListeners = new Set<() => void>();
  private currentStamps: CommitStamps = {
    clockMs: Number.NaN,
    shutterSeq: Number.NaN,
    holdsVersion: Number.NaN,
    projectSeq: null,
    primaryHosts: 0,
  };
  private readonly stampListeners = new Set<() => void>();
  private currentFrame: { targets: Gizmo2DTargetFrame[]; camera: CameraFrame | null } = {
    targets: [],
    camera: null,
  };
  private readonly frameListeners = new Set<() => void>();
  private currentPickers: GizmoPickerSummary[] = [];
  private readonly pickerListeners = new Set<() => void>();
  private losses = 0;
  private readonly lossListeners = new Set<() => void>();
  private readonly mirror: StoreMirror;
  private readonly projects = new Map<number, LoadedProject>();
  private loadSeq = 0;
  private readonly cameraShadow = new PerspectiveCamera();
  private readonly offs: (() => void)[] = [];
  private cursorValue = "";
  readonly onCursor: (cursor: string) => void;

  constructor(
    element: HTMLCanvasElement,
    readonly role: StageRole,
    size: StageSize,
    frameloop: "demand" | "never",
    options: { onCursor?: (cursor: string) => void } = {},
  ) {
    this.element = element;
    this.onCursor = options.onCursor ?? (() => {});
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A worker that never reports is a boot failure, not a wait: name it instead of hanging an autorun until its timeout. A ready that still arrives afterwards lifts the failure (onMessage).
    this.readyTimer = setTimeout(() => {
      if (this.isReady) return;
      this.timeout = new Error(
        `the ${role} stage worker did not report ready within ${READY_TIMEOUT_MS / 1000}s`,
      );
      this.fail(this.timeout);
    }, READY_TIMEOUT_MS);
    this.ready.then(
      () => clearTimeout(this.readyTimer),
      () => {},
    );
    this.mirror = mirrorStores(
      {
        ...mirroredStores(),
        clock: useClockStore as never,
        sceneText: useSceneTextRegistry as never,
        textKey: useTextKeyRegistry as never,
        stage: useStageRegistry as never,
        depthStage: useDepthStageRegistry as never,
      },
      (name, patch) => this.send({ type: "store", name, patch }),
    );
    this.worker = new Worker(new URL("./stageWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<ToWindow>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      console.error("[stage] worker error:", ev.message, ev.filename, ev.lineno);
      reportAutoRunError(`stage worker error: ${ev.message}`);
    };
    this.worker.onmessageerror = () =>
      console.error("[stage] a worker message could not be deserialised");
    const offscreen = element.transferControlToOffscreen();
    this.worker.postMessage(
      {
        type: "init",
        version: STAGE_PROTOCOL_VERSION,
        role,
        canvas: offscreen,
        size,
        frameloop,
        dev: import.meta.env.DEV,
        stores: this.mirror.snapshot(),
      } satisfies WindowNotice,
      [offscreen],
    );
    setSceneModuleProvider({
      compile: (projectId, entries) => this.compileScenes(projectId, entries),
      compilePersistent: (projectId, entry) =>
        this.request<{ key: string }>({ type: "compilePersistent", projectId, entry }),
    });
    this.offs.push(
      subscribeAssetChanges((projectId) => {
        if (!this.projectsHold(projectId)) return;
        this.send({ type: "assetsChanged", projectId, assets: buildStageAssets(projectId) });
      }),
    );
    void listen<unknown>("kookaburra://conform-progress", ({ payload }) =>
      this.send({ type: "conformProgress", payload }),
    ).then((off) => this.offs.push(off));
    void listen<{ slug?: string; paths?: string[]; origin?: string } | null>(
      "kookaburra://media-changed",
      ({ payload }) => {
        if (payload?.origin !== "conform" || !Array.isArray(payload.paths)) return;
        this.send({ type: "conformMediaChanged", slug: payload.slug, paths: payload.paths });
      },
    ).then((off) => this.offs.push(off));
    setStage(this);
  }

  private projectsHold(projectId: string): boolean {
    for (const project of this.projects.values()) if (project.id === projectId) return true;
    return false;
  }

  /** A worker that cannot serve: every waiting and future request fails with the cause, `ready` rejects, and the autorun hears it. */
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.readyTimer);
    console.error(`[stage] ${error.message}`);
    reportAutoRunError(error.message);
    if (!this.isReady) this.readyReject(error);
    this.rejectWaiting(error);
    this.setBoot({ status: "failed", error });
  }

  private rejectWaiting(error: Error): void {
    for (const q of this.queued.splice(0)) q.reject(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private setBoot(next: StageBoot): void {
    this.bootState = next;
    for (const l of this.bootListeners) l();
  }

  /** The project ids this window handed the stage; a port request naming any other project is refused. */
  private assertHeldProject(projectId: unknown): void {
    if (typeof projectId !== "string" || !this.projectsHold(projectId)) {
      throw new Error(`project "${String(projectId)}" is not open in this window`);
    }
  }

  private assertHeldSlug(slug: unknown): void {
    for (const project of this.projects.values()) {
      if (isWorkspaceBackedProjectId(project.id) && nativeProjectSlug(project.id) === slug) return;
    }
    throw new Error(`project "${String(slug)}" is not open in this window`);
  }

  /** The worker names projects by id (clip keys, emoji caches) or native slug (conform posters); each must be one this window loaded. Cache directories are checked by the port itself. */
  private checkPortScope(method: PortMethod, args: unknown[]): void {
    switch (method) {
      case "clipRevisions":
        for (const key of args[0] as string[])
          this.assertHeldProject(parseClipSourceKey(key).projectId);
        return;
      case "clipInfo":
      case "clipHash":
      case "clipEnsureChunks":
      case "clipConformPending":
        this.assertHeldProject(parseClipSourceKey(String(args[0])).projectId);
        return;
      case "emojiRead":
      case "emojiWrite":
        this.assertHeldProject(args[0]);
        return;
      case "conformPoster":
        this.assertHeldSlug(args[0]);
        return;
    }
  }

  // ── Transport ──────────────────────────────────────────────────────────────
  private send(msg: WindowNotice | WindowRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private request<T>(
    msg: RequestBody,
    transfer: Transferable[] = [],
    onProgress?: (value: unknown) => void,
  ): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const go = () => {
        const id = this.nextId++;
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
        this.send({ ...msg, id } as WindowRequest, transfer);
      };
      if (this.isReady) go();
      else this.queued.push({ go, reject });
    });
    // A failed worker reports itself, so a fire-and-forget caller owes no handler: keep its rejection out of the window's boot trap.
    result.catch(() => {});
    return result;
  }

  private onMessage(msg: ToWindow): void {
    switch (msg.type) {
      case "ready": {
        if (this.isReady) return;
        // Only the ready window's own failure lifts: a fatal or a closed worker stays failed.
        const late = this.failure !== null;
        if (late && this.failure !== this.timeout) return;
        this.failure = null;
        this.isReady = true;
        console.warn(
          `[stage] ${this.role} worker ready${late ? " after its window" : ""}: ${msg.gl}`,
        );
        for (const q of this.queued.splice(0)) q.go();
        this.readyResolve();
        this.setBoot({ status: "ready", late });
        return;
      }
      case "reply": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else {
          const error = new Error(msg.error);
          if (msg.stall) (error as Error & { reason?: string }).reason = msg.stall;
          p.reject(error);
        }
        return;
      }
      case "progress":
        this.pending.get(msg.id)?.onProgress?.(msg.value);
        return;
      case "log":
        // info rides warn: only warn and error reach the dev harness's log.
        if (msg.level === "error") console.error(`[stage] ${msg.text}`);
        else console.warn(`[stage] ${msg.text}`);
        return;
      case "fatal":
        this.fail(new Error(`stage worker: ${msg.text}`));
        return;
      case "commit":
        this.currentStamps = msg.stamps;
        for (const l of this.stampListeners) l();
        return;
      case "frame":
        this.currentFrame = { targets: msg.targets, camera: msg.camera };
        this.cameraShadow.matrixWorld.fromArray(msg.camera.matrixWorld);
        this.cameraShadow.matrixWorldInverse.copy(this.cameraShadow.matrixWorld).invert();
        this.cameraShadow.projectionMatrix.fromArray(msg.camera.projectionMatrix);
        this.cameraShadow.projectionMatrixInverse.fromArray(msg.camera.projectionMatrixInverse);
        this.cameraShadow.fov = msg.camera.fov;
        this.cameraShadow.aspect = msg.camera.aspect;
        this.cameraShadow.matrixAutoUpdate = false;
        this.cameraShadow.matrixWorldAutoUpdate = false;
        for (const l of this.frameListeners) l();
        return;
      case "pickers":
        this.currentPickers = msg.pickers;
        for (const l of this.pickerListeners) l();
        return;
      case "hosts":
        setMirroredSceneHosts(msg.hosts);
        return;
      case "store":
        this.mirror.apply(msg.name, msg.patch);
        return;
      case "cursor":
        this.cursorValue = msg.cursor;
        this.onCursor(msg.cursor);
        return;
      case "sourceChanged":
        // Dev only: the worker cannot Fast Refresh, so the window reloads as Vite does for an unaccepted update.
        if (!import.meta.env.DEV) return;
        console.warn(`[stage] source changed, reloading: ${msg.paths.join(" ")}`);
        location.reload();
        return;
      case "contextLost":
        if (!msg.deliberate) {
          this.losses += 1;
          for (const l of this.lossListeners) l();
        }
        return;
      case "clips":
        applyMirroredClipStatus(msg.extracting, msg.progress);
        return;
      case "emoji":
        applyMirroredEmoji(msg.version, msg.unrenderable);
        return;
      case "port":
        void this.servePort(msg);
        return;
    }
  }

  /** The worker's native requests, answered by the window's validated port by method name; an unknown method or a throwing one answers an error, never silence. */
  private async servePort(req: Extract<WorkerRequest, { type: "port" }>): Promise<void> {
    try {
      if (!Object.hasOwn(windowNativePort, req.method)) {
        throw new Error(`unknown port method ${String(req.method)}`);
      }
      const method = windowNativePort[req.method as PortMethod];
      const args = [...req.args];
      this.checkPortScope(req.method, args);
      if (req.method === "clipEnsureChunks") {
        args[3] = (value: unknown) => this.send({ type: "portProgress", id: req.id, value });
      }
      const value = await (method as (...a: unknown[]) => Promise<unknown>).apply(
        windowNativePort,
        args,
      );
      const transfer = value instanceof ArrayBuffer ? [value] : [];
      this.send({ type: "reply", id: req.id, ok: true, value }, transfer);
    } catch (e) {
      this.send({
        type: "reply",
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── StageHandle ────────────────────────────────────────────────────────────
  boot(): StageBoot {
    return this.bootState;
  }
  subscribeBoot(listener: () => void): () => void {
    this.bootListeners.add(listener);
    return () => {
      this.bootListeners.delete(listener);
    };
  }
  stamps(): CommitStamps {
    return this.currentStamps;
  }
  subscribeStamps(listener: () => void): () => void {
    this.stampListeners.add(listener);
    return () => {
      this.stampListeners.delete(listener);
    };
  }
  committedProject(): LoadedProject | null {
    const seq = this.currentStamps.projectSeq;
    return seq === null ? null : (this.projects.get(seq) ?? null);
  }
  frame(): { targets: Gizmo2DTargetFrame[]; camera: CameraFrame | null } {
    return this.currentFrame;
  }
  /** A camera whose matrices are the stage camera's last frame, for window-side projection maths. */
  camera(): PerspectiveCamera | null {
    return this.currentFrame.camera ? this.cameraShadow : null;
  }
  subscribeFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }
  pickers(): GizmoPickerSummary[] {
    return this.currentPickers;
  }
  subscribePickers(listener: () => void): () => void {
    this.pickerListeners.add(listener);
    return () => {
      this.pickerListeners.delete(listener);
    };
  }
  cursor(): string {
    return this.cursorValue;
  }
  configure(size: StageSize, frameloop: "demand" | "never"): Promise<void> {
    return this.request({ type: "configure", size, frameloop });
  }
  compileScenes(projectId: string, entries: SceneCompileEntry[]): Promise<SceneCompileResult[]> {
    return this.request({ type: "compileScenes", projectId, entries });
  }
  async loadProject(project: LoadedProject | null, seq: number): Promise<void> {
    if (project) this.projects.set(seq, project);
    // Keep the last few, so a stamp that lags a quick switch still resolves.
    for (const key of [...this.projects.keys()].slice(0, -4)) this.projects.delete(key);
    await this.request({
      type: "loadProject",
      project: project ? toStageProject(project) : null,
      seq,
    });
  }
  /** Loads with a fresh sequence number; the window's project swap path. A load the worker refuses is reported here, since no caller awaits a swap. */
  async applyProject(project: LoadedProject | null): Promise<number> {
    const seq = ++this.loadSeq;
    try {
      await this.loadProject(project, seq);
    } catch (e) {
      const text = `the stage could not load the project: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[stage] ${text}`);
      reportAutoRunError(text);
    }
    return seq;
  }
  awaitHosts(expected: number): Promise<void> {
    return this.request({ type: "awaitHosts", expected });
  }
  settle(projectId: string, onProgress?: (completed: number) => void): Promise<void> {
    return this.request({ type: "settle", projectId }, [], (v) => onProgress?.(v as number));
  }
  exportBegin(
    opts: StageExportOptions,
    onPrepareStep?: (step: number) => void,
  ): Promise<{ total: number }> {
    return this.request({ type: "exportBegin", opts }, [], (v) => onPrepareStep?.(v as number));
  }
  exportFrame(
    frame: number,
    tMs: number,
    poster: boolean,
    buffer: ArrayBuffer | null,
    fingerprint: boolean,
  ) {
    return this.request<Awaited<ReturnType<StageHandle["exportFrame"]>>>(
      { type: "exportFrame", frame, tMs, poster, buffer, fingerprint },
      buffer ? [buffer] : [],
    );
  }
  exportEnd(): Promise<void> {
    return this.request({ type: "exportEnd" });
  }
  holdExport(on: boolean): Promise<void> {
    return this.request({ type: "holdExport", on });
  }
  captureFrame(opts: StageExportOptions, tMs: number) {
    return this.request<Awaited<ReturnType<StageHandle["captureFrame"]>>>({
      type: "captureFrame",
      opts,
      tMs,
    });
  }
  rangeBegin(opts: StageExportOptions, spanMs: [number, number]): Promise<void> {
    return this.request({ type: "rangeBegin", opts, spanMs });
  }
  rangeFrame(index: number, tMs: number, buffer: ArrayBuffer | null, texts: boolean) {
    return this.request<Awaited<ReturnType<StageHandle["rangeFrame"]>>>(
      { type: "rangeFrame", index, tMs, buffer, texts },
      buffer ? [buffer] : [],
    );
  }
  rangeEnd(): Promise<void> {
    return this.request({ type: "rangeEnd" });
  }
  stillsBegin(
    opts: StageExportOptions,
    settings: StillsSettings,
    onPrepareStep?: (step: number) => void,
  ) {
    return this.request<Awaited<ReturnType<StageHandle["stillsBegin"]>>>(
      { type: "stillsBegin", opts, settings },
      [],
      (v) => onPrepareStep?.(v as number),
    );
  }
  stillsPage(page: number) {
    return this.request<{
      body: Uint8Array;
      headers: Record<string, string>;
      pageHash: string;
      digest: StillPageDigest;
    }>({ type: "stillsPage", page });
  }
  stillsEnd(): Promise<void> {
    return this.request({ type: "stillsEnd" });
  }
  snapshot(tMs: number | null, width: number, format: "png" | "jpeg"): Promise<Uint8Array | null> {
    return this.request({ type: "snapshot", tMs, width, format });
  }
  perfRun(): Promise<PerfRow[]> {
    return this.request({ type: "perfRun" });
  }
  perfColdWaits() {
    return this.request<{ referenced: number; bound: number; waits: number[] }>({
      type: "perfColdWaits",
    });
  }
  hitTest(
    ndcX: number,
    ndcY: number,
    domain?: GizmoDomain,
    claim = false,
  ): Promise<GizmoPickerSummary | null> {
    return this.request({ type: "hitTest", ndcX, ndcY, domain, claim });
  }
  census(): Promise<GlCensus> {
    return this.request({ type: "census" });
  }
  memoryCensus(): Promise<MemoryCensus> {
    return this.request({ type: "memoryCensus" });
  }
  forceContextLoss(): Promise<void> {
    return this.request({ type: "forceContextLoss" });
  }
  releasePools(): Promise<void> {
    return this.request({ type: "releasePools" });
  }
  invalidateChangedClips(): Promise<void> {
    return this.request({ type: "invalidateClips" });
  }
  evictAllClips(): Promise<void> {
    return this.request({ type: "evictClips" });
  }
  setCutout(rect: FrameRect | null): void {
    this.send({ type: "cutout", rect });
  }
  previewFlags(flags: Omit<Extract<WindowNotice, { type: "previewFlags" }>, "type">): void {
    this.send({ type: "previewFlags", ...flags });
  }
  setClipCacheCapacity(n: number): void {
    this.send({ type: "clipCacheCapacity", n });
  }
  pointer(event: StagePointerEvent): void {
    this.send({ type: "pointer", event });
  }
  contextLosses(): number {
    return this.losses;
  }
  subscribeContextLost(listener: () => void): () => void {
    this.lossListeners.add(listener);
    return () => {
      this.lossListeners.delete(listener);
    };
  }
  /** Mirrors the export hold into this realm too, for callers that only hold the worker. */
  holdLocal(on: boolean): void {
    setExporting(on);
  }

  dispose(): void {
    clearTimeout(this.readyTimer);
    for (const off of this.offs.splice(0)) off();
    this.mirror.stop();
    setSceneModuleProvider(null);
    setStage(null);
    this.worker.terminate();
    const closed = new Error("the stage worker was closed");
    this.failure ??= closed;
    if (!this.isReady) this.readyReject(closed);
    this.rejectWaiting(closed);
  }
}

/** The worker's view of a loaded project: the data, the module keys, and every asset URL the window resolves for it. */
export function toStageProject(project: LoadedProject): StageProject {
  const { scenes, persistent: _persistent, ...rest } = project;
  return {
    ...rest,
    scenes: scenes.map((scene, index) => {
      const errorCard = isSceneErrorCard(scene)
        ? {
            file: project.sceneFiles[index],
            message: project.sceneErrors?.find((e) => e.index === index)?.message ?? "",
          }
        : undefined;
      return {
        id: scene.id,
        durationMs: scene.durationMs,
        key: errorCard ? null : (scene.key ?? null),
        ...(errorCard ? { errorCard } : {}),
      };
    }),
    assets: buildStageAssets(project.id),
    fonts: workspaceFontEntries(),
  };
}

/** Every image and environment map the window's inventories know for a workspace project, at the URL the window would load it from; bundled projects resolve in the worker's own globs. */
export function buildStageAssets(projectId: string): StageAssets {
  const assets: StageAssets = { images: {}, environments: {} };
  if (!isWorkspaceBackedProjectId(projectId)) return assets;
  for (const rel of inventoryImageRels(projectId)) {
    try {
      assets.images[rel] = resolveAssetUrl(projectId, rel);
    } catch {
      // Not loadable (the inventory lists every stamped file); the worker treats a miss as missing.
    }
  }
  for (const rel of workspaceEnvironmentRels(projectId)) {
    try {
      assets.environments[rel] = resolveProjectHdrUrl(projectId, rel);
    } catch {
      // As above.
    }
  }
  return assets;
}

export type { ExportOptions, MirroredStore };
