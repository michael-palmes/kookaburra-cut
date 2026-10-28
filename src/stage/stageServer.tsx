import "../engine/glContexts";
import { createRoot, extend, type RootStore, useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { type Camera, Texture, TextureLoader } from "three";
import { configureTextBuilder } from "troika-three-text";
import { create } from "zustand";
import { CompositorDriver } from "../engine/CompositorDriver";
import {
  clipExtractionCount,
  clipExtractionProgress,
  evictAllClips,
  invalidateChangedClips,
  setHardwareVideo,
  subscribeClipExtraction,
} from "../engine/clips";
import { useClockStore } from "../engine/clock";
import { releaseCompositorPools } from "../engine/compositor";
import { useDepthStageRegistry } from "../engine/depthStageRegistry";
import { installDevPerformanceDrain } from "../engine/devPerformance";
import { releaseComposer } from "../engine/effects";
import {
  canvasHandle,
  ExportBridge,
  localCommitStamps,
  onCanvasCommit,
  ProjectCommitStamp,
  trackContextLosses,
} from "../engine/exportBridge";
import {
  awaitSceneHostsCommitted,
  beginExportRun,
  captureFrameRun,
  type ExportRun,
  endExportRun,
  renderExportFrame,
} from "../engine/exportRun";
import { setExporting } from "../engine/exportState";
import { CAMERA, SHADOW_MAP_TYPE } from "../engine/format";
import { gizmoHandleAt, gizmoPickerHandles, subscribeGizmoPickers } from "../engine/gizmoRegistry";
import { cameraFrameOf, projectGizmoTargets } from "../engine/gizmoTargetFrames";
import { glContextCensus, onGlContextLoss, tagGlCanvas } from "../engine/glContexts";
import { ensureRectAreaLightUniforms } from "../engine/lightingState";
import { perfColdWaits, runPerfProbe } from "../engine/perfProbe";
import { setPresentSlideshowActive } from "../engine/presentMode";
import {
  setPreviewClipStride,
  setPreviewMotionBlurPlayback,
  setPreviewPlaybackActive,
} from "../engine/previewMedia";
import { settleProjectOpen } from "../engine/previewSettle";
import type { LoadedProject } from "../engine/project";
import { RenderSettingsApplier } from "../engine/RenderSettingsApplier";
import { sceneErrorCard } from "../engine/SceneErrorCard";
import { StagePointer } from "../engine/StagePointer";
import { StageScenes } from "../engine/StageScenes";
import { getSceneHosts, subscribeSceneHosts } from "../engine/sceneHostRegistry";
import {
  compilePersistentModule,
  localSceneModuleProvider,
  persistentComponentFor,
  sceneModuleFor,
} from "../engine/sceneModules";
import { useSceneTextRegistry } from "../engine/sceneTextRegistry";
import { snapshotRun } from "../engine/snapshots";
import { setStageAssetTable } from "../engine/stageAssets";
import type {
  CommitStamps,
  SceneHostSummary,
  StageProject,
  StageRole,
  StageSize,
  ToWindow,
  ToWorker,
  WindowNotice,
  WindowRequest,
  WorkerRequest,
} from "../engine/stageProtocol";
import { setNativePort } from "../engine/stageRealm";
import { useStageRegistry } from "../engine/stageRegistry";
import { beginStillsRun, type StillsRun } from "../engine/stillsRun";
import { useTextKeyRegistry } from "../engine/textKeyRegistry";
import { PresentStageTree } from "../present/PresentStageTree";
import { useEditorStore } from "../store/editorStore";
import { registerWorkspaceFont, SDF_GLYPH_SIZE } from "../theme/fonts";
import {
  emojiRasterVersion,
  subscribeEmojiRasters,
  unrenderableEmojiClusters,
} from "../toolkit/text/emojiRaster";
import { mirroredStores } from "./mirroredStores";
import { mirrorStores } from "./storeMirror";
import { takeWorkerInbox } from "./workerInbox";
import { createWorkerNativePort } from "./workerNativePort";

/**
 * The stage worker's server: owns the react-three-fiber root on the window's OffscreenCanvas,
 * answers the protocol (compile, load, export frames, captures, stills pages, snapshots, hit
 * tests), mirrors the stores both ways and reports what the window chrome needs per frame
 * (commit stamps, gizmo targets, the camera, pickers, hosts, cursor). No Tauri IPC exists in
 * this realm; the native port forwards every need to the window. See docs/architecture.md.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: ToWindow, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

// ── Native port over the protocol ────────────────────────────────────────────
const pendingPort = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: (v: unknown) => void }
>();
let nextPortId = 1;
const port = createWorkerNativePort(
  (method, args, onProgress) =>
    new Promise((resolve, reject) => {
      const id = nextPortId++;
      pendingPort.set(id, { resolve, reject, onProgress });
      const transfer: Transferable[] = [];
      for (const arg of args)
        if (arg instanceof Uint8Array) transfer.push(arg.buffer as ArrayBuffer);
      post({ type: "port", id, method, args } satisfies WorkerRequest, transfer);
    }),
);
setNativePort(port);

// ── Realm setup ──────────────────────────────────────────────────────────────
installDevPerformanceDrain();
// `<Canvas>` extends the catalogue on import; a bare root must do it itself.
extend(THREE as unknown as Parameters<typeof extend>[0]);
// The atlas canvas is a WebGL OffscreenCanvas here, and WebKit's upload of one is not the raw copy an HTMLCanvasElement's is (jagged, speckled glyph edges); troika reads the pixels back instead.
configureTextBuilder({ sdfGlyphSize: SDF_GLYPH_SIZE, sdfAtlasReadback: true });

/** Image textures decode through fetch + createImageBitmap: three's ImageLoader needs an `<img>`, which the worker has not. Orientation follows the texture's `flipY` (read after the synchronous caller settled it, so glTF's `flipY = false` holds), alpha stays straight. Measured byte-identical to the `<img>` path on the gate projects (docs/determinism.md). */
(TextureLoader.prototype as unknown as { load: unknown }).load = function load(
  this: TextureLoader,
  url: string,
  onLoad?: (texture: Texture) => void,
  _onProgress?: unknown,
  onError?: (err: unknown) => void,
) {
  const texture = new Texture();
  const resolved = this.manager.resolveURL(this.path ? this.path + url : url);
  this.manager.itemStart(resolved);
  fetch(resolved)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch ${resolved}: HTTP ${r.status}`);
      return r.blob();
    })
    .then((blob) =>
      createImageBitmap(blob, {
        imageOrientation: texture.flipY ? "flipY" : "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "default",
      }),
    )
    .then(
      (bitmap) => {
        texture.image = bitmap;
        texture.needsUpdate = true;
        onLoad?.(texture);
        this.manager.itemEnd(resolved);
      },
      (err) => {
        onError?.(err);
        this.manager.itemError(resolved);
        this.manager.itemEnd(resolved);
      },
    );
  return texture;
};

// ── Stage state ──────────────────────────────────────────────────────────────
interface StageState {
  project: LoadedProject | null;
  cutout: Parameters<typeof StagePointer>[0]["cutout"];
}
const useStageStore = create<StageState>(() => ({ project: null, cutout: null }));

let role: StageRole = "editor";
let store: RootStore | null = null;
let canvas: OffscreenCanvas | null = null;
let size: StageSize = { width: 1, height: 1, dpr: 1 };
const projectSeqs = new WeakMap<object, number>();
let activeExport: ExportRun | null = null;
let activeStills: StillsRun | null = null;

// ── Store mirror ─────────────────────────────────────────────────────────────
const mirror = mirrorStores(
  {
    ...mirroredStores(),
    clock: useClockStore as never,
    sceneText: useSceneTextRegistry as never,
    textKey: useTextKeyRegistry as never,
    stage: useStageRegistry as never,
    depthStage: useDepthStageRegistry as never,
  },
  (name, patch) => post({ type: "store", name, patch }),
);

// ── Canvas tree ──────────────────────────────────────────────────────────────
/** Worker twin of the editor's PreviewClock: a clock write invalidates the demand loop so playback renders through the compositor. */
function PreviewClock() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(
    () =>
      useClockStore.subscribe((state, prev) => {
        if (state.currentMs !== prev.currentMs) invalidate();
      }),
    [invalidate],
  );
  return null;
}

let lastFrameJson = "";

/** After every composited frame: the 2D gizmo targets projected through the live camera and the camera itself, posted only when something moved. */
function reportFrame(camera: Camera): void {
  const targets = projectGizmoTargets(camera);
  const frame = cameraFrameOf(camera);
  const json = JSON.stringify([targets, frame]);
  if (json === lastFrameJson) return;
  lastFrameJson = json;
  post({ type: "frame", targets, camera: frame });
}

function FrameReporter() {
  const camera = useThree((s) => s.camera);
  // Priority 2: after the compositor driver's takeover render (priority 1), so the targets describe the frame on screen.
  useFrame(() => reportFrame(camera), 2);
  return null;
}

function EditorTree() {
  const project = useStageStore((s) => s.project);
  const cutout = useStageStore((s) => s.cutout);
  const theme = useEditorStore((s) => s.theme);
  return (
    <>
      <color attach="background" args={[theme.colors.background]} />
      <PreviewClock />
      <ExportBridge />
      <StagePointer cutout={cutout} />
      <RenderSettingsApplier />
      {project && (
        <CompositorDriver
          projectId={project.id}
          slots={project.slots}
          cameraTrack={project.cameraTrack}
          sceneDocs={project.sceneDocs}
          theme={project.theme}
          sceneThemes={project.sceneThemes}
          projectLighting={project.projectLighting}
          sceneFrames={project.sceneFrames}
          compareBDocs={project.compareBDocs}
          compareBThemes={project.compareBThemes}
          roomThemes={project.roomThemes}
          motionBlur={project.renderSettings.motionBlur}
          music={project.music}
          commitStamp={project}
        />
      )}
      <StageScenes project={project} />
      <FrameReporter />
    </>
  );
}

function PresentTree() {
  const project = useStageStore((s) => s.project);
  return <PresentStageTree project={project} />;
}

function RenderTree() {
  const project = useStageStore((s) => s.project);
  const theme = useEditorStore((s) => s.theme);
  return (
    <>
      <color attach="background" args={[theme.colors.background]} />
      <ExportBridge />
      <RenderSettingsApplier />
      <ProjectCommitStamp project={project} />
      <StageScenes project={project} />
    </>
  );
}

// ── Reports to the window ────────────────────────────────────────────────────
let stampsQueued = false;
function stamps(): CommitStamps {
  const local = localCommitStamps();
  return {
    clockMs: local.clockMs,
    shutterSeq: local.shutterSeq,
    holdsVersion: local.holdsVersion,
    projectSeq: local.project ? (projectSeqs.get(local.project as object) ?? null) : null,
    primaryHosts: getSceneHosts().filter((h) => h.side === undefined).length,
  };
}
function queueStamps(): void {
  if (stampsQueued) return;
  stampsQueued = true;
  queueMicrotask(() => {
    stampsQueued = false;
    post({ type: "commit", stamps: stamps() });
  });
}
onCanvasCommit(queueStamps);
subscribeSceneHosts(() => {
  queueStamps();
  const hosts: SceneHostSummary[] = getSceneHosts().map((h) => ({
    index: h.index,
    id: h.id,
    startMs: h.startMs,
    durationMs: h.durationMs,
    ...(h.side ? { side: h.side } : {}),
  }));
  post({ type: "hosts", hosts });
});
subscribeGizmoPickers(() =>
  post({
    type: "pickers",
    pickers: gizmoPickerHandles().map((h) => ({
      domain: h.domain,
      itemId: h.itemId,
      sceneIndex: h.sceneIndex,
    })),
  }),
);
subscribeClipExtraction(() =>
  post({ type: "clips", extracting: clipExtractionCount(), progress: clipExtractionProgress() }),
);
subscribeEmojiRasters(() =>
  post({
    type: "emoji",
    version: emojiRasterVersion(),
    unrenderable: [...unrenderableEmojiClusters().entries()],
  }),
);
onGlContextLoss((loss) =>
  post({
    type: "contextLost",
    lossClass: loss.lossClass,
    deliberate: loss.lossClass === "deliberate",
  }),
);

// ── Pointer events ───────────────────────────────────────────────────────────
function dispatchPointer(event: Extract<WindowNotice, { type: "pointer" }>["event"]): void {
  if (!canvas) return;
  const e = new Event(event.kind, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: event.x },
    clientY: { value: event.y },
    offsetX: { value: event.x },
    offsetY: { value: event.y },
    pageX: { value: event.x },
    pageY: { value: event.y },
    button: { value: event.button },
    buttons: { value: event.buttons },
    pointerId: { value: event.pointerId },
    pointerType: { value: event.pointerType },
    shiftKey: { value: event.shiftKey },
    ctrlKey: { value: event.ctrlKey },
    altKey: { value: event.altKey },
    metaKey: { value: event.metaKey },
    deltaX: { value: event.deltaX ?? 0 },
    deltaY: { value: event.deltaY ?? 0 },
    isPrimary: { value: true },
  });
  canvas.dispatchEvent(e);
  // TransformControls follows a drag on the owner document.
  if (
    event.kind === "pointermove" ||
    event.kind === "pointerup" ||
    event.kind === "pointercancel"
  ) {
    const doc = (scope as unknown as { document?: EventTarget }).document;
    const again = new Event(event.kind, { bubbles: false, cancelable: true });
    Object.defineProperties(again, {
      clientX: { value: event.x },
      clientY: { value: event.y },
      button: { value: event.button },
      buttons: { value: event.buttons },
      pointerId: { value: event.pointerId },
      pointerType: { value: event.pointerType },
      shiftKey: { value: event.shiftKey },
      ctrlKey: { value: event.ctrlKey },
      altKey: { value: event.altKey },
      metaKey: { value: event.metaKey },
    });
    doc?.dispatchEvent(again);
  }
}

// ── Project hydration ────────────────────────────────────────────────────────
function hydrate(stageProject: StageProject, seq: number): LoadedProject {
  const { scenes, persistentKey, assets, fonts, ...rest } = stageProject;
  setStageAssetTable(stageProject.id, assets);
  for (const font of fonts) registerWorkspaceFont(font.family, font.weight, font.url);
  const loaded: LoadedProject = {
    ...rest,
    scenes: scenes.map((scene) => {
      const module = scene.key ? sceneModuleFor(scene.key) : undefined;
      if (module)
        return {
          ...module,
          id: scene.id,
          durationMs: scene.durationMs,
          key: scene.key ?? undefined,
        };
      return sceneErrorCard({
        file: scene.errorCard?.file ?? scene.id,
        message: scene.errorCard?.message ?? "the stage holds no module for this scene",
        durationMs: scene.durationMs,
      });
    }),
    ...(persistentKey ? { persistent: persistentComponentFor(persistentKey), persistentKey } : {}),
  };
  projectSeqs.set(loaded, seq);
  return loaded;
}

// ── Requests ─────────────────────────────────────────────────────────────────
async function handle(req: WindowRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (req.type) {
    case "configure": {
      size = req.size;
      if (canvas) (canvas as OffscreenCanvas & { __css?: StageSize }).__css = size;
      await store?.getState().set({ frameloop: req.frameloop });
      store?.getState().setSize(size.width, size.height);
      store?.getState().setDpr(size.dpr);
      store?.getState().invalidate();
      return { value: null };
    }
    case "compileScenes":
      return { value: await localSceneModuleProvider.compile(req.projectId, req.entries) };
    case "compilePersistent":
      return { value: await compilePersistentModule(req.projectId, req.entry) };
    case "loadProject": {
      const loaded = req.project ? hydrate(req.project, req.seq) : null;
      useStageStore.setState({ project: loaded });
      if (loaded) useClockStore.getState().setDurationMs(loaded.totalMs);
      return { value: null };
    }
    case "awaitHosts":
      await awaitSceneHostsCommitted(req.expected);
      return { value: null };
    case "settle": {
      const project = useStageStore.getState().project;
      if (!project || project.id !== req.projectId) return { value: null };
      await settleProjectOpen(project, (completed) =>
        post({ type: "progress", id: req.id, value: completed }),
      );
      return { value: null };
    }
    case "exportBegin": {
      if (activeExport) throw new Error("an export run is already open");
      activeExport = await beginExportRun(req.opts, (step) =>
        post({ type: "progress", id: req.id, value: step }),
      );
      return { value: { total: activeExport.total } };
    }
    case "exportFrame": {
      if (!activeExport) throw new Error("no export run is open");
      const out = await renderExportFrame(
        activeExport,
        req.frame,
        req.tMs,
        req.buffer,
        req.fingerprint,
      );
      return {
        value: { rgba: out.rgba, boundClipFrame: out.boundClipFrame, fingerprint: out.fingerprint },
        transfer: [out.rgba.buffer as ArrayBuffer],
      };
    }
    case "exportEnd": {
      const run = activeExport;
      activeExport = null;
      if (run) endExportRun(run);
      return { value: null };
    }
    case "holdExport":
      setExporting(req.on);
      return { value: null };
    case "captureFrame": {
      const out = await captureFrameRun(req.opts, req.tMs);
      return { value: out, transfer: [out.rgba.buffer as ArrayBuffer] };
    }
    case "stillsBegin": {
      if (activeStills) throw new Error("a stills run is already open");
      activeStills = await beginStillsRun(req.opts, req.settings, (step) =>
        post({ type: "progress", id: req.id, value: step }),
      );
      const { total, pageTimesMs, warnings, pageMeta } = activeStills;
      return { value: { total, pageTimesMs, warnings, pageMeta } };
    }
    case "stillsPage": {
      if (!activeStills) throw new Error("no stills run is open");
      const out = await activeStills.render(req.page);
      return { value: out, transfer: [out.body.buffer as ArrayBuffer] };
    }
    case "stillsEnd": {
      const run = activeStills;
      activeStills = null;
      run?.end();
      return { value: null };
    }
    case "snapshot": {
      const bytes = await snapshotRun(req.tMs, req.width, req.format);
      return { value: bytes, transfer: bytes ? [bytes.buffer as ArrayBuffer] : [] };
    }
    case "perfRun": {
      const project = useStageStore.getState().project;
      if (!project) throw new Error("perf: no project is loaded in the stage");
      return { value: await runPerfProbe(project) };
    }
    case "perfColdWaits":
      return { value: perfColdWaits() };
    case "hitTest": {
      const hit = gizmoHandleAt(req.ndcX, req.ndcY, req.domain);
      if (hit && req.claim) hit.claim?.();
      return {
        value: hit ? { domain: hit.domain, itemId: hit.itemId, sceneIndex: hit.sceneIndex } : null,
      };
    }
    case "census":
      return { value: glContextCensus() };
    case "forceContextLoss":
      canvasHandle.current?.gl.forceContextLoss();
      return { value: null };
    case "releasePools":
      releaseCompositorPools();
      releaseComposer();
      return { value: null };
    case "invalidateClips":
      await invalidateChangedClips();
      return { value: null };
    case "evictClips":
      evictAllClips();
      return { value: null };
  }
}

function isRequest(msg: ToWorker): msg is WindowRequest {
  return "id" in msg && msg.type !== "reply";
}

async function boot(init: Extract<WindowNotice, { type: "init" }>): Promise<void> {
  role = init.role;
  canvas = init.canvas;
  size = init.size;
  (canvas as OffscreenCanvas & { __css?: StageSize }).__css = size;
  for (const { name, patch } of init.stores) mirror.apply(name, patch);
  const root = createRoot(init.canvas);
  await root.configure({
    size: { width: size.width, height: size.height, top: 0, left: 0 },
    dpr: size.dpr,
    frameloop: init.frameloop,
    gl: { preserveDrawingBuffer: true, antialias: true },
    shadows: { enabled: true, type: SHADOW_MAP_TYPE },
    camera: { position: CAMERA.position, fov: CAMERA.fov },
    onCreated: (state) => {
      store = state as unknown as RootStore;
      const gl = state.gl;
      // Area lights need the LTC uniforms initialised once, at renderer creation, never lazily on first light (a first-frame init would race the export preamble). Global and idempotent.
      ensureRectAreaLightUniforms();
      tagGlCanvas(gl.domElement, "stage");
      trackContextLosses(gl.domElement as unknown as HTMLCanvasElement);
      post({
        type: "ready",
        version: 1,
        gl: `${JSON.stringify(gl.getContext().getContextAttributes())} maxSamples=${gl.capabilities.maxSamples} extColorBufferFloat=${gl.extensions.has("EXT_color_buffer_float")}`,
      });
    },
  });
  store = root.render(
    role === "render" ? <RenderTree /> : role === "present" ? <PresentTree /> : <EditorTree />,
  );
  // The window's pointer events reach r3f's own raycaster through the canvas stand-in.
  const events = store.getState().events;
  events.connect?.(init.canvas as unknown as HTMLElement);
}

takeWorkerInbox((ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "portProgress") {
    pendingPort.get(msg.id)?.onProgress?.(msg.value);
    return;
  }
  if (msg.type === "reply") {
    const p = pendingPort.get(msg.id);
    if (!p) return;
    pendingPort.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error));
    return;
  }
  if (msg.type === "init") {
    void boot(msg).catch((e) =>
      post({
        type: "fatal",
        text: `boot: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      }),
    );
    return;
  }
  if (isRequest(msg)) {
    void handle(msg).then(
      ({ value, transfer }) => post({ type: "reply", id: msg.id, ok: true, value }, transfer),
      (e) =>
        post({
          type: "reply",
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          ...(e && typeof e === "object" && "reason" in e
            ? { stall: String((e as { reason: unknown }).reason) }
            : {}),
        }),
    );
    return;
  }
  switch (msg.type) {
    case "store":
      mirror.apply(msg.name, msg.patch);
      return;
    case "pointer":
      dispatchPointer(msg.event);
      return;
    case "cutout":
      useStageStore.setState({ cutout: msg.rect });
      return;
    case "assetsChanged":
      setStageAssetTable(msg.projectId, msg.assets);
      return;
    case "conformProgress":
      port.deliverConformProgress(msg.payload as never);
      return;
    case "conformMediaChanged":
      port.deliverConformMediaChanged(msg.slug, msg.paths);
      return;
    case "previewFlags":
      if (msg.clipStride !== undefined) setPreviewClipStride(msg.clipStride);
      if (msg.motionBlurSamples !== undefined) setPreviewMotionBlurPlayback(msg.motionBlurSamples);
      if (msg.playbackActive !== undefined) setPreviewPlaybackActive(msg.playbackActive);
      if (msg.slideshowActive !== undefined) setPresentSlideshowActive(msg.slideshowActive);
      if (msg.hardwareVideo !== undefined) setHardwareVideo(msg.hardwareVideo);
      return;
  }
});
