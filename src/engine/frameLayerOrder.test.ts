import { describe, expect, it } from "vitest";
import { frameLayerRenderOrder, nextFrameStackOrder } from "./frameLayerOrder";

describe("frameLayerOrder", () => {
  it("keeps below and above content in separate stable bands", () => {
    expect(frameLayerRenderOrder("below", 4)).toBe(-996);
    expect(frameLayerRenderOrder("above", 4)).toBe(1004);
    expect(frameLayerRenderOrder(undefined, 0)).toBe(1000);
  });

  it("places unnumbered images after every existing decoration", () => {
    expect(nextFrameStackOrder([])).toBe(0);
    expect(nextFrameStackOrder([{}, {}])).toBe(2);
    expect(nextFrameStackOrder([{ stackOrder: 7 }, {}])).toBe(8);
  });
});
