import { useLayoutEffect, useMemo } from "react";
import {
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type IUniform,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  PlaneGeometry,
  RGBAFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
} from "three";
import { FPS } from "../../../../engine/format";
import { createSeededRandom } from "../../../../engine/rng";
import { useTimeline } from "../../../../engine/timeline";
import type { LookMaterialSpec } from "./material";

/** Stroke splats (F3): instanced brush-mask quads laid as flat, layered paint. One seeded atlas of dry-brush masks, per-instance attributes, a fixed far-to-near draw order with depth writes off (overlaps layer like paint and never z-fight), and an integer boil step from the frame index. */

/** Brush-mask cells: shape `k` lives at uv cell `(k % 2, floor(k / 2))`, v up, the stroke's root edge at the cell's bottom. */
export const BRUSH_SHAPES = { flat: 0, curved: 1, short: 2, tapered: 3 } as const;

/** Atlas layout and seed: EXPORT CONTRACT, since every splat look samples it. */
export const BRUSH_ATLAS = { width: 256, height: 128, cols: 2, rows: 2, seed: 0xb1a5 } as const;

const BRISTLES = 16;
const CURVE_SEGMENTS = 24;

/** One RGBA8 atlas level: R, G and B carry the paint load (linear), A the coverage. */
export interface BrushMaskLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = px - ax - t * dx;
  const ey = py - ay - t * dy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Level 0 of the brush-mask atlas, rasterised analytically from one seeded stream (no canvas, no DOM): each cell is a dry-brush stroke of 16 overlapping round-capped bristles on quadratic curves, composited source-over. */
export function brushMaskPixels(seed: number = BRUSH_ATLAS.seed): BrushMaskLevel {
  const { width, height, cols, rows } = BRUSH_ATLAS;
  const cw = width / cols;
  const ch = height / rows;
  const load = new Float32Array(width * height);
  const cover = new Float32Array(width * height);
  const rand = createSeededRandom(seed);
  const xs = new Float64Array(CURVE_SEGMENTS + 1);
  const ys = new Float64Array(CURVE_SEGMENTS + 1);
  for (let shape = 0; shape < cols * rows; shape++) {
    const ox = (shape % cols) * cw;
    const oy = Math.floor(shape / cols) * ch;
    const short = shape === BRUSH_SHAPES.short;
    const x0 = short ? 26 : 12;
    const x1 = short ? 102 : 116;
    const curve = shape === BRUSH_SHAPES.curved ? 7 : (rand() - 0.5) * 3;
    for (let k = 0; k < BRISTLES; k++) {
      const v = (k + 0.5) / BRISTLES;
      const y = 14 + v * 36;
      const taper = shape === BRUSH_SHAPES.tapered ? Math.abs(v - 0.5) * 2 : 0;
      const s0 = x0 + rand() * 10 + taper * 10;
      const s1 = x1 - rand() * 12 - taper * 44;
      const paint = srgbToLinear(Math.floor(170 + rand() * 85) / 255);
      const alpha = 0.8 + rand() * 0.2;
      const half = (3 + rand() * 2.5) / 2;
      const ya = y + (rand() - 0.5) * 2;
      const yc = y - curve * (1 - Math.abs(v - 0.5));
      const yb = y + (rand() - 0.5) * 3;
      const xc = (s0 + s1) / 2;
      for (let i = 0; i <= CURVE_SEGMENTS; i++) {
        const t = i / CURVE_SEGMENTS;
        const u = 1 - t;
        xs[i] = u * u * s0 + 2 * u * t * xc + t * t * s1;
        ys[i] = u * u * ya + 2 * u * t * yc + t * t * yb;
      }
      // Canvas-style y runs down the cell; texture rows run up, so the stroke's top is the cell's top.
      const minX = Math.max(0, Math.floor(Math.min(s0, s1) - half - 1));
      const maxX = Math.min(cw - 1, Math.ceil(Math.max(s0, s1) + half + 1));
      const minY = Math.max(0, Math.floor(Math.min(ya, yb, yc) - half - 1));
      const maxY = Math.min(ch - 1, Math.ceil(Math.max(ya, yb, yc) + half + 1));
      for (let cy = minY; cy <= maxY; cy++) {
        const row = oy + (ch - 1 - cy);
        for (let cx = minX; cx <= maxX; cx++) {
          let d = Number.POSITIVE_INFINITY;
          for (let i = 0; i < CURVE_SEGMENTS; i++) {
            d = Math.min(
              d,
              segmentDistance(cx + 0.5, cy + 0.5, xs[i], ys[i], xs[i + 1], ys[i + 1]),
            );
          }
          const a = alpha * Math.min(1, Math.max(0, half + 0.5 - d));
          if (a <= 0) continue;
          const p = row * width + ox + cx;
          load[p] = paint * a + load[p] * (1 - a);
          cover[p] = a + cover[p] * (1 - a);
        }
      }
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const a = Math.round(cover[p] * 255);
    const l = a > 0 ? Math.round((load[p] / cover[p]) * 255) : 0;
    data[p * 4] = l;
    data[p * 4 + 1] = l;
    data[p * 4 + 2] = l;
    data[p * 4 + 3] = a;
  }
  return { width, height, data };
}

/** The full mip chain down to 1x1, box-filtered in JS (GPU mip generation is driver-defined). Paint load averages weighted by coverage, so small far strokes keep their tone instead of darkening toward the empty margins. */
export function brushMaskMips(level0: BrushMaskLevel): BrushMaskLevel[] {
  const out = [level0];
  let prev = level0;
  while (prev.width > 1 || prev.height > 1) {
    const width = Math.max(1, prev.width >> 1);
    const height = Math.max(1, prev.height >> 1);
    const data = new Uint8Array(width * height * 4);
    const sx = prev.width > 1 ? 2 : 1;
    const sy = prev.height > 1 ? 2 : 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let a = 0;
        let la = 0;
        for (let j = 0; j < sy; j++) {
          for (let i = 0; i < sx; i++) {
            const q = ((y * sy + j) * prev.width + x * sx + i) * 4;
            a += prev.data[q + 3];
            la += prev.data[q] * prev.data[q + 3];
          }
        }
        const p = (y * width + x) * 4;
        const l = a > 0 ? Math.round(la / a) : 0;
        data[p] = l;
        data[p + 1] = l;
        data[p + 2] = l;
        data[p + 3] = Math.round(a / (sx * sy));
      }
    }
    out.push({ width, height, data });
    prev = out[out.length - 1];
  }
  return out;
}

