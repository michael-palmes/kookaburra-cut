import { Channel, invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import type { PerspectiveCamera, Scene } from "three";
import { Vector2 } from "three";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { everydayClipLane, setClipLane } from "./clips";
import { useClockStore } from "./clock";
import { downscaleScratchLength, pageFromReadback } from "./downscale";
import { canvasHandle } from "./exportBridge";
import { type ExportOptions, type ExportProgress, exportPreamble, tileHashFrame } from "./exporter";
import {
  awaitHoldsCommitted,
  awaitTextSync,
  buildFramePlans,
  type FrameRig,
  renderFrameInto,
} from "./exportFrame";
import { setExporting, withExporting } from "./exportState";
import { getFramePanels } from "./framePanelRegistry";
import { HELPER_LAYER } from "./lightEditStore";
import { yieldMacrotask } from "./macrotask";
import { getPersistentLayers } from "./persistentLayerRegistry";
import { clearSceneHolds, replaceSceneHolds } from "./presentHold";
import { presentTimingsPendingCount, snapshotPresentTimings } from "./presentTimingRegistry";
import { isWorkspaceBackedProjectId, nativeProjectSlug, sceneFileStem } from "./project";
import { assertContextHeld } from "./readback";
import { hasSceneCameraTracks } from "./sceneCamera";
import { resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import { largestSceneText, useSceneTextRegistry } from "./sceneTextRegistry";
import { sceneTitle } from "./sceneTitle";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { planStillPages, type StillPage, type StillsWarning } from "./stillPages";
import { type StillsFormat, type StillsSize, stillsPixelSize } from "./stills";
import { collectPageText, fallbackPageText, pageTextRoots, type StillTextItem } from "./stillText";

/** Stills export: the slideshow as a PDF handout or a PNG zip, one page per still, captured through the deterministic export path (same preamble, barriers and `renderComposited`) and streamed one page at a time to the native writer. See docs/stills.md. */

export interface StillsSettings {
  format: StillsFormat;
  size: StillsSize;
  /** The project's display name: the PDF title and `pages.json` project. */
  title: string;
  /** Manifest scene files, index-parallel to the slots; a scene name falls back to its stem. */
  sceneFiles?: readonly string[];
  /** Overrides `opts.destination`; "autorun" writes into the run's result dir (auto-runs only). */
  destination?: "downloads" | "autorun";
  /** Leaves out the PDF dates, author and app version, and pins the zip timestamps. */
  reproducible?: boolean;
  /** The folder inside a PNG zip; the native default is the output stem. */
  zipFolder?: string;
}

/** One page's verify digest: 64 tile hashes of the page-stage RGBA, plus its text layer and metadata JSON. */
export interface StillPageDigest {
  tiles: Uint32Array;
  text: string;
  meta: string;
}

export interface StillsExportResult {
  path: string;
  kind: StillsFormat;
  pages: number;
  bytes: number;
  /** The output file's SHA-256 (advisory for PDF: WebKit's JPEG encoder is not pinned). */
  sha256: string;
  /** Per page payload SHA-256 from the native writer (JPEG or PNG bytes). */
  pageSha256: string[];
  /** The PNG zip's folder. */
  zipFolder?: string;
  /** SHA-256 over every page hash: the stills baseline. */
  pagesHash: string;
  /** Per page SHA-256 of its page-stage tile hashes, metadata and text layer. */
  pageHashes: string[];
  /** Global ms each page renders at. */
  pageTimesMs: number[];
  warnings: StillsWarning[];
  digests: StillPageDigest[];
}

interface NativeStillsResult {
  path: string;
  kind: StillsFormat;
  pages: number;
  bytes: number;
  sha256: string;
  pageSha256: string[];
  zipFolder?: string;
}

/** Waits until no staged primitive still owes its Present timing (a staggered headline reports pending until its first typeset spreads the units), kicking text sync each spin. Deterministic: the spin count varies, the snapshot it releases never does. */
export async function awaitPresentTimingsSettled(scene: Scene): Promise<void> {
  for (let spins = 1; ; spins++) {
    await awaitTextSync(scene);
    await yieldMacrotask();
    if (presentTimingsPendingCount() === 0) return;
    if (spins >= 5000) {
      throw new Error(
        `Present timings never settled: ${presentTimingsPendingCount()} still pending after ${spins} spins.`,
      );
    }
  }
}

const utf8 = new TextEncoder();

function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of utf8.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The page metadata the native writer records (`x-kookaburra-meta`). */
export function stillPageMeta(page: StillPage): string {
  return JSON.stringify({
    sceneIndex: page.sceneIndex,
    sceneName: page.sceneName,
    kind: page.kind,
    sceneMs: page.sceneMs,
    globalMs: page.tMs,
  });
}

/** The page's hash input: its tile hashes, then metadata and text layer JSON. */
async function digestHash(digest: StillPageDigest): Promise<string> {
  const tiles = new Uint8Array(
    digest.tiles.buffer,
    digest.tiles.byteOffset,
    digest.tiles.byteLength,
  );
  return sha256Hex(concatBytes([tiles, utf8.encode(digest.meta), utf8.encode(digest.text)]));
}

/** One reused canvas; each page is a `putImageData` and a quality-0.9 JPEG. */
function jpegEncoder(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Stills export: no 2D canvas for the JPEG encode.");
  return async (pixels: Uint8ClampedArray<ArrayBuffer>): Promise<Uint8Array> => {
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) throw new Error("Stills export: the JPEG encode failed.");
    return new Uint8Array(await blob.arrayBuffer());
  };
}

/** Scene display names for bookmarks and file names: the sidecar name, else the largest mounted text, else the file stem. */
function sceneNames(opts: ExportOptions, settings: StillsSettings): string[] {
  const texts = useSceneTextRegistry.getState().texts;
  return opts.slots.map((_, i) => {
    const file = settings.sceneFiles?.[i];
    return sceneTitle(
      opts.sceneDocs?.[i],
      largestSceneText(texts, i),
      file ? sceneFileStem(file) : null,
      i,
    );
  });
}

/** Strings the scene's text primitives registered, for a page whose lines could not be placed. */
function registeredSceneStrings(sceneIndex: number): string[] {
  const entries = useSceneTextRegistry.getState().texts[sceneIndex] ?? {};
  return Object.keys(entries)
    .sort()
    .map((id) => entries[id].text);
}

/** Exports the project's stills (`opts.format` is the native aspect; the caller commits it to the editor first, as Verify legs do). Pages are planned after the preamble from settled Present timings, automatic stills hold where Present would, and every page renders through `renderFrameInto`; the holds are always cleared before the preview resumes. */
export async function exportStills(
  opts: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
  /** UI overlay hook: reports each coarse export-preamble phase (1..3); UI only, never affects render. */
  onPrepareStep?: (step: number) => void,
): Promise<StillsExportResult> {
  return withExporting(() => exportStillsHeld(opts, settings, onProgress, onPrepareStep));
}

async function exportStillsHeld(
  input: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
  onPrepareStep?: (step: number) => void,
): Promise<StillsExportResult> {
  // No codec or encode spec: the deterministic software clip lane pins, as for every gated export.
  const opts: ExportOptions = { ...input, codec: undefined, encode: undefined };
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;
  const { signal } = opts;
  signal?.throwIfAborted();
  assertContextHeld(gl.getContext(), "before the stills export");

  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  let rig: FrameRig | null = null;
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;
  const prevHelperLayer = cam.layers.isEnabled(HELPER_LAYER);
  const cancelNative = () => void invoke("cancel_stills_export").catch(() => {});
  setExporting(true);
  try {
    await exportPreamble(opts, gl, (step) => {
      onPrepareStep?.(step);
      signal?.throwIfAborted();
    });
    signal?.throwIfAborted();
    const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);

    const { width, height } = opts.format;
    const ctx = gl.getContext();
    const rgba = new Uint8Array(width * height * 4);
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
    }
    const plans = buildFramePlans(opts, sceneFloorYs);

    await awaitPresentTimingsSettled(scene);
    const plan = planStillPages({
      slots: opts.slots,
      sceneDocs: opts.sceneDocs ?? [],
      timingsFor: snapshotPresentTimings,
      fps: opts.fps,
      sceneTracks: plans.sceneTracks,
      lightingTracks: plans.lightingTracks,
      compareBLightingTracks: plans.compareBLightingTracks?.tracks ?? null,
      projectCameraTrack: opts.cameraTrack,
      sceneNames: sceneNames(opts, settings),
    });
    signal?.throwIfAborted();
    await awaitHoldsCommitted(replaceSceneHolds(plan.holds));

    const total = plan.pages.length;
    const page = stillsPixelSize(opts.format, settings.size);
    const slug = isWorkspaceBackedProjectId(opts.projectId)
      ? nativeProjectSlug(opts.projectId)
      : null;
    await invoke<string>("start_stills_export", {
      options: {
        kind: settings.format,
        projectId: slug ?? opts.projectId,
        projectSlug: slug,
        aspect: opts.format.name.replace(":", "x"),
        outputSuffix: opts.outputSuffix ?? null,
        destination: settings.destination ?? opts.destination ?? null,
        title: settings.title,
        formatWidth: width,
        formatHeight: height,
        pageWidth: page.width,
        pageHeight: page.height,
        totalPages: total,
        reproducible: settings.reproducible === true,
        zipFolder: settings.zipFolder ?? null,
      },
      onProgress: new Channel<ExportProgress>(),
    });
    signal?.addEventListener("abort", cancelNative, { once: true });

    rig = {
      gl,
      scene,
      camera,
      ctx,
      width,
      height,
      rgba,
      sizeProbe: new Vector2(),
      plans,
      cameraTrack: opts.cameraTrack,
      clockOwnedMs: null,
    };
    // The video loop's stale-pose heal and helper-layer guard, unchanged.
    if (
      (!opts.cameraTrack || opts.cameraTrack.length === 0) &&
      !hasSceneCameraTracks(plans.sceneTracks)
    ) {
      applyCameraPose(cam, baseCameraPose());
    }
    cam.layers.disable(HELPER_LAYER);

    const pixels = new Uint8ClampedArray(page.width * page.height * 4);
    const scratch =
      page.width === width && page.height === height
        ? undefined
        : new Float64Array(downscaleScratchLength(height, page.width));
    const encodeJpeg = settings.format === "pdf" ? jpegEncoder(page.width, page.height) : null;
    const digests: StillPageDigest[] = [];
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted();
      const still = plan.pages[i];
      await renderFrameInto(
        rig,
        still.tMs,
        still.resolved,
        i === 0 ? 2 : 1,
        `still ${i + 1}/${total}`,
      );
      let textItems: StillTextItem[] = [];
      if (encodeJpeg) {
        const idx = still.sceneIndex;
        const compare = resolveCompareFrame(
          plans.compareSpecs,
          plans.sceneStates,
          plans.sceneStatesB,
          still.resolved,
        );
        textItems = collectPageText(
          pageTextRoots({
            sceneIndex: idx,
            hosts: getSceneHosts(),
            framePanels: getFramePanels(),
            persistent: getPersistentLayers(),
            camera: cam,
            overlay: plans.overlays?.[idx] ?? null,
            comparing: compare.some((p) => p.index === idx),
            width,
            height,
          }),
          cam.layers,
        );
        if (textItems.length === 0) textItems = fallbackPageText(registeredSceneStrings(idx));
      }
      pageFromReadback(rgba, width, height, page.width, page.height, pixels, scratch);
      const meta = stillPageMeta(still);
      const text = JSON.stringify(textItems);
      digests.push({
        tiles: tileHashFrame(new Uint8Array(pixels.buffer), page.width, page.height),
        text,
        meta,
      });
      const headers: Record<string, string> = {
        "x-kookaburra-still": String(i),
        "x-kookaburra-width": String(page.width),
        "x-kookaburra-height": String(page.height),
        "x-kookaburra-meta": base64Utf8(meta),
      };
      let body: Uint8Array;
      if (encodeJpeg) {
        const textBytes = utf8.encode(text);
        body = concatBytes([await encodeJpeg(pixels), textBytes]);
        headers["x-kookaburra-text-bytes"] = String(textBytes.length);
      } else {
        body = new Uint8Array(pixels.buffer);
      }
      await invoke("push_still", body, { headers });
      onProgress?.({ frame: i + 1, total, stage: "render" });
    }
    signal?.throwIfAborted();
    const native = await invoke<NativeStillsResult>("finish_stills_export");
    const pageHashes = await Promise.all(digests.map(digestHash));
    return {
      ...native,
      pagesHash: await sha256Hex(utf8.encode(pageHashes.join("\n"))),
      pageHashes,
      pageTimesMs: plan.pages.map((p) => Math.round(p.tMs * 1000) / 1000),
      warnings: plan.warnings,
      digests,
    };
  } catch (err) {
    await invoke("cancel_stills_export").catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancelNative);
    // Holds first: the preview resumes when the export hold drops, and must never draw a held scene.
    clearSceneHolds();
    setExporting(false);
    setClipLane(everydayClipLane());
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    if (prevHelperLayer) cam.layers.enable(HELPER_LAYER);
    const clockOwnedMs = rig?.clockOwnedMs ?? null;
    if (clockOwnedMs !== null && useClockStore.getState().currentMs === clockOwnedMs) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  }
}

