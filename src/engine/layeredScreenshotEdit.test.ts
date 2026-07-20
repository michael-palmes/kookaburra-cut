import { describe, expect, it } from "vitest";
import {
  addItem,
  addLayer,
  layersInOrder,
  moveLayer,
  nextItemId,
  nextLayerId,
  removeItem,
  removeLayer,
  updateItem,
  updateLayer,
} from "./layeredScreenshotEdit";
import type { LayeredScreenshotItem, SceneDocLayeredScreenshot } from "./sceneDocSchema";
import { defaultLayeredScreenshotPose } from "./sceneLayeredScreenshot";

const screen = (id: string, attach: LayeredScreenshotItem["attach"]): LayeredScreenshotItem => ({
  id,
  kind: "screen",
  src: `assets/${id}.png`,
  media: "image",
  attach,
});

const block = (over: Partial<SceneDocLayeredScreenshot> = {}): SceneDocLayeredScreenshot => ({
  layers: [
    {
      id: "l1",
      visible: true,
      z: 0,
      items: [
        screen("i1", null),
        screen("i2", { to: "i1", side: "right" }),
        screen("i3", { to: "i2", side: "right" }),
        screen("i4", { to: "i1", side: "top" }),
      ],
    },
    { id: "l2", visible: true, z: 1, items: [screen("i9", null)] },
  ],
  pose: defaultLayeredScreenshotPose(),
  ...over,
});

describe("id minting", () => {
  it("mints past the highest taken number across all layers", () => {
    expect(nextItemId(block())).toBe("i10");
    expect(nextLayerId(block())).toBe("l3");
    expect(nextItemId({ layers: [], pose: defaultLayeredScreenshotPose() })).toBe("i1");
  });
});

describe("layer ops", () => {
  it("addLayer appends an empty front layer", () => {
    const next = addLayer(block());
    expect(next.layers).toHaveLength(3);
    expect(next.layers[2]).toEqual({ id: "l3", visible: true, items: [], z: 2 });
  });

  it("removeLayer drops the layer; null for unknown ids", () => {
    expect(removeLayer(block(), "l1")?.layers.map((l) => l.id)).toEqual(["l2"]);
    expect(removeLayer(block(), "ghost")).toBeNull();
  });

  it("moveLayer swaps stacking order and renumbers z; refuses moves off the ends", () => {
    const next = moveLayer(block(), "l1", 1);
    expect(layersInOrder(next ?? block()).map((l) => l.id)).toEqual(["l2", "l1"]);
    expect(next?.layers.find((l) => l.id === "l1")?.z).toBe(1);
    expect(moveLayer(block(), "l1", -1)).toBeNull();
    expect(moveLayer(block(), "l2", 1)).toBeNull();
  });

  it("updateLayer patches only the named layer", () => {
    const next = updateLayer(block(), "l2", { visible: false, gap: 0.4 });
    expect(next?.layers[1]).toMatchObject({ visible: false, gap: 0.4 });
    expect(next?.layers[0].visible).toBe(true);
    expect(updateLayer(block(), "ghost", {})).toBeNull();
  });
});

describe("addItem", () => {
  it("chains a new item onto an existing target", () => {
    const next = addItem(block(), "l1", screen("i5", { to: "i3", side: "right" }));
    expect(next?.layers[0].items.map((i) => i.id)).toContain("i5");
  });

  it("refuses a second root, unknown targets and duplicate ids anywhere", () => {
    expect(addItem(block(), "l1", screen("i5", null))).toBeNull();
    expect(addItem(block(), "l1", screen("i5", { to: "ghost", side: "left" }))).toBeNull();
    expect(addItem(block(), "l1", screen("i9", { to: "i1", side: "left" }))).toBeNull();
  });

  it("roots the first item of an empty layer", () => {
    const withEmpty = addLayer(block());
    const next = addItem(withEmpty, "l3", screen("i5", null));
    expect(next?.layers[2].items[0].attach).toBeNull();
  });
});

describe("removeItem", () => {
  it("re-chains children onto the removed item's parent, keeping their sides", () => {
    const next = removeItem(block(), "l1", "i2");
    const i3 = next?.layers[0].items.find((i) => i.id === "i3");
    expect(i3?.attach).toEqual({ to: "i1", side: "right" });
  });

  it("promotes the first child to root when the root is removed", () => {
    const next = removeItem(block(), "l1", "i1");
    const items = next?.layers[0].items ?? [];
    expect(items.find((i) => i.id === "i2")?.attach).toBeNull();
    expect(items.find((i) => i.id === "i4")?.attach).toEqual({ to: "i2", side: "top" });
    expect(items.find((i) => i.id === "i3")?.attach).toEqual({ to: "i2", side: "right" });
  });

  it("null for unknown layer or item", () => {
    expect(removeItem(block(), "ghost", "i1")).toBeNull();
    expect(removeItem(block(), "l1", "ghost")).toBeNull();
  });
});

describe("updateItem", () => {
  it("patches one item in place", () => {
    const next = updateItem(block(), "l1", "i2", { gap: 0.5, flat: true });
    expect(next?.layers[0].items[1]).toMatchObject({ gap: 0.5, flat: true });
    expect(updateItem(block(), "l1", "ghost", {})).toBeNull();
  });
});
