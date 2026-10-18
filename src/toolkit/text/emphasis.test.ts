import { Color, type Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  computeEmphasisRects,
  EMPHASIS_WEIGHT_EM,
  EMPHASIS_WEIGHT_MAX_EM,
  MAX_EMPHASIS_RECTS,
  parseEmphasisValue,
  resolveEmphasis,
} from "./emphasis";
import { EDGE_SENTINEL } from "./presets";
import {
  createStaggerTextMaterial,
  writeEmphasisUniforms,
  writeTypeMaskUniforms,
} from "./staggerMaterial";

const colors = { text: "#ffffff", muted: "#888888", accent: "#ff5500" };

describe("parseEmphasisValue", () => {
  it("accepts a token or hex with an optional weight", () => {
    expect(parseEmphasisValue("accent")).toEqual({ colour: "accent" });
    expect(parseEmphasisValue("#0af@700")).toEqual({ colour: "#0af", weight: 700 });
    expect(parseEmphasisValue(" text@400 ")).toEqual({ colour: "text", weight: 400 });
  });

  it("rejects anything else", () => {
    for (const v of ["red", "#12345", "accent@", "accent@0", "accent@1200", 700, null, ""]) {
      expect(parseEmphasisValue(v)).toBeNull();
    }
  });
});

describe("resolveEmphasis", () => {
  it("defaults to the accent one weight step bolder", () => {
    expect(resolveEmphasis(colors, undefined, 400)).toEqual({
      color: "#ff5500",
      weightEm: EMPHASIS_WEIGHT_EM,
    });
    expect(resolveEmphasis(colors, "not valid", 400).color).toBe("#ff5500");
  });

  it("resolves tokens and weights relative to the face, clamped", () => {
    expect(resolveEmphasis(colors, "muted@700", 400).color).toBe("#888888");
    expect(resolveEmphasis(colors, "muted@700", 400).weightEm).toBeCloseTo(0.03, 12);
    expect(resolveEmphasis(colors, "#123456@400", 400)).toEqual({ color: "#123456", weightEm: 0 });
    expect(resolveEmphasis(colors, "text@300", 600).weightEm).toBeCloseTo(-0.03, 12);
    expect(resolveEmphasis(colors, "text@1000", 100).weightEm).toBe(EMPHASIS_WEIGHT_MAX_EM);
  });
});

/** [startX, endX, bottomY, topY] per char. */
function carets(rows: Array<[number, number, number, number]>): Float32Array {
  return new Float32Array(rows.flat());
}

describe("computeEmphasisRects", () => {
  it("covers each range's glyphs per line, skipping whitespace", () => {
    // "ab cd\nef": a range over "cd\nef" wraps onto the second line.
    const text = "ab cd\nef";
    const c = carets([
      [0, 1, 0, 1],
      [1, 2, 0, 1],
      [2, 2.5, 0, 1],
      [2.5, 3.5, 0, 1],
      [3.5, 4.5, 0, 1],
      [4.5, 4.5, 0, 1],
      [0, 1, -1, 0],
      [1, 2, -1, 0],
    ]);
    expect(Array.from(computeEmphasisRects(text, [[3, 8]], c))).toEqual([
      2.5, 0, 4.5, 1, 0, -1, 2, 0,
    ]);
    expect(
      Array.from(
        computeEmphasisRects(
          text,
          [
            [0, 1],
            [3, 5],
          ],
          c,
        ),
      ),
    ).toEqual([0, 0, 1, 1, 2.5, 0, 4.5, 1]);
  });

  it("caps the rect count", () => {
    const text = "x ".repeat(40);
    const c = new Float32Array(text.length * 4);
    for (let i = 0; i < text.length; i++) c.set([i, i + 1, 0, 1], i * 4);
    const ranges = Array.from({ length: 40 }, (_, i) => [i * 2, i * 2 + 1] as const);
    expect(computeEmphasisRects(text, ranges, c).length).toBe(MAX_EMPHASIS_RECTS * 4);
  });
});

describe("emphasis and typewriter uniforms", () => {
  it("emphasis mounts carry the rects, weight and colour; others do not", () => {
    const bare = createStaggerTextMaterial({});
    expect(bare.material.uniforms.uGanEmph).toBeUndefined();
    expect(() => writeEmphasisUniforms(bare, null, 1, new Color())).not.toThrow();
    bare.dispose();
    const mat = createStaggerTextMaterial({ emphasis: true });
    expect(mat.features.emphasis).toBe(true);
    expect(mat.material.uniforms.uGanEmphCount.value).toBe(0);
    writeEmphasisUniforms(
      mat,
      new Float32Array([0, 0, 1, 1, 2, 0, 3, 1]),
      0.015,
      new Color("#ff0000"),
    );
    expect(mat.material.uniforms.uGanEmphCount.value).toBe(2);
    expect(Array.from(mat.material.uniforms.uGanEmph.value.slice(0, 8))).toEqual([
      0, 0, 1, 1, 2, 0, 3, 1,
    ]);
    expect(mat.material.uniforms.uGanEmphWeight.value).toBe(0.015);
    expect(mat.material.uniforms.uGanEmphColor.value.getHex()).toBe(0xff0000);
    writeEmphasisUniforms(mat, null, 0.015, new Color("#ff0000"));
    expect(mat.material.uniforms.uGanEmphCount.value).toBe(0);
    mat.dispose();
  });

  it("the typewriter head starts hidden and takes sentinels or a head", () => {
    const mat = createStaggerTextMaterial({ typeMask: true });
    const head = mat.material.uniforms.uGanType.value as Vector3;
    const S = EDGE_SENTINEL;
    expect(head.toArray()).toEqual([S, S, S]);
    writeTypeMaskUniforms(mat, "all");
    expect(head.toArray()).toEqual([S, -S, -S]);
    writeTypeMaskUniforms(mat, { x: 1.5, bottom: -0.2, top: 0.4 });
    expect(head.toArray()).toEqual([1.5, -0.2, 0.4]);
    writeTypeMaskUniforms(mat, "none");
    expect(head.toArray()).toEqual([S, S, S]);
    mat.dispose();
  });
});
