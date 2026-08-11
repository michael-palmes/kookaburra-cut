import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFrameSpec, parseFrameOverride, parseFrameSpec } from "./frameSchema";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const valid = { cutout: { shape: "rounded-rect" } };

describe("parseFrameSpec cutout", () => {
  it("accepts a minimal block", () => {
    expect(parseFrameSpec(valid, "t")).toEqual({ cutout: { shape: "rounded-rect" } });
  });

  it("keeps the optional cutout fields", () => {
    const spec = parseFrameSpec(
      { cutout: { shape: "squircle", radius: 0.2, size: 0.6, inset: 0.05, side: "end" } },
      "t",
    );
    expect(spec?.cutout).toEqual({
      shape: "squircle",
      radius: 0.2,
      size: 0.6,
      inset: 0.05,
      side: "end",
    });
  });

  it("ignores the block when the shape is unknown or missing", () => {
    expect(parseFrameSpec({ cutout: { shape: "triangle" } }, "t")).toBeUndefined();
    expect(parseFrameSpec({ cutout: {} }, "t")).toBeUndefined();
    expect(parseFrameSpec({}, "t")).toBeUndefined();
  });

  it("ignores a non-object block", () => {
    expect(parseFrameSpec(null, "t")).toBeUndefined();
    expect(parseFrameSpec([valid], "t")).toBeUndefined();
    expect(parseFrameSpec("frame", "t")).toBeUndefined();
  });

  it("drops non-finite numbers rather than passing NaN to the layout maths", () => {
    const spec = parseFrameSpec(
      { cutout: { shape: "rect", size: Number.NaN, inset: Number.POSITIVE_INFINITY } },
      "t",
    );
    expect(spec?.cutout).toEqual({ shape: "rect" });
  });

  it("drops an unknown side", () => {
    const spec = parseFrameSpec({ cutout: { shape: "rect", side: "middle" } }, "t");
    expect(spec?.cutout.side).toBeUndefined();
  });
});

describe("parseFrameSpec colour", () => {
  it("accepts theme tokens and hex", () => {
    expect(parseFrameSpec({ ...valid, background: "accent" }, "t")?.background).toBe("accent");
    expect(parseFrameSpec({ ...valid, background: "#fff" }, "t")?.background).toBe("#fff");
    expect(parseFrameSpec({ ...valid, background: "#1a2b3c" }, "t")?.background).toBe("#1a2b3c");
  });

  it("drops a colour that is neither, keeping the rest of the block", () => {
    const spec = parseFrameSpec({ ...valid, background: "rebeccapurple" }, "t");
    expect(spec?.background).toBeUndefined();
    expect(spec?.cutout.shape).toBe("rounded-rect");
  });
});

describe("parseFrameSpec panel fill", () => {
  const gradient = {
    type: "linear",
    angleDeg: 180,
    stops: [
      ["#000000", 0],
      ["#ffffff", 1],
    ],
  };

  it("keeps the four fill types", () => {
    expect(
      parseFrameSpec({ ...valid, background: { type: "transparent" } }, "t")?.background,
    ).toEqual({ type: "transparent" });
    expect(
      parseFrameSpec({ ...valid, background: { type: "color", color: "accent" } }, "t")?.background,
    ).toEqual({ type: "color", color: "accent" });
    expect(
      parseFrameSpec({ ...valid, background: { type: "gradient", spec: gradient } }, "t")
        ?.background,
    ).toEqual({ type: "gradient", spec: gradient });
    expect(
      parseFrameSpec({ ...valid, background: { type: "image", src: "assets/panel.png" } }, "t")
        ?.background,
    ).toEqual({ type: "image", src: "assets/panel.png" });
  });

  it("keeps a named theme gradient, with or without an inline spec", () => {
    expect(
      parseFrameSpec({ ...valid, background: { type: "gradient", gradient: "backdrop" } }, "t")
        ?.background,
    ).toEqual({ type: "gradient", gradient: "backdrop" });
    expect(
      parseFrameSpec(
        { ...valid, background: { type: "gradient", gradient: "backdrop", spec: gradient } },
        "t",
      )?.background,
    ).toEqual({ type: "gradient", gradient: "backdrop", spec: gradient });
  });

  it("drops a fill that names nothing usable, keeping the rest of the block", () => {
    const drops = [
      { type: "gradient" },
      { type: "gradient", spec: { type: "wobble" } },
      { type: "color", color: "rebeccapurple" },
      { type: "color" },
      { type: "image", src: "" },
      { type: "image" },
      { type: "video", src: "assets/a.mp4" },
      { type: 3 },
      [],
    ];
    for (const background of drops) {
      const spec = parseFrameSpec({ ...valid, background }, "t");
      expect(spec?.background).toBeUndefined();
      expect(spec?.cutout.shape).toBe("rounded-rect");
    }
  });
});

