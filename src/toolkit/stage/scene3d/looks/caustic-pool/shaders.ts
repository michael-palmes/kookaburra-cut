import { glslFloat, LOOK_GLSL_BACKING } from "../../kit/glsl";
import { CAUSTIC_TURNS, POOL } from "./pool";

/** Both planes: world position only. */
// language=GLSL
export const POOL_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Iterated turbulence (after Dave_Hoskins' tileable water caustic), 2 PI periodic in space and in the loop phase. Each iteration's phase arrives as (cos, sin) in `uTurn`, so the loop needs only the trig of the warped point; `dir` -1 runs the field in reverse. Mirrored by `causticAtTurns` in pool.ts. */
// language=GLSL
const CAUSTIC = /* glsl */ `
const float CP_TAU = 6.28318530718;
uniform vec2 uTurn[${CAUSTIC_TURNS.length}];
float cpCaustic(vec2 p, float dir) {
  vec2 ci = cos(p);
  vec2 si = sin(p);
  float c = 1.0;
  for (int n = 0; n < ${CAUSTIC_TURNS.length}; n++) {
    float ct = uTurn[n].x;
    float st = dir * uTurn[n].y;
    vec2 i = p + vec2(ct * ci.x + st * si.x + st * ci.y + ct * si.y, st * ci.y - ct * si.y + ct * ci.x - st * si.x);
    ci = cos(i);
    si = sin(i);
    float sx = si.x * ct + ci.x * st;
    float cy = ci.y * ct - si.y * st;
    c += abs(sx * cy) / (1.25 * sqrt(sx * sx + cy * cy) + 1e-5);
  }
  c /= ${glslFloat(CAUSTIC_TURNS.length)};
  float k = abs(1.17 - pow(c, 1.4));
  k *= k;
  k *= k;
  return k * k;
}
`;

/** Pool floor: tiles with faint grout (fading to its mean coverage under a pixel), a hint of per-tile tone, and soft caustic nets mixed toward the Caustic slot, strongest just past the clearing and thinning outward. A long fade lands on the backing so the horizon is a gradient. Caustic work is skipped where the guard or the fade already hides it. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${CAUSTIC}
uniform vec3 uTile;
uniform vec3 uGrout;
uniform vec3 uCaustic;
uniform vec3 uBacking;
uniform float uTileSize;
uniform float uGroutMix;
uniform float uScale;
uniform float uStrength;
uniform float uClear;
varying vec3 vWorld;
void main() {
  vec2 xz = vWorld.xz;
  float r = length(xz);

  vec2 tc = xz / uTileSize;
  vec2 gd = abs(fract(tc + 0.5) - 0.5);
  float hw = 0.024 / uTileSize;
  vec2 fw = max(fwidth(tc), vec2(1e-5));
  vec2 lineAA = 1.0 - smoothstep(hw - fw, hw + fw, gd);
  float grout = max(lineAA.x, lineAA.y);
  float gGuard = 1.0 - smoothstep(hw * 1.5, hw * 5.0, length(fw));
  grout = mix(4.0 * hw * (1.0 - hw), grout, gGuard);
  float tileVar = (hash21(ivec2(floor(tc))) - 0.5) * 0.06 * pitchGuard(tc);
  vec3 col = mix(uTile, uGrout, clamp(grout * uGroutMix + tileVar + 0.03, 0.0, 1.0));

  vec2 p = xz * (CP_TAU / uScale);
  float cGuard = 1.0 - smoothstep(0.25, 0.9, length(fwidth(p)));
  float fade = pow(smoothstep(${glslFloat(POOL.fadeStart)}, ${glslFloat(POOL.fadeEnd)}, r), 0.7);
  float grazing = 1.0 - smoothstep(0.015, 0.2, abs(normalize(cameraPosition - vWorld).y));
  fade = max(fade, grazing * grazing);
  float cs = 0.18;
  if (cGuard > 0.0 && fade < 0.985) {
    float s = cpCaustic(p + vec2(0.03, 0.01), 1.0) + cpCaustic(p + vec2(-0.01, 0.03), 1.0);
    cs = mix(0.18, 0.5 * s, cGuard);
  }
  float ring = mix(0.12, 1.0, smoothstep(uClear - 2.5, uClear + 2.5, r));
  ring *= mix(1.0, 0.3, smoothstep(uClear + 4.0, 32.0, r));
  col = mix(col, uCaustic, clamp(cs * ring * uStrength, 0.0, 0.7));
  gl_FragColor = vec4(backingMix(col, uBacking, fade), 1.0);
  #include <colorspace_fragment>
}
`;

/** Rippled surface overhead, facing down so it shows only from below: the same field run in reverse at a broader scale, as soft light over the backing. Fades near the camera and into the far haze. */
// language=GLSL
export const SURFACE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${CAUSTIC}
uniform vec3 uCaustic;
uniform vec3 uBacking;
uniform float uScale;
uniform float uSurface;
varying vec3 vWorld;
void main() {
  float r = length(vWorld.xz);
  vec2 p = vWorld.xz * (CP_TAU / (uScale * ${glslFloat(POOL.surfaceScale)}));
  float g = 1.0 - smoothstep(0.25, 0.9, length(fwidth(p)));
  float k = uSurface * (1.0 - smoothstep(18.0, ${glslFloat(POOL.fadeEnd)}, r)) * stageFade(vWorld, 0.55, 0.95);
  float cs = 0.15;
  if (g > 0.0 && k > 0.002) cs = mix(0.15, cpCaustic(p * vec2(1.0, 0.7), -1.0), g);
  float a = smoothstep(0.1, 0.9, cs) * 0.45 * k;
  gl_FragColor = vec4(backingMix(uCaustic, uBacking, 1.0 - a), 1.0);
  #include <colorspace_fragment>
}
`;
