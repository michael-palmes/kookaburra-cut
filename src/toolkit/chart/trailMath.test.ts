import {
  CustomBlending,
  DoubleSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  ZeroFactor,
} from "three";
import { describe, expect, it } from "vitest";
import { FRAME_LAYER_BAND } from "../../engine/frameLayerOrder";
import { hexToOklch } from "../../theme/oklch";
import { builtinThemes } from "../../theme/registry";
import { computeChartLayout } from "./layout";
import {
  CHART_TRAIL_FEATHER,
  CHART_TRAIL_GLOW,
  CHART_TRAIL_HEAD,
  CHART_TRAIL_INK,
  CHART_TRAIL_MOVING,
  CHART_TRAIL_OFFSET_GLSL,
  CHART_TRAIL_PROFILE_GLSL,
  CHART_TRAIL_RENDER_ORDER,
  CHART_TRAIL_SPREAD,
  CHART_TRAIL_TAIL,
  type ChartTrailPoint,
  chartTrailGains,
  chartTrailGeometry,
  chartTrailHeadQuad,
  chartTrailKey,
  chartTrailLead,
  chartTrailOffset,
  chartTrailProfile,
  chartTrailRamp,
  chartTrailRampUniform,
  chartTrailReach,
  chartTrailRuns,
  chartTrailStrip,
  chartTrailTone,
  chartTrailVertexCount,
  chartTrailZ,
  makeChartTrailMaterial,
  writeChartTrailStrip,
  writeChartTrailUniforms,
} from "./trailMath";
import type { ChartData } from "./types";

const dark = builtinThemes["kookaburra-default"].colors.background;
const light = builtinThemes["kookaburra-pacific"].colors.background;

const run: ChartTrailPoint[] = [
  [0, 0, -1],
  [1, 0.5, -0.5],
  [2, 0.25, -0.25],
  [3, 1, 0],
];

const series = (values: number[], axis: { min?: number; max?: number } = {}) => {
  const data: ChartData = {
    categories: values.map((_, i) => `c${i}`),
    series: [{ id: "s1", name: "Series", values }],
  };
  return computeChartLayout(data, { type: "line", axis: { value: axis } }).series[0];
};

describe("the cross-section", () => {
  it("peaks on the centreline and lands on exactly nothing at the edge", () => {
    expect(chartTrailProfile(0)).toEqual({ halo: 1, core: 1 });
    expect(chartTrailProfile(1)).toEqual({ halo: 0, core: 0 });
    expect(chartTrailProfile(1.4)).toEqual({ halo: 0, core: 0 });
    expect(chartTrailProfile(Number.NaN)).toEqual({ halo: 0, core: 0 });
    expect(chartTrailProfile(-0.3)).toEqual(chartTrailProfile(0.3));
  });

  it("falls monotonically and smoothly into the edge, never a hard border", () => {
    let last = chartTrailProfile(0);
    for (let d = 0.02; d < 1; d += 0.02) {
      const at = chartTrailProfile(d);
      expect(at.halo, `halo ${d}`).toBeLessThanOrEqual(last.halo);
      expect(at.core, `core ${d}`).toBeLessThanOrEqual(last.core);
      last = at;
    }
    expect(chartTrailProfile(0.99).halo).toBeLessThan(0.01);
  });

  it("keeps a thin core one stroke wide inside a broad halo", () => {
    const stroke = 1 / CHART_TRAIL_SPREAD;
    expect(chartTrailProfile(stroke).core).toBeCloseTo(Math.exp(-1), 10);
    expect(chartTrailProfile(stroke).halo).toBeGreaterThan(0.9);
    expect(chartTrailProfile(0.5).core).toBeLessThan(1e-4);
    expect(chartTrailProfile(0.5).halo).toBeGreaterThan(0.3);
  });

  it("spreads the halo around the core stroke", () => {
    expect(chartTrailReach(0.02)).toBeCloseTo((0.02 * CHART_TRAIL_SPREAD) / 2, 12);
    expect(chartTrailReach(-1)).toBe(0);
  });
});