describe("parseFrameSpec chip", () => {
  it("keeps a full chip", () => {
    const spec = parseFrameSpec(
      { ...valid, chip: { label: "Released", colour: "accent", icon: "✅" } },
      "t",
    );
    expect(spec?.chip).toEqual({ label: "Released", colour: "accent", icon: "✅" });
  });

  it("drops a chip with no usable label", () => {
    expect(parseFrameSpec({ ...valid, chip: { label: "" } }, "t")?.chip).toBeUndefined();
    expect(parseFrameSpec({ ...valid, chip: { colour: "accent" } }, "t")?.chip).toBeUndefined();
  });

  it("keeps the chip when only its colour is bad", () => {
    const spec = parseFrameSpec({ ...valid, chip: { label: "Beta", colour: "nope" } }, "t");
    expect(spec?.chip).toEqual({ label: "Beta" });
  });
});

describe("parseFrameSpec decorations", () => {
  const deco = { id: "arm", src: "assets/arm.png", position: [0.4, 0.6], size: 0.3 };

  it("keeps a valid decoration and its layering", () => {
    const spec = parseFrameSpec(
      { ...valid, decorations: [{ ...deco, shape: "circle", layer: "above" }] },
      "t",
    );
    expect(spec?.decorations).toEqual([{ ...deco, shape: "circle", layer: "above" }]);
  });

  it("keeps a finite rotationDeg and drops a non-finite one", () => {
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...deco, rotationDeg: -12 }] }, "t")?.decorations,
    ).toEqual([{ ...deco, rotationDeg: -12 }]);
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...deco, rotationDeg: Number.NaN }] }, "t")
        ?.decorations,
    ).toEqual([deco]);
  });

  it("keeps a finite stack order and drops a non-finite one", () => {
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...deco, stackOrder: 4.5 }] }, "t")?.decorations,
    ).toEqual([{ ...deco, stackOrder: 4.5 }]);
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...deco, stackOrder: Number.NaN }] }, "t")
        ?.decorations,
    ).toEqual([deco]);
  });

  it("drops only the bad entries", () => {
    const spec = parseFrameSpec(
      {
        ...valid,
        decorations: [deco, { ...deco, position: [0.1] }, { ...deco, id: 7 }, { ...deco, size: 0 }],
      },
      "t",
    );
    expect(spec?.decorations).toEqual([deco]);
  });

  it("drops a non-array decorations field", () => {
    expect(parseFrameSpec({ ...valid, decorations: {} }, "t")?.decorations).toBeUndefined();
  });

  it("keeps a text decoration with its colour and face", () => {
    const text = { id: "t1", text: "Since 2019", position: [0.4, -0.5], size: 0.05 };
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...text, colour: "accent", face: "body" }] }, "t")
        ?.decorations,
    ).toEqual([{ ...text, colour: "accent", face: "body" }]);
  });

  it("keeps an empty text decoration (the inspector's cleared field)", () => {
    const text = { id: "t1", text: "", position: [0, 0], size: 0.05 };
    expect(parseFrameSpec({ ...valid, decorations: [text] }, "t")?.decorations).toEqual([text]);
  });

  it("drops a text decoration's bad colour and face, keeping the decoration", () => {
    const text = { id: "t1", text: "Hi", position: [0, 0], size: 0.05 };
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...text, colour: "nope", face: "mono" }] }, "t")
        ?.decorations,
    ).toEqual([text]);
  });

  it("keeps a text decoration's font and clamps its line spacing", () => {
    const text = { id: "t1", text: "Hi", position: [0, 0], size: 0.05 };
    expect(
      parseFrameSpec(
        { ...valid, decorations: [{ ...text, font: "Georgia@600", lineHeight: 1.4 }] },
        "t",
      )?.decorations,
    ).toEqual([{ ...text, font: "Georgia@600", lineHeight: 1.4 }]);
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...text, lineHeight: 9 }] }, "t")?.decorations,
    ).toEqual([{ ...text, lineHeight: 2 }]);
    expect(
      parseFrameSpec({ ...valid, decorations: [{ ...text, font: "", lineHeight: "x" }] }, "t")
        ?.decorations,
    ).toEqual([text]);
  });

  it("ignores shape on a text decoration and colour/face on an image one", () => {
    const spec = parseFrameSpec(
      {
        ...valid,
        decorations: [
          { id: "t1", text: "Hi", position: [0, 0], size: 0.05, shape: "circle" },
          { ...deco, colour: "accent", face: "body" },
        ],
      },
      "t",
    );
    expect(spec?.decorations).toEqual([
      { id: "t1", text: "Hi", position: [0, 0], size: 0.05 },
      deco,
    ]);
  });

  it("drops a decoration carrying both src and text, or neither", () => {
    const spec = parseFrameSpec(
      {
        ...valid,
        decorations: [
          { ...deco, text: "both" },
          { id: "empty", position: [0, 0], size: 0.1 },
          deco,
        ],
      },
      "t",
    );
    expect(spec?.decorations).toEqual([deco]);
  });
});

