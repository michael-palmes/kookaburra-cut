import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_SKY, STROKE_SPLAT_GLSL_FRAGMENT } from "../../kit";
import { PAD_TURN, RIPPLE_LOOP, RIPPLE_PERIODS, WATER_Y } from "./rafts";

/** Lily pond GLSL: a hazy sky dome, the water (fresnel wash, broken-colour reflection strokes masked by the F3 brush atlas, cloud reflections, scheduled ripple rings, haze), the pads and their blossoms. Colours are LINEAR slot uniforms. */

/** The water's haze: the far water dissolves into the dome's horizon colour, so there is no horizon line. */
export const HAZE = { start: 34, end: 95, mix: 0.6 } as const;

/** Cloud reflection noise frequency (cycles per world unit). */
export const CLOUD_SCALE = 0.045;

const PAD_Y = WATER_Y + 0.02;
const BLOOM_Y = WATER_Y + 0.05;

// language=GLSL
const COMMON = /* glsl */ `
const float LP_TAU = 6.28318530718;
uniform vec3 uSky;
uniform vec3 uBacking;
vec3 lpHaze() { return mix(uSky, uBacking, ${glslFloat(HAZE.mix)}); }
float lpHazeAt(float r) { return smoothstep(${glslFloat(HAZE.start)}, ${glslFloat(HAZE.end)}, r); }
`;

