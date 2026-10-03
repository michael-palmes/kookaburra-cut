import { useLayoutEffect } from "react";
import type { IUniform } from "three";
import { lookColorUniform, lookLuminance, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { TERRAZZO, terrazzoFade, terrazzoPhases, terrazzoRays } from "./inlay";
import { TERRAZZO_FRAGMENT, TERRAZZO_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const CEILING_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, TERRAZZO.floorY, 0];
const CEILING_POSITION: [number, number, number] = [0, TERRAZZO.ceilingY, 0];
const DARK_LUMINANCE = 0.2;
// The sketch's glint amplitude (0.75) and chip mix (0.4) at the default sliders.
const GLINT_GAIN = 0.75 / 0.6;
const CHIP_GAIN = 0.4 / 0.5;

function inlayUniforms(spin: number, ceiling: number): Record<string, IUniform> {
  return {
    uA: lookColorUniform("#26344a"),
    uB: lookColorUniform("#2e2a3c"),
    uBrass: lookColorUniform("#6a5a36"),
    uBacking: lookColorUniform("#0b0f16"),
    uSpin: { value: spin },
    uTurn: { value: 0 },
    uRays: { value: 28 },
    uClear: { value: 5 },
    uGlintRun: { value: 0 },
    uArc: { value: 0 },
    uGlint: { value: 0.75 },
    uChips: { value: 0.4 },
    uFadeStart: { value: 28 },
    uFadeEnd: { value: 45 },
    uDark: { value: 1 },
    uCeiling: { value: ceiling },
    uStrength: { value: 1 },
  };
}

/** Sunburst terrazzo: an inlaid deco floor medallion (two-tone wedge rays, stepped brass rings, a chevron border, terrazzo chips) with brass glints running outward, plus an optional counter-turning ceiling medallion so the default front view frames the headline. One polar shader, unlit; the ceiling faces down, culls once the camera rises above it and fades near the camera. */
export function SunburstTerrazzo({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const mats = useLookMaterials(() => {
    const base = { vertexShader: TERRAZZO_VERTEX, fragmentShader: TERRAZZO_FRAGMENT };
    return {
      floor: { ...base, key: "sunburst-terrazzo/inlay", uniforms: inlayUniforms(1, 0) },
      ceiling: { ...base, key: "sunburst-terrazzo/inlay", uniforms: inlayUniforms(-1, 1) },
    };
  }, []);

  useLayoutEffect(() => {
    for (const m of [mats.floor, mats.ceiling]) {
      const u = m.uniforms;
      u.uA.value.set(colors[0]);
      u.uB.value.set(colors[1]);
      u.uBrass.value.set(colors[2]);
      u.uBacking.value.set(backing);
      u.uDark.value = lookLuminance(backing) < DARK_LUMINANCE ? 1 : 0;
    }
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const phases = terrazzoPhases(t, params.turnMinutes);
    const fade = terrazzoFade(params.fadeRadius);
    for (const m of [mats.floor, mats.ceiling]) {
      const u = m.uniforms;
      u.uTurn.value = phases.turn;
      u.uGlintRun.value = phases.glint;
      u.uArc.value = phases.arc;
      u.uRays.value = terrazzoRays(params.rays);
      u.uClear.value = params.clearRadius;
      u.uGlint.value = params.glint * GLINT_GAIN;
      u.uChips.value = params.chips * CHIP_GAIN;
      u.uFadeStart.value = fade.start;
      u.uFadeEnd.value = fade.end;
    }
    mats.ceiling.uniforms.uStrength.value = params.ceiling;
  });

  const disc = params.fadeRadius + 1;
  return (
    <group userData={ROOT_DATA}>
      <mesh
        material={mats.floor}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        scale={disc}
        frustumCulled={false}
      >
        <circleGeometry args={[1, 128]} />
      </mesh>
      <mesh
        material={mats.ceiling}
        position={CEILING_POSITION}
        rotation={CEILING_ROTATION}
        scale={disc}
        frustumCulled={false}
        visible={params.ceiling > 0}
      >
        <circleGeometry args={[1, 128]} />
      </mesh>
    </group>
  );
}