describe("the brightness ramp", () => {
  it("rises from the tail's share to full at the leading end", () => {
    expect(chartTrailRamp(-2, -2, 2)).toBeCloseTo(CHART_TRAIL_TAIL, 12);
    expect(chartTrailRamp(2, -2, 2)).toBeCloseTo(1, 12);
    let last = 0;
    for (let x = -2; x <= 2; x += 0.25) {
      const at = chartTrailRamp(x, -2, 2);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });

  it("clamps outside the drawn span and lights a span with nothing drawn yet", () => {
    expect(chartTrailRamp(-5, -2, 2)).toBeCloseTo(CHART_TRAIL_TAIL, 12);
    expect(chartTrailRamp(5, -2, 2)).toBeCloseTo(1, 12);
    expect(chartTrailRamp(0, 1, 1)).toBe(1);
    expect(chartTrailRampUniform(1, 1)).toEqual([1, 0, 1]);
  });

  it("hands the shader the tail, the inverse span and the floor", () => {
    expect(chartTrailRampUniform(-2, 2, 0.3)).toEqual([-2, 0.25, 0.3]);
  });
});

describe("depth travel", () => {
  it("recedes the start the whole travel and lands the leading end on the plot plane", () => {
    expect(chartTrailZ(0, 2)).toBe(-2);
    expect(chartTrailZ(0.5, 2)).toBe(-1);
    expect(chartTrailZ(0.75, 2)).toBeCloseTo(-0.5, 12);
    expect(chartTrailZ(1, 2)).toBe(0);
  });

  it("clamps outside the plot and stays flat with no travel", () => {
    expect(chartTrailZ(-1, 2)).toBe(-2);
    expect(chartTrailZ(3, 2)).toBe(0);
    expect(chartTrailZ(0.2, 0)).toBe(0);
    expect(chartTrailZ(0.2, -1)).toBe(0);
    expect(chartTrailZ(0.2, Number.NaN)).toBe(0);
  });

  it("only ever recedes, so perspective pulls the trail in and the head stays where the fit put it", () => {
    const points = series([10, 30, 20, 50, 40, 70]).points;
    for (const p of points) expect(chartTrailZ(p.x, 1.5)).toBeLessThanOrEqual(0);
    const last = points[points.length - 1];
    expect(chartTrailZ(last.x, 1.5)).toBeGreaterThan(-1.5 / points.length);
  });
});

describe("chartTrailTone", () => {
  const gold = "#f0a848";

  it("adds light on a dark stage, the core lifted toward white on the series' own hue", () => {
    const tone = chartTrailTone(gold, dark);
    expect(tone.mode).toBe("glow");
    expect(tone.halo).toBe(gold);
    const core = hexToOklch(tone.core);
    const swatch = hexToOklch(gold);
    expect(core.l).toBeGreaterThan(swatch.l);
    expect(core.c).toBeLessThan(swatch.c);
    expect(Math.abs(core.h - swatch.h)).toBeLessThan(12);
  });

  it("lays down ink on a light stage, the core deepened rather than washed out", () => {
    const tone = chartTrailTone(gold, light);
    expect(tone.mode).toBe("ink");
    expect(tone.halo).toBe(gold);
    expect(hexToOklch(tone.core).l).toBeLessThan(hexToOklch(gold).l);
    // A swatch already darker than the floor is never lightened.
    const deep = hexToOklch(chartTrailTone("#101820", light).core).l;
    expect(deep).toBeLessThanOrEqual(hexToOklch("#101820").l + 0.005);
  });

  it("is pure, and degrades a broken colour to a mid grey", () => {
    expect(chartTrailTone(gold, dark)).toEqual(chartTrailTone(gold, dark));
    const broken = chartTrailTone("nope", dark);
    expect(broken.halo).toBe("#808080");
    expect(broken.core).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("chartTrailGains", () => {
  it("burns the glowing head brighter than its strip, and lifts it on a pulse", () => {
    const [halo, core, width] = chartTrailGains("glow", false);
    expect([halo, core]).toEqual([CHART_TRAIL_GLOW.halo, CHART_TRAIL_GLOW.core]);
    expect(width).toBeCloseTo(1 / CHART_TRAIL_SPREAD, 12);
    const head = chartTrailGains("glow", true);
    expect(head[0]).toBeCloseTo(halo * CHART_TRAIL_HEAD.gain, 12);
    expect(head[1]).toBeCloseTo(core * CHART_TRAIL_HEAD.gain, 12);
    expect(head[2]).toBe(CHART_TRAIL_HEAD.core);
    expect(chartTrailGains("glow", true, 1)[1]).toBeGreaterThan(head[1]);
  });

  it("keeps ink at its own opacities, head or not", () => {
    expect(chartTrailGains("ink", false).slice(0, 2)).toEqual([
      CHART_TRAIL_INK.halo,
      CHART_TRAIL_INK.core,
    ]);
    expect(chartTrailGains("ink", true, 1).slice(0, 2)).toEqual([
      CHART_TRAIL_INK.halo,
      CHART_TRAIL_INK.core,
    ]);
  });
});

describe("the strip", () => {
  it("takes a pair per point plus a cap pair at each end, and needs two points", () => {
    expect(chartTrailVertexCount(0)).toBe(0);
    expect(chartTrailVertexCount(1)).toBe(0);
    expect(chartTrailVertexCount(2)).toBe(8);
    expect(chartTrailVertexCount(4)).toBe(12);
    const lone = chartTrailStrip([[0, 0, 0]]);
    expect(lone.position).toHaveLength(0);
    expect(lone.index).toHaveLength(0);
  });

  it("alternates sides, caps both ends and stitches each pair to the next", () => {
    const strip = chartTrailStrip(run);
    const vertices = chartTrailVertexCount(run.length);
    expect(Array.from(strip.side)).toEqual(
      Array.from({ length: vertices }, (_, v) => (v % 2 === 0 ? -1 : 1)),
    );
    expect(Array.from(strip.cap)).toEqual([-1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(strip.index).toHaveLength((vertices / 2 - 1) * 6);
    for (const i of strip.index) expect(i).toBeLessThan(vertices);
    expect(Array.from(strip.index.slice(0, 6))).toEqual([0, 1, 2, 1, 3, 2]);
  });

  it("gives every vertex its centre and both neighbours, the ends taking themselves", () => {
    const strip = chartTrailStrip(run);
    const at = (array: Float32Array, v: number) => Array.from(array.slice(v * 3, v * 3 + 3));
    const f = (p: ChartTrailPoint) => Array.from(new Float32Array(p));
    // Tail cap and first body pair: the start, with itself behind it.
    for (const v of [0, 1, 2, 3]) {
      expect(at(strip.position, v)).toEqual(f(run[0]));
      expect(at(strip.prev, v)).toEqual(f(run[0]));
      expect(at(strip.next, v)).toEqual(f(run[1]));
    }
    // An interior pair sees both neighbours.
    expect(at(strip.position, 4)).toEqual(f(run[1]));
    expect(at(strip.prev, 4)).toEqual(f(run[0]));
    expect(at(strip.next, 4)).toEqual(f(run[2]));
    // Last body pair and head cap: the end, with itself ahead of it.
    for (const v of [8, 9, 10, 11]) {
      expect(at(strip.position, v)).toEqual(f(run[3]));
      expect(at(strip.prev, v)).toEqual(f(run[2]));
      expect(at(strip.next, v)).toEqual(f(run[3]));
    }
  });

  it("rewrites in place for the same count, and leaves a mismatched count alone", () => {
    const strip = chartTrailStrip(run);
    const index = strip.index;
    const moved: ChartTrailPoint[] = run.map(([x, y, z]) => [x, y + 1, z]);
    writeChartTrailStrip(moved, strip);
    expect(strip).toEqual(chartTrailStrip(moved));
    expect(strip.index).toBe(index);
    const before = Array.from(strip.position);
    writeChartTrailStrip(run.slice(0, 3), strip);
    expect(Array.from(strip.position)).toEqual(before);
  });

  it("keys on the centres, so an unmoved trail keeps its buffers", () => {
    expect(chartTrailKey(run)).toBe(chartTrailKey(run.map((p) => [...p] as ChartTrailPoint)));
    expect(chartTrailKey(run)).not.toBe(chartTrailKey([...run.slice(0, 3), [3, 1.01, 0]]));
  });

  it("builds a radial head quad and geometry over the strip's own arrays", () => {
    const quad = chartTrailHeadQuad();
    expect(Array.from(quad.side)).toEqual([-1, 1, -1, 1]);
    expect(Array.from(quad.cap)).toEqual([-1, -1, 1, 1]);
    expect(Array.from(quad.index)).toEqual([0, 1, 2, 1, 3, 2]);
    const strip = chartTrailStrip(run);
    const geometry = chartTrailGeometry(strip);
    expect(geometry.getAttribute("position").array).toBe(strip.position);
    expect(geometry.getAttribute("aTrailPrev").array).toBe(strip.prev);
    expect(geometry.getAttribute("aTrailNext").array).toBe(strip.next);
    expect(geometry.getAttribute("aTrailSide").array).toBe(strip.side);
    expect(geometry.getAttribute("aTrailCap").array).toBe(strip.cap);
    expect(geometry.getIndex()?.array).toBe(strip.index);
    for (const name of CHART_TRAIL_MOVING) expect(geometry.getAttribute(name)).toBeDefined();
    geometry.dispose();
  });
});

describe("joins", () => {
  const length = ([x, y]: [number, number]) => Math.hypot(x, y);

  it("offsets a straight run square to it by the reach, the side choosing which way", () => {
    for (const side of [1, -1]) {
      const [x, y] = chartTrailOffset([0, 0], [1, 0], [2, 0], side, 0, 0.5);
      expect(x).toBeCloseTo(0, 12);
      expect(y).toBeCloseTo(0.5 * side, 12);
    }
  });

  it("widens a joint so both segments keep their width", () => {
    const offset = chartTrailOffset([0, 0], [1, 0], [1, 1], 1, 0, 0.5);
    expect(length(offset)).toBeCloseTo(0.5 * Math.SQRT2, 10);
    // The vertex sits a reach from each segment's own line.
    expect(Math.abs(offset[1])).toBeCloseTo(0.5, 10);
    expect(Math.abs(offset[0])).toBeCloseTo(0.5, 10);
  });

  it("caps the widening at a sharp joint and survives a hairpin", () => {
    const sharp = chartTrailOffset([0, 0], [1, 0], [0, 0.05], 1, 0, 1);
    expect(length(sharp)).toBeCloseTo(2.5, 10);
    const hairpin = chartTrailOffset([0, 0], [1, 0], [0, 0], 1, 0, 1);
    expect(length(hairpin)).toBeCloseTo(1, 10);
    expect(hairpin.every(Number.isFinite)).toBe(true);
  });

  it("pushes the caps out along the run", () => {
    const tail = chartTrailOffset([0, 0], [0, 0], [1, 0], 0, -1, 0.5);
    expect(tail[0]).toBeCloseTo(-0.5, 12);
    expect(tail[1]).toBeCloseTo(0, 12);
    const head = chartTrailOffset([0, 0], [1, 0], [1, 0], 0, 1, 0.5);
    expect(head[0]).toBeCloseTo(0.5, 12);
  });

  it("lays a lone point (the head) on the screen axes", () => {
    const corner = chartTrailOffset([0, 0], [0, 0], [0, 0], 1, 1, 0.5);
    expect(corner[0]).toBeCloseTo(0.5, 12);
    expect(corner[1]).toBeCloseTo(0.5, 12);
  });
});

describe("the leading end", () => {
  it("sits on the last point once drawn, and rides the draw-on edge before that", () => {
    const { points } = series([10, 40, 20, 80]);
    const runs = chartTrailRuns(points);
    const settled = chartTrailLead(points, runs, 1);
    expect(settled).toEqual({ x: points[3].x, y: points[3].y, index: 3 });
    const half = chartTrailLead(points, runs, 0.5);
    expect(half?.x).toBeCloseTo((points[0].x + points[3].x) / 2, 12);
    expect(half?.y).toBeCloseTo((points[1].y + points[2].y) / 2, 12);
    expect(half?.index).toBe(2);
    expect(chartTrailLead(points, runs, 0)).toEqual({ x: points[0].x, y: points[0].y, index: 0 });
  });

  it("drops the head where the trim cut the line away", () => {
    // A manual ceiling cuts the third point out, so the run breaks around it.
    const { points } = series([10, 40, 200, 30, 20], { min: 0, max: 100 });
    const runs = chartTrailRuns(points);
    expect(runs.length).toBeGreaterThan(1);
    const third = points.findIndex((p) => !p.inside);
    expect(third).toBeGreaterThan(0);
    const span = points[points.length - 1].x - points[0].x;
    const draw = (points[third].x - points[0].x) / span;
    expect(chartTrailLead(points, runs, draw)).toBeNull();
    expect(chartTrailLead(points, runs, 1)).not.toBeNull();
  });

  it("keeps a lone category's head, and nothing for an empty series", () => {
    const { points } = series([42]);
    const runs = chartTrailRuns(points);
    expect(runs).toEqual([[0, 1]]);
    expect(chartTrailLead(points, runs, 1)).toEqual({ x: points[0].x, y: points[0].y, index: 0 });
    expect(chartTrailLead([], [], 1)).toBeNull();
    expect(chartTrailRuns([{ ...points[0], inside: false }])).toEqual([]);
  });
});

describe("the material", () => {
  it("adds light and leaves the destination alpha alone on a dark stage", () => {
    const { material } = makeChartTrailMaterial("glow", false);
    expect(material.blending).toBe(CustomBlending);
    expect([material.blendSrc, material.blendDst]).toEqual([OneFactor, OneFactor]);
    expect([material.blendSrcAlpha, material.blendDstAlpha]).toEqual([ZeroFactor, OneFactor]);
    material.dispose();
  });

  it("blends straight alpha as ink on a light one", () => {
    const { material } = makeChartTrailMaterial("ink", true);
    expect([material.blendSrc, material.blendDst]).toEqual([
      SrcAlphaFactor,
      OneMinusSrcAlphaFactor,
    ]);
    expect([material.blendSrcAlpha, material.blendDstAlpha]).toEqual([
      OneFactor,
      OneMinusSrcAlphaFactor,
    ]);
    material.dispose();
  });

  it("draws flat among the flat layers and 3D with the opaque marks, never writing depth", () => {
    const flat = makeChartTrailMaterial("glow", true).material;
    const lit = makeChartTrailMaterial("glow", false).material;
    expect(flat.transparent).toBe(true);
    expect(flat.toneMapped).toBe(false);
    expect(lit.transparent).toBe(false);
    expect(lit.toneMapped).toBe(true);
    for (const m of [flat, lit]) {
      expect(m.depthWrite).toBe(false);
      expect(m.side).toBe(DoubleSide);
    }
    expect(CHART_TRAIL_RENDER_ORDER).toBeGreaterThan(0);
    expect(CHART_TRAIL_RENDER_ORDER + 1).toBeLessThan(FRAME_LAYER_BAND.above);
    flat.dispose();
    lit.dispose();
  });

  it("compiles the profile and the joins from the maths' own constants", () => {
    const { material } = makeChartTrailMaterial("glow", false);
    expect(material.fragmentShader).toContain(CHART_TRAIL_PROFILE_GLSL);
    expect(material.vertexShader).toContain(CHART_TRAIL_OFFSET_GLSL);
    expect(CHART_TRAIL_PROFILE_GLSL).toContain(Math.exp(-3).toFixed(8));
    expect(CHART_TRAIL_OFFSET_GLSL).toContain("max(0.4000, dot(tangent, edge))");
    expect(material.fragmentShader).toContain("#include <colorspace_fragment>");
    expect(material.vertexShader).toContain("length(modelViewMatrix[0].xyz)");
    material.dispose();
  });

  it("writes the frame's state as plain uniforms", () => {
    const { material, uniforms } = makeChartTrailMaterial("ink", true);
    writeChartTrailUniforms(uniforms, {
      tone: chartTrailTone("#f0a848", light),
      reach: 12,
      pixels: 2160,
      gains: chartTrailGains("ink", false),
      clipX: 0.4,
      feather: 0.02,
      ramp: chartTrailRampUniform(-1, 1),
      alpha: 1.4,
    });
    expect(uniforms.reach.value).toBe(12);
    expect(uniforms.pixels.value).toBe(2160);
    expect(uniforms.gain.value.w).toBe(1);
    expect(uniforms.clip.value.toArray()).toEqual([0.4, 0.02, 1]);
    expect(uniforms.ramp.value.toArray()).toEqual([-1, 0.5, CHART_TRAIL_TAIL]);
    expect(uniforms.alpha.value).toBe(1);
    writeChartTrailUniforms(uniforms, {
      tone: chartTrailTone("#f0a848", dark),
      reach: 0.05,
      pixels: 0,
      gains: chartTrailGains("glow", true),
      clipX: null,
      feather: 0.05 * CHART_TRAIL_FEATHER,
      ramp: [0, 0, 1],
      alpha: 0.5,
    });
    expect(uniforms.clip.value.z).toBe(0);
    expect(uniforms.gain.value.w).toBe(0);
    expect(uniforms.pixels.value).toBe(0);
    expect(uniforms.alpha.value).toBe(0.5);
    material.dispose();
  });
});
