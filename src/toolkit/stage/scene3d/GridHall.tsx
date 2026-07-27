import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Group } from "three";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Grid hall: an unlit wireframe room around the stage, floor lattice plus studded walls and ceiling rails, fading toward its far ends and upper corners. Motion is a seamless longitudinal drift (offset cycles within one cell) plus a breathe; geometry builds once. */

const CHUNK = 2;
const FLOOR_Y = -2;

export function GridHall({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const groupRef = useRef<Group>(null);

  const width = params.width;
  const depth = params.depth;
  const height = params.height;
  const spacing = params.spacing;
  const clearRadius = params.clearRadius;
  const lineHex = colors[0] ?? "#3b5c7d";
  const opacity = params.opacity;

  const { geometry } = useMemo(() => {
    const verts: number[] = [];
    const rgba: number[] = [];
    const c = new Color(lineHex);
    const hw = width / 2;
    const hd = depth / 2;
    const fade = (x: number, y: number, z: number) => {
      const end = 1 - Math.min(Math.max((Math.abs(z) - hd * 0.45) / (hd * 0.55), 0), 1);
      const lift = 1 - 0.45 * Math.min(Math.max((y - FLOOR_Y) / (height - 0), 0), 1);
      const clear =
        y > FLOOR_Y + 0.01 ? 1 : Math.min(Math.max((Math.hypot(x, z) - clearRadius) / 3, 0), 1);
      const s = end * end * (3 - 2 * end);
      return s * lift * (clear * clear * (3 - 2 * clear));
    };
    const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
      const a = fade(x1, y1, z1);
      const b = fade(x2, y2, z2);
      if (a <= 0.004 && b <= 0.004) return;
      verts.push(x1, y1, z1, x2, y2, z2);
      rgba.push(c.r, c.g, c.b, a, c.r, c.g, c.b, b);
    };
    const chunked = (
      from: number,
      to: number,
      at: (v: number) => [number, number, number],
    ): void => {
      for (let v = from; v < to; v += CHUNK) {
        const [x1, y1, z1] = at(v);
        const [x2, y2, z2] = at(Math.min(v + CHUNK, to));
        push(x1, y1, z1, x2, y2, z2);
      }
    };
    for (let i = -hw; i <= hw + 1e-6; i += spacing) {
      chunked(-hd, hd, (z) => [i, FLOOR_Y, z]); // floor lines along Z
    }
    for (let j = -hd; j <= hd + 1e-6; j += spacing) {
      chunked(-hw, hw, (x) => [x, FLOOR_Y, j]); // floor lines along X
      // wall studs both sides, ceiling rail across
      chunked(FLOOR_Y, FLOOR_Y + height, (y) => [-hw, y, j]);
      chunked(FLOOR_Y, FLOOR_Y + height, (y) => [hw, y, j]);
      chunked(-hw, hw, (x) => [x, FLOOR_Y + height, j]);
    }
    // horizontal wall rails
    for (let y = FLOOR_Y; y <= FLOOR_Y + height + 1e-6; y += spacing) {
      chunked(-hd, hd, (z) => [-hw, y, z]);
      chunked(-hd, hd, (z) => [hw, y, z]);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(rgba), 4));
    return { geometry };
  }, [width, depth, height, spacing, clearRadius, lineHex]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const t = (localMs / 1000) * speed;
  const offZ = (((t * 0.3 * params.drift) % spacing) + spacing) % spacing;
  const breathe = opacity * (0.88 + 0.12 * Math.sin(t * 0.8));

  return (
    <group ref={groupRef} position={[0, 0, offZ]} userData={{ kookaburraBg3d: true }}>
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