/** The first page two stills runs disagree on, at each level. */
export interface StillsDivergence {
  page: number;
  /** 8×8 tile indices (row-major) whose page-stage RGBA differed. */
  tiles: number[];
  text: boolean;
  meta: boolean;
  /** The encoded payload (JPEG or PNG) differed. */
  payload: boolean;
}

export interface StillsVerification {
  identical: boolean;
  /** Output file SHA-256 equal; required for PNG zips, advisory for PDFs. */
  fileIdentical: boolean;
  a: StillsExportResult;
  b: StillsExportResult;
  divergentPages: number[];
  firstDivergence?: StillsDivergence;
}

/** Compares two stills runs: page RGBA tiles, text layers and metadata must match, and a PNG zip's file bytes too; a PDF's JPEG and file bytes are reported but never fail it. */
export function compareStillsRuns(
  a: StillsExportResult,
  b: StillsExportResult,
  format: StillsFormat,
): StillsVerification {
  const fileIdentical = a.sha256 === b.sha256;
  const divergentPages: number[] = [];
  let firstDivergence: StillsDivergence | undefined;
  const pages = Math.max(a.digests.length, b.digests.length);
  for (let i = 0; i < pages; i++) {
    const da = a.digests[i];
    const db = b.digests[i];
    const tiles: number[] = [];
    for (let t = 0; t < 64; t++) if (da?.tiles[t] !== db?.tiles[t]) tiles.push(t);
    const text = da?.text !== db?.text;
    const meta = da?.meta !== db?.meta;
    const payload = a.pageSha256[i] !== b.pageSha256[i];
    const strict = tiles.length > 0 || text || meta || (format === "png-zip" && payload);
    if (strict) {
      divergentPages.push(i);
      firstDivergence ??= { page: i, tiles, text, meta, payload };
    }
  }
  const identical =
    a.pages === b.pages && divergentPages.length === 0 && (format === "pdf" || fileIdentical);
  return {
    identical,
    fileIdentical,
    a,
    b,
    divergentPages,
    ...(firstDivergence ? { firstDivergence } : {}),
  };
}

/** Pass B's output suffix: its own file beside pass A's. */
export function verifyPassBSuffix(suffix: string | undefined): string {
  return suffix ? `${suffix}-b` : "b";
}

/** Stills Verify ×2: two runs in one boot under one export hold (the `verifyDeterminism` rationale: no preview frame lands between the passes). Pass B writes its own `-b` file inside pass A's zip folder, so both files stay for diffing and a PNG zip's bytes still compare. */
export async function verifyStills(
  opts: ExportOptions,
  settings: StillsSettings,
  onProgress?: (p: ExportProgress) => void,
): Promise<StillsVerification> {
  setExporting(true);
  try {
    const a = await exportStills(opts, settings, onProgress);
    const b = await exportStills(
      { ...opts, outputSuffix: verifyPassBSuffix(opts.outputSuffix) },
      { ...settings, zipFolder: a.zipFolder ?? settings.zipFolder },
      onProgress,
    );
    return compareStillsRuns(a, b, settings.format);
  } finally {
    setExporting(false);
  }
}
