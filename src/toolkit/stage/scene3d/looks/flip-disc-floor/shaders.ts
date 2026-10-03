import { glslFloat, LOOK_GLSL_BACKING } from "../../kit/glsl";
import { LOOK_GLSL_INSTANCE_ANCHOR } from "../../kit/instanced";
import { LOOK_GLSL_MEDALLION } from "../../kit/medallion";
import { FLIP } from "./board";

/** Which board a material draws (both stages): `uSide` 1 is the floor, -1 the ceiling (mirrored, facing down) at `uLevel`. `fdFade` lands the far board on the backing; the ceiling also leaves near the camera, on a dolly out and with its strength. */
// language=GLSL
const PLANE = /* glsl */ `
${LOOK_GLSL_MEDALLION}
uniform float uSide;
uniform float uLevel;
uniform float uStrength;
float fdFade(vec3 wp, float r) {
  float haze = smoothstep(${glslFloat(FLIP.hazeStart)}, ${glslFloat(FLIP.hazeEnd)}, r);
  return max(haze, step(uSide, 0.0) * max(medCeilingLeave(wp), 1.0 - uStrength));
}
`;

/** Weather field (both stages): three travelling plane waves through a slow domain warp, integer time frequencies so the loop is exact, minus the clearing. The ceiling reads it mirrored and shifted. Positive shows Face. Mirrored by `flipField`. */
// language=GLSL
const FIELD = /* glsl */ `
const float FD_TAU = 6.28318530718;
uniform float uPhase;
uniform float uBias;
uniform float uClear;
uniform float uFront;
float fdField(vec2 p) {
  vec2 p0 = vec2(p.x * uSide, p.y) / uFront;
  float ph = uPhase + (1.0 - uSide) * ${glslFloat(FLIP.ceilingShift / 2)};
  vec2 q = p0 + 2.6 * vec2(sin(p0.y / 7.0 + ph + 0.7), sin(p0.x / 8.5 - 2.0 * ph + 2.1));
  float s1 = sin(dot(q, vec2(0.940, 0.342)) * FD_TAU / 19.0 - 4.0 * ph + 0.4);
  float s2 = sin(dot(q, vec2(-0.500, 0.866)) * FD_TAU / 14.0 - 5.0 * ph + 2.3);
  float s3 = sin(dot(q, vec2(-0.208, -0.978)) * FD_TAU / 23.0 - 3.0 * ph + 4.9);
  float f = 0.45 * s1 + 0.33 * s2 + 0.3 * s3 - uBias;
  return f - 1.6 * (1.0 - smoothstep(uClear, uClear + 2.5, length(p)));
}
`;

/** Shared tones (fragment): past the calm radius fronts settle to one quiet tone; a cell's mean is disc over board at the disc share. */
// language=GLSL
const TONES = /* glsl */ `
uniform vec3 uFace;
uniform vec3 uBack;
uniform vec3 uBoard;
uniform vec3 uBacking;
float fdQuiet(float r) {
  return smoothstep(${glslFloat(FLIP.calmStart)}, ${glslFloat(FLIP.calmEnd)}, r);
}
vec3 fdMean(float flip, float quiet) {
  return mix(uBoard, mix(uBack, uFace, mix(flip, 0.25, quiet)), ${glslFloat(Math.PI * FLIP.discShare * FLIP.discShare)});
}
`;

