import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { BAR_GAP, ROD_TOP } from "./spinners";

/** F11 window shared by every part: spinners between the camera and the stage vanish on a dolly out. */
export const SPINNER_FADE = { near: 0.72, far: 0.96 } as const;

const FADE = `${glslFloat(SPINNER_FADE.near)}, ${glslFloat(SPINNER_FADE.far)}`;

// Fog toward the backing with distance from the stage axis, shared by bars and hubs.
const FOG = /* glsl */ `
uniform vec2 uFog;
float hsFog(vec3 wp) { return uFog.y * smoothstep(uFog.x, uFog.x + 26.0, length(wp.xz)); }
`;

/** Bars posed from (spinner, bar, helix) and the loop phase: helix A turns `aBar.w` times a loop, helix B once more the other way. */
export const BAR_VERTEX = /* glsl */ `
attribute vec4 aSp;
attribute vec4 aBar;
uniform float uPhase;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHelix;
varying float vPitch;
void main() {
  bool helixB = aBar.z > 0.5;
  float sgn = helixB ? -1.0 : 1.0;
  float turns = helixB ? aBar.w + 1.0 : aBar.w;
  float th = sgn * (aBar.y + turns * uPhase) + aSp.w;
  float c = cos(th);
  float s = sin(th);
  vec3 q = position * vec3(aSp.z, 1.0, 1.0);
  vec3 p = vec3(q.x * c + q.z * s, q.y, -q.x * s + q.z * c);
  vec3 n = vec3(normal.x * c + normal.z * s, normal.y, -normal.x * s + normal.z * c);
  vec4 w = modelMatrix * vec4(p + vec3(aSp.x, aBar.x, aSp.y), 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  vHelix = aBar.z;
  vec4 mv = viewMatrix * w;
  vPitch = smoothstep(2.0, 5.0, ${glslFloat(BAR_GAP)} * exportPxPerUnit(-mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

/** Unlit two-sided bars: half-Lambert from a fixed sun shaded toward the backing (lit faces in light presets, dark faces in dark ones); bars under a few pixels apart settle to the helix mean, far spinners fog toward the backing. */
export const BAR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${FOG}
uniform vec3 uHelixA;
uniform vec3 uHelixB;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uLight;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHelix;
varying float vPitch;
void main() {
  vec3 n = normalize(vNormalW);
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  float lam = clamp(dot(n, uSun) * 0.5 + 0.5, 0.0, 1.0);
  float shade = mix(1.0 - lam, lam, uLight) * 0.5;
  shade = mix(0.25, shade, vPitch);
  vec3 face = vHelix < 0.5 ? uHelixA : uHelixB;
  vec3 col = backingMix(face, uBacking, shade + hsFog(vWorld));
  float a = stageCut(vWorld, ${FADE});
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Motor hubs capping each spinner, in the Rod colour. */
export const HUB_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${FOG}
uniform vec3 uRod;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uLight;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  float lam = clamp(dot(normalize(vNormalW), uSun) * 0.5 + 0.5, 0.0, 1.0);
  float shade = mix(1.0 - lam, lam, uLight) * 0.4;
  vec3 col = backingMix(uRod, uBacking, shade + hsFog(vWorld));
  float a = stageCut(vWorld, ${FADE});
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Rods: F2 ink up each spinner's axis into the dark, fading above its top (strand data x). */
export const ROD_FRAGMENT = /* glsl */ `
uniform vec3 uRod;
uniform float uOpacity;
void main() {
  float top = vInkStrand.x;
  float s = clamp((vWorld.y - top) / (${glslFloat(ROD_TOP)} - top), 0.0, 1.0);
  float a = uOpacity * inkCoverage() * (1.0 - smoothstep(0.0, 0.7, s));
  a *= stageFade(vWorld, ${FADE});
  if (a < 0.003) discard;
  gl_FragColor = vec4(uRod, a);
  #include <colorspace_fragment>
}
`;
