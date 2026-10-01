import { useLayoutEffect, useMemo } from "react";
import { type Color, type IUniform, type ShaderMaterial, Vector3 } from "three";
import { lookColorUniform, loopSeconds, useLookMaterials, useLookTime } from "../../kit";
import { type GoboSunPath, writeGoboSun } from "../../kit/gobo";
import type { Scene3dLookProps } from "../../types";
import { FLOOR_FRAGMENT, IRIS_FLOOR_Y, IRIS_HEIGHT, IRIS_SUN, SCREEN_FRAGMENT } from "./iris";

const ROOT_DATA = { kookaburraBg3d: true };
const SCREEN_POSITION: [number, number, number] = [0, IRIS_FLOOR_Y + IRIS_HEIGHT / 2, 0];
const FLOOR_POSITION: [number, number, number] = [0, IRIS_FLOOR_Y, 0];
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const DARK_LUMINANCE = 0.2;
// The sketch's floor pools peaked at 0.7 with the default 0.6 slider.
const POOL_GAIN = 0.7 / 0.6;

function uniforms(): Record<string, IUniform> {
  return {
    uScreen: lookColorUniform("#1c2524"),
    uGlow: lookColorUniform("#8a6c3c"),
    uPool: lookColorUniform("#62533a"),
    uBacking: lookColorUniform("#0b1110"),
    uDark: { value: 1 },
    uPhase: { value: 0 },
    uSun: { value: new Vector3(0, 0.37, -0.93) },
    uRadius: { value: 15 },
    uCols: { value: 40 },
    uPanel: { value: 1 },
    uCalm: { value: 0 },
  };
}

/** Iris screen: a drum of lens-iris panels round the stage, backlit by a low virtual sun whose light falls through the apertures as analytic gobo pools on the floor. Unlit; the irises ripple round the drum and the sun sways, both on the absolute look clock. */
export function IrisScreen({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const mats = useLookMaterials(
    () => ({
      screen: {
        key: "iris-screen/screen",
        fragmentShader: SCREEN_FRAGMENT,
        uniforms: uniforms(),
        cutaway: true,
      },
      floor: {
        key: "iris-screen/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { ...uniforms(), uPools: { value: 0.7 }, uClear: { value: 6 } },
      },
    }),
    [],
  );
  const both = useMemo<ShaderMaterial[]>(() => [mats.screen, mats.floor], [mats]);
  const sun = useMemo<GoboSunPath>(
    () => ({ ...IRIS_SUN, elevationDeg: params.sunElevation }),
    [params.sunElevation],
  );
  const cols = Math.round(params.panels);
  const radius = params.radius;
  const drumScale = useMemo<[number, number, number]>(() => [radius, 1, radius], [radius]);

  useLayoutEffect(() => {
    for (const m of both) {
      const u = m.uniforms;
      u.uScreen.value.set(colors[0]);
      u.uGlow.value.set(colors[1]);
      u.uPool.value.set(colors[2]);
      const screen = u.uScreen.value as Color;
      const dark = 0.2126 * screen.r + 0.7152 * screen.g + 0.0722 * screen.b < DARK_LUMINANCE;
      u.uDark.value = dark ? 1 : 0;
      u.uBacking.value.set(backing);
    }
  }, [both, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const phase = loopSeconds(t, params.cycle) / params.cycle;
    for (const m of both) {
      const u = m.uniforms;
      u.uPhase.value = phase;
      writeGoboSun(u.uSun.value, sun, t);
      u.uRadius.value = radius;
      u.uCols.value = cols;
      u.uPanel.value = (2 * Math.PI * radius) / cols;
      u.uCalm.value = params.textCalm;
    }
    mats.floor.uniforms.uPools.value = params.pool * POOL_GAIN;
    mats.floor.uniforms.uClear.value = params.clearRadius;
  }, [
    both,
    mats,
    t,
    sun,
    radius,
    cols,
    params.cycle,
    params.textCalm,
    params.pool,
    params.clearRadius,
  ]);

  return (
    <group userData={ROOT_DATA}>
      <mesh material={mats.screen} position={SCREEN_POSITION} scale={drumScale}>
        <cylinderGeometry args={[1, 1, IRIS_HEIGHT, 192, 1, true]} />
      </mesh>
      <mesh
        material={mats.floor}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        scale={radius + 0.5}
      >
        <planeGeometry args={[2, 2]} />
      </mesh>
    </group>
  );
}
