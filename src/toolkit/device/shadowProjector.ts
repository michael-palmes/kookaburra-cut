import type { V3 } from "../types";
import type { DeviceSpec } from "./catalog";

// ── Device cast shadows (export contract) ────────────────────────────
// ONE analytic projector serves all three presentation modes. Each rigid slab of the device's
// silhouette (a handset is one slab, a laptop is a base plus its hinged lid) is back-projected
// from the receiver plane toward a virtual key light, then swept along the receiver to a throw
// length, widening its penumbra and fading as it goes. Pure functions of the pose: no light, no
// jitter, no accumulation, no runtime bbox. CHANGING ANY CONSTANT HERE REBASES EVERY STAGED DEVICE.

const DEG2RAD = Math.PI / 180;

/** How far behind the device the "behind" receiver plane sits, before the placement scale. */
export const SHADOW_PLANE_BACK = 0.45;
/** Slack added around the computed quad so a blurred edge is never clipped by the mesh. */
export const SHADOW_QUAD_MARGIN = 0.12;
/** Ambient (unswept) contact term: capped so a wildly scaled device cannot wash the floor. */
export const SHADOW_AMBIENT_MAX_BLUR = 1.6;

/** The three presentation modes' parameter sets. */
export type DeviceShadowMode = "soft" | "long" | "sun" | "none";

export interface ShadowModeSpec {
  /** Where the shadow lands: the stage floor under the device, or a plane behind it. */
  receiver: "floor" | "behind";
  /** Key light, in degrees: azimuth 0 sits at +Z (behind the camera), positive turns toward +X; elevation 90 is straight overhead. */
  azimuthDeg: number;
  elevationDeg: number;
  /** Penumbra half-width where the device meets the receiver, in world units before the placement scale. */
  blurNear: number;
  /** How fast the penumbra widens per world unit between occluder and receiver: the key light's apparent size, and what makes a floating device's shadow soften and a tall device's shadow blur toward its far end. Dimensionless, so it does NOT scale with the device. */
  softness: number;
  /** Darkness where the device meets the receiver. */
  opacity: number;
  /** Occluder distance over which the cast fades to nothing. */
  fadeLength: number;
  /** Fade exponent: higher fades sooner. */
  falloff: number;
  /** Sun sweep only: the silhouette is smeared this far along the receiver, its penumbra widening by `sweepBlur` over the smear. Zero leaves a plain projection. */
  sweepLength: number;
  sweepBlur: number;
  /** The contact pool: a heavily blurred copy of the footprint projected STRAIGHT DOWN onto the receiver rather than along the key, so it sits under the device and grounds it the way ambient occlusion does. Zero opacity disables it. */
  ambientBlur: number;
  ambientOpacity: number;
}

/** The bundled rig's key light sits at [4, 6, 5], so both floor modes rake away from it: the shadow falls back-left exactly as the lit device's highlights imply. */
export const KEY_LIGHT_AZIMUTH_DEG = 38.65980825409009;

/** The mode catalogue. Soft contact reads as a tight strip under the device plus a broad ambient pool; Long & smooth drops the same key to a low rake for a long eased tail; Sun sweep keeps its plane behind the device and its 45-degree down-right smear. */
export const DEVICE_SHADOW_MODES: Record<Exclude<DeviceShadowMode, "none">, ShadowModeSpec> = {
  soft: {
    receiver: "floor",
    azimuthDeg: KEY_LIGHT_AZIMUTH_DEG,
    elevationDeg: 62,
    blurNear: 0.04,
    softness: 0.075,
    opacity: 0.44,
    fadeLength: 3.2,
    falloff: 1.4,
    sweepLength: 0,
    sweepBlur: 0,
    ambientBlur: 0.4,
    ambientOpacity: 0.22,
  },
  long: {
    receiver: "floor",
    azimuthDeg: KEY_LIGHT_AZIMUTH_DEG,
    elevationDeg: 16,
    blurNear: 0.045,
    softness: 0.08,
    opacity: 0.38,
    fadeLength: 11,
    falloff: 1.5,
    sweepLength: 0,
    sweepBlur: 0,
    ambientBlur: 0.28,
    ambientOpacity: 0.14,
  },
  sun: {
    receiver: "behind",
    azimuthDeg: -45,
    elevationDeg: 35.264389682754654,
    blurNear: 0.06,
    softness: 0.02,
    opacity: 0.34,
    fadeLength: 40,
    falloff: 1.3,
    sweepLength: 3.4,
    sweepBlur: 0.79,
    ambientBlur: 0,
    ambientOpacity: 0,
  },
};

