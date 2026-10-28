import { Channel, invoke } from "@tauri-apps/api/core";
import type { EncodeSpec } from "../export/presetSchema";
import type { LightingSpec, Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import type { CameraKeyframe } from "./cameraTrack";
import { exportFrameTimeMs, posterFrameSample } from "./exportFrames";
import { setExporting, withExporting } from "./exportState";
import type { FormatSpec } from "./format";
import type { MotionBlurSettings } from "./motionBlur";
import type { ProjectMusic } from "./musicTime";
import { isWorkspaceBackedProjectId, nativeProjectSlug, type ProjectAudio } from "./project";
import type { RenderStateFingerprint } from "./renderFingerprint";
import type { SceneDoc } from "./sceneDocSchema";
import type { SceneSlot } from "./sceneTimeline";
import { stage, stageExportOptions } from "./stageHandle";

export { awaitTextSync } from "./exportFrame";

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
  /** The project's authored music (`LoadedProject.music`); resolves musical camera kick positions. Absent leaves only numeric kick times. */
  music?: ProjectMusic;
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
  /** Themes room keys name (`LoadedProject.roomThemes`); absent reads every room key against its scene's theme. */
  roomThemes?: Readonly<Record<string, Theme>>;
  /** Encoder; defaults to the deterministic libx264. */
  codec?: Codec;
  /** The resolved encode spec (presets/custom). Absent means the frozen legacy argv, byte-pinned in Rust; standing baselines and Verify never carry one. */
  encode?: EncodeSpec;
  /** Output filename suffix: preset id or "custom", the file becomes `<project>-<aspect>-<suffix>.<ext>`. Absent means the exact legacy name. */
  outputSuffix?: string;
  /** "downloads" routes the final file to ~/Downloads (the app's Settings toggle). Absent means the canonical project paths; autorun/terminal exports never set it. */
  destination?: "downloads";
  /** Cancels the run at its next frame or encode stage; the run then rejects with `signal.reason`. */
  signal?: AbortSignal;
  /** The manifest's `render.motionBlur`; absent (and no scene switching it on) means the byte-identical unblurred path. */
  motionBlur?: MotionBlurSettings;
}

