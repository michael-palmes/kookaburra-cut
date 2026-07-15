import type { SceneTime } from "../types";

/** Group fade over a time range. Apply the returned opacity to a `<group>` (or a material); a pure function of the timeline, safe for deterministic export. */
export function fade(t: SceneTime, range: [number, number]): { opacity: number } {
  const [start, end] = range;
  const opacity = end <= start ? 1 : Math.min(1, Math.max(0, (t.localMs - start) / (end - start)));
  return { opacity };
}
