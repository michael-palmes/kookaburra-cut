import { describe, expect, it } from "vitest";
import { moveSelection, planDeletes, planDuplicates, planMoves } from "./sceneOrder";

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

describe("planDuplicates", () => {
  it("copies a contiguous selection as one block after the last of them", () => {
    expect(planDuplicates([0, 1])).toEqual([
      { from: 0, at: 2 },
      { from: 1, at: 3 },
    ]);
  });

  it("puts a gappy selection's copies after the LAST selected scene", () => {
    expect(planDuplicates([1, 4])).toEqual([
      { from: 1, at: 5 },
      { from: 4, at: 6 },
    ]);
  });

  it("sorts and dedupes the selection", () => {
    expect(planDuplicates([4, 1, 4])).toEqual(planDuplicates([1, 4]));
  });

  it("has nothing to do for an empty selection", () => {
    expect(planDuplicates([])).toEqual([]);
  });

  it("replayed sequentially, the copies land as one block in source order", () => {
    for (const [count, selected] of [
      [2, [0, 1]],
      [6, [1, 4]],
      [4, [0, 2, 3]],
      [5, [2]],
      [3, [0, 1, 2]],
    ] as [number, number[]][]) {
      const before = Array.from({ length: count }, (_, i) => `s${i}`);
      const scenes = [...before];
      for (const { from, at } of planDuplicates(selected)) {
        scenes.splice(at, 0, `${scenes[from]} copy`);
      }
      const last = selected[selected.length - 1];
      expect(scenes).toEqual([
        ...before.slice(0, last + 1),
        ...selected.map((i) => `s${i} copy`),
        ...before.slice(last + 1),
      ]);
    }
  });
});

describe("planDeletes", () => {
  it("issues the selection descending so earlier removals never shift later ones", () => {
    expect(planDeletes([1, 2], 4)).toEqual([2, 1]);
    expect(planDeletes([0, 3], 4)).toEqual([3, 0]);
  });

  it("replayed sequentially, exactly the selected scenes go", () => {
    for (const [count, selected] of [
      [4, [1, 2]],
      [4, [0, 3]],
      [5, [0, 1, 2]],
      [3, [1]],
    ] as [number, number[]][]) {
      const before = Array.from({ length: count }, (_, i) => `s${i}`);
      const scenes = [...before];
      for (const index of planDeletes(selected, count)) {
        scenes.splice(index, 1);
      }
      expect(scenes).toEqual(before.filter((_, i) => !selected.includes(i)));
    }
  });

  it("refuses a selection that would empty the project", () => {
    expect(planDeletes([0, 1], 2)).toEqual([]);
    expect(planDeletes([0], 1)).toEqual([]);
    expect(planDeletes([2, 0, 1], 3)).toEqual([]);
  });

  it("keeps a partial selection of a two-scene project", () => {
    expect(planDeletes([1], 2)).toEqual([1]);
  });

  it("dedupes and drops out-of-range indices", () => {
    expect(planDeletes([1, 1, 9, -1], 4)).toEqual([1]);
    expect(planDeletes([], 4)).toEqual([]);
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
