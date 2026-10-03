import { useLayoutEffect, useMemo } from "react";
import { DoubleSide, type IUniform, Vector3 } from "three";
import {
  lookColorUniform,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { createMezzoLandGeometry, createMezzoMistGeometry, MEZZO_LAND } from "./land";
import { LAND_FRAGMENT, LAND_VERTEX, MIST_FRAGMENT, MIST_VERTEX, SKY_FRAGMENT } from "./shaders";
import {
  type MezzoGlow,
  mezzotintCells,
  mezzotintCoverShift,
  mezzotintGlow,
  mezzotintKey,
} from "./tone";

const glow: MezzoGlow = { azimuth: 0, breathe: 1, direction: [0, 0, -1] };

/** Mezzotint sky: a dusk mezzotint, Burnish on rocked Ground around a key read from the backing. A BackSide dome (F7) holds the sky, its cloud field turning about the zenith once per Drift period; rocked land ridges and mist strata lie at real depth out to the dome's horizon, so a camera move travels over them. The burr is a world-fixed F4 screen that never animates. */
export function MezzotintSky({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const dome = useSkyDomeGeometry(MEZZO_LAND.domeRadius);
  const land = useMemo(createMezzoLandGeometry, []);
  const mist = useMemo(createMezzoMistGeometry, []);
  useLayoutEffect(
    () => () => {
      land.dispose();
      mist.dispose();
    },
    [land, mist],
  );
  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uGround: lookColorUniform("#000000"),
      uBurnish: lookColorUniform("#000000"),
      uTime: { value: 0 },
      uPeriod: { value: 240 },
      uKey: { value: 0.3 },
      uCap: { value: 0.82 },
      uCells: { value: mezzotintCells(4) },
      uGlow: { value: 1 },
      uRelief: { value: 1 },
      uSunAz: { value: 0 },
      uBreathe: { value: 1 },
    };
    // Land first: opaque parts draw in material order, so the dome only shades the sky it shows.
    return {
      land: {
        key: "mezzotint-sky/land",
        vertexShader: LAND_VERTEX,
        fragmentShader: LAND_FRAGMENT,
        uniforms: { ...shared, uSun: { value: new Vector3(0, 0, -1) } },
      },
      sky: skyDomeMaterial({
        key: "mezzotint-sky/dome",
        fragmentShader: SKY_FRAGMENT,
        uniforms: { ...shared, uCoverShift: { value: 0 } },
      }),
      mist: {
        key: "mezzotint-sky/mist",
        vertexShader: MIST_VERTEX,
        fragmentShader: MIST_FRAGMENT,
        transparent: true,
        side: DoubleSide,
        uniforms: { ...shared, uMist: { value: 0.5 } },
      },
    };
  }, []);

  const key = useMemo(
    () => mezzotintKey(colors[0], colors[1], backing),
    [colors[0], colors[1], backing],
  );
  useLayoutEffect(() => {
    const u = mats.sky.uniforms;
    u.uGround.value.set(colors[0]);
    u.uBurnish.value.set(colors[1]);
    u.uKey.value = key;
  }, [mats, colors[0], colors[1], key]);

  useLayoutEffect(() => {
    const u = mats.sky.uniforms;
    mezzotintGlow(t, params.drift, glow);
    u.uPeriod.value = params.drift;
    u.uTime.value = loopSeconds(t, params.drift);
    u.uCap.value = params.cap;
    u.uCells.value = mezzotintCells(params.grain);
    u.uCoverShift.value = mezzotintCoverShift(params.cloud);
    u.uGlow.value = params.glow / 0.7;
    u.uRelief.value = params.relief;
    u.uSunAz.value = glow.azimuth;
    u.uBreathe.value = glow.breathe;
    mats.land.uniforms.uSun.value.fromArray(glow.direction);
    mats.mist.uniforms.uMist.value = params.mist;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={dome} material={mats.sky} />
      <mesh geometry={land} material={mats.land} frustumCulled={false} />
      <mesh geometry={mist} material={mats.mist} frustumCulled={false} visible={params.mist > 0} />
    </group>
  );
}
