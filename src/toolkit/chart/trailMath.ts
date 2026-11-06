/** The light trail, the `lineFinish: "trail"` stroke both renderers draw a line with: a bright core in a soft halo, brightening from its tail to a glowing head at its leading end. Each run is ONE strip built on the CPU (centre points, both neighbours, side and cap flags) and widened on the GPU across its SCREEN-space tangent, by export pixels on a flat chart (the `Line2` convention, so it holds a fixed fraction of the frame in preview and export) or by chart units in 3D, so it faces the camera and tapers with perspective. A strip covers each pixel once, so additive light never doubles up at a joint the way overlapping segment caps would. The glow lives in the material, never post-processing bloom, and on a light stage the same profile lays down ink. Pure apart from the material and geometry factories: no clock, no randomness, no state. */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector3,
  Vector4,
  ZeroFactor,
} from "three";
import { bytesToHex, hexToOklch, mixOklch, oklchToBytes } from "../../theme/oklch";
import { drawEdgeX, polylineYAt, pulseGain } from "./chart2dMath";
import { chartTrimRuns } from "./layout";
import { isLightBackground } from "./stylePresets";
import type { ChartLinePoint, ChartPoint } from "./types";

// ── Contract constants (pinned: moving one restyles every trail) ──

/** The halo's full width in core (stroke) widths; the core's own width is its reciprocal. */
export const CHART_TRAIL_SPREAD = 6.5;
const CORE_WIDTH = 1 / CHART_TRAIL_SPREAD;
/** Halo falloff: a Gaussian rescaled to land on exactly zero at the strip edge, so the strip never shows its border. */
const HALO_FALLOFF = 3;
const HALO_EDGE = Math.exp(-HALO_FALLOFF);
/** Strip gains (halo, core): light added over a dark stage, alpha laid down as ink over a light one. */
export const CHART_TRAIL_GLOW = { halo: 0.55, core: 1.6 } as const;
export const CHART_TRAIL_INK = { halo: 0.3, core: 1 } as const;
/** The head: its radius in halo half widths, its core width in its own radii, and how much brighter than the strip it burns. */
export const CHART_TRAIL_HEAD = { radius: 1.6, core: 0.24, gain: 1.5 } as const;
/** Brightness at the tail as a share of the leading end's, and the curve it rises on. */
export const CHART_TRAIL_TAIL = 0.22;
const RAMP_POWER = 1.4;
/** OKLCH: how far the core lifts toward white on a dark stage, and how far it deepens (never below the floor) on a light one. */
const CORE_LIFT = 0.72;
const INK_DEEPEN = 0.16;
const INK_FLOOR = 0.2;
/** The draw-on clip's feather in halo half widths: soft enough for the head to cover the cut. */
export const CHART_TRAIL_FEATHER = 0.5;
/** 3D draw order. The trail sits in the OPAQUE list so glass refracts it, and writes no depth, so it draws after every other opaque mark (anything behind it drawn later would paint over the glow) and before the frame's above band. */
export const CHART_TRAIL_RENDER_ORDER = 500;
/** A joint widens by at most 2.5x, the ribbon's own miter cap. */
const MITER_MIN = 0.4;

const FALLBACK_COLOUR = "#808080";
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const WHITE = hexToOklch("#ffffff");

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── The look ─────────────────────────────────────────────────────────────────

/** The halo half width a trail takes around a core `stroke` wide, in the stroke's units. */
export const chartTrailReach = (stroke: number): number =>
  (Math.max(0, stroke) * CHART_TRAIL_SPREAD) / 2;

