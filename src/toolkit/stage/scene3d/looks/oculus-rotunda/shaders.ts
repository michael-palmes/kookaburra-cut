import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_GOBO } from "../../kit";
import { DISC_EDGE, DRUM_TOP } from "./rotunda";

// language=GLSL
const COMMON = /* glsl */ `
${LOOK_GLSL_BACKING}
${LOOK_GLSL_GOBO}
uniform vec3 uStone;
uniform vec3 uShade;
uniform vec3 uSun;
uniform vec3 uBacking;
uniform float uDark;
uniform vec3 uBeam;
uniform float uRadius;
uniform float uOculusY;
uniform float uDisc;
varying vec3 vWorld;
const float OR_TAU = 6.283185307179586;
const float OR_PI = 3.141592653589793;
// Light presets read stone as the field and shade as the accent; dark presets weight walls toward shade.
vec3 orTone(float lightK, float darkK) { return mix(uStone, uShade, mix(lightK, darkK, uDark)); }
vec3 orLine() { return mix(uShade, uStone, uDark); }
float orInk(float d, float hw, float w) {
  float hwe = max(hw, w * 0.75);
  return (1.0 - smoothstep(hwe - w, hwe + w, abs(d))) * clamp(hw / hwe, 0.0, 1.0);
}
float orStep(float edge, float x, float w) { return smoothstep(edge - w, edge + w, x); }
float orGuard(vec2 cellsPerPx) { return 1.0 - smoothstep(0.35, 0.7, length(cellsPerPx)); }
// Analytic sun disc: how far the fragment sits inside the beam cast from the oculus (x the disc, y its soft spill).
vec2 orSunPatch(vec3 p) {
  vec3 v = p - vec3(0.0, uOculusY, 0.0);
  float along = dot(v, uBeam);
  float perp = length(v - along * uBeam);
  float on = step(0.0, along);
  float disc = 1.0 - smoothstep(uDisc * ${glslFloat(2 - DISC_EDGE)}, uDisc * ${glslFloat(DISC_EDGE)}, perp);
  return on * vec2(disc, 1.0 - smoothstep(uDisc, uDisc * 4.0, perp));
}
vec3 orFinish(vec3 col, vec3 p) {
  vec2 sp = orSunPatch(p);
  col = mix(col, uSun, clamp(sp.x * mix(0.8, 0.68, uDark) + sp.y * mix(0.3, 0.1, uDark), 0.0, 1.0));
  return backingMix(col, uBacking, smoothstep(30.0, 55.0, length(cameraPosition)) * 0.55);
}
`;