/** Both boards: world position only. */
// language=GLSL
export const BOARD_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Board: plain between the discs, settling to the cell mean (sharing the field) once the gaps near a pixel and past the reach. */
// language=GLSL
export const BOARD_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${PLANE}
${FIELD}
${TONES}
uniform float uSnap;
uniform float uPitch;
uniform float uReach;
varying vec3 vWorld;
void main() {
  float r = length(vWorld.xz);
  float px = length(fwidth(vWorld.xz)) / uPitch;
  float g = max(smoothstep(0.08, 0.2, px), smoothstep(uReach - 10.0, uReach - 1.0, r));
  float fade = fdFade(vWorld, r);
  vec3 col = uBoard;
  if (g > 0.0 && fade < 0.999) {
    float flip = smoothstep(-uSnap, uSnap, fdField(vWorld.xz));
    col = mix(uBoard, fdMean(flip, fdQuiet(r)), g);
  }
  gl_FragColor = vec4(backingMix(col, uBacking, fade), 1.0);
  #include <colorspace_fragment>
}
`;

/** Disc: one instanced unit quad posed from the field at its cell centre, a half turn about a fixed axle through its centre, so one half sinks into the board as it flips. Discs collapse once hidden or when the camera passes to the board's far side. */
// language=GLSL
export const DISC_VERTEX = /* glsl */ `
${LOOK_GLSL_INSTANCE_ANCHOR}
${PLANE}
${FIELD}
uniform float uR;
uniform float uSnap;
uniform float uAxle;
varying vec2 vDisc;
varying vec3 vN;
varying float vFlip;
varying float vR;
varying float vFade;
void main() {
  vec3 a = lookInstanceAnchor();
  vec3 anchor = (modelMatrix * vec4(a.x, uLevel, a.z, 1.0)).xyz;
  vR = length(a.xz);
  vFade = fdFade(anchor, vR);
  vDisc = position.xz;
  vN = vec3(0.0, 1.0, 0.0);
  vFlip = 0.0;
  if (vFade > 0.999 || (cameraPosition.y - anchor.y) * uSide < 0.25) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float flip = smoothstep(-uSnap, uSnap, fdField(a.xz));
  float th = 3.14159265 * flip;
  vec3 ax = vec3(cos(uAxle), 0.0, -sin(uAxle));
  vec3 bx = vec3(sin(uAxle), 0.0, cos(uAxle));
  vec3 up = vec3(0.0, 1.0, 0.0);
  float u = dot(position, ax);
  float v = dot(position, bx);
  vec3 rest = vec3(a.x, uLevel + uSide * ${glslFloat(FLIP.lift)}, a.z);
  vec3 wp = rest + (ax * u + (bx * cos(th) + up * (uSide * sin(th))) * v) * uR;
  vN = mat3(modelMatrix) * (up * cos(th) - bx * (uSide * sin(th)));
  vDisc = vec2(u, v);
  vFlip = flip;
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(wp, 1.0));
}
`;

/** Disc face: an antialiased circle (alpha to coverage), Back on the side that faces the room at rest and Face behind it, shaded by a fixed virtual sun (mirrored for the ceiling); under about two pixels it settles to the cell mean. */
// language=GLSL
export const DISC_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${TONES}
uniform float uSide;
uniform vec3 uSun;
uniform float uReach;
varying vec2 vDisc;
varying vec3 vN;
varying float vFlip;
varying float vR;
varying float vFade;
void main() {
  float d = length(vDisc);
  float pxu = max(length(fwidth(vDisc)), 1e-4);
  float cover = 1.0 - smoothstep(1.0 - pxu, 1.0 + pxu, d);
  vec3 base = gl_FrontFacing == (uSide > 0.0) ? uBack : uFace;
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float lam = clamp(dot(n, normalize(uSun * vec3(1.0, uSide, 1.0))) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(mix(base, uBoard, 0.35), base, lam);
  float quiet = fdQuiet(vR);
  col = mix(col, mix(uBack, uFace, 0.25), quiet);
  float g = max(smoothstep(0.44, 1.22, pxu), smoothstep(uReach - 10.0, uReach - 1.0, vR));
  col = mix(col, fdMean(vFlip, quiet), g);
  float a = mix(cover, 1.0, g);
  if (a < 0.02) discard;
  gl_FragColor = vec4(backingMix(col, uBacking, vFade), a);
  #include <colorspace_fragment>
}
`;
