import { BufferGeometry, Float32BufferAttribute, type IUniform } from "three";

/** F5 ring bands: seamless 360 degree horizons. One mesh holds every band (inward-facing open cylinders round the stage axis) plus an optional ground disc, laid out and grouped FAR TO NEAR, so the draw order never depends on the camera: pass one material to draw the stack in a single call, or a material array indexed by band (the floor takes index `bands.length`). Silhouettes are noise sampled on the circle (`ringNoise`, `ringCrest`), so no angle ever shows a seam. */

/** Uniform array length for per-band values (`RING_BANDS_MAX` in GLSL). */
export const RING_BANDS_MAX = 8;

const TAU = Math.PI * 2;

/** One band in world units: an open cylinder of `radius` from `bottom` to `top`. */
export interface RingBandShape {
  radius: number;
  bottom: number;
  top: number;
}

/** A flat, upward-facing ground disc drawn after every band at or beyond its radius. */
export interface RingFloorShape {
  radius: number;
  y: number;
}

export interface RingBandsGeometryOptions {
  /** Facets round each band and the floor (default 256). */
  segments?: number;
  floor?: RingFloorShape;
}

/** Draw order as input indices, far to near (ties keep input order); the floor is `bands.length`, placed after every band whose radius reaches it. */
export function ringBandDrawOrder(
  bands: readonly RingBandShape[],
  floor?: RingFloorShape,
): number[] {
  const order = bands.map((_, i) => i).sort((a, b) => bands[b].radius - bands[a].radius || a - b);
  if (!floor) return order;
  const at = order.findIndex((i) => bands[i].radius < floor.radius);
  order.splice(at < 0 ? order.length : at, 0, bands.length);
  return order;
}

