/** The compositor's transition shaders and type registry, extracted from engine/compositor.ts so the transition picker's live preview can drive the real shaders on its own small canvas. The legacy pair (types 0-3, GLSL1) is moved verbatim, byte-identical to the gated compositor so its baselines cannot move; the extended pack (types 4-9, GLSL3, `#version 300 es` for integer hashing) lives in separate materials selected by `TYPE_ID >= EXTENDED_MIN_TYPE`, so adding a type never recompiles the legacy programs. Every shader is a pure function of (uv, uniforms): progress/direction/params are CPU-computed uniforms, never time-derived in GLSL. The extended pack's only pseudo-randomness (glitch) is an integer PCG-style hash on uints, exact across compiles unlike fract(sin()) whose sin precision is driver-defined; tap counts and spiral constants are fixed literals, part of the export contract. */

import { ACES_FORWARD_GLSL, ACES_INVERSE_GLSL } from "./acesCurve";
import type { TransitionShape, TransitionType } from "./sceneTimeline";

export const TYPE_ID: Record<TransitionType, number> = {
  crossfade: 0,
  dip: 1,
  slide: 2,
  wipe: 3,
  blur: 4,
  push: 5,
  zoom: 6,
  whip: 7,
  luma: 8,
  glitch: 9,
  slice: 10,
  dissolve: 11,
  warp: 12,
  inkbleed: 13,
  flowmorph: 14,
  shockwave: 15,
  glasssweep: 16,
  rackfocus: 17,
  halftone: 18,
  lightsweep: 19,
  shatter: 20,
  pixelstretch: 21,
  chromasplit: 22,
  datamosh: 23,
  prism: 24,
  spinblur: 25,
};

/** Types >= this id render through the extended (GLSL3) materials. */
export const EXTENDED_MIN_TYPE = 4;

/** Types >= this id render through the v14 (third-generation GLSL3) materials, keeping the earlier programs source-identical. */
export const EXT2_MIN_TYPE = 10;

/** Types >= this id render through the v15 (fourth-generation GLSL3) materials, keeping the earlier programs source-identical. */
export const EXT3_MIN_TYPE = 13;

/** Procedural ramp/aperture shapes: linear/radial/iris are the luma ramps; hex is the rack-focus aperture (ext3 reuses the shared `shape` uniform with per-type meanings). */
export const SHAPE_ID: Record<TransitionShape, number> = { linear: 0, radial: 1, iris: 2, hex: 3 };

export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Fullscreen pass: map the 2x2 plane straight to clip space (ignore the camera).
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Crossfade/dip mix in the display (encoded sRGB) domain since a dissolve is a perceptual effect and linear-light mixing back-loads the apparent fade (slide/wipe move or mask whole pixels, no cross-blending); the no-fx A/B targets are hardware SRGB8_ALPHA8, so texture2D() returns hardware-decoded linear and sampleDisplay must re-encode it to recover the exact stored bytes, fixing the "snaps dim / snaps back" bug where a double-decode desynced the composite from the neighbouring solo frame (launch-2026 frame 263→264, 2026-07-07). progress/direction are supplied as uniforms, never derived from time in GLSL.
export const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float progress;
  uniform int type;
  uniform vec2 direction;
  uniform vec3 dipColor; // linear

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  // Hardware-decoded linear sample, re-encoded to the display domain (== stored bytes).
  vec3 sampleDisplay(sampler2D t, vec2 uv) {
    return linearToSrgb(texture2D(t, clamp(uv, 0.0, 1.0)).rgb);
  }

  void main() {
    vec3 outSrgb;
    if (type == 0) {                 // crossfade, perceptual (display-domain) blend
      outSrgb = mix(sampleDisplay(texA, vUv), sampleDisplay(texB, vUv), progress);
    } else if (type == 1) {          // dip to colour, perceptual blend toward the dip
      vec3 dipSrgb = linearToSrgb(dipColor);
      float h = progress * 2.0;
      outSrgb = progress < 0.5
        ? mix(sampleDisplay(texA, vUv), dipSrgb, h)
        : mix(dipSrgb, sampleDisplay(texB, vUv), h - 1.0);
    } else if (type == 2) {          // slide / push (B enters along +direction)
      float s = dot(vUv, direction);
      outSrgb = s < 1.0 - progress
        ? sampleDisplay(texA, vUv + progress * direction)
        : sampleDisplay(texB, vUv - (1.0 - progress) * direction);
    } else {                         // wipe (hard reveal of B along +direction)
      float s = dot(vUv, direction);
      float m = step(s, progress);
      outSrgb = mix(sampleDisplay(texA, vUv), sampleDisplay(texB, vUv), m);
    }
    gl_FragColor = vec4(outSrgb, 1.0);
  }
