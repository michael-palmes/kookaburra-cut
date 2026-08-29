import { afterEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../theme/tokens";
import {
  DEFAULT_LOOK_ANGLE_DEG,
  DEFAULT_LOOK_CURVE_DEG,
  DEFAULT_LOOK_HOLLOW,
  DEFAULT_LOOK_INTENSITY,
  DEFAULT_LOOK_OFFSET_EM,
  DEFAULT_LOOK_STROKE_EM,
  isTextLookName,
  lookIs3d,
  lookNeedsShaderPath,
  resolveTextLook,
  resolveTextLookWithDoc,
  TEXT_LOOK_NAMES,
  type TextLookName,
} from "./looks";

const baseTheme: Theme = {
  id: "test",
  name: "Test",
  colors: { background: "#000", text: "#fff", accent: "#08f", muted: "#888" },
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
    scale: 1.25,
  },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outQuad", emphasized: "outExpo" },
  },
};

const themed: Theme = {
  ...baseTheme,
  textLook: { preset: "gradient", colorA: "#ff0055", angleDeg: 45 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveTextLook", () => {
  it("returns null when neither props nor theme configure anything (the legacy contract)", () => {
    expect(resolveTextLook({}, baseTheme)).toBeNull();
  });

  it("adopts the theme's textLook and fully defaults every param (the spec's numbers)", () => {
    const look = resolveTextLook({}, themed);
    expect(look).toEqual({
      preset: "gradient",
      colorA: "#ff0055",
      angleDeg: 45,
      strokeEm: DEFAULT_LOOK_STROKE_EM,
      hollow: DEFAULT_LOOK_HOLLOW,
      intensity: DEFAULT_LOOK_INTENSITY,
      offsetEm: DEFAULT_LOOK_OFFSET_EM,
      curveDeg: DEFAULT_LOOK_CURVE_DEG,
    });
  });

  it("pins the spec's default numbers", () => {
    expect(DEFAULT_LOOK_ANGLE_DEG).toBe(90);
    expect(DEFAULT_LOOK_STROKE_EM).toBe(0.035);
    expect(DEFAULT_LOOK_INTENSITY).toBe(0.6);
    expect(DEFAULT_LOOK_OFFSET_EM).toBe(0.06);
    expect(DEFAULT_LOOK_CURVE_DEG).toBe(60);
    expect(DEFAULT_LOOK_HOLLOW).toBe(true);
    const look = resolveTextLook({ look: "outline" }, baseTheme);
    expect(look).toEqual({
      preset: "outline",
      angleDeg: 90,
      strokeEm: 0.035,
      hollow: true,
      intensity: 0.6,
      offsetEm: 0.06,
      curveDeg: 60,
    });
  });

  it("keeps colours OPTIONAL so the renderer can fall back to the theme accent", () => {
    const look = resolveTextLook({ look: "neon" }, baseTheme);
    expect(look?.colorA).toBeUndefined();
    expect(look?.colorB).toBeUndefined();
    expect(look && "colorA" in look).toBe(false);
  });

  it("lets props override the theme spec, field by field", () => {
    const look = resolveTextLook(
      { look: "outline", colorA: "#00ff00", strokeEm: 0.05, hollow: true },
      themed,
    );
    expect(look).toMatchObject({
      preset: "outline",
      colorA: "#00ff00",
      strokeEm: 0.05,
      hollow: true,
    });
    // Untouched prop fields still read the theme spec.
    expect(look?.angleDeg).toBe(45);
  });

  it("treats the doc spec as a WHOLE replacement of the theme spec (no field merging)", () => {
    const look = resolveTextLook({}, themed, { preset: "arc", curveDeg: 90 });
    expect(look).toMatchObject({ preset: "arc", curveDeg: 90 });
    // The theme's colorA/angleDeg do NOT bleed through the doc spec.
    expect(look?.colorA).toBeUndefined();
    expect(look?.angleDeg).toBe(DEFAULT_LOOK_ANGLE_DEG);
  });

  it("resolves from props alone (a scene with no theme or doc look)", () => {
    const look = resolveTextLook({ look: "frosted", intensity: 0.9 }, baseTheme);
    expect(look).toMatchObject({ preset: "frosted", intensity: 0.9 });
  });

  it("coerces unknown preset names to none, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTextLook({ look: "sparkle" }, baseTheme)?.preset).toBe("none");
    expect(resolveTextLook({ look: "sparkle" }, baseTheme)?.preset).toBe("none");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clamps params to the pinned bounds, warning once per value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const look = resolveTextLook(
      { look: "gradient", intensity: 2, strokeEm: -1, angleDeg: 721, offsetEm: 3, curveDeg: -900 },
      baseTheme,
    );
    expect(look).toMatchObject({
      intensity: 1,
      strokeEm: 0,
      angleDeg: 360,
      offsetEm: 0.5,
      curveDeg: -360,
    });
    expect(warn).toHaveBeenCalledTimes(5);
    resolveTextLook({ look: "gradient", intensity: 2 }, baseTheme);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("accepts in-range params unclamped and without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const look = resolveTextLook(
      { look: "arc", angleDeg: -180, strokeEm: 0.2, intensity: 0, offsetEm: -0.5, curveDeg: 360 },
      baseTheme,
    );
    expect(look).toMatchObject({
      angleDeg: -180,
      strokeEm: 0.2,
      intensity: 0,
      offsetEm: -0.5,
      curveDeg: 360,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("resolveTextLookWithDoc", () => {
  const doc = {
    textLook: { preset: "neon", intensity: 0.8 },
    textLookOverrides: { "title-1": { preset: "outline", hollow: true } },
  };

  it("precedence: prop > doc override > doc > theme", () => {
    // Prop wins over everything.
    expect(resolveTextLookWithDoc({ look: "frosted" }, themed, doc, "title-1")?.preset).toBe(
      "frosted",
    );
    // The keyed override wins over the doc's scene-wide spec.
    expect(resolveTextLookWithDoc({}, themed, doc, "title-1")).toMatchObject({
      preset: "outline",
      hollow: true,
    });
    // An unkeyed item falls to the doc's scene-wide spec.
    expect(resolveTextLookWithDoc({}, themed, doc, "other")).toMatchObject({
      preset: "neon",
      intensity: 0.8,
    });
    expect(resolveTextLookWithDoc({}, themed, doc)).toMatchObject({ preset: "neon" });
    // No doc at all falls to the theme.
    expect(resolveTextLookWithDoc({}, themed, null)?.preset).toBe("gradient");
  });

  it("textLookForce ignores the primitive's own look props", () => {
    const forced = { ...doc, textLookForce: true };
    expect(
      resolveTextLookWithDoc({ look: "frosted", intensity: 0.1 }, themed, forced, "title-1"),
    ).toMatchObject({ preset: "outline", hollow: true });
    expect(resolveTextLookWithDoc({ look: "frosted" }, themed, forced)?.preset).toBe("neon");
    // Forcing with no spec anywhere still resolves the theme, and null with nothing at all.
    expect(
      resolveTextLookWithDoc({ look: "frosted" }, themed, { textLookForce: true })?.preset,
    ).toBe("gradient");
    expect(resolveTextLookWithDoc({ look: "frosted" }, baseTheme, { textLookForce: true })).toBe(
      null,
    );
  });

  it("returns null when nothing is configured (the legacy contract)", () => {
    expect(resolveTextLookWithDoc({}, baseTheme, null)).toBeNull();
    expect(resolveTextLookWithDoc({}, baseTheme, {}, "title-1")).toBeNull();
  });
});

describe("look routing", () => {
  it("names the 9 looks plus none, and isTextLookName agrees", () => {
    expect(TEXT_LOOK_NAMES).toEqual([
      "none",
      "gradient",
      "outline",
      "neon",
      "offset-print",
      "highlight-block",
      "frosted",
      "arc",
      "glass-3d",
      "chrome-3d",
    ]);
    for (const name of TEXT_LOOK_NAMES) expect(isTextLookName(name)).toBe(true);
    expect(isTextLookName("sparkle")).toBe(false);
  });

  it("routes the SDF shader looks and leaves outline/neon on plain troika props", () => {
    const shader: TextLookName[] = [
      "gradient",
      "offset-print",
      "highlight-block",
      "frosted",
      "arc",
    ];
    for (const name of shader) expect(lookNeedsShaderPath(name)).toBe(true);
    const plain: TextLookName[] = ["none", "outline", "neon", "glass-3d", "chrome-3d"];
    for (const name of plain) expect(lookNeedsShaderPath(name)).toBe(false);
  });

  it("routes only the extruded looks to 3D", () => {
    expect(lookIs3d("glass-3d")).toBe(true);
    expect(lookIs3d("chrome-3d")).toBe(true);
    for (const name of TEXT_LOOK_NAMES) {
      if (name !== "glass-3d" && name !== "chrome-3d") expect(lookIs3d(name)).toBe(false);
    }
  });
});
