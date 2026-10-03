import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_INSTANCE_ANCHOR } from "../../kit";
import { TESSERA_LIGHT_WEIGHTS } from "./tessera";

/** Springing-line dissolve shared by tiles and grout: tiles fade into the backing near eye level; a raised camera sees the stage well below the rim, so the dissolve shortens there and more of the vault reads. */
// language=GLSL
const FADE = /* glsl */ `
uniform vec2 uSpring;
float tdFade(vec3 wp) {
  float relax = smoothstep(2.0, 8.0, cameraPosition.y);
  float spring = smoothstep(uSpring.x, uSpring.x + uSpring.y * mix(1.0, 0.35, relax), wp.y);
  return spring * stageFade(wp);
}
`;

/** Tile vertex: the tilted tile normal, the untilted course normal toward the dome centre (from the static anchor), uv and the per-tile tone and kind packed in the instance colour. */
// language=GLSL
export const TILE_VERTEX: string = /* glsl */ `
${LOOK_GLSL_INSTANCE_ANCHOR}
uniform float uCentreY;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vN0;
varying vec2 vUv;
varying vec2 vTile;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vN = lookWorldNormal(vec3(0.0, 0.0, 1.0));
  vec3 a = (modelMatrix * vec4(lookInstanceAnchor(), 1.0)).xyz;
  vN0 = normalize((modelMatrix * vec4(0.0, uCentreY, 0.0, 1.0)).xyz - a);
  vUv = uv;
  vTile = lookInstanceColor().xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Tiles: gold, ring and medallion tones with seeded variation, a cushioned edge, and glints from three drum-window lights circling below the horizon: a broad band on the course normal plus tile sparkle on the tilted normal, whose exponent falls with distance. Small tiles settle to the band and their mean tone, so nothing sparkles at pixel size. */
// language=GLSL
export const TILE_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_BACKING}
${FADE}
uniform vec3 uGold;
uniform vec3 uGrout;
uniform vec3 uGlint;
uniform vec3 uBacking;
uniform vec3 uLights[${TESSERA_LIGHT_WEIGHTS.length}];
uniform float uGlintAmount;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vN0;
varying vec2 vUv;
varying vec2 vTile;
const float TD_WEIGHTS[${TESSERA_LIGHT_WEIGHTS.length}] = float[](${TESSERA_LIGHT_WEIGHTS.map(glslFloat).join(", ")});
void main() {
  float tilePx = 1.0 / max(length(fwidth(vUv)), 1e-4);
  float detail = smoothstep(4.0, 10.0, tilePx);
  float kind = vTile.y * 2.0;
  vec3 base = uGold;
  base = mix(base, mix(uGold, uGrout, 0.6), step(0.5, kind) * (1.0 - step(1.5, kind)));
  base = mix(base, mix(uGold, uGlint, 0.4), step(1.5, kind));
  float tone = vTile.x;
  base = mix(base, tone > 0.5 ? uGlint : uGrout, abs(tone - 0.5) * 0.5 * detail);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N0 = normalize(vN0);
  vec3 N = normalize(vN);
  float far = max(smoothstep(30.0, 80.0, distance(cameraPosition, vWorld)), 1.0 - detail);
  float sparkExp = mix(60.0, 20.0, far);
  float g = 0.0;
  for (int k = 0; k < ${TESSERA_LIGHT_WEIGHTS.length}; k++) {
    vec3 H = normalize(V + uLights[k]);
    float broad = pow(max(dot(N0, H), 0.0), 28.0);
    float spark = mix(broad, pow(max(dot(N, H), 0.0), sparkExp), detail);
    g += TD_WEIGHTS[k] * (0.55 * broad + 0.9 * spark * (0.25 + 0.75 * broad));
  }
  g = clamp(g * uGlintAmount * 1.25, 0.0, 1.0);
  vec2 cu = abs(vUv - 0.5) * 2.0;
  float cushion = mix(0.9, 1.0 - 0.3 * pow(max(cu.x, cu.y), 4.0), detail);
  vec3 col = mix(mix(uGrout, base, cushion), uGlint, g);
  col = backingMix(col, uBacking, 1.0 - tdFade(vWorld));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Grout shell behind the tiles (BackSide, so its near half culls from outside): mortar between tiles, settling to the tiles' mean tone once the gaps near pixel size so they never shimmer. */
// language=GLSL
export const GROUT_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_BACKING}
${FADE}
uniform vec3 uGold;
uniform vec3 uGrout;
uniform vec3 uBacking;
uniform float uGap;
varying vec3 vWorld;
void main() {
  float gapPx = uGap / max(length(fwidth(vWorld)), 1e-5);
  float open = smoothstep(1.0, 3.0, gapPx);
  vec3 col = mix(mix(uGrout, uGold, 0.85), mix(uGrout, uGold, 0.15), open);
  col = backingMix(col, uBacking, 1.0 - tdFade(vWorld));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
