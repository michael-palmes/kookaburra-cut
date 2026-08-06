import { beforeEach, describe, expect, it } from "vitest";
import { useClockStore } from "../engine/clock";
import { clampLaneSeek, type LaneWindow, seekSceneLocal } from "./laneSeek";

const win = (over: Partial<LaneWindow> = {}): LaneWindow => ({
  windowStartMs: 200,
  windowEndMs: 3800,
  lastScene: false,
  ...over,
});

describe("clampLaneSeek", () => {
  it("holds a seek inside the window, one ms short of the next scene", () => {
    expect(clampLaneSeek(1000, win())).toBe(1000);
    expect(clampLaneSeek(0, win())).toBe(200);
    expect(clampLaneSeek(9000, win())).toBe(3799);
  });

  it("lands exactly on the window end when nothing follows", () => {
    expect(clampLaneSeek(9000, win({ lastScene: true }))).toBe(3800);
  });

  it("floors on the window start when the window has no width", () => {
    expect(clampLaneSeek(0, win({ windowStartMs: 500, windowEndMs: 500 }))).toBe(500);
  });
});

describe("seekSceneLocal", () => {
  beforeEach(() => useClockStore.setState({ currentMs: 0, durationMs: 10000 }));

  it("seeks the clock to the slot-relative time", () => {
    seekSceneLocal(2000, 1000, win());
    expect(useClockStore.getState().currentMs).toBe(3000);
  });

  it("never runs past the project", () => {
    useClockStore.setState({ durationMs: 2500 });
    seekSceneLocal(2000, 1000, win());
    expect(useClockStore.getState().currentMs).toBe(2500);
  });
});
