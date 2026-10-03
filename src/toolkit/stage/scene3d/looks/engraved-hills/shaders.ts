import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { HILLS_FLOOR_Y } from "./hills";

/** Shared by every part: ruling, the cutaway and the raster scale. */
// language=GLSL
const HILLS_COMMON = /* glsl */ `
uniform float uInv;
uniform vec2 uInkRaster;
const float EH_TAU = 6.28318530718;
// Raster px per export px: pitches are authored in export px, footprints come from the raster drawn into.
float ehRasterScale() { return uInkRaster.y > 0.0 ? uInkRaster.y / uResolution.y : 1.0; }
// One ruled family: lines at integer s, half-width hw in periods, footprint fw in periods per pixel. Lines thinner than a pixel draw one pixel wide at lower opacity, so the mean tone holds.
float ehLine(float s, float hw, float fw) {
  float d = abs(fract(s + 0.5) - 0.5);
  float dh = max(hw, fw * 0.5);
  return clamp((dh - d) / max(fw, 1e-6) + 0.5, 0.0, 1.0) * (hw / max(dh, 1e-6));
}
// Pitch-regulated ruling: the period halves or doubles in nested octaves so spacing stays within pitch to 2 x pitch pixels, settling to mean tone past the last octave.
float ehRule(float s, float fw, float hw, float pitch) {
  fw = max(fw, 1e-7);
  float lvl = log2(fw * pitch);
  float lc = clamp(lvl, -7.0, 7.0);
  float l0 = floor(lc);
  float f = smoothstep(0.0, 1.0, lc - l0);
  float s0 = exp2(l0);
  float c = mix(ehLine(s / s0, hw, fw / s0), ehLine(s / (2.0 * s0), hw, fw / (2.0 * s0)), f);
  c = mix(c, 2.0 * hw, smoothstep(6.5, 7.5, lvl));
  return c * smoothstep(-8.0, -7.0, lvl);
}
// 0 where a fragment sits between the camera and the content volume (a soft ellipsoid round x +-4, y +-2, z -6 to 9) or very near a camera that has left the stage.
float ehKeep(vec3 p) {
  vec3 R = vec3(5.6, 2.3, 9.6);
  vec3 ro = cameraPosition;
  vec3 rd = p - ro;
  float dP = length(rd);
  rd /= dP;
  vec3 o = (ro - vec3(0.0, 0.3, 1.5)) / R;
  vec3 d = rd / R;
  float a = dot(d, d);
  float b = dot(o, d);
  float oo = dot(o, o);
  float q = sqrt(max(oo - b * b / a, 0.0));
  float tRef = (-b - sqrt(max(b * b - a * (oo - 1.0), 0.0))) / a;
  float occ = (1.0 - smoothstep(0.95, 1.2, q)) * step(1.0, oo) * step(0.0, tRef)
    * (1.0 - smoothstep(tRef - 2.0, tRef - 0.3, dP));
  return (1.0 - occ) * smoothstep(0.16, 0.32, dP / max(length(ro), 1e-3));
}
`;

/** VERTEX. Range height scales every hill about the floor; hills sink below a camera standing among them, so it never looks out from inside one. Returns the look-local position and how far it sank. */
// language=GLSL
const HILLS_SHAPE = /* glsl */ `
uniform float uRange;
vec4 ehShape(vec3 p) {
  float y = ${glslFloat(HILLS_FLOOR_Y)} + (p.y - ${glslFloat(HILLS_FLOOR_Y)}) * uRange;
  vec3 cam = transpose(mat3(modelMatrix)) * (cameraPosition - modelMatrix[3].xyz);
  float near = 1.0 - smoothstep(3.0, 9.0, length(p.xz - cam.xz));
  float sunk = near * max(y - max(cam.y - 1.5, ${glslFloat(HILLS_FLOOR_Y)}), 0.0);
  return vec4(p.x, y - sunk, p.z, sunk);
}
`;

