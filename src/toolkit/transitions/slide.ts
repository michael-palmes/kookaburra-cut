import type { SceneTime } from "../types";

/** Group slide over a time range. Returns a normalised `offset` (1 → 0) to drive a position on the given axis. Pure function of the timeline; export-safe. */
export function slide(t: SceneTime, range: [number, number], _axis: "x" | "y"): { offset: number } {
  const [start, end] = range;
  const progress = end <= start ? 1 : Math.min(1, Math.max(0, (t.localMs - start) / (end - start)));
  return { offset: 1 - progress };
}
