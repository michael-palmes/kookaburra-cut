import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Points } from "three";
import { createSeededRandom } from "../../../engine/rng";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Dust drift: sparse motes in a shell around the stage (keep-out sphere in the middle), twinkling on seeded phases, the whole field turning imperceptibly. Unlit exact colours; twinkle alphas recompute on the CPU during commit as a pure function of the timeline. */

const SEED = 0xd057;

export function DustDrift({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const pointsRef = useRef<Points>(null);

  const count = Math.round(params.count);
  const inner = params.innerRadius;
  const outer = params.outerRadius;
  const dustHex = colors[0] ?? "#33475b";
  const sparkleHex = colors[1] ?? "#765738";

  const { geometry, rgba, motes } = useMemo(() => {
    const rng = createSeededRandom(SEED);
    const motes: { phase: number; rate: number; fade: number; sparkle: boolean }[] = [];
    const positions = new BufferAttribute(new Float32Array(count * 3), 3);
    const rgba = new BufferAttribute(new Float32Array(count * 4), 4);
    const dust = new Color(dustHex);
    const sparkle = new Color(sparkleHex);
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 40) {
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = inner + (outer - inner) * Math.cbrt(rng());
      const y = r * u * 0.55;
      if (y < -2.4) continue;
      const horiz = r * Math.sqrt(1 - u * u * 0.3);
      const x = horiz * Math.cos(theta);
      const z = horiz * Math.sin(theta);
      positions.setXYZ(placed, x, y, z);
      const isSparkle = placed % 7 === 3;
      const c = isSparkle ? sparkle : dust;
      const fade = 1 - Math.min(Math.max((r - outer * 0.7) / (outer * 0.3), 0), 1);
      rgba.setXYZW(placed, c.r, c.g, c.b, fade);
      motes.push({ phase: rng() * Math.PI * 2, rate: 0.4 + rng() * 1.1, fade, sparkle: isSparkle });
      placed++;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", positions);
    geometry.setAttribute("color", rgba);
    geometry.setDrawRange(0, placed);
    return { geometry, rgba, motes };
  }, [count, inner, outer, dustHex, sparkleHex]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    // Pace baked so speed 1 is the tuned house default.
    const t = (localMs / 1000) * speed * 2;
    const twinkle = params.twinkle;
    const col = rgba.array as Float32Array;
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      const flicker =
        1 - twinkle * (0.5 + 0.5 * Math.sin(t * m.rate + m.phase)) * (m.sparkle ? 0.9 : 0.55);
      col[i * 4 + 3] = m.fade * flicker;
    }
    rgba.needsUpdate = true;
  }, [localMs, speed, rgba, motes, params.twinkle]);

  const spin = ((localMs / 1000) * speed * 2 * 0.012 * params.drift) % (Math.PI * 2);
  return (
    <group rotation={[0, spin, 0]} userData={{ kookaburraBg3d: true }}>
      <points ref={pointsRef} geometry={geometry} frustumCulled={false}>
        <pointsMaterial
          size={params.pointSize}
          sizeAttenuation
          vertexColors
          transparent
          opacity={params.opacity}
          toneMapped={false}
          depthWrite={false}
        />
      </points>
    </group>
  );
}