/** The cross-section at `d` from the centreline in halo half widths (0 on the line, 1 at the edge): the halo falls from 1 to exactly 0 at the edge, and the core is a Gaussian `core` wide (e^-1 there). Both are 0 from the edge out, where the shader discards. */
export function chartTrailProfile(
  d: number,
  core: number = CORE_WIDTH,
): { halo: number; core: number } {
  const x = Number.isFinite(d) ? Math.abs(d) : 1;
  if (x >= 1) return { halo: 0, core: 0 };
  const k = x / Math.max(1e-4, core);
  return {
    halo: clamp01((Math.exp(-HALO_FALLOFF * x * x) - HALO_EDGE) / (1 - HALO_EDGE)),
    core: Math.exp(-k * k),
  };
}

/** Brightness along the trail at local x: the tail's share at the tail, rising to 1 at the leading end; a span with nothing drawn yet is all lead. */
export function chartTrailRamp(
  x: number,
  tailX: number,
  leadX: number,
  tail: number = CHART_TRAIL_TAIL,
): number {
  const [from, inverse, floor] = chartTrailRampUniform(tailX, leadX, tail);
  const along = clamp01((x - from) * inverse);
  return floor + (1 - floor) * along ** RAMP_POWER;
}

/** The ramp as the shader reads it: (tail x, 1 / span, tail floor), the floor lifting to 1 when the span is empty. */
export function chartTrailRampUniform(
  tailX: number,
  leadX: number,
  tail: number = CHART_TRAIL_TAIL,
): [number, number, number] {
  const span = leadX - tailX;
  return span > 1e-9 ? [tailX, 1 / span, clamp01(tail)] : [tailX, 0, 1];
}

/** The depth a 3D trail sits at for plot x (0..1): its start recedes `travel` behind the plot plane and its leading end lands on it, exactly where the fit placed the plot. */
export function chartTrailZ(x: number, travel: number): number {
  const t = Number.isFinite(travel) ? Math.max(0, travel) : 0;
  const u = Number.isFinite(x) ? clamp01(x) : 1;
  return t === 0 || u >= 1 ? 0 : -t * (1 - u);
}

export type ChartTrailMode = "glow" | "ink";

/** One series' trail colours: `halo` is the series colour, `core` the colour its centreline burns at. */
export interface ChartTrailTone {
  mode: ChartTrailMode;
  halo: string;
  core: string;
}

/** A series' trail on its stage: light added over a dark background with the core lifted toward white (hue kept), or ink over a light one with the core deepened, where a glow would wash out to nothing. */
export function chartTrailTone(colour: string, background: string): ChartTrailTone {
  const trimmed = typeof colour === "string" ? colour.trim() : "";
  const halo = HEX.test(trimmed) ? trimmed : FALLBACK_COLOUR;
  const lch = hexToOklch(halo);
  if (isLightBackground(background)) {
    const l = Math.min(lch.l, Math.max(INK_FLOOR, lch.l - INK_DEEPEN));
    return { mode: "ink", halo, core: bytesToHex(oklchToBytes({ ...lch, l })) };
  }
  return { mode: "glow", halo, core: bytesToHex(oklchToBytes(mixOklch(lch, WHITE, CORE_LIFT))) };
}

/** The (halo gain, core gain, core width) a strip or its head draws with; a pulse lifts a glowing head the way it lifts every other mark. */
export function chartTrailGains(
  mode: ChartTrailMode,
  head: boolean,
  pulse = 0,
): [number, number, number] {
  const width = head ? CHART_TRAIL_HEAD.core : CORE_WIDTH;
  if (mode === "ink") return [CHART_TRAIL_INK.halo, CHART_TRAIL_INK.core, width];
  const boost = head ? CHART_TRAIL_HEAD.gain * pulseGain(pulse) : 1;
  return [CHART_TRAIL_GLOW.halo * boost, CHART_TRAIL_GLOW.core * boost, width];
}

// ── The strip ────────────────────────────────────────────────────────────────

/** One centre point in the group's local units. */
export type ChartTrailPoint = readonly [number, number, number];

