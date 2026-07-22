import { beforeEach, describe, expect, it, vi } from "vitest";
import kookaburraAbyssDoc from "./builtin/kookaburra-abyss.json";
import kookaburraDefaultDoc from "./builtin/kookaburra-default.json";
import kookaburraEmberDoc from "./builtin/kookaburra-ember.json";
import kookaburraFxDoc from "./builtin/kookaburra-fx.json";
import kookaburraGalleryDoc from "./builtin/kookaburra-gallery.json";
import kookaburraLoftDoc from "./builtin/kookaburra-loft.json";
import kookaburraMidnightDoc from "./builtin/kookaburra-midnight.json";
import kookaburraNeonDoc from "./builtin/kookaburra-neon.json";
import kookaburraPacificDoc from "./builtin/kookaburra-pacific.json";
import kookaburraPaperDoc from "./builtin/kookaburra-paper.json";
import kookaburraStudioWhiteDoc from "./builtin/kookaburra-studio-white.json";
import kookaburraSunriseDoc from "./builtin/kookaburra-sunrise.json";
import {
  mergeLighting,
  parseBackdropSpec,
  parseBackgroundSpec,
  parseLightingOverride,
  parseThemeDoc,
  THEME_DOC_VERSION,
} from "./schema";

/** The builtin docs are STRUCTURE-PINNED here (the gate-sidecar lesson): parseThemeDoc degrades malformed documents by design, so a silent parse-degrade of a bundled theme must fail unit tests, not turn a gate project into a differently-themed no-op. */

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** A minimal valid v2 document; the base for the degrade cases. */
function validDoc(): Record<string, unknown> {
  return {
    version: 2,
    id: "test-theme",
    name: "Test Theme",
    colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#888888" },
    typography: { headline: "Inter", body: "Inter", scale: 1.25 },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
  };
}

