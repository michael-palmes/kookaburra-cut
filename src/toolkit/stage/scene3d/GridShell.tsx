import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Group } from "three";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Grid shell: an unlit latitude/longitude wireframe dome enclosing the whole stage, brightest in the band the camera actually faces and fading toward the zenith, clipped just under floor level. Motion is a slow whole-shell rotation plus a gentle breathe; geometry builds once. */

const SEG = 96;
const FLOOR_Y = -2.2;

export function GridShell({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const groupRef = useRef<Group>(null);

  const radius = params.radius;
  const latCount = Math.round(params.latCount);
  const lonCount = Math.round(params.lonCount);
  const horizonBias = params.horizonBias;
  const lineHex = colors[0] ?? "#3b5c7d";
  const opacity = params.opacity;

  const { geometry } = useMemo(() => {
    const verts: number[] = [];
    const rgba: number[] = [];
    const c = new Color(lineHex);
    // Elevation fade: full strength near the horizon, dying toward the zenith (harder with bias).
    const fadeAt = (y: number) => {
      const elevation = Math.asin(Math.min(Math.max(y / radius, -1), 1)) / (Math.PI / 2);
      const zenith = 1 - Math.min(Math.max(elevation, 0), 1);
      // Alpha floor keeps the cap faintly present; bias steepens the horizon emphasis.
      return 0.15 + 0.85 * zenith ** (1 + 2 * horizonBias);
    };
    const push = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      if (ay < FLOOR_Y && by < FLOOR_Y) return;
      const a = fadeAt(ay);
      const b = fadeAt(by);
      if (a <= 0.004 && b <= 0.004) return;
      verts.push(ax, ay, az, bx, by, bz);
      rgba.push(c.r, c.g, c.b, a, c.r, c.g, c.b, b);
    };
    // Latitude rings from just under the floor to near the zenith.
    for (let i = 0; i < latCount; i++) {
      const el = -0.12 + (i / (latCount - 1)) * 0.95;
      const phi = el * (Math.PI / 2);
      const y = radius * Math.sin(phi);
      const r = radius * Math.cos(phi);
      for (let s = 0; s < SEG; s++) {
        const t1 = (s / SEG) * Math.PI * 2;
        const t2 = ((s + 1) / SEG) * Math.PI * 2;
        push(r * Math.cos(t1), y, r * Math.sin(t1), r * Math.cos(t2), y, r * Math.sin(t2));
      }
    }
    // Longitude arcs over the same elevation window.
    for (let i = 0; i < lonCount; i++) {
      const theta = (i / lonCount) * Math.PI * 2;
      for (let s = 0; s < SEG / 2; s++) {
        const p1 = (-0.12 + (s / (SEG / 2)) * 0.95) * (Math.PI / 2);
        const p2 = (-0.12 + ((s + 1) / (SEG / 2)) * 0.95) * (Math.PI / 2);
        push(
          radius * Math.cos(p1) * Math.cos(theta),
          radius * Math.sin(p1),
          radius * Math.cos(p1) * Math.sin(theta),
          radius * Math.cos(p2) * Math.cos(theta),
          radius * Math.sin(p2),
          radius * Math.cos(p2) * Math.sin(theta),
        );
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(rgba), 4));
    return { geometry };
  }, [radius, latCount, lonCount, horizonBias, lineHex]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const t = (localMs / 1000) * speed;
  const spin = t * 0.04 * params.drift;
  const breathe = opacity * (0.88 + 0.12 * Math.sin(t * 0.7));

  return (
    <group ref={groupRef} rotation={[0, spin, 0]} userData={{ kookaburraBg3d: true }}>
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
