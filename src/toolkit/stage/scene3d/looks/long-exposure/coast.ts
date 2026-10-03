import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from "three";
import { loopSeconds } from "../../kit/clock";
import { smoothstep } from "../../kit/math";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

type Vec3 = [number, number, number];

/** The sea and coast: the water plane's height, its disc (exactly where the plane meets the sky dome, so the dome's horizon is the sea's far edge from any pose), the Headlands slider's top value (each arc wall is cut that tall, plus roughness), the roof's reach behind the crest (`depth + slope x crest`, sinking to `sink` under the sea) and the lighthouse: tower height, beam period (seconds per turn), beam reach and the lamp's quad half size. */
export const SEA = {
  y: -3.2,
  domeRadius: 70,
  segments: 256,
  headScaleMax: 1.5,
  headBase: -0.6,
  maxHeadlands: 6,
  roof: { depth: 1, slope: 2.4, sink: -0.3 },
  tower: 0.32,
  beamPeriod: 8,
  beamReach: 4,
  lampQuad: 5,
} as const;

/** The sea disc's radius: the plane's circle on the dome sphere. */
export const SEA_RADIUS = Math.sqrt(SEA.domeRadius ** 2 - SEA.y ** 2);
/** The dome's horizon as a direction height from its centre: the sea's far edge. */
export const SEA_HORIZON_Y = SEA.y / SEA.domeRadius;

/** One headland: an arc of coast `radius` out, centred on `azimuth` (degrees right of the stage's -z), `span` degrees wide, rising `height` over the sea, with its cliff at the `tip` end (1 the right end, -1 the left, 0 an island with cliffs at both). `seed` phases its roughness. */
export interface Headland {
  radius: number;
  azimuth: number;
  span: number;
  height: number;
  tip: -1 | 0 | 1;
  seed: number;
}

interface CoastLayout {
  heads: readonly Headland[];
  /** The lighthouse headland's index and the lamp's place along it (0 centre, 1 the tip). */
  lamp: { head: number; at: number };
}

/** Two hand-set coastlines, each with a mirrored twin (Coastline 3 and 4): near capes off the frame's centre at 24 to 34 units, ridges behind them at 40 to 50, a far range at 60 and a low island behind the stage. */
const BASE_COASTS: readonly CoastLayout[] = [
  {
    heads: [
      { radius: 30, azimuth: -46, span: 38, height: 2.9, tip: 1, seed: 0.7 },
      { radius: 45, azimuth: -27, span: 30, height: 3, tip: 1, seed: 2.3 },
      { radius: 60, azimuth: -80, span: 56, height: 4.2, tip: 1, seed: 4.1 },
      { radius: 25, azimuth: 49, span: 34, height: 2.2, tip: -1, seed: 1.6 },
      { radius: 40, azimuth: 38, span: 30, height: 2.8, tip: -1, seed: 5.2 },
      { radius: 55, azimuth: 205, span: 30, height: 2, tip: 0, seed: 3.4 },
    ],
    lamp: { head: 0, at: 0.66 },
  },
  {
    heads: [
      { radius: 34, azimuth: 44, span: 34, height: 2.8, tip: -1, seed: 1.1 },
      { radius: 26, azimuth: -50, span: 40, height: 3, tip: 1, seed: 2.9 },
      { radius: 42, azimuth: -30, span: 26, height: 2.5, tip: 1, seed: 0.4 },
      { radius: 60, azimuth: 72, span: 50, height: 4.2, tip: -1, seed: 3.8 },
      { radius: 48, azimuth: 14, span: 4, height: 1.3, tip: 0, seed: 6.1 },
      { radius: 55, azimuth: 160, span: 36, height: 2.2, tip: 0, seed: 4.7 },
    ],
    lamp: { head: 0, at: 0.62 },
  },
];

/** Coastline 1 to 4: the two base coasts, then each mirrored left to right. */
export function coastLayout(coast: number): CoastLayout {
  const n = Math.min(4, Math.max(1, Math.round(Number.isFinite(coast) ? coast : 1)));
  const base = BASE_COASTS[(n - 1) % 2];
  if (n <= 2) return base;
  return {
    heads: base.heads.map((h) => ({
      ...h,
      azimuth: -h.azimuth,
      tip: (h.tip === 0 ? 0 : -h.tip) as Headland["tip"],
    })),
    lamp: base.lamp,
  };
}

/** Signed angle `a - b` wrapped to [-PI, PI), as the GLSL does it. */
function wrapAngle(a: number): number {
  const r = (a + Math.PI) % TAU;
  return (r < 0 ? r + TAU : r) - Math.PI;
}

