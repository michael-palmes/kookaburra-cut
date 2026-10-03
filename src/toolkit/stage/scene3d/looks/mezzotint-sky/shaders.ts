import { glslFloat, LOOK_GLSL_PRINT } from "../../kit";
import { MEZZO_LAND } from "./land";

/** Aerial depth: land fades to the horizon haze as 1 - exp(-(d / distance) ^ power) of view distance d, so near land stays dense and the far ranges step back fast. */
export const MEZZO_HAZE = { distance: 90, power: 1.5 } as const;
/** The near give-way: land and mist between the camera and the stage that fall inside this box round the stage's projection (half sizes at stage depth, plus a feather) sink to the floor or thin away, nearer than this window of the camera-to-stage distance. */
export const MEZZO_NEAR_CUT = { near: 0.75, far: 0.97, box: [4.6, 2.6], feather: 2 } as const;

/** Land burr cells relative to the dome's: coarser near, where the ground is seen foreshortened, reaching the dome's own cells by the far land so the rim prints the dome's burr. */
export const MEZZO_LAND_BURR = { near: 0.55, from: 40, to: 180 } as const;

const R = glslFloat(MEZZO_LAND.domeRadius);
const NEAR = MEZZO_NEAR_CUT;

/** VERTEX-SAFE. `mezzoInFront(wp)` is 1 where a point stands between the camera and the stage inside the near box round the stage's projection, so land sinks and mist thins there. */
// language=GLSL
const MEZZO_GLSL_NEAR = /* glsl */ `
#ifndef MZ_NEAR
#define MZ_NEAR
float mezzoInFront(vec3 wp) {
  vec3 c = viewMatrix[3].xyz;
  vec3 v = (viewMatrix * vec4(wp, 1.0)).xyz;
  if (c.z > -1e-3 || v.z > -1e-3) return 0.0;
  vec2 q = abs(v.xy * (c.z / v.z) - c.xy) - vec2(${glslFloat(NEAR.box[0])}, ${glslFloat(NEAR.box[1])});
  float inBox = 1.0 - smoothstep(0.0, ${glslFloat(NEAR.feather)}, max(q.x, q.y));
  return inBox * (1.0 - stageFade(wp, ${glslFloat(NEAR.near)}, ${glslFloat(NEAR.far)}));
}
#endif
`;

/** The plate shared by the dome, land and mist: tone 1 is burnished to Burnish, 0 rocked to Ground. `mezzoHorizon` is the dome's haze below its cloud band (glow aside), which the land and mist fade toward with distance; `mezzoCover` prints a tone through the world-fixed burr (F4 screen) at burr cells `p`; `mezzoBurr` maps a land point to those cells log-polar round the stage (coarser near, where the ground is foreshortened), landing on the dome's direction cells at the rim so the two print one burr. */
// language=GLSL
const MEZZO_GLSL = /* glsl */ `
${LOOK_GLSL_PRINT}
${MEZZO_GLSL_NEAR}
const mat3 MZ_TILT = mat3(0.6486, 0.6821, -0.3376, -0.574, 0.7297, 0.3715, 0.4998, -0.0472, 0.8649);
float mezzoHorizon(float k) {
  return clamp(k * 1.15 + 0.06, 0.0, 1.0);
}
float mezzoToward(vec3 p, float sunAz) {
  return 0.5 + 0.5 * cos(atan(p.x, -p.z) - sunAz);
}
vec3 mezzoBurr(vec3 wp, float cells) {
  float r = max(length(wp.xz), 1.5);
  return MZ_TILT * vec3(wp.x / r, log(r / ${R}) + wp.y / r, wp.z / r) * cells * mix(${glslFloat(MEZZO_LAND_BURR.near)}, 1.0, smoothstep(${glslFloat(MEZZO_LAND_BURR.from)}, ${glslFloat(MEZZO_LAND_BURR.to)}, r));
}
float mezzoCover(float tone, vec3 p, float detail) {
  tone = clamp(tone + printGrain(p * 0.3 + 11.0, 1.0) * 0.16 * (0.4 + tone) * detail, 0.0, 1.0);
  float screen = printScreen(p, 1.0, 0.8);
  float guard = printGuard3(p);
  float ink = 1.0 - tone;
  float w = 0.15 + 0.7 * fwidth(screen);
  return mix(ink, smoothstep(screen - w, screen + w, ink), guard * 0.38);
}
`;

