import { useLayoutEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import type { V3 } from "../types";

export interface WireGridProps {
  /** Grid extent (a size × size square in the local XZ plane), in world units. */
  size?: number;
  /** Cells per side. */
  divisions?: number;
  /** Wave height, in world units. 0 = flat static grid. */
  amplitude?: number;
  /** Wave length, in world units. */
  wavelength?: number;
  /** Wave travel speed, in cycles/second, a pure function of the timeline. */
  speed?: number;
  /** Theme colour token. */
  tone?: "text" | "accent" | "muted";
  /** Line opacity (lines don't bloom hard; keep them a quiet backdrop). */
  opacity?: number;
  position?: V3;
  /** Base rotation in radians; lay it flat as a floor (default) or tilt it as a backdrop. */
  rotation?: V3;
}

const TWO_PI = Math.PI * 2;

/** Procedural line grid with a travelling wave: the lattice is built once (pure function of size/divisions), and per-frame the Y displacement is recomputed on the CPU as a pure function of `useTimeline()` (no RNG, no shader time uniform) during commit, so the export loop's canvas-commit barrier sees it before capture. */
export function WireGrid(props: WireGridProps) {
  const {
    size = 12,
    divisions = 24,
    amplitude = 0.35,
    wavelength = 3,
    speed = 0.25,
    tone = "muted",
    opacity = 0.6,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
  } = props;

  const { localMs } = useTimeline();
  const theme = useTheme();

  // Segment endpoints for both grid directions, flat in XZ. Rebuilt only on prop change.
  const { geometry, positions } = useMemo(() => {
    const side = divisions + 1;
    const step = size / divisions;
    const half = size / 2;
    const verts: number[] = [];
    for (let i = 0; i < side; i++) {
      const a = -half + i * step;
      for (let j = 0; j < divisions; j++) {
        const b = -half + j * step;
        verts.push(a, 0, b, a, 0, b + step); // line parallel to Z
        verts.push(b, 0, a, b + step, 0, a); // line parallel to X
      }
    }
    const positions = new BufferAttribute(new Float32Array(verts), 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", positions);
    return { geometry, positions };
  }, [size, divisions]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    if (amplitude === 0) return;
    const t = localMs / 1000;
    const k = TWO_PI / wavelength;
    const phase = t * speed * TWO_PI;
    const arr = positions.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i];
      const z = arr[i + 2];
      arr[i + 1] = amplitude * Math.sin(k * x + phase) * Math.cos(k * z + phase * 0.8);
    }
    positions.needsUpdate = true;
  }, [localMs, positions, amplitude, wavelength, speed]);

  return (
    <lineSegments geometry={geometry} position={position} rotation={rotation} frustumCulled={false}>
      <lineBasicMaterial color={theme.colors[tone]} transparent opacity={opacity} />
    </lineSegments>
  );
}
