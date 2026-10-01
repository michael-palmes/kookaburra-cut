import { type DependencyList, useLayoutEffect, useMemo } from "react";
import {
  type Camera,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  type Scene,
  type ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from "three";
import { glslFloat } from "./glsl";
import type { LookMaterialSpec } from "./material";

/** F2 ink ribbons: world-space lines drawn as screen-extruded quads, one instance per segment. A look describes each point with a vec4 path param that its GLSL `inkPath` turns into a look-local position, so animated paths build their geometry once and move in the vertex stage. Width is `max(world width in export px, px width * uPx)`; below the minimum (`min * uPx`, never under INK_RASTER_FLOOR_PX) the ribbon keeps that width and fades its coverage instead of thinning. Joins are mitred from the neighbouring points, so joined segments share their edges (no overlap beads, no gaps). */

/** Up to four numbers (missing ones are 0): a point's path param or a strand's data. */
export type InkParam = readonly number[];

/** One strand: path params (a flat vec4 per point) and a per-strand vec4 (`inkStrand` in GLSL). */
export interface InkStrand {
  points: Float32Array;
  closed: boolean;
  data: InkParam;
}

/** Narrowest width, in pixels of the target actually drawn into, a ribbon is drawn at; thinner asks fade coverage. */
export const INK_RASTER_FLOOR_PX = 1.2;
/** Default minimum width in reference px (times uPx), below which coverage fades instead of the line thinning. */
export const INK_MIN_PX = 1.5;
/** Extra quad width each side (target px) that holds the fwidth edge ramp. */
export const INK_EDGE_PAD_PX = 1.5;

const pack = (points: readonly InkParam[]): Float32Array => {
  const out = new Float32Array(points.length * 4);
  points.forEach((p, i) => {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = p[c] ?? 0;
  });
  return out;
};

/** An open strand through `points`. */
export function inkPolyline(points: readonly InkParam[], data: InkParam = []): InkStrand {
  return { points: pack(points), closed: false, data };
}

/** A closed strand: the last point joins back to the first (needs three or more points). */
export function inkLoop(points: readonly InkParam[], data: InkParam = []): InkStrand {
  return { points: pack(points), closed: true, data };
}

/** `count` strands of `points` points each, from `param(strand, point)` and optional `data(strand)`: threads, streaks, rings. */
export function inkStrands(
  count: number,
  points: number,
  param: (strand: number, point: number) => InkParam,
  options: { closed?: boolean; data?: (strand: number) => InkParam } = {},
): InkStrand[] {
  const out: InkStrand[] = [];
  for (let s = 0; s < count; s++) {
    const pts: InkParam[] = [];
    for (let i = 0; i < points; i++) pts.push(param(s, i));
    out.push({ points: pack(pts), closed: options.closed ?? false, data: options.data?.(s) ?? [] });
  }
  return out;
}

/** Per-segment instance data: path params of the previous point, both ends and the next point, `seg` (along at A, along at B, has prev, has next), the strand data, and each strand's cumulative segment end. */
export interface InkSegments {
  prev: Float32Array;
  a: Float32Array;
  b: Float32Array;
  next: Float32Array;
  seg: Float32Array;
  strand: Float32Array;
  strandEnds: number[];
}

const segmentCount = (s: InkStrand): number => {
  const n = Math.floor(s.points.length / 4);
  if (n < 2) return 0;
  return s.closed && n >= 3 ? n : n - 1;
};

/** Expands strands into per-segment instance arrays (pure). Open strands of n points give n - 1 segments; closed ones n, wrapping. */
export function inkRibbonSegments(strands: readonly InkStrand[]): InkSegments {
  const total = strands.reduce((sum, s) => sum + segmentCount(s), 0);
  const out: InkSegments = {
    prev: new Float32Array(total * 4),
    a: new Float32Array(total * 4),
    b: new Float32Array(total * 4),
    next: new Float32Array(total * 4),
    seg: new Float32Array(total * 4),
    strand: new Float32Array(total * 4),
    strandEnds: [],
  };
  let o = 0;
  for (const s of strands) {
    const n = Math.floor(s.points.length / 4);
    const segs = segmentCount(s);
    const closed = s.closed && n >= 3;
    const copy = (dst: Float32Array, point: number) =>
      dst.set(s.points.subarray(point * 4, point * 4 + 4), o * 4);
    for (let j = 0; j < segs; j++) {
      const ia = j;
      const ib = closed ? (j + 1) % n : j + 1;
      const hasPrev = closed || j > 0;
      const hasNext = closed || j + 2 < n;
      copy(out.prev, hasPrev ? (j - 1 + n) % n : ia);
      copy(out.a, ia);
      copy(out.b, ib);
      copy(out.next, hasNext ? (j + 2) % n : ib);
      const span = closed ? n : n - 1;
      out.seg.set([j / span, (j + 1) / span, hasPrev ? 1 : 0, hasNext ? 1 : 0], o * 4);
      for (let c = 0; c < 4; c++) out.strand[o * 4 + c] = s.data[c] ?? 0;
      o++;
    }
    out.strandEnds.push(o);
  }
  return out;
}

/** The ribbon geometry: a unit quad instanced per segment. Mount it with `frustumCulled={false}`; the vertex stage moves it. */
export function inkRibbonGeometry(strands: readonly InkStrand[]): InstancedBufferGeometry {
  const s = inkRibbonSegments(strands);
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute("inkPrev", new InstancedBufferAttribute(s.prev, 4));
  g.setAttribute("inkA", new InstancedBufferAttribute(s.a, 4));
  g.setAttribute("inkB", new InstancedBufferAttribute(s.b, 4));
  g.setAttribute("inkNext", new InstancedBufferAttribute(s.next, 4));
  g.setAttribute("inkSeg", new InstancedBufferAttribute(s.seg, 4));
  g.setAttribute("inkStrand", new InstancedBufferAttribute(s.strand, 4));
  g.instanceCount = s.strandEnds.at(-1) ?? 0;
  g.userData.inkStrandEnds = s.strandEnds;
  return g;
}

/** Draws only the first `count` strands (a slider over a geometry built at its max), without a rebuild. */
export function showInkStrands(geometry: InstancedBufferGeometry, count: number): void {
  const ends = (geometry.userData.inkStrandEnds as number[] | undefined) ?? [];
  const n = Math.max(0, Math.min(ends.length, Math.floor(count)));
  geometry.instanceCount = n > 0 ? ends[n - 1] : 0;
}

/** A memoised ribbon geometry, rebuilt when `deps` change and disposed on rebuild and unmount. */
export function useInkRibbonGeometry(
  build: () => readonly InkStrand[],
  deps: DependencyList,
): InstancedBufferGeometry {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps are the rebuild key, as with useMemo.
  const geometry = useMemo(() => inkRibbonGeometry(build()), deps);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** What an ink material needs beyond a look material. The fragment reads `inkCoverage()` (edge AA x floor coverage x distance fade) and the varyings `vWorld`, `vInkAlong`, `vInkStrand`; the chunk declares them, so do not redeclare. */
export interface InkRibbonSpec extends Omit<LookMaterialSpec, "vertexShader" | "cutaway"> {
  /** GLSL defining `vec3 inkPath(vec4 p)`, a path param to a look-local position (strand data in the `inkStrand` attribute). Default: `p.xyz`, static points. */
  path?: string;
  /** GLSL defining `vec2 inkWidth(vec4 p, vec3 world)`: full width as (world units, reference px), the larger wins. Default: `uInkWidth.xy`. */
  width?: string;
  /** GLSL defining `void inkVertex(vec4 p, vec3 world)`, run last in the vertex stage to write the look's own varyings. */
  vertex?: string;
  /** Initial `uInkWidth` (world, px, min): full world width, full width in reference px, and the minimum in reference px. */
  lineWidth?: { world?: number; px?: number; min?: number };
  /** Camera distance [near, far] over which ink fades out (`uInkFade`); omit for none. */
  fade?: readonly [number, number];
  /** Pulls ink toward the camera by this fraction of its view depth (`uInkLift`), with no screen shift, so ink on its own surface wins the depth test. */
  lift?: number;
}

const DEFAULT_PATH = "vec3 inkPath(vec4 p) { return p.xyz; }";
const DEFAULT_WIDTH = "vec2 inkWidth(vec4 p, vec3 world) { return uInkWidth.xy; }";
const DEFAULT_VERTEX = "void inkVertex(vec4 p, vec3 world) {}";

// language=GLSL
const INK_VERTEX_HEAD = /* glsl */ `
attribute vec4 inkPrev;
attribute vec4 inkA;
attribute vec4 inkB;
attribute vec4 inkNext;
attribute vec4 inkSeg;
attribute vec4 inkStrand;
uniform vec3 uInkWidth;
uniform float uInkLift;
uniform vec2 uInkRaster;
varying vec3 vWorld;
varying float vInkSide;
varying float vInkHalf;
varying float vInkCover;
varying float vInkAlong;
varying vec4 vInkStrand;
`;

// language=GLSL
const INK_VERTEX_MAIN = /* glsl */ `
vec3 inkWorld(vec4 p) { return (modelMatrix * vec4(inkPath(p), 1.0)).xyz; }
vec2 inkScreen(vec4 v) {
  vec4 c = projectionMatrix * v;
  return c.xy / c.w * uResolution * 0.5;
}
vec2 inkDir(vec2 from, vec2 to, vec2 fallback) {
  vec2 d = to - from;
  float l = length(d);
  return l > 1e-4 ? d / l : fallback;
}
void main() {
  bool atB = position.x > 0.5;
  float zc = -1.02 * projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  vec3 wa = inkWorld(inkA);
  vec3 wb = inkWorld(inkB);
  vec4 va = viewMatrix * vec4(wa, 1.0);
  vec4 vb = viewMatrix * vec4(wb, 1.0);
  if (va.z > zc && vb.z > zc) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  bool clipA = va.z > zc;
  bool clipB = vb.z > zc;
  float alongA = inkSeg.x;
  float alongB = inkSeg.y;
  if (clipA) {
    float k = (zc - va.z) / (vb.z - va.z);
    va = mix(va, vb, k);
    wa = mix(wa, wb, k);
    alongA = mix(inkSeg.x, inkSeg.y, k);
  } else if (clipB) {
    float k = (zc - vb.z) / (va.z - vb.z);
    vb = mix(vb, va, k);
    wb = mix(wb, wa, k);
    alongB = mix(inkSeg.y, inkSeg.x, k);
  }
  vec2 sa = inkScreen(va);
  vec2 sb = inkScreen(vb);
  vec2 dir = inkDir(sa, sb, vec2(1.0, 0.0));
  vec2 tIn = dir;
  vec2 tOut = dir;
  if (!atB && inkSeg.z > 0.5 && !clipA) {
    vec4 vp = viewMatrix * vec4(inkWorld(inkPrev), 1.0);
    if (vp.z > zc) vp = mix(vp, va, (zc - vp.z) / (va.z - vp.z));
    tIn = inkDir(inkScreen(vp), sa, dir);
  }
  if (atB && inkSeg.w > 0.5 && !clipB) {
    vec4 vn = viewMatrix * vec4(inkWorld(inkNext), 1.0);
    if (vn.z > zc) vn = mix(vn, vb, (zc - vn.z) / (vb.z - vn.z));
    tOut = inkDir(sb, inkScreen(vn), dir);
  }
  vec2 m = tIn + tOut;
  float ml = length(m);
  vec2 mdir = ml > 1e-3 ? m / ml : tIn;
  vec2 nrm = vec2(-mdir.y, mdir.x);
  float miter = 1.0 / max(dot(nrm, vec2(-tIn.y, tIn.x)), 0.5);
  vec4 v = atB ? vb : va;
  vec3 w = atB ? wb : wa;
  vec4 p = atB ? inkB : inkA;
  vec2 wd = inkWidth(p, w);
  float want = max(wd.x * exportPxPerUnit(-v.z), wd.y * uPx);
  float raster = uInkRaster.y > 0.0 ? uInkRaster.y / uResolution.y : 1.0;
  float drawPx = max(want, max(uInkWidth.z * uPx, INK_RASTER_FLOOR_PX / raster));
  float halfPx = 0.5 * drawPx;
  float extent = halfPx + INK_EDGE_PAD_PX / raster;
  vec4 c = projectionMatrix * vec4(v.xyz * (1.0 - uInkLift), 1.0);
  c.xy += nrm * (position.y * extent * miter) / (uResolution * 0.5) * c.w;
  gl_Position = c;
  vWorld = w;
  vInkSide = position.y * extent;
  vInkHalf = halfPx;
  vInkCover = want / drawPx;
  vInkAlong = atB ? alongB : alongA;
  vInkStrand = inkStrand;
  inkVertex(p, w);
}
`;

/** FRAGMENT. The ink varyings and coverage helpers every ink fragment gets prepended. */
// language=GLSL
export const INK_RIBBON_FRAGMENT: string = /* glsl */ `
#ifndef KK_INK_RIBBON
#define KK_INK_RIBBON
uniform vec2 uInkFade;
varying vec3 vWorld;
varying float vInkSide;
varying float vInkHalf;
varying float vInkCover;
varying float vInkAlong;
varying vec4 vInkStrand;
float inkEdge() {
  float fw = max(fwidth(vInkSide), 1e-4);
  return clamp((vInkHalf - abs(vInkSide)) / fw + 0.5, 0.0, 1.0);
}
float inkDistanceFade() {
  if (uInkFade.y <= uInkFade.x) return 1.0;
  return 1.0 - smoothstep(uInkFade.x, uInkFade.y, distance(cameraPosition, vWorld));
}
float inkCoverage() { return inkEdge() * vInkCover * inkDistanceFade(); }
#endif
`;

/** The ribbon vertex shader for a spec: attributes, the look's path/width/vertex hooks, then the extrusion. */
export function inkRibbonVertexShader(spec: Pick<InkRibbonSpec, "path" | "width" | "vertex">) {
  return [
    `#define INK_RASTER_FLOOR_PX ${glslFloat(INK_RASTER_FLOOR_PX)}`,
    `#define INK_EDGE_PAD_PX ${glslFloat(INK_EDGE_PAD_PX)}`,
    INK_VERTEX_HEAD,
    spec.path ?? DEFAULT_PATH,
    spec.width ?? DEFAULT_WIDTH,
    spec.vertex ?? DEFAULT_VERTEX,
    INK_VERTEX_MAIN,
  ].join("\n");
}

/** A look material spec for ink ribbons: feed it to `useLookMaterials` beside the look's other parts. Transparent with no depth writes by default; update `uInkWidth`, `uInkFade` and `uInkLift` in place. */
export function inkRibbonMaterial(spec: InkRibbonSpec): LookMaterialSpec {
  const { path, width, vertex, lineWidth, fade, lift, ...rest } = spec;
  return {
    ...rest,
    transparent: rest.transparent ?? true,
    vertexShader: inkRibbonVertexShader({ path, width, vertex }),
    fragmentShader: `${INK_RIBBON_FRAGMENT}\n${spec.fragmentShader}`,
    uniforms: {
      ...rest.uniforms,
      uInkWidth: {
        value: new Vector3(lineWidth?.world ?? 0, lineWidth?.px ?? 0, lineWidth?.min ?? INK_MIN_PX),
      },
      uInkFade: { value: new Vector2(fade?.[0] ?? 0, fade?.[1] ?? 0) },
      uInkLift: { value: lift ?? 0 },
      uInkRaster: { value: new Vector2(0, 0) },
    },
  };
}

const viewport = new Vector4();

/** Mount every ribbon mesh with `onBeforeRender={inkRasterSync}`: it hands the ink the size of the target it draws into, so the raster floor and edge pad hold in real pixels when that differs from the export size (preview canvas, picker tiles). On an export-size target it changes nothing. */
export function inkRasterSync(
  renderer: WebGLRenderer,
  _scene: Scene,
  _camera: Camera,
  _geometry: unknown,
  material: Material,
): void {
  const raster = (material as ShaderMaterial).uniforms?.uInkRaster?.value as Vector2 | undefined;
  if (!raster) return;
  renderer.getCurrentViewport(viewport);
  raster.set(viewport.z, viewport.w);
}
