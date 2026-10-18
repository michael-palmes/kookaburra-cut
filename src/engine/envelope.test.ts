import { describe, expect, it } from "vitest";
import { ease } from "./ease";
import { envelopeAt, envelopeLengthMs } from "./envelope";

describe("envelopeAt", () => {
  const spec = { attackMs: 100, holdMs: 50, releaseMs: 200 };

  it("is exactly 0 outside the envelope", () => {
    expect(envelopeAt(-1, spec)).toBe(0);
    expect(envelopeAt(Number.NaN, spec)).toBe(0);
    expect(envelopeAt(350, spec)).toBe(0);
    expect(envelopeAt(10_000, spec)).toBe(0);
  });

  it("rises, holds and falls on the ease", () => {
    expect(envelopeAt(0, spec)).toBe(0);
    expect(envelopeAt(50, spec)).toBe(ease("outQuad", 0.5));
    expect(envelopeAt(100, spec)).toBe(1);
    expect(envelopeAt(149, spec)).toBe(1);
    expect(envelopeAt(250, spec)).toBe(1 - ease("outQuad", 0.5));
  });

  it("snaps to 1 with no attack", () => {
    const snap = { releaseMs: 300 };
    expect(envelopeAt(0, snap)).toBe(1);
    expect(envelopeAt(150, snap)).toBe(1 - ease("outQuad", 0.5));
    expect(envelopeAt(300, snap)).toBe(0);
  });

  it("takes a named or functional ease", () => {
    expect(envelopeAt(50, { ...spec, ease: "linear" })).toBe(0.5);
    expect(envelopeAt(50, { ...spec, ease: (t) => t * t })).toBe(0.25);
  });

  it("measures its length", () => {
    expect(envelopeLengthMs(spec)).toBe(350);
    expect(envelopeLengthMs({ releaseMs: 120, attackMs: -5 })).toBe(120);
  });
});
