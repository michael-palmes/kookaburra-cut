import { Channel, invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { Vector2 } from "three";
import type { EncodeSpec } from "../export/presetSchema";
import { collectThemeFontRefs, preloadAppFonts } from "../theme/fonts";
import type { LightingSpec, Theme } from "../theme/tokens";
import { preloadCatalogModels } from "../toolkit/device/catalog";
import { preloadDeviceModels } from "../toolkit/device/models";
import { preloadChipIcons } from "../toolkit/frame/chipIcons";
import type { FrameSpec } from "../toolkit/frame/types";
import { preloadHeroModels } from "../toolkit/hero/models";
import { preloadSceneObjects } from "../toolkit/objects/preload";
import { preloadBundledBackdrops } from "../toolkit/stage/backdrops";
import { awaitEmojiRastersIdle, preloadEmojiRasters } from "../toolkit/text/emojiRaster";
import { preloadText3dFonts } from "../toolkit/text3d/fonts";
import {
  applyCameraPose,
  applyCameraTrack,
  baseCameraPose,
  type CameraKeyframe,
} from "./cameraTrack";
import { useChartEditStore } from "./chartEditStore";
import {
  awaitVideoFramesReady,
  everydayClipLane,
  laneForCodec,
  preextractClips,
  registerClip,
  setClipLane,
} from "./clips";
import { useClockStore } from "./clock";
import { renderComposited } from "./compositor";
import { useDeviceEditStore } from "./deviceEditStore";
import { preloadEffectLuts } from "./effects";
import {
  collectEnvironmentSources,
  collectMirrorRequests,
  preloadEnvironments,
  preloadMirrorEnvironments,
} from "./environments";
import { canvasCommittedClockMs, canvasHandle } from "./exportBridge";
import { exportFrameTimeMs, normalExportFrameCount, posterFrameSample } from "./exportFrames";
import { setExporting, withExporting } from "./exportState";
import { computeFormat, type FormatSpec } from "./format";
import { preloadPanelMeasures } from "./framePanelMeasure";
import { useImageEditStore } from "./imageEditStore";
import { HELPER_LAYER } from "./lightEditStore";
import { yieldMacrotask } from "./macrotask";
import { useObjectEditStore } from "./objectEditStore";
import { preloadOverlayPanelImages } from "./overlayPanelTexture";
import { overlayPanelImageSources, resolveOverlays } from "./overlayPlan";
import {
  isWorkspaceProjectId,
  type ProjectAudio,
  preloadProjectImages,
  resolveAssetPath,
  workspaceSlug,
} from "./project";
import { type RenderStateFingerprint, renderStateFingerprint } from "./renderFingerprint";
import { buildSceneCameraTracks, hasSceneCameraTracks, resolveFrameCameras } from "./sceneCamera";
import { compareSpecOf, resolveCompareFrame } from "./sceneCompare";
import { collectSceneDocFontRefs, type SceneDoc } from "./sceneDocSchema";
import { getSceneHosts } from "./sceneHostRegistry";
import {
  buildCompareBLightingTracks,
  buildLightingTracks,
  resolveFrameLighting,
} from "./sceneLighting";
import { resolveSceneDocMedia } from "./sceneMedia";
import { buildSceneRenderStates, resolveFrameSceneStates } from "./sceneState";
import { resolveAt, type SceneSlot } from "./sceneTimeline";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { useTerminalEditStore } from "./terminalEditStore";
import { configureDeterministicEngine } from "./timeline";
import { awaitTitleMeasuresSettled } from "./titleBlockMeasure";

/** Export encoder: libx264 is deterministic (the v0 default), videotoolbox is hardware-fast, prores_ks is software ProRes 422 HQ (10-bit 4:2:2, .mov container). */
export type Codec = "libx264" | "h264_videotoolbox" | "prores_ks";

export interface ExportOptions {
  /** Project id; drives the output path (~/Kookaburra Cut/<projectId>/<projectId>-<aspect>.<ext>, extension codec-dependent: .mp4 for H.264, .mov for ProRes). */
  projectId: string;
  /** The render clock rate: FPS (60) everywhere except preset lanes whose spec says 30, where the loop steps output instants directly, since `i·(1000/30)` is bit-identical to `2i·(1000/60)` in float64, so the frames are the same bytes the old ffmpeg `fps=30` decimation kept, at half the render time. */
  fps: number;
  durationMs: number;
  format: FormatSpec;
  /** Overlap-aware scene placement; per-frame the loop resolves the active scene(s). */
  slots: SceneSlot[];
  /** The project soundtrack; absent means the `-an` argv is byte-for-byte pre-audio. */
  audio?: ProjectAudio;
  /** The project's camera keyframe track; absent means the camera is never touched. */
  cameraTrack?: CameraKeyframe[];
  /** Sidecar scene docs, index-aligned with `slots`; per-scene camera tracks live here. Absent (or no doc declares a track) means the legacy camera path runs unchanged. */
  sceneDocs?: (SceneDoc | undefined)[];
  /** The project's theme + resolved per-scene themes; drive the per-target scene-state plan (background/environment). Absent means the root scene is never touched (the byte-identical legacy paths). */
  theme?: Theme;
  sceneThemes?: Theme[];
  /** The manifest's project-default lighting layer (v9); feeds per-scene environment resolution and the environment preload barrier. */
  projectLighting?: LightingSpec;
  /** Per-scene resolved overlays; absent (or all undefined) means no scene renders through a cutout, the byte-identical legacy path. */
  sceneFrames?: (FrameSpec | undefined)[];
  /** Comparison side-B docs/themes (`LoadedProject.compareBDocs`/`compareBThemes`); absent (or all undefined) means the compare path never engages. */
  compareBDocs?: (SceneDoc | undefined)[];
  compareBThemes?: (Theme | undefined)[];
  /** Encoder; defaults to the deterministic libx264. */
  codec?: Codec;
  /** The resolved encode spec (presets/custom). Absent means the frozen legacy argv, byte-pinned in Rust; standing baselines and Verify never carry one. */
  encode?: EncodeSpec;
  /** Output filename suffix: preset id or "custom", the file becomes `<project>-<aspect>-<suffix>.<ext>`. Absent means the exact legacy name. */
  outputSuffix?: string;
  /** "downloads" routes the final file to ~/Downloads (the app's Settings toggle). Absent means the canonical project paths; autorun/terminal exports never set it. */
  destination?: "downloads";
}

export interface ExportProgress {
  frame: number;
  total: number;
}

export interface DeterminismResult {
  identical: boolean;
  hashA: string;
  hashB: string;
  // Failure diagnostics (present only when not identical).
  /** Total count of frames whose pixels differed; zero with differing file hashes means the pixels matched and the encoder side diverged instead. */
  divergentCount?: number;
  /** Divergent frame indices as compact [start, end] inclusive ranges (full extent, no cap). */
  divergentRanges?: [number, number][];
  /** For the first few divergent frames: which cells of an 8×8 grid (row-major, 0=top-left) differed, localizing the divergence spatially (clip plane vs text vs full-frame). */
  divergentTiles?: { frame: number; tiles: number[] }[];
  /** Exported frames where the clip texture bound at render time differed between the runs: [exported frame, clip frame bound in run A, clip frame bound in run B]; a run rendering one clip-frame behind shows here directly. Capped at 40. */
  boundMismatches?: [number, number, number][];
  /** Per-pixel delta stats for divergent frames among the first few (retained raw during both runs); classifies the divergence: ±1-everywhere numeric jitter vs. localized stale content vs. a wholly different image. */
  frameDeltas?: FrameDelta[];
  /** Render-state snapshot from pass A's last frame, always present; diffing this across runs/builds/machines localizes "same project, different hash" to a named value. */
  fingerprint?: RenderStateFingerprint;
}

/** Pixel-delta report for one retained divergent frame (see DeterminismResult.frameDeltas). */
export interface FrameDelta {
  frame: number;
  /** Count of pixels with any channel difference. */
  differing: number;
  /** Largest absolute per-channel delta seen. */
  maxAbs: number;
  /** Differing-pixel counts by magnitude: exactly ±1, exactly ±2, and >2. */
  d1: number;
  d2: number;
  dGt2: number;
  /** Bounding box of differing pixels: [x0, y0, x1, y1] inclusive. */
  bbox: [number, number, number, number];
  /** First few differing pixels with both runs' RGBA values, to identify WHAT diverged. */
  samples: { x: number; y: number; a: number[]; b: number[] }[];
  /** Downscaled PNG data URLs of both runs' frame + an amplified |Δ|×8 diff map, present on the first divergent retained frame only, to let the divergence be seen. */
  imageA?: string;
  imageB?: string;
  imageDiff?: string;
}

/** Retained RGBA (GL bottom-up rows) → a downscaled PNG data URL. Diagnostic-only. */
function frameToDataUrl(rgba: Uint8Array, width: number, height: number, outW: number): string {
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const fullCtx = full.getContext("2d");
  if (!fullCtx) return "";
  const img = fullCtx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    img.data.set(rgba.subarray(src, src + width * 4), y * width * 4);
  }
  fullCtx.putImageData(img, 0, 0);
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = Math.max(1, Math.round((outW * height) / width));
  out.getContext("2d")?.drawImage(full, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Amplified per-channel |A−B|×8 as an RGBA frame (alpha 255), for frameToDataUrl. */
function diffFrame(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let p = 0; p < a.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      out[p + c] = Math.min(255, Math.abs(a[p + c] - b[p + c]) * 8);
    }
    out[p + 3] = 255;
  }
  return out;
}

