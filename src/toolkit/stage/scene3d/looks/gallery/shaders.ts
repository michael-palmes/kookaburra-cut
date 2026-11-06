import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { CLOUD_WAVES, GALLERY, LAMP } from "./bays";

const G = GALLERY;

/** Haze window from the camera: the corridor's far reaches dissolve into the backing. */
export const GALLERY_HAZE = { near: 42, far: 90 } as const;

// language=GLSL
const COMMON = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uPlaster;
uniform vec3 uOak;
uniform vec3 uShade;
uniform vec3 uBrass;
uniform vec3 uLamp;
uniform vec3 uBacking;
uniform float uDark;
uniform float uPitch;
uniform float uPierDepth;
uniform float uLampY;
uniform float uPools;
uniform float uDaylight;
uniform float uClouds;
uniform vec3 uCloud;
varying vec3 vWorld;
const float GA_FLOOR = ${glslFloat(G.floorY)};
const float GA_WALL = ${glslFloat(G.wallZ)};
const float GA_SILL = ${glslFloat(G.sillY)};
const float GA_HEAD = ${glslFloat(G.headY)};
const float GA_PIER_HALF = ${glslFloat(G.pierWidth / 2)};
const float GA_SKIRT = ${glslFloat(G.skirting)};
const float GA_BEAD = ${glslFloat(G.bead)};
const float GA_TAU = 6.283185307179586;
// Plaster under a picture light, and the daylight the clerestory lets in.
vec3 gaPoolTone() { return mix(uPlaster, uLamp, mix(0.82, 0.5, uDark)); }
vec3 gaDayTone() { return mix(uPlaster, uLamp, mix(0.6, 0.2, uDark)); }
// Offset from the nearest bay centre along the wall.
float gaBayX(float x) { return x - floor(x / uPitch + 0.5) * uPitch; }
float gaClearHalf() { return uPitch * 0.5 - GA_PIER_HALF; }
// Passing cloud: travelling waves along the wall, -1..1.
float gaCloudWave(float x) {
  return 0.5 * sin(GA_TAU * (x / ${glslFloat(CLOUD_WAVES[0].length)} - uCloud.x))
    + 0.3 * sin(GA_TAU * (x / ${glslFloat(CLOUD_WAVES[1].length)} - uCloud.y))
    + 0.2 * sin(GA_TAU * (x / ${glslFloat(CLOUD_WAVES[2].length)} - uCloud.z));
}
// Daylight breathing as cloud passes: a gentle gain on everything the clerestory lights.
float gaCloud(float x) { return 1.0 + 0.1 * uDaylight * uClouds * gaCloudWave(x); }
// A picture light's pool on the wall: a soft fan opening from the lamp (it shows above a hung work), a bright bloom at the lamp, a broad glow spilling round the work.
float gaPool(float dx, float y) {
  float below = uLampY - 0.14 - y;
  float b = max(below, 0.0);
  float w = 0.45 + 1.1 * sqrt(b);
  float fan = (1.0 - smoothstep(0.15, 1.0, abs(dx) / w)) * smoothstep(-0.12, 0.12, below) * exp(-b / 2.2);
  float bloom = exp(-(dx * dx + below * below * 1.6) / 0.55);
  float glow = exp(-dx * dx / 9.5 - (below - 1.3) * (below - 1.3) / 7.0);
  return clamp(fan * 0.95 + bloom * 0.5 + glow * 0.36, 0.0, 1.0);
}
// The brighter of the two nearest lamps' pools, so glows meet seamlessly between bays.
float gaPools(float x, float y, float soft) {
  float dx = gaBayX(x);
  return max(gaPool(dx / soft, y), gaPool((dx - sign(dx) * uPitch) / soft, y));
}
// The wall settles toward shade high above the lamps and low by the floor.
float gaFalloff(float y) {
  return 0.3 * smoothstep(uLampY + 0.3, GA_SILL, y) + 0.2 * exp(-(y - GA_FLOOR) * 1.3);
}
// A soft trowelled mottle with pitch-guarded fine grain.
float gaMottle(vec2 q) {
  float m = 0.6 * vnoise(q * 0.4) + 0.4 * vnoise(q * 0.9 + vec2(7.3, 1.9)) - 0.5;
  float fine = (vnoise(q * 9.0) - 0.5) * pitchGuard(q * 9.0);
  return 1.0 + m * 0.05 + fine * 0.025;
}
// The skirting: a shadow gap at the floor with a brass bead above it.
vec3 gaSkirting(vec3 col, float y) {
  float h = y - GA_FLOOR;
  col = mix(col, uShade * 0.8, 1.0 - aaStep(GA_SKIRT, h));
  return mix(col, uBrass * 1.08, aaLine(h - GA_SKIRT - GA_BEAD * 0.5, GA_BEAD * 0.5));
}
vec3 gaHaze(vec3 col, vec3 p) {
  return backingMix(col, uBacking, smoothstep(${glslFloat(GALLERY_HAZE.near)}, ${glslFloat(GALLERY_HAZE.far)}, distance(cameraPosition, p)));
}
`;

/** The hanging wall (bays between the piers, each under its picture light), the strip above the clerestory and the far wall behind the default camera. */
// language=GLSL
export const WALL_FRAGMENT = /* glsl */ `
${COMMON}
void main() {
  vec3 P = vWorld;
  float y = P.y;
  float far = step(0.0, P.z);
  vec3 col = uPlaster * gaMottle(P.xy + vec2(far * 113.0, 0.0));
  float dx = gaBayX(P.x);
  float corner = max(gaClearHalf() - abs(dx), 0.0);
  float occ = (1.0 - far) * exp(-corner / (0.2 + 0.35 * uPierDepth)) * smoothstep(0.1, 0.9, uPierDepth) * 0.3;
  col = mix(col, uShade, occ + gaFalloff(y));
  col = mix(col, gaDayTone(), uDaylight * 0.14 * smoothstep(GA_FLOOR, GA_SILL, y) * (1.0 - far));
  col *= mix(1.0, gaCloud(P.x), 1.0 - far);
  col = mix(col, gaPoolTone(), gaPool(dx, y) * uPools * (1.0 - far));
  col = gaSkirting(col, y);
  col = mix(col, mix(uPlaster, uShade, 0.3), step(GA_HEAD - 0.01, y));
  gl_FragColor = vec4(gaHaze(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Piers between the bays: plaster fronts with crisp arrises, returns in shade (the daylit side lighter) catching a rake of the bay's light, the skirting wrapping round. They go with the wall once the camera passes behind it. */
// language=GLSL
export const PIER_FRAGMENT = /* glsl */ `
${COMMON}
varying vec3 vNormalW;
void main() {
  if (cameraPosition.z < GA_WALL + 0.02) discard;
  vec3 P = vWorld;
  vec3 n = normalize(vNormalW);
  float y = P.y;
  float side = step(0.5, abs(n.x));
  float top = step(0.5, n.y);
  float face = (1.0 - side) * (1.0 - top);
  float xp = (floor(P.x / uPitch) + 0.5) * uPitch;
  float proud = P.z - GA_WALL;
  vec3 col = uPlaster * gaMottle(vec2(P.x + P.z, y) + vec2(31.0, 0.0));
  col = mix(col, gaDayTone(), face * 0.08);
  col = mix(col, uShade, side * mix(0.3, 0.5, step(0.0, n.x)));
  col = mix(col, uShade, side * 0.25 * exp(-proud / 0.18));
  float rake = exp(-pow((y - uLampY + 1.2) / 2.4, 2.0)) * uPools * smoothstep(0.0, 1.0, proud / max(uPierDepth, 0.01));
  col = mix(col, gaPoolTone(), side * rake * 0.2);
  col = mix(col, mix(uPlaster, gaDayTone(), 0.7), face * aaLine(abs(P.x - xp) - GA_PIER_HALF + 0.015, 0.012) * 0.6);
  col = mix(col, gaDayTone(), top * 0.3 * uDaylight);
  col = mix(col, uShade, (1.0 - top) * gaFalloff(y));
  col *= gaCloud(P.x);
  col = gaSkirting(col, y);
  gl_FragColor = vec4(gaHaze(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Oak boards running toward the wall: staggered butt joints, per-plank tone and grain, the pools spilling onto the boards at the wall and a satin reflection of the lit bays. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${COMMON}
uniform float uBoard;
void main() {
  vec3 P = vWorld;
  float bx = P.x / uBoard;
  float bi = floor(bx);
  int ib = int(bi);
  float len = mix(4.5, 8.5, hash21(ivec2(ib, 11)));
  float sz = P.z / len + hash21(ivec2(ib, 23));
  int jb = int(floor(sz));
  float plank = hash21(ivec2(ib, jb));
  vec2 gq = vec2(fract(bx) * 5.0 + bi * 1.7, P.z * 0.7 + plank * 37.0);
  vec2 fq = vec2(fract(bx) * 16.0 + bi * 3.1, P.z * 2.4 + plank * 11.0);
  float grain = (vnoise(gq) - 0.5) * pitchGuard(gq);
  float fine = (vnoise(fq) - 0.5) * pitchGuard(fq);
  float broad = 0.6 * vnoise(P.xz * 0.11) + 0.4 * vnoise(P.xz * 0.27 + vec2(3.7, 8.1)) - 0.5;
  vec3 col = uOak * (1.0 + (plank - 0.5) * 0.18 + grain * 0.18 + fine * 0.09 + broad * 0.08);
  float seam = max(aaLine((fract(bx + 0.5) - 0.5) * uBoard, 0.007), aaLine((fract(sz + 0.5) - 0.5) * len, 0.007));
  col = mix(col, uOak * 0.58, seam * pitchGuard(vec2(bx, sz)) * 0.75);
  float dzw = P.z - GA_WALL;
  float dx = gaBayX(P.x);
  vec3 lit = mix(uOak * mix(1.75, 2.6, uDark), uLamp, mix(0.12, 0.25, uDark));
  float spill = (1.0 - smoothstep(0.3, 1.0, abs(dx) / (1.4 + dzw * 0.5))) * exp(-dzw / 1.2) * uPools;
  col = mix(col, lit, clamp(spill * 0.6 + exp(-dzw / 2.0) * 0.1 * uPools, 0.0, 1.0));
  vec3 V = normalize(P - cameraPosition);
  float pool = 0.0;
  float sky = 0.0;
  if (V.z < -1e-3) {
    float t = (GA_WALL - P.z) / V.z;
    vec3 H = P + vec3(V.x, -V.y, V.z) * t;
    float soft = 1.0 + t * 0.1;
    pool = gaPools(H.x, H.y, soft) * uPools * exp(-t * 0.05);
    sky = step(GA_SILL, H.y) * step(H.y, GA_HEAD) * uDaylight;
  }
  float fres = mix(0.05, 0.5, pow(1.0 - clamp(-V.y, 0.0, 1.0), 5.0));
  col = mix(col, gaPoolTone(), fres * pool * 0.8);
  col = mix(col, gaDayTone(), fres * sky * 0.4);
  col = mix(col, mix(uPlaster, uShade, 0.3), fres * 0.16);
  col *= gaCloud(P.x);
  float xp = (floor(P.x / uPitch) + 0.5) * uPitch;
  vec2 dp = max(vec2(abs(P.x - xp) - GA_PIER_HALF, dzw - uPierDepth), 0.0);
  float occ = max(exp(-dzw / 0.14) * 0.55, exp(-length(dp) / 0.22) * 0.4);
  col = mix(col, uOak * 0.6, occ);
  gl_FragColor = vec4(gaHaze(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Horizontal plaster: the sill catches daylight, the clerestory head and the ceiling sit in shade, the ceiling with a skylight slot along the wall and soft beams over the piers. */
// language=GLSL
export const FLAT_FRAGMENT = /* glsl */ `
${COMMON}
varying vec3 vNormalW;
void main() {
  vec3 P = vWorld;
  float up = step(0.0, normalize(vNormalW).y);
  float ceiling = step(GA_HEAD + 0.5, P.y);
  if (ceiling < 0.5 && cameraPosition.z < GA_WALL + 0.02) discard;
  vec3 col = uPlaster * gaMottle(P.xz + vec2(0.0, 57.0));
  col = mix(col, gaDayTone(), up * 0.45 * uDaylight);
  col *= gaCloud(P.x);
  col = mix(col, uShade, (1.0 - up) * 0.42);
  float slot = ceiling * (aaStep(GA_WALL + 0.35, P.z) - aaStep(GA_WALL + 1.55, P.z));
  col = mix(col, mix(gaDayTone(), uLamp, 0.4), slot * (0.35 + 0.65 * uDaylight));
  col = mix(col, uShade, ceiling * aaLine(gaBayX(P.x + uPitch * 0.5), 0.35) * 0.22);
  gl_FragColor = vec4(gaHaze(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** The clerestory: frosted glass full of daylight, soft leaf shadows swaying across it, mullions in step with the piers. */
// language=GLSL
export const GLASS_FRAGMENT = /* glsl */ `
${COMMON}
uniform float uSway;
void main() {
  vec3 P = vWorld;
  float v = (P.y - GA_SILL) / (GA_HEAD - GA_SILL);
  float cloud = 1.0 + 0.22 * uClouds * gaCloudWave(P.x);
  vec3 sky = mix(uBacking, uLamp, mix(0.7, 0.12, uDark)) * mix(1.0, 0.94, v);
  float sway = 0.22 * sin(GA_TAU * uSway) + 0.07 * sin(GA_TAU * 3.0 * uSway + P.x * 0.3);
  vec2 lq = vec2(P.x * 0.55 + sway, P.y * 0.8);
  float leaves = 0.55 * vnoise(lq) + 0.3 * vnoise(lq * 2.2 + vec2(5.1, 2.7)) + 0.15 * vnoise(lq * 4.7 + vec2(1.3, 9.2));
  float shadow = smoothstep(0.42, 0.72, leaves + (0.35 - v) * 0.35) * pitchGuard(lq * 4.7);
  vec3 leaf = mix(mix(uShade, uPlaster, 0.4), mix(uBacking, uShade, 0.6), uDark);
  vec3 col = mix(sky * cloud, leaf, shadow * 0.45);
  float m = P.x / (uPitch / 3.0) - 0.5;
  float mull = aaLine((fract(m + 0.5) - 0.5) * uPitch / 3.0, 0.06);
  col = mix(col, mix(uShade, uPlaster, mix(0.15, 0.55, uDark)), mull);
  gl_FragColor = vec4(gaHaze(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Lamp parts carry their position in the lamp's own frame, so the can knows where its open end is. */
// language=GLSL
export const BRASS_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vLocal;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vNormalW = lookWorldNormal(normal);
  vLocal = position;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Brass picture lights: shaded by a virtual light from above with a specular streak; the can's lip glows where its lamp spills, its lens fully lit. */
// language=GLSL
export const BRASS_FRAGMENT = /* glsl */ `
${COMMON}
varying vec3 vNormalW;
varying vec3 vLocal;
const vec3 GA_AIM = vec3(${LAMP.aim.map(glslFloat).join(", ")});
const vec3 GA_CAN = vec3(0.0, 0.0, ${glslFloat(LAMP.reach)});
void main() {
  if (cameraPosition.z < GA_WALL + 0.02) discard;
  vec3 n = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(vec3(-0.35, 0.9, 0.45));
  float diff = 0.5 + 0.5 * dot(n, L);
  float spec = pow(max(dot(n, normalize(L + V)), 0.0), 30.0);
  vec3 col = uBrass * mix(0.38, 1.18, diff);
  col = mix(col, mix(uBrass, uLamp, 0.75), spec * 0.85);
#ifdef GA_LENS
  float along = dot(vLocal - GA_CAN, GA_AIM) / ${glslFloat(LAMP.canLength / 2)};
  float on = 0.35 + 0.65 * uPools;
  col = mix(col, mix(uBrass, uLamp, 0.8), smoothstep(0.55, 0.9, along) * on * 0.85);
  col = mix(col, uLamp, smoothstep(0.85, 0.97, dot(n, GA_AIM)) * on);
#endif
  gl_FragColor = vec4(gaHaze(col, vWorld), 1.0);
  #include <colorspace_fragment>
}
`;
