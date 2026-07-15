/** Deterministic seeded PRNG (mulberry32) for generative geometry: scene code must NEVER call `Math.random`, geometry has to be byte-identical run-to-run, so all randomness flows through a generator seeded by a constant (or a scene prop). The exact sequence is part of the export contract, committed projects bake their geometry from it, so changing the algorithm (or these constants) is a breaking change to every generative scene; guarded by golden values in rng.test.ts. */

/** A generator of floats in [0, 1), advancing on each call. */
export type SeededRandom = () => number;

/** Create a mulberry32 generator from an integer seed (fractional seeds are truncated). */
export function createSeededRandom(seed: number): SeededRandom {
  let a = Math.trunc(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
