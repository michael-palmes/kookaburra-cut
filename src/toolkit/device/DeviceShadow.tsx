import { useLayoutEffect, useMemo } from "react";
import { ShaderMaterial, Vector2, Vector3, Vector4 } from "three";
import type { V3 } from "../types";
import type { DeviceSpec } from "./catalog";
import {
  DEVICE_SHADOW_MODES,
  type DeviceShadowMode,
  deviceShadowSlabs,
  lightDirection,
  sweptMiddleSlab,
  SHADOW_AMBIENT_MAX_BLUR,
  SHADOW_FRAG,
  SHADOW_VERT,
  type ShadowModeSpec,
  type ShadowPlane,
  type ShadowPose,
  type ShadowSlab,
  shadowLightDirection,
  shadowPlane,
  shadowQuad,
  shadowSweepDirection,
} from "./shadowProjector";

/** The presentation shadow: one analytic projector, one quad, driven by the device's live pose. Mounted OUTSIDE the animated inner group so the receiver stays put on the floor while the occluder moves, which is what lets a float lift widen and lighten its own shadow. Maths, mode parameters and the shaders: `shadowProjector.ts`. */

function makeUniforms() {
  const slab = () => ({
    c: { value: new Vector3() },
    u: { value: new Vector3() },
    v: { value: new Vector3() },
    n: { value: new Vector3() },
    h: { value: new Vector4() },
  });
  const a = slab();
  const b = slab();
  return {
    uSize: { value: new Vector2(1, 1) },
    uCentre: { value: new Vector2() },
    uPlaneOrigin: { value: new Vector3() },
    uPlaneE1: { value: new Vector3() },
    uPlaneE2: { value: new Vector3() },
    uLight: { value: new Vector3() },
    uFillLight: { value: new Vector3() },
    uFillOpacity: { value: 0 },
    uPlaneNormal: { value: new Vector3() },
    uSweep: { value: new Vector2() },
    uSweepLen: { value: 0 },
    uSweepBlur: { value: 0 },
    uSweepFrom: { value: new Vector2() },
    uSweepWorld: { value: new Vector3() },
    uSlabM0C: { value: new Vector3() },
    uSlabM0U: { value: new Vector3() },
    uSlabM0V: { value: new Vector3() },
    uSlabM0N: { value: new Vector3() },
    uSlabM0H: { value: new Vector4() },
    uSlabM1C: { value: new Vector3() },
    uSlabM1U: { value: new Vector3() },
    uSlabM1V: { value: new Vector3() },
    uSlabM1N: { value: new Vector3() },
    uSlabM1H: { value: new Vector4() },
    uBlurNear: { value: 0 },
    uSoftness: { value: 0 },
    uOpacity: { value: 0 },
    uFadeLength: { value: 1 },
    uFalloff: { value: 1 },
    uAmbient: { value: new Vector2() },
    uAmbientMin: { value: 0 },
    uSlabC0: a.c,
    uSlabU0: a.u,
    uSlabV0: a.v,
    uSlabN0: a.n,
    uSlabH0: a.h,
    uSlabC1: b.c,
    uSlabU1: b.u,
    uSlabV1: b.v,
    uSlabN1: b.n,
    uSlabH1: b.h,
    uSlabOn1: { value: 0 },
  };
}

type Uniforms = ReturnType<typeof makeUniforms>;

function writeMiddleSlab(uniforms: Uniforms, index: 0 | 1, slab: ShadowSlab): void {
  const c = index === 0 ? uniforms.uSlabM0C : uniforms.uSlabM1C;
  const u = index === 0 ? uniforms.uSlabM0U : uniforms.uSlabM1U;
  const v = index === 0 ? uniforms.uSlabM0V : uniforms.uSlabM1V;
  const n = index === 0 ? uniforms.uSlabM0N : uniforms.uSlabM1N;
  const h = index === 0 ? uniforms.uSlabM0H : uniforms.uSlabM1H;
  c.value.set(...slab.center);
  u.value.set(...slab.u);
  v.value.set(...slab.v);
  n.value.set(...slab.n);
  h.value.set(slab.half[0], slab.half[1], slab.thickness / 2, slab.radius);
}

function writeSlab(uniforms: Uniforms, index: 0 | 1, slab: ShadowSlab | undefined): void {
  const c = index === 0 ? uniforms.uSlabC0 : uniforms.uSlabC1;
  const u = index === 0 ? uniforms.uSlabU0 : uniforms.uSlabU1;
  const v = index === 0 ? uniforms.uSlabV0 : uniforms.uSlabV1;
  const n = index === 0 ? uniforms.uSlabN0 : uniforms.uSlabN1;
  const h = index === 0 ? uniforms.uSlabH0 : uniforms.uSlabH1;
  if (!slab) {
    h.value.set(0, 0, 0, 0);
    return;
  }
  c.value.set(...slab.center);
  u.value.set(...slab.u);
  v.value.set(...slab.v);
  n.value.set(...slab.n);
  // (halfU, halfV, halfThickness, cornerRadius): the shader's true 3D rounded box.
  h.value.set(slab.half[0], slab.half[1], slab.thickness / 2, slab.radius);
}

