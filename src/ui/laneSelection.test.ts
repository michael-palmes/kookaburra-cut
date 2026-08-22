import { beforeEach, describe, expect, it } from "vitest";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { useChartTrackEditStore } from "../engine/chartTrackEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import {
  animationLaneMasterOpen,
  clearOtherLaneSelections,
  clearSecondaryLaneSelections,
} from "./laneSelection";

const selectAll = () => {
  useCameraEditStore.getState().select("k1", null);
  useCompareEditStore.getState().select("k2", null);
  useLayeredScreenshotEditStore.getState().selectKey("k3", 1);
  useChartTrackEditStore.getState().select("k4", null);
};

const live = () => ({
  camera: useCameraEditStore.getState().selectedKeyId,
  compare: useCompareEditStore.getState().selectedKeyId,
  stack: useLayeredScreenshotEditStore.getState().selectedKeyId,
  chart: useChartTrackEditStore.getState().selectedKeyId,
});

describe("animationLaneMasterOpen", () => {
  it("takes visibility only from the active master track", () => {
    expect(animationLaneMasterOpen(false, false, true)).toBe(false);
    expect(animationLaneMasterOpen(false, true, false)).toBe(true);
    expect(animationLaneMasterOpen(true, true, false)).toBe(false);
    expect(animationLaneMasterOpen(true, false, true)).toBe(true);
  });
});

describe("clearOtherLaneSelections", () => {
  beforeEach(selectAll);

  it("leaves exactly one live selection, whichever lane took it", () => {
    clearOtherLaneSelections("camera");
    expect(live()).toEqual({ camera: "k1", compare: null, stack: null, chart: null });
    selectAll();
    clearOtherLaneSelections("compare");
    expect(live()).toEqual({ camera: null, compare: "k2", stack: null, chart: null });
    selectAll();
    clearOtherLaneSelections("layeredScreenshot");
    expect(live()).toEqual({ camera: null, compare: null, stack: "k3", chart: null });
    selectAll();
    clearOtherLaneSelections("chart");
    expect(live()).toEqual({ camera: null, compare: null, stack: null, chart: "k4" });
  });

  it("clears the other lanes' segment selections too", () => {
    useCompareEditStore.getState().select(null, 2);
    clearOtherLaneSelections("camera");
    expect(useCompareEditStore.getState().selectedSegment).toBeNull();
    expect(useLayeredScreenshotEditStore.getState().selectedSegment).toBeNull();
  });
});

describe("clearSecondaryLaneSelections", () => {
  beforeEach(selectAll);

  it("clears chart and comparison while preserving the master track selection", () => {
    clearSecondaryLaneSelections();
    expect(live()).toEqual({ camera: "k1", compare: null, stack: "k3", chart: null });
    expect(useCompareEditStore.getState().selectedSegment).toBeNull();
    expect(useChartTrackEditStore.getState().selectedSegment).toBeNull();
  });
});
