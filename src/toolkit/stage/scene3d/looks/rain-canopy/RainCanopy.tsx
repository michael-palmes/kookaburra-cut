import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type InstancedMesh,
  LatheGeometry,
  Vector2,
  Vector3,
} from "three";
import {
  hexLattice,
  type InstancePose,
  type LatticePoint,
  LOOK_GLSL_BACKING,
  LOOK_GLSL_INSTANCE_ANCHOR,
  loopSeconds,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";

/** Rain canopy: a hex-packed ceiling of teardrops on thin threads, lifted by three plane waves 120 degrees apart whose weights cross-fade (Kinetic Rain, Reuben Margolin). Static anchors, every height in the vertex shader. */

const TAU = Math.PI * 2;
const RADIUS = 30;
const DROP_LEN = 0.4;
const THREAD_TOP = 12.5;
const THREAD_WIDTH = 0.012;
export const SPACING_MIN = 0.8;
const CAPACITY = hexLattice(SPACING_MIN, RADIUS).length;
const SUN_ELEVATION = 0.5;

// language=GLSL
const WAVE = /* glsl */ `
const float RC_TAU = 6.28318530718;
uniform float uTime;
uniform float uPeriod;
uniform float uAmp;
uniform float uBase;
uniform float uDroop;
uniform float uLen;
float rcWave(vec2 p) {
  float ph = RC_TAU * uTime / uPeriod;
  float k = RC_TAU / 15.0;
  float w0 = 0.5 + 0.5 * cos(ph);
  float w1 = 0.5 + 0.5 * cos(ph - RC_TAU / 3.0);
  float w2 = 0.5 + 0.5 * cos(ph - 2.0 * RC_TAU / 3.0);
  float s = w0 * sin(k * dot(vec2(0.940, 0.342), p) - ph + 0.4)
    + w1 * sin(k * 1.17 * dot(vec2(-0.766, 0.643), p) - 2.0 * ph + 1.9)
    + w2 * sin(k * 0.83 * dot(vec2(-0.174, -0.985), p) - ph + 4.1);
  return (0.7 + 0.3 * cos(2.0 * ph + 1.3)) * s / 1.5;
}
float rcTop(vec2 p, float wave) {
  float r = length(p);
  float bell = smoothstep(10.0, 30.0, r);
  float y = uBase - uDroop * bell + uAmp * (1.0 - 0.45 * bell) * wave;
  return mix(y, max(y, 2.8 + uLen), 1.0 - smoothstep(11.0, 13.0, r));
}
`;

// A taller halo than the kit default: portrait headlines sit near y 1.9, just under the canopy.
// language=GLSL
const CALM = /* glsl */ `
uniform float uCalm;
float rcCalm(vec3 wp) { return clamp(uCalm, 0.0, 1.0) * stageHalo(wp, vec2(4.0, 2.4), 0.35); }
`;

// language=GLSL
const DROP_VERTEX = /* glsl */ `
${LOOK_GLSL_INSTANCE_ANCHOR}
${WAVE}
${CALM}
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
varying float vAlpha;
varying float vFog;
varying float vCalm;
varying float vGlint;
void main() {
  vec3 anchor = lookInstanceAnchor();
  float wave = rcWave(anchor.xz);
  vec4 w = modelMatrix * vec4(position + vec3(anchor.x, rcTop(anchor.xz, wave), anchor.z), 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 mv = viewMatrix * w;
  float px = uLen * exportPxPerUnit(-mv.z);
  vCalm = rcCalm(w.xyz);
  vCrest = smoothstep(0.25, 0.9, wave) * (1.0 - vCalm);
  vGlint = smoothstep(6.0, 24.0, px) * (1.0 - vCalm);
  vFog = smoothstep(8.0, 27.0, length(anchor.xz)) * 0.9;
  vAlpha = mix(0.45, 1.0, smoothstep(1.5, 4.0, px)) * (1.0 - 0.75 * vCalm);
  gl_Position = projectionMatrix * mv;
}
`;

// language=GLSL
const DROP_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uDrop;
uniform vec3 uCrest;
uniform vec3 uSun;
uniform vec3 uBacking;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
varying float vAlpha;
varying float vFog;
varying float vCalm;
varying float vGlint;
void main() {
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 l = normalize(uSun);
  float lambert = clamp(dot(n, l) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 2.5) * (1.0 - 0.6 * vCalm);
  float glint = pow(max(dot(n, normalize(l + v)), 0.0), 36.0) * vGlint;
  vec3 body = mix(uDrop, mix(uDrop, uCrest, 0.6), lambert);
  body = mix(body, uCrest, clamp(vCrest * 0.55 + fresnel * 0.45 + glint * 0.9, 0.0, 1.0));
  body = backingMix(body, uBacking, vFog);
  float a = vAlpha * stageFade(vWorld);
  if (a < 0.004) discard;
  gl_FragColor = vec4(body, a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
const THREAD_VERTEX = /* glsl */ `
${LOOK_GLSL_INSTANCE_ANCHOR}
${WAVE}
uniform float uWidth;
uniform float uTopY;
varying float vCover;
varying float vAcross;
varying float vHalf;
varying float vAlong;
varying float vRadius;
varying vec3 vWorld;
void main() {
  vec3 anchor = lookInstanceAnchor();
  vec3 a = (modelMatrix * vec4(anchor.x, rcTop(anchor.xz, rcWave(anchor.xz)), anchor.z, 1.0)).xyz;
  vec3 b = (modelMatrix * vec4(anchor.x, uTopY, anchor.z, 1.0)).xyz;
  vAlong = position.y;
  vRadius = length(anchor.xz);
  vWorld = mix(a, b, position.y);
  vec4 va = viewMatrix * vec4(a, 1.0);
  vec4 vb = viewMatrix * vec4(b, 1.0);
  const float nearZ = -0.15;
  if (va.z > nearZ && vb.z > nearZ) {
    vCover = 0.0;
    vAcross = 0.0;
    vHalf = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (va.z > nearZ) va = mix(va, vb, (va.z - nearZ) / (va.z - vb.z));
  if (vb.z > nearZ) vb = mix(vb, va, (vb.z - nearZ) / (vb.z - va.z));
  vec4 ca = projectionMatrix * va;
  vec4 cb = projectionMatrix * vb;
  vec2 aspect = vec2(projectionMatrix[1][1] / projectionMatrix[0][0], 1.0);
  vec2 dir = cb.xy / cb.w * aspect - ca.xy / ca.w * aspect;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(0.0, 1.0);
  vec4 vv = mix(va, vb, position.y);
  vec4 c = mix(ca, cb, position.y);
  float truePx = uWidth * exportPxPerUnit(max(-vv.z, 0.1));
  float minPx = max(1.0, 1.4 * uPx);
  float corePx = max(truePx, minPx);
  float drawPx = corePx + 1.5;
  vCover = min(1.0, truePx / minPx);
  vAcross = position.x * drawPx;
  vHalf = corePx * 0.5;
  c.xy += vec2(-dir.y, dir.x) * position.x * drawPx * 2.0 / uResolution.y / aspect * c.w;
  gl_Position = c;
}
`;

// language=GLSL
const THREAD_FRAGMENT = /* glsl */ `
${CALM}
uniform vec3 uThread;
uniform float uOpacity;
varying float vCover;
varying float vAcross;
varying float vHalf;
varying float vAlong;
varying float vRadius;
varying vec3 vWorld;
void main() {
  float edge = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  float fade = (1.0 - smoothstep(0.35, 1.0, vAlong)) * (1.0 - 0.8 * smoothstep(14.0, 30.0, vRadius));
  float a = uOpacity * edge * vCover * fade * stageFade(vWorld) * (1.0 - 0.75 * rcCalm(vWorld));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uThread, a);
  #include <colorspace_fragment>
}
`;

/** Lathe teardrop, point up at the thread, 144 triangles. */
function teardropGeometry(): LatheGeometry {
  const steps = 6;
  const profile: Vector2[] = [];
  for (let s = steps; s >= 0; s--) {
    const th = (s / steps) * Math.PI;
    profile.push(
      new Vector2(
        0.175 * Math.sin(th) * Math.sin(th / 2) ** 1.2,
        (-DROP_LEN * (1 - Math.cos(th))) / 2,
      ),
    );
  }
  return new LatheGeometry(profile, 12);
}

/** Unit thread quad: x across (-0.5..0.5), y along from the drop (0) to the ceiling (1). */
function threadGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

const anchorPose = (p: LatticePoint, _i: number, out: InstancePose) => {
  out.position.set(p.x, 0, p.z);
};

export function RainCanopy({ colors, params, speed, backing }: Scene3dLookProps) {
  const dropsRef = useRef<InstancedMesh>(null);
  const threadsRef = useRef<InstancedMesh>(null);
  const t = useLookTime(speed);
  const drop = useMemo(teardropGeometry, []);
  const thread = useMemo(threadGeometry, []);
  useLayoutEffect(
    () => () => {
      drop.dispose();
      thread.dispose();
    },
    [drop, thread],
  );
  const cells = useMemo(() => hexLattice(params.spacing, RADIUS), [params.spacing]);
  const meshes = useMemo(() => [dropsRef, threadsRef], []);
  useStaticInstancedLayout(meshes, cells, anchorPose);

  const mats = useLookMaterials(() => {
    // One set of uniform objects shared by both materials, so the threads follow the drops.
    const wave = {
      uTime: { value: 0 },
      uPeriod: { value: 90 },
      uAmp: { value: 0.9 },
      uBase: { value: 5.8 },
      uDroop: { value: 3.6 },
      uLen: { value: DROP_LEN },
      uCalm: { value: 0.6 },
    };
    return {
      drop: {
        key: "rain-canopy/drop",
        vertexShader: DROP_VERTEX,
        fragmentShader: DROP_FRAGMENT,
        transparent: true,
        depthWrite: true,
        uniforms: {
          ...wave,
          uDrop: { value: new Color() },
          uCrest: { value: new Color() },
          uBacking: { value: new Color() },
          uSun: { value: new Vector3(0, 1, 0) },
        },
      },
      thread: {
        key: "rain-canopy/thread",
        vertexShader: THREAD_VERTEX,
        fragmentShader: THREAD_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          ...wave,
          uWidth: { value: THREAD_WIDTH },
          uTopY: { value: THREAD_TOP },
          uThread: { value: new Color() },
          uOpacity: { value: 0.25 },
        },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.drop.uniforms;
    const period = params.period;
    const time = loopSeconds(t, period);
    u.uTime.value = time;
    u.uPeriod.value = period;
    u.uAmp.value = params.amplitude;
    u.uBase.value = params.height;
    u.uDroop.value = params.droop;
    u.uCalm.value = params.textCalm;
    const az = (TAU * time) / period + 0.6;
    u.uSun.value.set(
      Math.cos(SUN_ELEVATION) * Math.sin(az),
      Math.sin(SUN_ELEVATION),
      Math.cos(SUN_ELEVATION) * Math.cos(az),
    );
    mats.thread.uniforms.uOpacity.value = params.threads;
  });
  useLayoutEffect(() => {
    mats.drop.uniforms.uDrop.value.set(colors[0]);
    mats.thread.uniforms.uThread.value.set(colors[1]);
    mats.drop.uniforms.uCrest.value.set(colors[2]);
    mats.drop.uniforms.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <instancedMesh
        ref={threadsRef}
        args={[undefined, undefined, CAPACITY]}
        geometry={thread}
        material={mats.thread}
        frustumCulled={false}
        visible={params.threads > 0}
      />
      <instancedMesh
        ref={dropsRef}
        args={[undefined, undefined, CAPACITY]}
        geometry={drop}
        material={mats.drop}
        frustumCulled={false}
      />
    </group>
  );
}
