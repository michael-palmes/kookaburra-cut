import { useLayoutEffect, useMemo, useRef } from "react";
import { type InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { createSeededRandom } from "../../engine/rng";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import type { V3 } from "../types";

export interface ParticleFieldProps {
  /** Instance count. */
  count?: number;
  /** RNG seed; same seed, same field, every run (the determinism contract). */
  seed?: number;
  /** Half-extents of the scatter box, in world units. */
  bounds?: V3;
  /** Base particle radius, in world units. */
  size?: number;
  /** Upward drift in world-units/second; particles wrap inside the bounds. 0 = static. */
  drift?: number;
  /** Scale-pulse amplitude as a fraction of `size` (0 disables). */
  twinkle?: number;
  /** Theme colour token (unlit material, pops under bloom). */
  tone?: "text" | "accent" | "muted";
  position?: V3;
}

/** Per-particle constants derived once from the seed. */
interface Particle {
  base: Vector3;
  sizeMul: number;
  phase: number;
  speedMul: number;
}

const IDENTITY_QUAT = new Quaternion();
const tmpMatrix = new Matrix4();
const tmpPos = new Vector3();
const tmpScale = new Vector3();
const TWO_PI = Math.PI * 2;

/** Instanced particle scatter: every particle's base position/size/phase is drawn from `createSeededRandom(seed)` (never `Math.random`), and per-frame drift/twinkle are pure functions of `useTimeline()` so the field is byte-identical run-to-run; the RNG draw order below is part of that contract, reordering it re-scatters every committed project. */
export function ParticleField(props: ParticleFieldProps) {
  const {
    count = 200,
    seed = 1,
    bounds = [6, 3.5, 2],
    size = 0.04,
    drift = 0.15,
    twinkle = 0.25,
    tone = "accent",
    position = [0, 0, 0],
  } = props;

  const { localMs } = useTimeline();
  const theme = useTheme();
  const ref = useRef<InstancedMesh>(null);
  const [bx, by, bz] = bounds;

  const particles = useMemo<Particle[]>(() => {
    const rand = createSeededRandom(seed);
    return Array.from({ length: count }, () => ({
      base: new Vector3((rand() * 2 - 1) * bx, (rand() * 2 - 1) * by, (rand() * 2 - 1) * bz),
      sizeMul: 0.5 + rand(),
      phase: rand() * TWO_PI,
      speedMul: 0.5 + rand(),
    }));
  }, [count, seed, bx, by, bz]);

  // Write instance matrices during commit (layout effect) so the export loop's canvas-commit barrier sees them before capture; pure function of localMs.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = localMs / 1000;
    const wrap = 2 * by;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const y =
        drift === 0 || wrap === 0
          ? p.base.y
          : ((((p.base.y + by + drift * p.speedMul * t) % wrap) + wrap) % wrap) - by;
      tmpPos.set(p.base.x, y, p.base.z);
      const pulse = 1 + twinkle * Math.sin(p.phase + t * p.speedMul * TWO_PI * 0.5);
      tmpScale.setScalar(size * p.sizeMul * pulse);
      tmpMatrix.compose(tmpPos, IDENTITY_QUAT, tmpScale);
      mesh.setMatrixAt(i, tmpMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [localMs, particles, by, drift, size, twinkle]);

  return (
    <group position={position}>
      {/* Instances move each frame; the geometry-derived bounding sphere would cull them. */}
      <instancedMesh
        key={count}
        ref={ref}
        args={[undefined, undefined, count]}
        frustumCulled={false}
      >
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial color={theme.colors[tone]} />
      </instancedMesh>
    </group>
  );
}
