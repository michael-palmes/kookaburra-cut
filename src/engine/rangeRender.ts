/** The render window's ranged renders (docs/agent-kit.md, "Ranged checks"): one preamble, then the export loop's own frame block over a span, each readback handed on (to the flash detector, a preview clip or a strip) and never encoded. Mid-edit like a capture, so the person's selection, camera pose and playhead come back afterwards. */

import { flushSync } from "react-dom";
import type { PerspectiveCamera } from "three";
import { Vector2 } from "three";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { useChartEditStore } from "./chartEditStore";
import { everydayClipLane, setClipLane } from "./clips";
import { useClockStore } from "./clock";
import { useDeviceEditStore } from "./deviceEditStore";
import { canvasHandle } from "./exportBridge";
import { type ExportOptions, exportPreamble } from "./exporter";
import { buildFramePlans, type FramePlans, type FrameRig, renderFrameInto } from "./exportFrame";
import { setExporting, withExporting } from "./exportState";
import { computeFormat } from "./format";
import { getFramePanels } from "./framePanelRegistry";
import { useImageEditStore } from "./imageEditStore";
import { HELPER_LAYER } from "./lightEditStore";
import { useObjectEditStore } from "./objectEditStore";
import { getPersistentLayers } from "./persistentLayerRegistry";
import { hasSceneHolds } from "./presentHold";
import { assertContextHeld } from "./readback";
import { hasSceneCameraTracks } from "./sceneCamera";
import { resolveCompareFrame } from "./sceneCompare";
import { getSceneHosts } from "./sceneHostRegistry";
import { type Resolved, resolveAt } from "./sceneTimeline";
import { snapshotSceneStageFloors } from "./stageRegistry";
import { collectPageText, pageTextRoots, type StillTextItem } from "./stillText";

/** One rendered frame: the reused readback buffer (GL bottom-up rows) and, when asked, the text it shows. */
export interface RangeFrame {
  index: number;
  tMs: number;
  rgba: Uint8Array;
  width: number;
  height: number;
  texts?: SceneTextBox[];
}

/** A visible text line on the frame, normalised (top-left origin), and the scene it belongs to. */
export interface SceneTextBox extends StillTextItem {
  scene: number;
}

/** The safe area as `useFormat().safe` lays it out, normalised (top-left origin). */
export function safeAreaBox(format: ExportOptions["format"]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const { frame, safe } = computeFormat(format);
  return {
    x: safe.left / frame.width,
    y: safe.top / frame.height,
    w: (frame.width - safe.left - safe.right) / frame.width,
    h: (frame.height - safe.top - safe.bottom) / frame.height,
  };
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

/** Renders `times` (project ms) through the export path, handing each frame to `onFrame` before the next renders. */
export async function renderRange(
  opts: ExportOptions,
  times: readonly number[],
  onFrame: (frame: RangeFrame) => Promise<void>,
  options: { texts?: boolean } = {},
): Promise<void> {
  return withExporting(() => renderRangeHeld(opts, times, onFrame, options));
}

async function renderRangeHeld(
  opts: ExportOptions,
  times: readonly number[],
  onFrame: (frame: RangeFrame) => Promise<void>,
  options: { texts?: boolean },
): Promise<void> {
  if (hasSceneHolds()) {
    throw new Error(
      "Scene holds are active (a stills export is running), so the ranged render cannot start.",
    );
  }
  if (times.length === 0) return;
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
  const prevSize = gl.getSize(new Vector2());
  const prevPixelRatio = gl.getPixelRatio();
  const prevClockMs = useClockStore.getState().currentMs;
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;
  const prevHelperLayer = cam.layers.isEnabled(HELPER_LAYER);
  let restoreCameraPose: (() => void) | null = null;
  let rig: FrameRig | null = null;
  setExporting(true);
  try {
    await exportPreamble(opts, gl, undefined, undefined, [Math.min(...times), Math.max(...times)]);
    const sceneFloorYs = snapshotSceneStageFloors(opts.slots.length);
    const { width, height } = opts.format;
    gl.setPixelRatio(1);
    gl.setSize(width, height, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
    }
    const plans = buildFramePlans(opts, sceneFloorYs);
    rig = {
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
    for (const [index, tMs] of times.entries()) {
      const resolved = resolveAt(opts.slots, tMs);
      let texts: SceneTextBox[] | undefined;
      await renderFrameInto(
        rig,
        tMs,
        resolved,
        index === 0 ? 2 : 1,
        `ranged frame ${index + 1}/${times.length}`,
        options.texts ? () => (texts = frameTexts(plans, resolved, cam, width, height)) : undefined,
      );
      await onFrame({ index, tMs, rgba: rig.rgba, width, height, texts });
    }
  } finally {
    setExporting(false);
    setClipLane(everydayClipLane());
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (cam.isPerspectiveCamera) {
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    }
    if (prevHelperLayer) cam.layers.enable(HELPER_LAYER);
    restoreCameraPose?.();
    useObjectEditStore.getState().select(prevSelection.object);
    useChartEditStore.getState().select(prevSelection.chart);
    useDeviceEditStore.getState().select(prevSelection.device);
    useImageEditStore.getState().select(prevSelection.image);
    const owned = rig?.clockOwnedMs ?? null;
    if (owned !== null && useClockStore.getState().currentMs === owned) {
      flushSync(() => useClockStore.getState().setCurrentMs(prevClockMs));
    }
  }
}