describe("parseFrameSpec chart slot", () => {
  it("takes a bare true as presence on the defaults", () => {
    expect(parseFrameSpec({ ...valid, chart: true }, "t")?.chart).toEqual({});
  });

  it("takes false as the off switch, so a scene can drop an inherited slot", () => {
    expect(parseFrameSpec({ ...valid, chart: false }, "t")?.chart).toEqual({ enabled: false });
  });

  it("keeps the layout options", () => {
    const spec = parseFrameSpec({ ...valid, chart: { height: 0.4, position: "replace" } }, "t");
    expect(spec?.chart).toEqual({ height: 0.4, position: "replace" });
  });

  it("drops a non-finite height and an unknown position, keeping the slot itself", () => {
    const spec = parseFrameSpec(
      { ...valid, chart: { height: Number.NaN, position: "beside" } },
      "t",
    );
    expect(spec?.chart).toEqual({});
  });

  it("drops a slot that is neither a boolean nor an object", () => {
    expect(parseFrameSpec({ ...valid, chart: "yes" }, "t")?.chart).toBeUndefined();
    expect(parseFrameSpec({ ...valid, chart: [true] }, "t")?.chart).toBeUndefined();
  });

  it("leaves the slot absent when the frame doesn't ask for one", () => {
    expect(parseFrameSpec(valid, "t")?.chart).toBeUndefined();
  });
});

