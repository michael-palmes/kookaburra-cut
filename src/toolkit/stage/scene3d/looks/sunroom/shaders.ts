import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { LOOK_GLSL_GOBO } from "../../kit/gobo";
import { SUNROOM_FLOOR_Y, SUNROOM_FRONT_Z, SUNROOM_PENUMBRA_REACH, SUNROOM_THROW } from "./room";

/** Walls and floor give way to the backing between these distances from the stage axis. */
export const SUNROOM_FADE = { start: 20, end: 38 } as const;
/** Wall tops give way to the backing between these heights above the floor (no ceiling). */
export const SUNROOM_TOP_FADE = { start: 11, end: 15 } as const;
/** Mullion half width on the blind, world units. */
export const SUNROOM_MULLION = 0.07;
/** Penumbra half width: `min` at the blind, widening by `spread` per unit travelled, times Softness. */
export const SUNROOM_PENUMBRA = { min: 0.025, spread: 0.005 } as const;
/** Room light as shares of the sunlight: `fill` in all shade, `halo` round the patch, `sky` between the slats and `grain` of plaster tooth. The floor takes `floor` of the halo and sky, so its slat shadows stay near shade; dark rooms take `dark` of all three, so the bars glow out of a deep room. */
export const SUNROOM_BOUNCE = {
  fill: 0.1,
  halo: 0.2,
  sky: 0.18,
  floor: 0.45,
  grain: 0.035,
  dark: 0.45,
} as const;

// language=GLSL
const SUNROOM_GLSL = /* glsl */ `
${LOOK_GLSL_GOBO}
${LOOK_GLSL_BACKING}
uniform vec3 uPlaster;
uniform vec3 uSunlight;
uniform vec3 uFloorTone;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform vec3 uWinCentre;
uniform vec3 uWinU;
uniform vec3 uWinN;
uniform vec2 uWinHalf;
uniform float uPanes;
uniform float uPitch;
uniform float uOpening;
uniform float uSoftness;
uniform float uBounce;
uniform vec2 uRoom;
varying vec3 vWorld;
const float SR_FLOOR = ${glslFloat(SUNROOM_FLOOR_Y)};
const float SR_NEAR_SHIFT = ${glslFloat(SUNROOM_THROW - SUNROOM_PENUMBRA_REACH)};
const float SR_MULLION = ${glslFloat(SUNROOM_MULLION)};
const vec2 SR_PEN = vec2(${glslFloat(SUNROOM_PENUMBRA.min)}, ${glslFloat(SUNROOM_PENUMBRA.spread)});
const float SR_FILL = ${glslFloat(SUNROOM_BOUNCE.fill)};
const float SR_HALO = ${glslFloat(SUNROOM_BOUNCE.halo)};
const float SR_SKY = ${glslFloat(SUNROOM_BOUNCE.sky)};
const float SR_GRAIN = ${glslFloat(SUNROOM_BOUNCE.grain)};
const float SR_FLOOR_SHARE = ${glslFloat(SUNROOM_BOUNCE.floor)};
// Second integral of the slat field: an open gap of width g centred in each unit pitch.
float srSlatG(float x, float g) {
  float n = floor(x);
  float f = x - n;
  float a = 0.5 - 0.5 * g;
  float r = clamp(f - a, 0.0, g);
  float cf = 0.5 * r * r + g * max(f - a - g, 0.0);
  return 0.5 * g * n * (n - 1.0) + n * (0.5 * g * g + a * g) + n * g * f + cf;
}
// Slat light tent-filtered over half width h (pitches): settles to the exact mean g as the penumbra or a pixel spans a pitch.
float srSlats(float x, float h, float g) {
  float xl = fract(x);
  float hh = max(h, 0.01);
  return clamp((srSlatG(xl + hh, g) - 2.0 * srSlatG(xl, g) + srSlatG(xl - hh, g)) / (hh * hh), 0.0, 1.0);
}
// Share of a box filter of half width w at d covered by a bar of half width m.
float srBar(float d, float m, float w) {
  return clamp(min(d + m, w) - max(d - m, -w), 0.0, 2.0 * min(m, w)) / (2.0 * w);
}
float srMullions(float wu, float w) {
  float pane = 2.0 * uWinHalf.x / uPanes;
  float k = (wu + uWinHalf.x) / pane;
  float kk = clamp(floor(k + 0.5), 1.0, max(uPanes - 1.0, 1.0));
  return 1.0 - srBar((k - kk) * pane, SR_MULLION, w) * step(1.5, uPanes);
}
// Light at P through the blind: (sun through the slats, skylight across the whole window, a wide halo for bounce), each 0 to 1.
vec3 srWindowLight(vec3 P) {
  GoboHit h = goboPlane(P, uSun, uWinCentre, uWinN);
  vec3 q3 = h.point - uWinCentre;
  vec2 q = vec2(dot(q3, uWinU), q3.y);
  vec2 px = fwidth(q) * 0.75;
  float near = max(h.dist - SR_NEAR_SHIFT, 0.0);
  float w = uSoftness * (SR_PEN.x + SR_PEN.y * near);
  float sdf = max(abs(q.x) - uWinHalf.x, abs(q.y) - uWinHalf.y);
  float mullions = srMullions(q.x, max(w, px.x));
  float slats = srSlats(q.y / uPitch, max(w, px.y) / uPitch, uOpening);
  float sun = goboEdge(sdf, 4.0 * w + 0.15) * mullions * slats;
  float sky = goboEdge(sdf, 5.0 * w + 0.2) * mix(1.0, mullions, 0.5);
  float halo = 0.55 * goboEdge(sdf, 1.4 + 0.08 * near) + 0.45 * goboEdge(sdf, 5.0 + 0.2 * near);
  return vec3(sun, sky, halo) * h.hit;
}
// Plaster tooth in -0.5..0.5, settling to 0 before its cells reach pixel size.
float srGrain(vec3 P) {
  float px = length(fwidth(P)) * 6.0;
  float n = 0.6 * vnoise3(P * 2.2) + 0.4 * vnoise3(P * 6.0 + vec3(5.3, 1.7, 9.1)) - 0.5;
  return n * (1.0 - smoothstep(0.35, 0.7, px));
}
float srEdgeFade(vec3 P) {
  return smoothstep(${glslFloat(SUNROOM_FADE.start)}, ${glslFloat(SUNROOM_FADE.end)}, length(P.xz));
}
// The surface's mix from its shade stop toward the sunlight stop: room fill and halo held back in the corners, skylight through the blind, then the sun.
float srMix(vec3 light, float facing, float ao, float share, vec3 P) {
  float lift = (SR_FILL + SR_HALO * share * light.z * facing) * ao * uBounce;
  float sky = SR_SKY * share * light.y * facing * uBounce;
  float k = lift + (1.0 - lift) * (sky + (1.0 - sky) * light.x * facing);
  return clamp(k + srGrain(P) * SR_GRAIN, 0.0, 1.0);
}
`;

