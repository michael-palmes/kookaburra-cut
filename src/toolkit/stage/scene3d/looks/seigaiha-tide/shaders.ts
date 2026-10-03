import { LOOK_GLSL_PRINT } from "../../kit";
import { TIDE_GLSL_SWELL } from "./tide";

/** Floor vertex: the polar grid lifted by the swell. */
// language=GLSL
export const FLOOR_VERTEX: string = /* glsl */ `
${TIDE_GLSL_SWELL}
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float quad;
  w.y += tsSwell(w.xz, quad).x;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Floor: seigaiha fans on a conformal log-polar lattice (fans open outward from any camera and grow with radius), a carved key line, a misregistered fill plate, a two-stage pitch guard, swell shading from a low virtual sun, the stage clearing and a horizon mist band. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${TIDE_GLSL_SWELL}
${LOOK_GLSL_PRINT}
uniform vec3 uPrussian;
uniform vec3 uWave;
uniform vec3 uFoam;
uniform vec3 uSea;
uniform vec3 uBacking;
uniform float uFans;
uniform float uRings;
uniform float uRipple;
uniform float uOrbit;
uniform float uMist;
varying vec3 vWorld;

// Unit circles in rows 0.5 apart, alternate rows offset by 1; the lowest row (nearest the stage) prints on top.
float tsSeigaiha(vec2 p) {
  float j0 = ceil((p.y - 1.0) / 0.5);
  for (int k = 0; k < 5; k++) {
    float j = j0 + float(k);
    float off = mod(j, 2.0);
    vec2 c = vec2(2.0 * floor((p.x - off) * 0.5 + 0.5) + off, j * 0.5);
    float d = length(p - c);
    if (d < 1.0) return d;
  }
  return 0.99;
}
float tsOddArea(float u) {
  float m = u * 0.5;
  return floor(m) + max(0.0, 2.0 * fract(m) - 1.0);
}
// Odd-ring indicator box-filtered over w ring units, so fill bands antialias once the key line fades.
float tsOdd(float u, float w) {
  w = max(w, 1e-4);
  return (tsOddArea(u + 0.5 * w) - tsOddArea(u - 0.5 * w)) / w;
}

void main() {
  vec2 xz = vWorld.xz;
  float r = max(length(xz), 0.5);
  float K = uFans / 3.14159265;
  // Seam-free lattice footprint from the analytic Jacobian (the map is conformal), not fwidth of the atan.
  float px = K * length(fwidth(xz)) / r;
  float ringsPx = px * uRings;
  float grain = 0.5 + 0.5 * printGrain(xz, 1.0 / 9.0) + 0.5 * printGrain(xz, 1.0 / 23.0);
  float ev = degrees(asin(clamp(normalize(vWorld - cameraPosition).y, -1.0, 1.0)));
  float mist = 1.0 - smoothstep(-uMist, -0.27 * uMist, ev);
  float far = smoothstep(45.0, 100.0, r);
  float clear = smoothstep(uClear - 0.8, uClear + 0.6, r);
  float quad;
  vec4 sw = tsSwell(xz, quad);
  vec3 fillMean = mix(uWave, uPrussian, 0.5);
  vec3 guarded = mix(fillMean, uSea, 0.5);
  float fillVis = 1.0 - smoothstep(0.3, 0.55, ringsPx);
  float keyVis = 1.0 - smoothstep(0.16, 0.3, ringsPx);
  vec3 col = guarded;
  if (fillVis * mist * (1.0 - far) * clear > 0.0) {
    // Every fan rides the raw wave on a small orbit and its rings ripple outward, near and far alike.
    vec2 p = vec2(atan(xz.y, xz.x), log(r)) * K + uOrbit * vec2(quad, sw.w);
    float ph = uRipple * sw.w;
    float d = tsSeigaiha(p);
    float x = fract(d * uRings - ph * (1.0 - d) + 0.5) - 0.5;
    float key = (1.0 - smoothstep(0.13 - ringsPx, 0.13 + ringsPx, abs(x))) * smoothstep(0.1, 0.2, d);
    vec2 slip = vec2(0.035, -0.03) * (1.0 - smoothstep(0.35, 0.7, px / 0.071));
    float df = tsSeigaiha(p + slip);
    vec3 fill = mix(uWave, uPrussian, tsOdd(df * uRings - ph * (1.0 - df), ringsPx));
    fill = mix(uPrussian, fill, smoothstep(0.2 - px, 0.2 + px, df));
    fill = mix(fill, uWave, 0.12 * grain);
    col = mix(mix(guarded, fill, fillVis), uFoam, 0.85 * key * keyVis);
  }
  // Low virtual sun behind the stage: swell faces toward it lift toward foam, backs sink toward prussian.
  vec3 n = normalize(vec3(-sw.y, 1.0, -sw.z));
  vec3 L = normalize(vec3(0.25, 0.35, -1.0));
  float s = dot(n, L) - L.y;
  col = mix(col, s > 0.0 ? uFoam : uPrussian, clamp(abs(s) * 2.2, 0.0, 0.55));
  col = mix(mix(uSea, uBacking, 0.25), col, clear);
  col = mix(col, uSea, far);
  col = mix(uSea, col, mist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Sky: a soft bokashi from the sea tone up to a pale dawn behind the headline, then printed dawn to prussian bands above it, all in elevation from the camera. */
// language=GLSL
export const SKY_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_PRINT}
uniform vec3 uPrussian;
uniform vec3 uWave;
uniform vec3 uDawn;
uniform vec3 uSea;
uniform vec3 uBacking;
uniform vec3 uBands;
uniform float uDrift;
varying vec3 vWorld;
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  float e = degrees(asin(clamp(dir.y, -1.0, 1.0)));
  float w = max(fwidth(e), 1e-4);
  float e3 = uBands.z + uDrift;
  vec3 col = mix(uSea, mix(uBacking, uDawn, 0.6), smoothstep(0.0, uBands.x * 0.8, e));
  col = mix(col, uDawn, smoothstep(uBands.x - w, uBands.x + w, e));
  col = mix(col, mix(uDawn, uWave, 0.55), smoothstep(uBands.y - w, uBands.y + w, e));
  col = mix(col, mix(uWave, uPrussian, 0.3 + 0.7 * smoothstep(e3, 70.0, e)), smoothstep(e3 - w, e3 + w, e));
  col = mix(uSea, col, smoothstep(-0.5, 0.5, e));
  col *= 1.0 + printGrain(dir, 1.0 / 180.0) * 0.025;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
