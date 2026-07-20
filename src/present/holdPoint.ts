/** Derives where a scene holds during a present slideshow: after its intros settle, before any authored outro. Pure; the constants shape present-mode behaviour only and are never part of the export contract. */

import type { PresentTimingEntry } from "../engine/presentTimingRegistry";

export interface DerivedHold {
  /** Scene-local ms the hold parks at. */
  holdMs: number;
  /** Scene-local ms the leave phase re-anchors to (outros + transition play from here). */
  outStartMs: number;
}

/** Settle margin added after the latest intro end. */
export const HOLD_MARGIN_MS = 150;
/** Hold point for scenes with no staged intro at all. */
export const FALLBACK_HOLD_MS = 400;
/** Leave runway reserved before the scene end when no outro is authored. */
export const DEFAULT_OUT_RUNWAY_MS = 600;
/** Minimum distance kept between the hold and the leave point. */
export const MIN_HOLD_GAP_MS = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function derivePresentHold(
  entries: readonly PresentTimingEntry[],
  sceneDurationMs: number,
): DerivedHold {
  const introEnds = entries.map((e) => e.toMs + (e.staggerSpreadMs ?? 0));
  const holdCandidate = introEnds.length
    ? Math.max(...introEnds) + HOLD_MARGIN_MS
    : FALLBACK_HOLD_MS;
  const outAts = entries
    .map((e) => e.outAtMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const outStartMs = clamp(
    outAts.length
      ? Math.min(...outAts)
      : Math.max(holdCandidate + MIN_HOLD_GAP_MS, sceneDurationMs - DEFAULT_OUT_RUNWAY_MS),
    0,
    sceneDurationMs,
  );
  const holdMs = clamp(Math.min(holdCandidate, outStartMs - MIN_HOLD_GAP_MS), 0, sceneDurationMs);
  return { holdMs, outStartMs };
}
