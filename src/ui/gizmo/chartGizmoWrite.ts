/** What a hero-chart gizmo drag writes into `chart.style`. The ranges are `resolveChartStyle`'s own, so a drag can never write a value the resolver would silently clamp back. */

/** A world-unit nudge added to the current offset, 2dp, clamped to the resolver's ±20. */
export function chartOffsetWrite(base: number, delta: number): number {
  const v = Number.isFinite(base) && Number.isFinite(delta) ? base + delta : base;
  return Math.round(Math.min(20, Math.max(-20, v)) * 100) / 100;
}

/** The current scale multiplied by the drag factor, 2dp, clamped to the resolver's 0.2..3. */
export function chartScaleWrite(base: number, factor: number): number {
  const v = Number.isFinite(base) && Number.isFinite(factor) ? base * factor : base;
  return Math.round(Math.min(3, Math.max(0.2, v)) * 100) / 100;
}