/** Crest height over the sea at an azimuth (radians): a long back slope, a knoll, a rounded hill and a steep cliff at the tip (an island takes cliffs at both ends), times four sines of arc length for roughness; 0 off the arc. EXPORT CONTRACT: mirrors the GLSL `leCrest`. */
export function headlandCrest(h: Headland, azimuth: number, scale: number): number {
  const half = (h.span / 2) * DEG;
  const da = wrapAngle(azimuth - h.azimuth * DEG);
  const u = da / half;
  if (Math.abs(u) >= 1) return 0;
  let base: number;
  if (h.tip === 0) {
    base =
      Math.sqrt(Math.max(1 - smoothstep(0.62, 0.97, Math.abs(u)), 0)) *
      (0.7 + 0.3 * Math.exp(-((u / 0.4) ** 2)));
  } else {
    const w = u * h.tip;
    const hill = 0.55 + 0.45 * Math.exp(-(((w - 0.52) / 0.3) ** 2));
    const knoll = 0.14 * Math.exp(-(((w + 0.25) / 0.18) ** 2));
    base =
      smoothstep(-1, 0, w) * (hill + knoll) * Math.sqrt(Math.max(1 - smoothstep(0.87, 0.99, w), 0));
  }
  const x = da * h.radius;
  const rough =
    0.06 * Math.sin(0.45 * x + h.seed) +
    0.04 * Math.sin(1.1 * x + 2.1 * h.seed) +
    0.025 * Math.sin(2.6 * x + 3.7 * h.seed) +
    0.012 * Math.sin(6.1 * x + 5.3 * h.seed);
  return h.height * scale * base * (1 + 1.2 * rough);
}

/** The lamp's world position: on its headland's crest `at` of the way to the tip, plus the tower. */
export function lampPosition(coast: number, scale: number): Vec3 {
  const { heads, lamp } = coastLayout(coast);
  const h = heads[lamp.head];
  const az = (h.azimuth + h.tip * lamp.at * (h.span / 2)) * DEG;
  const y = SEA.y + headlandCrest(h, az, scale) + SEA.tower * Math.min(1, scale);
  return [Math.sin(az) * h.radius, y, -Math.cos(az) * h.radius];
}

/** The beam's horizontal heading (radians, same azimuth sense as the headlands), one turn every beam period: wrapped on the CPU, so it loops exactly. */
export function lampBeamAngle(t: number): number {
  return (loopSeconds(t, SEA.beamPeriod) / SEA.beamPeriod) * TAU;
}

/** Headland uniforms: per arc (radius, azimuth rad, half span rad, height x scale) and (tip, seed, 0, 0), padded to `SEA.maxHeadlands` with zero height, plus `reach` (the nearest arc's radius and the tallest crest with roughness) for the sea's early out. */
export function headlandUniformValues(
  coast: number,
  scale: number,
): { head: number[]; shape: number[]; reach: [number, number] } {
  const { heads } = coastLayout(coast);
  const head: number[] = [];
  const shape: number[] = [];
  let near = Number.POSITIVE_INFINITY;
  let tall = 0;
  for (let i = 0; i < SEA.maxHeadlands; i++) {
    const h = heads[i];
    if (!h) {
      head.push(1, 0, 1, 0);
      shape.push(0, 0, 0, 0);
      continue;
    }
    head.push(h.radius, h.azimuth * DEG, (h.span / 2) * DEG, h.height * scale);
    shape.push(h.tip, h.seed, 0, 0);
    near = Math.min(near, h.radius);
    tall = Math.max(tall, h.height * scale * 1.2);
  }
  return { head, shape, reach: [near, tall] };
}

/** Coast mesh parts (`aCoast.y`): the wall's foot and top, then the roof's back and front edges, which the vertex stage lays on the crest. */
export const COAST_PART = { foot: 0, top: 1, back: 2, front: 3 } as const;

/** Every headland as an inward-facing arc wall (an F11 cutaway: from outside an arc its near side is a back face and culls) from just under the sea to its tallest crest, plus an upward-facing roof the vertex stage slopes from the crest back down into the sea (`SEA.roof`), so high cameras see a landmass, not a flat. About two segments per degree; `aCoast` is (arc index, part). Bounds are stage-centred so the transparent sort never reorders it. */
export function coastGeometry(coast: number): BufferGeometry {
  const { heads } = coastLayout(coast);
  const pos: number[] = [];
  const part: number[] = [];
  const index: number[] = [];
  heads.forEach((h, i) => {
    const segs = Math.max(4, Math.ceil(h.span * 2));
    const a0 = (h.azimuth - h.span / 2) * DEG;
    const top = SEA.y + h.height * SEA.headScaleMax * 1.2;
    for (const [lo, hi] of [
      [COAST_PART.foot, COAST_PART.top],
      [COAST_PART.back, COAST_PART.front],
    ]) {
      const base = pos.length / 3;
      for (let s = 0; s <= segs; s++) {
        const a = a0 + (s / segs) * h.span * DEG;
        const x = Math.sin(a) * h.radius;
        const z = -Math.cos(a) * h.radius;
        pos.push(x, lo === COAST_PART.foot ? SEA.y + SEA.headBase : SEA.y, z);
        pos.push(x, lo === COAST_PART.foot ? top : SEA.y, z);
        part.push(i, lo, i, hi);
      }
      for (let s = 0; s < segs; s++) {
        const b = base + s * 2;
        if (lo === COAST_PART.foot) index.push(b, b + 2, b + 1, b + 2, b + 3, b + 1);
        else index.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aCoast", new BufferAttribute(new Float32Array(part), 2));
  g.setIndex(index);
  g.boundingSphere = new Sphere(new Vector3(), SEA.domeRadius);
  return g;
}
