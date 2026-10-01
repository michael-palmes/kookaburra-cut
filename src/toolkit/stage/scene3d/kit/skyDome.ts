import { useLayoutEffect, useMemo } from "react";
import { BackSide, SphereGeometry } from "three";
import { glslFloat } from "./glsl";
import type { LookMaterialSpec } from "./material";

/** Sky dome (F7): an inward shell centred on the stage, shaded by direction from its centre, so the pattern is independent of tessellation and output size. Depth writes are off, so everything nearer paints over it. */

/** r3f's default camera far plane (the app never overrides it). */
export const SKY_DOME_CAMERA_FAR = 1000;
/** The furthest a camera rig reaches from the stage centre (orbit dolly out). */
export const SKY_DOME_CAMERA_REACH = 50;
/** Default dome radius: encloses every camera pose, far inside the far plane. */
export const SKY_DOME_RADIUS = 70;
/** Sphere tessellation: direction shading makes it matter only for the chord sag. */
export const SKY_DOME_SEGMENTS = { width: 96, height: 48 } as const;

/** Clamps a dome radius so it always encloses the camera reach and its far side stays inside the far plane from any pose. */
export function skyDomeRadius(radius: number = SKY_DOME_RADIUS): number {
  const min = SKY_DOME_CAMERA_REACH + 10;
  const max = SKY_DOME_CAMERA_FAR * 0.9 - SKY_DOME_CAMERA_REACH;
  return Math.min(max, Math.max(min, Number.isFinite(radius) ? radius : SKY_DOME_RADIUS));
}

/** Frame aspect below which `skyZenithFade(dir)` starts lowering the fade, and where it is fully lowered. */
export const SKY_PORTRAIT_ASPECT = { full: 0.75, none: 1 } as const;

/** VERTEX-SAFE sky helpers (needs the kit noise). `skyPlane` maps a direction onto a virtual ceiling plane (`dir.xz` over elevation plus `lift`); `skyFbm(p, fw[, octaves])` is 5-octave fbm whose octaves fade to their mean once finer than about two pixels (`fw` is the plane's pixel footprint, `length(fwidth(p))`), so the compressed horizon never shimmers; faded or dropped octaves cost nothing and add their mean; `skyZenithFade` is 1 below the zenith band and 0 at the zenith, starting lower in portrait frames. */
// language=GLSL
export const LOOK_GLSL_SKY: string = /* glsl */ `
#ifndef KK_LOOK_SKY
#define KK_LOOK_SKY
vec2 skyPlane(vec3 dir, float lift) {
  return dir.xz / (max(dir.y, 0.0) + lift);
}
float skyFbm(vec2 p, float fw, int octaves) {
  float s = 0.0;
  float a = 0.5;
  float f = 1.0;
  float used = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves || fw * f >= 0.5) break;
    s += a * mix(0.5, vnoise(p), 1.0 - smoothstep(0.2, 0.5, fw * f));
    used += a;
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
    f *= 2.03;
  }
  return s + 0.5 * (0.96875 - used);
}
float skyFbm(vec2 p, float fw) {
  return skyFbm(p, fw, 5);
}
float skyZenithFade(vec3 dir, float start, float end) {
  return 1.0 - smoothstep(start, end, dir.y);
}
float skyZenithFade(vec3 dir) {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float portrait = 1.0 - smoothstep(${glslFloat(SKY_PORTRAIT_ASPECT.full)}, ${glslFloat(SKY_PORTRAIT_ASPECT.none)}, aspect);
  return skyZenithFade(dir, mix(0.5, 0.38, portrait), mix(0.85, 0.72, portrait));
}
#endif
`;

/** Dome vertex shader: `vSkyDir` (unnormalised direction from the dome centre in world orientation; normalise it per fragment) and `vWorld` (for the calm halo). */
// language=GLSL
export const SKY_DOME_VERTEX_SHADER: string = /* glsl */ `
varying vec3 vSkyDir;
varying vec3 vWorld;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vSkyDir = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** A look material spec shaped as a sky dome: the dome vertex shader, the sky chunk prepended to the fragment, inward faces, opaque with depth writes off. */
export function skyDomeMaterial(
  spec: Omit<LookMaterialSpec, "vertexShader" | "side" | "cutaway" | "depthWrite">,
): LookMaterialSpec {
  return {
    ...spec,
    vertexShader: SKY_DOME_VERTEX_SHADER,
    fragmentShader: `${LOOK_GLSL_SKY}\n${spec.fragmentShader}`,
    side: BackSide,
    depthWrite: false,
  };
}

/** The dome's sphere, built once per radius and disposed on change or unmount. */
export function useSkyDomeGeometry(radius: number = SKY_DOME_RADIUS): SphereGeometry {
  const r = skyDomeRadius(radius);
  const geometry = useMemo(
    () => new SphereGeometry(r, SKY_DOME_SEGMENTS.width, SKY_DOME_SEGMENTS.height),
    [r],
  );
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}
