import { useLayoutEffect, useMemo } from "react";
import { type IUniform, Vector4 } from "three";
import { lookColorUniform, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { GUILLOCHE, guillocheCounts, guillochePhases } from "./dial";
import { GUILLOCHE_FRAGMENT, GUILLOCHE_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const CEILING_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, GUILLOCHE.floorY, 0];

function dialUniforms(spin: number, ceiling: number): Record<string, IUniform> {
  return {
    uA: lookColorUniform("#66593c"),
    uB: lookColorUniform("#4a5b47"),
    uG: lookColorUniform("#1a1812"),
    uBacking: lookColorUniform("#110f0b"),
    uSpin: { value: spin },
    uTurn: { value: 0 },
    uWeaveA: { value: 0 },
    uWeaveB: { value: 0 },
    uSheenAngle: { value: 0 },
    uScale: { value: 1 },
    uHW: { value: 0.035 },
    uCounts: { value: new Vector4(8, 5, 7, 2) },
    uSheen: { value: 1 },
    uUnder: { value: 0.6 },
    uCeiling: { value: ceiling },
  };
}

/** Guilloche medallion: a rose-engine dial engraved on the floor and a mirrored dial on a ceiling turning the other way, so hairline strands fill the top and bottom of the frame round an open horizon. One polar SDF shader, unlit; the ceiling faces down and culls away once the camera rises above it, and fades near the camera on a dolly out. */
export function GuillocheMedallion({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const mats = useLookMaterials(() => {
    const base = { vertexShader: GUILLOCHE_VERTEX, fragmentShader: GUILLOCHE_FRAGMENT };
    return {
      floor: { ...base, key: "guilloche-medallion/dial", uniforms: dialUniforms(1, 0) },
      ceiling: { ...base, key: "guilloche-medallion/dial", uniforms: dialUniforms(-1, 1) },
    };
  }, []);

  useLayoutEffect(() => {
    for (const m of [mats.floor, mats.ceiling]) {
      const u = m.uniforms;
      u.uA.value.set(colors[0]);
      u.uB.value.set(colors[1]);
      u.uG.value.set(colors[2]);
      u.uBacking.value.set(backing);
    }
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const counts = guillocheCounts(params.strands);
    const phases = guillochePhases(t, params.weave);
    const scale = GUILLOCHE.baseRadius / params.outerRadius;
    for (const m of [mats.floor, mats.ceiling]) {
      const u = m.uniforms;
      u.uTurn.value = phases.turn;
      u.uWeaveA.value = phases.weaveA;
      u.uWeaveB.value = phases.weaveB;
      u.uSheenAngle.value = phases.sheen;
      u.uScale.value = scale;
      u.uHW.value = (params.lineWidth / 2) * scale;
      u.uCounts.value.set(counts.lace, counts.braid, counts.rosette, counts.border);
      u.uSheen.value = params.sheen;
      u.uUnder.value = params.underprint;
    }
  });

  const disc = (GUILLOCHE.discRadius / GUILLOCHE.baseRadius) * params.outerRadius;
  const ceilingY = params.ceilingHeight;
  const ceilingPosition = useMemo<[number, number, number]>(() => [0, ceilingY, 0], [ceilingY]);
  return (
    <group userData={ROOT_DATA}>
      <mesh
        material={mats.floor}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        scale={disc}
        frustumCulled={false}
      >
        <circleGeometry args={[1, 192]} />
      </mesh>
      <mesh
        material={mats.ceiling}
        position={ceilingPosition}
        rotation={CEILING_ROTATION}
        scale={disc}
        frustumCulled={false}
      >
        <circleGeometry args={[1, 192]} />
      </mesh>
    </group>
  );
}
