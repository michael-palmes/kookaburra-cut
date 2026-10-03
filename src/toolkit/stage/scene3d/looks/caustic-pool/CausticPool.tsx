import { useLayoutEffect } from "react";
import { Vector2 } from "three";
import { lookColorUniform, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { CAUSTIC_TURNS, causticPhase, causticTurns, POOL } from "./pool";
import { FLOOR_FRAGMENT, POOL_VERTEX, SURFACE_FRAGMENT } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const SURFACE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, POOL.floorY, 0];
const SURFACE_POSITION: [number, number, number] = [0, POOL.surfaceY, 0];
const turnTable = () => CAUSTIC_TURNS.map(() => new Vector2(1, 0));
// The sketch's grout mix (0.3) at the default Grout slider (0.35).
const GROUT_GAIN = 0.3 / 0.35;

/** Caustic pool: a tiled pool floor under soft caustic nets (Hockney's pools, Dave_Hoskins' tileable caustic) and a faint rippled surface overhead that shows only from below. Two unlit planes on one exactly looping field; the nets mix toward the Caustic slot, never add light. */
export function CausticPool({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const mats = useLookMaterials(
    () => ({
      floor: {
        key: "caustic-pool/floor",
        vertexShader: POOL_VERTEX,
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: {
          uTile: lookColorUniform("#0d1c23"),
          uGrout: lookColorUniform("#18313a"),
          uCaustic: lookColorUniform("#336b61"),
          uBacking: lookColorUniform("#11252e"),
          uTurn: { value: turnTable() },
          uTileSize: { value: 1.5 },
          uGroutMix: { value: 0.3 },
          uScale: { value: 6 },
          uStrength: { value: 0.55 },
          uClear: { value: 6 },
        },
      },
      surface: {
        key: "caustic-pool/surface",
        vertexShader: POOL_VERTEX,
        fragmentShader: SURFACE_FRAGMENT,
        uniforms: {
          uCaustic: lookColorUniform("#336b61"),
          uBacking: lookColorUniform("#11252e"),
          uTurn: { value: turnTable() },
          uScale: { value: 6 },
          uSurface: { value: 1 },
        },
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const f = mats.floor.uniforms;
    f.uTile.value.set(colors[0]);
    f.uGrout.value.set(colors[1]);
    f.uCaustic.value.set(colors[2]);
    f.uBacking.value.set(backing);
    const s = mats.surface.uniforms;
    s.uCaustic.value.set(colors[2]);
    s.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const phase = causticPhase(t, params.loop);
    const f = mats.floor.uniforms;
    causticTurns(phase, f.uTurn.value);
    f.uTileSize.value = params.tile;
    f.uGroutMix.value = params.grout * GROUT_GAIN;
    f.uScale.value = params.scale;
    f.uStrength.value = params.strength;
    f.uClear.value = params.clearRadius;
    const s = mats.surface.uniforms;
    causticTurns(phase, s.uTurn.value);
    s.uScale.value = params.scale;
    s.uSurface.value = params.surface;
  });

  return (
    <group userData={ROOT_DATA}>
      <mesh
        material={mats.floor}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        scale={POOL.discRadius}
        frustumCulled={false}
      >
        <circleGeometry args={[1, 96]} />
      </mesh>
      <mesh
        material={mats.surface}
        position={SURFACE_POSITION}
        rotation={SURFACE_ROTATION}
        scale={POOL.discRadius}
        frustumCulled={false}
        visible={params.surface > 0}
      >
        <circleGeometry args={[1, 96]} />
      </mesh>
    </group>
  );
}
