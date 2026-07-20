import { describe, expect, it } from "vitest";
import type { PresentTimingEntry } from "../engine/presentTimingRegistry";
import {
  DEFAULT_OUT_RUNWAY_MS,
  derivePresentHold,
  FALLBACK_HOLD_MS,
  HOLD_MARGIN_MS,
  MIN_HOLD_GAP_MS,
} from "./holdPoint";

const text = (toMs: number, extra: Partial<PresentTimingEntry> = {}): PresentTimingEntry => ({
  kind: "text",
  toMs,
  ...extra,
});

describe("derivePresentHold", () => {
  it("falls back when a scene has no staged intro", () => {
    const hold = derivePresentHold([], 3000);
    expect(hold.holdMs).toBe(FALLBACK_HOLD_MS);
    expect(hold.outStartMs).toBe(3000 - DEFAULT_OUT_RUNWAY_MS);
  });

  it("holds after a single intro settles, plus the margin", () => {
    const hold = derivePresentHold([text(1200)], 4000);
    expect(hold.holdMs).toBe(1200 + HOLD_MARGIN_MS);
    expect(hold.outStartMs).toBe(4000 - DEFAULT_OUT_RUNWAY_MS);
  });

  it("accounts for stagger spread and takes the latest intro", () => {
    const hold = derivePresentHold([text(800, { staggerSpreadMs: 600 }), text(900)], 5000);
    expect(hold.holdMs).toBe(1400 + HOLD_MARGIN_MS);
  });

  it("lets an authored outAt win over the duration runway", () => {
    const hold = derivePresentHold([text(1200, { outAtMs: 2500 })], 6000);
    expect(hold.outStartMs).toBe(2500);
    expect(hold.holdMs).toBe(1200 + HOLD_MARGIN_MS);
  });

  it("takes the earliest of several authored outAts", () => {
    const hold = derivePresentHold(
      [text(500, { outAtMs: 4000 }), text(700, { outAtMs: 3200 })],
      6000,
    );
    expect(hold.outStartMs).toBe(3200);
  });

  it("never holds past outStart minus the gap", () => {
    const hold = derivePresentHold([text(2900, { outAtMs: 2950 })], 3000);
    expect(hold.outStartMs).toBe(2950);
    expect(hold.holdMs).toBe(2950 - MIN_HOLD_GAP_MS);
  });

  it("clamps both points into the scene duration", () => {
    const hold = derivePresentHold([], 300);
    expect(hold.outStartMs).toBe(300);
    expect(hold.holdMs).toBe(200);
  });

  it("ignores non-finite outAt values", () => {
    const hold = derivePresentHold([text(1000, { outAtMs: Number.NaN })], 4000);
    expect(hold.outStartMs).toBe(4000 - DEFAULT_OUT_RUNWAY_MS);
  });
});
