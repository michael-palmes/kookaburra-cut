import { useLayoutEffect, useMemo, useRef } from "react";
import {
  DoubleSide,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";
import { createSeededRandom } from "../../engine/rng";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import type { V3 } from "../types";

export interface DustBurstProps {
  /** The impact, in ms of local scene time. */
  at: number;
  /** Centre of what lands, on the floor. */
  position?: V3;
  /** Width and depth of what lands: the puffs start along its edge. */
  footprint?: [number, number];
  /** Puff count. */
  count?: number;
  /** RNG seed; same seed, same burst, every run. */
  seed?: number;
  /** How far the puffs travel outwards, in world units. */
  reach?: number;
  /** How far they rise. */
  lift?: number;
  /** A puff's radius at its largest. */
  size?: number;
  /** A puff's height against its width: under 1 keeps the burst low, a skirt along the floor. */
  flatten?: number;
  /** How long the burst takes to clear. */
  durationMs?: number;
  opacity?: number;
  /** Theme colour token (unlit). */
  tone?: "text" | "accent" | "muted";
}

export interface DustPuff {
  angle: number;
  speed: number;
  rise: number;
  radius: number;
  life: number;
  delayMs: number;
  alpha: number;
}

/** Per-puff constants from the seed; the draw order is part of the determinism contract. */
export function dustPuffs(count: number, seed: number): DustPuff[] {
  const rand = createSeededRandom(seed);
  return Array.from({ length: count }, () => ({
    angle: rand() * Math.PI * 2,
    speed: 0.35 + 0.65 * rand(),
    rise: 0.2 + 0.8 * rand(),
    radius: 0.45 + 0.55 * rand(),
    life: 0.55 + 0.45 * rand(),
    delayMs: 50 * rand(),
    alpha: 0.5 + 0.5 * rand(),
  }));
}

export interface DustShape {
  footprint: [number, number];
  reach: number;
  lift: number;
  size: number;
  flatten: number;
  durationMs: number;
}

/** One puff `ms` after the impact: thrown out fast and stopped by drag, swelling as it thins. `alpha` is 0 before it starts and once it has cleared. */
export function dustPuffAt(
  puff: DustPuff,
  ms: number,
  shape: DustShape,
): { x: number; y: number; z: number; radius: number; alpha: number } {
  const u = Math.min(1, Math.max(0, (ms - puff.delayMs) / (puff.life * shape.durationMs)));
  const out = 1 - (1 - u) ** 4;
  const radius = shape.size * puff.radius * (0.3 + 0.7 * out);
  const cos = Math.cos(puff.angle);
  const sin = Math.sin(puff.angle);
  const travel = shape.reach * puff.speed * out;
  const alive = ms >= puff.delayMs && u < 1;
  return {
    x: cos * (shape.footprint[0] / 2 + travel),
    y: 0.7 * radius * shape.flatten + shape.lift * puff.rise * (1 - (1 - u) ** 2),
    z: sin * (shape.footprint[1] / 2 + travel),
    radius,
    alpha: alive ? puff.alpha * Math.min(1, u / 0.05) * (1 - u) ** 2 : 0,
  };
}

const IDENTITY_QUAT = new Quaternion();
const tmpMatrix = new Matrix4();
const tmpPos = new Vector3();
const tmpScale = new Vector3();

const VERTEX_PARS = /* glsl */ `
attribute float kbAlpha;
varying float vKbAlpha;
varying vec2 vKbUv;
`;

const VERTEX = /* glsl */ `
vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
mvPosition.xy += position.xy * vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );
gl_Position = projectionMatrix * mvPosition;
vKbAlpha = kbAlpha;
vKbUv = position.xy;
`;

const FRAGMENT_PARS = /* glsl */ `
varying float vKbAlpha;
varying vec2 vKbUv;
`;

const FRAGMENT = /* glsl */ `
float kbSoft = 1.0 - smoothstep( 0.0, 1.0, length( vKbUv ) );
diffuseColor.a *= vKbAlpha * kbSoft * kbSoft;
`;

function mustReplace(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`dust burst: shader anchor missing: ${anchor}`);
  return source.replace(anchor, replacement);
}

/** Dust thrown up where something lands hard on a floor: soft puffs that burst outwards from the footprint's edge, rise a little and clear. Every puff is drawn from `createSeededRandom(seed)` and placed as a pure function of `useTimeline()`, so it exports byte for byte the same. Unlit and camera-facing; it shows in a satin floor's reflection. */
export function DustBurst(props: DustBurstProps) {
  const {
    at,
    position = [0, 0, 0],
    footprint = [1, 0.5],
    count = 120,
    seed = 1,
    reach = 1.6,
    lift = 0.2,
    size = 0.3,
    flatten = 0.6,
    durationMs = 800,
    opacity = 0.35,
    tone = "muted",
  } = props;
  const { localMs } = useTimeline();
  const theme = useTheme();
  const ref = useRef<InstancedMesh>(null);
  const puffs = useMemo(() => dustPuffs(count, seed), [count, seed]);
  const alphas = useMemo(() => new InstancedBufferAttribute(new Float32Array(count), 1), [count]);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    m.onBeforeCompile = (shader) => {
      let vs = mustReplace(
        shader.vertexShader,
        "#include <common>",
        `#include <common>${VERTEX_PARS}`,
      );
      vs = mustReplace(vs, "#include <project_vertex>", VERTEX);
      shader.vertexShader = vs;
      let fs = mustReplace(
        shader.fragmentShader,
        "#include <common>",
        `#include <common>${FRAGMENT_PARS}`,
      );
      fs = mustReplace(fs, "#include <color_fragment>", `#include <color_fragment>${FRAGMENT}`);
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => "kookaburra-dust-burst-v1";
    return m;
  }, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    material.color.set(theme.colors[tone]);
    material.opacity = Math.min(1, Math.max(0, opacity));
  }, [material, theme, tone, opacity]);

  const ms = localMs - at;
  const active = ms >= 0 && ms <= durationMs + 50;
  const [fx, fz] = footprint;

  // Written during commit so the export's canvas-commit barrier sees them before capture; pure function of localMs.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh || !active) return;
    const shape: DustShape = { footprint: [fx, fz], reach, lift, size, flatten, durationMs };
    for (let i = 0; i < puffs.length; i++) {
      const p = dustPuffAt(puffs[i], ms, shape);
      tmpPos.set(p.x, p.y, p.z);
      const r = Math.max(p.radius, 1e-4);
      tmpScale.set(r, r * flatten, r);
      tmpMatrix.compose(tmpPos, IDENTITY_QUAT, tmpScale);
      mesh.setMatrixAt(i, tmpMatrix);
      alphas.setX(i, p.alpha);
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphas.needsUpdate = true;
  }, [ms, active, puffs, alphas, fx, fz, reach, lift, size, flatten, durationMs]);

  return (
    <group position={position}>
      <instancedMesh
        key={count}
        ref={ref}
        args={[undefined, undefined, count]}
        material={material}
        visible={active}
        frustumCulled={false}
        renderOrder={2}
      >
        <planeGeometry args={[2, 2]}>
          <primitive object={alphas} attach="attributes-kbAlpha" />
        </planeGeometry>
      </instancedMesh>
    </group>
  );
}
