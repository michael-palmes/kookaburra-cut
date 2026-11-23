import { useEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { ease } from "../../engine/ease";
import { useTimeline } from "../../engine/timeline";
import type { V3 } from "../types";

export interface RippleProps {
  /** When the ripple starts, in ms of local scene time. */
  at: number;
  /** Centre of the ripple, on the surface it crosses. */
  position?: V3;
  /** Rotation in radians; the ripple spreads in its own XY plane and faces +z. */
  rotation?: V3;
  /** World-unit radius the ring reaches. */
  radius?: number;
  /** The ring's width as a fraction of its radius. */
  width?: number;
  /** How tall the wave stands against its width: the strength of the bend. */
  height?: number;
  /** Crests across the ring's width: 1 is a single swell, 2 a wave with a trailing ring. */
  crests?: number;
  /** Index of refraction: 1.33 is water, 1.5 glass. */
  ior?: number;
  durationMs?: number;
}

const AROUND = 96;
const ACROSS = 24;

/** A unit ring (outer radius 1, `width` wide) raised into a smooth wave of `crests` crests, at most unit height and tallest mid-ring, flat where it meets the surface on both sides, with exact normals. */
export function rippleRingGeometry(width: number, crests = 1): BufferGeometry {
  const w = Math.min(Math.max(width, 0.02), 1);
  const k = Math.min(Math.max(Math.round(crests), 1), 4);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= AROUND; i++) {
    const angle = (i / AROUND) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let j = 0; j <= ACROSS; j++) {
      const t = j / ACROSS;
      const r = 1 - w + w * t;
      const wave = Math.sin(Math.PI * k * t) ** 2;
      const envelope = k === 1 ? 1 : Math.sin(Math.PI * t);
      const slope =
        (Math.PI / w) *
        (k * Math.sin(2 * Math.PI * k * t) * envelope +
          (k === 1 ? 0 : wave * Math.cos(Math.PI * t)));
      const length = Math.hypot(slope, 1);
      positions.push(r * cos, r * sin, wave * envelope);
      normals.push((-slope * cos) / length, (-slope * sin) / length, 1 / length);
    }
  }
  for (let i = 0; i < AROUND; i++) {
    for (let j = 0; j < ACROSS; j++) {
      const a = i * (ACROSS + 1) + j;
      const b = a + ACROSS + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** The ring `ms` after it starts: it opens fast and slows, and its wave swells in and dies away. `swell` is 0 before it starts and once it has gone. */
export function rippleAt(
  ms: number,
  radius: number,
  durationMs: number,
): { radius: number; swell: number } {
  const u = Math.min(1, Math.max(0, ms / Math.max(durationMs, 1)));
  const alive = ms >= 0 && u < 1;
  return {
    radius: radius * (0.12 + 0.88 * ease("outCubic", u)),
    swell: alive ? Math.min(1, u / 0.1) * (1 - u) ** 1.5 : 0,
  };
}

/** A ripple crossing a surface: a ring of clear, glossy wave that opens from a point and bends what is behind it, like a drop landing on water or a pulse through glass. Place it just off the surface (a screen, a floor, a card) and turn it to face out of it. It refracts what the frame has already drawn, so it reads over a picture or a screen and shows nothing over a flat colour. Pure function of `useTimeline()`. */
export function Ripple({
  at,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  radius = 0.4,
  width = 0.6,
  height = 0.2,
  crests = 2,
  ior = 1.4,
  durationMs = 600,
}: RippleProps) {
  const { localMs } = useTimeline();
  const geometry = useMemo(() => rippleRingGeometry(width, crests), [width, crests]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const ring = rippleAt(localMs - at, radius, durationMs);
  const wave = Math.max(ring.radius * width * height * ring.swell, 1e-5);
  return (
    <mesh
      geometry={geometry}
      position={position}
      rotation={rotation}
      scale={[ring.radius, ring.radius, wave]}
      visible={ring.swell > 0}
      frustumCulled={false}
    >
      <meshPhysicalMaterial
        transmission={1}
        thickness={1}
        ior={ior}
        roughness={0}
        metalness={0}
        specularIntensity={1}
        depthWrite={false}
      />
    </mesh>
  );
}
