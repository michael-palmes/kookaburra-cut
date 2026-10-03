import { LOOK_GLSL_SKY } from "../../kit";
import { WASH_BLOOM_SLOTS } from "./motion";

/** Uniforms both parts read: the palette, the paper grain and the shared cloud field's drift, threshold and styling. */
// language=GLSL
const WASH_COMMON = /* glsl */ `
uniform vec3 uWash;
uniform vec3 uPool;
uniform vec3 uBloom;
uniform vec3 uPaper;
uniform sampler2D uPaperTex;
uniform vec2 uDrift;
uniform float uDry;
uniform float uCover;
uniform float uEdge;
uniform float uGrain;
uniform float uStreak;
float washField(vec2 p, float fw) {
  p.x *= mix(1.0, 0.45, uStreak);
  p += uDrift;
  vec2 w = vec2(skyFbm(p * 0.7 + vec2(4.1, 1.3), fw * 0.7), skyFbm(p * 0.7 + vec2(8.7, 6.2), fw * 0.7));
  return skyFbm(p + 0.9 * (w - 0.5), fw * 1.4);
}
`;

/** The dome: a calm graded wash below the calm band, pooled-edge cloud masses above it thinning to a quiet zenith, granulation from the paper tooth, and scheduled backrun blooms. */
// language=GLSL
export const DOME_FRAGMENT: string = /* glsl */ `
${WASH_COMMON}
uniform float uStrokeDrift;
uniform float uCalmLo;
uniform float uCalmHi;
uniform vec4 uBloomC[${WASH_BLOOM_SLOTS}];
uniform float uBloomAmp[${WASH_BLOOM_SLOTS}];
varying vec3 vSkyDir;

float domeTooth(vec3 dir) {
  vec3 w = abs(dir);
  w *= w;
  w *= w;
  w /= w.x + w.y + w.z;
  return texture2D(uPaperTex, dir.zy * 1.6).r * w.x
    + texture2D(uPaperTex, dir.xz * 1.6 + 0.37).r * w.y
    + texture2D(uPaperTex, dir.xy * 1.6 + 0.61).r * w.z;
}

void main() {
  vec3 dir = normalize(vSkyDir);
  float e = dir.y;
  float tooth = domeTooth(dir) - 0.5;
  vec2 p = skyPlane(dir, 0.14) * 0.45;
  float fwp = length(fwidth(p));
  float fwd = length(fwidth(dir));
  float calm = smoothstep(uCalmLo, uCalmHi, e);
  float D = 0.0;
  float inside = 0.0;
  float pool = 0.0;
  float halo = 0.0;
  // Branches below skip work per pixel, so they take no derivatives: fwp and fwd stand in.
  if (calm > 0.0) {
    float f = washField(p, fwp);
    float th = mix(0.7, uCover, calm * skyZenithFade(dir)) + uDry;
    float fw = 0.5 * fwp;
    float soft = 0.008 + fw;
    D = smoothstep(th - soft, th + soft, f) * calm;
    inside = max(f - th, 0.0);
    pool = exp(-inside / (0.022 + fw)) * D;
    halo = exp(-max(th - f, 0.0) / 0.025) * (1.0 - D) * 0.25 * calm;
  }
  vec3 col = mix(uPaper, uWash, 0.08 + 0.14 * smoothstep(0.3, 0.0, e));
  col = mix(col, uWash, halo);
  float strokeW = 0.14 * calm * (1.0 - smoothstep(0.35, 0.8, e));
  if (strokeW > 0.0) {
    vec2 sp = vec2(p.x * 0.35 + p.y * 0.9, p.y * 0.25 - p.x * 0.1) * 1.3 + vec2(uStrokeDrift, 0.0);
    col = mix(col, uWash, strokeW * smoothstep(0.45, 0.72, skyFbm(sp, fwp * 1.3)));
  }
  float body = 0.62 + 0.25 * smoothstep(0.05, 0.25, inside);
  col = mix(col, uWash, D * body);
  col = mix(col, uPool, pool * uEdge);
  col = mix(col, uBloom, D * 0.45 * (1.0 - smoothstep(0.14, 0.3, e)) * smoothstep(0.02, 0.12, inside));
  col = mix(col, uPool, clamp(D * (tooth * 0.6 + 0.15) * uGrain, 0.0, 1.0));
  for (int k = 0; k < ${WASH_BLOOM_SLOTS}; k++) {
    float amp = uBloomAmp[k];
    vec3 c = uBloomC[k].xyz;
    float R = uBloomC[k].w;
    vec3 dd = dir - c;
    float reach = 2.0 * R + 0.02;
    if (amp <= 0.0 || dot(dd, dd) > reach * reach) continue;
    vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(t1, c);
    vec2 lp = vec2(dot(dd, t1), dot(dd, t2));
    vec2 ring = lp / max(length(lp), 1e-5);
    float fk = float(k);
    float lobes = 0.6 * vnoise(ring * 2.5 + fk * 7.0) + 0.4 * vnoise(ring * 6.0 + fk * 3.0);
    float rr = length(lp) - (lobes - 0.5) * 0.5 * R;
    float a = amp * (0.3 + 0.7 * D) * 0.4;
    float inner = 1.0 - smoothstep(R - 0.006 - fwd, R, rr);
    float core = 1.0 - smoothstep(0.0, R * 0.8, rr);
    float rimW = 0.004 + 0.5 * fwd;
    float rim = 1.0 - smoothstep(rimW - fwd, rimW + fwd, abs(rr - R));
    col = mix(col, mix(uWash, uBloom, 0.35 + 0.4 * core), inner * a);
    col = mix(col, uPool, rim * a);
  }
  col = mix(mix(uPaper, uWash, 0.22), col, smoothstep(-0.02, 0.01, e));
  col *= 1.0 + tooth * 0.05;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** The paper floor: a faint layered wash and brush strokes, painted cloud shadows from the same field (pooled rims, granulation) that fade at grazing angles and in the stage clearing, dissolving into the horizon wash. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_SKY}
${WASH_COMMON}
varying vec3 vWorld;

void main() {
  float r = length(vWorld.xz);
  vec3 col = mix(uPaper, uWash, 0.1 + 0.1 * smoothstep(6.0, 30.0, r));
  vec2 lp = vWorld.xz * 0.05 + 7.0;
  float lay = skyFbm(lp, length(fwidth(lp)), 3);
  col = mix(col, uWash, 0.1 * smoothstep(0.4, 0.7, lay));
  vec2 p = (vWorld.xz + vec2(-8.0, 5.0)) * 0.04;
  float fp = length(fwidth(p));
  float sg = texture2D(uPaperTex, vWorld.xz / 38.0).a - 0.5;
  vec3 V = normalize(cameraPosition - vWorld);
  float shAmt = smoothstep(0.06, 0.22, V.y) * (1.0 - 0.5 * smoothstep(18.0, 40.0, r)) * smoothstep(3.5, 7.0, r);
  if (shAmt > 0.0) {
    float f = washField(p, fp);
    float fwf = 0.5 * fp;
    float th = uCover + 0.03 + uDry;
    float sh = smoothstep(th - fwf, th + fwf + 0.01, f);
    float shRim = exp(-max(f - th, 0.0) / (0.02 + fwf)) * sh;
    col = mix(col, uWash, sh * 0.45 * shAmt);
    col = mix(col, uPool, clamp(shRim * 0.625 * uEdge + sh * sg * uGrain, 0.0, 1.0) * shAmt);
  }
  vec2 sp = vec2(vWorld.x * 0.04, vWorld.z * 0.35) + 2.0;
  float strokes = skyFbm(sp, length(fwidth(sp)), 3);
  col = mix(col, uWash, 0.14 * smoothstep(0.45, 0.7, strokes) * smoothstep(3.0, 7.0, r));
  float tooth = texture2D(uPaperTex, vWorld.xz / 12.0).r - 0.5;
  col = mix(col, uPool, tooth * 0.08);
  col = mix(col, mix(uPaper, uWash, 0.22), smoothstep(38.0, 64.0, r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
