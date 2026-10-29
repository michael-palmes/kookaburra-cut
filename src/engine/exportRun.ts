import { flushSync } from "react-dom";
import type { Camera, Object3D, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { Vector2 } from "three";
import { collectThemeFontRefs, preloadAppFonts } from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import { preloadCatalogModels } from "../toolkit/device/catalog";
import { preloadDeviceModels } from "../toolkit/device/models";
import { preloadChipIcons } from "../toolkit/frame/chipIcons";
import { preloadHeroModels } from "../toolkit/hero/models";
import { preloadSceneObjects } from "../toolkit/objects/preload";
import { preloadBundledBackdrops } from "../toolkit/stage/backdrops";
import { awaitEmojiRastersIdle, preloadEmojiRasters } from "../toolkit/text/emojiRaster";
import { preloadText3dFonts } from "../toolkit/text3d/fonts";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { useChartEditStore } from "./chartEditStore";
import { CLIP_ACTIVE_LEAD_MS } from "./clipChunks";
import { clipFrameIndex, deviceClipFrameIndex } from "./clipFrame";
import {
  awaitVideoFramesReady,
  type ClipDemand,
  everydayClipLane,
  laneForCodec,
  prepareExportClips,
  releaseIdleClipFrames,
  setClipLane,
} from "./clips";
import { useClockStore } from "./clock";
import { useDeviceEditStore } from "./deviceEditStore";
import { deviceVideoSlots } from "./deviceScreens";
import { preloadEffectLuts } from "./effects";
import {
  collectEnvironmentSources,
  collectMirrorRequestsWithCompare,
  preloadEnvironments,
  preloadMirrorEnvironments,
} from "./environments";
import { canvasHandle } from "./exportBridge";
import {
  awaitCanvasClockCommit,
  awaitTextSync,
  buildFramePlans,
  clearShutterSample,
  drawPlannedFrame,
  type FrameRig,
  renderFrameInto,
} from "./exportFrame";
import { normalExportFrameCount, posterFrameSample } from "./exportFrames";
import { setExporting } from "./exportState";
import { computeFormat } from "./format";
import { preloadPanelMeasures } from "./framePanelMeasure";
import { useImageEditStore } from "./imageEditStore";
import { HELPER_LAYER } from "./lightEditStore";
import { yieldMacrotask } from "./macrotask";
import { useObjectEditStore } from "./objectEditStore";
import { preloadOverlayPanelImages } from "./overlayPanelTexture";
import { overlayPanelImageSources } from "./overlayPlan";
import { hasSceneHolds } from "./presentHold";
import { assertProjectRelative, preloadProjectImages } from "./project";
import { assertContextHeld, readFrameOrThrow } from "./readback";
import { type RenderStateFingerprint, renderStateFingerprint } from "./renderFingerprint";
import { hasSceneCameraTracks } from "./sceneCamera";
import { collectSceneDocFontRefs } from "./sceneDocSchema";
import { getSceneHosts } from "./sceneHostRegistry";
import { resolveSceneDocMedia } from "./sceneMedia";
import { mosaicTileKind } from "./sceneMosaic";
import { resolveAt } from "./sceneTimeline";
import type { StageExportOptions } from "./stageProtocol";
import { clipSourceKey } from "./stageRealm";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { useTerminalEditStore } from "./terminalEditStore";
import { configureDeterministicEngine } from "./timeline";
import { awaitTitleMeasuresSettled } from "./titleBlockMeasure";
import { preloadTransitionMasks } from "./transitionMask";
import { useWebsiteEditStore } from "./websiteEditStore";

/** The export run as the stage worker executes it: the deterministic preamble, one frame at a time into a readback buffer, and the restore. The window owns every native effect (start, push, finish) and drives these through the stage protocol; this module never names a path and never invokes. The GL call sequence per frame is `renderFrameInto`, unchanged from the single-realm loop (docs/determinism.md). */

/** Waits until every scene's host is registered, i.e. the canvas tree has actually committed the scenes. All scenes mount inside one shared `<Suspense fallback={null}>`; on a cold load a suspending primitive (ImageCard's `useTexture`) keeps the whole boundary out of the graph until React's retry commits, which races the export preamble on the wall clock, and frame 0 rendered before it lands captures a scene-less frame (the showcase-tour white-first-frame flake) that the clock barrier can't catch since the clock is already committed at its initial 0. Host registration runs in a `useEffect` after the boundary's content commits, so counting hosts observes exactly the state frame 0 needs; called after the asset preloads so the spin exits within a few ticks. Exported for the theme-preview batch, which swaps projects the same way. */
export async function awaitSceneHostsCommitted(expected: number): Promise<void> {
  const primaryHostCount = (): number =>
    getSceneHosts().filter((host) => host.side === undefined).length;
  for (let spins = 0; primaryHostCount() < expected; spins++) {
    if (spins > 5000) {
      throw new Error(
        `Scene tree never committed: ${primaryHostCount()}/${expected} primary scene hosts registered.`,
      );
    }
    await yieldMacrotask();
  }
}

/**
 * Every sidecar-declared video per source, each with the frames its slot shows over the scene window `[−500, duration + 500]` ms (the consumers' near gate): device screens through `deviceClipFrameIndex`, media entries, layered-screenshot cards and mosaic tiles through `clipFrameIndex` with their loop semantics, on both comparison sides. Layered-screenshot cards and screens behind a model's suspense mount after the last barrier, so the barrier must already know them. A screen timed by a fold opening (`startOn: "open"`) is declared with no demand: its mounted consumer covers it, else it takes the whole clip.
 */
function declaredClipDemands(opts: StageExportOptions): Map<string, ClipDemand[]> {
  const declared = new Map<string, ClipDemand[]>();
  const declare = (src: string, demand: ClipDemand | null) => {
    const source = clipSourceKey({ projectId: opts.projectId, rel: assertProjectRelative(src) });
    const list = declared.get(source) ?? [];
    if (demand) list.push(demand);
    declared.set(source, list);
  };
  const docs = [
    ...(opts.sceneDocs ?? []).map((doc, i) => ({ doc, slot: opts.slots[i] })),
    ...(opts.compareBDocs ?? []).map((doc, i) => ({ doc, slot: opts.slots[i] })),
  ];
  for (const { doc, slot } of docs) {
    if (!doc) continue;
    const window: [number, number] | null = slot
      ? [-CLIP_ACTIVE_LEAD_MS, slot.durationMs + CLIP_ACTIVE_LEAD_MS]
      : null;
    const clip = (startMs: number, loop: boolean): ClipDemand | null =>
      window && {
        window,
        sceneStartMs: slot?.startMs ?? 0,
        frameAt: (ms, info) => clipFrameIndex(ms, startMs, info.fps, info.frameCount, loop),
      };
    for (const layer of doc.layeredScreenshot?.layers ?? []) {
      for (const item of layer.items ?? []) {
        if (item.kind === "screen" && item.media === "video" && typeof item.src === "string") {
          declare(item.src, clip(typeof item.startMs === "number" ? item.startMs : 0, false));
        }
      }
    }
    for (const entry of resolveSceneDocMedia(doc)) {
      if (entry.kind === "video") {
        declare(entry.src, clip(entry.video?.startMs ?? 0, entry.video?.loop === true));
      }
    }
    for (const tile of doc.mosaic?.tiles ?? []) {
      if (mosaicTileKind(tile) === "video") {
        declare(tile.src as string, clip(tile.startMs ?? 0, tile.loop === true));
      }
    }
    for (const device of doc.devices ?? []) {
      for (const media of deviceVideoSlots(doc, device)) {
        declare(
          media.src,
          window && media.startOn !== "open"
            ? {
                window,
                sceneStartMs: slot?.startMs ?? 0,
                frameAt: (ms, info) =>
                  deviceClipFrameIndex(ms, 0, media, info.fps, info.frameCount),
              }
            : null,
        );
      }
    }
  }
  return declared;
}

/** The deterministic preamble shared by exportProject, captureScreenshot and the stills export; barrier order is pinned (docs/determinism.md). `onStep` reports coarse-phase completion for the UI overlay only. */
export async function exportPreamble(
  opts: StageExportOptions,
  gl: WebGLRenderer,
  onStep?: (step: number) => void,
  /** A one-frame capture's project time: clips extract only the frames that instant shows. */
  atMs?: number,
): Promise<void> {
  configureDeterministicEngine();
  // Explicit, not incidental: an object, chart, device, image or terminal gizmo selected when an export starts must never reach a frame.
  useObjectEditStore.getState().select(null);
  useChartEditStore.getState().select(null);
  useDeviceEditStore.getState().select(null);
  useImageEditStore.getState().select(null);
  useTerminalEditStore.getState().select(null);
  useWebsiteEditStore.getState().select(null);
  // With themes, preloads exactly the fonts the project renders (bundled and workspace-pinned system fonts, plus sidecar `<key>Font` overrides), comparison side-B themes included: a B-only face loaded at first typeset would land outside every barrier, the per-boot atlas lottery. The no-theme form preloads the bundled defaults.
  await preloadAppFonts(
    opts.theme
      ? [
          ...collectThemeFontRefs([
            opts.theme,
            ...(opts.sceneThemes ?? []),
            ...(opts.compareBThemes ?? []),
          ]),
          ...collectSceneDocFontRefs(opts.sceneDocs ?? []),
        ]
      : undefined,
  );
  // Deterministic codecs read the software-decoded frame lane (the one baselines were recorded from); fast-draft hardware codecs keep the everyday hw lane. Restored in the run's finally, preamble throws included.
  setClipLane(laneForCodec(opts.encode?.codec ?? opts.codec));
  // Extracts, before frame 0, the chunks every sidecar-declared video needs over its scene window, mirroring font preload so no frame races an async decode; cached chunks make it a no-op after the first.
  const declaredClips = declaredClipDemands(opts);
  await prepareExportClips(declaredClips, { consumers: false, atMs });
  onStep?.(1);
  // Fetches + parses bundled 3D models and this project's screen images (and warms drei's caches) before frame 0, so a cold export never captures a still-loading DeviceMockup; no-op once cached. See docs/determinism.md.
  await preloadDeviceModels();
  await preloadCatalogModels();
  await preloadHeroModels();
  // Staged library objects referenced by any scene (and compare side B), the same barrier over a dynamic id set.
  await preloadSceneObjects([...(opts.sceneDocs ?? []), ...(opts.compareBDocs ?? [])]);
  await preloadProjectImages(opts.projectId);
  // Image-mask transitions sample their SDF at the render seam, so each one is built and uploaded here; a missing or unreadable mask fails the run.
  await preloadTransitionMasks(opts.slots, gl);
  onStep?.(2);
  // Parses the bundled typeface JSON for ExtrudedText (synchronous today; the barrier is kept so a future fetched font can't race frame 0).
  await preloadText3dFonts();
  // Preloads the project's LUT textures (usually cached by loadProject already) and forces their GPU upload before frame 0, since a mid-run first-use upload is exactly the async-asset race this preamble exists to prevent. See docs/determinism.md.
  await preloadEffectLuts({ gl });
  // Resolves every environment source across the v8 theme blocks and the v9 lighting layers (RGBE/EXR decode + PMREM) before frame 0, since a themed frame must never find its environment texture still loading; a missing USER source rejects here and fails the run loudly. Env-mirror bakes ride the same barrier (one-shot fromScene, cached by content key).
  if (opts.theme) {
    await preloadEnvironments(
      gl,
      collectEnvironmentSources(
        opts.projectId,
        [
          opts.theme,
          ...(opts.sceneThemes ?? []),
          ...(opts.compareBThemes ?? []).filter((t): t is Theme => !!t),
        ],
        opts.projectLighting,
        [...(opts.sceneDocs ?? []), ...(opts.compareBDocs ?? []).filter(Boolean)],
      ),
    );
    await preloadMirrorEnvironments(
      gl,
      collectMirrorRequestsWithCompare(
        opts.projectId,
        opts.sceneThemes ?? [],
        opts.projectLighting,
        opts.sceneDocs,
        opts.compareBThemes,
        opts.compareBDocs,
      ),
    );
  }
  // Bundled backdrop images load through an awaited module cache, never suspense (the loft-1 stale-capture lesson); settle them before frame 0.
  await preloadBundledBackdrops();
  // Bundled chip icon PNGs (the frame chip's mark) settle before frame 0, alongside the other bundled assets.
  await preloadChipIcons();
  // Colour-emoji rasters for every sidecar string settle before frame 0 (write-once per-project cache; docs/determinism.md "Emoji").
  await preloadEmojiRasters(opts.projectId, opts.sceneDocs ?? []);
  // Overlay panel title/subtitle measurements settle before frame 0, so the panel lays out from real troika blocks on every frame (framePanelMeasure.ts); image panel fills settle in the same block, since the compositor samples them at the render seam with no way to suspend.
  if (opts.sceneFrames?.some(Boolean)) {
    await preloadOverlayPanelImages(
      opts.projectId,
      overlayPanelImageSources(opts.sceneFrames ?? []),
    );
    const panelThemes = (opts.sceneFrames ?? []).map((_, i) => opts.sceneThemes?.[i] ?? opts.theme);
    await preloadPanelMeasures(
      computeFormat(opts.format),
      opts.sceneFrames ?? [],
      opts.sceneDocs ?? [],
      panelThemes,
    );
  }
  onStep?.(3);
  // Last barrier: the scenes must actually be in the canvas tree. A cold-load suspense (shared boundary) can still be holding every scene out of the graph at this point, but the preloads above have resolved its assets so the retry commit is imminent; wait for it or frame 0 captures a scene-less frame. See awaitSceneHostsCommitted.
  await awaitSceneHostsCommitted(opts.slots.length);
  // A second extract pass over every mounted consumer's own window and held frame: clips registered by primitives that only mounted at the barrier above (a video background or code-authored VideoClip behind the shared suspense), plus the timing only a mounted consumer knows; a no-op when the first pass already covered them all.
  await prepareExportClips(declaredClips, { consumers: true, atMs });
  // In-world TitleBlocks measure their own title/subtitle blocks, and their props only exist once the scenes are in the tree, so this barrier runs last: settle those typesets and let the tree re-render with them, or frame 0 captures the pre-measure layout (engine/titleBlockMeasure).
  await awaitTitleMeasuresSettled();
}

/** Present holds freeze staged text mid-timeline, so a video frame or capture rendered while the stills export holds scenes would not be the pure function of `t` the contract promises. */
function assertNoSceneHolds(run: "export" | "capture"): void {
  if (hasSceneHolds()) {
    throw new Error(
      `Scene holds are active (a stills export is running), so the ${run} cannot start.`,
    );
  }
}

/** Everything one export run holds between its frames: the live canvas, buffers, plans and the preview state to give back. */
export interface ExportRun {
  rig: FrameRig;
  total: number;
  poster: ReturnType<typeof posterFrameSample> | undefined;
  opts: StageExportOptions;
  restore: () => void;
}

/** The preview state a run or capture snapshots first and gives back whole in its finally, so a failed preamble leaves no export-sized buffer, aspect or clip lane behind. Returns the playhead the run started from. */
function snapshotPreviewState(gl: WebGLRenderer, camera: Camera): () => number {
  const cam = camera as PerspectiveCamera;
  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;
  const prevHelperLayer = cam.layers.isEnabled(HELPER_LAYER);
  return () => {
    setClipLane(everydayClipLane());
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    if (prevHelperLayer) cam.layers.enable(HELPER_LAYER);
    return prevClockMs;
  };
}

/** Sizes the drawing buffer to the export resolution (no CSS resize) and the camera to its aspect. */
function sizeForExport(gl: WebGLRenderer, camera: Camera, width: number, height: number): void {
  const cam = camera as PerspectiveCamera;
  gl.setPixelRatio(1);
  gl.setSize(width, height, false);
  if (cam.isPerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
}

/** The run's preamble and setup: the deterministic preamble, the export-sized buffer, the frame plans and the stale-pose heal. The window drives the frames (`renderExportFrame`) and ends the run (`endExportRun`); this realm holds the export flag for the run's length. */
export async function beginExportRun(
  opts: StageExportOptions,
  onPrepareStep?: (step: number) => void,
): Promise<ExportRun> {
  assertNoSceneHolds("export");
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;
  assertContextHeld(gl.getContext(), "before the export");
  const restorePreview = snapshotPreviewState(gl, camera);
  const cam = camera as PerspectiveCamera;
  // The exporter owns rendering for the whole run; the preview driver stands down (see engine/exportState) so no stray preview render interleaves with a capture.
  setExporting(true);
  releaseIdleClipFrames();
  let clockOwned: () => number | null = () => null;
  const restore = () => {
    setExporting(false);
    releaseIdleClipFrames();
    const prevClockMs = restorePreview();
    // Give the playhead back only if this run wrote it and still owns it; an untouched or since-moved clock stays put.
    const owned = clockOwned();
    if (owned !== null && useClockStore.getState().currentMs === owned) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  };
  try {
    await exportPreamble(opts, gl, onPrepareStep);
    const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);
    const { width, height } = opts.format;
    const normalTotal = normalExportFrameCount(opts.durationMs, opts.fps);
    const poster = opts.encode?.posterFrame ? posterFrameSample(opts.slots, opts.fps) : undefined;
    const total = normalTotal + (poster === undefined ? 0 : 1);
    sizeForExport(gl, camera, width, height);
    const plans = buildFramePlans(opts, sceneFloorYs);
    const rig: FrameRig = {
      gl,
      scene,
      camera,
      ctx: gl.getContext(),
      width,
      height,
      rgba: new Uint8Array(width * height * 4),
      sizeProbe: new Vector2(),
      plans,
      cameraTrack: opts.cameraTrack,
      clockOwnedMs: null,
    };
    clockOwned = () => rig.clockOwnedMs;
    // Stale-pose healing: a fully trackless project never writes the camera inside the loop, and the shared camera persists across project switches, so heal it once before frame 0. Pristine case writes identical floats (fov unchanged, no projection update), so the gated no-track paths stay byte-identical. Mirrored in CompositorDriver.
    if (
      (!opts.cameraTrack || opts.cameraTrack.length === 0) &&
      !hasSceneCameraTracks(plans.sceneTracks)
    ) {
      applyCameraPose(cam, baseCameraPose());
    }
    // Preview-only light helpers can never reach a capture: their layer is disabled on the camera for the whole run (the second guard on top of their mount gating) and given back in the restore.
    cam.layers.disable(HELPER_LAYER);
    return { rig, total, poster, opts, restore };
  } catch (e) {
    restore();
    throw e;
  }
}

/** One frame of the run: into `buffer` when the window hands the previous frame's buffer back (the bytes ping-pong across the boundary without a copy), else the run's own. Frame 0 draws twice so it is never a run's first draw. */
export async function renderExportFrame(
  run: ExportRun,
  frame: number,
  tMs: number,
  buffer: ArrayBuffer | null,
  wantFingerprint: boolean,
): Promise<{
  rgba: Uint8Array;
  boundClipFrame: number;
  fingerprint: RenderStateFingerprint | null;
}> {
  const { rig, opts, poster, total } = run;
  // The previous frame's buffer left this realm (transferred to the window); adopt the one handed back, or a fresh one.
  const bytes = rig.width * rig.height * 4;
  if (buffer && buffer.byteLength === bytes) rig.rgba = new Uint8Array(buffer);
  else if (rig.rgba.byteLength !== bytes) rig.rgba = new Uint8Array(bytes);
  const resolved = frame === 0 && poster ? poster.resolved : resolveAt(opts.slots, tMs);
  let fingerprint: RenderStateFingerprint | null = null;
  await renderFrameInto(
    rig,
    tMs,
    resolved,
    frame === 0 ? 2 : 1,
    `export frame ${frame + 1}/${total}`,
    wantFingerprint
      ? () => {
          fingerprint = renderStateFingerprint(rig.gl, rig.scene);
        }
      : undefined,
  );
  return { rgba: rig.rgba, boundClipFrame: sampleBoundClipFrame(rig.scene), fingerprint };
}

export function endExportRun(run: ExportRun): void {
  run.restore();
}

/** Renders one deterministic frame at tMs through the export path and returns its raw pixels (GL bottom-up row order): the shared core of screenshots, bridge captures and the render window's thumb service. */
export async function captureFrameRun(
  opts: StageExportOptions,
  tMs: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  assertNoSceneHolds("capture");
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;
  assertContextHeld(gl.getContext(), `capture at ${tMs}ms`);

  // Bridge captures run mid-edit: the preamble's selection clear (a gizmo must never reach a frame) is given back once the capture ends, unlike a user-initiated export.
  const prevSelection = {
    object: useObjectEditStore.getState().selected,
    chart: useChartEditStore.getState().selected,
    device: useDeviceEditStore.getState().selected,
    image: useImageEditStore.getState().selected,
  };
  const restoreSelection = () => {
    useObjectEditStore.getState().select(prevSelection.object);
    useChartEditStore.getState().select(prevSelection.chart);
    useDeviceEditStore.getState().select(prevSelection.device);
    useImageEditStore.getState().select(prevSelection.image);
  };
  const restorePreview = snapshotPreviewState(gl, camera);
  const cam = camera as PerspectiveCamera;
  let restoreCameraPose: (() => void) | null = null;
  setExporting(true);
  try {
    await exportPreamble(opts, gl, undefined, tMs);
    const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);
    const { width, height } = opts.format;
    const ctx = gl.getContext();
    const rgba = new Uint8Array(width * height * 4);
    sizeForExport(gl, camera, width, height);
    const plans = buildFramePlans(opts, sceneFloorYs);
    // Trackless projects heal the shared camera to base for the frame; snapshot the live pose (a mid-orbit view stays where the user left it) and give it back afterwards.
    if (
      (!opts.cameraTrack || opts.cameraTrack.length === 0) &&
      !hasSceneCameraTracks(plans.sceneTracks)
    ) {
      const pos = cam.position.clone();
      const quat = cam.quaternion.clone();
      const fov = cam.fov;
      restoreCameraPose = () => {
        cam.position.copy(pos);
        cam.quaternion.copy(quat);
        cam.fov = fov;
        cam.updateProjectionMatrix();
      };
      applyCameraPose(cam, baseCameraPose());
    }
    cam.layers.disable(HELPER_LAYER);
    // One iteration of the export loop's frame block, barrier for barrier.
    flushSync(() => useClockStore.getState().setCurrentMs(tMs));
    await awaitCanvasClockCommit(tMs);
    await clearShutterSample(scene);
    await awaitVideoFramesReady(scene);
    await awaitTextSync(scene);
    await awaitEmojiRastersIdle();
    if (cam.isPerspectiveCamera && cam.aspect !== width / height) {
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
    }
    const resolved = resolveAt(opts.slots, tMs);
    await drawPlannedFrame(
      gl,
      scene,
      camera,
      width,
      height,
      plans,
      opts.cameraTrack,
      resolved,
      tMs,
      1,
    );
    readFrameOrThrow(ctx, width, height, rgba, `capture at ${tMs}ms`);
    return { rgba, width, height };
  } finally {
    setExporting(false);
    const prevClockMs = restorePreview();
    restoreCameraPose?.();
    restoreSelection();
    // Give the playhead back only while the capture still owns it; a scrub mid-capture wins.
    if (useClockStore.getState().currentMs === tMs) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  }
}

/** Verify diagnostic: the clip-frame index stamped on the texture that is actually bound on the scene's clip material right now (-1 when no clip/map); read immediately after render so it reflects what the capture saw. A consumer's readiness node publishes its material (`clipMaterial`), since a Device's node is a bare group. */
function sampleBoundClipFrame(scene: Scene): number {
  type ClipMaterial = { map?: { userData?: { clipFrame?: number } } | null };
  let bound = -1;
  scene.traverse((obj: Object3D) => {
    if (bound !== -1) return;
    const ud = obj.userData as { videoFrameReady?: unknown; clipMaterial?: ClipMaterial };
    if (!ud.videoFrameReady) return;
    const material = ud.clipMaterial ?? (obj as unknown as { material?: ClipMaterial }).material;
    bound = material?.map?.userData?.clipFrame ?? -1;
  });
  return bound;
}
