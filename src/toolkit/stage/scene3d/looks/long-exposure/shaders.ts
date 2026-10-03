import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_SKY } from "../../kit";
import { COAST_PART, SEA, SEA_HORIZON_Y } from "./coast";
import { LONG_EXPOSURE, NAMED_STARS } from "./sky";

/** Sea tuning: how much of the horizon glow the water mirrors (also the dome's colour under the sea), swell crest spacing and half width (world units), and how many crests roll by before the swell's phase (and each crest's glints) repeats. */
export const SEA_LOOK = {
  glow: 0.4,
  swellSpacing: 2.4,
  swellHalfWidth: 0.035,
  swellLoop: 45,
} as const;

/** VERTEX-SAFE constants shared by every part. */
// language=GLSL
const LE_GLSL_CONST = /* glsl */ `
#ifndef LE_CONST
#define LE_CONST
const float LE_TAU = 6.28318531;
const float LE_PI = 3.14159265;
const float LE_SEA_Y = ${glslFloat(SEA.y)};
#endif
`;

/** VERTEX-SAFE crest: per headland (radius, azimuth, half span, height) and (tip, seed), and the crest profile (mirrors `headlandCrest` in coast.ts). */
// language=GLSL
const LE_GLSL_CREST = /* glsl */ `
${LE_GLSL_CONST}
#ifndef LE_CREST
#define LE_CREST
uniform vec4 uHead[${SEA.maxHeadlands}];
uniform vec4 uHeadShape[${SEA.maxHeadlands}];
float leCrest(int i, float az) {
  vec4 h = uHead[i];
  vec4 k = uHeadShape[i];
  float da = mod(az - h.y + LE_PI, LE_TAU) - LE_PI;
  float u = da / h.z;
  if (abs(u) >= 1.0) return 0.0;
  float base;
  if (k.x == 0.0) {
    base = sqrt(max(1.0 - smoothstep(0.62, 0.97, abs(u)), 0.0)) * (0.7 + 0.3 * exp(-(u * u) / 0.16));
  } else {
    float w = u * k.x;
    float hill = 0.55 + 0.45 * exp(-(w - 0.52) * (w - 0.52) / 0.09);
    float knoll = 0.14 * exp(-(w + 0.25) * (w + 0.25) / 0.0324);
    base = smoothstep(-1.0, 0.0, w) * (hill + knoll) * sqrt(max(1.0 - smoothstep(0.87, 0.99, w), 0.0));
  }
  float x = da * h.x;
  float rough = 0.06 * sin(0.45 * x + k.y) + 0.04 * sin(1.1 * x + 2.1 * k.y) + 0.025 * sin(2.6 * x + 3.7 * k.y) + 0.012 * sin(6.1 * x + 5.3 * k.y);
  return h.w * base * (1.0 + 1.2 * rough);
}
#endif
`;