describe("builtin theme documents (structure pins)", () => {
  it("kookaburra-default parses with NO v8 blocks (the legacy-path guarantee)", () => {
    const theme = parseThemeDoc(kookaburraDefaultDoc, "pin");
    expect(theme).toBeDefined();
    expect(theme?.id).toBe("kookaburra-default");
    expect(theme?.name).toBe("Kookaburra Cut Default");
    expect(theme?.mode).toBe("dark");
    expect(theme?.colors).toEqual({
      background: "#0b0f14",
      text: "#f5f7fa",
      accent: "#3ad1c4",
      muted: "#8a97a6",
    });
    expect(theme?.typography).toEqual({
      headline: { family: "Inter", weight: 400 },
      body: { family: "Inter", weight: 400 },
      scale: 1.25,
    });
    expect(theme?.motion.durations).toEqual({ fast: 200, base: 500, slow: 900 });
    expect(theme?.motion.easings).toEqual({ standard: "outQuad", emphasized: "outExpo" });
    // Absent v8 blocks are what keep every pre-v8 project on its byte-identical path.
    expect(theme?.lighting).toBeUndefined();
    expect(theme?.environment).toBeUndefined();
    expect(theme?.backdrop).toBeUndefined();
    expect(theme?.textAnimation).toBeUndefined();
    expect(theme?.effects).toBeUndefined();
    expect(theme?.gradients?.brand).toEqual({
      type: "linear",
      angleDeg: 135,
      stops: [
        ["#0b0f14", 0],
        ["#16323a", 1],
      ],
    });
  });

  it("kookaburra-fx parses with the exact v3 effect stack and NO other v8 blocks", () => {
    const theme = parseThemeDoc(kookaburraFxDoc, "pin");
    expect(theme).toBeDefined();
    expect(theme?.id).toBe("kookaburra-fx");
    // Token parity with the default theme (fxTheme was `{...defaultTheme, effects}`).
    const base = parseThemeDoc(kookaburraDefaultDoc, "pin");
    expect(theme?.colors).toEqual(base?.colors);
    expect(theme?.typography).toEqual(base?.typography);
    expect(theme?.motion).toEqual(base?.motion);
    expect(theme?.effects).toEqual({
      bloom: { intensity: 1.1, luminanceThreshold: 0.55, luminanceSmoothing: 0.2 },
      vignette: { offset: 0.3, darkness: 0.55 },
    });
    expect(theme?.lighting).toBeUndefined();
    expect(theme?.environment).toBeUndefined();
    expect(theme?.backdrop).toBeUndefined();
  });

  it("kookaburra-midnight parses WITH its lighting + environment blocks (themed-scene gate)", () => {
    const theme = parseThemeDoc(kookaburraMidnightDoc, "pin");
    expect(theme?.id).toBe("kookaburra-midnight");
    expect(theme?.mode).toBe("dark");
    // The lineup evolution: teal accent (the kookaburra-default lineage) and the second (rim) fill that lifts black-titanium devices out of the background.
    expect(theme?.colors.accent).toBe("#3ad1c4");
    // The bundled-font gate: a parse-degrade back to Inter would render the spike's headlines in the wrong face while still verifying byte-identical.
    expect(theme?.typography.headline).toEqual({ family: "Space Grotesk", weight: 600 });
    expect(theme?.lighting?.key).toEqual({
      azimuthDeg: -30,
      elevationDeg: 42,
      intensity: 1.9,
      color: "#dbe4ff",
    });
    expect(theme?.lighting?.fills).toHaveLength(2);
    expect(theme?.lighting?.ambient).toBe(0.4);
    expect(theme?.environment).toEqual({
      source: "kookaburra:ferndale-studio",
      intensity: 0.7,
      rotationDeg: 0,
    });
    // The theme visual pass: fade-scale + shine over the new glow background.
    expect(theme?.textAnimation).toEqual({
      in: "fade-scale",
      out: "fade",
      staggerMs: 0,
      startScale: 0.9,
      shine: true,
    });
    expect(theme?.background).toEqual({ type: "gradient", gradient: "glow", parallax: 0.04 });
    expect(theme?.backdrop).toBeUndefined();
    expect(theme?.effects).toBeUndefined();
  });

  it("kookaburra-studio-white parses WITH lighting + environment + floor staging (themed-scene gate)", () => {
    const theme = parseThemeDoc(kookaburraStudioWhiteDoc, "pin");
    expect(theme?.id).toBe("kookaburra-studio-white");
    expect(theme?.mode).toBe("light");
    expect(theme?.colors.background).toBe("#f4f6f8");
    // The lineup evolution: the SemiBold headline face.
    expect(theme?.typography.headline).toEqual({ family: "Inter", weight: 600 });
    expect(theme?.lighting?.key.intensity).toBe(2.0);
    expect(theme?.lighting?.ambient).toBe(0.85);
    expect(theme?.environment?.source).toBe("kookaburra:monochrome-studio");
    // The white cyc floor with REAL map shadows: a parse-degrade here would silently turn the gate's floor scene back into a flat background.
    expect(theme?.backdrop).toEqual({ type: "floor", color: "#ffffff", filletRadius: 2.5 });
    expect(theme?.lighting?.shadow).toEqual({
      technique: "map",
      softness: 0.6,
      opacity: 0.28,
      mapSize: 2048,
      bias: -0.0005,
      color: "#20242c",
    });
    // The theme visual pass: a soft fade-scale over the brand-wash background.
    expect(theme?.textAnimation).toEqual({
      in: "fade-scale",
      out: "fade",
      staggerMs: 0,
      startScale: 0.94,
    });
    expect(theme?.background).toEqual({ type: "gradient", gradient: "brand", parallax: 0.03 });
    expect(theme?.effects).toBeUndefined();
  });

  it("parses shader backgrounds schema-light: clamps speed/scale, drops non-string colours and non-numeric params", () => {
    const spec = parseBackgroundSpec(
      {
        type: "shader",
        shader: "mesh-gradient",
        colors: ["#ff0000", 3, "#00ff00"],
        speed: 9,
        scale: 0.01,
        params: { softness: 0.5, bad: "x" },
      },
      "test",
    );
    expect(spec).toEqual({
      type: "shader",
      shader: "mesh-gradient",
      colors: ["#ff0000", "#00ff00"],
      speed: 4,
      scale: 0.1,
      params: { softness: 0.5 },
    });
    expect(parseBackgroundSpec({ type: "shader" }, "test")).toBeUndefined();
  });

  it("preserves an optional preset id on shader backgrounds; legacy docs are unaffected", () => {
    expect(
      parseBackgroundSpec({ type: "shader", shader: "mesh-gradient", preset: "p3" }, "test"),
    ).toEqual({ type: "shader", shader: "mesh-gradient", preset: "p3" });
    expect(
      parseBackgroundSpec({ type: "shader", shader: "mesh-gradient", preset: 3 }, "test"),
    ).toEqual({ type: "shader", shader: "mesh-gradient" });
    expect(
      parseBackgroundSpec({ type: "shader", shader: "mesh-gradient", speed: 1 }, "test"),
    ).toEqual({ type: "shader", shader: "mesh-gradient", speed: 1 });
  });

  it("parses gradient backdrops with an inline spec, which wins over the name", () => {
    const spec = {
      type: "linear",
      angleDeg: 45,
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    };
    const inline = parseBackdropSpec({ type: "gradient", spec }, "test");
    expect(inline).toEqual({ type: "gradient", spec });
    const both = parseBackdropSpec({ type: "gradient", gradient: "brand", spec }, "test");
    expect(both).toEqual({ type: "gradient", gradient: "brand", spec });
    const nameOnly = parseBackdropSpec({ type: "gradient", gradient: "brand" }, "test");
    expect(nameOnly).toEqual({ type: "gradient", gradient: "brand" });
    expect(parseBackdropSpec({ type: "gradient" }, "test")).toBeUndefined();
  });

  // Every new bundled doc must parse with its signature blocks intact: a silently-degraded builtin (dropped backdrop, wrong face, lost effects) renders and verifies byte-identical while looking wrong, so the pins live here, not in gates.
  const LINEUP_PINS: {
    id: string;
    doc: unknown;
    mode: "light" | "dark";
    headline: { family: string; weight: number };
    backdrop: string | undefined;
    environment: string;
    animIn: string;
  }[] = [
    {
      id: "kookaburra-pacific",
      doc: kookaburraPacificDoc,
      mode: "light",
      headline: { family: "Inter", weight: 600 },
      backdrop: "gradient",
      environment: "kookaburra:softbox",
      animIn: "fade-scale",
    },
    {
      id: "kookaburra-paper",
      doc: kookaburraPaperDoc,
      mode: "light",
      headline: { family: "Playfair Display", weight: 600 },
      backdrop: "floor",
      environment: "kookaburra:story-studio",
      animIn: "mask-reveal",
    },
    {
      id: "kookaburra-gallery",
      doc: kookaburraGalleryDoc,
      mode: "light",
      headline: { family: "Space Grotesk", weight: 400 },
      backdrop: "gradient",
      environment: "kookaburra:monochrome-studio",
      animIn: "fade",
    },
    {
      id: "kookaburra-sunrise",
      doc: kookaburraSunriseDoc,
      mode: "light",
      headline: { family: "Open Sans", weight: 600 },
      backdrop: "gradient",
      environment: "kookaburra:softbox",
      animIn: "fade-scale",
    },
    {
      id: "kookaburra-loft",
      doc: kookaburraLoftDoc,
      mode: "light",
      headline: { family: "Space Grotesk", weight: 600 },
      backdrop: "image",
      environment: "kookaburra:ferndale-studio",
      animIn: "twist-scale",
    },
    {
      id: "kookaburra-neon",
      doc: kookaburraNeonDoc,
      mode: "dark",
      headline: { family: "JetBrains Mono", weight: 400 },
      backdrop: undefined,
      environment: "kookaburra:monochrome-studio",
      animIn: "scatter-scale",
    },
    {
      id: "kookaburra-abyss",
      doc: kookaburraAbyssDoc,
      mode: "dark",
      headline: { family: "Inter", weight: 600 },
      backdrop: "gradient",
      environment: "kookaburra:monochrome-studio",
      animIn: "blur-in",
    },
    {
      id: "kookaburra-ember",
      doc: kookaburraEmberDoc,
      mode: "dark",
      headline: { family: "Space Grotesk", weight: 600 },
      backdrop: "floor",
      environment: "kookaburra:story-studio",
      animIn: "fade-scale",
    },
  ];

  it.each(LINEUP_PINS)("$id parses with its signature blocks (v8 · M4 lineup pin)", ({
    id,
    doc,
    mode,
    headline,
    backdrop,
    environment,
    animIn,
  }) => {
    const theme = parseThemeDoc(doc, "pin");
    expect(theme).toBeDefined();
    expect(theme?.id).toBe(id);
    expect(theme?.mode).toBe(mode);
    expect(theme?.typography.headline).toEqual(headline);
    expect(theme?.backdrop?.type).toBe(backdrop);
    expect(theme?.environment?.source).toBe(environment);
    expect(theme?.textAnimation?.in).toBe(animIn);
    // Every lineup theme lights its stage (SceneStage would silently stand down without).
    expect(theme?.lighting?.key).toBeDefined();
    // A gradient backdrop must name a gradient that actually exists in the theme (bundled themes never use inline specs).
    if (theme?.backdrop?.type === "gradient") {
      expect(theme.backdrop.gradient).toBeDefined();
      expect(theme?.gradients?.[theme.backdrop.gradient ?? ""]).toBeDefined();
    }
  });

  it("the LINEUP carries fixed backgrounds; default/fx stay clean (v12 · M5 flip)", () => {
    // The null-for-legacy pin flipped DELIBERATELY with the theme visual pass: every lineup theme now stages a camera-locked gradient wash (naming a gradient in its own theme), while legacy-resolved default/fx stay background-free so every non-themed project keeps its bytes.
    expect(parseThemeDoc(kookaburraDefaultDoc, "pin")?.background).toBeUndefined();
    expect(parseThemeDoc(kookaburraFxDoc, "pin")?.background).toBeUndefined();
    const lineup = [
      kookaburraMidnightDoc,
      kookaburraStudioWhiteDoc,
      ...LINEUP_PINS.map((p) => p.doc),
    ];
    for (const doc of lineup) {
      const theme = parseThemeDoc(doc, "pin");
      const bg = theme?.background;
      expect(bg?.type, theme?.id).toBe("gradient");
      if (bg?.type !== "gradient") continue;
      expect(bg.gradient, theme?.id).toBeDefined();
      if (bg.gradient) expect(theme?.gradients?.[bg.gradient], theme?.id).toBeDefined();
      expect(bg.parallax, theme?.id).toBeGreaterThan(0);
    }
  });

  it("THEMES drop video backgrounds — scene-doc only (v12 · M4, decision 5)", () => {
    // Themes are workspace-shared and cannot reference project assets; a theme JSON authored with a video fill degrades to "no background", never a broken reference.
    const doc = {
      ...kookaburraStudioWhiteDoc,
      background: { type: "video", src: "assets/loop.mp4" },
    };
    expect(parseThemeDoc(doc, "pin")?.background).toBeUndefined();
  });

  it("the M5 motion-pack adoption is EXACTLY these themes (v12 · M5 flip)", () => {
    // The null-for-legacy pin flipped DELIBERATELY with the theme visual pass: default/fx stay clean (no textAnimation at all, the legacy path guarantee), while Gallery and Paper deliberately KEEP their v8 signature motion, param-free.
    expect(parseThemeDoc(kookaburraDefaultDoc, "pin")?.textAnimation).toBeUndefined();
    expect(parseThemeDoc(kookaburraFxDoc, "pin")?.textAnimation).toBeUndefined();
    const adopted: Record<string, { in: string; startScale?: number; shine?: boolean }> = {
      "kookaburra-midnight": { in: "fade-scale", startScale: 0.9, shine: true },
      "kookaburra-studio-white": { in: "fade-scale", startScale: 0.94 },
      "kookaburra-pacific": { in: "fade-scale", startScale: 0.94 },
      "kookaburra-sunrise": { in: "fade-scale", startScale: 0.88 },
      "kookaburra-ember": { in: "fade-scale", startScale: 0.9, shine: true },
      "kookaburra-loft": { in: "twist-scale" },
      "kookaburra-neon": { in: "scatter-scale" },
      "kookaburra-abyss": { in: "blur-in" },
    };
    const paramFree = ["kookaburra-gallery", "kookaburra-paper"];
    for (const doc of [
      kookaburraMidnightDoc,
      kookaburraStudioWhiteDoc,
      ...LINEUP_PINS.map((p) => p.doc),
    ]) {
      const theme = parseThemeDoc(doc, "pin");
      const spec = theme?.textAnimation;
      const want = theme ? adopted[theme.id] : undefined;
      if (want) {
        expect(spec?.in, theme?.id).toBe(want.in);
        expect(spec?.startScale, theme?.id).toBe(want.startScale);
        expect(spec?.shine, theme?.id).toBe(want.shine);
      } else {
        expect(paramFree, theme?.id).toContain(theme?.id);
        expect(spec?.startScale, theme?.id).toBeUndefined();
        expect(spec?.shine, theme?.id).toBeUndefined();
      }
      expect(spec?.direction, theme?.id).toBeUndefined();
      expect(spec?.delivery, theme?.id).toBeUndefined();
    }
  });

  it("kookaburra-neon carries the bloom stack; the rest of the lineup has no effects", () => {
    const neon = parseThemeDoc(kookaburraNeonDoc, "pin");
    expect(neon?.effects).toEqual({
      // Threshold moved from 0.7 to 0.85: 0.7 haloed white video screens into unreadability.
      bloom: { intensity: 0.9, luminanceThreshold: 0.85, luminanceSmoothing: 0.3 },
    });
    // Neon's signature motion is the per-character scatter.
    expect(neon?.textAnimation).toEqual({
      in: "scatter-scale",
      out: "fade",
      staggerMs: 0,
    });
    for (const { id, doc } of LINEUP_PINS) {
      if (id === "kookaburra-neon") continue;
      expect(parseThemeDoc(doc, "pin")?.effects, id).toBeUndefined();
    }
  });
});

