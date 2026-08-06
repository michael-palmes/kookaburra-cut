import { useCameraEditStore } from "../engine/cameraEditStore";
import { useChartTrackEditStore } from "../engine/chartTrackEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";

/** Stacked lanes each bind window-level key handlers, so only ONE selection may be live: a lane taking a selection clears the others, or Delete and the arrows would edit every stacked lane at once. */

export type LaneKind = "camera" | "compare" | "layeredScreenshot" | "chart";

export function clearOtherLaneSelections(lane: LaneKind) {
  if (lane !== "camera") useCameraEditStore.getState().select(null, null);
  if (lane !== "compare") useCompareEditStore.getState().select(null, null);
  if (lane !== "layeredScreenshot") useLayeredScreenshotEditStore.getState().selectKey(null, null);
  if (lane !== "chart") useChartTrackEditStore.getState().select(null, null);
}
