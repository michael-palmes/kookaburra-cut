import { useLayoutEffect, useMemo } from "react";
import { Color, type IUniform, Vector3 } from "three";
import { useFormat } from "../../../../../engine/format";
import {
  lookColorUniform,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { FLOOR_FRAGMENT, FLOOR_VERTEX, SKY_FRAGMENT } from "./shaders";
import { polarGridGeometry, TIDE, tideBands } from "./tide";

const TAU = Math.PI * 2;

/** Seigaiha tide: ukiyo-e wave fans printed on a swelling floor under a banded bokashi sky dome (F7). Both parts share one set of palette uniforms. */
export function SeigaihaTide({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const { aspect } = useFormat();
  const sky = useSkyDomeGeometry(TIDE.skyRadius);
  const floor = useMemo(
    () => polarGridGeometry(TIDE.floorRadius, TIDE.floorRings, TIDE.floorSegments, TIDE.floorPower),
    [],
  );
  useLayoutEffect(() => () => floor.dispose(), [floor]);

  const mats = useLookMaterials(() => {
    const palette: Record<string, IUniform> = {
      uPrussian: lookColorUniform("#000000"),
      uWave: lookColorUniform("#000000"),
      uSea: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
    };
    return {
      sky: skyDomeMaterial({
        key: "seigaiha-tide/sky",
        fragmentShader: SKY_FRAGMENT,
        uniforms: {
          ...palette,
          uDawn: lookColorUniform("#000000"),
          uBands: { value: new Vector3(11, 16.5, 23) },
          uDrift: { value: 0 },
        },
      }),
      floor: {
        key: "seigaiha-tide/floor",
        vertexShader: FLOOR_VERTEX,
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: {
          ...palette,
          uFoam: lookColorUniform("#000000"),
          uTime: { value: 0 },
          uSwell: { value: 0.45 },
          uClear: { value: 3 },
          uFans: { value: 10 },
          uRings: { value: 4 },
          uRipple: { value: 0.34 },
          uOrbit: { value: 0.16 },
          uMist: { value: 7.5 },
        },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const [prussian, wave, dawn, foam] = colors;
    const u = mats.floor.uniforms;
    u.uPrussian.value.set(prussian);
    u.uWave.value.set(wave);
    u.uFoam.value.set(foam);
    u.uBacking.value.set(backing);
    (u.uSea.value as Color).set(wave).lerp(new Color(prussian), 0.35).lerp(new Color(foam), 0.22);
    mats.sky.uniforms.uDawn.value.set(dawn);
  }, [mats, colors[0], colors[1], colors[2], colors[3], backing]);

  useLayoutEffect(() => {
    const u = mats.floor.uniforms;
    u.uTime.value = loopSeconds(t * params.swellSpeed, TIDE.loop);
    u.uSwell.value = params.swell;
    u.uClear.value = params.clearRadius;
    u.uFans.value = Math.round(params.fans);
    u.uRings.value = Math.round(params.rings);
    u.uRipple.value = params.ripple;
    u.uOrbit.value = TIDE.orbit * params.swell;
    u.uMist.value = params.mist;
    const s = mats.sky.uniforms;
    s.uBands.value.set(...tideBands(aspect));
    s.uDrift.value =
      TIDE.drift * Math.sin((TAU * loopSeconds(t, TIDE.driftPeriod)) / TIDE.driftPeriod);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={sky} material={mats.sky} />
      <mesh geometry={floor} material={mats.floor} position-y={TIDE.floorY} frustumCulled={false} />
    </group>
  );
}