let sharedAtlas: DataTexture | null = null;

/** The shared brush-mask atlas, built on first use (never at module evaluation) with its JS mip chain: trilinear, clamped, linear data, no flip, no premultiply. */
export function brushMaskTexture(): DataTexture {
  if (sharedAtlas) return sharedAtlas;
  const levels = brushMaskMips(brushMaskPixels());
  const tex = new DataTexture(
    levels[0].data,
    levels[0].width,
    levels[0].height,
    RGBAFormat,
    UnsignedByteType,
  );
  tex.mipmaps = levels.map(({ data, width, height }) => ({ data, width, height }));
  tex.generateMipmaps = false;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = NoColorSpace;
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.name = "kk-look:brush-mask";
  tex.needsUpdate = true;
  sharedAtlas = tex;
  return tex;
}

/** `{ uBrushMask }` for a splat material's uniforms; call it inside the material factory, never at module scope. */
export function brushMaskUniforms(): { uBrushMask: IUniform<DataTexture> } {
  return { uBrushMask: { value: brushMaskTexture() } };
}

/** One splat as a look places it. `tilt` lifts the free edge off the ground (radians, 0 lies flat, its sign picks the side it leans to, never exactly 0); `tone` is look-defined (a palette pick); `rank` in [0, 1) is the thinning key (`splatHidden(keep)` drops rank >= keep); `id` is the placement index, the seed for every per-splat hash. */
export interface StrokeSplat {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tilt: number;
  length: number;
  width: number;
  shape: number;
  tone: number;
  rank: number;
}

/** The fixed draw order: farthest from the stage centre (xz) first, id breaking ties, so layered paint reads front over back from the stage and never re-sorts per frame. Returns a new array. */
export function orderSplatsFarToNear<T extends Pick<StrokeSplat, "id" | "x" | "z">>(
  splats: readonly T[],
): T[] {
  return splats
    .map((s) => ({ s, d: s.x * s.x + s.z * s.z }))
    .sort((a, b) => b.d - a.d || a.s.id - b.s.id)
    .map((e) => e.s);
}

/** Per-instance attributes as vec4s: `aSplatRoot` (x, y, z, yaw), `aSplatSize` (length, width, tilt, shape), `aSplatSeed` (tone, rank, id, 0). */
export function packStrokeSplats(splats: readonly StrokeSplat[]): {
  root: Float32Array;
  size: Float32Array;
  seed: Float32Array;
} {
  const n = splats.length;
  const root = new Float32Array(n * 4);
  const size = new Float32Array(n * 4);
  const seed = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = splats[i];
    root.set([s.x, s.y, s.z, s.yaw], i * 4);
    size.set([s.length, s.width, s.tilt, s.shape], i * 4);
    seed.set([s.tone, s.rank, s.id, 0], i * 4);
  }
  return { root, size, seed };
}