`;

// Effects (HDR) variant: the fx-path A/B targets are HalfFloat/LINEAR and hold the un-tone-mapped scene (the composer still owns the project's single ACES afterwards), fixing the pre-v10 8-bit fx targets that clamped everything above 1.0 linear before that ACES (the highlight half of the transition dim). Mixing raw HDR would back-load the fade, so the perceptual mix goes through the tone map: tm(x) = encode(aces(x)), mix there, invert back to linear HDR for the composer; the forward/inverse pair (engine/acesCurve.ts, three's exact constants) is self-inverting, so at progress 0/1 the composite equals the solo frames' composer input within fp32, seam-exact by construction. The encoded mix clamps to <= 0.999 before inversion (the fit saturates; blown-out pixels flatten and land back at white after the composer re-tone-maps, sub-LSB), and the fit's black toe likewise clamps sub-~0.002-linear values, which re-tone-map back to black. Slide/wipe select rather than mix, passing raw linear HDR straight through untouched.
export const fragmentShaderHdr = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float progress;
  uniform int type;
  uniform vec2 direction;
  uniform vec3 dipColor; // linear

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

  void main() {
    vec3 outLinear;
    if (type == 0) {                 // crossfade, display-domain blend, HDR-reconstructed
      outLinear = tmInv(mix(tm(sampleHdr(texA, vUv)), tm(sampleHdr(texB, vUv)), progress));
    } else if (type == 1) {          // dip, toward the authored display colour
      vec3 dipSrgb = linearToSrgb(dipColor);
      float h = progress * 2.0;
      outLinear = tmInv(progress < 0.5
        ? mix(tm(sampleHdr(texA, vUv)), dipSrgb, h)
        : mix(dipSrgb, tm(sampleHdr(texB, vUv)), h - 1.0));
    } else if (type == 2) {          // slide / push, selection, raw linear HDR
      float s = dot(vUv, direction);
      outLinear = s < 1.0 - progress
        ? sampleHdr(texA, vUv + progress * direction)
        : sampleHdr(texB, vUv - (1.0 - progress) * direction);
    } else {                         // wipe, selection, raw linear HDR
      float s = dot(vUv, direction);
      outLinear = mix(sampleHdr(texA, vUv), sampleHdr(texB, vUv), step(s, progress));
    }
    gl_FragColor = vec4(outLinear, 1.0);
  }
`;

/** GLSL3 vertex pass for the extended materials (three declares position/uv in its prefix). */
export const vertexShader300 = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    // Fullscreen pass: map the 2x2 plane straight to clip space (ignore the camera).
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// The extended pack's shared GLSL bodies: all motion/randomness derives from (uv, progress, params), and `bell = 4p(1-p)` gates every distortion to 0 at both seams so the first/last transition frames equal a plain crossfade's (identity on A/B). The 8 blur directions are exact literals (no transcendentals feeding offsets beyond luma's atan, which is same-machine-deterministic like every other GPU float op here).
const extCommon = /* glsl */ `
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform float progress;
  uniform int type;        // 4 blur · 5 push · 6 zoom · 7 whip · 8 luma · 9 glitch
  uniform vec2 direction;
  uniform vec3 dipColor;   // unused by the pack; kept so the shared uniform set applies
  uniform float aspect;    // drawing-buffer w/h (screen-circular blur, luma geometry)
  uniform float intensity;
  uniform float softness;
  uniform vec2 center;
  uniform vec2 blocks;
  uniform int shape;       // 0 linear · 1 radial · 2 iris
  uniform float steps;
  uniform float parallax;

  const vec2 DIRS[8] = vec2[8](
    vec2(1.0, 0.0), vec2(0.70710678, 0.70710678), vec2(0.0, 1.0),
    vec2(-0.70710678, 0.70710678), vec2(-1.0, 0.0), vec2(-0.70710678, -0.70710678),
    vec2(0.0, -1.0), vec2(0.70710678, -0.70710678));

  // Coordinate along the travel axis, 0 at the edge the incoming scene enters from; robust for all four unit axes (the legacy slide/wipe dot() only handles +axes).
  float axisCoord(vec2 uv, vec2 d) {
    return dot(uv, max(d, vec2(0.0))) + dot(vec2(1.0) - uv, max(-d, vec2(0.0)));
  }

  // PCG-style integer hash, exact across compiles (never fract(sin), whose precision is driver-defined); feeds glitch block displacement/selection.
  float hash01(uvec3 v) {
    uint h = v.x * 374761393u ^ v.y * 668265263u ^ v.z * 2246822519u;
    h ^= h >> 13;
    h *= 1274126177u;
    h ^= h >> 16;
    return float(h & 0x00FFFFFFu) / 16777216.0;
  }
`;