/** The ring stack geometry: `position`, `uv` (u round the band, v bottom to top; floor uv is planar), `normal` (inward for bands, up for the floor) and `aRingBand` (the input index, -1 on the floor), one group per band in draw order with `materialIndex` equal to that index. Bands wind inward, so the default FrontSide culls a band's near half once the camera is outside it (the F11 cutaway, built in). */
export function createRingBandsGeometry(
  bands: readonly RingBandShape[],
  options: RingBandsGeometryOptions = {},
): BufferGeometry {
  if (bands.length > RING_BANDS_MAX) {
    throw new Error(`[scene3d kit] ring bands: at most ${RING_BANDS_MAX} bands`);
  }
  const segments = Math.max(3, Math.floor(options.segments ?? 256));
  const { floor } = options;
  const position: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];
  const band: number[] = [];
  const index: number[] = [];
  const geometry = new BufferGeometry();

  for (const i of ringBandDrawOrder(bands, floor)) {
    const start = index.length;
    const base = position.length / 3;
    if (i === bands.length && floor) {
      position.push(0, floor.y, 0);
      uv.push(0.5, 0.5);
      normal.push(0, 1, 0);
      band.push(-1);
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * TAU;
        const x = Math.cos(a) * floor.radius;
        const z = Math.sin(a) * floor.radius;
        position.push(x, floor.y, z);
        uv.push(0.5 + x / (2 * floor.radius), 0.5 + z / (2 * floor.radius));
        normal.push(0, 1, 0);
        band.push(-1);
      }
      for (let s = 0; s < segments; s++) index.push(base, base + s + 2, base + s + 1);
    } else {
      const { radius, bottom, top } = bands[i];
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * TAU;
        const c = Math.cos(a);
        const n = Math.sin(a);
        for (const [y, v] of [
          [bottom, 0],
          [top, 1],
        ]) {
          position.push(c * radius, y, n * radius);
          uv.push(s / segments, v);
          normal.push(-c, 0, -n);
          band.push(i);
        }
      }
      for (let s = 0; s < segments; s++) {
        const a = base + s * 2;
        index.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
    geometry.addGroup(start, index.length - start, i);
  }

  geometry.setIndex(index);
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  geometry.setAttribute("aRingBand", new Float32BufferAttribute(band, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A band's spin in radians at look time `t`: `turns` signed revolutions per `period` seconds, so whole turns loop the stack exactly every period. Wrapped to [0, 2pi) in double precision; fractional turns (a drift multiplier) stay continuous. */
export function ringBandAngle(t: number, turns: number, period: number): number {
  if (!(period > 0)) return 0;
  const phase = (turns * t) / period;
  return (phase - Math.floor(phase)) * TAU;
}

/** Per-band uniforms the ring vertex shader reads: spin angle (radians) and fade (0 hides the band's vertices, 1 is full strength). Fades start at 1. Share one set across every material on the stack. */
export function createRingBandUniforms(): {
  uRingAngle: IUniform<Float32Array>;
  uRingFade: IUniform<Float32Array>;
} {
  return {
    uRingAngle: { value: new Float32Array(RING_BANDS_MAX) },
    uRingFade: { value: new Float32Array(RING_BANDS_MAX).fill(1) },
  };
}

/** VERTEX-SAFE (needs the kit noise chunk). Circle-sampled noise for seamless 360 degree silhouettes: `dir` is the unit direction round the axis (`normalize(p.xz)`), `freq` the noise-space radius, so a larger freq packs more features into the turn. `ringCrest` is a mountain profile between `lo` and `hi`: rolling fbm plus squared ridged peaks. `ringRotate` spins a point about the axis. */
// language=GLSL
export const LOOK_GLSL_RING_BANDS: string = /* glsl */ `
#ifndef KK_LOOK_RING_BANDS
#define KK_LOOK_RING_BANDS
#define RING_BANDS_MAX ${RING_BANDS_MAX}
vec3 ringRotate(vec3 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}
float ringNoise(vec2 dir, float freq, float seed) {
  return fbm(dir * freq + vec2(seed, seed * 0.37));
}
float ringRidge(vec2 dir, float freq, float seed) {
  float r = 1.0 - abs(2.0 * vnoise(dir * freq * 1.9 + vec2(seed + 3.1, seed * 0.37 + 3.1)) - 1.0);
  return r * r;
}
float ringCrest(vec2 dir, float lo, float hi, float freq, float seed) {
  float n = ringNoise(dir, freq, seed);
  float h = clamp(0.75 * smoothstep(0.25, 0.75, n) + 0.3 * ringRidge(dir, freq, seed), 0.0, 1.0);
  return mix(lo, hi, h);
}
#endif
`;

/** FRAGMENT-ONLY (fwidth). `ringEdge` is the silhouette alpha for `d` (world units below the crest, positive inside): a ragged wet bleed (`bleed` offsets the edge, `bleedWidth` softens it) morphing into a crisp aaStep cut as `hardness` goes 0 to 1. */
// language=GLSL
export const LOOK_GLSL_RING_EDGE: string = /* glsl */ `
#ifndef KK_LOOK_RING_EDGE
#define KK_LOOK_RING_EDGE
float ringEdge(float d, float hardness, float bleed, float bleedWidth) {
  float bw = bleedWidth + fwidth(d);
  float wet = smoothstep(-bw, bw, d + bleed);
  return mix(wet, aaStep(0.0, d), clamp(hardness, 0.0, 1.0));
}
#endif
`;

/** VERTEX-ONLY. The ring stack's vertex stage: `ringBandVertex()` spins each band by `uRingAngle`, collapses bands whose `uRingFade` is 0, sets `vWorld`, `vRing` (the band-space position, which turns with the band: sample silhouettes here), `vRingBand` and `vRingFade`, and returns the clip position. The floor (band -1) never spins. */
// language=GLSL
export const LOOK_GLSL_RING_VERTEX: string = /* glsl */ `
#ifndef KK_LOOK_RING_VERTEX
#define KK_LOOK_RING_VERTEX
${LOOK_GLSL_RING_BANDS}
attribute float aRingBand;
uniform float uRingAngle[RING_BANDS_MAX];
uniform float uRingFade[RING_BANDS_MAX];
varying vec3 vWorld;
varying vec3 vRing;
varying float vRingBand;
varying float vRingFade;
vec4 ringBandVertex() {
  int b = int(floor(aRingBand + 0.5));
  float angle = b >= 0 ? uRingAngle[b] : 0.0;
  float fade = b >= 0 ? uRingFade[b] : 1.0;
  vRing = position;
  vRingBand = aRingBand;
  vRingFade = fade;
  vec4 w = lookWorldPosition(ringRotate(position, angle));
  vWorld = w.xyz;
  return fade > 0.0 ? projectionMatrix * viewMatrix * w : vec4(0.0, 0.0, 2.0, 1.0);
}
#endif
`;

/** Default ring stack vertex shader (`LOOK_GLSL_RING_VERTEX` and nothing else). */
// language=GLSL
export const RING_BANDS_VERTEX_SHADER: string = /* glsl */ `
${LOOK_GLSL_RING_VERTEX}
void main() {
  gl_Position = ringBandVertex();
}
`;