/** A unit quad instanced once per splat in the given (draw) order. Its bounding sphere is centred on the stage, like every look part, so three's transparent sort ties and the look's mount order is its draw order. Render it with `frustumCulled={false}`. */
export function createStrokeSplatGeometry(splats: readonly StrokeSplat[]): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(quad.getIndex());
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));
  const { root, size, seed } = packStrokeSplats(splats);
  geometry.setAttribute("aSplatRoot", new InstancedBufferAttribute(root, 4));
  geometry.setAttribute("aSplatSize", new InstancedBufferAttribute(size, 4));
  geometry.setAttribute("aSplatSeed", new InstancedBufferAttribute(seed, 4));
  geometry.instanceCount = splats.length;
  let reach = 0;
  for (const s of splats) {
    reach = Math.max(reach, Math.hypot(s.x, s.y, s.z) + Math.max(s.length, s.width));
  }
  geometry.boundingSphere = new Sphere(new Vector3(), reach);
  quad.dispose();
  return geometry;
}

/** The splat geometry for a placement list, disposed on change and unmount. */
export function useStrokeSplatGeometry(splats: readonly StrokeSplat[]): InstancedBufferGeometry {
  const geometry = useMemo(() => createStrokeSplatGeometry(splats), [splats]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** Integer boil step for stop-motion splats: the frame index (exact on export frames) times a whole-number rate per second, integer-divided by FPS. 0 while the rate is 0. Never floor a float time. */
export function splatBoilStep(globalMs: number, ratePerSecond: number): number {
  const rate = Math.max(0, Math.round(ratePerSecond));
  if (rate === 0) return 0;
  const frame = Math.round((globalMs * FPS) / 1000);
  return Math.floor((frame * rate) / FPS);
}

/** The boil step on the absolute project clock. */
export function useSplatBoilStep(ratePerSecond: number): number {
  const { globalMs } = useTimeline();
  return splatBoilStep(globalMs, ratePerSecond);
}

/** Blend state for splat materials: layered paint (transparent, depth writes off), both faces. */
export const STROKE_SPLAT_MATERIAL: Pick<LookMaterialSpec, "transparent" | "depthWrite" | "side"> =
  { transparent: true, depthWrite: false, side: DoubleSide };

/** VERTEX-ONLY (attributes; needs the kit hash). The splat attributes plus helpers: `splatLocalCorner(corner, length, width)` is the quad corner's offset from the root before yaw (`corner` is the unit quad's `position.xy`, the root edge at y -0.5), `splatLocalNormal()` its face normal, `splatYaw` turns either about +y, `splatTip` is 0 at the root edge and 1 at the free edge (for wind shear), `splatRand(salt)` and `splatRandStep(salt, step)` hash the splat id, `splatHidden(keep)` thins by rank and `splatCulled()` is a clip position that draws nothing. */
// language=GLSL
export const STROKE_SPLAT_GLSL_VERTEX: string = /* glsl */ `
#ifndef KK_STROKE_SPLAT_VERTEX
#define KK_STROKE_SPLAT_VERTEX
attribute vec4 aSplatRoot;
attribute vec4 aSplatSize;
attribute vec4 aSplatSeed;
int splatId() { return int(aSplatSeed.z + 0.5); }
float splatRand(int salt) { return hash21(ivec2(splatId(), salt)); }
float splatRandStep(int salt, int step) { return hash31(ivec3(splatId(), salt, step)); }
bool splatHidden(float keep) { return aSplatSeed.y >= keep; }
float splatLean() { return aSplatSize.z < 0.0 ? -1.0 : 1.0; }
vec3 splatLocalCorner(vec2 corner, float len, float width) {
  float tilt = abs(aSplatSize.z);
  float across = (corner.y + 0.5) * width;
  return vec3(corner.x * len, across * sin(tilt), across * cos(tilt) * splatLean());
}
vec3 splatLocalNormal() {
  float tilt = abs(aSplatSize.z);
  return vec3(0.0, cos(tilt), -sin(tilt) * splatLean());
}
vec3 splatYaw(vec3 v, float yaw) {
  float c = cos(yaw);
  float s = sin(yaw);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}
float splatTip(vec2 corner) { return corner.y + 0.5; }
vec2 splatAtlasUv(vec2 quadUv) {
  int k = int(aSplatSize.w + 0.5);
  return (vec2(float(k % 2), float(k / 2)) + quadUv) * 0.5;
}
vec4 splatCulled() { return vec4(0.0, 0.0, 2.0, 1.0); }
#endif
`;

/** FRAGMENT. `splatMask(atlasUv)` samples the brush atlas (declares `uBrushMask`): x is the paint load (streaks), y the coverage as a soft threshold of the filtered mask, so edges stay painterly at every mip. */
// language=GLSL
export const STROKE_SPLAT_GLSL_FRAGMENT: string = /* glsl */ `
#ifndef KK_STROKE_SPLAT_FRAGMENT
#define KK_STROKE_SPLAT_FRAGMENT
uniform sampler2D uBrushMask;
vec2 splatMask(vec2 atlasUv) {
  vec4 m = texture2D(uBrushMask, atlasUv);
  return vec2(m.r, smoothstep(0.2, 0.6, m.a));
}
#endif
`;
