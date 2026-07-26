/** Pure geometry for the scene placement strip (SceneInsertTimeline), structure-pinned in unit tests so the drag feel is tunable without touching the component (the scrubMath precedent). */

export interface StripLayout {
  /** Scene card count; the strip has `count + 1` gaps (start and end are first-class). */
  count: number;
  /** Rendered card width in px (cards are equal-width, never duration-proportional). */
  cardWidth: number;
  /** Space between cards in px. */
  gapWidth: number;
  /** Left inset of the first card in strip content coordinates. */
  padStart: number;
}

/** Content-x centres of every insertion gap: gap i sits mid-gap before card i, gap `count` sits after the last card. */
export function gapCentres(layout: StripLayout): number[] {
  const pitch = layout.cardWidth + layout.gapWidth;
  return Array.from(
    { length: layout.count + 1 },
    (_, i) => layout.padStart - layout.gapWidth / 2 + i * pitch,
  );
}

/** Stretch the final gap out to `endX` when the row underfills its width, so "At the end" parks at the strip's far edge; a computed centre already past `endX` (an overflowing strip) wins. */
export function stretchEnd(centres: number[], endX: number): number[] {
  if (centres.length === 0 || endX <= centres[centres.length - 1]) return centres;
  const out = centres.slice();
  out[out.length - 1] = endX;
  return out;
}

/** Index of the nearest gap centre (ties go to the earlier gap; empty centres degrade to 0). */
export function nearestGap(x: number, centres: number[]): number {
  let best = 0;
  for (let i = 1; i < centres.length; i++) {
    if (Math.abs(centres[i] - x) < Math.abs(centres[best] - x)) best = i;
  }
  return best;
}

/** Rubber-band pull toward the nearest gap centre: full pull at the centre, easing to none at `halfSpan` (the midpoint to the neighbouring gap), so the indicator always tracks the pointer and never jumps when the nearest gap changes mid-drag. */
export function elasticX(rawX: number, gapX: number, halfSpan: number, exponent = 2): number {
  if (halfSpan <= 0) return gapX;
  const d = rawX - gapX;
  const u = Math.min(1, Math.abs(d) / halfSpan);
  return gapX + d * u ** exponent;
}

/** Gap index → the wizards' placement encoding ("start" | "end" | "after:<index>"). */
export function placementFromGap(gap: number, count: number): string {
  if (gap >= count) return "end";
  if (gap <= 0) return "start";
  return `after:${gap - 1}`;
}

/** Placement encoding → gap index, clamped to the strip; junk degrades to the end. */
export function gapFromPlacement(value: string, count: number): number {
  if (value === "start") return 0;
  if (value === "end") return count;
  const after = Number(value.replace(/^after:/, ""));
  if (!Number.isFinite(after)) return count;
  return Math.max(0, Math.min(count, after + 1));
}

/** Auto-scroll velocity (px per frame) while a drag sits within `band` px of a viewport edge, ramping linearly to `maxSpeed` at the edge; 0 elsewhere. */
export function edgeScrollVelocity(
  pointerX: number,
  viewLeft: number,
  viewRight: number,
  band = 48,
  maxSpeed = 14,
): number {
  if (band <= 0) return 0;
  const fromLeft = pointerX - viewLeft;
  const fromRight = viewRight - pointerX;
  if (fromLeft < band) return -maxSpeed * Math.min(1, (band - fromLeft) / band);
  if (fromRight < band) return maxSpeed * Math.min(1, (band - fromRight) / band);
  return 0;
}
