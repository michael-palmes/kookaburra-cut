import { describe, expect, it } from "vitest";
import {
  DEFAULT_ITEM_GAP,
  fitStackScale,
  MAX_LAYER_STEP,
  MIN_LAYER_STEP,
  SCREEN_HEIGHT,
  solveLayerLayout,
  spreadZToLocal,
} from "./layeredScreenshotLayout";
import type { LayeredScreenshotItem, LayeredScreenshotLayer } from "./sceneDocSchema";

const screen = (
  id: string,
  attach: LayeredScreenshotItem["attach"],
  over: Partial<LayeredScreenshotItem> = {},
): LayeredScreenshotItem => ({
  id,
  kind: "screen",
  src: `assets/${id}.png`,
  media: "image",
  attach,
  ...over,
});

const layer = (
  items: LayeredScreenshotItem[],
  over: Partial<LayeredScreenshotLayer> = {},
): LayeredScreenshotLayer => ({ id: "l1", visible: true, z: 0, items, ...over });

// A square screen keeps the golden maths readable: width = height = SCREEN_HEIGHT.
const square = (id: string) => ({ id, aspect: 1 });

describe("solveLayerLayout", () => {
  it("stacks a single-direction chain outward with the default gap, then centres", () => {
    const solved = solveLayerLayout(
      layer([screen("a", null), screen("b", { to: "a", side: "right" })]),
      [square("a"), square("b")],
    );
    const [a, b] = solved.items;
    // Two squares plus one gap, centred: each centre sits half the (width + gap) from origin.
    const offset = (SCREEN_HEIGHT + DEFAULT_ITEM_GAP) / 2;
    expect(a.x).toBeCloseTo(-offset);
    expect(b.x).toBeCloseTo(offset);
    expect(a.y).toBeCloseTo(0);
    expect(solved.width).toBeCloseTo(SCREEN_HEIGHT * 2 + DEFAULT_ITEM_GAP);
    expect(solved.height).toBeCloseTo(SCREEN_HEIGHT);
  });

  it("branches four ways off one root", () => {
    const solved = solveLayerLayout(
      layer([
        screen("c", null),
        screen("l", { to: "c", side: "left" }),
        screen("r", { to: "c", side: "right" }),
        screen("t", { to: "c", side: "top" }),
        screen("b", { to: "c", side: "bottom" }),
      ]),
      ["c", "l", "r", "t", "b"].map(square),
    );
    const by = new Map(solved.items.map((i) => [i.id, i]));
    const span = SCREEN_HEIGHT + DEFAULT_ITEM_GAP;
    expect(by.get("c")?.x).toBeCloseTo(0);
    expect(by.get("c")?.y).toBeCloseTo(0);
    expect(by.get("l")?.x).toBeCloseTo(-span);
    expect(by.get("r")?.x).toBeCloseTo(span);
    expect(by.get("t")?.y).toBeCloseTo(span);
    expect(by.get("b")?.y).toBeCloseTo(-span);
  });

  it("extends chained strips through intermediate items", () => {
    const solved = solveLayerLayout(
      layer([
        screen("c", null),
        screen("r1", { to: "c", side: "right" }),
        screen("r2", { to: "r1", side: "right" }),
      ]),
      ["c", "r1", "r2"].map(square),
    );
    const by = new Map(solved.items.map((i) => [i.id, i]));
    const span = SCREEN_HEIGHT + DEFAULT_ITEM_GAP;
    // Chain spans three squares; centring shifts everything half a span left of the middle item.
    expect((by.get("r1")?.x ?? 0) - (by.get("c")?.x ?? 0)).toBeCloseTo(span);
    expect((by.get("r2")?.x ?? 0) - (by.get("r1")?.x ?? 0)).toBeCloseTo(span);
    expect(by.get("r1")?.x).toBeCloseTo(0);
  });

  it("honours per-item and per-layer gap overrides", () => {
    const custom = solveLayerLayout(
      layer([screen("a", null), screen("b", { to: "a", side: "right" }, { gap: 1 })], {
        gap: 0.5,
      }),
      [square("a"), square("b")],
    );
    const [a, b] = custom.items;
    expect(b.x - a.x).toBeCloseTo(SCREEN_HEIGHT + 1);
    const layerGap = solveLayerLayout(
      layer([screen("a", null), screen("b", { to: "a", side: "right" })], { gap: 0.5 }),
      [square("a"), square("b")],
    );
    expect(layerGap.items[1].x - layerGap.items[0].x).toBeCloseTo(SCREEN_HEIGHT + 0.5);
  });

  it("sizes screens from their measured aspect and text from its width", () => {
    const solved = solveLayerLayout(
      layer([
        screen("wide", null),
        { id: "note", kind: "text", width: 1.5, attach: { to: "wide", side: "right" } },
      ]),
      [{ id: "wide", aspect: 2 }],
    );
    const by = new Map(solved.items.map((i) => [i.id, i]));
    expect(by.get("wide")?.width).toBeCloseTo(SCREEN_HEIGHT * 2);
    expect(by.get("note")?.width).toBeCloseTo(1.5);
  });

  it("returns an empty layout for an empty layer", () => {
    expect(solveLayerLayout(layer([]), [])).toEqual({ id: "l1", items: [], width: 0, height: 0 });
  });
});

describe("fitStackScale", () => {
  it("fits the widest visible layer into the safe frame, up or down", () => {
    const layouts = [
      { id: "l1", items: [], width: 8, height: 2 },
      { id: "l2", items: [], width: 4, height: 4 },
    ];
    expect(fitStackScale(layouts, 4, 4)).toBeCloseTo(0.5);
    expect(fitStackScale(layouts, 16, 16)).toBeCloseTo(2);
    expect(fitStackScale([], 4, 4)).toBe(1);
  });
});

describe("spreadZToLocal", () => {
  it("keeps a non-clipping minimum step at spread 0 and grows to the expanded step", () => {
    const flat = spreadZToLocal(0, 3);
    expect(flat[1] - flat[0]).toBeCloseTo(MIN_LAYER_STEP);
    const expanded = spreadZToLocal(1, 3);
    expect(expanded[1] - expanded[0]).toBeCloseTo(MAX_LAYER_STEP);
  });

  it("never lets neighbouring layers close beneath the minimum step at any spread", () => {
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const z = spreadZToLocal(s, 5);
      for (let i = 1; i < z.length; i++) {
        expect(z[i] - z[i - 1]).toBeGreaterThanOrEqual(MIN_LAYER_STEP - 1e-9);
      }
    }
  });

  it("centres the stack and clamps spread", () => {
    const z = spreadZToLocal(2, 4);
    expect(z[0] + z[3]).toBeCloseTo(0);
    expect(z[3] - z[2]).toBeCloseTo(MAX_LAYER_STEP);
  });
});
