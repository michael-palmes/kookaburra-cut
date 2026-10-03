import { glslFloat, LOOK_GLSL_BACKING } from "../../kit/glsl";
import { LOOK_GLSL_MEDALLION } from "../../kit/medallion";
import { TERRAZZO } from "./inlay";

/** Varyings for the medallion discs: world position only. */
// language=GLSL
export const TERRAZZO_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** One unlit polar inlay for the floor and the optional ceiling: two-tone wedge rays, stepped brass rings, a chevron border and terrazzo chips (floor only), all world-space distances with pixel-floored edges. Ray and chevron contrast falls to its mean at grazing angles and pixel pitch. */
// language=GLSL
export const TERRAZZO_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${LOOK_GLSL_MEDALLION}
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uBrass;
uniform vec3 uBacking;
uniform float uSpin;
uniform float uTurn;
uniform float uRays;
uniform float uClear;
uniform float uGlintRun;
uniform float uArc;
uniform float uGlint;
uniform float uChips;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uDark;
uniform float uCeiling;
uniform float uStrength;
varying vec3 vWorld;
const float BORDER = ${glslFloat(TERRAZZO.border)};
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  float th = atan(p.y, p.x);
  float pxW = max(length(fwidth(p)), 1e-5);
  vec3 V = normalize(cameraPosition - vWorld);
  float graze = smoothstep(0.025, 0.16, abs(V.y));
  float grazeLine = smoothstep(0.05, 0.25, abs(V.y));
  float clearR = uClear + 0.9;
  float turned = th + uSpin * uTurn;

  float a = turned / MED_TAU * uRays;
  float f = fract(a);
  float parity = mod(floor(a), 2.0);
  float dEdge = min(f, 1.0 - f) * MED_TAU * r / uRays;
  float rayMix = aaStep(0.0, (parity * 2.0 - 1.0) * dEdge);
  float aPx = uRays / MED_TAU * pxW / max(r, 1e-3);
  float rayPitch = 1.0 - smoothstep(0.35, 0.7, length(vec2(aPx, 0.2 * pxW)));
  vec3 mean = mix(uA, uB, 0.5);
  vec3 ray = mix(mean, mix(uA, uB, rayMix), graze * rayPitch);
  float inRays = aaStep(clearR, r) * (1.0 - aaStep(18.0, r));

  float u = turned / MED_TAU * uRays * 3.0;
  float zig = r - (19.2 + abs(fract(u) - 0.5) * 2.0);
  float zigPitch = 1.0 - smoothstep(0.35, 0.7, 3.0 * aPx);
  float inBorder = aaStep(18.0, r) * (1.0 - aaStep(BORDER, r));
  float between = aaStep(0.0, zig) * (1.0 - aaStep(1.0, zig));
  vec3 border = mix(uA, uB, mix(0.5, between, graze * zigPitch));

  vec3 base = uBacking;
  base = mix(base, ray, inRays);
  base = mix(base, border, inBorder);
  base = mix(base, mix(uBacking, mean, 0.35), aaStep(BORDER, r) * (1.0 - smoothstep(BORDER + 0.1, max(uFadeEnd * 0.89, BORDER + 1.0), r)));
  base = mix(base, mix(uBacking, uA, 0.25), 1.0 - aaStep(clearR, r));

  float fillet = aaLine(dEdge, 0.035) * grazeLine;
  fillet = mix(min(0.07 / max(MED_TAU * r / uRays, 1e-3), 1.0), fillet, rayPitch);
  float brass = fillet * inRays;
  brass = max(brass, aaLine(r - 18.0, 0.1));
  brass = max(brass, aaLine(r - 17.62, 0.045));
  brass = max(brass, aaLine(r - 11.0, 0.08));
  brass = max(brass, aaLine(r - 10.7, 0.035));
  brass = max(brass, aaLine(r - clearR, 0.09));
  brass = max(brass, aaLine(r - (uClear + 0.55), 0.045));
  brass = max(brass, aaLine(r - (uClear + 0.3), 0.03));
  brass = max(brass, aaLine(r - BORDER, 0.09));
  float chevron = max(aaLine(zig, 0.05), aaLine(zig - 1.0, 0.05));
  brass = max(brass, mix(0.1, chevron, zigPitch) * inBorder);

  float gr = uClear + 17.0 * uGlintRun;
  float arcs = max(medLobe(th, uSpin * uArc, 0.495), medLobe(th, uSpin * uArc + MED_PI, 0.495));
  float glint = exp(-(r - gr) * (r - gr) / 2.56) * arcs * uGlint;
  vec3 brassCol = uBrass * (1.0 + glint * mix(0.9, 0.7, uDark));
  vec3 col = mix(base, brassCol, brass * mix(0.35, 1.0, grazeLine));

  vec2 cp = p / 0.42;
  float chipK = pitchGuard(cp * 3.0) * uChips * (1.0 - uCeiling);
  chipK *= (1.0 - smoothstep(20.0, 26.0, r)) * aaStep(clearR, r);
  if (chipK > 0.0) {
    ivec2 ci = ivec2(floor(cp));
    float h = hash21(ci);
    vec2 off = hash22(ci + ivec2(31, 7)) * 0.6 + 0.2;
    float cr = 0.07 + 0.08 * hash21(ci + ivec2(5, 11));
    float cd = length(fract(cp) - off) * 0.42;
    float chip = (1.0 - smoothstep(cr - pxW, cr + pxW, cd)) * step(0.72, h);
    vec3 chipCol = h > 0.9 ? uBrass : (h > 0.81 ? uA : uB);
    col = mix(col, mix(col, chipCol, 0.7), chipK * chip);
  }

  float fade = smoothstep(uFadeStart, uFadeEnd, r);
  fade = max(fade, 1.0 - uStrength);
  fade = max(fade, uCeiling * medCeilingLeave(vWorld));
  gl_FragColor = vec4(backingMix(col, uBacking, fade), 1.0);
  #include <colorspace_fragment>
}
`;