// Per-type composition over a display-domain sampler S(t, uv); `SEL_RAW(t, uv)` is the pure-selection sample (raw target values, identical to S on the SDR variant, raw linear HDR on the fx variant so selections stay exact there).
const extBody = /* glsl */ `
  float bell = 4.0 * progress * (1.0 - progress);

  if (type == 4) {                   // blur dissolve, display-domain spiral blur + mix
    float radius = intensity * bell;
    vec3 accA = S(texA, vUv);
    vec3 accB = S(texB, vUv);
    for (int k = 0; k < 8; k++) {
      vec2 d = vec2(DIRS[k].x / aspect, DIRS[k].y) * radius;
      accA += S(texA, vUv + d * 0.3333) + S(texA, vUv + d * 0.6667) + S(texA, vUv + d);
      accB += S(texB, vUv + d * 0.3333) + S(texB, vUv + d * 0.6667) + S(texB, vUv + d);
    }
    outDisplay = mix(accA / 25.0, accB / 25.0, progress);
  } else if (type == 5) {            // parallax push, pure selection, no mixing
    float r = axisCoord(vUv, direction);
    if (r < 1.0 - progress) {
      outSelect = SEL_RAW(texA, vUv + progress * parallax * direction);
    } else {
      outSelect = SEL_RAW(texB, vUv - (1.0 - progress) * direction);
    }
    isSelect = true;
  } else if (type == 6) {            // zoom dissolve, counter-zoomed display-domain mix
    vec2 uvA = (vUv - center) / (1.0 + intensity * progress) + center;
    vec2 uvB = (vUv - center) / (1.0 + intensity * (1.0 - progress)) + center;
    outDisplay = mix(S(texA, uvA), S(texB, uvB), progress);
  } else if (type == 7) {            // whip pan, full-travel push under directional blur
    float spread = intensity * bell;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float tt = float(i) / 15.0 - 0.5;
      vec2 uv = vUv + vec2(direction.x / aspect, direction.y) * (tt * spread);
      float r = axisCoord(uv, direction);
      acc += (r < 1.0 - progress)
        ? S(texA, uv + progress * direction)
        : S(texB, uv - (1.0 - progress) * direction);
    }
    outDisplay = acc / 16.0;
  } else if (type == 8) {            // luma wipe, procedural ramp, soft edge mixes
    float r;
    if (shape == 0) {
      r = axisCoord(vUv, direction);
    } else {
      vec2 q = vec2((vUv.x - center.x) * aspect, vUv.y - center.y);
      if (shape == 1) {
        r = atan(q.y, q.x) * 0.15915494 + 0.5;   // radial sweep
      } else {
        vec2 corner = vec2(max(center.x, 1.0 - center.x) * aspect, max(center.y, 1.0 - center.y));
        r = length(q) / length(corner);           // iris, normalized to the far corner
      }
    }
    float pp = mix(-softness, 1.0 + softness, progress);
    float m = 1.0 - smoothstep(pp - softness, pp + softness, r);
    if (m <= 0.0) {
      outSelect = SEL_RAW(texA, vUv);
      isSelect = true;
    } else if (m >= 1.0) {
      outSelect = SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      outDisplay = mix(S(texA, vUv), S(texB, vUv), m);
    }
  } else {                           // glitch, hashed block displacement + RGB split
    float qp = floor(progress * steps);
    uvec2 blk = uvec2(floor(vUv * blocks));
    float h = hash01(uvec3(blk, uint(qp)));
    float disp = (h - 0.5) * 0.2 * intensity * bell;
    vec2 uv = vUv + vec2(disp, 0.0);
    float split = 0.006 * intensity * bell * (h > 0.5 ? 1.0 : -1.0);
    vec2 so = vec2(split / aspect, 0.0);
    bool useB = h < smoothstep(0.0, 0.85, progress);  // every block lands on B by p=0.85
    if (useB) {
      outDisplay = vec3(S(texB, uv + so).r, S(texB, uv).g, S(texB, uv - so).b);
    } else {
      outDisplay = vec3(S(texA, uv + so).r, S(texA, uv).g, S(texA, uv - so).b);
    }
  }
`;

/** Extended SDR composite (GLSL3): display-domain throughout, samples are hardware-decoded linear from the sRGB targets, re-encoded per tap (matching the legacy shader's semantics), output encoded straight to the canvas. Selections and mixes share the same S(). */
export const fragmentShaderExt = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb);
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) { return S(t, uv); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${extBody}
    fragColor = vec4(isSelect ? outSelect : outDisplay, 1.0);
  }
`;

// The v14 pack (types 10-12): its own body so the earlier generations stay source-identical. Every distortion gates on `bell = 4p(1-p)` (identity at both seams) and slice/dissolve reach pure A/B selection at progress 0/1, so the first/last transition frames equal the solo neighbours exactly. Randomness is the shared PCG hash; the value-noise lattice interpolation uses fixed smoothstep weights.
const ext2Body = /* glsl */ `
  float bell = 4.0 * progress * (1.0 - progress);

  if (type == 10) {                  // slice: hash-staggered strips slide out along +direction
    float count = max(blocks.x, 2.0);
    float across = abs(direction.x) > 0.5 ? vUv.y : vUv.x;
    float idx = floor(across * count);
    float st = intensity;            // stagger fraction of the travel
    float h = hash01(uvec3(uint(idx), 191u, 73u));
    float lp = clamp(progress * (1.0 + st) - h * st, 0.0, 1.0);
    vec2 uvA = vUv - lp * direction;
    if (any(lessThan(uvA, vec2(0.0))) || any(greaterThan(uvA, vec2(1.0)))) {
      outSelect = SEL_RAW(texB, vUv);
    } else {
      outSelect = SEL_RAW(texA, uvA);
    }
    isSelect = true;
  } else if (type == 11) {           // dissolve: organic value-noise threshold, soft edge
    float scale = mix(4.0, 16.0, intensity);
    vec2 p = vec2(vUv.x * aspect, vUv.y) * scale;
    vec2 i0 = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float n00 = hash01(uvec3(uvec2(i0), 11u));
    float n10 = hash01(uvec3(uvec2(i0 + vec2(1.0, 0.0)), 11u));
    float n01 = hash01(uvec3(uvec2(i0 + vec2(0.0, 1.0)), 11u));
    float n11 = hash01(uvec3(uvec2(i0 + vec2(1.0, 1.0)), 11u));
    float n = mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
    vec2 p2 = p * 2.7;
    vec2 j0 = floor(p2);
    vec2 g = fract(p2);
    vec2 v = g * g * (3.0 - 2.0 * g);
    float m00 = hash01(uvec3(uvec2(j0), 29u));
    float m10 = hash01(uvec3(uvec2(j0 + vec2(1.0, 0.0)), 29u));
    float m01 = hash01(uvec3(uvec2(j0 + vec2(0.0, 1.0)), 29u));
    float m11 = hash01(uvec3(uvec2(j0 + vec2(1.0, 1.0)), 29u));
    n = n * 0.7 + mix(mix(m00, m10, v.x), mix(m01, m11, v.x), v.y) * 0.3;
    // Interpolated value noise clusters around 0.5; stretching it spreads the threshold sweep so the front advances instead of the whole frame blending at once.
    n = clamp((n - 0.5) * 1.8 + 0.5, 0.0, 1.0);
    float pp = mix(-softness, 1.0 + softness, progress);
    float m = 1.0 - smoothstep(pp - softness, pp + softness, n);
    if (m <= 0.0) {
      outSelect = SEL_RAW(texA, vUv);
      isSelect = true;
    } else if (m >= 1.0) {
      outSelect = SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      outDisplay = mix(S(texA, vUv), S(texB, vUv), m);
    }
  } else {                           // warp: lens pull toward centre, restrained RGB split at mid
    vec2 q = vUv - center;
    float w = intensity * bell;
    float sA = 1.0 + w * 0.6;        // A lenses away
    float sB = 1.0 - w * 0.4;        // B settles in
    float split = 0.012 * w;
    vec3 a = vec3(
      S(texA, center + q * (sA - split)).r,
      S(texA, center + q * sA).g,
      S(texA, center + q * (sA + split)).b);
    vec3 b = vec3(
      S(texB, center + q * (sB - split)).r,
      S(texB, center + q * sB).g,
      S(texB, center + q * (sB + split)).b);
    outDisplay = mix(a, b, progress);
  }
