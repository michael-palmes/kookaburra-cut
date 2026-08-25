import { describe, expect, it } from "vitest";
import {
  arcGlyphTransform,
  arcSpec,
  darkenHex,
  FROSTED_SOFT_EM,
  FROSTED_WEIGHT_EM,
  frostedDeltas,
  GRADIENT_B_DARKEN,
  gradientSpan,
  gradientStops,
  lightenHex,
  lookColorA,
  NEON_BLUR_EM,
  NEON_CORE_LIFT,
  NEON_HALO_OPACITY,
  neonCoreFill,
  neonHalo,
  outlineStroke,
} from "./lookStyle";
import type { ResolvedTextLook } from "./looks";

const look = (over: Partial<ResolvedTextLook> = {}): ResolvedTextLook => ({
  preset: "gradient",
  angleDeg: 90,
  strokeEm: 0.035,
  hollow: false,
  intensity: 0.6,
  offsetEm: 0.06,
  curveDeg: 60,
  ...over,
});

describe("look colours", () => {
  it("colorA falls back to the theme accent", () => {
    expect(lookColorA(look(), "#0088ff")).toBe("#0088ff");
    expect(lookColorA(look({ colorA: "#ff0055" }), "#0088ff")).toBe("#ff0055");
  });

  it("darkenHex scales sRGB channels and passes non-hex through", () => {
    expect(darkenHex("#8800ff", 0.5)).toBe("#440080");
    expect(darkenHex("#fff", 0.5)).toBe("#808080");
    expect(darkenHex("red", 0.5)).toBe("red");
  });

  it("lightenHex lerps toward white", () => {
    expect(lightenHex("#000000", 0.5)).toBe("#808080");
    expect(lightenHex("#ffffff", 0.3)).toBe("#ffffff");
    expect(lightenHex("papayawhip", 0.3)).toBe("papayawhip");
  });

  it("gradientStops: explicit stops win, colorB derives as a darkened colorA, accent seeds both", () => {
    expect(gradientStops(look({ colorA: "#204060", colorB: "#010203" }), "#fff")).toEqual({
      a: "#204060",
      b: "#010203",
    });
    const derived = gradientStops(look({ colorA: "#8800ff" }), "#fff");
    expect(derived.a).toBe("#8800ff");
    expect(derived.b).toBe(darkenHex("#8800ff", GRADIENT_B_DARKEN));
    const fromAccent = gradientStops(look(), "#0088ff");
    expect(fromAccent.a).toBe("#0088ff");
    expect(fromAccent.b).toBe(darkenHex("#0088ff", GRADIENT_B_DARKEN));
  });
});

describe("gradientSpan", () => {
  const bounds: [number, number, number, number] = [-1, -0.5, 3, 0.5];

  it("returns null until measured or when degenerate", () => {
    expect(gradientSpan(null, 90)).toBeNull();
    expect(gradientSpan([0, 0, 0, 0], 90)).toBeNull();
  });

  it("angle 90 projects vertically with colorA (t = 0) at the top edge", () => {
    const span = gradientSpan(bounds, 90);
    expect(span).not.toBeNull();
    if (!span) return;
    expect(span.ax).toBeCloseTo(0, 10);
    expect(span.ay).toBeCloseTo(1, 10);
    expect(span.sHi).toBeCloseTo(0.5);
    expect(span.invRange).toBeCloseTo(1);
    // A point at the top edge lands t = 0 (colorA), the bottom edge t = 1.
    expect((span.sHi - (0 * span.ax + 0.5 * span.ay)) * span.invRange).toBeCloseTo(0);
    expect((span.sHi - (0 * span.ax + -0.5 * span.ay)) * span.invRange).toBeCloseTo(1);
  });

  it("angle 0 projects horizontally with colorA at the right edge", () => {
    const span = gradientSpan(bounds, 0);
    if (!span) throw new Error("span");
    expect(span.ax).toBeCloseTo(1);
    expect(span.ay).toBeCloseTo(0);
    expect(span.sHi).toBeCloseTo(3);
    expect(span.invRange).toBeCloseTo(1 / 4);
  });
});

