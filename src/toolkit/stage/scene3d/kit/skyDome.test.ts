import { BackSide } from "three";
import { describe, expect, it } from "vitest";
import { createLookMaterial, lookMaterialProblem } from "./material";
import {
  LOOK_GLSL_SKY,
  SKY_DOME_CAMERA_FAR,
  SKY_DOME_CAMERA_REACH,
  SKY_DOME_RADIUS,
  SKY_DOME_VERTEX_SHADER,
  skyDomeMaterial,
  skyDomeRadius,
} from "./skyDome";

const FRAGMENT = /* glsl */ `
uniform vec3 uSky;
varying vec3 vSkyDir;
void main() {
  vec3 dir = normalize(vSkyDir);
  gl_FragColor = vec4(uSky * skyZenithFade(dir) * skyFbm(skyPlane(dir, 0.1), 0.0), 1.0);
  #include <colorspace_fragment>
}
`;

describe("sky dome", () => {
  it("keeps every dome radius around the camera reach and inside the far plane", () => {
    for (const r of [0, 10, SKY_DOME_RADIUS, 400, 5000, Number.NaN]) {
      const radius = skyDomeRadius(r);
      expect(radius, `${r}`).toBeGreaterThan(SKY_DOME_CAMERA_REACH);
      expect(radius + SKY_DOME_CAMERA_REACH, `${r}`).toBeLessThan(SKY_DOME_CAMERA_FAR);
    }
    expect(skyDomeRadius()).toBe(SKY_DOME_RADIUS);
  });

  it("shapes a valid look material: inward, opaque, no depth writes, sky chunk first", () => {
    const spec = skyDomeMaterial({ key: "test-look/dome", fragmentShader: FRAGMENT });
    expect(lookMaterialProblem(spec)).toBeNull();
    expect(spec.fragmentShader.startsWith(LOOK_GLSL_SKY)).toBe(true);
    const m = createLookMaterial(spec);
    expect(m.side).toBe(BackSide);
    expect(m.depthWrite).toBe(false);
    expect(m.transparent).toBe(false);
    expect(m.vertexShader.endsWith(SKY_DOME_VERTEX_SHADER)).toBe(true);
  });

  it("keeps the sky chunk vertex-safe, include-guarded and hash-clean", () => {
    expect(/\b(fwidth|dFdx|dFdy)\s*\(/.test(LOOK_GLSL_SKY)).toBe(false);
    expect(/fract\s*\(\s*sin/.test(LOOK_GLSL_SKY)).toBe(false);
    expect(LOOK_GLSL_SKY).toContain("#ifndef KK_LOOK_SKY");
    for (const fn of ["skyPlane", "skyFbm", "skyZenithFade"]) {
      expect(new RegExp(`\\b${fn}\\s*\\(`).test(LOOK_GLSL_SKY), fn).toBe(true);
    }
  });
});
