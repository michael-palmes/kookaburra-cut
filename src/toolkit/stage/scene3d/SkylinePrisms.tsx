import { useMemo } from "react";
import { Color } from "three";
import { createSeededRandom } from "../../../engine/rng";
import { useTimeline } from "../../../engine/timeline";
import { ABSTRACT_EMISSIVE } from "./staging";
import type { Scene3dLookProps } from "./types";

/** Skyline prisms: a ring of vertical prisms encircling the stage like a distant skyline, swaying imperceptibly. Lit: standard materials take the scene's v9 lighting; the emissive floor keeps them visible on unlit scenes. Placement is a seeded even ring so no orbit angle faces a gap. */

const SEED = 0x5c11e;
const FLOOR_Y = -2;

export function SkylinePrisms({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const count = Math.round(params.count);
  const prisms = useMemo(() => {
    const rng = createSeededRandom(SEED);
    // A full ring skyline: even azimuthal spacing with jitter, alternating lanes for depth, so no orbit angle faces a gap.
    // Ring plus a half-count back-arc lane so the main backdrop reads full.
    const backCount = Math.round(count * 0.5);
    return Array.from({ length: count + backCount }, (_, k) => {
      const inBack = k >= count;
      const lane = k % 2;
      const angle = inBack
        ? Math.PI * (1.15 + ((k - count + 0.5) / backCount) * 0.7) + (rng() - 0.5) * 0.2
        : ((k + 0.5) / count) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / count);
      const r = params.depth + lane * 3.5 + rng() * 2 + (inBack ? 3 : 0);
      return {
        x: r * Math.cos(angle),
        z: r * Math.sin(angle),
        width: 1.2 + rng() * 1.4,
        height: 3 + rng() * (params.tallest - 3),
        phase: rng() * Math.PI * 2,
      };
    });
  }, [count, params.depth, params.tallest]);
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
      {prisms.map((p, i) => {
        const accented = i % 5 === 2;
        const sway = 0.012 * Math.sin(t * 0.25 * params.drift + p.phase);
        return (
          <mesh
            key={`${p.phase}-${p.x}`}
            position={[p.x, FLOOR_Y + p.height / 2, p.z]}
            rotation={[0, p.phase * 0.2, sway]}
          >
            <boxGeometry args={[p.width, p.height, p.width]} />
            <meshStandardMaterial
              color={accented ? palette.accent : palette.shape}
              emissive={accented ? palette.accentEmissive : palette.shapeEmissive}
              roughness={0.7}
              metalness={0.05}
            />
          </mesh>
        );
      })}
    </group>
  );
}
