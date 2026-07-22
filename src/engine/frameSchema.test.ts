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

  it("lets a scene opt out of an inherited deck frame", () => {
    const merged = mergeFrameSpec(base, parseFrameOverride({ enabled: false }, "t"));
    expect(merged?.enabled).toBe(false);
  });
});
