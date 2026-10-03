import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from "three";
import { glslFloat, smoothstep } from "../../kit";

/** Seigaiha tide geometry and motion constants, shared by the shaders and their CPU mirrors. */
export const TIDE = {
  floorY: -2,
  floorRadius: 130,
  floorRings: 120,
  floorSegments: 240,
  /** Radial spacing widens outward (r ~ i^power), so the swell zone holds the vertex density. */
  floorPower: 1.6,
  skyRadius: 160,
  /** The three swells close exactly on this loop (5, 4 and 3 cycles). */
  loop: 60,
  /** The top sky band rises and falls `drift` degrees over `driftPeriod` seconds. */
  drift: 2,
  driftPeriod: 20,
  /** Fan orbit in lattice units per unit of swell height (0.45 gives the sketch's 0.16). */
  orbit: 0.36,
} as const;

/** Travelling swells: unit direction, wavelength (world units), whole cycles per loop, phase and weight (weights sum to 1). */
export const TIDE_SWELLS = [
  { dir: unit(0.3, 1), wavelength: 17, cycles: 5, phase: 0, weight: 0.5 },
  { dir: unit(-0.8, 0.6), wavelength: 23, cycles: 4, phase: 1.3, weight: 0.3 },
  { dir: unit(0.9, 0.25), wavelength: 13, cycles: 3, phase: 4.1, weight: 0.2 },
] as const;

function unit(x: number, z: number): readonly [number, number] {
  const l = Math.hypot(x, z);
  return [x / l, z / l];
}

const TAU = Math.PI * 2;

/** The raw unit wave (same strength everywhere) and its quadrature: fans orbit on (quad, h) and rings ripple on h, so near and far fans move alike. */
export function tideWave(x: number, z: number, t: number): { h: number; quad: number } {
  let h = 0;
  let quad = 0;
  for (const s of TIDE_SWELLS) {
    const p =
      (TAU / s.wavelength) * (s.dir[0] * x + s.dir[1] * z) -
      ((TAU * s.cycles) / TIDE.loop) * t +
      s.phase;
    h += s.weight * Math.sin(p);
    quad += s.weight * Math.cos(p);
  }
  return { h, quad };
}

/** Swell amplitude envelope: low but present near the clearing, full beyond radius 20, gone toward the far fade. */
export function tideEnvelope(r: number, amplitude: number, clear: number): number {
  return (
    amplitude *
    (0.3 + 0.7 * smoothstep(8, 20, r)) *
    smoothstep(clear - 1, clear + 2, r) *
    (1 - smoothstep(70, 110, r))
  );
}

/** How far a frame of `aspect` counts as portrait: 0 at 1.2 and wider, 1 at 0.6 and narrower. */
export function tidePortrait(aspect: number): number {
  return 1 - smoothstep(0.6, 1.2, aspect);
}

/** Printed sky band edges in degrees of elevation from the camera, lifted with a portrait headline. */
export function tideBands(aspect: number): [number, number, number] {
  const k = tidePortrait(aspect);
  return [11 + 6.5 * k, 16.5 + 5 * k, 23 + 4 * k];
}

/** Flat polar grid in xz: a centre vertex, then `rings` rings of `segments` at radius `radius * (i / rings) ^ power`. */
export function polarGridGeometry(
  radius: number,
  rings: number,
  segments: number,
  power: number,
): BufferGeometry {
  const pos = new Float32Array((1 + rings * segments) * 3);
  for (let i = 1; i <= rings; i++) {
    const r = radius * (i / rings) ** power;
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * TAU;
      const o = (1 + (i - 1) * segments + j) * 3;
      pos[o] = Math.cos(a) * r;
      pos[o + 2] = Math.sin(a) * r;
    }
  }
  const idx = new Uint32Array(segments * 3 + (rings - 1) * segments * 6);
  let k = 0;
  for (let j = 0; j < segments; j++) {
    idx.set([0, 1 + ((j + 1) % segments), 1 + j], k);
    k += 3;
  }
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segments;
    const b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx.set([a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j], k);
      k += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

/** GLSL for the swell (both stages): `tsSwell(xz, quad)` returns the enveloped height, its xz gradient and the raw wave. */
export const TIDE_GLSL_SWELL: string = /* glsl */ `
uniform float uTime;
uniform float uSwell;
uniform float uClear;
float tsEnvelope(float r) {
  return uSwell * (0.3 + 0.7 * smoothstep(8.0, 20.0, r)) * smoothstep(uClear - 1.0, uClear + 2.0, r)
    * (1.0 - smoothstep(70.0, 110.0, r));
}
vec4 tsSwell(vec2 xz, out float quad) {
  float h = 0.0;
  vec2 g = vec2(0.0);
  quad = 0.0;
${TIDE_SWELLS.map((s, i) => {
  const k = glslFloat(TAU / s.wavelength);
  const w = glslFloat((TAU * s.cycles) / TIDE.loop);
  const d = `vec2(${glslFloat(s.dir[0])}, ${glslFloat(s.dir[1])})`;
  return `  float p${i} = ${k} * dot(${d}, xz) - ${w} * uTime + ${glslFloat(s.phase)};
  h += ${glslFloat(s.weight)} * sin(p${i});
  quad += ${glslFloat(s.weight)} * cos(p${i});
  g += ${glslFloat(s.weight)} * ${k} * cos(p${i}) * ${d};`;
}).join("\n")}
  float r = length(xz);
  float e = tsEnvelope(r);
  float de = (tsEnvelope(r + 0.05) - tsEnvelope(r - 0.05)) * 10.0;
  vec2 rd = r > 1e-3 ? xz / r : vec2(0.0);
  return vec4(h * e, g * e + rd * de * h, h);
}
`;