/** The stored normal scales with the range height. Cloud shadows (a field turning with the sky) are smooth enough to sample per vertex. */
// language=GLSL
export const LAND_VERTEX = /* glsl */ `
${HILLS_SHAPE}
uniform float uCloudAngle;
attribute vec3 hill;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vHill;
varying float vCloud;
float ehCloudField(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s + 0.015625;
}
void main() {
  vec3 p = ehShape(position).xyz;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * vec3(normal.x * uRange, normal.y, normal.z * uRange));
  vHill = hill;
  float ca = uCloudAngle;
  vec2 q = mat2(cos(ca), -sin(ca), sin(ca), cos(ca)) * p.xz;
  vCloud = ehCloudField(q * 0.05 + vec2(3.7, 8.1));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Land: form lines (level sets of height plus a radial rise and a seamless angular tilt) swell with shade, or with light in white line; cross-hatch only at the deepest tone; far ranges paler and finer. */
// language=GLSL
export const LAND_FRAGMENT = /* glsl */ `
${HILLS_COMMON}
uniform vec3 uSun;
uniform vec3 uInk;
uniform vec3 uFar;
uniform vec3 uPaper;
uniform float uPitch;
uniform float uSwell;
uniform float uCross;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vHill;
varying float vCloud;
// Burin swell: plane waves leaning out of the ground plane tilt the normal, so no swell lines up as screen columns.
vec3 ehWave(vec3 p, float lambda, vec3 dir, float amp, float ph) {
  vec3 k = normalize(dir);
  return k * (amp * cos(dot(p, k) * EH_TAU / lambda + ph));
}
vec3 ehBump(vec3 p) {
  return ehWave(p, 2.3, vec3(0.96, 0.8, 0.3), 0.12, 0.0)
    + ehWave(p, 1.9, vec3(-0.35, 0.9, 0.95), 0.12, 2.1)
    + ehWave(p, 1.6, vec3(-0.8, -0.7, -0.4), 0.11, 4.4)
    + ehWave(p, 1.15, vec3(0.6, -0.9, -0.8), 0.07, 1.3)
    + ehWave(p, 0.95, vec3(-0.9, 0.6, -0.5), 0.06, 5.2)
    + ehWave(p, 0.8, vec3(0.2, 1.0, -0.9), 0.05, 3.0);
}
float ehEyeRel(vec3 wp) {
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 vd = normalize(wp - cameraPosition);
  return asin(clamp(vd.y, -1.0, 1.0)) - asin(clamp(fwd.y, -1.0, 1.0));
}
void main() {
  float keep = ehKeep(vWorld);
  vec3 N = normalize(vN);
  float r = length(vWorld.xz);
  float aerial = max(vHill.y, smoothstep(40.0, 80.0, r));
  float cs = smoothstep(0.5, 0.68, vCloud);
  vec3 bump = ehBump(vWorld);
  vec3 Nb = normalize(N + (bump - N * dot(bump, N)) * 2.2 * (1.0 - 0.7 * vHill.z));
  float lit = smoothstep(-0.1, 0.65, dot(Nb, uSun));
  float fore = smoothstep(0.12, 0.38, -ehEyeRel(vWorld));
  float shade = mix(1.0 - lit + 0.3 * cs, lit * (1.0 - 0.5 * cs), uInv);
  float tone = (0.28 + 0.72 * shade) * mix(0.1, 1.0, vHill.x) * (1.0 - 0.75 * aerial);
  float floorT = (0.12 * fore + 0.08 * cs * (1.0 - uInv)) * smoothstep(1.5, 5.0, r);
  tone = clamp(mix(tone, floorT, vHill.z) * (1.0 - smoothstep(60.0, 95.0, r)), 0.0, 1.0);
  float pitch = max(mix(uPitch, uPitch * 0.56, aerial) * uPx * ehRasterScale(), 3.2);
  float th = atan(vWorld.z, vWorld.x);
  float F = (vWorld.y + 0.5 * r + smoothstep(6.0, 14.0, r) * (1.4 * sin(3.0 * th + 1.1) + 0.8 * sin(5.0 * th + 4.2))) / 0.1;
  float Fx = dFdx(F);
  float Fy = dFdy(F);
  float c1 = ehRule(F, abs(Fx) + abs(Fy), min(0.3 * uSwell * tone, 0.46), pitch);
  // Cross family: the same lines turned by 512 whole periods per turn (seamless), only in the deepest tone.
  vec2 gx = dFdx(vWorld.xz);
  vec2 gy = dFdy(vWorld.xz);
  float rr2 = max(r * r, 1.0);
  float M = 512.0 / EH_TAU;
  float dthx = (vWorld.x * gx.y - vWorld.z * gx.x) / rr2;
  float dthy = (vWorld.x * gy.y - vWorld.z * gy.x) / rr2;
  float deep = smoothstep(0.82, 1.0, tone) * (1.0 - aerial) * uCross;
  float c2 = ehRule(F + th * M, abs(Fx + dthx * M) + abs(Fy + dthy * M), 0.14 * deep, pitch * 1.15);
  float cov = (1.0 - (1.0 - c1) * (1.0 - c2)) * smoothstep(0.01, 0.6, keep);
  vec3 ink = mix(uInk, uFar, smoothstep(0.1, 0.8, aerial));
  if (keep < 0.01) discard;
  gl_FragColor = vec4(mix(uPaper, ink, cov), 1.0);
  #include <colorspace_fragment>
}
`;

/** Sky: fine even horizontals by elevation, heavier at the horizon, with ruled clouds turning round. */
// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
${HILLS_COMMON}
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uPaper;
uniform float uCloudAngle;
varying vec3 vSkyDir;
float ehCloud(float az, float el) {
  float band = smoothstep(0.1, 0.2, el) * (1.0 - smoothstep(0.6, 0.95, el));
  vec3 p = vec3(cos(az) * 2.4, sin(az) * 2.4, el * 9.0) + vec3(4.1, 1.7, 0.3);
  return fbm3(p) - 0.3 * (1.0 - band);
}
void main() {
  vec3 d = normalize(vSkyDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float s = el * 400.0;
  float fw = fwidth(s);
  float tone = 0.0;
  if (el > 0.0) {
    float az = atan(d.z, d.x) - uCloudAngle;
    float m = 0.0;
    float belly = 0.0;
    if (el > 0.05) {
      m = smoothstep(0.5, 0.57, ehCloud(az, el));
      belly = m * (1.0 - smoothstep(0.5, 0.57, ehCloud(az, el - 0.035)));
    }
    float hz = 1.0 - smoothstep(0.0, 0.2, el);
    float glow = 1.0 - smoothstep(0.0, 0.55, acos(clamp(dot(d, uSun), -1.0, 1.0)));
    float toneL = (0.05 + 0.1 * hz) * (1.0 - 0.5 * glow) * (1.0 - m) + 0.4 * belly;
    float toneD = (0.05 + 0.1 * hz + 0.14 * glow) * (1.0 - 0.8 * belly) + 0.26 * m * (1.0 - belly);
    tone = mix(toneL, toneD, uInv);
  }
  float c = ehRule(s, fw, 0.25 * tone, max(5.0 * uPx * ehRasterScale(), 3.0));
  gl_FragColor = vec4(mix(uPaper, uSky, c), 1.0);
  #include <colorspace_fragment>
}
`;

