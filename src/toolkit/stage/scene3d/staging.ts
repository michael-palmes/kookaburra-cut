import { createSeededRandom, type SeededRandom } from "../../../engine/rng";

/** Seeded placement for lit abstract looks: positions in the backdrop band, reject-sampled OUT of the content volume (x/y roughly +-4/+-2, z -6..9 plus margin) so shapes never crowd the device or title. Pure function of the seed; every look builds its ensemble once. */
export interface AbstractPlacement {
  position: [number, number, number];
  phase: number;
  scale: number;
}

export function seededPlacements(
  seed: number,
  count: number,
  opts: { spread: number; depthMid: number; depthRange: number; yMin: number; yMax: number },
): { rng: SeededRandom; placements: AbstractPlacement[] } {
  const rng = createSeededRandom(seed);
  const placements: AbstractPlacement[] = [];
  let guard = 0;
  while (placements.length < count && guard++ < count * 30) {
    const x = (rng() - 0.5) * 2 * opts.spread;
    const y = opts.yMin + rng() * (opts.yMax - opts.yMin);
    const z = opts.depthMid + (rng() - 0.5) * 2 * opts.depthRange;
    // Keep-out: nothing near the stage volume (content x/y +-4/+-2, z -6..9 with margin).
    if (Math.abs(x) < 6 && z > -9) continue;
    placements.push({ position: [x, y, z], phase: rng() * Math.PI * 2, scale: 0.7 + rng() * 0.6 });
  }
  return { rng, placements };
}

/** Emissive floor keeps lit looks visible on scenes without any lighting rig; scene lights add the modelling on top. */
export const ABSTRACT_EMISSIVE = 0.35;