/** Compare two retained RGBA frames; null when identical. Diagnostic-only (verify path). */
function frameDelta(frame: number, a: Uint8Array, b: Uint8Array, width: number): FrameDelta | null {
  let differing = 0;
  let maxAbs = 0;
  let d1 = 0;
  let d2 = 0;
  let dGt2 = 0;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  const samples: FrameDelta["samples"] = [];
  for (let p = 0; p < a.length; p += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[p + c] - b[p + c]);
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax === 0) continue;
    differing++;
    if (pixelMax > maxAbs) maxAbs = pixelMax;
    if (pixelMax === 1) d1++;
    else if (pixelMax === 2) d2++;
    else dGt2++;
    const x = (p >> 2) % width;
    const y = ((p >> 2) / width) | 0;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (samples.length < 12) {
      samples.push({
        x,
        y,
        a: [a[p], a[p + 1], a[p + 2], a[p + 3]],
        b: [b[p], b[p + 1], b[p + 2], b[p + 3]],
      });
    }
  }
  if (differing === 0) return null;
  return { frame, differing, maxAbs, d1, d2, dGt2, bbox: [x0, y0, x1, y1], samples };
}

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

/** Waits until the canvas tree has committed `tMs`. The canvas subtree renders in the r3f reconciler, which react-dom's `flushSync` does not flush, so its commit usually lands within a macrotask or two; per-mesh readiness hooks are only trustworthy for this frame after that commit, since awaiting them earlier can capture the previous frame's texture/glyphs (the back-to-back Verify ×2 race). Deterministic by construction: the loop's duration varies, its outcome never does. */
async function awaitCanvasClockCommit(tMs: number): Promise<void> {
  for (let spins = 0; canvasCommittedClockMs() !== tMs; spins++) {
    if (spins > 5000) {
      throw new Error(
        `Canvas tree never committed clock ${tMs}ms (stuck at ${canvasCommittedClockMs()}ms).`,
      );
    }
    await yieldMacrotask();
  }
}

