import { describe, expect, it } from "vitest";
import { parseTextLookSpec } from "../theme/schema";
import {
  DEFAULT_LOOK_ANGLE_DEG,
  DEFAULT_LOOK_INTENSITY,
  DEFAULT_LOOK_STROKE_EM,
  TEXT_LOOK_NAMES,
} from "../toolkit/text/looks";
import {
  darkenedStopB,
  defaultLookDraft,
  describeLookSpec,
  lookDraftToSpec,
  lookSpecToDraft,
  TEXT_LOOK_CATALOG,
} from "./textLookOptions";

describe("TEXT_LOOK_CATALOG (the vocabulary pin)", () => {
  it("covers TEXT_LOOK_NAMES exactly, in order", () => {
    expect(TEXT_LOOK_CATALOG.map((meta) => meta.preset)).toEqual([...TEXT_LOOK_NAMES]);
  });

  it("pins the param capabilities", () => {
    const byName = Object.fromEntries(TEXT_LOOK_CATALOG.map((meta) => [meta.preset, meta]));
    expect(byName.gradient).toMatchObject({ hasColorA: true, hasColorB: true, hasAngle: true });
    expect(byName.outline).toMatchObject({ hasColorA: true, hasStroke: true, hasHollow: true });
    expect(byName.neon).toMatchObject({ hasColorA: true, hasIntensity: true });
    expect(byName["offset-print"]).toMatchObject({ hasColorA: true, hasOffset: true });
    expect(byName["highlight-block"]).toMatchObject({ hasColorA: true });
    expect(byName.frosted).toMatchObject({ hasIntensity: true });
    expect(byName.arc).toMatchObject({ hasCurve: true });
    // glass tints via colorA with a clear-white default (an accent default would dye every glass headline).
    expect(byName["glass-3d"]).toMatchObject({
      hasColorA: true,
      hasIntensity: true,
      colorALabel: "Tint",
      colorADefault: "#ffffff",
    });
    expect(byName["chrome-3d"]).toMatchObject({ hasColorA: true });
    expect(byName.none.hasColorA).toBeUndefined();
  });

  it("labels the UI vocabulary", () => {
    const labels = Object.fromEntries(TEXT_LOOK_CATALOG.map((meta) => [meta.preset, meta.label]));
    expect(labels).toEqual({
      none: "None",
      gradient: "Gradient",
      outline: "Outline",
      neon: "Neon",
      "offset-print": "Offset print",
      "highlight-block": "Highlight block",
      frosted: "Frosted glass",
      arc: "Arc",
      "glass-3d": "Glass (3D)",
      "chrome-3d": "Chrome (3D)",
    });
  });
});

describe("lookDraftToSpec (the written sidecar shapes)", () => {
  it("every preset's default draft round-trips the shared parser IDENTICALLY", () => {
    for (const meta of TEXT_LOOK_CATALOG) {
      const spec = lookDraftToSpec(defaultLookDraft(meta.preset));
      expect(parseTextLookSpec(spec, "pin")).toEqual(spec);
    }
  });

  it("an untouched draft writes the bare preset", () => {
    expect(lookDraftToSpec(defaultLookDraft("gradient"))).toEqual({ preset: "gradient" });
    expect(lookDraftToSpec(defaultLookDraft("none"))).toEqual({ preset: "none" });
  });

  it("writes only the fields the preset uses, away from their defaults", () => {
    const spec = lookDraftToSpec({
      ...defaultLookDraft("gradient"),
      colorA: "#ff0055",
      colorB: "#220011",
      angleDeg: 45,
      strokeEm: 0.08,
      hollow: true,
      intensity: 0.9,
    });
    expect(spec).toEqual({
      preset: "gradient",
      colorA: "#ff0055",
      colorB: "#220011",
      angleDeg: 45,
    });
    expect(parseTextLookSpec(spec, "pin")).toEqual(spec);
  });

  it("outline carries stroke and hollow, and hollow only away from its hollow-by-default", () => {
    const outline = lookDraftToSpec({
      ...defaultLookDraft("outline"),
      colorA: "#ffffff",
      strokeEm: 0.05,
      hollow: false,
    });
    expect(outline).toEqual({
      preset: "outline",
      colorA: "#ffffff",
      strokeEm: 0.05,
      hollow: false,
    });
    expect(
      lookDraftToSpec({ ...defaultLookDraft("outline"), hollow: true }).hollow,
    ).toBeUndefined();
    expect(parseTextLookSpec(outline, "pin")).toEqual(outline);
  });

  it("arc writes only its bend", () => {
    const arc = lookDraftToSpec({ ...defaultLookDraft("arc"), curveDeg: -80, colorA: "#123456" });
    expect(arc).toEqual({ preset: "arc", curveDeg: -80 });
    expect(parseTextLookSpec(arc, "pin")).toEqual(arc);
  });
});

describe("lookSpecToDraft", () => {
  it("round-trips every param through the draft", () => {
    const spec = {
      preset: "outline",
      colorA: "#abcdef",
      strokeEm: 0.06,
      hollow: false,
    };
    expect(lookDraftToSpec(lookSpecToDraft(spec))).toEqual(spec);
  });

  it("seeds defaults for absent params", () => {
    const draft = lookSpecToDraft({ preset: "neon" });
    expect(draft.intensity).toBe(DEFAULT_LOOK_INTENSITY);
    expect(draft.angleDeg).toBe(DEFAULT_LOOK_ANGLE_DEG);
    expect(draft.strokeEm).toBe(DEFAULT_LOOK_STROKE_EM);
    expect(draft.colorA).toBeNull();
    // Outline is hollow by default; the draft starts there so an untouched toggle writes nothing.
    expect(draft.hollow).toBe(true);
  });

  it("coerces unknown preset names to none, like the resolver", () => {
    expect(lookSpecToDraft({ preset: "sparkle" }).preset).toBe("none");
  });
});

describe("describeLookSpec", () => {
  it("names the theme chip", () => {
    expect(describeLookSpec(undefined)).toBe("No style preset");
    expect(describeLookSpec({ preset: "none" })).toBe("No style preset");
    expect(describeLookSpec({ preset: "offset-print" })).toBe("Offset print");
    expect(describeLookSpec({ preset: "mystery" })).toBe("mystery");
  });
});

describe("darkenedStopB (display-only)", () => {
  it("darkens a hex deterministically", () => {
    expect(darkenedStopB("#ff8800")).toBe("#9e5400");
    expect(darkenedStopB("#fff")).toBe("#9e9e9e");
  });

  it("passes malformed values through untouched", () => {
    expect(darkenedStopB("accent")).toBe("accent");
    expect(darkenedStopB("#12")).toBe("#12");
  });
});