`;

/** v14 SDR composite (GLSL3): same display-domain semantics as the extended pack, its own program. */
export const fragmentShaderExt2 = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb);
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) { return S(t, uv); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${ext2Body}
    fragColor = vec4(isSelect ? outSelect : outDisplay, 1.0);
  }
`;

/** v14 HDR composite (GLSL3, fx path): the extended pack's ACES round-trip semantics, its own program; selections pass raw linear HDR untouched. */
export const fragmentShaderExt2Hdr = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  ${ACES_FORWARD_GLSL}
  ${ACES_INVERSE_GLSL}

  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(acesForward(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb));
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) {
    return texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  }
  vec3 tmInv(vec3 e) { return acesInverse(srgbToLinear(clamp(e, 0.0, 0.999))); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${ext2Body}
    fragColor = vec4(isSelect ? outSelect : tmInv(outDisplay), 1.0);
  }
`;

/** Extended HDR composite (GLSL3, fx path): the display-domain-through-ACES blend, S() tone-maps each tap to the display domain, mixed results invert back to linear HDR for the composer (single tmInv at the end), and pure selections pass raw linear HDR through untouched (exact seams, no inversion error). */
export const fragmentShaderExtHdr = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  ${ACES_FORWARD_GLSL}
  ${ACES_INVERSE_GLSL}

  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(acesForward(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb));
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) {
    return texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  }
  vec3 tmInv(vec3 e) { return acesInverse(srgbToLinear(clamp(e, 0.0, 0.999))); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${extBody}
    fragColor = vec4(isSelect ? outSelect : tmInv(outDisplay), 1.0);
  }
`;

// The v15 pack's helpers (ext3 sources only, so the earlier programs stay byte-identical): a value-noise lattice on the shared PCG hash with its analytic gradient (curl fields without finite differences), a 2D rotation, Rec.709 luminance, and the two fixed 19-tap aperture kernels (centre + ring of 6 + ring of 12; tap positions are export contract).
const ext3Common = /* glsl */ `
  vec3 vnoised(vec2 p, uint seed) {
    vec2 i0 = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float n00 = hash01(uvec3(uvec2(i0 + 64.0), seed));
    float n10 = hash01(uvec3(uvec2(i0 + vec2(65.0, 64.0)), seed));
    float n01 = hash01(uvec3(uvec2(i0 + vec2(64.0, 65.0)), seed));
    float n11 = hash01(uvec3(uvec2(i0 + 65.0), seed));
    float nx0 = mix(n00, n10, u.x);
    float nx1 = mix(n01, n11, u.x);
    float n = mix(nx0, nx1, u.y);
    float dx = mix(n10 - n00, n11 - n01, u.y) * du.x;
    float dy = (nx1 - nx0) * du.y;
    return vec3(n, dx, dy);
  }
  float vnoise(vec2 p, uint seed) { return vnoised(p, seed).x; }
  float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  vec2 rot2(vec2 q, float c, float s) { return vec2(q.x * c - q.y * s, q.x * s + q.y * c); }

  const vec2 DISC19[19] = vec2[19](
    vec2(0.0, 0.0),
    vec2(0.5, 0.0), vec2(0.25, 0.4330127), vec2(-0.25, 0.4330127),
    vec2(-0.5, 0.0), vec2(-0.25, -0.4330127), vec2(0.25, -0.4330127),
    vec2(0.9659258, 0.2588190), vec2(0.7071068, 0.7071068), vec2(0.2588190, 0.9659258),
    vec2(-0.2588190, 0.9659258), vec2(-0.7071068, 0.7071068), vec2(-0.9659258, 0.2588190),
    vec2(-0.9659258, -0.2588190), vec2(-0.7071068, -0.7071068), vec2(-0.2588190, -0.9659258),
    vec2(0.2588190, -0.9659258), vec2(0.7071068, -0.7071068), vec2(0.9659258, -0.2588190));

  const vec2 HEX19[19] = vec2[19](
    vec2(0.0, 0.0),
    vec2(0.5, 0.0), vec2(0.25, 0.4330127), vec2(-0.25, 0.4330127),
    vec2(-0.5, 0.0), vec2(-0.25, -0.4330127), vec2(0.25, -0.4330127),
    vec2(1.0, 0.0), vec2(0.5, 0.8660254), vec2(-0.5, 0.8660254),
    vec2(-1.0, 0.0), vec2(-0.5, -0.8660254), vec2(0.5, -0.8660254),
    vec2(0.75, 0.4330127), vec2(0.0, 0.8660254), vec2(-0.75, 0.4330127),
    vec2(-0.75, -0.4330127), vec2(0.0, -0.8660254), vec2(0.75, -0.4330127));
`;