/** The subset of troika-three-text's Text we drive. `_needsSync`/`_isSyncing` are private but stable in the pinned 0.52.4, and are the only way to detect quiescence, since troika's `sync(cb)` silently drops the callback when `_needsSync` is false (including while a typeset is in flight). */
interface TroikaTextLike {
  sync: (cb?: () => void) => void;
  _needsSync?: boolean;
  _isSyncing?: boolean;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
}

/** Awaits typesetting for every troika text mesh in the scene: per-frame layout can be async (e.g. a counter whose text changes each frame), so we must wait for it before capturing or read stale glyphs. Two hard-won subtleties (the text half of the back-to-back Verify ×2 race): troika meshes are detected via `material.isTroikaTextMaterial`, since the mesh itself carries no `isTroikaText` flag in troika 0.52.4; and a pending typeset is kicked here (pre-render) rather than left to troika's own `onBeforeRender` kick (which would start it a frame late), with quiescence awaited via the `synccomplete` event since `sync(cb)` drops callbacks when no new sync is needed. Exported for the borrowed-clock capture paths (snapshots.ts), whose single forced paint otherwise reads glyphs one capture late (the invisible-Playfair-title theme-preview bug). */
export function awaitTextSync(scene: Scene): Promise<void> {
  const pending: Promise<void>[] = [];
  scene.traverse((obj: Object3D) => {
    const material = (obj as { material?: { isTroikaTextMaterial?: boolean } }).material;
    const mesh = obj as unknown as TroikaTextLike;
    if (!material?.isTroikaTextMaterial || typeof mesh.sync !== "function") return;
    pending.push(
      new Promise<void>((resolve) => {
        const settle = () => {
          // Kicks a queued typeset now so this frame's text lays out before the render (troika would otherwise only kick it during onBeforeRender, one frame late).
          if (mesh._needsSync) mesh.sync();
          if (!mesh._needsSync && !mesh._isSyncing) {
            mesh.removeEventListener("synccomplete", settle);
            resolve();
          }
        };
        mesh.addEventListener("synccomplete", settle);
        settle();
      }),
    );
  });
  return Promise.all(pending).then(() => undefined);
}

/**
 * Deterministic export loop: reuses the live preview canvas, sizing its drawing buffer to the export resolution, then for each frame seeks the clock, awaits typesetting, renders exactly one frame, reads the pixels, and streams them to the ffmpeg sidecar. Frame N is a pure function of the frame index, no wall clock, no UI state. See docs/determinism.md.
 *
 * @returns the output file path reported by the native side.
 */
/** The export preamble's coarse phases, for the "preparing export" overlay (UI only; the preload order itself is authoritative). */
export const EXPORT_PREAMBLE_STEPS = [
  "Loading fonts and clips",
  "Loading models and images",
  "Loading effects and assets",
  "Placing the scenes",
] as const;