export interface ExportProgress {
  frame: number;
  total: number;
  /** "render" while frames stream, then "pass1" / "pass2" through a two-pass transcode. */
  stage: "render" | "pass1" | "pass2";
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
/**
 * Deterministic export loop: reuses the live preview canvas, sizing its drawing buffer to the export resolution, then for each frame seeks the clock, awaits typesetting, renders the frame, reads the pixels, and streams them to the ffmpeg sidecar. Frame N is a pure function of the frame index, no wall clock, no UI state. See docs/determinism.md.
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

/** Waits until every scene's host is registered in the stage (the canvas tree has committed the scenes); asked of the worker from a window, answered from the registry inside it. See exportRun.ts. */
export function awaitSceneHostsCommitted(expected: number): Promise<void> {
  return stage().awaitHosts(expected);
}

/**
 * Deterministic export loop, the window half: the stage worker renders each frame through the shared per-frame body (`exportRun.ts`), the bytes cross once per frame and stream to the ffmpeg sidecar from here. Frame N is a pure function of the frame index, no wall clock, no UI state. See docs/determinism.md.
 *
 * @returns the output file path reported by the native side.
 */
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

/** Resolves with `promise`, or rejects with the signal's reason the moment it aborts; the promise itself is left to settle. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      promise.catch(() => {});
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function exportProjectHeld(
  opts: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
  onFrame?: (frame: number, rgba: Uint8Array) => void,
  onBoundClipFrame?: (frame: number, boundClipFrame: number) => void,
  onFingerprint?: (fp: RenderStateFingerprint) => void,
  onPrepareStep?: (step: number) => void,
): Promise<string> {
  const s = stage();
  const { signal } = opts;
  signal?.throwIfAborted();
  let started = false;
  let begun = false;
  // A cancel that lands while Rust finalises or runs a two-pass pass has no frame boundary to stop at, so it kills the native encode directly.
  const stopNativeEncode = () => void invoke("cancel_export").catch(() => {});
  try {
    const begin = s.exportBegin(stageExportOptions(opts), (step) => onPrepareStep?.(step));
    // The worker opens the run whether or not the wait below is cut short; the finally closes it either way.
    begun = true;
    const { total } = await untilAborted(begin, signal);
    const { width, height } = opts.format;
    const poster = opts.encode?.posterFrame ? posterFrameSample(opts.slots, opts.fps) : undefined;

    const channel = new Channel<ExportProgress>();
    if (onProgress) channel.onmessage = onProgress;

    // Workspace-backed ids (projects and library items) pass their native slug so the output lands in that folder's own exports/; bundled ids keep the legacy ~/Kookaburra Cut/<project>/ path (projectSlug absent). The native side folds any scope prefix out of the filename stem.
    const slug = isWorkspaceBackedProjectId(opts.projectId)
      ? nativeProjectSlug(opts.projectId)
      : null;
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
              fadeOutCurve: opts.audio.fadeOutCurve ?? null,
              startOffsetMs: opts.audio.startOffsetMs ?? 0,
              trackDurationMs: Math.round(opts.audio.durationMs),
            }
          : null,
      },
      onProgress: channel,
    });
    started = true;
    signal?.addEventListener("abort", stopNativeEncode, { once: true });

    // The frame buffer ping-pongs: the worker renders into it, the window pushes it, then hands it back for the next frame.
    let buffer: ArrayBuffer | null = null;
    for (let frame = 0; frame < total; frame++) {
      signal?.throwIfAborted();
      const tMs = exportFrameTimeMs(frame, opts.fps, poster?.tMs);
      const last = frame === total - 1;
      const result = await s.exportFrame(frame, tMs, !!poster, buffer, last && !!onFingerprint);
      if (result.fingerprint && onFingerprint) onFingerprint(result.fingerprint);
      onBoundClipFrame?.(frame, result.boundClipFrame);
      onFrame?.(frame, result.rgba);
      await invoke("push_frame", result.rgba);
      buffer = result.rgba.buffer as ArrayBuffer;
    }
    signal?.throwIfAborted();
    return await invoke<string>("finish_export");
  } catch (err) {
    if (started) await invoke("cancel_export").catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", stopNativeEncode);
    if (begun) await s.exportEnd().catch(() => {});
  }
}

/** Renders one deterministic frame at tMs through the export path in the stage and returns its raw pixels (GL bottom-up row order). The shared core of `captureScreenshot` and the render window's thumb service. */
export async function captureFrameRgba(
  opts: ExportOptions,
  tMs: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  return withExporting(() => stage().captureFrame(stageExportOptions(opts), tMs));
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
  await stage().holdExport(true);
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
    await stage()
      .holdExport(false)
      .catch(() => {});
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
export function tileHashFrame(rgba: Uint8Array, width: number, height: number): Uint32Array {
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

/** Determinism gate: runs Verify ×2 for each format (aspect) in turn. The multi-scene project, including the offscreen composite/transition path, must be byte-identical run-to-run in every aspect, not just 16:9. `commitFormat` lands each leg's aspect where the canvas lays out from (the editor store behind `useFormat`) before the loop reads pixels; without it every leg after the editor's own aspect hashes the wrong layout in the right-sized buffer, twice, and reports green. */
export async function verifyAllFormats(
  opts: Omit<ExportOptions, "format">,
  formats: FormatSpec[],
  commitFormat: (format: FormatSpec) => Promise<void>,
  onProgress?: (p: ExportProgress) => void,
): Promise<FormatVerification[]> {
  const results: FormatVerification[] = [];
  for (const format of formats) {
    opts.signal?.throwIfAborted();
    await commitFormat(format);
    const r = await verifyDeterminism({ ...opts, format }, onProgress);
    results.push({ ...r, aspect: format.name });
  }
  return results;
}

/** Reveal an exported file in macOS Finder (selects it in its folder). */
export async function revealInFinder(path: string): Promise<void> {
  await invoke("reveal_in_finder", { path });
}

/** Reveal one export this app wrote in this session (Rust refuses any other path, as it refuses to take one for `revealLastExport`). */
export async function revealExport(path: string): Promise<void> {
  await invoke("reveal_export", { path });
}

/** Reveal the most recent finished export. No path crosses the IPC boundary: exports default to ~/Downloads, outside `reveal_in_finder`'s confinement, so Rust reveals the destination it wrote itself. */
export async function revealLastExport(): Promise<void> {
  await invoke("reveal_last_export");
}
