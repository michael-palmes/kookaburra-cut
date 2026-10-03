import { useLayoutEffect, useMemo } from "react";
import { BufferGeometry, Vector2, Vector3 } from "three";
import { lookColorUniform, printPlateSlip, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { isDarkStock, polarGrid, RISO_GRID, risoClearingRings, risoPhases, risoSun } from "./model";
import { RISO_CLEARING_FRAGMENT, RISO_FRAGMENT, RISO_VERTEX } from "./shaders";

const FLOOR_Y = -2;
const RING_INDICES = RISO_GRID.segments * 6;

/** Riso dunes: a polar floor displaced by an analytic dune field, printed as two slipped riso plates screened against static world grain (F4). The near field carries both inks, the far swells a pale tint, so the text band stays quiet. The bare clearing draws with a paper-only material, one ring overlapping the dune draw. */
export function RisoDunes({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const [keyHex, tintHex, paperHex] = colors;
  const { dunes, clearing } = useMemo(() => {
    const { rings, segments, radius, power } = RISO_GRID;
    const dunes = polarGrid(rings, segments, radius, power);
    const clearing = new BufferGeometry();
    clearing.setAttribute("position", dunes.getAttribute("position"));
    clearing.setIndex(dunes.getIndex());
    return { dunes, clearing };
  }, []);
  useLayoutEffect(
    () => () => {
      dunes.dispose();
      clearing.dispose();
    },
    [dunes, clearing],
  );

  const mats = useLookMaterials(() => {
    const uniforms = {
      uPaper: lookColorUniform("#000000"),
      uSmallPhase: { value: 0 },
      uBigPhase: { value: 0 },
      uClear: { value: 8 },
      uReach: { value: 15 },
      uHeight: { value: 1.3 },
      uSpacing: { value: 17 },
    };
    return {
      floor: {
        key: "riso-dunes/floor",
        vertexShader: RISO_VERTEX,
        fragmentShader: RISO_FRAGMENT,
        uniforms: {
          ...uniforms,
          uBacking: lookColorUniform("#000000"),
          uKey: lookColorUniform("#000000"),
          uTint: lookColorUniform("#000000"),
          uDark: { value: 0 },
          uSun: { value: new Vector3(0, 1, 0) },
          uSlip: { value: new Vector2() },
          uRipPhase: { value: 0 },
          uGrain: { value: 0.5 },
        },
      },
      clearing: {
        key: "riso-dunes/clearing",
        vertexShader: RISO_VERTEX,
        fragmentShader: RISO_CLEARING_FRAGMENT,
        uniforms,
      },
    };
  }, []);

  const clearRings = risoClearingRings(params.clearRadius, params.misregister);
  useLayoutEffect(() => {
    clearing.setDrawRange(0, clearRings * RING_INDICES);
    dunes.setDrawRange(Math.max(0, clearRings - 1) * RING_INDICES, Number.POSITIVE_INFINITY);
  }, [dunes, clearing, clearRings]);

  const dark = useMemo(() => isDarkStock(keyHex, paperHex), [keyHex, paperHex]);
  useLayoutEffect(() => {
    const u = mats.floor.uniforms;
    u.uKey.value.set(keyHex);
    u.uTint.value.set(tintHex);
    u.uPaper.value.set(paperHex);
    u.uBacking.value.set(backing);
    u.uDark.value = dark ? 1 : 0;
  }, [mats, keyHex, tintHex, paperHex, backing, dark]);

  useLayoutEffect(() => {
    const u = mats.floor.uniforms;
    const phases = risoPhases(t, params.drift, params.duneSpacing);
    u.uClear.value = params.clearRadius;
    u.uReach.value = Math.max(params.inkReach, params.clearRadius + 6);
    u.uHeight.value = params.duneHeight;
    u.uSpacing.value = params.duneSpacing;
    u.uGrain.value = params.grain;
    u.uSlip.value.set(...printPlateSlip(params.misregister));
    u.uBigPhase.value = phases.big;
    u.uSmallPhase.value = phases.small;
    u.uRipPhase.value = phases.ripple;
    risoSun(t, params.sunSwing, dark, u.uSun.value);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh
        geometry={clearing}
        material={mats.clearing}
        position={[0, FLOOR_Y, 0]}
        frustumCulled={false}
        visible={clearRings > 0}
      />
      <mesh
        geometry={dunes}
        material={mats.floor}
        position={[0, FLOOR_Y, 0]}
        frustumCulled={false}
      />
    </group>
  );
}