describe("parseFrameSpec flags", () => {
  it("records only an explicit opt-out, so absent means on", () => {
    expect(parseFrameSpec({ ...valid, enabled: false }, "t")?.enabled).toBe(false);
    expect(parseFrameSpec({ ...valid, enabled: true }, "t")?.enabled).toBeUndefined();
    expect(parseFrameSpec({ ...valid, claimsSceneText: false }, "t")?.claimsSceneText).toBe(false);
    expect(parseFrameSpec(valid, "t")?.claimsSceneText).toBeUndefined();
  });

  it("validates textAlign against the scene vocabulary", () => {
    expect(parseFrameSpec({ ...valid, textAlign: "right" }, "t")?.textAlign).toBe("right");
    expect(parseFrameSpec({ ...valid, textAlign: "justify" }, "t")?.textAlign).toBeUndefined();
  });
});

describe("parseFrameOverride", () => {
  it("accepts an override with no cutout, so a scene can restyle without restating the shape", () => {
    expect(parseFrameOverride({ background: "accent" }, "t")).toEqual({ background: "accent" });
  });

  it("still requires a cutout on a deck frame", () => {
    expect(parseFrameSpec({ background: "accent" }, "t")).toBeUndefined();
  });

  it("drops a malformed cutout but keeps the rest of the override", () => {
    const spec = parseFrameOverride({ cutout: { shape: "blob" }, background: "accent" }, "t");
    expect(spec).toEqual({ background: "accent" });
  });
});

describe("mergeFrameSpec", () => {
  const base = parseFrameSpec({ ...valid, background: "accent", icon: "🚀" }, "t");

  it("returns whichever side exists when the other does not", () => {
    expect(mergeFrameSpec(base, undefined)).toBe(base);
    expect(mergeFrameSpec(undefined, undefined)).toBeUndefined();
  });

  it("lets a scene override single fields while inheriting the rest", () => {
    const merged = mergeFrameSpec(base, parseFrameOverride({ background: "#000" }, "t"));
    expect(merged?.background).toBe("#000");
    expect(merged?.icon).toBe("🚀");
  });

  it("inherits the deck cutout when the override omits one", () => {
    const deck = parseFrameSpec({ cutout: { shape: "squircle", size: 0.7 } }, "t");
    const merged = mergeFrameSpec(deck, parseFrameOverride({ background: "#000" }, "t"));
    expect(merged?.cutout).toEqual({ shape: "squircle", size: 0.7 });
  });

  it("replaces the cutout outright, so a new shape cannot inherit a foreign radius", () => {
    const withRadius = parseFrameSpec({ cutout: { shape: "rounded-rect", radius: 0.9 } }, "t");
    const merged = mergeFrameSpec(
      withRadius,
      parseFrameOverride({ cutout: { shape: "circle" } }, "t"),
    );
    expect(merged?.cutout).toEqual({ shape: "circle" });
  });

  it("cannot invent a frame from an override alone when there is no deck default", () => {
    expect(
      mergeFrameSpec(undefined, parseFrameOverride({ background: "#000" }, "t")),
    ).toBeUndefined();
    expect(mergeFrameSpec(undefined, parseFrameOverride(valid, "t"))?.cutout.shape).toBe(
      "rounded-rect",
    );
  });

  it("replaces an inherited chart slot outright rather than merging its options", () => {
    const deck = parseFrameSpec({ ...valid, chart: { height: 0.3, position: "replace" } }, "t");
    const merged = mergeFrameSpec(deck, parseFrameOverride({ chart: { height: 0.7 } }, "t"));
    expect(merged?.chart).toEqual({ height: 0.7 });
  });

  it("lets a scene switch off a deck chart slot while keeping the panel", () => {
    const deck = parseFrameSpec({ ...valid, chart: true }, "t");
    const merged = mergeFrameSpec(deck, parseFrameOverride({ chart: false }, "t"));
    expect(merged?.chart).toEqual({ enabled: false });
    expect(merged?.cutout.shape).toBe("rounded-rect");
  });

  it("lets a scene opt out of an inherited deck frame", () => {
    const merged = mergeFrameSpec(base, parseFrameOverride({ enabled: false }, "t"));
    expect(merged?.enabled).toBe(false);
  });
});
