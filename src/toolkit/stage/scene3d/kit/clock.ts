/** Look time in seconds: the ABSOLUTE project clock (`globalMs`) times the look's speed, so a look flows unbroken across cuts. The existing 10 looks stay on scene-local time. */
export function lookSeconds(globalMs: number, speed: number): number {
  return (globalMs / 1000) * speed;
}

/** Wraps look time into [0, period) with a negative-safe modulo, in double precision on the CPU, so exact loops stay exact and shader floats stay small on long projects. */
export function loopSeconds(t: number, period: number): number {
  if (!(period > 0)) return t;
  const r = t % period;
  return r < 0 ? r + period : r;
}
