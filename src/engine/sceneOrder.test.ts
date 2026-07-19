import { describe, expect, it } from "vitest";
import { moveSelection, planMoves } from "./sceneOrder";

describe("moveSelection", () => {
  it("moves one scene forward and back", () => {
    expect(moveSelection(4, [0], 3)).toEqual([1, 2, 0, 3]);
    expect(moveSelection(4, [3], 1)).toEqual([0, 3, 1, 2]);
  });

  it("moves a non-contiguous selection as one block, relative order kept", () => {
    expect(moveSelection(5, [0, 3], 5)).toEqual([1, 2, 4, 0, 3]);
    expect(moveSelection(5, [1, 4], 0)).toEqual([1, 4, 0, 2, 3]);
  });

  it("dropping onto a selected index lands the block at the same spot", () => {
    expect(moveSelection(4, [1, 2], 1)).toEqual([0, 1, 2, 3]);
  });
});

describe("planMoves", () => {
  it("returns no moves for the identity", () => {
    expect(planMoves([0, 1, 2])).toEqual([]);
  });

  it("realises a permutation when replayed as sequential moves", () => {
    for (const desired of [
      [2, 0, 1, 3],
      [3, 2, 1, 0],
      [1, 4, 0, 2, 3],
    ]) {
      const current = desired.map((_, i) => i);
      for (const { from, to } of planMoves(desired)) {
        const [x] = current.splice(from, 1);
        current.splice(to, 0, x);
      }
      expect(current).toEqual(desired);
    }
  });
});