/** Crest outlines: static points (x, y, z, clearance) shaped like the land. Strand data is (width px, aerial depth). */
// language=GLSL
export const CREST_PATH = /* glsl */ `
${HILLS_SHAPE}
varying float vClear;
varying float vSunk;
vec3 inkPath(vec4 p) { return ehShape(p.xyz).xyz; }
`;

// language=GLSL
export const CREST_WIDTH = /* glsl */ `
vec2 inkWidth(vec4 p, vec3 world) { return vec2(0.0, inkStrand.x); }
`;

// language=GLSL
export const CREST_VERTEX_HOOK = /* glsl */ `
void inkVertex(vec4 p, vec3 world) {
  vClear = p.w;
  vSunk = ehShape(p.xyz).w;
}
`;

/** The silhouette the engraver cuts first: firm near, paler far, dropped near the stage. */
// language=GLSL
export const CREST_FRAGMENT = /* glsl */ `
${HILLS_COMMON}
${LOOK_GLSL_BACKING}
uniform vec3 uInk;
uniform vec3 uFar;
uniform vec3 uPaper;
varying float vClear;
varying float vSunk;
void main() {
  float aer = vInkStrand.y;
  float a = inkCoverage() * ehKeep(vWorld) * smoothstep(0.6, 0.95, vClear) * (1.0 - smoothstep(0.1, 0.6, vSunk));
  if (a < 0.003) discard;
  vec3 ink = mix(uInk, uFar, smoothstep(0.0, 0.8, aer));
  gl_FragColor = vec4(backingMix(ink, uPaper, 1.0 - mix(0.95, 0.55, aer)), a);
  #include <colorspace_fragment>
}
`;
