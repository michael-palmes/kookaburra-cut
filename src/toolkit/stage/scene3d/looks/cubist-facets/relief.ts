import { Quaternion, Vector3 } from "three";
import { createSeededRandom } from "../../../../../engine/rng";

/** Cubist relief layout: three courses of seeded cells round the stage, each flat, folded on a diagonal (chevrons toward the axes behind the stage and the camera) or hinged on a vertical, built as flat triangles with per-vertex half and cell normals, barycentrics, edge altitudes and seeds. The seed and draw order match the approved sketch, so the default params rebuild its exact composition. */

export const CUBIST_SEED = 0xb4a90e;

/** Course bottoms and tops (world y): the lowest course stands on the floor line, the top one dissolves into the backing. */
export const CUBIST_COURSES: readonly (readonly [number, number])[] = [
  [-2, 2.4],
  [2.4, 6.6],
  [6.6, 10.8],
];

/** Relief depth the sketch was tuned at: breathing and depth jitter scale from it. */
export const CUBIST_REFERENCE_RELIEF = 0.45;
/** Breathing amplitude at the reference relief (world units). */
export const CUBIST_BREATH = 0.35;

/** The breathing amplitude at a relief depth (world units along each cell's normal). */
export function cubistBreath(relief: number): number {
  return (CUBIST_BREATH * relief) / CUBIST_REFERENCE_RELIEF;
}

export interface CubistReliefOptions {
  radius: number;
  /** Base cells per course before the focus narrowing near the two axes. */
  planes: number;
  /** Mean fold angle in degrees (the lowest course folds half as far). */
  fold: number;
  /** Depth step in and out of the ring (world units). */
  relief: number;
}

export type CubistKind = "flat" | "diag" | "vert";

