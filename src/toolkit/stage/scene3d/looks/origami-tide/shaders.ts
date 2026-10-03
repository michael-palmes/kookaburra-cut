import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { ORIGAMI } from "./origami";

const [W1, W2] = ORIGAMI.waves;

/** The wall, folded in the vertex stage from closed-form Miura-ori (`otFold` mirrors `origamiFold`, the position mirrors `origamiVertex`). */
// language=GLSL
export const WALL_VERTEX: string = /* glsl */ `
const float OT_TAU = 6.28318530718;
attribute vec2 aIJ;
uniform float uPhase;
uniform float uAmp;
uniform float uRadius;
uniform float uStep;
uniform float uRowPitch;
uniform float uScale;
varying vec3 vWorld;
varying vec3 vFlat;
varying vec2 vIJ;
varying float vFold;
float otFold(float phi, float y) {
  float ph = OT_TAU * uPhase;
  float w1 = sin(${glslFloat(W1.crests)} * phi - ${glslFloat(W1.passes)} * ph + 0.45 * y);
  float w2 = sin(${glslFloat(W2.crests)} * phi - ${glslFloat(W2.passes)} * ph + 1.3 - 0.3 * y);
  float w = smoothstep(0.25, 0.95, 0.5 + 0.5 * (0.6 * w1 + 0.4 * w2));
  float tide = uAmp * smoothstep(-2.2, 0.8, y);
  return clamp(${glslFloat(ORIGAMI.base)} * smoothstep(-2.6, 0.0, y) + tide * w, 0.0, 1.0);
}
void main() {
  float i = aIJ.x;
  float j = aIJ.y;
  float y = ${glslFloat(ORIGAMI.bottom)} + j * uRowPitch;
  float phi0 = i * uStep / uRadius;
  float f = otFold(phi0, y);
  float psi = f * ${glslFloat((ORIGAMI.psiMaxDeg * Math.PI) / 180)};
  float h = ${glslFloat(ORIGAMI.depth)} * uScale * sin(psi);
  float p = ${glslFloat(ORIGAMI.leg * Math.cos((ORIGAMI.alphaDeg * Math.PI) / 180))} * uScale / cos(psi);
  float phi = (i * uStep + p * mod(j, 2.0)) / uRadius;
  float r = uRadius - h * mod(i, 2.0);
  vec4 w = modelMatrix * vec4(r * sin(phi), y, r * cos(phi), 1.0);
  vWorld = w.xyz;
  vFlat = normalize(mat3(modelMatrix) * -vec3(sin(phi), 0.0, cos(phi)));
  vIJ = aIJ;
  vFold = f;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Flat facet normals from derivatives against the raking sun: facets turned from it fall to the crease shade, facets turned to it rise to paper, relaxed paper rests at the base tone (a dark backing sinks both, the base furthest). Pitch guard, foot fade, a hard near cut and a cutaway wherever the camera sees the wall from outside. */
// language=GLSL
export const WALL_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uPaper;
uniform vec3 uShade;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uSink;
varying vec3 vWorld;
varying vec3 vFlat;
varying vec2 vIJ;
varying float vFold;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float guard = pitchGuard(vIJ * 1.5);
  float fade = stageFade(vWorld, 0.78, 0.97);
  float inside = dot(normalize(vFlat), normalize(cameraPosition - vWorld));
  float a = stageCut(vWorld, 0.78, 0.97) * aaStep(0.0, inside);
  if (a < 0.01) discard;
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  vec3 l = normalize(uSun);
  float rel = dot(n, l) - dot(normalize(vFlat), l);
  float lift = clamp(rel * 1.4, 0.0, 1.0) * guard;
  float dark = clamp(-rel * 1.4, 0.0, 1.0) * guard;
  vec3 base = backingMix(uPaper, uBacking, uSink);
  vec3 paper = backingMix(uPaper, uBacking, 0.4 * uSink);
  vec3 col = mix(base, paper, lift);
  col = mix(col, uShade, dark);
  col = mix(col, mix(base, mix(paper, uShade, 0.5), 0.8 * vFold), 1.0 - guard);
  float foot = 1.0 - smoothstep(-2.8, -1.1, vWorld.y);
  col = backingMix(col, uBacking, 0.85 * foot);
  col = backingMix(col, uBacking, 1.0 - smoothstep(0.5, 1.0, fade));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;
