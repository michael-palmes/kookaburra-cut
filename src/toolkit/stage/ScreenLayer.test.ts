import { Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { stackInJsxOrder } from "./ScreenLayer";
import { sampleScreenFill } from "./screenFills";

describe("stackInJsxOrder", () => {
  const leaf = () => new Mesh(undefined, new MeshBasicMaterial());

  it("orders renderables by tree position, whichever was created first", () => {
    const late = leaf();
    const first = leaf();
    const nested = leaf();
    const root = new Group();
    const inner = new Group();
    inner.add(nested);
    root.add(first, inner, late);
    stackInJsxOrder(root);
    expect([first, nested, late].map((m) => m.renderOrder)).toEqual([0, 1, 2]);
  });

  it("turns the depth test off on every material, arrays included", () => {
    const single = leaf();
    const a = new MeshBasicMaterial();
    const b = new MeshBasicMaterial();
    const both = new Mesh(undefined, [a, b]);
    const root = new Group();
    root.add(single, both);
    stackInJsxOrder(root);
    for (const m of [single.material, a, b]) {
      expect(m.depthTest).toBe(false);
      expect(m.depthWrite).toBe(false);
    }
  });

  it("leaves plain groups alone: a group's renderOrder outranks its children's", () => {
    const root = new Group();
    const inner = new Group();
    inner.add(leaf());
    root.add(inner);
    stackInJsxOrder(root);
    expect(inner.renderOrder).toBe(0);
  });
});

describe("sampleScreenFill", () => {
  const spec = { opacity: 0.6, angleDeg: 180, start: 0, end: 1 };

  it("holds the props without keys", () => {
    expect(sampleScreenFill(spec, 500)).toEqual(spec);
  });

  it("lets keys override only what they name", () => {
    const keyed = {
      ...spec,
      keys: [
        { tMs: 0, opacity: 0 },
        { tMs: 1000, opacity: 1 },
      ],
    };
    expect(sampleScreenFill(keyed, 500)).toEqual({ ...spec, opacity: 0.5 });
    expect(sampleScreenFill(keyed, -5).opacity).toBe(0);
    expect(sampleScreenFill(keyed, 2000).opacity).toBe(1);
  });

  it("keeps opacity within 0..1", () => {
    expect(sampleScreenFill({ ...spec, opacity: 3 }, 0).opacity).toBe(1);
    expect(sampleScreenFill({ ...spec, opacity: -1 }, 0).opacity).toBe(0);
  });
});
