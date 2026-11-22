import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";
import { createSeededRandom } from "../../../engine/rng";
import { supersampleCount, supersampleSeed } from "../../../engine/supersample";
import { BEAM_FRAGMENT, BEAM_VERTEX } from "./beamShader";
import { DUST_FRAGMENT, DUST_VERTEX } from "./dustShader";

/** The beam's compile-time switches: each adds code only when on, so a plain beam keeps its exact program. */
export interface BeamFlags {
  box: boolean;
  smoke: boolean;
  extinction: boolean;
  ground: boolean;
}

/** The beam's material: drawn on the back faces of a proxy box, every uniform written per frame or per draw. */
export function createBeamMaterial(flags: BeamFlags): ShaderMaterial {
  return new ShaderMaterial({
    name: "kookaburra-volumetric-spot",
    defines: {
      ...(flags.box ? { BEAM_BOX: 1 } : {}),
      ...(flags.smoke ? { BEAM_SMOKE: 1 } : {}),
      ...(flags.extinction ? { BEAM_EXTINCT: 1 } : {}),
      ...(flags.ground ? { BEAM_GROUND: 1 } : {}),
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: BackSide,
    blending: AdditiveBlending,
    uniforms: {
      uSampleSeed: supersampleSeed,
      uSampleCount: supersampleCount,
      uApex: { value: new Vector3() },
      uAxis: { value: new Vector3(0, -1, 0) },
      uCosOuter: { value: 0.9 },
      uCosInner: { value: 0.95 },
      uRange: { value: 0 },
      uDecay: { value: 1.2 },
      uSoftRadius: { value: 0.6 },
      uRadiance: { value: new Color() },
      uDensity: { value: 0.3 },
      uG: { value: 0.5 },
      uFloorY: { value: -1.5 },
      uHeightFalloff: { value: 0 },
      uDrift: { value: new Vector3() },
      uNoiseScale: { value: 0.5 },
      uNoiseAmount: { value: 0.5 },
      uGobo: { value: null },
      uGoboOn: { value: 0 },
      uLightMatrix: { value: new Matrix4() },
      uShadowMap: { value: null },
      uShadowOn: { value: 0 },
      uShadowBias: { value: 0 },
      uHotspot: { value: 0 },
      uSceneDepth: { value: null },
      uVeilOn: { value: 0 },
      uDepthSize: { value: new Vector2(1, 1) },
      uCamForward: { value: new Vector3(0, 0, -1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 1000 },
      uBoxMin: { value: new Vector3() },
      uBoxMax: { value: new Vector3() },
      uSmokeScale: { value: 0.2 },
      uSmokeWarp: { value: 1 },
      uSmokeWarpScale: { value: 0.1 },
      uSmokeContrast: { value: new Vector2(0.4, 0.6) },
      uSmokeFloor: { value: 0 },
      uSmokeShift: { value: new Vector3() },
      uWarpShift: { value: new Vector3() },
      uSmokeOffset: { value: new Vector3() },
      uFrontFade: { value: new Vector3(0, 1, 1) },
      uMeanDensity: { value: 0 },
      uGroundFade: { value: 1 },
    },
  });
}

/** Seeded dust: one point per mote, its seed in `aSeed`, everything else computed on the GPU. */
export function createBeamDust(count: number, seed: number) {
  const rand = createSeededRandom(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 4));
  const material = new ShaderMaterial({
    name: "kookaburra-beam-dust",
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    uniforms: {
      uMin: { value: new Vector3() },
      uMax: { value: new Vector3() },
      uShift: { value: new Vector3() },
      uWander: { value: new Vector3() },
      uJitter: { value: 0 },
      uJitterScale: { value: 1 },
      uRadius: { value: new Vector2() },
      uPxPerUnit: { value: 1000 },
      uApex: { value: new Vector3() },
      uAxis: { value: new Vector3(0, -1, 0) },
      uCosOuter: { value: 0.9 },
      uCosInner: { value: 0.95 },
      uDecay: { value: 2 },
      uG: { value: 0.6 },
      uLightMatrix: { value: new Matrix4() },
      uGobo: { value: null },
      uGoboOn: { value: 0 },
      uShadowMap: { value: null },
      uShadowOn: { value: 0 },
      uShadowBias: { value: 0 },
      uColor: { value: new Color() },
    },
  });
  return { geometry, material };
}
