import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { MAX_JOINTS } from "./mobiles";

/** F11 window shared by paddles and wires: the near half of the front mobile vanishes on a dolly out. */
export const MOBILE_FADE = { near: 0.72, far: 0.96 } as const;

const FADE = `${glslFloat(MOBILE_FADE.near)}, ${glslFloat(MOBILE_FADE.far)}`;

/** Unlit two-sided paddles: half-Lambert from a fixed virtual sun, shaded toward the backing (lit faces in light presets, dark faces in dark ones), hazed with distance. */
export const PADDLE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uLight;
uniform vec2 uHaze;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vInstanceColor;
void main() {
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float lit = clamp(dot(n, uSun) * 0.5 + 0.5, 0.0, 1.0);
  float shade = mix(1.0 - lit, lit, uLight) * 0.3;
  float haze = uHaze.y * smoothstep(uHaze.x, uHaze.x * 2.2, distance(cameraPosition, vWorld));
  vec3 col = backingMix(vInstanceColor, uBacking, shade + haze);
  float a = stageCut(vWorld, ${FADE});
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Wire path: the path param's x is a joint index into the CPU-posed joint array. */
export const WIRE_PATH = /* glsl */ `
uniform vec3 uJoint[${MAX_JOINTS}];
vec3 inkPath(vec4 p) { return uJoint[int(p.x + 0.5)]; }
`;

/** Wires: thin ink in the Wire colour; hanging threads (strand kind 1) fade toward the ceiling. */
export const WIRE_FRAGMENT = /* glsl */ `
uniform vec3 uWire;
void main() {
  float up = vInkStrand.x > 0.5 ? 1.0 - smoothstep(0.1, 1.0, vInkAlong) : 1.0;
  float a = inkCoverage() * up * stageFade(vWorld, ${FADE});
  if (a < 0.003) discard;
  gl_FragColor = vec4(uWire, a);
  #include <colorspace_fragment>
}
`;