/** The sky: a glow band and burnished cloud banks sit high, a smooth haze band holds the horizon and runs on below it (the land covers it), and a world-fixed burr prints the whole dome. */
// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
${MEZZO_GLSL}
uniform vec3 uGround;
uniform vec3 uBurnish;
uniform float uTime;
uniform float uPeriod;
uniform float uKey;
uniform float uCap;
uniform float uCells;
uniform float uCoverShift;
uniform float uGlow;
varying vec3 vSkyDir;
void main() {
  vec3 dir = normalize(vSkyDir);
  float e = dir.y;
  float k = uKey;
  float T = 6.28318530718 * uTime / uPeriod;
  float toward = mezzoToward(dir, 0.35 * sin(T));
  float sky = mix(k * 1.15 + 0.06, k * 0.55, smoothstep(0.2, 0.75, e));
  float glow = exp(-abs(e - 0.27) / 0.09) * mix(0.3, 1.0, toward * toward) * (0.85 + 0.15 * sin(3.0 * T)) * uGlow;
  float ca = cos(T);
  float sa = sin(T);
  vec3 q = vec3(ca * dir.x - sa * dir.z, dir.y, sa * dir.x + ca * dir.z);
  vec3 drift = 0.35 * vec3(cos(3.0 * T), 0.3 * sin(2.0 * T), sin(3.0 * T));
  float band = smoothstep(0.16, 0.3, e) * (1.0 - smoothstep(0.55, 0.85, e));
  float body = 0.0;
  float rim = 0.0;
  if (band > 0.0) {
    float cl = fbm3(vec3(q.x * 2.4, q.y * 7.5, q.z * 2.4) + vec3(3.1, 0.0, 1.7) + drift);
    float c0 = cl - uCoverShift;
    body = smoothstep(0.47, 0.62, c0) * band;
    rim = smoothstep(0.39, 0.47, c0) * (1.0 - smoothstep(0.5, 0.6, c0)) * band;
  }
  float tone = sky + (glow * (0.5 - k * 0.3) - body * (0.1 + k * 0.35) + rim * (0.05 + k * 0.15 + 0.35 * glow));
  tone = clamp(min(tone, uCap), 0.0, 1.0);
  float cover = mezzoCover(tone, MZ_TILT * dir * uCells, 1.0);
  gl_FragColor = vec4(mix(uBurnish, uGround, cover), 1.0);
  #include <colorspace_fragment>
}
`;

/** Land vertex stage: heights scale by Land relief about the floor (and sink to it where they would stand in front of the stage or over a low camera), the normal follows the stored slope. */
// language=GLSL
export const LAND_VERTEX = /* glsl */ `
${MEZZO_GLSL_NEAR}
attribute vec3 aLand;
uniform float uRelief;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
void main() {
  vec4 w = lookWorldPosition(vec3(position.x, ${glslFloat(MEZZO_LAND.floorY)} + position.y * uRelief, position.z));
  float overhead = (1.0 - smoothstep(4.0, 12.0, distance(w.xz, cameraPosition.xz))) * smoothstep(-0.6, 0.0, w.y - cameraPosition.y);
  float relief = uRelief * (1.0 - max(mezzoInFront(w.xyz), overhead));
  w = lookWorldPosition(vec3(position.x, ${glslFloat(MEZZO_LAND.floorY)} + position.y * relief, position.z));
  vWorld = w.xyz;
  vNormalW = lookWorldNormal(vec3(-aLand.x * relief, 1.0, -aLand.y * relief));
  vCrest = aLand.z * min(relief, 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Rocked land: dense Ground shaded by the low glow (slopes facing it lift, crests catching it burnish) under soft cloud shadows turning with the clouds, stepping back to the horizon haze with view distance, printed through the same burr anchored to the land. */
// language=GLSL
export const LAND_FRAGMENT = /* glsl */ `
${MEZZO_GLSL}
uniform vec3 uGround;
uniform vec3 uBurnish;
uniform vec3 uSun;
uniform float uSunAz;
uniform float uBreathe;
uniform float uTime;
uniform float uPeriod;
uniform float uKey;
uniform float uCap;
uniform float uCells;
uniform float uGlow;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
void main() {
  float k = uKey;
  float r = length(vWorld.xz);
  vec3 n = normalize(vNormalW);
  float detail = mix(0.55, 1.0, smoothstep(4.0, 10.0, r));
  float toward = mezzoToward(vWorld, uSunAz);
  float lit = dot(n, uSun) - uSun.y;
  float rim = smoothstep(0.3, 0.85, vCrest) * toward * toward * uGlow * uBreathe;
  float T = 6.28318530718 * uTime / uPeriod;
  vec2 sxz = mat2(cos(T), sin(T), -sin(T), cos(T)) * vWorld.xz / 22.0;
  float sg = 1.0 - smoothstep(0.15, 0.35, length(fwidth(sxz)));
  float shade = sg > 0.0 ? 0.62 * vnoise(sxz + 5.3) + 0.38 * vnoise(sxz * 2.3 + 1.7) - 0.5 : 0.0;
  float tone = k * 0.25 + 0.015 + lit * (0.2 + 0.2 * k) + detail * (rim * (0.2 + 0.25 * k) + shade * sg * (0.22 + 0.25 * k));
  tone = clamp(min(tone, uCap), 0.0, 1.0);
  float haze = max(1.0 - exp(-pow(distance(cameraPosition, vWorld) / ${glslFloat(MEZZO_HAZE.distance)}, ${glslFloat(MEZZO_HAZE.power)})), smoothstep(150.0, 260.0, r));
  tone = mix(tone, mezzoHorizon(k), haze);
  float cover = mezzoCover(tone, mezzoBurr(vWorld, uCells), detail);
  gl_FragColor = vec4(mix(uBurnish, uGround, cover), 1.0);
  #include <colorspace_fragment>
}
`;

/** Mist vertex stage: each sheet rides at its height times Land relief; `vThick` is how far it floats above the land under it. */
// language=GLSL
export const MIST_VERTEX = /* glsl */ `
attribute vec4 aMist;
uniform float uRelief;
varying vec3 vWorld;
varying float vThick;
varying vec3 vBand;
void main() {
  vec4 w = lookWorldPosition(vec3(position.x, ${glslFloat(MEZZO_LAND.floorY)} + position.y * uRelief, position.z));
  vWorld = w.xyz;
  vThick = (position.y - aMist.x) * uRelief;
  vBand = aMist.yzw;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Mist strata: burnished haze in thin sheets, denser seen edge on, wisps turning whole times per Drift period. They thin to nothing where the land rises through them, at their edges, in front of the stage and round the camera. */
// language=GLSL
export const MIST_FRAGMENT = /* glsl */ `
${MEZZO_GLSL}
uniform vec3 uGround;
uniform vec3 uBurnish;
uniform float uTime;
uniform float uPeriod;
uniform float uSunAz;
uniform float uBreathe;
uniform float uKey;
uniform float uCap;
uniform float uGlow;
uniform float uMist;
varying vec3 vWorld;
varying float vThick;
varying vec3 vBand;
void main() {
  float k = uKey;
  float r = length(vWorld.xz);
  float span = vBand.z - vBand.y;
  float edge = smoothstep(vBand.y, vBand.y + 0.45 * span, r) * (1.0 - smoothstep(vBand.z - 0.45 * span, vBand.z, r));
  float contact = smoothstep(0.08, 0.45, vThick);
  float T = 6.28318530718 * uTime / uPeriod;
  float a = T * vBand.x;
  vec2 xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * vWorld.xz;
  vec3 p = vec3(xz / 5.0, r / 3.0 + 0.37 * vBand.y) + 0.35 * vec3(cos(3.0 * T), sin(3.0 * T), 0.3 * sin(2.0 * T));
  float g = 1.0 - smoothstep(0.3, 0.7, length(fwidth(p)));
  float wisp = smoothstep(0.36, 0.6, mix(0.47, fbm3(p), g));
  vec3 v = normalize(cameraPosition - vWorld);
  float tau = uMist * edge * contact * mix(0.1, 1.0, wisp) * 0.35 / max(abs(v.y), 0.05);
  float toward = mezzoToward(vWorld, uSunAz);
  float tone = mezzoHorizon(k) + 0.05 + 0.1 * k + toward * toward * uGlow * uBreathe * (0.12 - 0.06 * k);
  float alpha = (1.0 - exp(-tau)) * (1.0 - mezzoInFront(vWorld)) * smoothstep(2.0, 8.0, distance(cameraPosition, vWorld));
  gl_FragColor = vec4(mix(uGround, uBurnish, clamp(min(tone, uCap), 0.0, 1.0)), alpha);
  #include <colorspace_fragment>
}
`;