/** The deterministic preamble shared by exportProject and captureScreenshot; barrier order is pinned (docs/determinism.md). `onStep` reports coarse-phase completion for the UI overlay only. */
async function exportPreamble(
  opts: ExportOptions,
  gl: WebGLRenderer,
  onStep?: (step: number) => void,
): Promise<void> {
  configureDeterministicEngine();
  // Explicit, not incidental: an object, chart, device, image or terminal gizmo selected when an export starts must never reach a frame.
  useObjectEditStore.getState().select(null);
  useChartEditStore.getState().select(null);
  useDeviceEditStore.getState().select(null);
  useImageEditStore.getState().select(null);
  useTerminalEditStore.getState().select(null);
  // With themes, preloads exactly the fonts the project renders (bundled and workspace-pinned system fonts, plus sidecar `<key>Font` overrides); the no-theme form preloads the bundled defaults.
  await preloadAppFonts(
    opts.theme
      ? [
          ...collectThemeFontRefs([opts.theme, ...(opts.sceneThemes ?? [])]),
          ...collectSceneDocFontRefs(opts.sceneDocs ?? []),
        ]
      : undefined,
  );
  // Deterministic codecs read the software-decoded frame lane (the one baselines were recorded from); fast-draft hardware codecs keep the everyday hw lane. Restored in the loop's finally; a preamble throw leaves it on sw, corrected by the next export or preview re-registration.
  setClipLane(laneForCodec(opts.encode?.codec ?? opts.codec));
  // Layered-screenshot video cards mount behind their image Suspense, so render-time registration can miss a cold run's extract barrier; every sidecar-declared screen video registers here explicitly (docs/determinism.md).
  for (const doc of opts.sceneDocs ?? []) {
    for (const layer of doc?.layeredScreenshot?.layers ?? []) {
      for (const item of layer.items ?? []) {
        if (item.kind === "screen" && item.media === "video" && typeof item.src === "string") {
          registerClip(resolveAssetPath(opts.projectId, item.src));
        }
      }
    }
  }
  // Every video media entry, on both comparison sides: a scene can now carry several, and a fallback-mounted one is only in the tree after the last barrier, so the extract barrier below must already know about it.
  for (const doc of [...(opts.sceneDocs ?? []), ...(opts.compareBDocs ?? [])]) {
    for (const entry of resolveSceneDocMedia(doc)) {
      if (entry.kind === "video") registerClip(resolveAssetPath(opts.projectId, entry.src));
    }
  }
  // Pre-extracts every VideoClip's frame sequence before frame 0, mirroring font preload so no frame races an async decode; extraction is cached, so this is a no-op after the first.
  await preextractClips();
  onStep?.(1);
  // Fetches + parses bundled 3D models and this project's screen images (and warms drei's caches) before frame 0, so a cold export never captures a still-loading DeviceMockup; no-op once cached. See docs/determinism.md.
  await preloadDeviceModels();
  await preloadCatalogModels();
  await preloadHeroModels();
  // Staged library objects referenced by any scene (and compare side B), the same barrier over a dynamic id set.
  await preloadSceneObjects([...(opts.sceneDocs ?? []), ...(opts.compareBDocs ?? [])]);
  await preloadProjectImages(opts.projectId);
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
      collectMirrorRequests(
        opts.projectId,
        opts.sceneThemes ?? [],
        opts.projectLighting,
        opts.sceneDocs,
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
  // In-world TitleBlocks measure their own title/subtitle blocks, and their props only exist once the scenes are in the tree, so this barrier runs last: settle those typesets and let the tree re-render with them, or frame 0 captures the pre-measure layout (engine/titleBlockMeasure).
  await awaitTitleMeasuresSettled();
}

export async function exportProject(
  opts: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
  /** Diagnostic hook: called with each captured frame's pixels (the reused buffer) right after readback, before encode. Used by `verifyDeterminism` to hash frames in memory. */
  onFrame?: (frame: number, rgba: Uint8Array) => void,
  /** Diagnostic hook: called per frame with the clip-frame index of the texture actually bound on the scene's VideoClip at render time (-1 if none). Lets a failed Verify ×2 distinguish a stale texture bind from a pixel-content difference. */
  onBoundClipFrame?: (frame: number, boundClipFrame: number) => void,
  /** Diagnostic hook: called once, after the last frame renders, with the render-state fingerprint (engine/renderFingerprint.ts). */
  onFingerprint?: (fp: RenderStateFingerprint) => void,
  /** UI overlay hook: reports each coarse export-preamble phase (1..3); UI only, never affects render. */
  onPrepareStep?: (step: number) => void,
): Promise<string> {
  return withExporting(() =>
    exportProjectHeld(opts, onProgress, onFrame, onBoundClipFrame, onFingerprint, onPrepareStep),
  );
}

async function exportProjectHeld(
  opts: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
  onFrame?: (frame: number, rgba: Uint8Array) => void,
  onBoundClipFrame?: (frame: number, boundClipFrame: number) => void,
  onFingerprint?: (fp: RenderStateFingerprint) => void,
  onPrepareStep?: (step: number) => void,
): Promise<string> {
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;

  await exportPreamble(opts, gl, onPrepareStep);
  const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);

  const { width, height } = opts.format;
  const normalTotal = normalExportFrameCount(opts.durationMs, opts.fps);
  const poster = opts.encode?.posterFrame ? posterFrameSample(opts.slots, opts.fps) : undefined;
  const total = normalTotal + (poster === undefined ? 0 : 1);
  const ctx = gl.getContext();
  const rgba = new Uint8Array(width * height * 4);
  const sizeProbe = new Vector2();

  // Snapshot preview state to restore when the run ends.
  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  let clockOwnedMs: number | null = null;
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;

  // Size the renderer's drawing buffer to the export resolution (no CSS resize).
  gl.setPixelRatio(1);
  gl.setSize(width, height, false);
  if (cam.isPerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }

  const channel = new Channel<ExportProgress>();
  if (onProgress) channel.onmessage = onProgress;

  // Workspace projects: strip the ws: prefix for the filename stem and pass the slug so the native side routes output to <workspace>/<slug>/exports/; bundled projects keep the legacy ~/Kookaburra Cut/<project>/ path (projectSlug absent).
  const workspace = isWorkspaceProjectId(opts.projectId);
  const slug = workspace ? workspaceSlug(opts.projectId) : null;
  await invoke("start_export", {
    options: {
      projectId: slug ?? opts.projectId,
      width,
      height,
      fps: opts.fps,
      totalFrames: total,
      // Sanitised aspect label for the output filename (e.g. "16:9" → "16x9").
      aspect: opts.format.name.replace(":", "x"),
      codec: opts.codec ?? "libx264",
      encode: opts.encode ?? null,
      outputSuffix: opts.outputSuffix ?? null,
      destination: opts.destination ?? null,
      projectSlug: slug,
      audio: opts.audio
        ? {
            file: opts.audio.abs,
            gainDb: opts.audio.gainDb ?? 0,
            fadeInMs: opts.audio.fadeInMs ?? 0,
            fadeOutMs: opts.audio.fadeOutMs ?? 0,
            startOffsetMs: opts.audio.startOffsetMs ?? 0,
          }
        : null,
    },
    onProgress: channel,
  });

  // Per-scene camera tracks, normalized once for the whole run; projects without any stay on the legacy camera path below, byte-identically.
  const sceneTracks = buildSceneCameraTracks(
    opts.sceneDocs ?? [],
    computeFormat(opts.format),
    sceneFloorYs,
  );
  const lightingTracks = opts.sceneThemes
    ? buildLightingTracks(opts.sceneThemes, opts.projectLighting, opts.sceneDocs ?? [])
    : null;
  const compareBLightingTracks = opts.sceneThemes
    ? buildCompareBLightingTracks(
        opts.sceneThemes,
        opts.compareBThemes,
        opts.projectLighting,
        opts.sceneDocs ?? [],
      )
    : null;

  // Per-scene render states, built once; null unless the project opts into themed scene state (mirrored in CompositorDriver).
  const sceneStates =
    opts.theme && opts.sceneThemes
      ? buildSceneRenderStates(opts.theme, opts.sceneThemes, {
          projectId: opts.projectId,
          projectLighting: opts.projectLighting,
          sceneDocs: opts.sceneDocs,
        })
      : null;

  // Comparison plan inputs, built once (mirrored in CompositorDriver): specs per scene, plus side B's states over B-substituted themes/docs.
  const compareSpecs = (opts.sceneDocs ?? []).map((d, i) =>
    compareSpecOf(d, opts.sceneThemes?.[i]),
  );
  const sceneStatesB =
    opts.theme && opts.sceneThemes && opts.compareBDocs?.some(Boolean)
      ? buildSceneRenderStates(
          opts.theme,
          opts.sceneThemes.map((t, i) => opts.compareBThemes?.[i] ?? t),
          {
            projectId: opts.projectId,
            projectLighting: opts.projectLighting,
            sceneDocs: (opts.sceneDocs ?? []).map((d, i) => opts.compareBDocs?.[i] ?? d),
          },
        )
      : null;

  // Per-scene overlays, resolved once; null unless some scene declares a frame (mirrored in CompositorDriver).
  const overlays = opts.sceneThemes
    ? resolveOverlays(
        opts.sceneFrames ?? [],
        opts.sceneThemes,
        opts.sceneDocs ?? [],
        opts.projectId,
      )
    : null;

  // Stale-pose healing: a fully trackless project never writes the camera inside the loop, and the shared camera persists across project switches, so heal it once before frame 0. Pristine case writes identical floats (fov unchanged, no projection update), so the gated no-track paths stay byte-identical. Mirrored in CompositorDriver.
  if ((!opts.cameraTrack || opts.cameraTrack.length === 0) && !hasSceneCameraTracks(sceneTracks)) {
    applyCameraPose(cam, baseCameraPose());
  }

  // Preview-only light helpers can never reach a capture: their layer is disabled on the camera for the whole run (the second guard on top of their mount gating).
  cam.layers.disable(HELPER_LAYER);
  // The exporter owns rendering for the whole loop; the preview driver stands down (see engine/exportState) so no stray preview render interleaves with a capture.
  setExporting(true);
  try {
    for (let frame = 0; frame < total; frame++) {
      const tMs = exportFrameTimeMs(frame, opts.fps, poster?.tMs);
      // flushSync commits the DOM tree; the canvas tree (r3f reconciler) commits on its own schedule, so wait for it before trusting any per-mesh readiness hook for this frame.
      flushSync(() => useClockStore.getState().setCurrentMs(tMs));
      clockOwnedMs = tMs;
      await awaitCanvasClockCommit(tMs);
      // Ensure each VideoClip's current frame texture is uploaded first (this may yield)...
      await awaitVideoFramesReady(scene);
      // ...then syncs troika text last, immediately before the render, with no async gap after it where a stray render or worker message could leave a text mesh stale at capture.
      await awaitTextSync(scene);
      // Emoji rasters requested this frame (e.g. a counter format emitting an unseen cluster) settle before capture, so a texture can never pop in at a run-dependent frame.
      await awaitEmojiRastersIdle();
      // Guards against mid-run interference (e.g. a window resize retriggering r3f's size handling, which would corrupt every remaining captured frame); re-asserts the export size only if drifted, since an unconditional setSize would clear the canvas every frame. Resize events land during the awaits above; from here to readPixels is synchronous, so a corrected size cannot drift again before capture.
      gl.getSize(sizeProbe);
      if (sizeProbe.x !== width || sizeProbe.y !== height || gl.getPixelRatio() !== 1) {
        gl.setPixelRatio(1);
        gl.setSize(width, height, false);
      }
      if (cam.isPerspectiveCamera && cam.aspect !== width / height) {
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
      }
      // The camera applies at this shared seam (mirrored in CompositorDriver), a pure function of tMs. Scene-doc tracks get a per-frame plan applied inside renderComposited (per-target on transition frames); otherwise the legacy project-track path runs, a hard no-op when the project declares no track. Neither touches `cam.aspect`, so the resize guard above stays the sole owner of aspect.
      const resolved = frame === 0 && poster ? poster.resolved : resolveAt(opts.slots, tMs);
      const plan = resolveFrameCameras(sceneTracks, opts.cameraTrack, resolved, tMs);
      if (!plan) applyCameraTrack(cam, opts.cameraTrack, tMs);
      const statePlan = resolveFrameSceneStates(sceneStates, resolved);
      const lightingPlan = resolveFrameLighting(lightingTracks, resolved, compareBLightingTracks);
      const compareFrame = resolveCompareFrame(compareSpecs, sceneStates, sceneStatesB, resolved);
      // Same render path as the preview (engine/compositor): single-scene frames render directly (v0-identical), transition frames go through the composite.
      renderComposited(
        gl,
        scene,
        camera,
        getSceneHosts(),
        resolved,
        plan ?? undefined,
        statePlan,
        overlays ?? undefined,
        lightingPlan ?? undefined,
        compareFrame,
      );
      if (frame === total - 1) onFingerprint?.(renderStateFingerprint(gl, scene));
      ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, rgba);
      onBoundClipFrame?.(frame, sampleBoundClipFrame(scene));
      onFrame?.(frame, rgba);
      await invoke("push_frame", rgba);
    }
    return await invoke<string>("finish_export");
  } catch (err) {
    await invoke("cancel_export").catch(() => {});
    throw err;
  } finally {
    setExporting(false);
    setClipLane(everydayClipLane());
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    // Give the playhead back only if this run wrote it and still owns it; an untouched or since-moved clock stays put.
    if (clockOwnedMs !== null && useClockStore.getState().currentMs === clockOwnedMs) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  }
}

