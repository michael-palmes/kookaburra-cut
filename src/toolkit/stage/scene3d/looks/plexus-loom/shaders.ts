import { glslFloat } from "../../kit";

/** Loom geometry shared by the component and its shaders. */
export const LOOM = {
  lowY: -7,
  highY: 8,
  maxBundles: 48,
  threadsPerBundle: 3,
  /** Points per thread: straight threads only need enough segments to clip at the near plane. */
  points: 15,
  /** Angle between the threads of one bundle, radians. */
  spread: 0.0105,
  /** Full thread width: world units, then the reference-px floor and the coverage minimum. */
  width: { world: 0.036, px: 1.1, min: 1.5 },
  hoopTube: 0.08,
  spinPeriod: 360,
  breathPeriod: 40,
} as const;

/** F11 near fade window (fractions of the camera-to-stage distance): threads between the camera and the stage vanish on a dolly out. */
export const LOOM_FADE = { near: 0.72, far: 1.0 } as const;

const FADE = `${glslFloat(LOOM_FADE.near)}, ${glslFloat(LOOM_FADE.far)}`;

const LOOM_UNIFORMS = /* glsl */ `
uniform float uSpin;
uniform float uBreath;
uniform float uTwist;
uniform float uRadius;
uniform float uBundles;
uniform float uHueTurn;
varying float vHue;
varying float vWeight;
`;

// Strand data inkStrand = (bundle, family sign, thread in bundle, 0); the path param p.x runs 0 at the low hoop to 1 at the high hoop.
export const THREAD_PATH = /* glsl */ `
${LOOM_UNIFORMS}
const float TAU = 6.28318530718;
vec3 inkPath(vec4 p) {
  float a0 = (inkStrand.x + (inkStrand.y > 0.0 ? 0.0 : 0.5)) / uBundles * TAU
    + (inkStrand.z - 1.0) * ${glslFloat(LOOM.spread)} + uSpin;
  float a1 = a0 + inkStrand.y * uTwist + uBreath;
  vec3 lo = vec3(cos(a0) * uRadius, ${glslFloat(LOOM.lowY)}, sin(a0) * uRadius);
  vec3 hi = vec3(cos(a1) * uRadius, ${glslFloat(LOOM.highY)}, sin(a1) * uRadius);
  return mix(lo, hi, p.x);
}
`;

export const THREAD_VERTEX_HOOK = /* glsl */ `
void inkVertex(vec4 p, vec3 world) {
  vHue = fract(inkStrand.x / uBundles + (inkStrand.y > 0.0 ? 0.0 : 0.5) + uHueTurn);
  vWeight = inkStrand.z == 1.0 ? 1.13 : 0.84;
}
`;

export const THREAD_FRAGMENT = /* glsl */ `
uniform vec3 uThreadA;
uniform vec3 uThreadB;
uniform vec3 uThreadC;
uniform float uOpacity;
uniform float uCalm;
varying float vHue;
varying float vWeight;
void main() {
  float h = vHue * 3.0;
  vec3 col = h < 1.0
    ? mix(uThreadA, uThreadB, smoothstep(0.0, 1.0, h))
    : h < 2.0
      ? mix(uThreadB, uThreadC, smoothstep(1.0, 2.0, h))
      : mix(uThreadC, uThreadA, smoothstep(2.0, 3.0, h));
  float ends = smoothstep(0.0, 0.06, vInkAlong) * (1.0 - smoothstep(0.94, 1.0, vInkAlong));
  float a = inkCoverage() * uOpacity * vWeight * ends * stageFade(vWorld, ${FADE});
  a *= 1.0 - calmWeight(vWorld, uCalm);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

export const HOOP_FRAGMENT = /* glsl */ `
uniform vec3 uGlow;
uniform float uCalm;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  float facing = abs(dot(normalize(vNormalW), normalize(cameraPosition - vWorld)));
  float a = stageFade(vWorld, ${FADE}) * (1.0 - calmWeight(vWorld, uCalm));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uGlow * mix(0.72, 1.0, facing), a);
  #include <colorspace_fragment>
}
`;