/** Sky field shared by the dome and the sea. Stars sit at infinity: a direction maps to pole distance and phase, hashes one candidate star per band, cell and layer (two half-offset layers, the fragment's band and its nearer neighbour, up to three cells) plus the named stars, and draws each as a closed-form trail from its head back one exposure, fading toward the tail. Widths are reference pixels of the raster actually drawn (`uInkRaster`), so tiles and exports frame alike; below 0.7 px a trail keeps that width and fades. No derivatives inside: callers pass the pixel sizes. */
// language=GLSL
const LE_GLSL_SKY = /* glsl */ `
#ifndef LE_SKY
#define LE_SKY
uniform vec3 uTrail;
uniform vec3 uBright;
uniform vec3 uHorizon;
uniform vec3 uBacking;
uniform vec3 uPole;
uniform vec3 uU;
uniform vec3 uV;
uniform float uTurn;
uniform float uLen;
uniform float uDensity;
uniform float uHorizonAmt;
uniform float uLight;
uniform float uMist;
uniform vec3 uStars[${NAMED_STARS.length}];
uniform vec2 uInkRaster;
${LE_GLSL_CONST}
const float LE_DR = ${glslFloat(LONG_EXPOSURE.bandWidth)};
const int LE_CELLS = ${LONG_EXPOSURE.cells};
const float LE_HY = ${glslFloat(SEA_HORIZON_Y)};
const float LE_SEA_GLOW = ${glslFloat(SEA_LOOK.glow)};
float leRefPx() {
  return (uInkRaster.y > 0.0 ? uInkRaster.y : uResolution.y) / 1080.0;
}
vec2 lePolar(vec3 d) {
  float rho = acos(clamp(dot(d, uPole), -1.0, 1.0));
  float th = atan(dot(d, uV), dot(d, uU));
  return vec2(rho, mod(th + uTurn, LE_TAU));
}
vec3 leSeaEdge() {
  return mix(uBacking, uHorizon, uHorizonAmt * LE_SEA_GLOW);
}
vec3 leMistTone() {
  return mix(uHorizon, uTrail, 0.3);
}
float leTrail(float rho, float phi, float pxR, float pxA, float rs, float ps, float halfPx) {
  float a = mod(phi - ps + LE_PI, LE_TAU) - LE_PI;
  float head = smoothstep(-pxA, pxA, a);
  float s = clamp(a / uLen, 0.0, 1.0);
  float tail = pow(1.0 - s, 1.6) * (1.0 - smoothstep(uLen - pxA, uLen + pxA, a));
  float hwe = max(halfPx, 0.7);
  float dr = abs(rho - rs) / pxR;
  return (1.0 - smoothstep(hwe - 0.6, hwe + 0.6, dr)) * sqrt(halfPx / hwe) * head * tail;
}
vec2 leStars(vec2 rp, float pxR, float pxA, float refPx, float widen) {
  float rho = rp.x;
  float phi = rp.y;
  float cellA = LE_TAU / float(LE_CELLS);
  float bandF = rho / LE_DR;
  float covT = 0.0;
  float covB = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float off = float(layer) * 0.5;
    float bf = bandF - off;
    int b0 = int(floor(bf));
    int side = fract(bf) < 0.5 ? -1 : 1;
    int c0 = min(int(floor(phi / cellA)), LE_CELLS - 1);
    for (int k = 0; k < 2; k++) {
      int b = b0 + k * side;
      if (b < 2) continue;
      float rb = (float(b) + off + 0.5) * LE_DR;
      float pr = uDensity * clamp(0.15 + 0.95 * sin(rb), 0.0, 1.0);
      for (int dc = -2; dc <= 0; dc++) {
        if (float(-dc - 1) * cellA >= uLen) continue;
        int c = c0 + dc;
        int cw = c < 0 ? c + LE_CELLS : c;
        ivec3 key = ivec3(b, cw, layer * 7 + 3);
        if (hash31(key) > pr) continue;
        float h1 = hash31(key + ivec3(0, 0, 101));
        float h2 = hash31(key + ivec3(0, 0, 211));
        float h3 = hash31(key + ivec3(0, 0, 307));
        float rs = (float(b) + off + 0.15 + 0.7 * h1) * LE_DR;
        float ps = (float(cw) + h2) * cellA;
        float mag = h3 * h3;
        float tr = leTrail(rho, phi, pxR, pxA, rs, ps, 0.5 * (1.7 + 2.0 * mag) * refPx * widen);
        if (h3 > 0.975) covB = max(covB, tr);
        else covT = max(covT, tr * (0.5 + 0.5 * mag));
      }
    }
  }
  for (int i = 0; i < ${NAMED_STARS.length}; i++) {
    vec3 st = uStars[i];
    float ps = mod(st.y, LE_TAU);
    float tr = leTrail(rho, phi, pxR, pxA, st.x, ps, 0.5 * (2.4 + 1.6 * st.z) * refPx * widen);
    float a = mod(phi - ps + LE_PI, LE_TAU) - LE_PI;
    float dpx = length(vec2(a / pxA, (rho - st.x) / pxR));
    float r = 1.6 * refPx * widen * (1.0 + st.z);
    float bead = 1.0 - smoothstep(r, r + 1.0, dpx);
    covB = max(covB, max(tr, bead) * st.z);
  }
  return vec2(covT, covB);
}
#endif
`;

