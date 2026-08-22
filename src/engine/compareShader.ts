import { ACES_FORWARD_GLSL, ACES_INVERSE_GLSL } from "./acesCurve";

/** The comparison composite's mask shaders: side A (before) and side B (after) render to the transition machinery's A/B targets and blend under the mask here. Mask family: linear (a straight divider at any angle), circle (the after inside a growing window, the transition iris ramp), radial (the after sweeps around the centre, the transition radial ramp), blend (a held crossfade). Chrome is procedural SDF in the same pass: the divider line (linear + circle), the grip handle (linear, one of four styles dispatched on `gripStyle`, 0 being the legacy ring and chevrons), per-side tints. Same contracts as the transition shaders: a pure function of (uv, uniforms), every animated value CPU-computed; the SDR variant re-encodes hardware-decoded samples via sampleDisplay (the snaps-dim lesson), the HDR variant tone-maps both samples, composites in the display domain and inverts back (the self-inverting ACES pair, seam-exact within fp32). All divider maths is aspect-corrected so lines are straight ON SCREEN and widths are 1080-tall reference pixels. */

const UNIFORMS_GLSL = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float value;
  uniform float sweepRad;
  uniform float softness;
  uniform float aspect;
  uniform int maskType;        // 0 linear · 1 circle · 2 radial · 3 blend
  uniform vec2 center;
  uniform float lineWidth;     // height-fraction (reference px / 1080); 0 = off
  uniform vec3 lineColor;      // display sRGB
  uniform float lineSoftness;  // height-fraction
  uniform float gripSize;      // multiplier; 0 = off
  uniform int gripStyle;       // 0 chevrons · 1 dot · 2 bar · 3 arrows
  uniform vec3 tintA;          // display sRGB
  uniform vec3 tintB;
  uniform float tintAmountA;
  uniform float tintAmountB;

  float sdSeg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  // A filled arrowhead pointing along +x: base plane at x = 0, apex at (len, 0), half-height h.
  float sdHead(vec2 pt, float len, float h) {
    vec2 q = vec2(pt.x, abs(pt.y));
    vec2 n = normalize(vec2(h, len));
    return max(-q.x, dot(q - vec2(0.0, h), n));
  }
`;

const BODY_GLSL = /* glsl */ `
  void main() {
    vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
    float field = 0.0;
    float lineScale = 0.0;
    vec2 dir = vec2(1.0, 0.0);
    float hi = 0.5;
    if (maskType == 0) {
      dir = vec2(cos(sweepRad), sin(sweepRad));
      hi = max(0.5 * (aspect * abs(dir.x) + abs(dir.y)), 1e-5);
      field = clamp(0.5 + 0.5 * dot(p, dir) / hi, 0.0, 1.0);
      lineScale = 0.5 / hi;
    } else if (maskType != 3) {
      vec2 q = vec2((vUv.x - center.x) * aspect, vUv.y - center.y);
      if (maskType == 2) {
        field = atan(q.y, q.x) * 0.15915494 + 0.5;
      } else {
        vec2 corner = vec2(max(center.x, 1.0 - center.x) * aspect, max(center.y, 1.0 - center.y));
        float cl = max(length(corner), 1e-5);
        field = length(q) / cl;
        lineScale = 1.0 / cl;
      }
    }
    // 1 = side A (before): below the divider on linear masks, outside the window on circle/radial.
    float m;
    if (maskType == 3) {
      m = 1.0 - value;
    } else {
      float sgn = maskType == 0 ? field - value : value - field;
      m = softness > 0.0 ? 1.0 - smoothstep(-softness, softness, sgn) : 1.0 - step(0.0, sgn);
    }
    vec3 colA = mix(SAMPLE_A, tintA, tintAmountA);
    vec3 colB = mix(SAMPLE_B, tintB, tintAmountB);
    vec3 outC = mix(colB, colA, m);
    float chrome = 0.0;
    if (lineWidth > 0.0 && lineScale > 0.0 && maskType != 2) {
      float w = lineWidth * lineScale * 0.5;
      float e = max(lineSoftness * lineScale, w * 0.6);
      chrome = 1.0 - smoothstep(w, w + e, abs(field - value));
    }
    if (gripSize > 0.0 && maskType == 0) {
      vec2 g = dir * ((value * 2.0 - 1.0) * hi);
      vec2 l = vec2(dot(p - g, dir), dot(p - g, vec2(-dir.y, dir.x)));
      float R = 0.032 * gripSize;
      float w = max(lineWidth, 2.0) / 1080.0;
      if (gripStyle == 1) {
        float disc = 1.0 - smoothstep(R * 0.55, R * 0.55 + w, length(l));
        chrome = max(chrome, disc);
      } else if (gripStyle == 2) {
        float pill = sdSeg(l, vec2(0.0, -R * 0.62), vec2(0.0, R * 0.62)) - R * 0.26;
        chrome = max(chrome, 1.0 - smoothstep(0.0, w, pill));
      } else if (gripStyle == 3) {
        float heads = min(
          sdHead(l - vec2(R * 0.2, 0.0), R * 0.72, R * 0.44),
          sdHead(vec2(-l.x - R * 0.2, l.y), R * 0.72, R * 0.44));
        chrome = max(chrome, 1.0 - smoothstep(0.0, w, heads));
      } else {
        // Style 0, the legacy handle: these expressions are character-identical to the pre-style shader (the byte-identical null proof).
        float ring = 1.0 - smoothstep(w, w * 2.2, abs(length(l) - R));
        float chL = min(
          sdSeg(l, vec2(-R * 0.25, R * 0.3), vec2(-R * 0.55, 0.0)),
          sdSeg(l, vec2(-R * 0.25, -R * 0.3), vec2(-R * 0.55, 0.0)));
        float chR = min(
          sdSeg(l, vec2(R * 0.25, R * 0.3), vec2(R * 0.55, 0.0)),
          sdSeg(l, vec2(R * 0.25, -R * 0.3), vec2(R * 0.55, 0.0)));
        float chev = 1.0 - smoothstep(w * 0.9, w * 2.0, min(chL, chR));
        chrome = max(chrome, max(ring, chev));
      }
    }
    outC = mix(outC, lineColor, chrome);
    OUTPUT_LINE
  }
`;

export const compareFragmentShader = /* glsl */ `
  precision highp float;
${UNIFORMS_GLSL}
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 sampleDisplay(sampler2D t, vec2 uv) {
    return linearToSrgb(texture2D(t, clamp(uv, 0.0, 1.0)).rgb);
  }
${BODY_GLSL.replace("SAMPLE_A", "sampleDisplay(texA, vUv)")
  .replace("SAMPLE_B", "sampleDisplay(texB, vUv)")
  .replace("OUTPUT_LINE", "gl_FragColor = vec4(outC, 1.0);")}
`;

export const compareFragmentShaderHdr = /* glsl */ `
  precision highp float;
${UNIFORMS_GLSL}
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
${BODY_GLSL.replace("SAMPLE_A", "tm(sampleHdr(texA, vUv))")
  .replace("SAMPLE_B", "tm(sampleHdr(texB, vUv))")
  .replace("OUTPUT_LINE", "gl_FragColor = vec4(tmInv(outC), 1.0);")}
`;