// The v15 pack (types 13-25): its own body so the earlier generations stay source-identical. Beyond the bell convention (every distortion amplitude is gated by bell or proportional to p / 1-p), the pack opens with an explicit endpoint guard, so seam frames are raw selections regardless of any accumulation maths inside a type. Randomness is the shared PCG hash; every tap count, kernel position and noise octave is a fixed literal (export contract).
const ext3Body = /* glsl */ `
  float bell = 4.0 * progress * (1.0 - progress);

  if (progress <= 0.0) {             // endpoint guard: the seam frames are exact selections
    outSelect = SEL_RAW(texA, vUv);
    isSelect = true;
  } else if (progress >= 1.0) {
    outSelect = SEL_RAW(texB, vUv);
    isSelect = true;
  } else if (type == 13) {           // ink bleed: noise-perturbed frontier wicks along +direction
    float c = axisCoord(vUv, direction);
    vec2 np = vec2(vUv.x * aspect, vUv.y) * mix(3.0, 10.0, intensity);
    float n = vnoise(np, 131u) * 0.7 + vnoise(np * 2.3, 137u) * 0.3 - 0.5;
    float r = c + n * 0.35 * intensity;
    float reach = softness + 0.4;
    float pp = mix(-reach, 1.0 + reach, progress);
    float m = 1.0 - smoothstep(pp - softness, pp + softness, r);
    if (m <= 0.0) {
      outSelect = SEL_RAW(texA, vUv);
      isSelect = true;
    } else if (m >= 1.0) {
      outSelect = SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      float edge = 1.0 - abs(2.0 * m - 1.0);
      vec2 smear = -vec2(direction.x / aspect, direction.y) * edge * bell * 0.06;
      vec3 a = (S(texA, vUv) + S(texA, vUv + smear * 0.5) + S(texA, vUv + smear)
        + S(texA, vUv + smear * 1.5) + S(texA, vUv + smear * 2.0)) / 5.0;
      outDisplay = mix(a, S(texB, vUv), m);
    }
  } else if (type == 14) {           // flow morph: curl-noise currents advect A out and B in
    vec2 np = vec2(vUv.x * aspect, vUv.y);
    vec3 o1 = vnoised(np * 1.7, 151u);
    vec3 o2 = vnoised(np * 4.3, 157u);
    vec2 grad = o1.yz * 1.275 + o2.yz * 1.075;
    vec2 curl = vec2(grad.y / aspect, -grad.x);
    float k = 0.1 * intensity;
    vec2 offA = curl * (k * progress * (0.5 + 0.7 * parallax));
    vec2 offB = -curl * (k * (1.0 - progress) * (1.5 - 0.7 * parallax));
    vec2 smearS = curl * (bell * 0.02);
    vec3 a = (S(texA, vUv + offA) + S(texA, vUv + offA + smearS) + S(texA, vUv + offA - smearS)) / 3.0;
    vec3 b = (S(texB, vUv + offB) + S(texB, vUv + offB + smearS) + S(texB, vUv + offB - smearS)) / 3.0;
    outDisplay = mix(a, b, progress);
  } else if (type == 15) {           // shockwave: refractive pressure front expanding from the origin
    vec2 q = vec2((vUv.x - center.x) * aspect, vUv.y - center.y);
    float rd = length(q);
    float w = softness;
    vec2 corner = vec2(max(center.x, 1.0 - center.x) * aspect, max(center.y, 1.0 - center.y));
    float rmax = length(corner) + w * 2.0;
    float R = mix(-w * 2.0, rmax, progress);
    float m = 1.0 - smoothstep(R - w * 0.5, R + w * 0.5, rd);
    float pw = 0.0;
    for (int i = 0; i < 3; i++) {
      if (float(i) < steps) {
        float xi = (rd - (R - w * 1.6 * float(i))) / w;
        float amp = i == 0 ? 1.0 : (i == 1 ? 0.35 : 0.12);
        float d0 = xi + 0.35;
        pw += amp * max(0.0, 1.0 - (d0 > 0.0 ? d0 / 0.35 : -d0 / 1.4));
      }
    }
    vec2 nd = rd > 0.0001 ? q / rd : vec2(0.0);
    vec2 duv = vec2(nd.x / aspect, nd.y) * (pw * 0.08 * intensity * bell);
    if (pw <= 0.001 && m <= 0.0) {
      outSelect = SEL_RAW(texA, vUv);
      isSelect = true;
    } else if (pw <= 0.001 && m >= 1.0) {
      outSelect = SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      vec3 a = vec3(S(texA, vUv + duv * 0.92).r, S(texA, vUv + duv).g, S(texA, vUv + duv * 1.08).b);
      vec3 b = vec3(S(texB, vUv + duv * 0.92).r, S(texB, vUv + duv).g, S(texB, vUv + duv * 1.08).b);
      outDisplay = clamp(mix(a, b, m) + pw * pw * bell * 0.25 * intensity, 0.0, 1.0);
    }
  } else if (type == 16) {           // glass sweep: refracting bar, per-channel dispersion, rim light
    float c = axisCoord(vUv, direction);
    float w = softness;
    float pos = mix(-w - 0.05, 1.0 + w + 0.05, progress);
    float dc = c - pos;
    if (abs(dc) >= w) {
      outSelect = dc > 0.0 ? SEL_RAW(texA, vUv) : SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      float t = dc / w;
      float h = cos(1.5707963 * t);
      float slope = -sin(1.5707963 * t) * 1.5707963;
      float disp = slope * 0.1 * intensity * bell;
      vec2 axis = vec2(direction.x / aspect, direction.y);
      float sideMix = smoothstep(0.15 * w, -0.15 * w, dc);
      vec3 a = vec3(
        S(texA, vUv + axis * (disp * 0.96)).r,
        S(texA, vUv + axis * disp).g,
        S(texA, vUv + axis * (disp * 1.04)).b);
      vec3 b = vec3(
        S(texB, vUv + axis * (disp * 0.96)).r,
        S(texB, vUv + axis * disp).g,
        S(texB, vUv + axis * (disp * 1.04)).b);
      float rim = pow(1.0 - h, 6.0) * intensity * bell * 0.45;
      outDisplay = clamp(mix(a, b, sideMix) + rim, 0.0, 1.0);
    }
  } else if (type == 17) {           // rack focus: aperture-shaped, highlight-weighted defocus swap
    float rA = 0.045 * intensity * smoothstep(0.0, 0.5, progress);
    float rB = 0.045 * intensity * smoothstep(0.0, 0.5, 1.0 - progress);
    vec2 sc = vec2(1.0 / aspect, 1.0);
    vec3 sumA = vec3(0.0);
    vec3 sumB = vec3(0.0);
    float wsumA = 0.0;
    float wsumB = 0.0;
    for (int i = 0; i < 19; i++) {
      vec2 o = (shape == 3 ? HEX19[i] : DISC19[i]) * sc;
      vec3 ta = S(texA, vUv + o * rA);
      float wa = 1.0 + 80.0 * softness * pow(max(lum(ta) - 0.7, 0.0) * 3.3333, 2.0);
      sumA += ta * wa;
      wsumA += wa;
      vec3 tb = S(texB, vUv + o * rB);
      float wb = 1.0 + 80.0 * softness * pow(max(lum(tb) - 0.7, 0.0) * 3.3333, 2.0);
      sumB += tb * wb;
      wsumB += wb;
    }
    outDisplay = mix(sumA / wsumA, sumB / wsumB, progress);
  } else if (type == 18) {           // halftone: the frame prints into shrinking content dots on paper
    vec3 paper = linearToSrgb(dipColor);
    float baseAng = atan(direction.y, direction.x);
    bool firstHalf = progress < 0.5;
    float t = clamp((firstHalf ? progress : 1.0 - progress) * 2.0, 0.0, 1.0);
    float gate = smoothstep(0.0, 0.22, t);
    vec3 base = firstHalf ? S(texA, vUv) : S(texB, vUv);
    vec3 outc = base;
    for (int ch = 0; ch < 3; ch++) {
      float ang = baseAng + (ch == 0 ? 0.261799 : ch == 1 ? 0.785398 : 1.308997);
      float ca = cos(ang);
      float sa = sin(ang);
      vec2 sp = rot2(vec2(vUv.x * aspect, vUv.y), ca, sa) * blocks.x;
      vec2 cell = floor(sp) + 0.5;
      vec2 cw = rot2(cell / blocks.x, ca, -sa);
      vec2 cuv = vec2(cw.x / aspect, cw.y);
      vec3 cs = firstHalf ? S(texA, cuv) : S(texB, cuv);
      float cv = ch == 0 ? cs.r : ch == 1 ? cs.g : cs.b;
      float pch = ch == 0 ? paper.r : ch == 1 ? paper.g : paper.b;
      // Dot sized by how far the cell's content sits from the paper, shrinking to paper across the half.
      float r = sqrt(clamp(abs(cv - pch), 0.0, 1.0)) * (0.62 + 0.3 * intensity) * (1.0 - t);
      float f = shape == 0 ? abs(fract(sp.y) - 0.5) : length(fract(sp) - 0.5);
      float dotm = 1.0 - smoothstep(r - 0.05, r + 0.05, f);
      float printed = mix(pch, cv, dotm);
      float bch = ch == 0 ? base.r : ch == 1 ? base.g : base.b;
      float o = mix(bch, printed, gate);
      if (ch == 0) { outc.r = o; } else if (ch == 1) { outc.g = o; } else { outc.b = o; }
    }
    outDisplay = outc;
  } else if (type == 19) {           // light sweep: anamorphic streak flare over a band reveal
    float c = axisCoord(vUv, direction);
    float w = softness;
    float bandHalf = w * 2.5;
    float pos = mix(-bandHalf, 1.0 + bandHalf, progress);
    float dc = c - pos;
    if (abs(dc) >= bandHalf) {
      outSelect = dc > 0.0 ? SEL_RAW(texA, vUv) : SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      float sideMix = smoothstep(0.2 * w, -0.2 * w, dc);
      vec3 base = mix(S(texA, vUv), S(texB, vUv), sideMix);
      vec2 axis = vec2(direction.x / aspect, direction.y);
      float e = 0.0;
      for (int i = 0; i < 8; i++) {
        float tt = (float(i) / 7.0 - 0.5) * 2.0;
        vec2 uv = vUv + axis * (tt * w * 2.0);
        vec3 tap = axisCoord(uv, direction) - pos > 0.0 ? S(texA, uv) : S(texB, uv);
        e += max(lum(tap) - 0.55, 0.0);
      }
      float gauss = exp(-dc * dc / (0.5 * w * w));
      float energy = (e * 0.5 + 0.55) * intensity * bell * (gauss + 0.8 * gauss * gauss * gauss);
      vec3 flare = linearToSrgb(dipColor) * energy;
      outDisplay = clamp(1.0 - (1.0 - base) * (1.0 - clamp(flare, 0.0, 1.0)), 0.0, 1.0);
    }
  } else if (type == 20) {           // shatter: staggered panes drift and rotate out, rim-lit edges
    float g = max(blocks.x, 2.0);
    vec2 P = vec2(vUv.x * aspect, vUv.y);
    vec2 ig = floor(P * g);
    float st = parallax * 1.5;
    vec2 dscaled = vec2(direction.x * aspect, direction.y);
    // Forward search: which moved pane covers this fragment (so panes stay visible in flight).
    bool hit = false;
    vec2 x0 = vec2(0.0);
    float hitLp = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        if (!hit) {
          vec2 cid = ig + vec2(float(ox), float(oy));
          uvec2 ck = uvec2(cid + 64.0);
          float h1 = hash01(uvec3(ck, 419u));
          float h2 = hash01(uvec3(ck, 421u));
          float h3 = hash01(uvec3(ck, 431u));
          float lp = clamp(progress * (1.0 + st) - h3 * st, 0.0, 1.0);
          if (lp < 1.0) {
            float drive = lp * lp;
            vec2 drift = (dscaled * (0.6 + 0.8 * h1) + vec2(h2 - 0.5, h1 - 0.5) * 0.8)
              * ((0.5 + intensity) * drive * 1.4);
            float rot = (h2 - 0.5) * 2.4 * intensity * lp;
            vec2 C = (cid + 0.5) / g;
            vec2 q0 = C + rot2(P - C - drift, cos(rot), -sin(rot));
            if (floor(q0 * g) == cid) {
              hit = true;
              x0 = q0;
              hitLp = lp;
            }
          }
        }
      }
    }
    if (!hit || x0.x < 0.0 || x0.x > aspect || x0.y < 0.0 || x0.y > 1.0) {
      outSelect = SEL_RAW(texB, vUv);
      isSelect = true;
    } else {
      vec2 fr = abs(fract(x0 * g) - 0.5);
      float border = smoothstep(0.4, 0.5, max(fr.x, fr.y));
      float rim = border * bell * intensity * 0.7 * smoothstep(0.0, 0.1, hitLp);
      outDisplay = clamp(S(texA, vec2(x0.x / aspect, x0.y)) * (1.0 + rim), 0.0, 1.0);
    }
  } else if (type == 21) {           // pixel stretch: luma-keyed smear, bright pixels hold longest
    float key = lum(S(texA, vUv));
    key = clamp(key + (vnoise(vec2(vUv.x * aspect, vUv.y) * 60.0, 461u) - 0.5) * softness * 2.0, 0.0, 1.0);
    float lp = clamp(progress * 2.2 - key * 1.2, 0.0, 1.0);
    float m = lp * lp * (3.0 - 2.0 * lp);
    float len = 0.55 * intensity * bell * (0.3 + 0.7 * key);
    vec2 axis = vec2(direction.x / aspect, direction.y);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 12; i++) {
      vec3 tap = S(texA, vUv - axis * ((float(i) / 11.0) * len));
      float wt = 0.05 + pow(lum(tap), 3.0);
      acc += tap * wt;
      wsum += wt;
    }
    outDisplay = mix(acc / wsum, S(texB, vUv), m);
  } else if (type == 22) {           // chroma split: channels peel apart, reconverge into B
    vec2 axis = vec2(direction.x / aspect, direction.y);
    float dA = 0.2 * intensity * progress;
    float dB = 0.2 * intensity * (1.0 - progress);
    float m = smoothstep(0.5 - softness, 0.5 + softness, progress);
    vec3 a = vec3(S(texA, vUv + axis * dA).r, S(texA, vUv).g, S(texA, vUv - axis * dA).b);
    vec3 b = vec3(S(texB, vUv - axis * dB).r, S(texB, vUv).g, S(texB, vUv + axis * dB).b);
    vec3 col = mix(a, b, m);
    outDisplay = mix(col, vec3(lum(col)), 0.25 * bell);
  } else if (type == 23) {           // datamosh: animated macroblock mosaic + motion smear + refresh sweep
    float nx = max(blocks.x, 2.0);
    vec2 bc = vec2(nx, max(nx / aspect, 2.0));
    vec2 blk = floor(vUv * bc);
    uvec2 bk = uvec2(blk);
    uint qp = uint(floor(progress * steps));
    vec2 mv = vec2(hash01(uvec3(bk, 100u + qp)) - 0.5, hash01(uvec3(bk, 200u + qp)) - 0.5) * 1.6
      + direction * 0.4;
    // Mosaic cell size grows with bell (fine enough near the seams to read as identity).
    vec2 cellSz = vec2(bell * 0.9) / bc;
    vec2 uvS = cellSz.x > 0.00002 ? (floor(vUv / cellSz) + 0.5) * cellSz : vUv;
    float thr = smoothstep(0.0, 0.8, progress * (1.0 + 0.15 * vUv.y));
    bool useB = hash01(uvec3(bk, 300u + qp)) < thr;
    float L = mix(48.0, 10.0, bell * intensity);
    vec3 col = useB
      ? S(texB, uvS - mv * (0.05 * intensity * (1.0 - progress) * bell))
      : S(texA, uvS + mv * (0.12 * intensity * progress * bell));
    outDisplay = mix(col, floor(col * L) / L, clamp(bell * 2.0, 0.0, 1.0));
  } else if (type == 24) {           // prism fold: faceted refraction with facet-edge glints
    vec2 q = vec2((vUv.x - center.x) * aspect, vUv.y - center.y);
    float th = atan(q.y, q.x);
    float rd = length(q);
    float wseg = 6.2831853 / max(steps, 3.0);
    float thc = (floor(th / wseg) + 0.5) * wseg;
    float dth = (thc - th) * (0.8 * intensity * bell) + 0.6 * intensity * bell;
    float dd = 0.03 * intensity * bell;
    vec2 e0 = vec2(cos(th + dth), sin(th + dth)) * rd;
    vec2 eR = vec2(cos(th + dth + dd), sin(th + dth + dd)) * rd;
    vec2 eB = vec2(cos(th + dth - dd), sin(th + dth - dd)) * rd;
    vec2 uv0 = vec2(e0.x / aspect + center.x, e0.y + center.y);
    vec2 uvR = vec2(eR.x / aspect + center.x, eR.y + center.y);
    vec2 uvB2 = vec2(eB.x / aspect + center.x, eB.y + center.y);
    vec3 a = vec3(S(texA, uvR).r, S(texA, uv0).g, S(texA, uvB2).b);
    vec3 b = vec3(S(texB, uvR).r, S(texB, uv0).g, S(texB, uvB2).b);
    float glint = smoothstep(0.42, 0.5, abs(th - thc) / wseg) * bell * intensity * 0.45;
    outDisplay = clamp(mix(a, b, progress) + glint, 0.0, 1.0);
  } else {                           // spin blur: rotational whip about the focal point
    vec2 q = vec2((vUv.x - center.x) * aspect, vUv.y - center.y);
    float sgn = shape == 1 ? 1.0 : -1.0;
    float travel = sgn * (0.4 + 0.9 * intensity);
    float ep = progress * progress * (3.0 - 2.0 * progress);
    float thA = travel * ep;
    float thB = -travel * (1.0 - ep);
    float spread = abs(travel) * bell * 0.45;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float o = (float(i) / 15.0 - 0.5) * spread;
      vec2 pa = rot2(q, cos(thA + o), sin(thA + o));
      vec2 pb = rot2(q, cos(thB + o), sin(thB + o));
      acc += mix(
        S(texA, vec2(pa.x / aspect + center.x, pa.y + center.y)),
        S(texB, vec2(pb.x / aspect + center.x, pb.y + center.y)),
        progress);
    }
    outDisplay = acc / 16.0;
  }
`;