describe("parseThemeDoc degrade behaviour", () => {
  it("rejects non-objects, bad versions and newer versions", () => {
    expect(parseThemeDoc(null, "t")).toBeUndefined();
    expect(parseThemeDoc("nope", "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), version: undefined }, "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), version: 0 }, "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), version: THEME_DOC_VERSION + 1 }, "t")).toBeUndefined();
  });

  it("rejects documents missing id or a required block", () => {
    expect(parseThemeDoc({ ...validDoc(), id: undefined }, "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), colors: undefined }, "t")).toBeUndefined();
    const badColors = validDoc();
    (badColors.colors as Record<string, unknown>).accent = 42;
    expect(parseThemeDoc(badColors, "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), typography: undefined }, "t")).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), motion: {} }, "t")).toBeUndefined();
  });

  it("card parses a clamped radius fraction and drops invalid shapes", () => {
    expect(parseThemeDoc({ ...validDoc(), card: { radius: 0.08 } }, "t")?.card).toEqual({
      radius: 0.08,
    });
    expect(parseThemeDoc({ ...validDoc(), card: { radius: 0.9 } }, "t")?.card).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), card: { radius: -1 } }, "t")?.card).toBeUndefined();
    expect(parseThemeDoc({ ...validDoc(), card: 0.08 }, "t")?.card).toBeUndefined();
    expect(parseThemeDoc(validDoc(), "t")?.card).toBeUndefined();
  });

  it("name falls back to id; unknown fields are ignored", () => {
    const doc = { ...validDoc(), name: undefined, futureField: { nested: true } };
    const theme = parseThemeDoc(doc, "t");
    expect(theme?.name).toBe("test-theme");
    expect((theme as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("accepts {family, weight} font refs (weights consumed from M3)", () => {
    const doc = validDoc();
    doc.typography = {
      headline: { family: "Space Grotesk", weight: 600 },
      body: "Inter",
      scale: 1.2,
    };
    const theme = parseThemeDoc(doc, "t");
    expect(theme?.typography.headline).toEqual({ family: "Space Grotesk", weight: 600 });
    expect(theme?.typography.body).toEqual({ family: "Inter", weight: 400 });
  });

  it("drops an invalid lighting block but keeps the theme", () => {
    const doc = { ...validDoc(), lighting: { key: { azimuthDeg: "east" }, ambient: 0.5 } };
    const theme = parseThemeDoc(doc, "t");
    expect(theme).toBeDefined();
    expect(theme?.lighting).toBeUndefined();
  });

  it("keeps valid fills, drops invalid ones, and validates shadow tokens", () => {
    const doc = {
      ...validDoc(),
      lighting: {
        key: { azimuthDeg: 35, elevationDeg: 55, intensity: 2.2, color: "#ffffff" },
        fills: [{ azimuthDeg: -120, elevationDeg: 15, intensity: 0.7 }, { azimuthDeg: "bad" }],
        ambient: 0.55,
        shadow: { technique: "map", softness: 0.5, opacity: 0.3, mapSize: 2048, bias: -0.0005 },
      },
    };
    const theme = parseThemeDoc(doc, "t");
    expect(theme?.lighting?.key.intensity).toBe(2.2);
    expect(theme?.lighting?.fills).toHaveLength(1);
    expect(theme?.lighting?.shadow?.mapSize).toBe(2048);

    const badShadow = {
      ...validDoc(),
      lighting: {
        key: { azimuthDeg: 0, elevationDeg: 45, intensity: 1 },
        ambient: 0.5,
        shadow: { technique: "raytrace", softness: 0.5, opacity: 0.3, mapSize: 2048, bias: 0 },
      },
    };
    const parsed = parseThemeDoc(badShadow, "t");
    expect(parsed?.lighting).toBeDefined();
    expect(parsed?.lighting?.shadow).toBeUndefined();
  });

  it("environment defaults intensity/rotation and requires a source", () => {
    const doc = { ...validDoc(), environment: { source: "kookaburra:monochrome-studio" } };
    expect(parseThemeDoc(doc, "t")?.environment).toEqual({
      source: "kookaburra:monochrome-studio",
      intensity: 1,
      rotationDeg: 0,
    });
    const bad = { ...validDoc(), environment: { intensity: 2 } };
    expect(parseThemeDoc(bad, "t")?.environment).toBeUndefined();
  });

  it("parses each backdrop variant and drops invalid ones", () => {
    const floor = {
      ...validDoc(),
      backdrop: { type: "floor", color: "#ffffff", filletRadius: 2.5 },
    };
    expect(parseThemeDoc(floor, "t")?.backdrop).toEqual({
      type: "floor",
      color: "#ffffff",
      filletRadius: 2.5,
    });
    const gradient = { ...validDoc(), backdrop: { type: "gradient", gradient: "brand" } };
    expect(parseThemeDoc(gradient, "t")?.backdrop).toEqual({ type: "gradient", gradient: "brand" });
    const image = { ...validDoc(), backdrop: { type: "image", src: "assets/bg.jpg" } };
    expect(parseThemeDoc(image, "t")?.backdrop).toEqual({
      type: "image",
      src: "assets/bg.jpg",
      fit: "cover",
    });
    const none = { ...validDoc(), backdrop: { type: "none" } };
    expect(parseThemeDoc(none, "t")?.backdrop).toEqual({ type: "none" });
    const bad = { ...validDoc(), backdrop: { type: "floor" } };
    expect(parseThemeDoc(bad, "t")?.backdrop).toBeUndefined();
  });

  it("parses each background variant, clamps parallax, and drops invalid ones (v11)", () => {
    const color = { ...validDoc(), background: { type: "color", color: "#101418" } };
    expect(parseThemeDoc(color, "t")?.background).toEqual({ type: "color", color: "#101418" });
    const gradient = {
      ...validDoc(),
      background: { type: "gradient", gradient: "brand", parallax: 0.05 },
    };
    expect(parseThemeDoc(gradient, "t")?.background).toEqual({
      type: "gradient",
      gradient: "brand",
      parallax: 0.05,
    });
    // Parallax clamps to [0, 0.5]; a non-numeric value is omitted (hard-locked).
    const over = { ...validDoc(), background: { type: "image", src: "kookaburra:x", parallax: 2 } };
    expect(parseThemeDoc(over, "t")?.background).toEqual({
      type: "image",
      src: "kookaburra:x",
      parallax: 0.5,
    });
    const neg = { ...validDoc(), background: { type: "image", src: "a.jpg", parallax: -1 } };
    expect(parseThemeDoc(neg, "t")?.background).toEqual({
      type: "image",
      src: "a.jpg",
      parallax: 0,
    });
    const nonNum = {
      ...validDoc(),
      background: { type: "color", color: "#000000", parallax: "lots" },
    };
    expect(parseThemeDoc(nonNum, "t")?.background).toEqual({ type: "color", color: "#000000" });
    const none = { ...validDoc(), background: { type: "none" } };
    expect(parseThemeDoc(none, "t")?.background).toEqual({ type: "none" });
    const missingSrc = { ...validDoc(), background: { type: "image" } };
    expect(parseThemeDoc(missingSrc, "t")?.background).toBeUndefined();
    const badType = { ...validDoc(), background: { type: "video", src: "x.mp4" } };
    expect(parseThemeDoc(badType, "t")?.background).toBeUndefined();
  });

  it("drops invalid gradients, requires 2+ stops, accepts radial + oklch (v11)", () => {
    const doc = {
      ...validDoc(),
      gradients: {
        good: {
          type: "linear",
          angleDeg: 90,
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
        oneStop: { type: "linear", angleDeg: 90, stops: [["#000000", 0]] },
        conic: {
          type: "conic",
          angleDeg: 0,
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
        // Radial + perceptual interpolation are first-class.
        radial: {
          type: "radial",
          angleDeg: 0,
          space: "oklch",
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
      },
    };
    const theme = parseThemeDoc(doc, "t");
    expect(Object.keys(theme?.gradients ?? {})).toEqual(["good", "radial"]);
    expect(theme?.gradients?.good.space).toBeUndefined(); // absent = the byte-frozen sRGB path
    expect(theme?.gradients?.radial).toEqual({
      type: "radial",
      angleDeg: 0,
      space: "oklch",
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    });
  });

  it("parses an inline background gradient spec and keeps the name form (v11 · M2)", () => {
    const inline = {
      ...validDoc(),
      background: {
        type: "gradient",
        spec: {
          type: "radial",
          angleDeg: 0,
          space: "oklch",
          stops: [
            ["#CFEDE6", 0],
            ["#AFD9E8", 1],
          ],
        },
        parallax: 0.05,
      },
    };
    expect(parseThemeDoc(inline, "t")?.background).toEqual({
      type: "gradient",
      spec: {
        type: "radial",
        angleDeg: 0,
        space: "oklch",
        stops: [
          ["#CFEDE6", 0],
          ["#AFD9E8", 1],
        ],
      },
      parallax: 0.05,
    });
    // A gradient background with NEITHER a name nor a valid spec drops.
    const bad = { ...validDoc(), background: { type: "gradient", spec: { type: "conic" } } };
    expect(parseThemeDoc(bad, "t")?.background).toBeUndefined();
  });

  it("validates effects per-block (invalid bloom drops, valid vignette stays)", () => {
    const doc = {
      ...validDoc(),
      effects: {
        bloom: { intensity: "high" },
        vignette: { offset: 0.3, darkness: 0.55 },
      },
    };
    const theme = parseThemeDoc(doc, "t");
    expect(theme?.effects?.bloom).toBeUndefined();
    expect(theme?.effects?.vignette).toEqual({ offset: 0.3, darkness: 0.55 });
  });

  it("parses textAnimation with a stagger default", () => {
    const doc = { ...validDoc(), textAnimation: { in: "fade-up", out: "fade" } };
    expect(parseThemeDoc(doc, "t")?.textAnimation).toEqual({
      in: "fade-up",
      out: "fade",
      staggerMs: 0,
    });
  });

  it("parses the v11 motion-pack params per-field, dropping invalid ones", () => {
    const doc = {
      ...validDoc(),
      textAnimation: {
        in: "fade-scale",
        out: "twist-scale",
        staggerMs: 0,
        startScale: 1.15,
        shine: true,
        direction: "from-right",
        delivery: "by-paragraph-group",
      },
    };
    expect(parseThemeDoc(doc, "t")?.textAnimation).toEqual({
      in: "fade-scale",
      out: "twist-scale",
      staggerMs: 0,
      startScale: 1.15,
      shine: true,
      direction: "from-right",
      delivery: "by-paragraph-group",
    });
    const bad = {
      ...validDoc(),
      textAnimation: {
        in: "fade-scale",
        out: "none",
        startScale: "big",
        shine: "yes",
        direction: "sideways",
        delivery: "one-by-one",
      },
    };
    const parsed = parseThemeDoc(bad, "t")?.textAnimation;
    expect(parsed).toEqual({ in: "fade-scale", out: "none", staggerMs: 0 });
  });

  it("keeps an optional shadow colour (v8 · M2)", () => {
    const doc = {
      ...validDoc(),
      lighting: {
        key: { azimuthDeg: 0, elevationDeg: 45, intensity: 1 },
        ambient: 0.5,
        shadow: {
          technique: "map",
          softness: 0.5,
          opacity: 0.3,
          mapSize: 2048,
          bias: -0.0005,
          color: "#2a3040",
        },
      },
    };
    expect(parseThemeDoc(doc, "t")?.lighting?.shadow?.color).toBe("#2a3040");
  });
});

describe("parseLightingOverride + mergeLighting (v8 · M2 scene-doc staging)", () => {
  const base: NonNullable<ReturnType<typeof parseThemeDoc>>["lighting"] = {
    key: { azimuthDeg: 35, elevationDeg: 55, intensity: 2 },
    fills: [{ azimuthDeg: -120, elevationDeg: 18, intensity: 0.8 }],
    ambient: 0.85,
    shadow: { technique: "map", softness: 0.5, opacity: 0.3, mapSize: 2048, bias: -0.0005 },
  };

  it("parses partial overrides and drops invalid fields", () => {
    const ov = parseLightingOverride(
      { key: { azimuthDeg: 60, elevationDeg: 14, intensity: 2.4 }, ambient: "high" },
      "t",
    );
    expect(ov?.key?.elevationDeg).toBe(14);
    expect(ov?.ambient).toBeUndefined();
    expect(parseLightingOverride({ nothing: true }, "t")).toBeUndefined();
  });

  it("merges field-level: an override key replaces the theme key wholesale", () => {
    const merged = mergeLighting(base, {
      key: { azimuthDeg: 60, elevationDeg: 14, intensity: 2.4 },
    });
    expect(merged?.key).toEqual({ azimuthDeg: 60, elevationDeg: 14, intensity: 2.4 });
    expect(merged?.fills).toBe(base?.fills);
    expect(merged?.ambient).toBe(0.85);
    expect(merged?.shadow?.mapSize).toBe(2048);
  });

  it("without a base, applies only a complete override (key + ambient)", () => {
    expect(mergeLighting(undefined, { ambient: 0.4 })).toBeUndefined();
    const built = mergeLighting(undefined, {
      key: { azimuthDeg: 0, elevationDeg: 30, intensity: 1.5 },
      ambient: 0.4,
    });
    expect(built?.fills).toEqual([]);
    expect(built?.ambient).toBe(0.4);
  });

  it("returns the base untouched when there is no override", () => {
    expect(mergeLighting(base, undefined)).toBe(base);
  });
});
