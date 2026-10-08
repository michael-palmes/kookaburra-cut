import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSceneHolds,
  hasSceneHolds,
  replaceSceneHolds,
  sceneHoldsVersion,
  setSceneHold,
  subscribeSceneHolds,
} from "./presentHold";

afterEach(() => clearSceneHolds());

describe("scene hold store", () => {
  it("replaces every hold in one notify and returns the bumped version", () => {
    setSceneHold(7, 100);
    const listener = vi.fn();
    const unsubscribe = subscribeSceneHolds(listener);
    const before = sceneHoldsVersion();
    const version = replaceSceneHolds(
      new Map([
        [0, 450],
        [2, 900],
      ]),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(version).toBe(before + 1);
    expect(sceneHoldsVersion()).toBe(version);
    expect(hasSceneHolds()).toBe(true);
    unsubscribe();
  });

  it("bumps the version on clear only when something was held", () => {
    replaceSceneHolds(new Map([[1, 300]]));
    const held = sceneHoldsVersion();
    clearSceneHolds();
    expect(sceneHoldsVersion()).toBe(held + 1);
    expect(hasSceneHolds()).toBe(false);
    clearSceneHolds();
    expect(sceneHoldsVersion()).toBe(held + 1);
  });

  it("keeps a private copy of the replacement map", () => {
    const map = new Map([[0, 450]]);
    replaceSceneHolds(map);
    map.clear();
    expect(hasSceneHolds()).toBe(true);
  });
});