/** v15 SDR composite (GLSL3): same display-domain semantics as the earlier packs, its own program. */
export const fragmentShaderExt3 = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}
  ${ext3Common}

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb);
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) { return S(t, uv); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${ext3Body}
    fragColor = vec4(isSelect ? outSelect : outDisplay, 1.0);
  }
`;

/** v15 HDR composite (GLSL3, fx path): the earlier packs' ACES round-trip semantics, its own program; selections pass raw linear HDR untouched. */
export const fragmentShaderExt3Hdr = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  ${extCommon}
  ${ext3Common}

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  ${ACES_FORWARD_GLSL}
  ${ACES_INVERSE_GLSL}

  vec3 S(sampler2D t, vec2 uv) {
    return linearToSrgb(acesForward(texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb));
  }
  vec3 SEL_RAW(sampler2D t, vec2 uv) {
    return texture(t, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  }
  vec3 tmInv(vec3 e) { return acesInverse(srgbToLinear(clamp(e, 0.0, 0.999))); }

  void main() {
    vec3 outDisplay = vec3(0.0);
    vec3 outSelect = vec3(0.0);
    bool isSelect = false;
    ${ext3Body}
    fragColor = vec4(isSelect ? outSelect : tmInv(outDisplay), 1.0);
  }
`;