/** One rigid rounded-rect slab of the silhouette, in the device group's local frame (the frame the shadow mesh also lives in): `center` plus an orthonormal (u, v, n) basis, half extents along u and v, `thickness` along n. */
export interface ShadowSlab {
  center: V3;
  u: V3;
  v: V3;
  n: V3;
  half: [number, number];
  thickness: number;
  radius: number;
}

/** The device pose the silhouette is built from: everything the inner animated group applies, so a float lifts the shadow off the floor and a turntable spin narrows it. */
export interface ShadowPose {
  /** Placement scale times the model's auto-fit is NOT included: slabs are authored in fitted units and scaled by `scale` alone. */
  scale: number;
  /** Radians, applied X then Y then Z, matching the inner group's rotation order. */
  rotation: V3;
  /** Local-space offset of the animated group (the float lift). */
  offset: V3;
  /** The intro presets' uniform scale on top of `scale`. */
  introScale: number;
  /** Lid opening in degrees; ignored by devices with no hinge. */
  lidDeg: number;
}

const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** Euler XYZ rotation matrix as three column vectors, matching three's default order. */
function basisFromEuler(rotation: V3): [V3, V3, V3] {
  const [cx, cy, cz] = [Math.cos(rotation[0]), Math.cos(rotation[1]), Math.cos(rotation[2])];
  const [sx, sy, sz] = [Math.sin(rotation[0]), Math.sin(rotation[1]), Math.sin(rotation[2])];
  return [
    [cy * cz, cx * sz + sx * sy * cz, sx * sz - cx * sy * cz],
    [-cy * sz, cx * cz - sx * sy * sz, sx * cz + cx * sy * sz],
    [sy, -sx * cy, cx * cy],
  ];
}

/** Rotate a fitted-frame vector into the device group's local frame. */
function applyBasis(basis: [V3, V3, V3], p: V3): V3 {
  return [
    basis[0][0] * p[0] + basis[1][0] * p[1] + basis[2][0] * p[2],
    basis[0][1] * p[0] + basis[1][1] * p[1] + basis[2][1] * p[2],
    basis[0][2] * p[0] + basis[1][2] * p[1] + basis[2][2] * p[2],
  ];
}

/** The slabs a device casts from, in its own fitted frame (before pose): one upright rounded rect for a handset, a flat base plus its hinged lid for a laptop. `pitch` turns a slab about local X, 0 standing it upright facing +Z and +90 laying it flat facing up. */
function fittedSlabs(
  spec: Pick<DeviceSpec, "layoutWidth" | "fittedHeight" | "shadow" | "lid">,
  lidDeg: number,
): Array<{ center: V3; half: [number, number]; thickness: number; radius: number; pitch: number }> {
  const shadow = spec.shadow;
  const halfWidth = spec.layoutWidth / 2;
  if (!shadow.base || !shadow.lid) {
    return [
      {
        center: [0, 0, 0],
        half: [halfWidth, spec.fittedHeight / 2],
        thickness: shadow.thickness,
        radius: shadow.radius,
        pitch: 0,
      },
    ];
  }
  const base = {
    center: [0, shadow.base.y, shadow.base.z] as V3,
    half: [halfWidth, shadow.base.depth / 2] as [number, number],
    thickness: shadow.thickness,
    radius: shadow.radius,
    // Flat on the floor, its +v running from the hinge to the front edge.
    pitch: Math.PI / 2,
  };
  // The lid opens about the hinge; `lidDeg` is the angle off the closed (flat) pose, so 90 stands it upright and the authored 110 leans it back.
  const open = Math.max(0, Math.min(spec.lid?.openDeg ?? 110, lidDeg)) * DEG2RAD;
  const halfLen = shadow.lid.length / 2;
  return [
    base,
    {
      center: [
        0,
        shadow.lid.hingeY + Math.sin(open) * halfLen,
        shadow.lid.hingeZ + Math.cos(open) * halfLen,
      ],
      half: [halfWidth, halfLen],
      thickness: shadow.lid.thickness,
      radius: shadow.radius,
      pitch: Math.PI / 2 - open,
    },
  ];
}

