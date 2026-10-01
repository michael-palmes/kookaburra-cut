import { useLayoutEffect, useMemo } from "react";
import { type IUniform, Vector2, Vector4 } from "three";
import {
  getPaperGrainTexture,
  lookColorUniform,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  WASH_BLOOM_SLOTS,
  WASH_WIND,
  washCalmBand,
  washDry,
  washThreshold,
  washWind,
  writeWashBlooms,
} from "./motion";
import { DOME_FRAGMENT, FLOOR_FRAGMENT } from "./shaders";

const FLOOR_Y = -2;
const FLOOR_RADIUS = 66;

/** Wash dome: a watercolour sky dome (F7) over a paper floor (F8 grain) that takes painted cloud shadows from the same drifting wash, both painted on the scene's backing tone. Both parts share one set of uniform objects, so one update drives both. */
export function WashDome({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const domeGeometry = useSkyDomeGeometry();

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uWash: lookColorUniform("#000000"),
      uPool: lookColorUniform("#000000"),
      uBloom: lookColorUniform("#000000"),
      uPaper: lookColorUniform("#000000"),
      uPaperTex: { value: getPaperGrainTexture() },
      uDrift: { value: new Vector2() },
      uDry: { value: 0 },
      uCover: { value: washThreshold(0.35) },
      uEdge: { value: 0.8 },
      uGrain: { value: 0.4 },
      uStreak: { value: 0.35 },
      uCalm: { value: 0 },
    };
    return {
      dome: skyDomeMaterial({
        key: "wash-dome/dome",
        fragmentShader: DOME_FRAGMENT,
        uniforms: {
          ...shared,
          uStrokeDrift: { value: 0 },
          uCalmLo: { value: 0.1 },
          uCalmHi: { value: 0.17 },
          uBloomC: { value: Array.from({ length: WASH_BLOOM_SLOTS }, () => new Vector4()) },
          uBloomAmp: { value: new Array<number>(WASH_BLOOM_SLOTS).fill(0) },
        },
      }),
      floor: { key: "wash-dome/floor", fragmentShader: FLOOR_FRAGMENT, uniforms: shared },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.dome.uniforms;
    u.uWash.value.set(colors[0]);
    u.uPool.value.set(colors[1]);
    u.uBloom.value.set(colors[2]);
    u.uPaper.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  const calmBand = useMemo(() => washCalmBand(params.calmHeight), [params.calmHeight]);

  useLayoutEffect(() => {
    const u = mats.dome.uniforms;
    const wind = washWind(t, params.wind);
    u.uDrift.value.set(wind * WASH_WIND.x, wind * WASH_WIND.y);
    u.uStrokeDrift.value = wind * WASH_WIND.stroke;
    u.uDry.value = washDry(t);
    u.uCover.value = washThreshold(params.coverage);
    u.uCalmLo.value = calmBand[0];
    u.uCalmHi.value = calmBand[1];
    u.uEdge.value = params.edge;
    u.uGrain.value = params.granulation;
    u.uStreak.value = params.streak;
    u.uCalm.value = params.textCalm;
    writeWashBlooms(t, Math.round(params.blooms), u.uBloomC.value, u.uBloomAmp.value);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={domeGeometry} material={mats.dome} />
      <mesh material={mats.floor} position-y={FLOOR_Y} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[FLOOR_RADIUS, 96]} />
      </mesh>
    </group>
  );
}
