import { useMemo } from "react";
import { Color } from "three";
import { useTimeline } from "../../../engine/timeline";
import { ABSTRACT_EMISSIVE, ringPlacements } from "./staging";
import type { Scene3dLookProps } from "./types";

/** Drift slabs: large matte panes hovering in the backdrop band, tilting and bobbing on seeded phases. Lit (`lit: true`): standard materials take the scene's v9 lighting; an emissive floor keeps them visible on unlit scenes. No shadow casting (backdrop discipline, and shadow maps stay scene-owned). */

const SEED = 0x51ab5;

export function DriftSlabs({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const count = Math.round(params.count);
  const placements = useMemo(
    () =>
      ringPlacements(SEED, count, {
        distance: params.depth,
        thickness: params.spread,
        yMin: -1.5,
        yMax: 4,
      }),
    [count, params.spread, params.depth],
  );
  // Memoised: localMs re-renders every frame, so colour objects must not churn.
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

  // Pace baked so speed 1 is the tuned house default.
  const t = (localMs / 1000) * speed * 2;
  return (
    <group userData={{ kookaburraBg3d: true }}>
      {placements.map((p, i) => {
        const accented = i % 3 === 2;
        const bob = 0.18 * Math.sin(t * 0.35 * params.drift + p.phase);
        const tilt = 0.25 * Math.sin(t * 0.12 * params.drift + p.phase * 1.7);
        return (
          <mesh
            key={`${p.phase}-${p.position[0]}`}
            position={[p.position[0], p.position[1] + bob, p.position[2]]}
            rotation={[tilt * 0.4, p.phase, tilt]}
            scale={p.scale * params.size}
          >
            <boxGeometry args={[4.4, 2.8, 0.16]} />
            <meshStandardMaterial
              color={accented ? palette.accent : palette.shape}
              emissive={accented ? palette.accentEmissive : palette.shapeEmissive}
              roughness={0.65}
              metalness={0.05}
            />
          </mesh>
        );
      })}
    </group>
  );
}