/** Renders one deterministic frame at tMs through the export path and returns its raw pixels (GL bottom-up row order). The shared core of `captureScreenshot` and the render window's thumb service. */
export async function captureFrameRgba(
  opts: ExportOptions,
  tMs: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  return withExporting(() => captureFrameRgbaHeld(opts, tMs));
}

async function captureFrameRgbaHeld(
  opts: ExportOptions,
  tMs: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;

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
  try {
    await exportPreamble(opts, gl);
  } catch (err) {
    restoreSelection();
    throw err;
  }
  const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);

  const { width, height } = opts.format;
  const ctx = gl.getContext();
  const rgba = new Uint8Array(width * height * 4);

  // Snapshot preview state to restore when the capture ends (the export loop's contract).
  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;

  gl.setPixelRatio(1);
  gl.setSize(width, height, false);
  if (cam.isPerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }

  const sceneTracks = buildSceneCameraTracks(
    opts.sceneDocs ?? [],
    computeFormat(opts.format),
    sceneFloorYs,
  );
  const lightingTracks = opts.sceneThemes
    ? buildLightingTracks(opts.sceneThemes, opts.projectLighting, opts.sceneDocs ?? [])
    : null;
  const compareBLightingTracks = opts.sceneThemes
    ? buildCompareBLightingTracks(
        opts.sceneThemes,
        opts.compareBThemes,
        opts.projectLighting,
        opts.sceneDocs ?? [],
      )
    : null;
  const sceneStates =
    opts.theme && opts.sceneThemes
      ? buildSceneRenderStates(opts.theme, opts.sceneThemes, {
          projectId: opts.projectId,
          projectLighting: opts.projectLighting,
          sceneDocs: opts.sceneDocs,
        })
      : null;
  const overlays = opts.sceneThemes
    ? resolveOverlays(
        opts.sceneFrames ?? [],
        opts.sceneThemes,
        opts.sceneDocs ?? [],
        opts.projectId,
      )
    : null;
  // Comparison plan inputs, mirroring the export loop exactly (a screenshot must show the frame the export would).
  const compareSpecs = (opts.sceneDocs ?? []).map((d, i) =>
    compareSpecOf(d, opts.sceneThemes?.[i]),
  );
  const sceneStatesB =
    opts.theme && opts.sceneThemes && opts.compareBDocs?.some(Boolean)
      ? buildSceneRenderStates(
          opts.theme,
          opts.sceneThemes.map((t, i) => opts.compareBThemes?.[i] ?? t),
          {
            projectId: opts.projectId,
            projectLighting: opts.projectLighting,
            sceneDocs: (opts.sceneDocs ?? []).map((d, i) => opts.compareBDocs?.[i] ?? d),
          },
        )
      : null;
  // Trackless projects heal the shared camera to base for the frame; snapshot the live pose (a mid-orbit view stays where the user left it) and give it back afterwards.
  let restoreCameraPose: (() => void) | null = null;
  if ((!opts.cameraTrack || opts.cameraTrack.length === 0) && !hasSceneCameraTracks(sceneTracks)) {
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
  setExporting(true);
  try {
    // One iteration of the export loop's frame block, barrier for barrier.
    flushSync(() => useClockStore.getState().setCurrentMs(tMs));
    await awaitCanvasClockCommit(tMs);
    await awaitVideoFramesReady(scene);
    await awaitTextSync(scene);
    await awaitEmojiRastersIdle();
    if (cam.isPerspectiveCamera && cam.aspect !== width / height) {
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
    }
    const resolved = resolveAt(opts.slots, tMs);
    const plan = resolveFrameCameras(sceneTracks, opts.cameraTrack, resolved, tMs);
    if (!plan) applyCameraTrack(cam, opts.cameraTrack, tMs);
    const statePlan = resolveFrameSceneStates(sceneStates, resolved);
    const lightingPlan = resolveFrameLighting(lightingTracks, resolved, compareBLightingTracks);
    const compareFrame = resolveCompareFrame(compareSpecs, sceneStates, sceneStatesB, resolved);
    renderComposited(
      gl,
      scene,
      camera,
      getSceneHosts(),
      resolved,
      plan ?? undefined,
      statePlan,
      overlays ?? undefined,
      lightingPlan ?? undefined,
      compareFrame,
    );
    ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, rgba);
    return { rgba, width, height };
  } finally {
    setExporting(false);
    setClipLane(everydayClipLane());
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    restoreCameraPose?.();
    restoreSelection();
    // Give the playhead back only while the capture still owns it; a scrub mid-capture wins.
    if (useClockStore.getState().currentMs === tMs) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  }
}