/** A run's vertex buffers: a left and a right vertex per centre point plus a round cap pair at each end, each vertex carrying its centre and both neighbours so the vertex shader can find the screen-space tangent. Plain arrays, so the layout is testable and the renderer rewrites them in place. */
export interface ChartTrailStrip {
  position: Float32Array;
  prev: Float32Array;
  next: Float32Array;
  /** -1 left of the line, +1 right. */
  side: Float32Array;
  /** 0 along the body; -1 at the tail cap's tip, +1 at the head cap's. */
  cap: Float32Array;
  index: Uint16Array;
}

/** Vertices a run of `points` centres takes; a run needs two. */
export const chartTrailVertexCount = (points: number): number =>
  points >= 2 ? 2 * (points + 2) : 0;

export function chartTrailStrip(points: readonly ChartTrailPoint[]): ChartTrailStrip {
  const vertices = chartTrailVertexCount(points.length);
  const pairs = vertices / 2;
  const strip: ChartTrailStrip = {
    position: new Float32Array(vertices * 3),
    prev: new Float32Array(vertices * 3),
    next: new Float32Array(vertices * 3),
    side: new Float32Array(vertices),
    cap: new Float32Array(vertices),
    index: new Uint16Array(Math.max(0, pairs - 1) * 6),
  };
  for (let pair = 0; pair < pairs; pair++) {
    const v = pair * 2;
    const cap = pair === 0 ? -1 : pair === pairs - 1 ? 1 : 0;
    strip.side[v] = -1;
    strip.side[v + 1] = 1;
    strip.cap[v] = cap;
    strip.cap[v + 1] = cap;
    if (pair > 0) strip.index.set([v - 2, v - 1, v, v - 1, v + 1, v], (pair - 1) * 6);
  }
  writeChartTrailStrip(points, strip);
  return strip;
}

/** Rewrite a strip's centres and neighbours in place for the same point count, so a data morph or a grow channel never reallocates. The caps repeat their end point; the end vertices take themselves as the missing neighbour. */
export function writeChartTrailStrip(
  points: readonly ChartTrailPoint[],
  strip: ChartTrailStrip,
): void {
  const n = points.length;
  if (n < 2 || chartTrailVertexCount(n) * 3 !== strip.position.length) return;
  for (let pair = 0; pair < n + 2; pair++) {
    const i = pair === 0 ? 0 : pair === n + 1 ? n - 1 : pair - 1;
    const here = points[i];
    const prev = points[i > 0 ? i - 1 : i];
    const next = points[i < n - 1 ? i + 1 : i];
    for (let v = pair * 2; v < pair * 2 + 2; v++) {
      strip.position.set(here, v * 3);
      strip.prev.set(prev, v * 3);
      strip.next.set(next, v * 3);
    }
  }
}

/** The head: one screen-aligned quad about its mesh's origin, whose side and cap corners make the profile radial. */
export function chartTrailHeadQuad(): ChartTrailStrip {
  return {
    position: new Float32Array(12),
    prev: new Float32Array(12),
    next: new Float32Array(12),
    side: new Float32Array([-1, 1, -1, 1]),
    cap: new Float32Array([-1, -1, 1, 1]),
    index: new Uint16Array([0, 1, 2, 1, 3, 2]),
  };
}

/** A strip's signature, so its buffers are rewritten only when a centre actually moves. */
export const chartTrailKey = (points: readonly ChartTrailPoint[]): string =>
  points.map((p) => `${p[0]},${p[1]},${p[2]}`).join("|");

/** The attributes a strip's rewrite dirties. */
export const CHART_TRAIL_MOVING = ["position", "aTrailPrev", "aTrailNext"] as const;

/** A strip's geometry over its own arrays: a rewrite marks them dirty and never copies. */
export function chartTrailGeometry(strip: ChartTrailStrip): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(strip.position, 3));
  geometry.setAttribute("aTrailPrev", new BufferAttribute(strip.prev, 3));
  geometry.setAttribute("aTrailNext", new BufferAttribute(strip.next, 3));
  geometry.setAttribute("aTrailSide", new BufferAttribute(strip.side, 1));
  geometry.setAttribute("aTrailCap", new BufferAttribute(strip.cap, 1));
  geometry.setIndex(new BufferAttribute(strip.index, 1));
  return geometry;
}

