import { flushSync } from "react-dom";
import type { PerspectiveCamera, Scene } from "three";
import { Vector2 } from "three";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { everydayClipLane, setClipLane } from "./clips";
import { useClockStore } from "./clock";
import { downscaleScratchLength, pageFromReadback } from "./downscale";
import { canvasHandle } from "./exportBridge";
import { tileHashFrame } from "./exporter";
import {
  awaitHoldsCommitted,
  awaitTextSync,
  buildFramePlans,
  type FrameRig,
  renderFrameInto,
} from "./exportFrame";
import { exportPreamble } from "./exportRun";
import { setExporting } from "./exportState";
import { getFramePanels } from "./framePanelRegistry";
import { HELPER_LAYER } from "./lightEditStore";
import { yieldMacrotask } from "./macrotask";
import { getPersistentLayers } from "./persistentLayerRegistry";
import { clearSceneHolds, replaceSceneHolds } from "./presentHold";
import { presentTimingsPendingCount, snapshotPresentTimings } from "./presentTimingRegistry";
import { sceneFileStem } from "./project";
import { assertContextHeld } from "./readback";
import { hasSceneCameraTracks } from "./sceneCamera";
import { resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import { largestSceneText, useSceneTextRegistry } from "./sceneTextRegistry";
import { sceneTitle } from "./sceneTitle";
import type { StageExportOptions } from "./stageProtocol";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { planStillPages, type StillPage, type StillsWarning } from "./stillPages";
import { stillsPixelSize } from "./stills";
import type { StillPageDigest, StillsSettings } from "./stillsExport";
import { collectPageText, fallbackPageText, pageTextRoots, type StillTextItem } from "./stillText";

/** The stills export as the stage worker executes it: the export preamble, the page plan from settled Present timings, the holds, then one page at a time rendered through `renderFrameInto`, flipped and downscaled, encoded and hashed. The window streams each page to the native writer (docs/stills.md). */

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
function sceneNames(opts: StageExportOptions, settings: StillsSettings): string[] {
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

/** A page as the window pushes it: the native body, its headers and the page's verify hash. */
export interface StillPageOutput {
  body: Uint8Array;
  headers: Record<string, string>;
  pageHash: string;
  digest: StillPageDigest;
}

export interface StillsRun {
  total: number;
  pageTimesMs: number[];
  warnings: StillsWarning[];
  pageMeta: string[];
  render: (page: number) => Promise<StillPageOutput>;
  end: () => void;
}

/** The run's setup: preamble, export sizing, plans without a shutter, settled timings, the page plan and its holds. `end` always clears the holds before the preview resumes. */
export async function beginStillsRun(
  input: StageExportOptions,
  settings: StillsSettings,
  onPrepareStep?: (step: number) => void,
): Promise<StillsRun> {
  // No codec or encode spec: the deterministic software clip lane pins, as for every gated export.
  const opts: StageExportOptions = { ...input, codec: undefined, encode: undefined };
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;
  assertContextHeld(gl.getContext(), "before the stills export");

  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  let rig: FrameRig | null = null;
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;
  const prevHelperLayer = cam.layers.isEnabled(HELPER_LAYER);
  setExporting(true);
  const end = () => {
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
  };
  try {
    await exportPreamble(opts, gl, onPrepareStep);
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
    // Stills are settled handouts: never motion blurred.
    const plans = { ...buildFramePlans(opts, sceneFloorYs), shutter: null };

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
    await awaitHoldsCommitted(replaceSceneHolds(plan.holds));

    const total = plan.pages.length;
    const page = stillsPixelSize(opts.format, settings.size);
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
    const frameRig = rig;
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
    const render = async (i: number): Promise<StillPageOutput> => {
      const still = plan.pages[i];
      await renderFrameInto(
        frameRig,
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
      const digest: StillPageDigest = {
        tiles: tileHashFrame(new Uint8Array(pixels.buffer), page.width, page.height),
        text,
        meta,
      };
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
        // A copy: the page buffer is reused, and the bytes leave this realm.
        body = new Uint8Array(pixels);
      }
      return { body, headers, pageHash: await digestHash(digest), digest };
    };
    return {
      total,
      pageTimesMs: plan.pages.map((p) => Math.round(p.tMs * 1000) / 1000),
      warnings: plan.warnings,
      pageMeta: plan.pages.map(stillPageMeta),
      render,
      end,
    };
  } catch (e) {
    end();
    throw e;
  }
}

export async function sha256HexOf(text: string): Promise<string> {
  return sha256Hex(utf8.encode(text));
}
