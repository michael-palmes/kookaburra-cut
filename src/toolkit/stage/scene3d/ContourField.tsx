import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Group } from "three";
import { createSeededRandom } from "../../../engine/rng";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Contour field: an unlit topographic map on the floor, marching-squares contours of a seeded gaussian-bump heightfield drawn flat (so nothing can clip), with the grid-plain clearing and radial fade. Motion is a seamless drift plus a breathe; geometry builds once from a fixed seed. */

const EXTENT = 92;
const CELL = 1.5;
const BUMPS = 12;
const SEED = 0xc0470;

export function ContourField({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const groupRef = useRef<Group>(null);

  const levels = Math.round(params.levels);
  const hilliness = params.hilliness;
  const scale = params.scale;
  const clearRadius = params.clearRadius;
  const fadeRadius = params.fadeRadius;
  const height = params.height;
  const lineHex = colors[0] ?? "#3b5c7d";
  const opacity = params.opacity;

  const { geometry } = useMemo(() => {
    const rng = createSeededRandom(SEED);
    // Jittered ring placement guarantees contours populate the visible band at every azimuth.
    const bumps = Array.from({ length: BUMPS }, (_, k) => {
      const angle = (k / BUMPS) * Math.PI * 2 + rng() * 1.2;
      const dist = 10 + rng() * 30;
      return {
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        amp: (0.5 + rng()) * hilliness,
        sigma: scale * (0.6 + rng() * 0.7),
      };
    });
    const h = (x: number, z: number) => {
      let v = 0;
      for (const b of bumps) {
        const d2 = (x - b.x) ** 2 + (z - b.z) ** 2;
        v += b.amp * Math.exp(-d2 / (2 * b.sigma * b.sigma));
      }
      return v;
    };
    const fade = (x: number, z: number) => {
      const r = Math.hypot(x, z);
      const inFade = Math.min(Math.max((r - clearRadius) / 3, 0), 1);
      const outFade = 1 - Math.min(Math.max((r - fadeRadius * 0.55) / (fadeRadius * 0.45), 0), 1);
      return inFade * inFade * (3 - 2 * inFade) * outFade * outFade * (3 - 2 * outFade);
    };
    const n = Math.round(EXTENT / CELL);
    const field: number[][] = [];
    for (let i = 0; i <= n; i++) {
      field[i] = [];
      for (let j = 0; j <= n; j++) {
        field[i][j] = h(-EXTENT / 2 + i * CELL, -EXTENT / 2 + j * CELL);
      }
    }
    let max = 0;
    for (const row of field) for (const v of row) max = Math.max(max, v);

    const verts: number[] = [];
    const rgba: number[] = [];
    const c = new Color(lineHex);
    const push = (x1: number, z1: number, x2: number, z2: number) => {
      const a = fade(x1, z1);
      const b = fade(x2, z2);
      if (a <= 0.004 && b <= 0.004) return;
      verts.push(x1, 0, z1, x2, 0, z2);
      rgba.push(c.r, c.g, c.b, a, c.r, c.g, c.b, b);
    };
    // Marching squares: one segment per crossed cell edge pair, per level.
    const at = (i: number, j: number): [number, number] => [
      -EXTENT / 2 + i * CELL,
      -EXTENT / 2 + j * CELL,
    ];
    for (let l = 1; l <= levels; l++) {
      const iso = (max * l) / (levels + 1);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const v00 = field[i][j];
          const v10 = field[i + 1][j];
          const v01 = field[i][j + 1];
          const v11 = field[i + 1][j + 1];
          const [x0, z0] = at(i, j);
          const crossings: [number, number][] = [];
          const lerp = (a: number, b: number) => (iso - a) / (b - a);
          if (v00 < iso !== v10 < iso) crossings.push([x0 + CELL * lerp(v00, v10), z0]);
          if (v01 < iso !== v11 < iso) crossings.push([x0 + CELL * lerp(v01, v11), z0 + CELL]);
          if (v00 < iso !== v01 < iso) crossings.push([x0, z0 + CELL * lerp(v00, v01)]);
          if (v10 < iso !== v11 < iso) crossings.push([x0 + CELL, z0 + CELL * lerp(v10, v11)]);
          if (crossings.length >= 2) {
            push(crossings[0][0], crossings[0][1], crossings[1][0], crossings[1][1]);
            if (crossings.length === 4) {
              push(crossings[2][0], crossings[2][1], crossings[3][0], crossings[3][1]);
            }
          }
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(rgba), 4));
    return { geometry };
  }, [levels, hilliness, scale, clearRadius, fadeRadius, lineHex]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const t = (localMs / 1000) * speed;
  const drift = params.drift;
  // Contours have no lattice period, so the drift is a bounded oscillation (no wrap, no snap on long holds).
  const offX = 4 * Math.sin(t * 0.05 * drift);
  const offZ = 3 * Math.sin(t * 0.035 * drift + 1);
  const breathe = opacity * (0.87 + 0.13 * Math.sin(t * 0.6));

  return (
    <group ref={groupRef} position={[offX, height, offZ]} userData={{ kookaburraBg3d: true }}>
      <lineSegments geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={breathe}
          toneMapped={false}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}
