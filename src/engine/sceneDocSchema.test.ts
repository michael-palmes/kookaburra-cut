import { describe, expect, it, vi } from "vitest";
// Gate sidecars kept as committed fixtures (theme-spike left the bundled set, 2026-07-13).
import themeSpikeMidnightDoc from "./__fixtures__/theme-spike/01-midnight.json";
import themeSpikeStudioDoc from "./__fixtures__/theme-spike/02-studio.json";
import themeSpikeGradientDoc from "./__fixtures__/theme-spike/03-gradient.json";
import themeSpikeImageDoc from "./__fixtures__/theme-spike/04-image.json";
import themeSpikeAbyssDoc from "./__fixtures__/theme-spike/05-abyss.json";
import { collectSceneDocFontRefs, parseSceneDoc, SCENE_DOC_VERSION } from "./sceneDocSchema";

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

  it("keeps well-formed object entries and drops the malformed, like devices", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      {
        version: 1,
        objects: [
          { id: "o1", objectId: "lantern", placement: { position: [1, 0, 0], ground: true } },
          { id: "o2" },
          "not-an-object",
        ],
      },
      "test",
    );
    expect(doc?.objects).toHaveLength(1);
    expect(doc?.objects?.[0].objectId).toBe("lantern");
    expect(doc?.objects?.[0].placement?.ground).toBe(true);
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

  it("parses textStyle font, size and offset overrides and drops bad values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = parseSceneDoc(
      {
        version: 1,
        textStyle: {
          titleFont: "Avenir Next@600",
          titleSize: 1.25,
          titleOffsetX: -0.4,
          titleOffsetY: 0.2,
        },
      },
      "test",
    );
    expect(good?.textStyle).toEqual({
      titleFont: "Avenir Next@600",
      titleSize: 1.25,
      titleOffsetX: -0.4,
      titleOffsetY: 0.2,
    });
    const bad = parseSceneDoc(
      {
        version: 1,
        textStyle: {
          titleFont: "",
          titleSize: 0,
          subtitleSize: "big",
          titleOffsetX: Number.NaN,
          titleOffsetY: 0.1,
        },
      },
      "test",
    );
    expect(bad?.textStyle).toEqual({ titleOffsetY: 0.1 });
    warn.mockRestore();
  });

  it("parses textStyle line heights, clamps them and drops non-numbers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = parseSceneDoc(
      { version: 1, textStyle: { titleLineHeight: 1.45, subtitleLineHeight: 0.8 } },
      "test",
    );
    expect(good?.textStyle).toEqual({ titleLineHeight: 1.45, subtitleLineHeight: 0.8 });
    const clamped = parseSceneDoc(
      { version: 1, textStyle: { titleLineHeight: 9, subtitleLineHeight: 0.1 } },
      "test",
    );
    expect(clamped?.textStyle).toEqual({ titleLineHeight: 2, subtitleLineHeight: 0.8 });
    const bad = parseSceneDoc(
      { version: 1, textStyle: { titleLineHeight: "tall", subtitleLineHeight: Number.NaN } },
      "test",
    );
    expect(bad?.textStyle).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("textStyle.titleLineHeight"));
    warn.mockRestore();
  });

  it("parses textStyle rotations, folds them into (-180, 180] and drops non-numbers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = parseSceneDoc(
      { version: 1, textStyle: { titleRotationDeg: 12.5, subtitleRotationDeg: 400 } },
      "test",
    );
    expect(good?.textStyle).toEqual({ titleRotationDeg: 12.5, subtitleRotationDeg: 40 });
    const wrapped = parseSceneDoc(
      { version: 1, textStyle: { titleRotationDeg: -190, subtitleRotationDeg: -180 } },
      "test",
    );
    expect(wrapped?.textStyle).toEqual({ titleRotationDeg: 170, subtitleRotationDeg: 180 });
    const bad = parseSceneDoc({ version: 1, textStyle: { titleRotationDeg: Number.NaN } }, "test");
    expect(bad?.textStyle).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("textStyle.titleRotationDeg"));
    warn.mockRestore();
  });

  it("collects distinct sidecar font refs across docs", () => {
    const a = parseSceneDoc(
      { version: 1, textStyle: { titleFont: "Avenir Next@600", subtitleFont: "Georgia" } },
      "test",
    );
    const b = parseSceneDoc({ version: 1, textStyle: { titleFont: "Avenir Next@600" } }, "test");
    expect(collectSceneDocFontRefs([a, b, undefined])).toEqual([
      { family: "Avenir Next", weight: 600 },
      { family: "Georgia", weight: 400 },
    ]);
  });

  it("collects a chart font into the preload set, so exported chart text can't fall back", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data: { categories: ["a"], series: [{ id: "s1", values: [1] }] },
          font: "IBM Plex Mono@500",
        },
      },
      "test",
    );
    expect(doc?.chart?.font).toBe("IBM Plex Mono@500");
    expect(collectSceneDocFontRefs([doc])).toEqual([{ family: "IBM Plex Mono", weight: 500 }]);
    const plain = parseSceneDoc(
      {
        version: 1,
        chart: { type: "column", data: { categories: ["a"], series: [{ id: "s1", values: [1] }] } },
      },
      "test",
    );
    expect(collectSceneDocFontRefs([plain])).toEqual([]);
  });

  it("collects a text decoration's font into the preload set", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        frame: {
          cutout: { shape: "rounded-rect", side: "start" },
          decorations: [
            { id: "t1", text: "Since 2019", position: [0.4, -0.5], size: 0.05, font: "Avenir@700" },
          ],
        },
      },
      "test",
    );
    expect(doc?.frame?.decorations?.[0]?.font).toBe("Avenir@700");
    expect(collectSceneDocFontRefs([doc])).toEqual([{ family: "Avenir", weight: 700 }]);
  });

  it("keeps a camera track only when keys AND segments are arrays", () => {
    const good = parseSceneDoc({ version: 1, camera: { keys: [], segments: [] } }, "test");
    expect(good?.camera).toEqual({ keys: [], segments: [] });
    const bad = parseSceneDoc({ version: 1, camera: { keys: [] } }, "test");
    expect(bad?.camera).toBeUndefined();
  });

  it("keeps a valid camera.presentLoop and drops invalid ones without losing the track", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const smooth = parseSceneDoc(
      {
        version: 1,
        camera: { keys: [], segments: [], presentLoop: { mode: "smooth", blendMs: 1500 } },
      },
      "test",
    );
    expect(smooth?.camera?.presentLoop).toEqual({ mode: "smooth", blendMs: 1500 });
    const jump = parseSceneDoc(
      { version: 1, camera: { keys: [], segments: [], presentLoop: { mode: "jump" } } },
      "test",
    );
    expect(jump?.camera?.presentLoop).toEqual({ mode: "jump" });
    const badMode = parseSceneDoc(
      { version: 1, camera: { keys: [], segments: [], presentLoop: { mode: "bounce" } } },
      "test",
    );
    expect(badMode?.camera).toEqual({ keys: [], segments: [] });
    const badBlend = parseSceneDoc(
      {
        version: 1,
        camera: { keys: [], segments: [], presentLoop: { mode: "smooth", blendMs: -5 } },
      },
      "test",
    );
    expect(badBlend?.camera).toEqual({ keys: [], segments: [] });
    expect(badBlend?.camera?.presentLoop).toBeUndefined();
    warn.mockRestore();
  });
  it("keeps a structurally sound layeredScreenshot block and drops malformed ones whole", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posed = { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] };
    const good = parseSceneDoc(
      { version: 1, layeredScreenshot: { layers: [], pose: posed } },
      "test",
    );
    expect(good?.layeredScreenshot).toEqual({ layers: [], pose: posed });
    const badPose = parseSceneDoc(
      { version: 1, layeredScreenshot: { layers: [], pose: { spread: "wide" } } },
      "test",
    );
    expect(badPose?.layeredScreenshot).toBeUndefined();
    const badAnimation = parseSceneDoc(
      { version: 1, layeredScreenshot: { layers: [], pose: posed, animation: { keys: 7 } } },
      "test",
    );
    expect(badAnimation?.layeredScreenshot).toBeUndefined();
    warn.mockRestore();
  });

  it("keeps only the known animatedTrack values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const track of ["camera", "layeredScreenshot", "compare", "chart"]) {
      expect(parseSceneDoc({ version: 1, animatedTrack: track }, "test")?.animatedTrack).toBe(
        track,
      );
    }
    expect(
      parseSceneDoc({ version: 1, animatedTrack: "both" }, "test")?.animatedTrack,
    ).toBeUndefined();
    warn.mockRestore();
  });

  it("parses comparison staging and device appearance independently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      {
        version: 1,
        compare: {
          b: {
            backdrop: { type: "floor", color: "#123456" },
            background: { type: "color", color: "#654321" },
            deviceAppearance: {
              d1: { colour: "silver", shadow: "none" },
              d2: { colour: "graphite", shadow: "unknown" },
              d3: { colour: 42, shadow: "long" },
              d4: { colour: "   " },
              empty: {},
            },
          },
        },
      },
      "test",
    );
    expect(doc?.compare?.b?.backdrop).toEqual({ type: "floor", color: "#123456" });
    expect(doc?.compare?.b?.background).toEqual({ type: "color", color: "#654321" });
    expect(doc?.compare?.b?.deviceAppearance).toEqual({
      d1: { colour: "silver", shadow: "none" },
      d2: { colour: "graphite" },
      d3: { shadow: "long" },
    });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
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
    expect(gradient?.lighting?.sun?.elevationDeg).toBe(16);
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
    expect(doc?.lighting?.sun?.elevationDeg).toBe(16);
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
    // `fit: "fit"` letterboxes; `fill` (the default) normalizes AWAY, keeping legacy bytes identical.
    const fit = parseSceneDoc(
      { version: 1, background: { type: "video", src: "a.mp4", fit: "fit" } },
      "test",
    );
    expect(fit?.background).toEqual({ type: "video", src: "a.mp4", fit: "fit" });
    const fill = parseSceneDoc(
      { version: 1, background: { type: "video", src: "a.mp4", fit: "fill" } },
      "test",
    );
    expect(fill?.background).toEqual({ type: "video", src: "a.mp4" });
    // No src → dropped (the standard degrade).
    const bad = parseSceneDoc({ version: 1, background: { type: "video" } }, "test");
    expect(bad?.background).toBeUndefined();
  });

  it("round-trips a camera rig and leaves legacy docs without one", () => {
    const rig = {
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: { position: [0, 1, 6], aim: { mode: "tangent", at: [0, 0, 0] }, rollDeg: 8 },
        },
        {
          id: "k2",
          tMs: 1200,
          pose: {
            position: [2, 1, 2],
            aim: { mode: "object", id: "phone", at: [0, 0, 0] },
            fov: 32,
          },
        },
      ],
      segments: [{ from: "k1", to: "k2", ease: "inOutCubic", easeLens: "outExpo" }],
    };
    const doc = parseSceneDoc({ version: 1, cameraMode: "rig", cameraRig: rig }, "test");
    expect(doc?.cameraMode).toBe("rig");
    expect(doc?.cameraRig).toEqual(rig);
    // Absent fields parse unchanged, which is why SCENE_DOC_VERSION stays 1.
    const legacy = parseSceneDoc({ version: 1, camera: { keys: [], segments: [] } }, "test");
    expect(legacy?.cameraMode).toBeUndefined();
    expect(legacy?.cameraRig).toBeUndefined();
  });

  it("drops an unknown cameraMode and a structurally wrong rig", () => {
    const doc = parseSceneDoc(
      { version: 1, cameraMode: "freehand", cameraRig: { keys: "nope" } },
      "test",
    );
    expect(doc?.cameraMode).toBeUndefined();
    expect(doc?.cameraRig).toBeUndefined();
  });

  it("drops an invalid rig presentLoop but keeps the keys", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        cameraRig: { keys: [], segments: [], presentLoop: { mode: "spin" } },
      },
      "test",
    );
    expect(doc?.cameraRig).toEqual({ keys: [], segments: [] });
  });

  it("round-trips a deviceLayout block and degrades its bad fields alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const block = {
      preset: "hero",
      gap: 0.5,
      devices: { d2: { offset: [0.1, 0, -0.2], rotationDeg: [0, 5, 0], scale: 1.2 } },
    };
    const doc = parseSceneDoc({ version: 1, deviceLayout: block }, "test");
    expect(doc?.deviceLayout).toEqual(block);
    const degraded = parseSceneDoc(
      {
        version: 1,
        deviceLayout: {
          preset: "spiral",
          gap: "wide",
          devices: { d1: { offset: [1, 2], scale: 0 }, d2: "nope", d3: { scale: 2 } },
        },
      },
      "test",
    );
    expect(degraded?.deviceLayout).toEqual({ preset: "row", devices: { d3: { scale: 2 } } });
    expect(parseSceneDoc({ version: 1, deviceLayout: 7 }, "test")?.deviceLayout).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("round-trips a full chart block, dropping only the null series colour", () => {
    const block = {
      type: "stackedColumn",
      dimension: "3d",
      mount: "hero",
      data: {
        categories: ["April", "May"],
        series: [
          { id: "s1", name: "Region 1", values: [17, 26], colour: null },
          { id: "s2", name: "Region 2", values: [55, 43], colour: "#f0a848" },
        ],
        source: "assets/q3.csv",
      },
      style: {
        preset: "boardroom",
        depth: 0.5,
        gap: 1,
        cornerRadius: 0.25,
        rotation: [18.5, -18.1],
        innerRadius: 0,
      },
      axis: {
        value: {
          name: null,
          min: null,
          max: null,
          steps: 4,
          format: { decimals: null, separator: true, prefix: "$", suffix: "", compact: false },
          gridlines: { visible: true, style: "hair" },
          labels: true,
        },
        category: { name: null, labels: true },
      },
      labels: {
        legend: { visible: true, position: "bottom" },
        values: {
          visible: true,
          location: "above",
          format: { decimals: 0, separator: true, prefix: "", suffix: "" },
          countUp: true,
        },
      },
      animation: {
        preset: "rise",
        delivery: "cascade",
        staggerMs: 60,
        durationMs: 900,
        from: "start",
      },
      track: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              values: [
                [17, 26],
                [55, 43],
              ],
            },
          },
          {
            id: "k2",
            tMs: 3000,
            pose: {
              values: [
                [24, 31],
                [48, 50],
              ],
            },
          },
        ],
        segments: [{ from: "k1", to: "k2", ease: "inOutQuad" }],
      },
    };
    const doc = parseSceneDoc({ version: 1, chart: block }, "test");
    expect(doc?.chart).toEqual({
      ...block,
      data: {
        ...block.data,
        series: [
          { id: "s1", name: "Region 1", values: [17, 26] },
          { id: "s2", name: "Region 2", values: [55, 43], colour: "#f0a848" },
        ],
      },
    });
  });

  it("keeps a chart colour scheme id and drops anything that isn't one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = { categories: ["a"], series: [{ id: "s1", values: [1] }] };
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, palette: "reef" } }, "test")?.chart
        ?.palette,
    ).toBe("reef");
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, palette: 7 } }, "test")?.chart
        ?.palette,
    ).toBeUndefined();
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, palette: "  " } }, "test")?.chart
        ?.palette,
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chart.palette"));
    vi.restoreAllMocks();
  });

  it("keeps a chart font string and drops anything that isn't one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = { categories: ["a"], series: [{ id: "s1", values: [1] }] };
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, font: " Georgia " } }, "test")
        ?.chart?.font,
    ).toBe("Georgia");
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, font: 7 } }, "test")?.chart?.font,
    ).toBeUndefined();
    expect(
      parseSceneDoc({ version: 1, chart: { type: "column", data, font: "  " } }, "test")?.chart
        ?.font,
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chart.font"));
    vi.restoreAllMocks();
  });

  it("keeps a chart block absent from legacy docs (null-for-legacy)", () => {
    expect(parseSceneDoc({ version: 1, text: { headline: "hi" } }, "test")?.chart).toBeUndefined();
  });

  it("drops the chart block whole without a data.series array, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noData = parseSceneDoc({ version: 1, chart: { type: "column" } }, "test");
    expect(noData).toBeDefined();
    expect(noData?.chart).toBeUndefined();
    expect(
      parseSceneDoc({ version: 1, chart: { type: "pie", data: {} } }, "test")?.chart,
    ).toBeUndefined();
    expect(parseSceneDoc({ version: 1, chart: "nope" }, "test")?.chart).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chart"));
    warn.mockRestore();
  });

  it("falls back to a column for an unknown chart type, keeping the data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      { version: 1, chart: { type: "donut", data: { categories: ["a"], series: [] } } },
      "test",
    );
    expect(doc?.chart?.type).toBe("column");
    expect(doc?.chart?.data).toEqual({ categories: ["a"], series: [] });
    warn.mockRestore();
  });

  it("keeps a value-label nudge and a background block, dropping only the junk fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = { categories: ["a"], series: [{ id: "s1", values: [1] }] };
    const authored = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data,
          labels: {
            values: {
              offsetY: 1.2,
              background: { colour: "#1b2733", opacity: 0.85, radius: 0.4 },
            },
          },
        },
      },
      "test",
    );
    expect(authored?.chart?.labels?.values).toEqual({
      offsetY: 1.2,
      background: { colour: "#1b2733", opacity: 0.85, radius: 0.4 },
    });
    const degraded = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data,
          labels: {
            values: {
              offsetY: "up",
              background: { colour: "chartreuse", opacity: "half", radius: null },
            },
          },
        },
      },
      "test",
    );
    // The block survives bare, because its PRESENCE is what forces the chip on.
    expect(degraded?.chart?.labels?.values).toEqual({ background: {} });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("chart.labels.values.background.colour"),
    );
    const token = parseSceneDoc(
      { version: 1, chart: { type: "column", data, labels: { values: { background: "solid" } } } },
      "test",
    );
    expect(token?.chart?.labels?.values).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chart.labels.values.background"));
    const named = parseSceneDoc(
      {
        version: 1,
        chart: { type: "column", data, labels: { values: { background: { colour: "accent" } } } },
      },
      "test",
    );
    expect(named?.chart?.labels?.values?.background).toEqual({ colour: "accent" });
    warn.mockRestore();
  });

  it("leaves the value-label nudge and background absent when nothing authors them", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data: { categories: ["a"], series: [{ id: "s1", values: [1] }] },
          labels: { values: { visible: true } },
        },
      },
      "test",
    );
    expect(doc?.chart?.labels?.values).toEqual({ visible: true });
  });

  it("coerces a panel-mounted chart to 2d and leaves other mounts alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = { categories: [], series: [] };
    const panel = parseSceneDoc(
      { version: 1, chart: { type: "line", mount: "panel", dimension: "3d", data } },
      "test",
    );
    expect(panel?.chart?.dimension).toBe("2d");
    const staged = parseSceneDoc(
      { version: 1, chart: { type: "line", mount: "staged", dimension: "3d", data } },
      "test",
    );
    expect(staged?.chart?.dimension).toBe("3d");
    // Absence is preserved: sceneChart.ts owns the default.
    const bare = parseSceneDoc(
      { version: 1, chart: { type: "line", mount: "panel", data } },
      "test",
    );
    expect(bare?.chart?.dimension).toBeUndefined();
    const badMount = parseSceneDoc(
      { version: 1, chart: { type: "line", mount: "wall", dimension: "flat", data } },
      "test",
    );
    expect(badMount?.chart?.mount).toBeUndefined();
    expect(badMount?.chart?.dimension).toBeUndefined();
    warn.mockRestore();
  });

  it("blanks non-string categories and drops malformed series, zeroing bad cells", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data: {
            categories: ["April", 7, "June"],
            series: [
              { id: "s1", values: [1, "two", null] },
              { name: "no id", values: [1] },
              { id: "s3", values: "nope" },
              "not-an-object",
            ],
            source: "",
          },
        },
      },
      "test",
    );
    // A blanked category keeps its slot so the remaining labels stay aligned.
    expect(doc?.chart?.data.categories).toEqual(["April", "", "June"]);
    expect(doc?.chart?.data.series).toEqual([{ id: "s1", values: [1, 0, 0] }]);
    expect(doc?.chart?.data.source).toBeUndefined();
    warn.mockRestore();
  });

  it("degrades malformed chart placement, style, axis, labels and animation fields alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "bar",
          mount: "staged",
          placement: { position: [0, 1, 0], rotationDeg: [0, "x", 0], scale: 0, ground: true },
          data: { categories: ["a"], series: [{ id: "s1", values: [1] }] },
          style: { preset: "", depth: "deep", gap: 2, cornerRadius: 0.4, rotation: [1] },
          axis: {
            value: {
              name: 7,
              min: "auto",
              max: 100,
              steps: Number.NaN,
              format: { decimals: 2, separator: "yes", prefix: "$" },
              gridlines: { visible: false, style: "dotted" },
              labels: "on",
            },
            category: { name: "Month", labels: false },
          },
          labels: {
            legend: { visible: false, position: "left" },
            values: { location: "middle", countUp: false, format: 7 },
          },
          animation: { preset: "rise", delivery: "waterfall", staggerMs: -5, durationMs: 400 },
        },
      },
      "test",
    );
    expect(doc?.chart?.placement).toEqual({ position: [0, 1, 0], ground: true });
    expect(doc?.chart?.style).toEqual({ gap: 2, cornerRadius: 0.4 });
    expect(doc?.chart?.axis).toEqual({
      value: {
        max: 100,
        format: { decimals: 2, prefix: "$" },
        gridlines: { visible: false },
      },
      category: { name: "Month", labels: false },
    });
    expect(doc?.chart?.labels).toEqual({
      legend: { visible: false },
      values: { countUp: false },
    });
    expect(doc?.chart?.animation).toEqual({ preset: "rise", durationMs: 400 });
    warn.mockRestore();
  });

  it("keeps a chart track only while a key survives, dropping malformed keys and segments", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = { categories: ["a"], series: [{ id: "s1", values: [1] }] };
    const doc = parseSceneDoc(
      {
        version: 1,
        chart: {
          type: "column",
          data,
          track: {
            keys: [
              { id: "k1", tMs: 0, pose: { values: [[1, "x"]] } },
              { id: "k2", tMs: "later", pose: { values: [[2]] } },
              { id: "k3", tMs: 500, pose: { values: 3 } },
              { tMs: 900, pose: { values: [[4]] } },
            ],
            segments: [
              { from: "k1", to: "k2", ease: "linear" },
              { from: "k1", to: 7 },
            ],
          },
        },
      },
      "test",
    );
    expect(doc?.chart?.track).toEqual({
      keys: [{ id: "k1", tMs: 0, pose: { values: [[1, 0]] } }],
      segments: [{ from: "k1", to: "k2", ease: "linear" }],
    });
    const empty = parseSceneDoc(
      { version: 1, chart: { type: "column", data, track: { keys: [], segments: [] } } },
      "test",
    );
    expect(empty?.chart?.track).toBeUndefined();
    expect(empty?.chart?.data).toEqual(data);
    warn.mockRestore();
  });
});
