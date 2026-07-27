import { useMemo } from "react";
import { Color } from "three";
import { useTimeline } from "../../../engine/timeline";
import { ABSTRACT_EMISSIVE, seededPlacements } from "./staging";
import type { Scene3dLookProps } from "./types";

/** Halo rings: large tilted tori turning very slowly behind the stage. Lit: standard materials take the scene's v9 lighting; the emissive floor keeps them visible on unlit scenes. */

const SEED = 0x4a105;

export function HaloRings({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const count = Math.round(params.count);
  const { placements } = useMemo(
    () =>
      seededPlacements(SEED, count, {
        spread: params.spread,
        depthMid: -params.depth,
        depthRange: 4,
        yMin: -0.5,
        yMax: 4,
      }),
    [count, params.spread, params.depth],
  );
  const palette = useMemo(() => {
    const shape = new Color(colors[0] ?? "#3b5c7d");
    const accent = new Color(colors[1] ?? "#48628c");
    return {
      shape,
      accent,
      shapeEmissive: shape.clone().multiplyScalar(ABSTRACT_EMISSIVE),
      accentEmissive: accent.clone().multiplyScalar(ABSTRACT_EMISSIVE),
    };
  }, [colors[0], colors[1]]);

  const t = (localMs / 1000) * speed;
  return (
    <group userData={{ kookaburraBg3d: true }}>
      {placements.map((p, i) => {
        const accented = i % 2 === 1;
        const turn = t * 0.06 * params.drift + p.phase;
        return (
          <mesh
            key={`${i}-${p.phase.toFixed(4)}`}
            position={p.position}
            rotation={[p.phase * 0.5 + 0.4, turn, p.phase * 0.3]}
            scale={p.scale * params.size}
          >
            <torusGeometry args={[4.6, params.tube, 24, 96]} />
            <meshStandardMaterial
              color={accented ? palette.accent : palette.shape}
              emissive={accented ? palette.accentEmissive : palette.shapeEmissive}
              roughness={0.5}
              metalness={0.15}
            />
          </mesh>
        );
      })}
    </group>
  );
}
