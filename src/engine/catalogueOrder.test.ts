import { describe, expect, it } from "vitest";
import {
  CATALOGUE_ORDER_GAP,
  moveInList,
  normaliseOrders,
  renumberOrders,
  reorderCatalogue,
} from "./catalogueOrder";

describe("renumberOrders", () => {
  it("numbers in gaps, first item at the gap", () => {
    expect(renumberOrders(["a", "b", "c"])).toEqual([
      { id: "a", order: 10 },
      { id: "b", order: 20 },
      { id: "c", order: 30 },
    ]);
    expect(CATALOGUE_ORDER_GAP).toBe(10);
  });

  it("handles an empty category", () => {
    expect(renumberOrders([])).toEqual([]);
  });
});

describe("moveInList", () => {
  it("moves an item forwards and backwards", () => {
    expect(moveInList(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveInList(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("returns a copy when nothing moves", () => {
    const ids = ["a", "b"];
    const next = moveInList(ids, 1, 1);
    expect(next).toEqual(ids);
    expect(next).not.toBe(ids);
  });

  it("clamps indices past either end", () => {
    expect(moveInList(["a", "b", "c"], -4, 9)).toEqual(["b", "c", "a"]);
    expect(moveInList(["a", "b", "c"], 9, -4)).toEqual(["c", "a", "b"]);
  });

  it("leaves an empty list alone", () => {
    expect(moveInList([], 0, 1)).toEqual([]);
  });
});

describe("reorderCatalogue", () => {
  it("returns the new order and the orders to write", () => {
    const result = reorderCatalogue(["a", "b", "c"], 2, 0);
    expect(result.ids).toEqual(["c", "a", "b"]);
    expect(result.orders).toEqual([
      { id: "c", order: 10 },
      { id: "a", order: 20 },
      { id: "b", order: 30 },
    ]);
    expect(result.changed).toBe(true);
  });

  it("reports an unchanged drag so the caller can skip the writes", () => {
    expect(reorderCatalogue(["a", "b", "c"], 1, 1).changed).toBe(false);
  });
});

describe("normaliseOrders", () => {
  it("returns only the entries whose order moves", () => {
    expect(
      normaliseOrders([
        { id: "a", order: 10 },
        { id: "b", order: 15 },
        { id: "c", order: 15 },
      ]),
    ).toEqual([
      { id: "b", order: 20 },
      { id: "c", order: 30 },
    ]);
  });

  it("writes nothing for a tidy category", () => {
    expect(
      normaliseOrders([
        { id: "a", order: 10 },
        { id: "b", order: 20 },
      ]),
    ).toEqual([]);
  });
});
