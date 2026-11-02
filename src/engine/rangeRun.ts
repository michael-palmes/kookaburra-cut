/** A ranged render as the stage worker executes it (docs/agent-kit.md, "Ranged checks"): one preamble over the span, then the export loop's own frame block per frame, each readback going back to the window and never encoded. Mid-edit like a capture, so the person's selection, camera pose and playhead come back at the end. */

import { flushSync } from "react-dom";
import type { PerspectiveCamera } from "three";
import { Vector2 } from "three";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { useChartEditStore } from "./chartEditStore";
import { releaseIdleClipFrames } from "./clips";
import { useClockStore } from "./clock";
import { useDeviceEditStore } from "./deviceEditStore";
import { canvasHandle } from "./exportBridge";
import { buildFramePlans, type FramePlans, type FrameRig, renderFrameInto } from "./exportFrame";
import {
  assertNoSceneHolds,
  exportPreamble,
  sizeForExport,
  snapshotPreviewState,
} from "./exportRun";
import { setExporting } from "./exportState";
import { getFramePanels } from "./framePanelRegistry";
import { useImageEditStore } from "./imageEditStore";
import { HELPER_LAYER } from "./lightEditStore";
import { useObjectEditStore } from "./objectEditStore";
import { getPersistentLayers } from "./persistentLayerRegistry";
import { assertContextHeld } from "./readback";
import { hasSceneCameraTracks } from "./sceneCamera";
import { resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import { type Resolved, resolveAt } from "./sceneTimeline";
import type { StageExportOptions } from "./stageProtocol";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { collectPageText, pageTextRoots, type StillTextItem } from "./stillText";

/** A visible text line on the frame, normalised (top-left origin), and the scene it belongs to. */
export interface SceneTextBox extends StillTextItem {
  scene: number;
}

/** Everything one ranged render holds between its frames. */
export interface RangeRun {
  rig: FrameRig;
  opts: StageExportOptions;
  restore: () => void;
}

/** Every visible troika line the frame drew, per scene on screen (both sides of a transition). */
function frameTexts(
  plans: FramePlans,
  resolved: Resolved,
  camera: PerspectiveCamera,
  width: number,
  height: number,
): SceneTextBox[] {
  const compare = resolveCompareFrame(
    plans.compareSpecs,
    plans.sceneStates,
    plans.sceneStatesB,
    resolved,
  );
  const indices = [...new Set(resolved.active.map((r) => r.index))];
  return indices.flatMap((idx) =>
    collectPageText(
      pageTextRoots({
        sceneIndex: idx,
        hosts: getSceneHosts(),
        framePanels: getFramePanels(),
        persistent: getPersistentLayers(),
        camera,
        overlay: plans.overlays?.[idx] ?? null,
        comparing: compare.some((p) => p.index === idx),
        width,
        height,
      }),
      camera.layers,
    ).map((item) => ({ ...item, scene: idx })),
  );
}

export async function beginRangeRun(
  opts: StageExportOptions,
  spanMs: readonly [number, number],
): Promise<RangeRun> {
  assertNoSceneHolds("ranged render");
  const handle = canvasHandle.current;
  if (!handle) throw new Error("Export bridge not mounted: the canvas is not ready.");
  const { gl, scene, camera } = handle;
  assertContextHeld(gl.getContext(), "before the ranged render");
  const prevSelection = {
    object: useObjectEditStore.getState().selected,
    chart: useChartEditStore.getState().selected,
    device: useDeviceEditStore.getState().selected,
    image: useImageEditStore.getState().selected,
  };
  const restorePreview = snapshotPreviewState(gl, camera);
  const cam = camera as PerspectiveCamera;
  let restoreCameraPose: (() => void) | null = null;
  let clockOwned: () => number | null = () => null;
  setExporting(true);
  releaseIdleClipFrames();
  const restore = () => {
    setExporting(false);
    releaseIdleClipFrames();
    const prevClockMs = restorePreview();
    restoreCameraPose?.();
    useObjectEditStore.getState().select(prevSelection.object);
    useChartEditStore.getState().select(prevSelection.chart);
    useDeviceEditStore.getState().select(prevSelection.device);
    useImageEditStore.getState().select(prevSelection.image);
    const owned = clockOwned();
    if (owned !== null && useClockStore.getState().currentMs === owned) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  };
  try {
    await exportPreamble(opts, gl, undefined, undefined, spanMs);
    const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);
    const { width, height } = opts.format;
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
    return { rig, opts, restore };
  } catch (e) {
    restore();
    throw e;
  }
}

/** One frame into `buffer` when the window hands the last one back, else the run's own; the first draws twice, so it is never a run's first draw. */
export async function renderRangeFrame(
  run: RangeRun,
  index: number,
  tMs: number,
  buffer: ArrayBuffer | null,
  wantTexts: boolean,
): Promise<{ rgba: Uint8Array; texts?: SceneTextBox[] }> {
  const { rig, opts } = run;
  const { width, height, plans, camera } = rig;
  const bytes = width * height * 4;
  if (buffer && buffer.byteLength === bytes) rig.rgba = new Uint8Array(buffer);
  else if (rig.rgba.byteLength !== bytes) rig.rgba = new Uint8Array(bytes);
  const resolved = resolveAt(opts.slots, tMs);
  let texts: SceneTextBox[] | undefined;
  await renderFrameInto(
    rig,
    tMs,
    resolved,
    index === 0 ? 2 : 1,
    `ranged frame ${index + 1}`,
    wantTexts
      ? () => {
          texts = frameTexts(plans, resolved, camera as PerspectiveCamera, width, height);
        }
      : undefined,
  );
  return { rgba: rig.rgba, ...(texts ? { texts } : {}) };
}

export function endRangeRun(run: RangeRun): void {
  run.restore();
}