describe("arc maths", () => {
  const bounds: [number, number, number, number] = [-2, -0.35, 2, 0.35];

  it("arcSpec is null (the identity) when unmeasured, flat or zero curve", () => {
    expect(arcSpec(null, 60)).toBeNull();
    expect(arcSpec(bounds, 0)).toBeNull();
    expect(arcSpec([1, 0, 1, 1], 60)).toBeNull();
  });

  it("radius comes from width / curveRad and the bend spans the full curve across the width", () => {
    const spec = arcSpec(bounds, 60);
    if (!spec) throw new Error("spec");
    expect(spec.centerX).toBeCloseTo(0);
    expect(spec.invRadius).toBeCloseTo(Math.PI / 3 / 4);
    // Ends rotate by half the total curve each.
    expect(arcGlyphTransform(2, spec).rotRad).toBeCloseTo(Math.PI / 6);
    expect(arcGlyphTransform(-2, spec).rotRad).toBeCloseTo(-Math.PI / 6);
  });

  it("the block centre is the fixed point and positive curve lifts the ends (smile)", () => {
    const spec = arcSpec(bounds, 60);
    if (!spec) throw new Error("spec");
    expect(arcGlyphTransform(0, spec)).toEqual({ dx: 0, dy: 0, rotRad: 0 });
    const right = arcGlyphTransform(2, spec);
    const left = arcGlyphTransform(-2, spec);
    expect(right.dy).toBeGreaterThan(0);
    expect(left.dy).toBeCloseTo(right.dy);
    expect(left.dx).toBeCloseTo(-right.dx);
    // The chord is shorter than the arc, so ends pull inward.
    expect(right.dx).toBeLessThan(0);
  });

  it("negative curve mirrors downward (frown)", () => {
    const spec = arcSpec(bounds, -60);
    if (!spec) throw new Error("spec");
    const right = arcGlyphTransform(2, spec);
    expect(right.dy).toBeLessThan(0);
    expect(right.rotRad).toBeCloseTo(-Math.PI / 6);
  });

  it("matches the small-angle limit dy ≈ s²/(2R)", () => {
    const spec = arcSpec(bounds, 10);
    if (!spec) throw new Error("spec");
    const t = arcGlyphTransform(1, spec);
    expect(t.dy).toBeCloseTo(spec.invRadius / 2, 4);
  });
});

describe("troika prop pricing", () => {
  it("outlineStroke scales the em width by fontSize and takes colorA (else accent)", () => {
    expect(outlineStroke(look({ preset: "outline" }), "#0088ff", 0.6)).toEqual({
      strokeWidth: 0.035 * 0.6,
      strokeColor: "#0088ff",
    });
    expect(
      outlineStroke(look({ preset: "outline", colorA: "#123456", strokeEm: 0.1 }), "#0088ff", 0.5)
        .strokeWidth,
    ).toBeCloseTo(0.05);
  });

  it("neonHalo scales blur and opacity by intensity; the core lifts toward white", () => {
    const halo = neonHalo(look({ preset: "neon", intensity: 0.5 }), "#0088ff", 0.6);
    expect(halo.outlineBlur).toBeCloseTo(NEON_BLUR_EM * 0.5 * 0.6);
    expect(halo.outlineColor).toBe("#0088ff");
    expect(halo.outlineOpacity).toBeCloseTo(NEON_HALO_OPACITY * 0.5);
    expect(neonCoreFill("#000000", 1)).toBe(lightenHex("#000000", NEON_CORE_LIFT));
    expect(neonCoreFill("#808080", 0)).toBe("#808080");
  });

  it("frostedDeltas scales by intensity and is exactly zero at 0 (the neutral guard)", () => {
    expect(frostedDeltas(0)).toEqual({ softEm: 0, weightEm: 0 });
    expect(frostedDeltas(1)).toEqual({ softEm: FROSTED_SOFT_EM, weightEm: FROSTED_WEIGHT_EM });
    expect(frostedDeltas(0.5).softEm).toBeCloseTo(FROSTED_SOFT_EM / 2);
  });
});
