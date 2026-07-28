import { useLayoutEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, type Points } from "three";
import { useTimeline } from "../../../engine/timeline";
import type { Scene3dLookProps } from "./types";

/** Point swell: an ocean of points rolling below and around the stage, crests tinting toward the accent, fading off at distance with a clearing under the stage. Unlit exact colours; per-frame displacement is a pure function of the timeline recomputed on the CPU during commit (the WireGrid precedent), so the export barrier always sees it. */

const EXTENT = 72;
const FLOOR_Y = -2.2;

export function PointSwell({ colors, params, speed }: Scene3dLookProps) {
  const { localMs } = useTimeline();
  const pointsRef = useRef<Points>(null);

  const spacing = params.spacing;
  const clearRadius = params.clearRadius;
  const fadeRadius = params.fadeRadius;
  const pointHex = colors[0] ?? "#33475b";
  const crestHex = colors[1] ?? "#765738";

  const { geometry, positions, rgba, base } = useMemo(() => {
    const base: { x: number; z: number; fade: number }[] = [];
    const fade = (r: number) => {
      const inF = Math.min(Math.max((r - clearRadius) / 3, 0), 1);
      const outF = 1 - Math.min(Math.max((r - fadeRadius * 0.5) / (fadeRadius * 0.5), 0), 1);
      return inF * inF * (3 - 2 * inF) * outF * outF * (3 - 2 * outF);
    };
    for (let x = -EXTENT / 2; x <= EXTENT / 2; x += spacing) {
      for (let z = -EXTENT / 2; z <= EXTENT / 2; z += spacing) {
        const f = fade(Math.hypot(x, z));
        if (f > 0.004) base.push({ x, z, fade: f });
      }
    }
    const positions = new BufferAttribute(new Float32Array(base.length * 3), 3);
    const rgba = new BufferAttribute(new Float32Array(base.length * 4), 4);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", positions);
    geometry.setAttribute("color", rgba);
    return { geometry, positions, rgba, base };
  }, [spacing, clearRadius, fadeRadius]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const palette = useMemo(() => {
    const a = new Color(pointHex);
    const b = new Color(crestHex);
    return { a, b };
  }, [pointHex, crestHex]);

  useLayoutEffect(() => {
    // Pace baked so speed 1 is the tuned house default.
    const t = (localMs / 1000) * speed * 2;
    const k = (Math.PI * 2) / params.wavelength;
    const phase = t * 0.6 * params.drift;
    const amp = params.amplitude;
    const pos = positions.array as Float32Array;
    const col = rgba.array as Float32Array;
    for (let i = 0; i < base.length; i++) {
      const { x, z, fade } = base[i];
      const swell = Math.sin(k * x + phase) * Math.cos(k * z * 0.8 + phase * 0.7);
      pos[i * 3] = x;
      pos[i * 3 + 1] = FLOOR_Y + amp * swell;
      pos[i * 3 + 2] = z;
      // Crests tint toward the accent.
      const crest = Math.max(0, swell);
      col[i * 4] = palette.a.r + (palette.b.r - palette.a.r) * crest;
      col[i * 4 + 1] = palette.a.g + (palette.b.g - palette.a.g) * crest;
      col[i * 4 + 2] = palette.a.b + (palette.b.b - palette.a.b) * crest;
      col[i * 4 + 3] = fade;
    }
    positions.needsUpdate = true;
    rgba.needsUpdate = true;
  }, [
    localMs,
    speed,
    positions,
    rgba,
    base,
    palette,
    params.wavelength,
    params.drift,
    params.amplitude,
  ]);

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      frustumCulled={false}
      userData={{ kookaburraBg3d: true }}
    >
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
  );
}
