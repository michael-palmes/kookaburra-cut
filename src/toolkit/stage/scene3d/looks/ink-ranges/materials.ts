import { Color, type ShaderMaterial, Vector2, Vector3 } from "three";
import {
  createRingBandUniforms,
  type LookMaterialSpec,
  lookColorUniform,
  loopSeconds,
  RING_BANDS_MAX,
  RING_BANDS_VERTEX_SHADER,
  ringBandAngle,
} from "../../kit";
import {
  INK_FLOOR_Y,
  INK_PERIOD,
  INK_RIDGES,
  inkDiscDirection,
  inkRidgeHeight,
  inkVisibleRidges,
} from "./ranges";
import { FLOOR_FRAGMENT, RIDGE_FRAGMENT, SKY_FRAGMENT } from "./shaders";

export type InkPart = "sky" | "floor" | "ridge";
export type InkMaterials = Record<InkPart, ShaderMaterial>;

const TAU = Math.PI * 2;
const BREATHE_SECONDS = 20;
/** Floor drift circles (noise units) sized for the sketch's 0.008 and 0.01 units/s over one period. */
const LUMP_ORBIT = (0.008 * INK_PERIOD) / TAU;
const WASH_ORBIT = (0.01 * INK_PERIOD) / TAU;
/** Disc angular radius (radians) at Disc size 1. */
const DISC_RADIUS = 0.0326;
const scratch = { near: new Color(), far: new Color(), mist: new Color(), disc: [0, 0, 0] };

/** The three parts of the stack. Every part shares the ring, mist and calm uniform objects, so one write drives them all. */
export function inkMaterialSpecs(): Record<InkPart, LookMaterialSpec> {
  const ring = createRingBandUniforms();
  const mist = lookColorUniform("#000000");
  const calm = { value: 0 };
  const freq = new Float32Array(RING_BANDS_MAX).fill(1);
  const seed = new Float32Array(RING_BANDS_MAX);
  for (const [k, r] of INK_RIDGES.entries()) {
    freq[k + 1] = 1.3 + 0.075 * r.radius;
    seed[k + 1] = r.seed;
  }
  const base = { vertexShader: RING_BANDS_VERTEX_SHADER, transparent: true };
  return {
    sky: {
      ...base,
      key: "ink-ranges/sky",
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        ...ring,
        uMist: mist,
        uSun: lookColorUniform("#000000"),
        uDiscDir: { value: new Vector3(0, 0, -1) },
        uDiscR: { value: DISC_RADIUS },
        uMistH: { value: 0.2 },
      },
    },
    floor: {
      ...base,
      key: "ink-ranges/floor",
      fragmentShader: FLOOR_FRAGMENT,
      uniforms: {
        ...ring,
        uMist: mist,
        uNear: lookColorUniform("#000000"),
        uPoolR: { value: new Float32Array(RING_BANDS_MAX) },
        uLumpDrift: { value: new Vector2() },
        uWashDrift: { value: new Vector2() },
        uPools: { value: 0.3 },
        uCalm: calm,
      },
    },
    ridge: {
      ...base,
      key: "ink-ranges/ridge",
      fragmentShader: RIDGE_FRAGMENT,
      uniforms: {
        ...ring,
        uMist: mist,
        uBandCol: { value: Array.from({ length: RING_BANDS_MAX }, () => new Color()) },
        uBandLo: { value: new Float32Array(RING_BANDS_MAX) },
        uBandHi: { value: new Float32Array(RING_BANDS_MAX) },
        uBandFreq: { value: freq },
        uBandSeed: { value: seed },
        uBandWisp: { value: new Float32Array(RING_BANDS_MAX) },
        uHard: { value: 0.3 },
        uFootK: { value: 0.7 },
        uFogH: { value: 1 },
        uFloorY: { value: INK_FLOOR_Y },
        uBreathe: { value: 0 },
        uHaze: { value: 0.38 },
        uCalm: calm,
      },
    },
  };
}

/** Slot colours, with each shown ridge toned by its depth rank: near ink to far ink, paling toward mist. */
export function writeInkPalette(mats: InkMaterials, colors: string[], layers: number): void {
  const [near, far, mist, sun] = colors;
  const visible = inkVisibleRidges(layers);
  mats.ridge.uniforms.uMist.value.set(mist);
  mats.sky.uniforms.uSun.value.set(sun);
  mats.floor.uniforms.uNear.value.set(near);
  scratch.near.set(near);
  scratch.far.set(far);
  scratch.mist.set(mist);
  const cols = mats.ridge.uniforms.uBandCol.value as Color[];
  for (const [rank, k] of visible.entries()) {
    const f = rank / (visible.length - 1);
    cols[k + 1]
      .copy(scratch.near)
      .lerp(scratch.far, f)
      .lerp(scratch.mist, 0.3 * f);
  }
}

/** Every per-frame value at look time `t` (seconds): spins, wisps, breathing, floor drift and the params. Allocates nothing. */
export function writeInkFrame(mats: InkMaterials, params: Record<string, number>, t: number): void {
  const ridge = mats.ridge.uniforms;
  const angle = ridge.uRingAngle.value as Float32Array;
  const fade = ridge.uRingFade.value as Float32Array;
  const lo = ridge.uBandLo.value as Float32Array;
  const hi = ridge.uBandHi.value as Float32Array;
  const wisp = ridge.uBandWisp.value as Float32Array;
  const poolR = mats.floor.uniforms.uPoolR.value as Float32Array;
  const visible = inkVisibleRidges(params.layers);
  const spin = t * params.drift;
  for (const [k, r] of INK_RIDGES.entries()) {
    const shown = visible.includes(k);
    angle[k + 1] = ringBandAngle(spin, r.turns, INK_PERIOD);
    fade[k + 1] = shown ? 1 : 0;
    poolR[k + 1] = shown ? r.radius : 0;
    lo[k + 1] = inkRidgeHeight(r.lo, params.horizon);
    hi[k + 1] = inkRidgeHeight(r.hi, params.horizon);
    wisp[k + 1] = ringBandAngle(t, r.wisp, INK_PERIOD);
  }
  ridge.uHard.value = params.hardness;
  ridge.uFootK.value = 2.2 - 2.5 * params.mist;
  ridge.uFogH.value = 0.3 + 1.2 * params.mist;
  ridge.uBreathe.value = (loopSeconds(t, BREATHE_SECONDS) / BREATHE_SECONDS) * TAU;
  ridge.uHaze.value = params.eyeHaze;
  ridge.uCalm.value = params.textCalm;

  const sky = mats.sky.uniforms;
  (sky.uDiscDir.value as Vector3).fromArray(inkDiscDirection(params.horizon, scratch.disc));
  sky.uDiscR.value = DISC_RADIUS * params.discSize;
  sky.uMistH.value = 0.2 * (0.4 + params.mist);

  const floor = mats.floor.uniforms;
  const phase = (loopSeconds(t, INK_PERIOD) / INK_PERIOD) * TAU;
  (floor.uLumpDrift.value as Vector2).set(
    3 + Math.cos(phase) * LUMP_ORBIT,
    Math.sin(phase) * LUMP_ORBIT,
  );
  (floor.uWashDrift.value as Vector2).set(
    Math.sin(phase) * WASH_ORBIT,
    Math.cos(phase) * WASH_ORBIT,
  );
  floor.uPools.value = 0.3 * (0.4 + params.mist);
}
