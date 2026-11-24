import { describe, expect, it } from "vitest";
import { createMirrorNest, MIRROR_DEPTH_CAP } from "./mirrorNest";

function mirrorRenders(floors: number, nest: ReturnType<typeof createMirrorNest>): number {
  const hidden = new Set<number>();
  let renders = 0;
  const draw = () => {
    for (let f = 0; f < floors; f++) {
      if (hidden.has(f) || nest.full()) continue;
      hidden.add(f);
      renders += 1;
      nest.within(draw);
      hidden.delete(f);
    }
  };
  draw();
  return renders;
}

describe("createMirrorNest", () => {
  it("mirrors a lone floor once, whatever the cap", () => {
    expect(mirrorRenders(1, createMirrorNest())).toBe(1);
    expect(mirrorRenders(1, createMirrorNest(Number.POSITIVE_INFINITY))).toBe(1);
  });

  it("keeps many floors in one render to one mirror each", () => {
    expect(MIRROR_DEPTH_CAP).toBe(1);
    expect(mirrorRenders(24, createMirrorNest())).toBe(24);
    expect(mirrorRenders(24, createMirrorNest(2))).toBe(24 + 24 * 23);
    expect(mirrorRenders(4, createMirrorNest(Number.POSITIVE_INFINITY))).toBe(4 + 12 + 24 + 24);
  });

  it("unwinds its depth when a render throws", () => {
    const nest = createMirrorNest();
    expect(() =>
      nest.within(() => {
        expect(nest.depth).toBe(1);
        expect(nest.full()).toBe(true);
        throw new Error("lost context");
      }),
    ).toThrow("lost context");
    expect(nest.depth).toBe(0);
    expect(nest.full()).toBe(false);
  });
});