export interface CubistRelief {
  /** xyz per vertex, flat triangles. */
  position: Float32Array;
  /** Facet normal per vertex, facing the stage axis. */
  half: Float32Array;
  /** The whole cell's normal: the breathing direction and the light's ring term. */
  cell: Float32Array;
  bary: Float32Array;
  /** World altitude to the edge opposite each vertex, 0 where the edge draws no contour. */
  edge: Float32Array;
  /** (crease coordinate: 0 at the crease, 1 on the far side; top coordinate: 0 at the top). */
  mod: Float32Array;
  /** (tone jitter, breathing phase, passage draw) per cell, all in [0, 1). */
  seed: Float32Array;
  kinds: CubistKind[];
  vertices: number;
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const BARY: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** Edge types opposite each vertex: contour and crease draw a line, interior does not. */
const CONTOUR = 0;
const CREASE = 2;
const INTERIOR = 4;

type Mod = readonly [number, number];
// (crease, top) corner coordinates.
const M00: Mod = [0, 0];
const M01: Mod = [0, 1];
const M10: Mod = [1, 0];
const M11: Mod = [1, 1];

function focusCell(theta: number): boolean {
  return Math.max(Math.cos(theta), Math.cos(theta - Math.PI)) > 0.7;
}

/** The relief at the given params. Pure and deterministic: the same options always give the same buffers. */
export function cubistRelief(o: CubistReliefOptions): CubistRelief {
  const rand = createSeededRandom(CUBIST_SEED);
  const R = o.radius;
  const planes = Math.max(1, o.planes);
  const depthScale = o.relief / CUBIST_REFERENCE_RELIEF;
  const position: number[] = [];
  const half: number[] = [];
  const cell: number[] = [];
  const bary: number[] = [];
  const edge: number[] = [];
  const mod: number[] = [];
  const seed: number[] = [];
  const kinds: CubistKind[] = [];
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();

  const pushTri = (
    vs: [Vector3, Vector3, Vector3],
    types: [number, number, number],
    mods: [Mod, Mod, Mod],
    s: readonly number[],
    n0: Vector3,
  ) => {
    let [a, b, c] = vs;
    let t = types;
    let m = mods;
    n.subVectors(b, a).cross(ac.subVectors(c, a)).normalize();
    const mx = (a.x + b.x + c.x) / 3;
    const my = (a.y + b.y + c.y) / 3;
    const mz = (a.z + b.z + c.z) / 3;
    if (n.x * mx + n.y * my + n.z * mz > 0) {
      [b, c] = [c, b];
      t = [t[0], t[2], t[1]];
      m = [m[0], m[2], m[1]];
      n.negate();
    }
    const v = [a, b, c];
    const area2 = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length();
    const alt = v.map((_, i) => {
      if (t[i] === INTERIOR) return 0;
      const len = v[(i + 1) % 3].distanceTo(v[(i + 2) % 3]);
      return len > 1e-6 ? area2 / len : 0;
    });
    for (let i = 0; i < 3; i++) {
      position.push(v[i].x, v[i].y, v[i].z);
      half.push(n.x, n.y, n.z);
      cell.push(n0.x, n0.y, n0.z);
      bary.push(...BARY[i]);
      edge.push(alt[0], alt[1], alt[2]);
      mod.push(...m[i]);
      seed.push(s[0], s[1], s[2]);
    }
  };
  // A planar quad (a, b bottom; c, d top) as two triangles; edges in order bottom, right, top, left.
  const pushQuad = (
    q: [Vector3, Vector3, Vector3, Vector3],
    types: [number, number, number, number],
    mods: [Mod, Mod, Mod, Mod],
    s: readonly number[],
    n0: Vector3,
  ) => {
    const [a, b, c, d] = q;
    pushTri([a, b, c], [types[1], INTERIOR, types[0]], [mods[0], mods[1], mods[2]], s, n0);
    pushTri([a, c, d], [types[2], types[3], INTERIOR], [mods[0], mods[2], mods[3]], s, n0);
  };
  const axis = new Vector3();
  const hinge = (p: Vector3, h0: Vector3, h1: Vector3, angle: number) => {
    axis.subVectors(h1, h0).normalize();
    return p.clone().sub(h0).applyAxisAngle(axis, angle).add(h0);
  };

  CUBIST_COURSES.forEach(([y0, y1], r) => {
    const widths: number[] = [];
    let acc = 0;
    while (acc < TAU - 1e-3) {
      const w = (TAU / planes) * (focusCell(acc) ? 0.7 : 1.15) * (0.7 + rand() * 0.6);
      widths.push(w);
      acc += w;
    }
    const scale = TAU / acc;
    let th0 = r * 0.21;
    for (const w0 of widths) {
      const w = w0 * scale;
      const th = th0 + w / 2;
      th0 += w;
      const inward = new Vector3(-Math.sin(th), 0, Math.cos(th));
      const T = new Vector3(Math.cos(th), 0, Math.sin(th));
      const depth = (rand() < 0.5 ? o.relief : -o.relief) + (rand() - 0.5) * 0.25 * depthScale;
      const centre = new Vector3(
        Math.sin(th) * R,
        (y0 + y1) / 2,
        -Math.cos(th) * R,
      ).addScaledVector(inward, depth);
      const hw = (w * R) / 2 + 0.45;
      const hh = (y1 - y0) / 2 + 0.3;
      const lean = new Quaternion().setFromAxisAngle(UP, (rand() - 0.5) * 0.16);
      lean.multiply(new Quaternion().setFromAxisAngle(T, (rand() - 0.5) * 0.12));
      const n0 = inward.clone().applyQuaternion(lean);
      const corner = (sx: number, sy: number) =>
        new Vector3()
          .addScaledVector(T, sx * hw)
          .addScaledVector(UP, sy * hh)
          .applyQuaternion(lean)
          .add(centre);
      const A = corner(-1, -1);
      const B = corner(1, -1);
      const C = corner(1, 1);
      const D = corner(-1, 1);
      const s = [rand(), rand()];
      s.push(rand());
      const foldDeg = r === 0 ? o.fold * 0.5 : Math.max(0, o.fold - 3 + rand() * 6);
      const fold = foldDeg * DEG * (rand() < 0.5 ? 1 : -1);
      const kind: CubistKind = focusCell(th)
        ? "diag"
        : rand() < 0.55
          ? "vert"
          : rand() < 0.5
            ? "diag"
            : "flat";
      kinds.push(kind);
      if (kind === "diag") {
        // Diagonals rise toward the nearer axis: th 0 behind the stage, th 180 behind the camera.
        const rising = Math.sin(th) < 0 !== Math.cos(th) < 0;
        if (rising) {
          const Bf = hinge(B, A, C, fold);
          const Df = hinge(D, A, C, fold);
          pushTri([A, Bf, C], [CONTOUR, CREASE, CONTOUR], [M01, M11, M00], s, n0);
          pushTri([A, C, Df], [CONTOUR, CONTOUR, CREASE], [M01, M00, M10], s, n0);
        } else {
          const Af = hinge(A, B, D, fold);
          const Cf = hinge(C, B, D, fold);
          pushTri([Af, B, D], [CREASE, CONTOUR, CONTOUR], [M11, M01, M00], s, n0);
          pushTri([B, Cf, D], [CONTOUR, CREASE, CONTOUR], [M01, M10, M00], s, n0);
        }
      } else if (kind === "vert") {
        const f = 0.35 + rand() * 0.3;
        const Mb = A.clone().lerp(B, f);
        const Mt = D.clone().lerp(C, f);
        const L0 = hinge(A, Mb, Mt, fold);
        const L1 = hinge(D, Mb, Mt, fold);
        const R0 = hinge(B, Mb, Mt, fold);
        const R1 = hinge(C, Mb, Mt, fold);
        pushQuad(
          [L0, Mb, Mt, L1],
          [CONTOUR, CREASE, CONTOUR, CONTOUR],
          [M11, M01, M00, M10],
          s,
          n0,
        );
        pushQuad(
          [Mb, R0, R1, Mt],
          [CONTOUR, CONTOUR, CONTOUR, CREASE],
          [M01, M11, M10, M00],
          s,
          n0,
        );
      } else {
        pushQuad([A, B, C, D], [CONTOUR, CONTOUR, CONTOUR, CONTOUR], [M11, M11, M10, M10], s, n0);
      }
    }
  });

  return {
    position: new Float32Array(position),
    half: new Float32Array(half),
    cell: new Float32Array(cell),
    bary: new Float32Array(bary),
    edge: new Float32Array(edge),
    mod: new Float32Array(mod),
    seed: new Float32Array(seed),
    kinds,
    vertices: position.length / 3,
  };
}