type Vec2 = readonly [number, number];

const direction = (from: Vec2, to: Vec2): Vec2 => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? [dx / len, dy / len] : [0, 0];
};

const isZero = (v: Vec2): boolean => v[0] === 0 && v[1] === 0;

/** One strip vertex's offset in isotropic screen units, the vertex shader's own maths mirrored so the joins are testable: across the averaged tangent (widened at a joint so each segment keeps its width, capped at a sharp one) and along it at a cap. A lone point, the head, takes the screen axes. */
export function chartTrailOffset(
  prev: Vec2,
  here: Vec2,
  next: Vec2,
  side: number,
  cap: number,
  reach: number,
): [number, number] {
  const inbound = direction(prev, here);
  const outbound = direction(here, next);
  let tangent: Vec2 = [inbound[0] + outbound[0], inbound[1] + outbound[1]];
  let miter = 1;
  if (tangent[0] * tangent[0] + tangent[1] * tangent[1] < 1e-8) {
    tangent = isZero(outbound) ? (isZero(inbound) ? [1, 0] : inbound) : outbound;
  } else {
    const len = Math.hypot(tangent[0], tangent[1]);
    tangent = [tangent[0] / len, tangent[1] / len];
    const edge = isZero(inbound) ? outbound : inbound;
    miter = 1 / Math.max(MITER_MIN, tangent[0] * edge[0] + tangent[1] * edge[1]);
  }
  const [tx, ty] = tangent;
  return [(-ty * side * miter + tx * cap) * reach, (tx * side * miter + ty * cap) * reach];
}

// ── The leading end ──────────────────────────────────────────────────────────

/** The runs a trail draws: the axis trim's own, plus a lone point (a single category) standing on its own so its head still shows. */
export function chartTrailRuns(points: readonly ChartLinePoint[]): [number, number][] {
  if (points.length === 1) return points[0].inside ? [[0, 1]] : [];
  return chartTrimRuns(points);
}

export interface ChartTrailLead {
  x: number;
  y: number;
  /** The point whose emphasis pulse the head carries. */
  index: number;
}

/** Where the leading end sits in plot space: on the draw-on edge while the series draws (the `draw` and `trace` build-ins draw it on from the left), on the last point once drawn. Null where that x falls in a gap the trim cut, so a head never floats over nothing. */
export function chartTrailLead(
  points: readonly ChartPoint[],
  runs: readonly (readonly [number, number])[],
  draw: number,
): ChartTrailLead | null {
  const n = points.length;
  if (n === 0) return null;
  const d = Number.isFinite(draw) ? clamp01(draw) : 1;
  const last = points[n - 1];
  const x = d >= 1 ? last.x : drawEdgeX(points, d);
  // Tested against the polyline's own span, so a rounding step can never drop the head at either end.
  const at = Math.min(Math.max(x, points[0].x), last.x);
  if (!runs.some(([from, to]) => at >= points[from].x && at <= points[to - 1].x)) return null;
  return { x, y: polylineYAt(points, x), index: Math.round(d * (n - 1)) };
}

// ── The material ─────────────────────────────────────────────────────────────

/** The profile in GLSL, from the same constants as `chartTrailProfile`. */
export const CHART_TRAIL_PROFILE_GLSL = /* glsl */ `
float chartTrailHalo(float d) {
  float edge = ${HALO_EDGE.toFixed(8)};
  return clamp((exp(-${HALO_FALLOFF.toFixed(4)} * d * d) - edge) / (1.0 - edge), 0.0, 1.0);
}
float chartTrailCore(float d, float width) {
  float k = d / max(width, 1e-4);
  return exp(-k * k);
}`;

