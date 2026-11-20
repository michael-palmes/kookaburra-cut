type V3 = [number, number, number];

/** Smoke the shafts pass through: a seeded field that drifts and churns with the clock alone. */
export interface BeamSmoke {
  /** Feature scale. Keep the shapes large (0.2 is about five units): edge-on rays average the smoke along a long path, which washes out small wisps. */
  scale: number;
  /** How far a slower field folds the smoke into wisps. */
  warp: number;
  warpScale: number;
  /** The noise band mapped onto [floor, 1]. */
  contrast: [number, number];
  floor: number;
  /** World units per second. */
  drift: V3;
  /** How fast the smoke churns in place. */
  evolve: number;
  warpEvolve: number;
  offset: V3;
  /** Thins the smoke in front of the subject: density falls to `min` between `z0` and `z1`. */
  frontFade?: { z0: number; z1: number; min: number };
}

export const BEAM_SMOKE_DEFAULTS: BeamSmoke = {
  scale: 0.2,
  warp: 1.2,
  warpScale: 0.1,
  contrast: [0.38, 0.62],
  floor: 0.05,
  drift: [0.25, 0.18, 0],
  evolve: 0.12,
  warpEvolve: 0.06,
  offset: [3.1, 7.7, 1.3],
};

/** Motes that glint only where a shaft lights them: seeded, drifting with the clock and wrapping inside a box. Keep them few, small and dim, or they read as a starfield. */
export interface BeamDust {
  count: number;
  min: V3;
  max: V3;
  /** Each mote's radius is picked in this range, world units. */
  radius: [number, number];
  seed: number;
  /** World units per second. */
  drift: V3;
  /** How far each mote wanders off its drift. */
  jitter: number;
  jitterScale: number;
  jitterSpeed: number;
  color: string;
  /** How much a mote glows when lit from behind (Henyey-Greenstein g). */
  forward: number;
  gain: number;
}

export const BEAM_DUST_DEFAULTS: BeamDust = {
  count: 1800,
  min: [-8, -1, -9],
  max: [0, 6, 1],
  radius: [0.002, 0.006],
  seed: 11,
  drift: [0.08, 0.1, 0],
  jitter: 0.35,
  jitterScale: 0.5,
  jitterSpeed: 0.3,
  color: "#b8a890",
  forward: 0.6,
  gain: 1,
};
