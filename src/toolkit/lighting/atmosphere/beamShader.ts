import { LOOK_GLSL_HASH, LOOK_GLSL_NOISE } from "../../stage/scene3d/kit/glsl";

/** Fixed march length: export contract once shipped (every lane, preview included). */
export const BEAM_STEPS = 48;
/** The sharp second phase lobe that makes the haze round the source glow hot. */
const HOTSPOT_G = "0.9";

// language=GLSL
export const BEAM_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// A lit participating medium inside one spot cone: single scattering, Henyey-Greenstein phase, the light's own cookie and shadow map. Drawn on the back faces of a proxy box whose floor sits just above the stage floor, so opaque content in front of a ray hides it and the march stops at the floor.
// language=GLSL
export const BEAM_FRAGMENT = /* glsl */ `
${LOOK_GLSL_HASH}
${LOOK_GLSL_NOISE}
uniform vec3 uApex;
uniform vec3 uAxis;
uniform float uCosOuter;
uniform float uCosInner;
uniform float uRange;
uniform float uDecay;
uniform float uSoftRadius;
uniform vec3 uRadiance;
uniform float uDensity;
uniform float uG;
uniform float uHotspot;
uniform float uFloorY;
uniform float uHeightFalloff;
uniform vec3 uDrift;
uniform float uNoiseScale;
uniform float uNoiseAmount;
uniform sampler2D uGobo;
uniform float uGoboOn;
uniform mat4 uLightMatrix;
uniform sampler2D uShadowMap;
uniform float uShadowOn;
uniform float uShadowBias;
uniform sampler2D uSceneDepth;
uniform float uVeilOn;
uniform vec2 uDepthSize;
uniform vec3 uCamForward;
uniform float uCamNear;
uniform float uCamFar;
uniform float uSampleSeed;
#ifdef BEAM_BOX
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
#endif
#ifdef BEAM_EXTINCT
uniform float uMeanDensity;
#endif
#ifdef BEAM_GROUND
uniform float uGroundFade;
#endif
#ifdef BEAM_SMOKE
uniform float uSmokeScale;
uniform float uSmokeWarp;
uniform float uSmokeWarpScale;
uniform vec2 uSmokeContrast;
uniform float uSmokeFloor;
uniform vec3 uSmokeShift;
uniform vec3 uWarpShift;
uniform vec3 uSmokeOffset;
uniform vec3 uFrontFade;
#endif
varying vec3 vWorld;

// Distance along the view ray to the opaque surface behind this pixel, from the veil's depth pre-pass.
float sceneDistance(vec3 rd) {
  float d = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy * uDepthSize), 0).r;
  if (d >= 1.0) return 1e6;
  float z = d * 2.0 - 1.0;
  float viewZ = 2.0 * uCamNear * uCamFar / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
  return viewZ / max(dot(rd, uCamForward), 1e-4);
}

// The ray's span inside the forward cone (apex, unit axis, cos of the half angle); x > y is a miss.
vec2 coneSpan(vec3 ro, vec3 rd, vec3 apex, vec3 axis, float cosA) {
  vec3 co = ro - apex;
  float rdD = dot(rd, axis);
  float coD = dot(co, axis);
  float c2 = cosA * cosA;
  float a = rdD * rdD - c2;
  float b = 2.0 * (rdD * coD - dot(rd, co) * c2);
  float c = coD * coD - dot(co, co) * c2;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0 || abs(a) < 1e-7) return vec2(1.0, -1.0);
  float sq = sqrt(disc);
  float q1 = (-b - sq) / (2.0 * a);
  float q2 = (-b + sq) / (2.0 * a);
  float t1 = min(q1, q2);
  float t2 = max(q1, q2);
  if (a < 0.0) {
    float mid = 0.5 * (t1 + t2);
    if (coD + mid * rdD < 0.0) return vec2(1.0, -1.0);
    return vec2(t1, t2);
  }
  return rdD > 0.0 ? vec2(t2, 1e6) : vec2(-1e6, t1);
}

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614359172 * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

float lightVisibility(vec3 p) {
  vec4 c = uLightMatrix * vec4(p, 1.0);
  vec3 s = c.xyz / c.w;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  vec2 m = textureLod(uShadowMap, s.xy, 0.0).rg;
  float z = s.z + uShadowBias;
  if (z <= m.x) return 1.0;
  float variance = max(m.y * m.y, 1e-7);
  float d = z - m.x;
  float pMax = variance / (variance + d * d);
  return clamp((pMax - 0.3) / 0.65, 0.0, 1.0);
}

#ifdef BEAM_SMOKE
// Seeded smoke that drifts and churns with the clock alone: a slower warp field folds the drifting field into wisps.
float smokeAt(vec3 p) {
  vec3 wq = p * uSmokeWarpScale + uWarpShift;
  vec3 warp = vec3(vnoise3(wq), vnoise3(wq + vec3(31.4, 17.9, 5.3)), vnoise3(wq + vec3(9.2, 41.7, 23.1))) - 0.5;
  float n = fbm3((p - uSmokeShift) * uSmokeScale + warp * uSmokeWarp + uSmokeOffset);
  float d = mix(uSmokeFloor, 1.0, smoothstep(uSmokeContrast.x, uSmokeContrast.y, n));
  float front = clamp((p.z - uFrontFade.x) / max(uFrontFade.y - uFrontFade.x, 1e-4), 0.0, 1.0);
  return d * mix(1.0, uFrontFade.z, front);
}
#endif

float goboAt(vec3 p) {
  vec4 c = uLightMatrix * vec4(p, 1.0);
  return textureLod(uGobo, c.xy / c.w, 0.0).r;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 seg = vWorld - ro;
  float tMax = length(seg);
  vec3 rd = seg / tMax;
  vec2 span = coneSpan(ro, rd, uApex, uAxis, uCosOuter);
  float t0 = max(span.x, 0.0);
  float t1 = min(span.y, tMax);
  if (uVeilOn > 0.5) t1 = min(t1, sceneDistance(rd));
  if (rd.y < 0.0 && ro.y > uFloorY) t1 = min(t1, (uFloorY - ro.y) / rd.y);
#if defined(BEAM_BOX) || defined(BEAM_EXTINCT)
  float tEnter = t0;
#endif
#ifdef BEAM_BOX
  vec3 inv = 1.0 / rd;
  vec3 ta = (uBoxMin - ro) * inv;
  vec3 tb = (uBoxMax - ro) * inv;
  vec3 lo = min(ta, tb);
  vec3 hi = max(ta, tb);
  tEnter = max(max(max(lo.x, lo.y), lo.z), 0.0);
  t0 = max(t0, tEnter);
  t1 = min(t1, min(min(hi.x, hi.y), hi.z));
#endif
  if (uRange > 0.0) {
    vec3 oc = ro - uApex;
    float b = dot(oc, rd);
    float h = b * b - (dot(oc, oc) - uRange * uRange);
    if (h <= 0.0) discard;
    float s = sqrt(h);
    t0 = max(t0, -b - s);
    t1 = min(t1, -b + s);
  }
  if (t1 <= t0) discard;
  float dt = (t1 - t0) / ${BEAM_STEPS}.0;
  // Offset per supersample draw, so the samples average the march noise away.
  float jitter = fract(hash21(ivec2(gl_FragCoord.xy)) + 0.61803398875 * uSampleSeed);
  float sum = 0.0;
#ifdef BEAM_EXTINCT
  // Haze between entering the box and reaching the beam dims it too.
  float tau = uMeanDensity * max(t0 - tEnter, 0.0);
#endif
  for (int i = 0; i < ${BEAM_STEPS}; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    vec3 l = p - uApex;
    float dist = length(l);
    vec3 ldir = l / max(dist, 1e-5);
#ifdef BEAM_EXTINCT
    float stepDens = uDensity * exp(-max(p.y - uFloorY, 0.0) * uHeightFalloff);
#ifdef BEAM_GROUND
    stepDens *= smoothstep(uFloorY, uFloorY + uGroundFade, p.y);
#endif
#ifdef BEAM_SMOKE
    stepDens *= smokeAt(p);
#endif
    float seen = exp(-tau) * exp(-uMeanDensity * dist);
    tau += stepDens * dt;
#endif
    float cone = smoothstep(uCosOuter, uCosInner, dot(ldir, uAxis));
    if (cone <= 0.0) continue;
    float fall = 1.0 / pow(dist * dist + uSoftRadius * uSoftRadius, 0.5 * uDecay);
    if (uRange > 0.0) {
      float r = dist / uRange;
      float cut = clamp(1.0 - r * r * r * r, 0.0, 1.0);
      fall *= cut * cut;
    }
    float light = cone * fall;
    if (uGoboOn > 0.5) light *= goboAt(p);
    if (light <= 1e-5) continue;
    if (uShadowOn > 0.5) light *= lightVisibility(p);
#ifdef BEAM_EXTINCT
    float dens = stepDens * seen;
#else
    float dens = uDensity * exp(-max(p.y - uFloorY, 0.0) * uHeightFalloff);
#ifdef BEAM_GROUND
    dens *= smoothstep(uFloorY, uFloorY + uGroundFade, p.y);
#endif
#endif
#ifdef BEAM_SMOKE
#ifndef BEAM_EXTINCT
    dens *= smokeAt(p);
#endif
#else
    if (uNoiseAmount > 0.0) {
      float n = vnoise3(p * uNoiseScale + uDrift) * 0.65 + vnoise3(p * uNoiseScale * 2.7 - uDrift * 1.3) * 0.35;
      dens *= mix(1.0, smoothstep(0.15, 0.85, n) * 2.0, uNoiseAmount);
    }
#endif
    float cosTheta = dot(ldir, -rd);
    float phase = hgPhase(cosTheta, uG);
    if (uHotspot > 0.0) phase = mix(phase, hgPhase(cosTheta, ${HOTSPOT_G}), uHotspot);
    sum += light * dens * phase;
  }
  vec3 col = uRadiance * (sum * dt);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
