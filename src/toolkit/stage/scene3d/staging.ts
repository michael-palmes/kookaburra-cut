import { createSeededRandom } from "../../../engine/rng";

/** Seeded ring placement for lit abstract looks: even azimuthal coverage with jitter, so a full 360 orbit never finds an empty sector. `distance` is the ring radius from the stage centre, `thickness` the radial variance; the hard floor keeps every shape outside the content volume regardless of slider combinations. Pure function of the seed; every look builds its ensemble once. */
export interface AbstractPlacement {
  position: [number, number, number];
  phase: number;
  scale: number;
}

const MIN_RING_RADIUS = 9.5;

export function ringPlacements(
  seed: number,
  count: number,
  opts: {
    distance: number;
    thickness: number;
    yMin: number;
    yMax: number;
    /** Extra shapes as a fraction of `count`, laid across the BACK arc (behind the stage from the default camera) one layer deeper, so the main backdrop reads full while the ring still covers every orbit angle. */
    backExtra?: number;
  },
): AbstractPlacement[] {
  const rng = createSeededRandom(seed);
  const place = (angle: number, extraDistance: number): AbstractPlacement => {
    const r = Math.max(
      MIN_RING_RADIUS,
      opts.distance + extraDistance + (rng() - 0.5) * 2 * opts.thickness,
    );
    const y = opts.yMin + rng() * (opts.yMax - opts.yMin);
    return {
      position: [r * Math.cos(angle), y, r * Math.sin(angle)],
      phase: rng() * Math.PI * 2,
      scale: 0.7 + rng() * 0.6,
    };
  };
  const ring = Array.from({ length: count }, (_, k) =>
    place(((k + 0.5) / count) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / count), 0),
  );
  // Back arc: z negative faces the default camera; theta pi..2pi under the x=cos/z=sin convention.
  const backCount = Math.round(count * (opts.backExtra ?? 0));
  const back = Array.from({ length: backCount }, (_, k) =>
    place(Math.PI * (1.15 + ((k + 0.5) / backCount) * 0.7) + (rng() - 0.5) * 0.2, 2 + rng() * 2),
  );
  return [...ring, ...back];
}

/** Emissive floor keeps lit looks visible on scenes without any lighting rig; scene lights add the modelling on top. */
export const ABSTRACT_EMISSIVE = 0.35;