/** The posed slabs in the device group's local frame: the fitted silhouette rotated, scaled and lifted exactly as the inner animated group renders it. */
export function deviceShadowSlabs(
  spec: Pick<DeviceSpec, "layoutWidth" | "fittedHeight" | "shadow" | "lid">,
  pose: ShadowPose,
): ShadowSlab[] {
  const basis = basisFromEuler(pose.rotation);
  const k = pose.scale * pose.introScale;
  return fittedSlabs(spec, pose.lidDeg).map((slab) => {
    const cp = Math.cos(slab.pitch);
    const sp = Math.sin(slab.pitch);
    // Pitch about local X: u is untouched, v and n turn with it.
    const localU: V3 = [1, 0, 0];
    const localV: V3 = [0, cp, sp];
    const localN: V3 = cross(localU, localV);
    const center = applyBasis(basis, scaled(slab.center, k));
    return {
      center: add(center, pose.offset),
      u: applyBasis(basis, localU),
      v: applyBasis(basis, localV),
      n: applyBasis(basis, localN),
      half: [slab.half[0] * k, slab.half[1] * k],
      thickness: slab.thickness * k,
      radius: Math.min(slab.radius * k, Math.min(slab.half[0], slab.half[1]) * k),
    };
  });
}

/** Unit vector from the origin toward the key light. */
export function shadowLightDirection(mode: ShadowModeSpec): V3 {
  const az = mode.azimuthDeg * DEG2RAD;
  const el = mode.elevationDeg * DEG2RAD;
  const ce = Math.cos(el);
  return [ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)];
}

/** The receiver plane in the device group's local frame: an origin plus the mounted mesh's own orthonormal basis, so plane coordinates ARE the quad's local xy. */
export interface ShadowPlane {
  origin: V3;
  e1: V3;
  e2: V3;
  normal: V3;
}

export function shadowPlane(mode: ShadowModeSpec, groundY: number, scale: number): ShadowPlane {
  if (mode.receiver === "floor") {
    // The mesh's own frame: a plane turned to face up, so its +y maps to world -z.
    return { origin: [0, groundY, 0], e1: [1, 0, 0], e2: [0, 0, -1], normal: [0, 1, 0] };
  }
  return {
    origin: [0, 0, -SHADOW_PLANE_BACK * scale],
    e1: [1, 0, 0],
    e2: [0, 1, 0],
    normal: [0, 0, 1],
  };
}

/** Where the shadow travels across the receiver, in the plane's own basis: the light direction flattened onto the plane and negated (shadows fall away from the light). Zero when the light is dead-on, which the caller degrades to no sweep. */
export function shadowSweepDirection(plane: ShadowPlane, light: V3): [number, number] {
  const along = dot(light, plane.normal);
  const flat: V3 = [
    light[0] - plane.normal[0] * along,
    light[1] - plane.normal[1] * along,
    light[2] - plane.normal[2] * along,
  ];
  const x = -dot(flat, plane.e1);
  const y = -dot(flat, plane.e2);
  const len = Math.hypot(x, y);
  return len < 1e-6 ? [0, 0] : [x / len, y / len];
}

