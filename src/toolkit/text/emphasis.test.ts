import { Color, type Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { pillMotionsFromUnits } from "./EmphasisPills";
import {
  computeEmphasisRects,
  EMPHASIS_WEIGHT_EM,
  EMPHASIS_WEIGHT_MAX_EM,
  emphasisPillPhase,
  emphasisPills,
  MAX_EMPHASIS_RECTS,
  PILL_DRAW_MS,
  PILL_FILL_DELAY_MS,
  PILL_FILL_MS,
  PILL_PAD_X_EM,
  PILL_STROKE_EM,
  padEmphasisRanges,
  parseEmphasisValue,
  resolveEmphasis,
} from "./emphasis";
import { EDGE_SENTINEL, type TextUnitSample } from "./presets";
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

describe("shaped emphasis", () => {
  const themed = { ...colors, background: "#101010" };

  it("parses a shape after the colour or weight, and nothing else", () => {
    expect(parseEmphasisValue("accent pill")).toEqual({ colour: "accent", shape: "pill" });
    expect(parseEmphasisValue("#0af@700  battery")).toEqual({
      colour: "#0af",
      weight: 700,
      shape: "battery",
    });
    for (const v of ["accent blob", "pill", "accent@700pill", "accent pill battery"]) {
      expect(parseEmphasisValue(v)).toBeNull();
    }
  });

  it("fills to the background colour, and plain emphasis stays exactly as it was", () => {
    expect(resolveEmphasis(themed, "accent@700 pill", 400)).toEqual({
      color: "#ff5500",
      weightEm: resolveEmphasis(themed, "accent@700", 400).weightEm,
      shape: "pill",
      filledColor: "#101010",
    });
    expect(Object.keys(resolveEmphasis(themed, "accent", 400))).toEqual(["color", "weightEm"]);
  });

  it("wraps each rect in a capsule, or a battery body with its terminal on the right", () => {
    const rects = new Float32Array([0, -0.4, 2, 0.4, 5, -0.4, 5, 0.4]);
    const [pill] = emphasisPills(rects, 1, "pill");
    expect(emphasisPills(rects, 1, "pill")).toHaveLength(1);
    expect(pill.rect).toBe(0);
    expect(pill.cx).toBe(1);
    expect(pill.halfW).toBeCloseTo(1 + PILL_PAD_X_EM);
    expect(pill.radius).toBe(pill.halfH);
    expect(pill.stroke).toBeCloseTo(PILL_STROKE_EM);
    expect(pill.nub).toBeNull();
    const [battery] = emphasisPills(rects, 1, "battery");
    expect(battery.radius).toBeLessThan(battery.halfH);
    expect(battery.nub?.cx).toBeGreaterThan(battery.cx + battery.halfW);
    expect(battery.nub?.cy).toBe(battery.cy);
  });

  it("draws on, then fills, from its start", () => {
    expect(emphasisPillPhase(900, 1000)).toEqual({ draw: 0, fill: 0 });
    const mid = emphasisPillPhase(1000 + PILL_DRAW_MS / 2, 1000);
    expect(mid.draw).toBeCloseTo(0.5);
    expect(mid.fill).toBe(0);
    expect(emphasisPillPhase(1000 + PILL_FILL_DELAY_MS + PILL_FILL_MS, 1000)).toEqual({
      draw: 1,
      fill: 1,
    });
  });

  it("makes room either side of each range inside a line, moving ranges and emoji", () => {
    const padded = padEmphasisRanges({
      text: "up to 24 hours of\nX",
      emphasis: [[6, 14]],
      clusters: [{ codeUnitIndex: 18, cluster: "🔋", key: "1f50b" }],
    });
    expect(padded.text).toBe("up to  24 hours  of\nX");
    expect(padded.emphasis).toEqual([[7, 15]]);
    expect(padded.clusters[0].codeUnitIndex).toBe(20);
    const battery = padEmphasisRanges(
      { text: "a 24h b", emphasis: [[2, 5]], clusters: [] },
      "battery",
    );
    expect(battery.text).toBe("a  24h   b");
    expect(battery.emphasis).toEqual([[3, 6]]);
    const edges = padEmphasisRanges({ text: "24 hours\nleft", emphasis: [[0, 8]], clusters: [] });
    expect(edges.text).toBe("24 hours\nleft");
    const plain = { text: "plain", emphasis: [], clusters: [] };
    expect(padEmphasisRanges(plain)).toBe(plain);
  });
});

describe("pillMotionsFromUnits", () => {
  it("rides the motion of the unit holding each rect's centre", () => {
    const units = {
      count: 2,
      startX: new Float32Array([0, 3]),
      endX: new Float32Array([2, 5]),
      edgeKey: new Float32Array([0, 2.5]),
      centerY: new Float32Array([0, 0]),
      axis: "x" as const,
    };
    const sample = (dxEm: number, alpha: number) =>
      ({ dxEm, dyEm: 0.5, scale: 0.9, alpha }) as unknown as TextUnitSample;
    const motions = pillMotionsFromUnits(
      new Float32Array([3, 0, 5, 1]),
      units,
      [sample(0, 1), sample(0.25, 0.4)],
      "x",
      2,
    );
    expect(motions).toEqual([{ dx: 0.5, dy: 1, scale: 0.9, alpha: 0.4 }]);
  });
});