// language=GLSL
export const DOME_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${COMMON}
varying vec3 vSkyDir;
void main() {
  vec3 dir = normalize(vSkyDir);
  gl_FragColor = vec4(backingMix(lpHaze(), uBacking, smoothstep(-0.01, 0.12, dir.y)), 1.0);
  #include <colorspace_fragment>
}
`;

const periods = RIPPLE_PERIODS.map(glslFloat).join(", ");

// language=GLSL
export const WATER_FRAGMENT = /* glsl */ `
${LOOK_GLSL_SKY}
${COMMON}
uniform sampler2D uBrushMask;
uniform vec3 uDeep;
uniform vec3 uPad;
uniform float uRippleT;
uniform int uRipples;
uniform int uStep;
uniform vec2 uCloud;
uniform float uClear;
uniform float uStroke;
varying vec3 vWorld;
const float LP_PERIOD[${RIPPLE_PERIODS.length}] = float[${RIPPLE_PERIODS.length}](${periods});
float lpBand(float d, float halfWidth, float fw) {
  return 1.0 - smoothstep(halfWidth - fw, halfWidth + fw, abs(d));
}
// One layer of broken-colour strokes, one per world cell, each a brush-atlas mask (explicit gradients: cells jump).
vec4 lpStrokes(vec2 xz, vec2 dx, vec2 dy, vec2 cell, int seed, float warp) {
  vec2 q = xz / cell;
  float row = floor(q.y);
  q.x += hash11(int(row) * 13 + seed);
  q.y += warp;
  ivec2 cid = ivec2(floor(q));
  vec2 f = fract(q) - 0.5;
  vec2 h = hash22(cid + ivec2(seed, seed * 7));
  vec2 jit = hash22(cid + ivec2(uStep, seed)) - 0.5;
  vec2 g = hash22(cid + ivec2(seed * 5, 77));
  vec2 c = (g - 0.5) * vec2(0.12, 0.2) + jit * vec2(0.015, 0.02);
  float halfLen = (0.2 + 0.1 * h.y) * cell.x;
  float halfWid = (0.13 + 0.06 * h.x) * cell.y;
  vec2 dp = (f - c) * cell;
  float tilt = (hash21(cid + ivec2(seed, 19)) - 0.5) * 0.08;
  dp = vec2(dp.x + tilt * dp.y, dp.y - tilt * dp.x);
  float bend = dp.x / max(halfLen, 0.1);
  dp.y += (h.x - 0.5) * 0.12 * bend * bend;
  float flip = hash21(cid + ivec2(41, seed)) < 0.5 ? -1.0 : 1.0;
  vec2 k = vec2(0.41 * flip / halfLen, 0.28 / halfWid);
  vec2 uv = 0.5 + dp * k;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  int shape = int(hash21(cid + ivec2(seed, 63)) * 4.0);
  vec2 atlas = (vec2(float(shape % 2), float(shape / 2)) + clamp(uv, 0.0, 1.0)) * 0.5;
  vec4 m = textureGrad(uBrushMask, atlas, dx * k * 0.5, dy * k * 0.5);
  float present = step(0.42, hash21(cid + ivec2(seed * 3, 91)));
  float a = smoothstep(0.2, 0.6, m.a) * inside * present * (0.55 + 0.45 * hash21(cid + ivec2(5, seed * 11)));
  float pick = hash21(cid + ivec2(17, seed));
  vec3 col = pick < 0.46 ? uSky : (pick < 0.84 ? uDeep : (pick < 0.94 ? mix(uPad, uDeep, 0.3) : mix(uSky, uDeep, 0.5)));
  col = mix(mix(col, uDeep, 0.22), col, m.r);
  return vec4(col, a);
}
void main() {
  vec2 xz = vWorld.xz;
  float r = length(xz);
  vec2 dx = dFdx(xz);
  vec2 dy = dFdy(xz);
  vec2 fw = abs(dx) + abs(dy);
  float fwr = length(fw);
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
  vec3 col = mix(uDeep, uSky, 0.22 + 0.5 * fres);
  // Sky reflections: soft clouds glide across, darker reflected masses between them.
  float f = skyFbm(xz * ${glslFloat(CLOUD_SCALE)} - uCloud, fwr * ${glslFloat(CLOUD_SCALE)}, 3);
  float reach = 1.0 - smoothstep(30.0, 70.0, r);
  col = mix(col, uSky, smoothstep(0.45, 0.7, f) * 0.6 * reach);
  col = mix(col, uDeep, (1.0 - smoothstep(0.28, 0.45, f)) * 0.3 * reach);

  float ring = 0.0;
  float trough = 0.0;
  float warp = 0.0;
  if (r < 30.0) {
    for (int k = 0; k < ${RIPPLE_PERIODS.length}; k++) {
      if (k >= uRipples) break;
      float period = LP_PERIOD[k];
      float ph = (uRippleT + float(k) * 2.9) / period;
      float n = floor(ph);
      float u = ph - n;
      int seed = int(mod(n, ${glslFloat(RIPPLE_LOOP)} / period)) * 11 + k * 173 + 5;
      float ang = hash11(seed) * LP_TAU;
      float rad = 3.0 + hash11(seed + 1) * 20.0;
      float dist = length(xz - vec2(cos(ang), sin(ang)) * rad);
      float R = 0.2 + 3.2 * u;
      if (dist > R + 1.5 || dist < 0.6 * R - 1.0) continue;
      float amp = smoothstep(0.0, 0.06, u) * pow(1.0 - u, 1.5);
      float w = max(0.05 + 0.05 * u, fwr * 0.9);
      ring += lpBand(dist - R, w, fwr) * amp;
      trough += lpBand(dist - R + 2.2 * w, w, fwr) * amp;
      ring += lpBand(dist - R * 0.6, w * 0.8, fwr) * amp * 0.6;
      warp += sin((dist - R) * 9.0) * exp(-abs(dist - R) * 3.0) * amp * 0.12;
    }
  }

  float amount = mix(0.45, 0.85, smoothstep(uClear - 3.0, uClear + 2.0, r)) * (1.0 - smoothstep(30.0, 60.0, r));
  vec2 cell1 = vec2(3.0, 0.8) * uStroke;
  vec2 cell2 = vec2(2.3, 0.62) * uStroke;
  float g1 = 1.0 - smoothstep(0.35, 0.7, length(fw / cell1));
  float g2 = 1.0 - smoothstep(0.35, 0.7, length(fw / cell2));
  if (g1 + g2 > 0.0 && amount > 0.0) {
    vec4 s1 = lpStrokes(xz, dx, dy, cell1, 3, warp);
    vec4 s2 = lpStrokes(xz + vec2(1.4, 0.4) * uStroke, dx, dy, cell2, 29, warp);
    col = mix(col, s1.rgb, s1.a * g1 * amount * 0.7);
    col = mix(col, s2.rgb, s2.a * g2 * amount * 0.55);
  }
  col = mix(col, uSky, clamp(ring, 0.0, 1.0) * 0.7);
  col = mix(col, uDeep, clamp(trough, 0.0, 1.0) * 0.45);
  col = mix(col, lpHaze(), lpHazeAt(r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// language=GLSL
const POSE = /* glsl */ `
attribute vec4 aPad;
attribute vec4 aRaft;
attribute vec4 aPadKey;
attribute vec4 aBloom;
uniform float uRaftT;
const float LP_TURN = ${glslFloat(PAD_TURN)};
vec3 lpPadPose() {
  float w = 6.28318530718 * uRaftT / aRaft.y + aRaft.z;
  return vec3(aPad.x + cos(w) * aRaft.x, aPad.y + sin(w) * aRaft.x, aPad.w + LP_TURN * sin(w + aRaft.w));
}
// The quad's local y maps to world -z, so its front face looks up.
vec2 lpLocal() { return vec2(position.x, -position.y); }
vec2 lpTurn(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
`;

// language=GLSL
export const PAD_VERTEX = /* glsl */ `
${POSE}
varying vec2 vLocal;
varying vec3 vWorld;
varying float vTone;
void main() {
  vec3 pose = lpPadPose();
  vec2 p = lpTurn(lpLocal(), pose.z) * aPad.z;
  vec4 w = modelMatrix * vec4(pose.x + p.x, ${glslFloat(PAD_Y)}, pose.y + p.y, 1.0);
  vLocal = lpLocal();
  vWorld = w.xyz;
  vTone = aPadKey.x;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const PAD_FRAGMENT = /* glsl */ `
${STROKE_SPLAT_GLSL_FRAGMENT}
${COMMON}
uniform vec3 uPad;
uniform vec3 uDeep;
varying vec2 vLocal;
varying vec3 vWorld;
varying float vTone;
const float LP_NOTCH = 0.3;
const vec2 LP_SUN = vec2(-0.6, 0.8);
void main() {
  vec2 p = vLocal;
  float r = length(p);
  float wedge = max(p.y * cos(LP_NOTCH) - p.x * sin(LP_NOTCH), -(p.y * cos(LP_NOTCH) + p.x * sin(LP_NOTCH)));
  float cover = 1.0 - aaStep(0.0, max(r - 1.0, -wedge));
  vec2 m = splatMask(vec2(0.5 + 0.45 * p.x, 0.5 + 0.32 * p.y) * 0.5 + vec2(0.0, step(0.5, vTone) * 0.5));
  if (cover < 0.01) discard;
  vec3 col = mix(uPad, uSky, clamp(0.12 * vTone + 0.22 * dot(p, LP_SUN), 0.0, 1.0));
  col = mix(col, mix(uPad, uSky, 0.35), m.y * (1.0 - m.x) * 0.3);
  float rim = smoothstep(0.78, 0.99, r);
  col = mix(col, mix(uPad, uDeep, 0.6), rim * 0.7);
  float fa = length(fwidth(p)) / max(r, 1e-3) * 9.0 / LP_TAU;
  float d = fract(atan(p.y, p.x) * 9.0 / LP_TAU + 0.5) - 0.5;
  float vein = (1.0 - smoothstep(0.05 - fa, 0.05 + fa, abs(d))) * smoothstep(0.15, 0.4, r) * (1.0 - rim);
  col = mix(col, mix(uPad, uSky, 0.4), vein * 0.25);
  col = mix(col, lpHaze(), lpHazeAt(length(vWorld.xz)));
  gl_FragColor = vec4(col, cover);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const BLOOM_VERTEX = /* glsl */ `
${POSE}
uniform float uBlossoms;
varying vec2 vLocal;
varying vec3 vWorld;
varying float vFade;
void main() {
  vLocal = vec2(0.0);
  vWorld = vec3(0.0);
  vFade = 0.0;
  if (aPadKey.y >= uBlossoms) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec3 pose = lpPadPose();
  float a = pose.z + aBloom.z;
  vec2 c = pose.xy + vec2(cos(a), sin(a)) * aBloom.y * aPad.z;
  vec2 p = lpTurn(lpLocal(), pose.z * 1.3) * aBloom.x;
  vec4 w = modelMatrix * vec4(c.x + p.x, ${glslFloat(BLOOM_Y)}, c.y + p.y, 1.0);
  vec4 view = viewMatrix * w;
  vLocal = lpLocal();
  vWorld = w.xyz;
  vFade = smoothstep(3.0, 6.0, aBloom.x * exportPxPerUnit(-view.z) / uPx);
  gl_Position = projectionMatrix * view;
}
`;

// language=GLSL
export const BLOOM_FRAGMENT = /* glsl */ `
${COMMON}
uniform vec3 uBloom;
uniform vec3 uPad;
varying vec2 vLocal;
varying vec3 vWorld;
varying float vFade;
void main() {
  vec2 p = vLocal;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float outer = r - (0.8 + 0.2 * cos(ang * 7.0));
  float inner = r - (0.5 + 0.12 * cos(ang * 7.0 + 1.57));
  float a = (1.0 - aaStep(0.0, outer)) * vFade;
  if (a < 0.01) discard;
  vec3 col = mix(uBloom, mix(uBloom, uPad, 0.3), smoothstep(0.4, 1.0, r));
  col = mix(col, mix(uBloom, uBacking, 0.3), 1.0 - aaStep(0.0, inner));
  col = mix(col, mix(uBloom, uPad, 0.45), smoothstep(0.16, 0.05, r));
  col = mix(col, lpHaze(), lpHazeAt(length(vWorld.xz)));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;