/** Back and side walls: plaster in room light, the blind's slatted patch where the sun reaches, softened corners and a top that fades into the backing. */
// language=GLSL
export const WALL_FRAGMENT: string = /* glsl */ `
${SUNROOM_GLSL}
varying vec3 vNormalW;
void main() {
  vec3 P = vWorld;
  vec3 N = normalize(vNormalW);
  vec3 light = srWindowLight(P);
  float facing = smoothstep(0.0, 0.6, dot(N, uSun));
  float height = P.y - SR_FLOOR;
  float corner = abs(N.z) > 0.5 ? uRoom.y - abs(P.x) : P.z + uRoom.x;
  float ao = mix(0.25, 1.0, smoothstep(0.0, 2.0, height)) * mix(0.45, 1.0, smoothstep(0.0, 3.0, corner));
  vec3 col = mix(uPlaster, uSunlight, srMix(light, facing, ao, 1.0, P));
  float fade = max(srEdgeFade(P), smoothstep(${glslFloat(SUNROOM_TOP_FADE.start)}, ${glslFloat(SUNROOM_TOP_FADE.end)}, height));
  fade = max(fade, smoothstep(${glslFloat(SUNROOM_FRONT_Z - 8)}, ${glslFloat(SUNROOM_FRONT_Z)}, P.z));
  gl_FragColor = vec4(backingMix(col, uBacking, fade), 1.0);
  #include <colorspace_fragment>
}
`;

/** The floor: its own tone in room light, the blind's stripes running on from the wall toward the sun, softened along the walls. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${SUNROOM_GLSL}
void main() {
  vec3 P = vWorld;
  vec3 light = srWindowLight(P);
  float facing = smoothstep(0.0, 0.3, uSun.y);
  float wall = min(P.z + uRoom.x, abs(uRoom.y - abs(P.x)));
  float ao = mix(0.3, 1.0, smoothstep(0.0, 2.2, wall));
  vec3 col = mix(uFloorTone, uSunlight, srMix(light, facing, ao, SR_FLOOR_SHARE, P));
  gl_FragColor = vec4(backingMix(col, uBacking, srEdgeFade(P)), 1.0);
  #include <colorspace_fragment>
}
`;
