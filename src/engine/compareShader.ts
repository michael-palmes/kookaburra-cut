import { ACES_FORWARD_GLSL, ACES_INVERSE_GLSL } from "./acesCurve";

/** The comparison composite's mask shaders: side A (before) and side B (after) render to the transition machinery's A/B targets and blend under a linear divider here. Same contracts as the transition shaders: a pure function of (uv, uniforms), the divider value/angle CPU-computed and never time-derived in GLSL; the SDR variant re-encodes hardware-decoded samples via sampleDisplay (the snaps-dim lesson), the HDR variant passes raw linear through a selection mask (a feathered edge blends through the ACES round trip like the extended transitions). The divider maths is aspect-corrected so an angled line is straight ON SCREEN: uv recentres to +-0.5, x scales by aspect, and the value normalises over the mask direction's full span so 0..1 always sweeps edge to edge at any angle. */

/** The divider mask, shared by both variants: 1 = side A (before), 0 = side B (after). */
const MASK_GLSL = /* glsl */ `
  float compareMask(vec2 uv) {
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
    vec2 dir = vec2(cos(sweepRad), sin(sweepRad));
    float hi = 0.5 * (aspect * abs(dir.x) + abs(dir.y));
    float sp = clamp(0.5 + 0.5 * dot(p, dir) / max(hi, 1e-5), 0.0, 1.0);
    return softness > 0.0
      ? 1.0 - smoothstep(value - softness, value + softness, sp)
      : 1.0 - step(value, sp);
  }
`;

export const compareFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float value;
  uniform float sweepRad;
  uniform float softness;
  uniform float aspect;

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 sampleDisplay(sampler2D t, vec2 uv) {
    return linearToSrgb(texture2D(t, clamp(uv, 0.0, 1.0)).rgb);
  }

  ${MASK_GLSL}

  void main() {
    float m = compareMask(vUv);
    vec3 outSrgb = mix(sampleDisplay(texB, vUv), sampleDisplay(texA, vUv), m);
    gl_FragColor = vec4(outSrgb, 1.0);
  }
`;

export const compareFragmentShaderHdr = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float value;
  uniform float sweepRad;
  uniform float softness;
  uniform float aspect;

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  ${ACES_FORWARD_GLSL}
  ${ACES_INVERSE_GLSL}

  vec3 sampleHdr(sampler2D t, vec2 uv) {
    return texture2D(t, clamp(uv, 0.0, 1.0)).rgb;
  }
  vec3 tm(vec3 x) { return linearToSrgb(acesForward(x)); }
  vec3 tmInv(vec3 e) { return acesInverse(srgbToLinear(clamp(e, 0.0, 0.999))); }

  ${MASK_GLSL}

  void main() {
    float m = compareMask(vUv);
    vec3 outLinear;
    if (m <= 0.0) {
      outLinear = sampleHdr(texB, vUv);
    } else if (m >= 1.0) {
      outLinear = sampleHdr(texA, vUv);
    } else {
      // The feathered edge blends perceptually through the tone map, the HDR transition rule.
      outLinear = tmInv(mix(tm(sampleHdr(texB, vUv)), tm(sampleHdr(texA, vUv)), m));
    }
    gl_FragColor = vec4(outLinear, 1.0);
  }
`;
