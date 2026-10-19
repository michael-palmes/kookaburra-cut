import { DoubleSide, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { createExactTextBase, materialProp } from "./exactText";

describe("exactText base material", () => {
  it("is troika's default text base with only tone mapping turned off", () => {
    const base = createExactTextBase();
    const troikaDefault = new MeshBasicMaterial({
      color: 0xffffff,
      side: DoubleSide,
      transparent: true,
    });
    expect(base.toneMapped).toBe(false);
    const { uuid: _a, toneMapped: _b, ...exact } = base.toJSON();
    const { uuid: _c, ...stock } = troikaDefault.toJSON();
    expect(exact).toEqual(stock);
  });

  it("names no material prop when there is none, so default Text sites pass nothing", () => {
    expect(materialProp(null)).toEqual({});
    expect(materialProp(undefined)).toEqual({});
    const base = createExactTextBase();
    expect(materialProp(base)).toEqual({ material: base });
  });
});
