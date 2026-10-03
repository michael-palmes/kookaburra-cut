import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  CircleGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  type InstancedMesh,
  PlaneGeometry,
  Vector3,
  Vector4,
} from "three";
import {
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { FLOOR_FRAGMENT, SHAFT_FRAGMENT, SHAFT_VERTEX, SLOT_FRAGMENT } from "./shaders";
import {
  CLERESTORY,
  clerestoryLayout,
  DUST_NOISE,
  dustFrame,
  fallShift,
  shaftAzimuth,
  shaftBreath,
  shaftDirection,
  shaftPose,
  slotPose,
  WISP_NOISE,
} from "./shafts";

const ROOT_DATA = { kookaburraBg3d: true };
const MAX = CLERESTORY.maxShafts;
const FLOOR_POSITION: [number, number, number] = [0, CLERESTORY.floorY, 0];
const FLOOR_RADIUS = 115;
const DARK_LUMINANCE = 0.2;
const HAZE_DEFAULT = 0.6;
const DUST_GAIN = 1.8;
const ALPHA_CAP = { light: 0.34, dark: 0.42 } as const;

/** Clerestory shafts: soft parallel sun shafts from high glowing roof slots, each an instanced sheared box marched in its own fragment, landing as analytic pools (F6) on a floor that fades straight into the backing. The sun sweeps, every shaft breathes and dust falls down the beams, all on the absolute look clock. */
export function ClerestoryShafts({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const shaftsRef = useRef<InstancedMesh>(null);
  const slotsRef = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    const box = new BoxGeometry(1, 1, 1);
    box.setAttribute("aWave", new InstancedBufferAttribute(new Float32Array(MAX * 2), 2));
    return {
      box,
      slot: new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      floor: new CircleGeometry(FLOOR_RADIUS, 96).rotateX(-Math.PI / 2),
    };
  }, []);
  useLayoutEffect(
    () => () => {
      geometry.box.dispose();
      geometry.slot.dispose();
      geometry.floor.dispose();
    },
    [geometry],
  );

  const count = Math.min(MAX, Math.max(1, Math.round(params.shaftCount)));
  const tilt = params.tilt;
  const sweep = params.sweep;
  const shafts = useMemo(() => clerestoryLayout(count, tilt, sweep), [count, tilt, sweep]);
  const fall = useMemo<[number, number, number]>(() => [0, -1, 0], []);
  const shaftMeshes = useMemo(() => [shaftsRef], []);
  const slotMeshes = useMemo(() => [slotsRef], []);
  useStaticInstancedLayout(shaftMeshes, shafts, shaftPose);
  useStaticInstancedLayout(slotMeshes, shafts, slotPose);

  const mats = useLookMaterials(
    () => ({
      shafts: {
        key: "clerestory-shafts/shaft",
        vertexShader: SHAFT_VERTEX,
        fragmentShader: SHAFT_FRAGMENT,
        transparent: true,
        cutaway: true,
        uniforms: {
          uBeam: lookColorUniform("#715f3d"),
          uAir: lookColorUniform("#3a2f23"),
          uFall: { value: new Vector3(0, -1, 0) },
          uBreathPhase: { value: 0 },
          uMaxAlpha: { value: ALPHA_CAP.dark },
          uDensity: { value: 1 },
          uDust: { value: 0.9 },
          uFallA: { value: new Vector3(1, 0, 0) },
          uFallB: { value: new Vector3(0, 0, 1) },
          uFallC: { value: new Vector3(0, -1, 0) },
          uDustShift: { value: 0 },
          uWispShift: { value: 0 },
        },
      },
      slots: {
        key: "clerestory-shafts/slot",
        fragmentShader: SLOT_FRAGMENT,
        transparent: true,
        side: DoubleSide,
        uniforms: { uSlot: lookColorUniform("#a88b58") },
      },
      floor: {
        key: "clerestory-shafts/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: {
          uBeam: lookColorUniform("#715f3d"),
          uFloor: lookColorUniform("#1b1512"),
          uBacking: lookColorUniform("#251f18"),
          uSun: { value: new Vector3(0, 1, 0) },
          uSlots: { value: Array.from({ length: MAX }, () => new Vector4()) },
          uSlotAxes: { value: Array.from({ length: MAX }, () => new Vector4()) },
          uCount: { value: 0 },
          uSoft: { value: 0.45 },
        },
      },
    }),
    [],
  );

  const [beam, air, floor, slot] = colors;
  useLayoutEffect(() => {
    const s = mats.shafts.uniforms;
    const f = mats.floor.uniforms;
    s.uBeam.value.set(beam);
    s.uAir.value.set(air);
    f.uBeam.value.set(beam);
    f.uFloor.value.set(floor);
    f.uBacking.value.set(backing);
    mats.slots.uniforms.uSlot.value.set(slot);
    const dark = lookLuminance(floor) < DARK_LUMINANCE;
    s.uMaxAlpha.value = dark ? ALPHA_CAP.dark : ALPHA_CAP.light;
  }, [mats, beam, air, floor, slot, backing]);

  useLayoutEffect(() => {
    const wave = geometry.box.getAttribute("aWave") as InstancedBufferAttribute;
    const f = mats.floor.uniforms;
    shafts.forEach((s, i) => {
      wave.setXY(i, s.cycles, s.phase);
      f.uSlots.value[i].set(s.slot[0], s.slot[1], s.slot[2], 1);
      f.uSlotAxes.value[i].set(s.tangent[0], s.tangent[1], s.length / 2, s.width / 2);
    });
    wave.needsUpdate = true;
    f.uCount.value = shafts.length;
  }, [geometry, mats, shafts]);

  useLayoutEffect(() => {
    const [a, b, c] = dustFrame(tilt);
    const s = mats.shafts.uniforms;
    s.uFallA.value.set(...a);
    s.uFallB.value.set(...b);
    s.uFallC.value.set(...c);
  }, [mats, tilt]);

  useLayoutEffect(() => {
    const d = shaftDirection(tilt, shaftAzimuth(t, sweep), fall);
    const s = mats.shafts.uniforms;
    const f = mats.floor.uniforms;
    s.uFall.value.set(d[0] / -d[1], -1, d[2] / -d[1]);
    s.uBreathPhase.value = loopSeconds(t, CLERESTORY.breathPeriod) / CLERESTORY.breathPeriod;
    s.uDustShift.value = fallShift(t, DUST_NOISE);
    s.uWispShift.value = fallShift(t, WISP_NOISE);
    s.uDensity.value = params.haze / HAZE_DEFAULT;
    s.uDust.value = params.dust * DUST_GAIN;
    f.uSun.value.set(-d[0], -d[1], -d[2]);
    f.uSoft.value = params.poolSoftness;
    for (let i = 0; i < shafts.length; i++) f.uSlots.value[i].w = shaftBreath(shafts[i], t);
  });

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry.floor} material={mats.floor} position={FLOOR_POSITION} />
      <instancedMesh
        ref={slotsRef}
        args={[undefined, undefined, MAX]}
        geometry={geometry.slot}
        material={mats.slots}
        frustumCulled={false}
      />
      <instancedMesh
        ref={shaftsRef}
        args={[undefined, undefined, MAX]}
        geometry={geometry.box}
        material={mats.shafts}
        frustumCulled={false}
      />
    </group>
  );
}
