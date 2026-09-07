import { Group } from "three";
import { describe, expect, it } from "vitest";
import { comparisonFramePanel, type FramePanelHandle } from "./framePanelRegistry";

describe("comparisonFramePanel", () => {
  it("keeps a legacy framed comparison on its unchanged path", () => {
    const group = new Group();
    const handles: FramePanelHandle[] = [{ index: 2, group, hasSceneImages: false }];
    expect(comparisonFramePanel(handles, 2)).toBeNull();
  });

  it("returns the matching panel only when first-class Overlay images are present", () => {
    const legacy = new Group();
    const imagePanel = new Group();
    const handles: FramePanelHandle[] = [
      { index: 1, group: legacy, hasSceneImages: false },
      { index: 2, group: imagePanel, hasSceneImages: true },
    ];
    expect(comparisonFramePanel(handles, 1)).toBeNull();
    expect(comparisonFramePanel(handles, 2)).toBe(imagePanel);
    expect(comparisonFramePanel(handles, 3)).toBeNull();
  });
});