/** Silhouette half-extents grown by the slab's thickness as seen from the light: the exact projected outline of a box onto its own mid-plane. */
export function slabSilhouetteHalf(slab: ShadowSlab, light: V3): [number, number] {
  const denom = dot(light, slab.n);
  if (Math.abs(denom) < 1e-4) return [slab.half[0], slab.half[1]];
  const grow = slab.thickness / 2 / Math.abs(denom);
  return [
    slab.half[0] + Math.abs(dot(light, slab.u)) * grow,
    slab.half[1] + Math.abs(dot(light, slab.v)) * grow,
  ];
}

/** Penumbra half-width for an occluder `distance` from the receiver: the contact blur plus the light's apparent size over that gap. The physical law the whole projector turns on, so a floating device's shadow softens and a tall one blurs toward its far end. */
export function shadowPenumbra(mode: ShadowModeSpec, distance: number, scale: number): number {
  return mode.blurNear * scale + mode.softness * Math.max(0, distance);
}

/** The receiver quad that holds the whole blurred cast: the slabs' corners projected onto the plane, then grown by the sweep and by the penumbra the furthest corner reaches. Returns plane-basis coordinates. */
export function shadowQuad(
  slabs: ShadowSlab[],
  plane: ShadowPlane,
  light: V3,
  mode: ShadowModeSpec,
  scale: number,
): { centre: [number, number]; size: [number, number] } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const denomPlane = dot(light, plane.normal);
  if (Math.abs(denomPlane) < 1e-4) return null;
  let maxDistance = 0;
  const directions = mode.ambientOpacity > 0 ? [light, plane.normal] : [light];
  for (const slab of slabs) {
    for (const direction of directions) {
      const half = slabSilhouetteHalf(slab, direction);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const corner: V3 = [
            slab.center[0] + slab.u[0] * half[0] * sx + slab.v[0] * half[1] * sy,
            slab.center[1] + slab.u[1] * half[0] * sx + slab.v[1] * half[1] * sy,
            slab.center[2] + slab.u[2] * half[0] * sx + slab.v[2] * half[1] * sy,
          ];
          // Slide the corner along the light onto the receiver plane.
          const rel: V3 = [
            corner[0] - plane.origin[0],
            corner[1] - plane.origin[1],
            corner[2] - plane.origin[2],
          ];
          const t = -dot(rel, plane.normal) / dot(direction, plane.normal);
          maxDistance = Math.max(maxDistance, Math.abs(t));
          const hit: V3 = [
            rel[0] + direction[0] * t,
            rel[1] + direction[1] * t,
            rel[2] + direction[2] * t,
          ];
          const x = dot(hit, plane.e1);
          const y = dot(hit, plane.e2);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  const sweep = shadowSweepDirection(plane, light);
  const sweepLen = mode.sweepLength * scale;
  minX = Math.min(minX, minX + sweep[0] * sweepLen);
  maxX = Math.max(maxX, maxX + sweep[0] * sweepLen);
  minY = Math.min(minY, minY + sweep[1] * sweepLen);
  maxY = Math.max(maxY, maxY + sweep[1] * sweepLen);
  const penumbra =
    shadowPenumbra(mode, maxDistance, scale) + (mode.sweepBlur + SHADOW_QUAD_MARGIN) * scale;
  const pad = Math.max(penumbra, Math.min(mode.ambientBlur * scale, SHADOW_AMBIENT_MAX_BLUR));
  return {
    centre: [(minX + maxX) / 2, (minY + maxY) / 2],
    size: [maxX - minX + pad * 2, maxY - minY + pad * 2],
  };
}

// language=GLSL
export const SHADOW_VERT = /* glsl */ `
uniform vec2 uSize;
uniform vec2 uCentre;
varying vec2 vPos;
void main() {
  vPos = (uv - 0.5) * uSize + uCentre;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// language=GLSL
/** Two slabs, unrolled rather than looped: ANGLE Metal has already cost this project one shader (see docs/determinism.md, the troika `inout` patch), so the fragment stage keeps to flat arithmetic. `uSlabOn` weights the second slab out for a device with no hinge. */
export const SHADOW_FRAG = /* glsl */ `
uniform vec3 uPlaneOrigin;
uniform vec3 uPlaneE1;
uniform vec3 uPlaneE2;
uniform vec3 uLight;
uniform vec3 uPlaneNormal;
uniform vec2 uSweep;
uniform float uSweepLen;
uniform float uSweepBlur;
uniform float uBlurNear;
uniform float uSoftness;
uniform float uOpacity;
uniform float uFadeLength;
uniform float uFalloff;
uniform vec2 uAmbient;
uniform vec3 uSlabC0;
uniform vec3 uSlabU0;
uniform vec3 uSlabV0;
uniform vec3 uSlabN0;
uniform vec3 uSlabH0;
uniform vec3 uSlabC1;
uniform vec3 uSlabU1;
uniform vec3 uSlabV1;
uniform vec3 uSlabN1;
uniform vec3 uSlabH1;
uniform float uSlabOn1;
varying vec2 vPos;

const float SLAB_MISS = 1e4;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Probes one slab from a receiver point: x is the signed distance to its silhouette, y how far along the light the slab sits. A slab behind the receiver occludes nothing and returns the miss sentinel.
vec2 slabProbe(vec2 p, vec3 light, vec3 c, vec3 u, vec3 v, vec3 n, vec3 h) {
  vec3 world = uPlaneOrigin + uPlaneE1 * p.x + uPlaneE2 * p.y;
  float denom = dot(light, n);
  if (abs(denom) < 1e-4) return vec2(SLAB_MISS, SLAB_MISS);
  float s = dot(c - world, n) / denom;
  if (s <= 0.0) return vec2(SLAB_MISS, SLAB_MISS);
  vec3 q = world + light * s - c;
  return vec2(sdRoundBox(vec2(dot(q, u), dot(q, v)), h.xy, h.z), s);
}

// One probe's coverage: the penumbra widens with the slab's distance from the receiver, which softens a floating device's shadow and blurs a tall one toward its far end. blurAdd carries the sun sweep's extra ramp; fadeOn mutes the distance fade for the ambient pool.
float probeCoverage(vec2 probe, float blurAdd, float fadeOn) {
  if (probe.y > 9e3) return 0.0;
  float blur = max(uBlurNear + uSoftness * probe.y + blurAdd, 1e-4);
  float cover = 1.0 - smoothstep(-blur, blur, probe.x);
  float fade = pow(clamp(1.0 - probe.y / uFadeLength, 0.0, 1.0), uFalloff);
  return cover * mix(1.0, fade, fadeOn);
}

float shade(vec2 p, vec3 light, float blurAdd, float fadeOn) {
  float a = probeCoverage(slabProbe(p, light, uSlabC0, uSlabU0, uSlabV0, uSlabN0, uSlabH0), blurAdd, fadeOn);
  float b = probeCoverage(slabProbe(p, light, uSlabC1, uSlabU1, uSlabV1, uSlabN1, uSlabH1), blurAdd, fadeOn);
  return max(a, b * uSlabOn1);
}

void main() {
  // Slide back along the sweep to the nearest translate of the silhouette: the closed form of the union over the whole smear.
  float along = uSweepLen > 0.0 ? clamp(dot(vPos, uSweep), 0.0, uSweepLen) : 0.0;
  float t = uSweepLen > 0.0 ? along / uSweepLen : 0.0;
  float cast = shade(vPos - uSweep * along, uLight, uSweepBlur * t, 1.0) * pow(1.0 - t, uFalloff) * uOpacity;
  float ambient = uAmbient.y > 0.0 ? shade(vPos, uPlaneNormal, uAmbient.x, 0.0) * uAmbient.y : 0.0;
  float alpha = 1.0 - (1.0 - cast) * (1.0 - ambient);
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
}
`;
