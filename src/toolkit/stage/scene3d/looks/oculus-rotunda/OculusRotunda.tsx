import { useLayoutEffect, useMemo } from "react";
import { DoubleSide, type IUniform, type ShaderMaterial, Vector3 } from "three";
import {
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  cappedMaxElevation,
  DRUM_TOP,
  drumBays,
  OCULUS_RADIUS,
  oculusHeight,
  ROTUNDA_FLOOR_Y,
  rotundaSunAzimuth,
  rotundaSunElevation,
  writeRotundaBeam,
} from "./rotunda";
import { DOME_FRAGMENT, DRUM_FRAGMENT, FLOOR_FRAGMENT, OCULUS_FRAGMENT } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const DRUM_HEIGHT = DRUM_TOP - ROTUNDA_FLOOR_Y;
const DRUM_POSITION: [number, number, number] = [0, ROTUNDA_FLOOR_Y + DRUM_HEIGHT / 2, 0];
const DOME_POSITION: [number, number, number] = [0, DRUM_TOP, 0];
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const OCULUS_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const DRUM_ARGS: [number, number, number, number, number, boolean] = [
  1,
  1,
  DRUM_HEIGHT,
  140,
  1,
  true,
];
const OCULUS_ARGS: [number, number] = [OCULUS_RADIUS + 0.2, 48];
const FLOOR_ARGS: [number, number] = [2, 2];
const DARK_LUMINANCE = 0.2;
/** Stud breathing periods (6, 8 and 10 s) all close on this loop. */
const STUD_LOOP = 120;

function shared(): Record<string, IUniform> {
  return {
    uStone: lookColorUniform("#4e535c"),
    uShade: lookColorUniform("#14181e"),
    uSun: lookColorUniform("#8a7048"),
    uBacking: lookColorUniform("#07090c"),
    uDark: { value: 1 },
    uBeam: { value: new Vector3(0, -0.8, -0.6) },
    uRadius: { value: 22 },
    uOculusY: { value: 42 },
    uDisc: { value: 3 },
  };
}

/** Oculus rotunda: a pilastered drum under a coffered dome that diminishes to an open oculus, whose soft sun disc swings across the back of the drum like a sundial. Unlit BackSide shells (a cutaway bowl from outside), shaded toward the disc. */
export function OculusRotunda({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const mats = useLookMaterials(
    () => ({
      drum: {
        key: "oculus-rotunda/drum",
        fragmentShader: DRUM_FRAGMENT,
        uniforms: { ...shared(), uBays: { value: 28 } },
        cutaway: true,
      },
      dome: {
        key: "oculus-rotunda/dome",
        fragmentShader: DOME_FRAGMENT,
        uniforms: {
          ...shared(),
          uCoffers: { value: 28 },
          uStuds: { value: 0 },
          uTime: { value: 0 },
        },
        cutaway: true,
      },
      floor: { key: "oculus-rotunda/floor", fragmentShader: FLOOR_FRAGMENT, uniforms: shared() },
      oculus: {
        key: "oculus-rotunda/oculus",
        fragmentShader: OCULUS_FRAGMENT,
        uniforms: {
          uSun: lookColorUniform("#8a7048"),
          uBacking: lookColorUniform("#07090c"),
          uOpen: { value: OCULUS_RADIUS },
        },
        side: DoubleSide,
      },
    }),
    [],
  );
  const shells = useMemo<ShaderMaterial[]>(() => [mats.drum, mats.dome, mats.floor], [mats]);

  const radius = params.radius;
  const hole = Math.asin(OCULUS_RADIUS / radius);
  const drumScale = useMemo<[number, number, number]>(() => [radius, 1, radius], [radius]);
  const domeArgs = useMemo<[number, number, number, number, number, number, number]>(
    () => [radius, 112, 40, 0, Math.PI * 2, hole, Math.PI / 2 - hole],
    [radius, hole],
  );
  const oculusPosition = useMemo<[number, number, number]>(
    () => [0, DRUM_TOP + Math.cos(hole) * radius + 0.3, 0],
    [hole, radius],
  );
  const maxElevation = cappedMaxElevation(radius, params.discSize, params.maxElevation);

  useLayoutEffect(() => {
    for (const m of shells) {
      const u = m.uniforms;
      u.uStone.value.set(colors[0]);
      u.uShade.value.set(colors[1]);
      u.uSun.value.set(colors[2]);
      u.uBacking.value.set(backing);
      u.uDark.value = lookLuminance(colors[0]) < DARK_LUMINANCE ? 1 : 0;
    }
    mats.oculus.uniforms.uSun.value.set(colors[2]);
    mats.oculus.uniforms.uBacking.value.set(backing);
  }, [shells, mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const traverse = Math.max(params.traverse, 1);
    const lt = loopSeconds(t, 2 * traverse);
    const azimuth = rotundaSunAzimuth(lt, traverse);
    const elevation = rotundaSunElevation(lt, traverse, maxElevation);
    for (const m of shells) {
      const u = m.uniforms;
      writeRotundaBeam(u.uBeam.value, azimuth, elevation);
      u.uRadius.value = radius;
      u.uOculusY.value = oculusHeight(radius);
      u.uDisc.value = params.discSize;
    }
    mats.drum.uniforms.uBays.value = drumBays(radius);
    const dome = mats.dome.uniforms;
    dome.uCoffers.value = Math.round(params.coffers);
    dome.uStuds.value = params.studs;
    dome.uTime.value = loopSeconds(t, STUD_LOOP);
  }, [
    shells,
    mats,
    t,
    radius,
    maxElevation,
    params.traverse,
    params.discSize,
    params.coffers,
    params.studs,
  ]);

  return (
    <group userData={ROOT_DATA}>
      <mesh material={mats.drum} position={DRUM_POSITION} scale={drumScale}>
        <cylinderGeometry args={DRUM_ARGS} />
      </mesh>
      <mesh material={mats.dome} position={DOME_POSITION}>
        <sphereGeometry args={domeArgs} />
      </mesh>
      <mesh material={mats.oculus} position={oculusPosition} rotation={OCULUS_ROTATION}>
        <circleGeometry args={OCULUS_ARGS} />
      </mesh>
      <mesh
        material={mats.floor}
        position-y={ROTUNDA_FLOOR_Y}
        rotation={FLOOR_ROTATION}
        scale={radius + 0.5}
      >
        <planeGeometry args={FLOOR_ARGS} />
      </mesh>
    </group>
  );
}
