import { describe, expect, it, vi } from "vitest";
// Gate sidecars kept as committed fixtures (theme-spike left the bundled set, 2026-07-13).
import themeSpikeMidnightDoc from "./__fixtures__/theme-spike/01-midnight.json";
import themeSpikeStudioDoc from "./__fixtures__/theme-spike/02-studio.json";
import themeSpikeGradientDoc from "./__fixtures__/theme-spike/03-gradient.json";
import themeSpikeImageDoc from "./__fixtures__/theme-spike/04-image.json";
import themeSpikeAbyssDoc from "./__fixtures__/theme-spike/05-abyss.json";
import { parseSceneDoc, SCENE_DOC_VERSION } from "./sceneDocSchema";

// parseSceneDoc must degrade (warn + ignore), never throw; a bad sidecar cannot tear down the canvas tree.
describe("parseSceneDoc", () => {
  it("passes a well-formed v1 doc through", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        name: "Hero demo",
        duration: { mode: "follow-media", sourceDeviceId: "d1" },
        text: { headline: "Ship faster" },
        devices: [{ id: "d1", model: "iphone-15-pro", colour: "blue-titanium" }],
      },
      "test",
    );
    expect(doc).toBeDefined();
    expect(doc?.name).toBe("Hero demo");
    expect(doc?.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d1" });
    expect(doc?.text).toEqual({ headline: "Ship faster" });
    expect(doc?.devices).toHaveLength(1);
  });

  it("ignores non-objects and docs without a valid version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSceneDoc(null, "test")).toBeUndefined();
    expect(parseSceneDoc("nope", "test")).toBeUndefined();
    expect(parseSceneDoc([], "test")).toBeUndefined();
    expect(parseSceneDoc({}, "test")).toBeUndefined();
    expect(parseSceneDoc({ version: 0 }, "test")).toBeUndefined();
    expect(parseSceneDoc({ version: "1" }, "test")).toBeUndefined();
    warn.mockRestore();
  });

  it("ignores docs from a newer schema than this build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSceneDoc({ version: SCENE_DOC_VERSION + 1 }, "test")).toBeUndefined();
    warn.mockRestore();
  });

  it("drops malformed text values and device entries, keeping the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      {
        version: 1,
        text: { good: "yes", bad: 42 },
        devices: [{ id: "d1", model: "iphone-15-pro" }, { model: "missing-id" }, "not-an-object"],
      },
      "test",
    );
    expect(doc?.text).toEqual({ good: "yes" });
    expect(doc?.devices).toHaveLength(1);
    expect(doc?.devices?.[0].id).toBe("d1");
    warn.mockRestore();
  });

  it("drops an unknown duration mode but keeps the doc", () => {
    const doc = parseSceneDoc({ version: 1, duration: { mode: "warp" } }, "test");
    expect(doc).toBeDefined();
    expect(doc?.duration).toBeUndefined();
  });

  it("parses textLayout.align and drops other values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = parseSceneDoc({ version: 1, textLayout: { align: "left" } }, "test");
    expect(good?.textLayout).toEqual({ align: "left" });
    const bad = parseSceneDoc({ version: 1, textLayout: { align: "justify" } }, "test");
    expect(bad).toBeDefined();
    expect(bad?.textLayout).toBeUndefined();
    const empty = parseSceneDoc({ version: 1, textLayout: {} }, "test");
    expect(empty?.textLayout).toBeUndefined();
    warn.mockRestore();
  });

  it("parses textStyle colours field-by-field and collapses an empty object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const both = parseSceneDoc(
      { version: 1, textStyle: { titleColor: "#ff0000", subtitleColor: "#00ff00" } },
      "test",
    );
    expect(both?.textStyle).toEqual({ titleColor: "#ff0000", subtitleColor: "#00ff00" });
    const partial = parseSceneDoc({ version: 1, textStyle: { subtitleColor: "#00ff00" } }, "test");
    expect(partial?.textStyle).toEqual({ subtitleColor: "#00ff00" });
    const bad = parseSceneDoc(
      { version: 1, textStyle: { titleColor: 7, subtitleColor: "" } },
      "test",
    );
    expect(bad).toBeDefined();
    expect(bad?.textStyle).toBeUndefined();
    const empty = parseSceneDoc({ version: 1, textStyle: {} }, "test");
    expect(empty?.textStyle).toBeUndefined();
    warn.mockRestore();
  });

  it("accepts any <textKey>Color entry in textStyle and drops other keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const custom = parseSceneDoc(
      { version: 1, textStyle: { headlineColor: "#123456", versionColor: "muted" } },
      "test",
    );
    expect(custom?.textStyle).toEqual({ headlineColor: "#123456", versionColor: "muted" });
    const stray = parseSceneDoc(
      { version: 1, textStyle: { headline: "#123456", nameColor: "#654321" } },
      "test",
    );
    expect(stray?.textStyle).toEqual({ nameColor: "#654321" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("textStyle.headline"));
    warn.mockRestore();
  });

  it("keeps a camera track only when keys AND segments are arrays", () => {
    const good = parseSceneDoc({ version: 1, camera: { keys: [], segments: [] } }, "test");
    expect(good?.camera).toEqual({ keys: [], segments: [] });
    const bad = parseSceneDoc({ version: 1, camera: { keys: [] } }, "test");
    expect(bad?.camera).toBeUndefined();
  });
  it("keeps a non-empty string themeId and drops other shapes (v8)", () => {
    expect(parseSceneDoc({ version: 1, themeId: "kookaburra-studio-white" }, "test")?.themeId).toBe(
      "kookaburra-studio-white",
    );
    expect(parseSceneDoc({ version: 1, themeId: "" }, "test")?.themeId).toBeUndefined();
    expect(parseSceneDoc({ version: 1, themeId: 42 }, "test")?.themeId).toBeUndefined();
    expect(parseSceneDoc({ version: 1 }, "test")?.themeId).toBeUndefined();
  });

  it("structure-pins the theme-spike gate sidecar: the theme swap must survive parsing", () => {
    // The gate-sidecar lesson: a silent parse-degrade would turn the cross-theme crossfade gate into a single-theme no-op that still verifies byte-identical.
    const doc = parseSceneDoc(themeSpikeStudioDoc, "theme-spike/02-studio.json");
    expect(doc?.themeId).toBe("kookaburra-studio-white");
    expect(doc?.text?.headline).toBe("Hello daylight");

    // The long-shadow gradient scene rides entirely on sidecar staging overrides.
    const gradient = parseSceneDoc(themeSpikeGradientDoc, "theme-spike/03-gradient.json");
    expect(gradient?.backdrop).toEqual({ type: "gradient", gradient: "glow" });
    expect(gradient?.lighting?.key?.elevationDeg).toBe(16);
    expect(gradient?.lighting?.shadow?.technique).toBe("map");

    const image = parseSceneDoc(themeSpikeImageDoc, "theme-spike/04-image.json");
    expect(image?.themeId).toBe("kookaburra-studio-white");
    expect(image?.backdrop).toEqual({ type: "image", src: "assets/backdrop.jpg", fit: "cover" });
    expect(image?.lighting?.shadow?.color).toBe("#101418");
  });

  it("structure-pins the v11 fixed-background gate sidecars", () => {
    // A silent parse-degrade would verify byte-identical while quietly dropping the fixed layer (the gate-sidecar lesson again).
    const midnight = parseSceneDoc(themeSpikeMidnightDoc, "theme-spike/01-midnight.json");
    expect(midnight?.background).toEqual({
      type: "image",
      src: "kookaburra:loft-studio",
      parallax: 0.05,
    });
    expect(midnight?.camera?.keys).toHaveLength(2); // the pan+orbit that shows the drift

    const studio = parseSceneDoc(themeSpikeStudioDoc, "theme-spike/02-studio.json");
    expect(studio?.background).toEqual({ type: "color", color: "#dfe6ee" });

    const gradient = parseSceneDoc(themeSpikeGradientDoc, "theme-spike/03-gradient.json");
    expect(gradient?.background).toEqual({ type: "color", color: "#2a1e3f" });

    // Scene 05: cross-theme, world backdrop cancelled, the fixed gradient IS the fill.
    const abyss = parseSceneDoc(themeSpikeAbyssDoc, "theme-spike/05-abyss.json");
    expect(abyss?.themeId).toBe("kookaburra-abyss");
    expect(abyss?.backdrop).toEqual({ type: "none" });
    expect(abyss?.background).toEqual({ type: "gradient", gradient: "backdrop", parallax: 0.03 });
  });
  it("parses staging overrides: backdrop + partial lighting (v8 · M2)", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        backdrop: { type: "gradient", gradient: "brand" },
        lighting: {
          key: { azimuthDeg: 70, elevationDeg: 16, intensity: 2.2 },
          shadow: { technique: "map", softness: 0.7, opacity: 0.35, mapSize: 2048, bias: -0.0005 },
        },
      },
      "test",
    );
    expect(doc?.backdrop).toEqual({ type: "gradient", gradient: "brand" });
    expect(doc?.lighting?.key?.elevationDeg).toBe(16);
    expect(doc?.lighting?.ambient).toBeUndefined();
    const bad = parseSceneDoc({ version: 1, backdrop: { type: "floor" } }, "test");
    expect(bad?.backdrop).toBeUndefined();
  });

  it("parses the textAnimation sidecar override (v11 · M3)", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        textAnimation: {
          in: "fade-scale",
          out: "none",
          staggerMs: 0,
          startScale: 1.15,
          shine: true,
        },
      },
      "test",
    );
    expect(doc?.textAnimation).toEqual({
      in: "fade-scale",
      out: "none",
      staggerMs: 0,
      startScale: 1.15,
      shine: true,
    });
    // A malformed spec drops the field, never the doc.
    const bad = parseSceneDoc({ version: 1, textAnimation: { in: "fade" } }, "test");
    expect(bad?.textAnimation).toBeUndefined();
    expect(bad).toBeDefined();
  });

  it("parses the fixed-background override and degrades invalid ones (v11)", () => {
    const doc = parseSceneDoc(
      { version: 1, background: { type: "image", src: "kookaburra:loft-studio", parallax: 0.05 } },
      "test",
    );
    expect(doc?.background).toEqual({
      type: "image",
      src: "kookaburra:loft-studio",
      parallax: 0.05,
    });
    // {type:"none"} cancels the theme's fixed layer for this scene.
    const none = parseSceneDoc({ version: 1, background: { type: "none" } }, "test");
    expect(none?.background).toEqual({ type: "none" });
    const bad = parseSceneDoc({ version: 1, background: { type: "color" } }, "test");
    expect(bad?.background).toBeUndefined();
    expect(bad).toBeDefined();
  });

  it("parses VIDEO background fills — sidecars only, loop stored only as false (v12 · M4)", () => {
    // The canonical minimal shape: absent loop = loop (decision 6).
    const looped = parseSceneDoc(
      { version: 1, background: { type: "video", src: "assets/bg-loop.mp4" } },
      "test",
    );
    expect(looped?.background).toEqual({ type: "video", src: "assets/bg-loop.mp4" });
    // `loop: true` normalizes AWAY (only false is stored); false survives; parallax rides.
    const explicit = parseSceneDoc(
      { version: 1, background: { type: "video", src: "a.mp4", loop: true, parallax: 0.05 } },
      "test",
    );
    expect(explicit?.background).toEqual({ type: "video", src: "a.mp4", parallax: 0.05 });
    const hold = parseSceneDoc(
      { version: 1, background: { type: "video", src: "a.mp4", loop: false } },
      "test",
    );
    expect(hold?.background).toEqual({ type: "video", src: "a.mp4", loop: false });
    // No src → dropped (the standard degrade).
    const bad = parseSceneDoc({ version: 1, background: { type: "video" } }, "test");
    expect(bad?.background).toBeUndefined();
  });
});
