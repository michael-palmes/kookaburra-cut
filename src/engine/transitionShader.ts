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
};

/** Types >= this id render through the extended (GLSL3) materials. */
export const EXTENDED_MIN_TYPE = 4;

/** Types >= this id render through the v14 (third-generation GLSL3) materials, keeping the earlier programs source-identical. */
export const EXT2_MIN_TYPE = 10;

/** Procedural luma-wipe ramp shapes (see the extended fragment shaders). */
export const SHAPE_ID: Record<TransitionShape, number> = { linear: 0, radial: 1, iris: 2 };

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
