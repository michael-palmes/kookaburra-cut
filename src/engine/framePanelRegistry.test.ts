import { Group } from "three";
import { describe, expect, it } from "vitest";
import { type FramePanelHandle, framePanelsFor } from "./framePanelRegistry";

describe("framePanelsFor", () => {
  it("keeps a legacy framed comparison on its unchanged path", () => {
    const group = new Group();
    const handles: FramePanelHandle[] = [{ index: 2, group, hasSceneImages: false }];
    expect(framePanelsFor(handles, 2, true)).toBeNull();
    expect(framePanelsFor(handles, 2)?.map((p) => p.group)).toEqual([group]);
  });

  it("returns the matching panel only when first-class Overlay images are present", () => {
    const legacy = new Group();
    const imagePanel = new Group();
    const handles: FramePanelHandle[] = [
      { index: 1, group: legacy, hasSceneImages: false },
      { index: 2, group: imagePanel, hasSceneImages: true },
    ];
    expect(framePanelsFor(handles, 1, true)).toBeNull();
    expect(framePanelsFor(handles, 2, true)?.map((p) => p.group)).toEqual([imagePanel]);
    expect(framePanelsFor(handles, 3, true)).toBeNull();
  });

  it("draws the scene's own panel first, then its screen layers in mount order", () => {
    const panel = new Group();
    const first = new Group();
    const second = new Group();
    const handles: FramePanelHandle[] = [
      { index: 0, group: first, hasSceneImages: true, screenLayer: true },
      { index: 0, group: second, hasSceneImages: true, screenLayer: true },
      { index: 0, group: panel, hasSceneImages: false },
    ];
    expect(framePanelsFor(handles, 0)?.map((p) => p.group)).toEqual([panel, first, second]);
    expect(framePanelsFor(handles, 0, true)?.map((p) => p.group)).toEqual([first, second]);
  });
});
