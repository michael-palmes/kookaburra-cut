import { useCameraEditStore } from "../engine/cameraEditStore";
import { useChartTrackEditStore } from "../engine/chartTrackEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import { useDeviceTrackEditStore } from "../engine/deviceTrackEditStore";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import { useLightingEditStore } from "../engine/lightingEditStore";

/** Stacked lanes each bind window-level key handlers, so only ONE selection may be live: a lane taking a selection clears the others, or Delete and the arrows would edit every stacked lane at once. */

export type LaneKind = "camera" | "compare" | "layeredScreenshot" | "chart" | "lighting" | "device";

export function animationLaneMasterOpen(
  layeredScreenshotActive: boolean,
  cameraOpen: boolean,
  layeredScreenshotOpen: boolean,
): boolean {
  return layeredScreenshotActive ? layeredScreenshotOpen : cameraOpen;
}

export function clearOtherLaneSelections(lane: LaneKind) {
  if (lane !== "camera") useCameraEditStore.getState().select(null, null);
  if (lane !== "compare") useCompareEditStore.getState().select(null, null);
  if (lane !== "layeredScreenshot") useLayeredScreenshotEditStore.getState().selectKey(null, null);
  if (lane !== "chart") useChartTrackEditStore.getState().select(null, null);
  if (lane !== "lighting") useLightingEditStore.getState().select(null, null);
  if (lane !== "device") useDeviceTrackEditStore.getState().select(null, null);
}

/** True while any lane holds a keyframe or segment selection, so a window-level Delete belongs to the lane, not to the inspector's content. */
export function laneSelectionActive(): boolean {
  return [
    useCameraEditStore.getState(),
    useCompareEditStore.getState(),
    useLayeredScreenshotEditStore.getState(),
    useChartTrackEditStore.getState(),
    useLightingEditStore.getState(),
    useDeviceTrackEditStore.getState(),
  ].some((lane) => lane.selectedKeyId !== null || lane.selectedSegment !== null);
}

export function clearSecondaryLaneSelections() {
  useCompareEditStore.getState().select(null, null);
  useChartTrackEditStore.getState().select(null, null);
  useDeviceTrackEditStore.getState().select(null, null);
}