/** Drum: fluted pilasters with alternate round-headed niches and panels, a plinth, a cornice and a panelled attic. */
// language=GLSL
export const DRUM_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform float uBays;
void main() {
  vec3 P = vWorld;
  float y = P.y;
  vec2 turns = goboTurns(P);
  vec2 tw = goboTurnsWidth(P);
  float bw = OR_TAU * uRadius / uBays;
  float u = turns.x * uBays;
  float bay = floor(u);
  float xw = (fract(u) - 0.5) * bw;
  float wx = tw.x * uBays * bw;
  float wy = max(tw.y, 1e-5);
  float w = max(max(wx, wy), 1e-5);
  float lower = step(y, 10.0);
  float pil = 1.0 - orStep(0.7, abs(xw), wx);
  float flute = 0.5 + 0.5 * cos(xw / 0.7 * 3.5 * OR_TAU);
  float fg = orGuard(vec2(wx * 5.0, wy));
  vec3 pilCol = mix(orTone(0.0, 0.46), orTone(0.28, 0.66), flute * fg + 0.5 * (1.0 - fg));
  float nicheOn = mod(bay, 2.0);
  vec2 nq = vec2(xw, y - 5.0);
  float nd = nq.y < 0.0 ? max(abs(nq.x) - 1.3, -nq.y - 6.2) : length(nq) - 1.3;
  float niche = (1.0 - orStep(0.0, nd, w)) * nicheOn * lower;
  float nicheEdge = orInk(nd, 0.05, w) * nicheOn * lower;
  vec3 wall = orTone(0.09, 0.72);
  wall = mix(wall, orTone(0.44, 0.84), niche);
  wall = mix(wall, orLine(), nicheEdge * 0.3);
  float panel = orInk(max(abs(xw) - 1.55, abs(y - 4.0) - 5.0), 0.04, w) * (1.0 - nicheOn) * lower;
  wall = mix(wall, orLine(), panel * 0.3);
  vec3 col = mix(wall, pilCol, pil * lower);
  col = mix(col, orTone(0.12, 0.74), 1.0 - orStep(-1.2, y, wy));
  float cornice = orStep(10.0, y, wy) * (1.0 - orStep(11.2, y, wy));
  col = mix(col, orTone(0.12, 0.4), cornice);
  col = mix(col, orLine(), max(orInk(y - 10.0, 0.06, wy), orInk(y - 11.2, 0.05, wy)) * 0.5);
  float attic = orStep(11.2, y, wy);
  float xa = (fract(u * 2.0) - 0.5) * bw * 0.5;
  float wa = wx * 0.5;
  float apil = 1.0 - orStep(0.35, abs(xa), wa);
  float apanel = orInk(max(abs(xa) - 0.9, abs(y - 15.2) - 2.6), 0.035, max(wa, wy));
  vec3 atticCol = mix(orTone(0.14, 0.74), orTone(0.22, 0.5), apil);
  atticCol = mix(atticCol, orLine(), apanel * 0.35);
  col = mix(col, atticCol, attic);
  col = mix(col, orLine(), orInk(y - ${glslFloat(DRUM_TOP - 0.6)}, 0.07, wy) * 0.5);
  gl_FragColor = vec4(orFinish(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Dome: five rings of stepped coffers diminishing toward the oculus, their lips lit toward the sun disc, studs breathing in dark presets. */
// language=GLSL
export const DOME_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform float uCoffers;
uniform float uStuds;
uniform float uTime;
void main() {
  vec3 P = vWorld;
  vec3 q = P - vec3(0.0, ${glslFloat(DRUM_TOP)}, 0.0);
  float beta = degrees(asin(clamp(q.y / uRadius, -1.0, 1.0)));
  vec2 turns = goboTurns(q);
  float u = turns.x * uCoffers;
  float rowf = (beta - 3.0) / 10.0;
  float row = floor(rowf);
  vec2 cell = vec2(fract(u) - 0.5, fract(rowf) - 0.5);
  float inRows = step(0.0, rowf) * step(rowf, 5.0);
  float phi = turns.x * OR_TAU - OR_PI;
  float phiSun = atan(uBeam.z, uBeam.x);
  float dphi = mod(phiSun - phi + OR_PI, OR_TAU) - OR_PI;
  vec2 L = normalize(vec2(clamp(dphi * 2.0, -1.0, 1.0) * 0.8, 1.0));
  float guard = orGuard(vec2(goboTurnsWidth(q).x * uCoffers, fwidth(rowf)) * 4.0);
  vec3 rib = orTone(0.08, 0.38);
  vec2 a = abs(cell);
  float m = max(a.x / 0.44, a.y / 0.42);
  float stepIdx = floor((m - 0.55) / 0.15);
  float inCoffer = 1.0 - aaStep(1.0, m);
  vec2 n = a.x / 0.44 > a.y / 0.42 ? vec2(-sign(cell.x), 0.0) : vec2(0.0, -sign(cell.y));
  float lit = dot(n, L);
  vec3 lipCol = mix(orTone(0.3, 0.55), orTone(0.62, 0.9), 0.5 - 0.5 * lit);
  vec3 floorCol = orTone(0.42, 0.88);
  vec3 cof = m < 0.55 ? floorCol : mix(lipCol, floorCol, clamp(stepIdx / 3.0, 0.0, 1.0) * 0.35);
  float stepLines = orInk(fract((m - 0.55) / 0.15) - 0.5, 0.06, fwidth(m) / 0.15) * step(0.55, m) * 0.25;
  cof = mix(cof, uShade, stepLines * guard);
  vec3 meanCof = orTone(0.36, 0.7);
  vec3 col = mix(rib, mix(meanCof, cof, guard), inCoffer * inRows);
  ivec2 ci = ivec2(int(floor(u)) + 64, int(row) + 8);
  float ph = hash21(ci);
  float per = ph < 0.33 ? 6.0 : (ph < 0.66 ? 8.0 : 10.0);
  float breath = 0.55 + 0.45 * sin(uTime * OR_TAU / per + hash21(ci + ivec2(17, 3)) * OR_TAU);
  vec2 sq = cell * vec2(cos(radians(beta)), 1.0) * vec2(4.9, 3.84) / 3.84;
  float stud = (1.0 - aaStep(0.07, length(sq))) * inRows;
  col = mix(col, uSun, clamp(stud * uStuds * 0.85 * breath * guard, 0.0, 1.0));
  col = mix(col, orTone(0.1, 0.45), step(5.0, rowf));
  float ring = 90.0 - degrees(asin(${glslFloat(4)} / uRadius)) - 3.0;
  col = mix(col, orLine(), orInk(beta - ring, 0.35, fwidth(beta)) * 0.6);
  gl_FragColor = vec4(orFinish(col, P), 1.0);
  #include <colorspace_fragment>
}
`;

/** Oculus: the open sky as a small emissive disc. */
// language=GLSL
export const OCULUS_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uSun;
uniform vec3 uBacking;
uniform float uOpen;
varying vec3 vWorld;
void main() {
  float r = length(vWorld.xz) / uOpen;
  vec3 col = mix(uSun, mix(uSun, uBacking, 0.35), smoothstep(0.2, 1.0, r));
  col = backingMix(col, uBacking, smoothstep(30.0, 55.0, length(cameraPosition)) * 0.55);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Floor: squares framing alternate circles and squares, clear under the stage, a darker rim at the wall. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${COMMON}
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  vec2 g = p / 3.2;
  ivec2 gi = ivec2(floor(g));
  vec2 f = fract(g) - 0.5;
  float parity = mod(float(gi.x + gi.y), 2.0);
  float fd = max(abs(f.x), abs(f.y)) - 0.5;
  float frame = orInk(fd, 0.025, fwidth(fd));
  float circ = 1.0 - aaStep(0.36, length(f));
  float sq = 1.0 - aaStep(0.3, max(abs(f.x), abs(f.y)));
  float inlay = parity > 0.5 ? circ : sq;
  float guard = pitchGuard(g * 2.0);
  float clear = smoothstep(6.0, 8.5, r);
  vec3 base = orTone(0.1, 0.76);
  vec3 inl = parity > 0.5 ? orTone(0.26, 0.66) : orTone(0.18, 0.7);
  vec3 col = mix(base, inl, inlay * guard * clear);
  col = mix(col, mix(base, inl, 0.25), (1.0 - guard) * clear);
  col = mix(col, orLine(), frame * 0.2 * guard * clear);
  col = mix(col, orTone(0.12, 0.76), smoothstep(uRadius - 1.2, uRadius, r));
  col = backingMix(col, uBacking, smoothstep(30.0, 55.0, length(cameraPosition)) * 0.55);
  if (r > uRadius) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
