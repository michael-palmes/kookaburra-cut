import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Group } from "three";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Grid plain: an unlit line lattice floor running to the horizon in every direction, with a baked keep-out clearance around the stage and a radial fade into nothing. Motion is a seamless scroll (the whole lattice translates by a fraction of one cell, a pure function of the timeline) plus a gentle global breathe; geometry is built once, so per-frame cost is two group/material writes. */

const EXTENT = 96;
const CHUNK = 2;

export function GridPlain({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const groupRef = useRef<Group>(null);

  const spacing = params.spacing;
  const clearRadius = params.clearRadius;
  const fadeRadius = params.fadeRadius;
  const height = params.height;
  const lineHex = colors[0] ?? "#22364e";
  const opacity = params.opacity;

  const { geometry } = useMemo(() => {
    const verts: number[] = [];
    const rgba: number[] = [];
    const c = new Color(lineHex);
    const half = EXTENT / 2;
    const fade = (r: number) => {
      // Fixed 3u feather: the clearing is a courtesy under the stage, not a content radius (the floor sits below everything, so nothing can clip).
      const inFade = Math.min(Math.max((r - clearRadius) / 3, 0), 1);
      const outFade = 1 - Math.min(Math.max((r - fadeRadius * 0.55) / (fadeRadius * 0.45), 0), 1);
      return inFade * inFade * (3 - 2 * inFade) * outFade * outFade * (3 - 2 * outFade);
    };
    const pushChunk = (x1: number, z1: number, x2: number, z2: number) => {
      const a = fade(Math.hypot(x1, z1));
      const b = fade(Math.hypot(x2, z2));
      if (a <= 0.001 && b <= 0.001) return;
      verts.push(x1, 0, z1, x2, 0, z2);
      rgba.push(c.r, c.g, c.b, a, c.r, c.g, c.b, b);
    };
    for (let i = -half; i <= half + 1e-6; i += spacing) {
      for (let j = -half; j < half; j += CHUNK) {
        pushChunk(i, j, i, Math.min(j + CHUNK, half));
        pushChunk(j, i, Math.min(j + CHUNK, half), i);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(rgba), 4));
    return { geometry };
  }, [spacing, clearRadius, fadeRadius, lineHex]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  // Seamless scroll: offset cycles within one cell, so the baked fade ring wobbles under a unit (invisible against a 20u feather).
  // Pace baked so speed 1 is the tuned house default.
  const t = (localMs / 1000) * speed * 1.3;
  const drift = params.drift;
  const offX = (((t * 0.35 * drift) % spacing) + spacing) % spacing;
  const offZ = (((t * 0.22 * drift) % spacing) + spacing) % spacing;
  const breathe = opacity * (0.85 + 0.15 * Math.sin(t * 0.9));

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