/** Per-render uniform refresh, the `LayeredScreenshot` style: every value is a pure function of the pose, so preview and export cannot drift. */
function refreshUniforms(
  uniforms: Uniforms,
  slabs: ShadowSlab[],
  plane: ShadowPlane,
  light: V3,
  mode: ShadowModeSpec,
  quad: { centre: [number, number]; size: [number, number] },
  scale: number,
): void {
  uniforms.uSize.value.set(quad.size[0], quad.size[1]);
  uniforms.uCentre.value.set(quad.centre[0], quad.centre[1]);
  uniforms.uPlaneOrigin.value.set(...plane.origin);
  uniforms.uPlaneE1.value.set(...plane.e1);
  uniforms.uPlaneE2.value.set(...plane.e2);
  uniforms.uLight.value.set(...light);
  const fillDir = mode.fill ? lightDirection(mode.fill.azimuthDeg, mode.fill.elevationDeg) : null;
  if (fillDir) uniforms.uFillLight.value.set(...fillDir);
  uniforms.uFillOpacity.value = mode.fill?.opacity ?? 0;
  uniforms.uPlaneNormal.value.set(...plane.normal);
  const sweep = shadowSweepDirection(plane, light);
  uniforms.uSweep.value.set(sweep[0], sweep[1]);
  const sweepLen = sweep[0] === 0 && sweep[1] === 0 ? 0 : mode.sweepLength * scale;
  uniforms.uSweepLen.value = sweepLen;
  uniforms.uSweepBlur.value = mode.sweepBlur * scale;
  if (sweepLen > 0) {
    // World sweep vector plus the tangent-band slabs: the hull pieces the swept probe unions.
    const sweepWorld: V3 = [
      (plane.e1[0] * sweep[0] + plane.e2[0] * sweep[1]) * sweepLen,
      (plane.e1[1] * sweep[0] + plane.e2[1] * sweep[1]) * sweepLen,
      (plane.e1[2] * sweep[0] + plane.e2[2] * sweep[1]) * sweepLen,
    ];
    uniforms.uSweepWorld.value.set(...sweepWorld);
    writeMiddleSlab(uniforms, 0, sweptMiddleSlab(slabs[0], sweepWorld, plane.normal));
    if (slabs[1]) writeMiddleSlab(uniforms, 1, sweptMiddleSlab(slabs[1], sweepWorld, plane.normal));
    // The ramp anchors at the root: the slab centre projected along the light onto the plane.
    const rel: V3 = [
      slabs[0].center[0] - plane.origin[0],
      slabs[0].center[1] - plane.origin[1],
      slabs[0].center[2] - plane.origin[2],
    ];
    const denom =
      light[0] * plane.normal[0] + light[1] * plane.normal[1] + light[2] * plane.normal[2];
    const along =
      (rel[0] * plane.normal[0] + rel[1] * plane.normal[1] + rel[2] * plane.normal[2]) /
      (denom === 0 ? 1 : denom);
    const hit: V3 = [
      rel[0] - light[0] * along,
      rel[1] - light[1] * along,
      rel[2] - light[2] * along,
    ];
    uniforms.uSweepFrom.value.set(
      hit[0] * plane.e1[0] + hit[1] * plane.e1[1] + hit[2] * plane.e1[2],
      hit[0] * plane.e2[0] + hit[1] * plane.e2[1] + hit[2] * plane.e2[2],
    );
  }
  uniforms.uBlurNear.value = mode.blurNear * scale;
  // Dimensionless: the light's apparent size, not a length, so it must not scale with the device.
  uniforms.uSoftness.value = mode.softness;
  uniforms.uOpacity.value = mode.opacity;
  uniforms.uFadeLength.value = mode.fadeLength * scale;
  uniforms.uFalloff.value = mode.falloff;
  uniforms.uAmbient.value.set(
    Math.min(mode.ambientBlur * scale, SHADOW_AMBIENT_MAX_BLUR),
    mode.ambientOpacity,
  );
  uniforms.uAmbientMin.value = (mode.ambientMinHalf ?? 0) * scale;
  writeSlab(uniforms, 0, slabs[0]);
  writeSlab(uniforms, 1, slabs[1]);
  uniforms.uSlabOn1.value = slabs[1] ? 1 : 0;
}

export function DeviceShadow({
  spec,
  mode,
  pose,
  groundY,
}: {
  spec: DeviceSpec;
  mode: Exclude<DeviceShadowMode, "none">;
  pose: ShadowPose;
  /** Local y of the floor the device stands on; ignored by the behind-plane mode. */
  groundY: number;
}) {
  const uniforms = useMemo(makeUniforms, []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms,
      }),
    [uniforms],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  const modeSpec = DEVICE_SHADOW_MODES[mode];
  const scale = pose.scale * pose.introScale;
  const slabs = deviceShadowSlabs(spec, pose);
  const plane = shadowPlane(modeSpec, groundY, pose.scale, pose, slabs);
  const light = shadowLightDirection(modeSpec, plane);
  const quad = shadowQuad(slabs, plane, light, modeSpec, scale);
  if (!quad) return null;
  refreshUniforms(uniforms, slabs, plane, light, modeSpec, quad, scale);

  const centre: V3 = [
    plane.origin[0] + plane.e1[0] * quad.centre[0] + plane.e2[0] * quad.centre[1],
    plane.origin[1] + plane.e1[1] * quad.centre[0] + plane.e2[1] * quad.centre[1],
    plane.origin[2] + plane.e1[2] * quad.centre[0] + plane.e2[2] * quad.centre[1],
  ];
  return (
    <mesh
      position={centre}
      // The floor quad faces up; the behind quad shares the device's own rotation, the frame its plane basis was built in.
      rotation={modeSpec.receiver === "floor" ? [-Math.PI / 2, 0, 0] : pose.rotation}
      scale={[quad.size[0], quad.size[1], 1]}
    >
      <planeGeometry args={[1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