/** The join maths in GLSL, mirroring `chartTrailOffset`. */
export const CHART_TRAIL_OFFSET_GLSL = /* glsl */ `
vec2 chartTrailDir(vec2 from, vec2 to) {
  vec2 d = to - from;
  float len = length(d);
  return len > 1e-6 ? d / len : vec2(0.0);
}
vec2 chartTrailOffset(vec2 prev, vec2 here, vec2 next, float side, float cap, float reach) {
  vec2 inbound = chartTrailDir(prev, here);
  vec2 outbound = chartTrailDir(here, next);
  vec2 tangent = inbound + outbound;
  float miter = 1.0;
  if (dot(tangent, tangent) < 1e-8) {
    tangent = dot(outbound, outbound) > 0.0 ? outbound : (dot(inbound, inbound) > 0.0 ? inbound : vec2(1.0, 0.0));
  } else {
    tangent = normalize(tangent);
    vec2 edge = dot(inbound, inbound) > 0.0 ? inbound : outbound;
    miter = 1.0 / max(${MITER_MIN.toFixed(4)}, dot(tangent, edge));
  }
  return (vec2(-tangent.y, tangent.x) * side * miter + tangent * cap) * reach;
}`;

const VERTEX = /* glsl */ `
uniform float uTrailReach;
uniform float uTrailPixels;
attribute vec3 aTrailPrev;
attribute vec3 aTrailNext;
attribute float aTrailSide;
attribute float aTrailCap;
varying vec2 vTrailUv;
varying float vTrailX;
${CHART_TRAIL_OFFSET_GLSL}
vec2 chartTrailScreen(vec4 clip, float aspect) {
  return vec2(clip.x * aspect, clip.y) / clip.w;
}
void main() {
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 clip = mvp * vec4(position, 1.0);
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  // Pixels hold a fixed fraction of the frame; chart units scale with the model and taper with depth.
  float reach = uTrailPixels > 0.0
    ? 2.0 * uTrailReach / uTrailPixels
    : uTrailReach * length(modelViewMatrix[0].xyz) * projectionMatrix[1][1] / clip.w;
  vec2 offset = chartTrailOffset(
    chartTrailScreen(mvp * vec4(aTrailPrev, 1.0), aspect),
    chartTrailScreen(clip, aspect),
    chartTrailScreen(mvp * vec4(aTrailNext, 1.0), aspect),
    aTrailSide,
    aTrailCap,
    reach
  );
  clip.xy += vec2(offset.x / aspect, offset.y) * clip.w;
  gl_Position = clip;
  vTrailUv = vec2(aTrailSide, aTrailCap);
  vTrailX = position.x;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uTrailHalo;
uniform vec3 uTrailCore;
uniform vec4 uTrailGain;
uniform vec3 uTrailClip;
uniform vec3 uTrailRamp;
uniform float uTrailAlpha;
varying vec2 vTrailUv;
varying float vTrailX;
${CHART_TRAIL_PROFILE_GLSL}
void main() {
  float d = length(vTrailUv);
  if (d >= 1.0) discard;
  float core = chartTrailCore(d, uTrailGain.z);
  float energy = uTrailGain.x * chartTrailHalo(d) + uTrailGain.y * core;
  float along = clamp((vTrailX - uTrailRamp.x) * uTrailRamp.y, 0.0, 1.0);
  float weight = uTrailAlpha * (uTrailRamp.z + (1.0 - uTrailRamp.z) * pow(along, ${RAMP_POWER.toFixed(4)}));
  if (uTrailClip.z > 0.5) {
    weight *= 1.0 - smoothstep(-uTrailClip.y, uTrailClip.y, vTrailX - uTrailClip.x);
  }
  vec3 colour = mix(uTrailHalo, uTrailCore, core);
  gl_FragColor = uTrailGain.w > 0.5
    ? vec4(colour, min(1.0, energy) * weight)
    : vec4(colour * (energy * weight), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface ChartTrailUniforms {
  /** Halo half width: export pixels when `pixels` is set, chart units otherwise. */
  reach: { value: number };
  /** The export frame's pixel height for a flat trail; 0 widens by chart units. */
  pixels: { value: number };
  halo: { value: Color };
  core: { value: Color };
  /** (halo gain, core gain, core width, ink). */
  gain: { value: Vector4 };
  /** (edge x, feather, enabled), local units. */
  clip: { value: Vector3 };
  /** (tail x, 1 / span, tail floor), local units. */
  ramp: { value: Vector3 };
  alpha: { value: number };
}

export interface ChartTrailMaterial {
  material: ShaderMaterial;
  uniforms: ChartTrailUniforms;
}

/** One trail material. Glow adds light (`One`, `One`) and leaves the destination alpha alone; ink blends straight alpha. A flat trail stays in the transparent list among the flat layers and skips tone mapping like them; a 3D one draws with the opaque marks (`CHART_TRAIL_RENDER_ORDER`) and tone maps like the lit finish. Neither writes depth. */
export function makeChartTrailMaterial(mode: ChartTrailMode, flat: boolean): ChartTrailMaterial {
  const uniforms: ChartTrailUniforms = {
    reach: { value: 0 },
    pixels: { value: 0 },
    halo: { value: new Color(1, 1, 1) },
    core: { value: new Color(1, 1, 1) },
    gain: { value: new Vector4(0, 0, CORE_WIDTH, 0) },
    clip: { value: new Vector3(0, 1, 0) },
    ramp: { value: new Vector3(0, 0, 1) },
    alpha: { value: 1 },
  };
  const material = new ShaderMaterial({
    uniforms: {
      uTrailReach: uniforms.reach,
      uTrailPixels: uniforms.pixels,
      uTrailHalo: uniforms.halo,
      uTrailCore: uniforms.core,
      uTrailGain: uniforms.gain,
      uTrailClip: uniforms.clip,
      uTrailRamp: uniforms.ramp,
      uTrailAlpha: uniforms.alpha,
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: flat,
    depthWrite: false,
    side: DoubleSide,
    blending: CustomBlending,
  });
  const ink = mode === "ink";
  material.blendSrc = ink ? SrcAlphaFactor : OneFactor;
  material.blendDst = ink ? OneMinusSrcAlphaFactor : OneFactor;
  material.blendSrcAlpha = ink ? OneFactor : ZeroFactor;
  material.blendDstAlpha = ink ? OneMinusSrcAlphaFactor : OneFactor;
  material.toneMapped = !flat;
  return { material, uniforms };
}

/** Everything a trail material reads, per frame. */
export interface ChartTrailState {
  tone: ChartTrailTone;
  reach: number;
  pixels: number;
  gains: readonly [number, number, number];
  /** Draw-on edge in local x, or null once drawn. */
  clipX: number | null;
  feather: number;
  ramp: readonly [number, number, number];
  alpha: number;
}

/** Plain uniform writes: a build-in never rebuilds a material. */
export function writeChartTrailUniforms(
  uniforms: ChartTrailUniforms,
  state: ChartTrailState,
): void {
  uniforms.reach.value = Math.max(0, state.reach);
  uniforms.pixels.value = Math.max(0, state.pixels);
  uniforms.halo.value.set(state.tone.halo);
  uniforms.core.value.set(state.tone.core);
  const [halo, core, width] = state.gains;
  uniforms.gain.value.set(halo, core, width, state.tone.mode === "ink" ? 1 : 0);
  uniforms.clip.value.set(
    state.clipX ?? 0,
    Math.max(1e-5, state.feather),
    state.clipX === null ? 0 : 1,
  );
  uniforms.ramp.value.set(state.ramp[0], state.ramp[1], state.ramp[2]);
  uniforms.alpha.value = clamp01(Number.isFinite(state.alpha) ? state.alpha : 0);
}