/** The coast: the crest, the land tone (a dark mix of Horizon and backing, Horizon toward Trail on light presets) hazed toward the horizon glow with distance, and the lighthouse flash (the beam facing the camera). Needs LE_GLSL_SKY and the kit backing chunk. */
// language=GLSL
const LE_GLSL_COAST = /* glsl */ `
${LE_GLSL_CREST}
uniform vec3 uLamp;
uniform vec2 uBeam;
uniform float uLampAmt;
vec3 leLand(float radius) {
  vec3 ink = uLight > 0.5 ? mix(uHorizon, uTrail, 0.35) : mix(uBacking, uHorizon, 0.1) * 0.8;
  vec3 haze = mix(uBacking, uHorizon, uHorizonAmt * 0.45);
  return backingMix(ink, haze, smoothstep(20.0, 66.0, radius) * 0.75);
}
float leFlash() {
  vec2 toCam = cameraPosition.xz - uLamp.xz;
  return pow(max(dot(uBeam, toCam / max(length(toCam), 1e-4)), 0.0), 24.0);
}
`;

/** The dome: stars at infinity (the view ray's direction, so they never parallax), the horizon glow and line where the dome meets the sea (the dome-centre direction, so it is the sea's far edge from any pose). Under the horizon the sea covers the dome from any camera above the water, so it writes the sea's edge tone and skips the stars. */
// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
${LE_GLSL_SKY}
varying vec3 vSkyDir;
varying vec3 vWorld;
void main() {
  vec3 g = normalize(vSkyDir);
  float above = g.y - LE_HY;
  float pxY = max(fwidth(g.y), 1e-6);
  float refPx = leRefPx();
  float line = aaBand(above, 0.6 * pxY * max(1.6 * refPx, 1.0)) * uHorizonAmt * 0.6;
  vec2 rp = lePolar(normalize(vWorld - cameraPosition));
  float pxR = max(fwidth(rp.x), 1e-6);
  float guard = pitchGuard(vec2(rp.x / LE_DR * 0.5, 0.0));
  vec3 col = leSeaEdge();
  if (above > -0.004) {
    float glowBand = exp(-abs(above) / 0.085) * uHorizonAmt;
    col = mix(uBacking, uHorizon, glowBand * 0.7);
    vec2 cov = leStars(rp, pxR, pxR / max(sin(rp.x), 0.02), refPx, 1.0);
    cov.x = mix(uDensity * 0.2, cov.x, guard);
    float high = smoothstep(0.12, 0.3, g.y);
    cov *= mix(0.42, 1.0, smoothstep(-0.05, 0.4, g.y));
    col = mix(col, uTrail, cov.x);
    col = mix(col, mix(uTrail, uBright, high), cov.y);
    col = mix(col, uHorizon, line * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Still sea: the view ray reflected off the water from the real camera. Its direction shades the trails (dimmed, slightly softened, like long-exposure water); where it meets the dome sets the mirrored horizon glow, so the far edge meets the dome's horizon exactly. Over that, the headlands' reflections (the reflected ray against each arc's crest), the lamp's long reflection streak, world-space mist streaks drifting along x and faint swell crests rolling toward the coast, both kept off a small clearing under the stage. */
// language=GLSL
export const SEA_FRAGMENT = /* glsl */ `
${LOOK_GLSL_SKY}
${LOOK_GLSL_BACKING}
${LE_GLSL_SKY}
${LE_GLSL_COAST}
uniform vec2 uCoastReach;
uniform float uSwell;
uniform float uSwellPhase;
uniform vec2 uMistDrift;
varying vec3 vWorld;
const float LE_R = ${glslFloat(SEA.domeRadius)};
const float LE_SWELL = ${glslFloat(SEA_LOOK.swellSpacing)};
const float LE_SWELL_LOOP = ${glslFloat(SEA_LOOK.swellLoop)};
vec2 leCoastReflect(vec3 p, vec3 r, float pxAng) {
  vec2 hit = vec2(0.0);
  float a = dot(r.xz, r.xz);
  if (a < 1e-6) return hit;
  float slope = r.y / sqrt(a);
  if ((uCoastReach.x - length(p.xz)) * slope > uCoastReach.y) return hit;
  float best = 1e9;
  float b = dot(p.xz, r.xz);
  float o2 = dot(p.xz, p.xz);
  for (int i = 0; i < ${SEA.maxHeadlands}; i++) {
    vec4 h = uHead[i];
    if (h.w <= 0.0) continue;
    float c = o2 - h.x * h.x;
    float disc = b * b - a * c;
    if (disc < 0.0) continue;
    float sq = sqrt(disc);
    float t = c < 0.0 ? (-b + sq) / a : (-b - sq) / a;
    if (t <= 0.0) continue;
    float y = t * r.y;
    if (y > h.w * 1.2) continue;
    vec3 q = p + t * r;
    float crest = leCrest(i, atan(q.x, -q.z));
    float soft = max(0.1 + 0.012 * t, pxAng * t);
    float cov = smoothstep(-soft, soft, crest - y);
    if (cov <= 0.0) continue;
    if (t < best) {
      best = t;
      hit.y = h.x;
    }
    hit.x = max(hit.x, cov);
  }
  return hit;
}
void main() {
  vec3 p = vWorld;
  vec3 v = normalize(p - cameraPosition);
  vec3 r = vec3(v.x, -v.y, v.z);
  float b = dot(p, r);
  float c = dot(p, p) - LE_R * LE_R;
  vec3 g = (p + (-b + sqrt(max(b * b - c, 0.0))) * r) / LE_R;
  float above = max(g.y - LE_HY, 0.0);
  float refPx = leRefPx();
  vec2 rp = lePolar(r);
  float pxR = max(fwidth(rp.x), 1e-6);
  float guard = pitchGuard(vec2(rp.x / LE_DR * 0.5, 0.0));
  float pxAng = max(length(fwidth(v)), 1e-6);
  vec2 xz = p.xz;
  float dist = length(xz);
  vec2 fw = fwidth(xz);
  float ph = (-xz.y + 0.004 * xz.x * xz.x + 2.2 * vnoise(xz * vec2(0.035, 0.07))) / LE_SWELL + uSwellPhase;
  float pxPh = max(fwidth(ph), 1e-5);
  vec2 mp = vec2(xz.x * 0.055, xz.y * 0.5) + uMistDrift;
  float mist = skyFbm(mp, length(fw * vec2(0.055, 0.5)), 3);

  float glow = exp(-above / 0.05) * uHorizonAmt;
  vec3 col = mix(uBacking, uHorizon, glow * LE_SEA_GLOW);
  float refl = 0.15 * pow(1.0 - clamp(-v.y, 0.0, 1.0), 8.0);
  vec2 cov = vec2(0.0);
  if (refl > 0.01) cov = leStars(rp, pxR, pxR / max(sin(rp.x), 0.02), refPx, 2.0);
  cov.x = mix(uDensity * 0.2, cov.x, guard) * 0.55;
  cov *= refl;
  col = mix(col, uTrail, cov.x);
  col = mix(col, mix(uTrail, uBright, 0.4), cov.y);

  vec2 land = leCoastReflect(p, r, pxAng);
  if (land.x > 0.0) col = mix(col, leLand(land.y), land.x * 0.7);

  float clear = smoothstep(2.5, 6.5, dist);
  float m = smoothstep(0.42, 0.8, mist) * (1.0 - smoothstep(32.0, 66.0, dist)) * (0.35 + 0.65 * clear);
  col = mix(col, leMistTone(), m * uMist * 0.6);

  float d = (fract(ph + 0.5) - 0.5) * LE_SWELL;
  float hw = ${glslFloat(SEA_LOOK.swellHalfWidth)};
  float pxD = pxPh * LE_SWELL;
  float w = max(hw, 0.75 * pxD);
  float crest = (1.0 - smoothstep(w - pxD, w + pxD, abs(d))) * (hw / w);
  float km = mod(floor(ph + 0.5), LE_SWELL_LOOP);
  float glint = smoothstep(0.42, 0.78, vnoise(vec2(xz.x * 0.45 + 37.0 * hash11(int(km)), km * 3.1)));
  float back = 0.5 + 0.5 * cos(LE_TAU * ph);
  float broad = back * back * (1.0 - smoothstep(0.2, 0.45, pxPh)) * clear;
  col = mix(col, leMistTone(), broad * uSwell * 0.14);
  float swell = crest * glint * (1.0 - smoothstep(0.12, 0.3, pxPh)) * clear;
  col = mix(col, uTrail, swell * uSwell * (0.7 - 0.25 * uLight));

  if (uLampAmt > 0.0) {
    vec3 e = normalize(vec3(uLamp.x, 2.0 * LE_SEA_Y - uLamp.y, uLamp.z) - cameraPosition);
    float side = (v.x * e.z - v.z * e.x) / max(length(v.xz) * length(e.xz), 1e-4);
    float drop = asin(clamp(v.y, -1.0, 1.0)) - asin(clamp(e.y, -1.0, 1.0));
    float wide = max(0.003, 1.3 * pxAng);
    float streak = exp(-side * side / (wide * wide)) * exp(-drop * drop / 0.00015);
    col = mix(col, uBright, streak * uLampAmt * (0.16 + 0.3 * leFlash()));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Headlands: walls cut at the crest with a one-pixel coverage edge (alpha to coverage) under a thin rim (the glow catching the ridge, so dark silhouettes still read at tile size), and roofs the vertex stage slopes from the crest back into the sea (cut away with their wall once the camera is outside it). Anything between the camera and the stage is cut (F11), and the lamp goes with it. The land tone hazes with distance and low mist hugs the waterline. */
// language=GLSL
export const COAST_VERTEX = /* glsl */ `
${LE_GLSL_CREST}
attribute vec2 aCoast;
varying vec3 vWorld;
varying float vHead;
varying float vRoof;
void main() {
  int i = int(aCoast.x + 0.5);
  vec3 p = position;
  vRoof = -1.0;
  if (aCoast.y > ${glslFloat(COAST_PART.top + 0.5)}) {
    float h = leCrest(i, atan(p.x, -p.z));
    float back = aCoast.y < ${glslFloat(COAST_PART.front - 0.5)} ? 1.0 : 0.0;
    float r = uHead[i].x + back * (${glslFloat(SEA.roof.depth)} + ${glslFloat(SEA.roof.slope)} * h);
    vec2 dir = normalize(p.xz);
    p = vec3(dir.x * r, LE_SEA_Y + mix(h - 0.03, ${glslFloat(SEA.roof.sink)}, back), dir.y * r);
    vRoof = back;
  }
  vec4 w = lookWorldPosition(p);
  vWorld = w.xyz;
  vHead = aCoast.x;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const COAST_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${LE_GLSL_SKY}
${LE_GLSL_COAST}
varying vec3 vWorld;
varying float vHead;
varying float vRoof;
void main() {
  int i = int(vHead + 0.5);
  float y = vWorld.y - LE_SEA_Y;
  float d = leCrest(i, atan(vWorld.x, -vWorld.z)) - y;
  float px = max(fwidth(d), 1e-5);
  float wall = step(vRoof, -0.5);
  float cov = mix(1.0, clamp(d / px + 0.5, 0.0, 1.0), wall) * stageCut(vWorld);
  float radius = uHead[i].x;
  if (cov <= 0.0 || (wall < 0.5 && dot(cameraPosition.xz, normalize(vWorld.xz)) > radius)) discard;
  vec3 col = leLand(radius);
  col = backingMix(col, mix(uBacking, uHorizon, uHorizonAmt * 0.45), 0.3 * max(vRoof, 0.0));
  col = mix(col, leMistTone(), uMist * 0.4 * exp(-max(y, 0.0) / 0.6));
  float rim = (1.0 - smoothstep(0.0, max(1.2, 2.0 * leRefPx()) * px, d)) * wall;
  vec3 rimTone = uLight > 0.5 ? uTrail : mix(uHorizon, uTrail, 0.6);
  col = mix(col, rimTone, rim * mix(0.6, 0.3, smoothstep(25.0, 60.0, radius)));
  gl_FragColor = vec4(col, cov);
  #include <colorspace_fragment>
}
`;

/** The lighthouse: a camera-facing quad round the lamp, pulled a little toward the camera so its own headland never clips the glow; nearer headlands still hide it. */
// language=GLSL
export const LAMP_VERTEX = /* glsl */ `
uniform vec3 uLamp;
varying vec3 vWorld;
void main() {
  vec3 toCam = cameraPosition - uLamp;
  float dc = max(length(toCam), 1e-3);
  vec3 f = toCam / dc;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), f));
  vec3 up = cross(f, right);
  vec3 w = uLamp + f * min(1.5, 0.05 * dc) + (right * position.x + up * position.y) * ${glslFloat(SEA.lampQuad)};
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

/** A steady core (never under about a pixel, so tiles keep it), a soft halo that swells as the beam faces the camera, and the beam itself: the view ray's closest approach to the beam's ray, widening and fading with reach. All in the glow slot, alpha over what is behind. */
// language=GLSL
export const LAMP_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${LE_GLSL_SKY}
${LE_GLSL_COAST}
varying vec3 vWorld;
void main() {
  vec3 v = normalize(vWorld - cameraPosition);
  vec3 toL = uLamp - cameraPosition;
  float dl = length(toL);
  float pxAng = max(length(fwidth(v)), 1e-6);
  float rpx = length(cross(v, toL / dl)) / pxAng;
  float refPx = leRefPx();
  float flash = leFlash();
  float coreR = max(2.0 * refPx, 1.0);
  float core = 1.0 - smoothstep(coreR - 0.5, coreR + 0.5, rpx);
  float halo = exp(-rpx / (coreR * (2.2 + 3.5 * flash)));
  vec3 bd = vec3(uBeam.x, 0.0, uBeam.y);
  vec3 w0 = cameraPosition - uLamp;
  float bb = dot(v, bd);
  float den = max(1.0 - bb * bb, 1e-3);
  float dd = dot(v, w0);
  float ee = dot(bd, w0);
  float sc = (bb * ee - dd) / den;
  float tc = (ee - bb * dd) / den;
  vec3 gap = w0 + sc * v - tc * bd;
  float bw = max(0.05 + 0.08 * max(tc, 0.0), 0.8 * pxAng * dl);
  float beam = exp(-dot(gap, gap) / (bw * bw)) * smoothstep(0.0, 0.5, tc) * exp(-max(tc, 0.0) / ${glslFloat(SEA.beamReach)});
  float near = smoothstep(0.45, 0.55, stageFade(uLamp));
  float a = clamp(core + (0.5 + 0.4 * flash) * halo + 0.22 * beam, 0.0, 1.0) * uLampAmt * near;
  gl_FragColor = vec4(uBright, a);
  #include <colorspace_fragment>
}
`;