/** Renders one deterministic frame at tMs through the export path and writes it natively as a PNG (autorun `<run result dir>/<name>.png` by default, from `KOOKABURRA_RESULT_DIR` or the legacy `_autorun`; the bridge pair for capture requests). */
export async function captureScreenshot(
  opts: ExportOptions,
  tMs: number,
  name: string,
  commands: { begin: string; save: string } = {
    begin: "begin_screenshot",
    save: "save_screenshot",
  },
): Promise<string> {
  const { rgba, width, height } = await captureFrameRgba(opts, tMs);
  await invoke(commands.begin, { width, height, name });
  return await invoke<string>(commands.save, rgba);
}

/** The determinism gate: exports the same project twice (overwriting the per-aspect output path) and compares the SHA-256 of each run, returning both digests and whether they match. Must run in the app runtime, export needs WebGL and the ffmpeg sidecar. */
export async function verifyDeterminism(
  opts: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
): Promise<DeterminismResult> {
  // Diagnostics: hashes every frame in memory (as an 8×8 grid of tile hashes) during both runs, so a mismatch reports which frames diverged and where in the frame, not just that they did (these localized the back-to-back race to the clip/text pipelines).
  const { width, height } = opts.format;
  const framesA: Uint32Array[] = [];
  const framesB: Uint32Array[] = [];
  const boundA: number[] = [];
  const boundB: number[] = [];
  // Retains the first frames raw (the exporter reuses its buffer, so copy); the showcase-tour flake diverged only there, and on mismatch these feed the per-pixel delta report below. At 4K each copy is ~33 MB and the WebContent process rides WebKit's 4 GB footprint ceiling, so pass B releases each pass-A copy the moment its tile hashes confirm the frame matched; only genuinely divergent frames keep both copies.
  const RETAIN_FRAMES = 3;
  const rawA: (Uint8Array | undefined)[] = [];
  const rawB: (Uint8Array | undefined)[] = [];
  // Holds the preview stand-down across both passes (nested over each pass's own hold; the flag is depth-counted, see engine/exportState). Without this, a wall-clock-varying number of preview frames rendered between the passes at the preview size, with the restored preview clock, and their GPU residue leaked into pass B's first frames (the showcase-tour frames-0-1 ±LSB flake); with the hold, pass B starts from exactly the state pass A ended in, deterministic by construction. Each pass's own run disables HELPER_LAYER.
  setExporting(true);
  let hashA: string;
  let hashB: string;
  let fingerprint: RenderStateFingerprint | undefined;
  try {
    const outA = await exportProject(
      opts,
      onProgress,
      (f, rgba) => {
        framesA[f] = tileHashFrame(rgba, width, height);
        if (f < RETAIN_FRAMES) rawA[f] = rgba.slice();
      },
      (f, bound) => {
        boundA[f] = bound;
      },
      (fp) => {
        fingerprint = fp;
      },
    );
    hashA = await invoke<string>("hash_file", { path: outA });
    const outB = await exportProject(
      opts,
      onProgress,
      (f, rgba) => {
        framesB[f] = tileHashFrame(rgba, width, height);
        if (f < RETAIN_FRAMES) {
          const a = framesA[f];
          const same = !!a && a.every((v, i) => v === framesB[f][i]);
          if (same) rawA[f] = undefined;
          else rawB[f] = rgba.slice();
        }
      },
      (f, bound) => {
        boundB[f] = bound;
      },
    );
    hashB = await invoke<string>("hash_file", { path: outB });
  } finally {
    setExporting(false);
  }
  const identical = hashA === hashB;
  if (identical) return { identical, hashA, hashB, fingerprint };
  const boundMismatches: [number, number, number][] = [];
  for (let i = 0; i < Math.max(boundA.length, boundB.length); i++) {
    if (boundA[i] !== boundB[i] && boundMismatches.length < 40) {
      boundMismatches.push([i, boundA[i], boundB[i]]);
    }
  }

  const tilesDiffer = (a?: Uint32Array, b?: Uint32Array): number[] => {
    if (!a || !b) return a === b ? [] : Array.from({ length: 64 }, (_, i) => i);
    const out: number[] = [];
    for (let t = 0; t < 64; t++) if (a[t] !== b[t]) out.push(t);
    return out;
  };
  const ranges: [number, number][] = [];
  const tileSamples: { frame: number; tiles: number[] }[] = [];
  let count = 0;
  for (let i = 0; i < Math.max(framesA.length, framesB.length); i++) {
    const diff = tilesDiffer(framesA[i], framesB[i]);
    if (diff.length === 0) continue;
    count++;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else ranges.push([i, i]);
    if (tileSamples.length < 5) tileSamples.push({ frame: i, tiles: diff });
  }
  const frameDeltas: FrameDelta[] = [];
  for (let f = 0; f < RETAIN_FRAMES; f++) {
    const a = rawA[f];
    const b = rawB[f];
    if (!a || !b) continue;
    const d = frameDelta(f, a, b, width);
    if (!d) continue;
    if (frameDeltas.length === 0) {
      d.imageA = frameToDataUrl(a, width, height, 480);
      d.imageB = frameToDataUrl(b, width, height, 480);
      d.imageDiff = frameToDataUrl(diffFrame(a, b), width, height, 960);
    }
    frameDeltas.push(d);
  }
  return {
    identical,
    hashA,
    hashB,
    divergentCount: count,
    divergentRanges: ranges,
    divergentTiles: tileSamples,
    boundMismatches,
    frameDeltas,
    fingerprint,
  };
}

