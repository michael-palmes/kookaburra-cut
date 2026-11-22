import { Path, Shape, Vector2 } from "three";

export type Point = readonly [number, number];

const MIN_TURN = 0.4;
const ARC_STEPS = 6;
const REACH = 0.45;

function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-9)
    out.pop();
  return out;
}

/** Fillets every sharp corner of a closed outline with a curve of about `radius`, capped so neighbouring corners never meet; gently curving runs (a glyph's own bowls) pass through untouched. */
export function roundPolygon(points: readonly Point[], radius: number): Point[] {
  const pts = dedupe(points);
  const n = pts.length;
  if (n < 3 || radius <= 0) return pts;
  const at = (i: number) => pts[((i % n) + n) % n] as Point;
  const lengths = pts.map((p, i) => Math.hypot(at(i + 1)[0] - p[0], at(i + 1)[1] - p[1]));
  const starts: number[] = [];
  let total = 0;
  for (const length of lengths) {
    starts.push(total);
    total += length;
  }
  const turns = pts.map((p, i) => {
    const a = at(i - 1);
    const b = at(i + 1);
    const inAngle = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const outAngle = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let turn = Math.abs(outAngle - inAngle);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn;
  });
  const sharp = turns.flatMap((turn, i) => (turn > MIN_TURN ? [i] : []));
  if (sharp.length === 0) return pts;
  const pointAt = (s: number): Point => {
    const wrapped = ((s % total) + total) % total;
    let i = 0;
    while (i < n - 1 && (starts[i + 1] as number) <= wrapped) i++;
    const length = lengths[i] as number;
    const u = length > 0 ? (wrapped - (starts[i] as number)) / length : 0;
    const a = at(i);
    const b = at(i + 1);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const gap = (from: number, to: number) => {
    const d = (starts[to] as number) - (starts[from] as number);
    return d > 0 ? d : d + total;
  };
  const trims = sharp.map((index, k) => {
    const previous = sharp[(k - 1 + sharp.length) % sharp.length] as number;
    const next = sharp[(k + 1) % sharp.length] as number;
    const room = sharp.length === 1 ? total : Math.min(gap(previous, index), gap(index, next));
    const interior = Math.PI - (turns[index] as number);
    return Math.min(radius / Math.tan(interior / 2), REACH * room);
  });
  const out: Point[] = [];
  sharp.forEach((index, k) => {
    const trim = trims[k] as number;
    const corner = at(index);
    const s = starts[index] as number;
    const from = pointAt(s - trim);
    const to = pointAt(s + trim);
    for (let step = 0; step <= ARC_STEPS; step++) {
      const u = step / ARC_STEPS;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      out.push([
        w0 * from[0] + w1 * corner[0] + w2 * to[0],
        w0 * from[1] + w1 * corner[1] + w2 * to[1],
      ]);
    }
    const next = sharp[(k + 1) % sharp.length] as number;
    const nextTrim = trims[(k + 1) % sharp.length] as number;
    const span = sharp.length === 1 ? total : gap(index, next);
    let travelled = 0;
    for (let step = 1; step < n; step++) {
      const i = (index + step) % n;
      travelled += lengths[(index + step - 1) % n] as number;
      if (travelled >= span - nextTrim) break;
      if (travelled > trim) out.push(at(i));
    }
  });
  return out;
}

function toPoints(vectors: readonly Vector2[]): Point[] {
  return vectors.map((v) => [v.x, v.y] as const);
}

function toVectors(points: readonly Point[]): Vector2[] {
  return points.map((p) => new Vector2(p[0], p[1]));
}

/** Glyph shapes with every sharp corner rounded, holes included. */
export function roundShapes(shapes: readonly Shape[], radius: number, divisions: number): Shape[] {
  return shapes.map((shape) => {
    const { shape: outline, holes } = shape.extractPoints(divisions);
    const rounded = new Shape(toVectors(roundPolygon(toPoints(outline), radius)));
    rounded.holes = holes.map((hole) => new Path(toVectors(roundPolygon(toPoints(hole), radius))));
    return rounded;
  });
}
