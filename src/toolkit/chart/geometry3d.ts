/** Hand-built solids behind 3D lines and areas. Non-indexed with explicit per-face normals (three's averaged normals would round the extrusion's edges away), one vertex layout per polyline length, so a later data morph rewrites `position` in place instead of re-triangulating. Pure: same points in, same buffers out, on every machine. Pie wedges share `chart2d.pieSliceShape` with the flat renderer, so both dimensions cut identical arcs. */

import { BufferAttribute, BufferGeometry } from "three";

export interface ChartPoint2 {
  x: number;
  y: number;
}

type Vertex = readonly [number, number, number];

interface StripSink {
  positions: number[];
  normals: number[];
}

/** Miter offsets blow up at hairpins; cap the widening well before the singularity. */
const MITER_MIN = 0.4;

const EPSILON = 1e-9;

/** The left-hand normal of a segment (rotate the direction +90 degrees), unit length; a zero-length segment reads as pointing up. */
function leftNormal(a: ChartPoint2, b: ChartPoint2): ChartPoint2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < EPSILON ? { x: 0, y: 1 } : { x: -dy / len, y: dx / len };
}

function direction(a: ChartPoint2, b: ChartPoint2): ChartPoint2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < EPSILON ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
}

/** Emits one quad as two triangles carrying a single explicit normal, flipping the winding when the vertex order disagrees with that normal, so callers order corners cyclically and never reason about handedness. */
function quad(sink: StripSink, a: Vertex, b: Vertex, c: Vertex, d: Vertex, n: Vertex): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const gx = uy * vz - uz * vy;
  const gy = uz * vx - ux * vz;
  const gz = ux * vy - uy * vx;
  const forward = gx * n[0] + gy * n[1] + gz * n[2] >= 0;
  const order: Vertex[] = forward ? [a, b, c, a, c, d] : [a, d, c, a, c, b];
  for (const p of order) {
    sink.positions.push(p[0], p[1], p[2]);
    sink.normals.push(n[0], n[1], n[2]);
  }
}

function toGeometry(sink: StripSink): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(sink.positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(sink.normals), 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The solid between a value curve and its baseline (the zero line, or the stack layer below), extruded to `halfDepth` either side of z 0: front and back faces, a wall along each curve and a cap at each end. */
export function buildAreaSolid(
  top: readonly ChartPoint2[],
  bottom: readonly ChartPoint2[],
  halfDepth: number,
): BufferGeometry {
  const sink: StripSink = { positions: [], normals: [] };
  const count = Math.min(top.length, bottom.length);
  if (count < 2) return toGeometry(sink);
  const d = halfDepth;
  for (let i = 0; i < count - 1; i++) {
    const t0 = top[i];
    const t1 = top[i + 1];
    const b0 = bottom[i];
    const b1 = bottom[i + 1];
    quad(sink, [t0.x, t0.y, d], [b0.x, b0.y, d], [b1.x, b1.y, d], [t1.x, t1.y, d], [0, 0, 1]);
    quad(sink, [t0.x, t0.y, -d], [b0.x, b0.y, -d], [b1.x, b1.y, -d], [t1.x, t1.y, -d], [0, 0, -1]);
    const tn = leftNormal(t0, t1);
    quad(
      sink,
      [t0.x, t0.y, d],
      [t1.x, t1.y, d],
      [t1.x, t1.y, -d],
      [t0.x, t0.y, -d],
      [tn.x, tn.y, 0],
    );
    const bn = leftNormal(b0, b1);
    quad(
      sink,
      [b0.x, b0.y, d],
      [b1.x, b1.y, d],
      [b1.x, b1.y, -d],
      [b0.x, b0.y, -d],
      [-bn.x, -bn.y, 0],
    );
  }
  const head = direction(top[0], top[1]);
  const tail = direction(top[count - 2], top[count - 1]);
  const first = { top: top[0], bottom: bottom[0] };
  const last = { top: top[count - 1], bottom: bottom[count - 1] };
  quad(
    sink,
    [first.top.x, first.top.y, d],
    [first.bottom.x, first.bottom.y, d],
    [first.bottom.x, first.bottom.y, -d],
    [first.top.x, first.top.y, -d],
    [-head.x, -head.y, 0],
  );
  quad(
    sink,
    [last.top.x, last.top.y, d],
    [last.bottom.x, last.bottom.y, d],
    [last.bottom.x, last.bottom.y, -d],
    [last.top.x, last.top.y, -d],
    [tail.x, tail.y, 0],
  );
  return toGeometry(sink);
}

/** A rectangular cross-section swept along a polyline: `thickness` across the plot plane, `halfDepth` either side of z 0, mitred at the joints and capped at both ends. */
export function buildRibbonSolid(
  points: readonly ChartPoint2[],
  thickness: number,
  halfDepth: number,
): BufferGeometry {
  const sink: StripSink = { positions: [], normals: [] };
  const count = points.length;
  if (count < 2) return toGeometry(sink);
  const h = thickness / 2;
  const d = halfDepth;

  const segment: ChartPoint2[] = [];
  for (let i = 0; i < count - 1; i++) segment.push(leftNormal(points[i], points[i + 1]));

  const offset: ChartPoint2[] = [];
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      offset.push(segment[0]);
      continue;
    }
    if (i === count - 1) {
      offset.push(segment[count - 2]);
      continue;
    }
    const a = segment[i - 1];
    const b = segment[i];
    const sx = a.x + b.x;
    const sy = a.y + b.y;
    const len = Math.hypot(sx, sy);
    if (len < EPSILON) {
      offset.push(b);
      continue;
    }
    const mx = sx / len;
    const my = sy / len;
    const scale = 1 / Math.max(MITER_MIN, mx * b.x + my * b.y);
    offset.push({ x: mx * scale, y: my * scale });
  }

  const left = points.map((p, i) => ({ x: p.x + offset[i].x * h, y: p.y + offset[i].y * h }));
  const right = points.map((p, i) => ({ x: p.x - offset[i].x * h, y: p.y - offset[i].y * h }));

  for (let i = 0; i < count - 1; i++) {
    const n = segment[i];
    const l0 = left[i];
    const l1 = left[i + 1];
    const r0 = right[i];
    const r1 = right[i + 1];
    quad(sink, [l0.x, l0.y, d], [l1.x, l1.y, d], [l1.x, l1.y, -d], [l0.x, l0.y, -d], [n.x, n.y, 0]);
    quad(
      sink,
      [r0.x, r0.y, d],
      [r1.x, r1.y, d],
      [r1.x, r1.y, -d],
      [r0.x, r0.y, -d],
      [-n.x, -n.y, 0],
    );
    quad(sink, [l0.x, l0.y, d], [r0.x, r0.y, d], [r1.x, r1.y, d], [l1.x, l1.y, d], [0, 0, 1]);
    quad(sink, [l0.x, l0.y, -d], [r0.x, r0.y, -d], [r1.x, r1.y, -d], [l1.x, l1.y, -d], [0, 0, -1]);
  }

  const head = direction(points[0], points[1]);
  const tail = direction(points[count - 2], points[count - 1]);
  quad(
    sink,
    [left[0].x, left[0].y, d],
    [right[0].x, right[0].y, d],
    [right[0].x, right[0].y, -d],
    [left[0].x, left[0].y, -d],
    [-head.x, -head.y, 0],
  );
  const end = count - 1;
  quad(
    sink,
    [left[end].x, left[end].y, d],
    [right[end].x, right[end].y, d],
    [right[end].x, right[end].y, -d],
    [left[end].x, left[end].y, -d],
    [tail.x, tail.y, 0],
  );
  return toGeometry(sink);
}