/** Verify diagnostic: FNV-1a per cell of an 8×8 grid over the frame, so two runs' frames can be compared tile-by-tile to localize a divergence spatially; any pixel difference flips its cell's hash. */
function tileHashFrame(rgba: Uint8Array, width: number, height: number): Uint32Array {
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  const tiles = new Uint32Array(64).fill(0x811c9dc5);
  for (let y = 0; y < height; y++) {
    const tileRow = ((y * 8) / height) | 0;
    const rowStart = y * width;
    for (let tc = 0; tc < 8; tc++) {
      const x0 = ((tc * width) / 8) | 0;
      const x1 = (((tc + 1) * width) / 8) | 0;
      const t = tileRow * 8 + tc;
      let h = tiles[t];
      for (let x = rowStart + x0; x < rowStart + x1; x++) {
        h = Math.imul(h ^ words[x], 0x01000193);
      }
      tiles[t] = h;
    }
  }
  return tiles;
}

/** A per-aspect determinism result. */
export interface FormatVerification extends DeterminismResult {
  aspect: string;
}

/** Determinism gate: runs Verify ×2 for each format (aspect) in turn. The multi-scene project, including the offscreen composite/transition path, must be byte-identical run-to-run in every aspect, not just 16:9. */
export async function verifyAllFormats(
  opts: Omit<ExportOptions, "format">,
  formats: FormatSpec[],
  onProgress?: (p: ExportProgress) => void,
): Promise<FormatVerification[]> {
  const results: FormatVerification[] = [];
  for (const format of formats) {
    const r = await verifyDeterminism({ ...opts, format }, onProgress);
    results.push({ ...r, aspect: format.name });
  }
  return results;
}

/** Reveal an exported file in macOS Finder (selects it in its folder). */
export async function revealInFinder(path: string): Promise<void> {
  await invoke("reveal_in_finder", { path });
}

/** Reveal the most recent finished export. No path crosses the IPC boundary: exports default to ~/Downloads, outside `reveal_in_finder`'s confinement, so Rust reveals the destination it wrote itself. */
export async function revealLastExport(): Promise<void> {
  await invoke("reveal_last_export");
}

/** Verify diagnostic: the clip-frame index stamped on the texture that is actually bound on the scene's VideoClip material right now (-1 when no clip/map); read immediately after render so it reflects what the capture saw. */
function sampleBoundClipFrame(scene: Scene): number {
  let bound = -1;
  scene.traverse((obj: Object3D) => {
    if (bound !== -1) return;
    const ud = obj.userData as { videoFrameReady?: unknown };
    if (!ud.videoFrameReady) return;
    const mesh = obj as unknown as { material?: { map?: { userData?: { clipFrame?: number } } } };
    bound = mesh.material?.map?.userData?.clipFrame ?? -1;
  });
  return bound;
}
