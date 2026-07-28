import { useMemo } from "react";
import { Color } from "three";
import { useTimeline } from "../../../engine/timeline";
import { ABSTRACT_EMISSIVE, ringPlacements } from "./staging";
import type { Scene3dLookProps } from "./types";

/** Orb field: soft matte spheres at varied depths, bobbing on seeded phases. Lit: standard materials take the scene's v9 lighting (speculars sell the roundness); the emissive floor keeps them visible on unlit scenes. */

const SEED = 0x0bf1e;

export function OrbField({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const count = Math.round(params.count);
  const placements = useMemo(
    () =>
      ringPlacements(SEED, count, {
        distance: params.depth,
        thickness: params.spread,
        yMin: -1.2,
        yMax: 4.5,
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

  // Pace baked so speed 1 is the tuned house default.
  const t = (localMs / 1000) * speed * 2;
  return (
    <group userData={{ kookaburraBg3d: true }}>
      {placements.map((p, i) => {
        const accented = i % 4 === 3;
        const bob = 0.25 * Math.sin(t * 0.3 * params.drift + p.phase);
        const sway = 0.15 * Math.sin(t * 0.18 * params.drift + p.phase * 2.1);
        return (
          <mesh
            key={`${p.phase}-${p.position[0]}`}
            position={[p.position[0] + sway, p.position[1] + bob, p.position[2]]}
            scale={p.scale * params.size}
          >
            <sphereGeometry args={[1.6, 48, 32]} />
            <meshStandardMaterial
              color={accented ? palette.accent : palette.shape}
              emissive={accented ? palette.accentEmissive : palette.shapeEmissive}
              roughness={0.45}
              metalness={0.08}
            />
          </mesh>
        );
      })}
    </group>
  );
}
