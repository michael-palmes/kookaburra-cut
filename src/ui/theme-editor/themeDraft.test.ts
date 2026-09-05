import { describe, expect, it } from "vitest";
import { parseThemeCatalogueMetadata } from "../../theme/catalogue";
import {
  addTag,
  canonicalJson,
  DEFAULT_SUN,
  defaultGradientStops,
  duplicateThemeDoc,
  EFFECT_DEFAULTS,
  environmentPath,
  FALLBACK_USE_LABEL,
  firstGradientName,
  getIn,
  isDirty,
  parseThemeDraft,
  readBackdropKind,
  readBackgroundKind,
  readEffect,
  readEnvironment,
  readFills,
  readGradients,
  readIdentity,
  readSun,
  removeTag,
  renameGradient,
  serialiseThemeDoc,
  setIn,
  setSunEnabled,
  sunPath,
  type ThemeDoc,
  themeScope,
  uniqueGradientName,
  writeChartColours,
  writeEffect,
  writeEnvironment,
  writeFills,
  writeGradients,
  writeIdentity,
  writeStageGradient,
  writeSun,
} from "./themeDraft";

const base = (): ThemeDoc => ({
  version: 2,
  id: "demo",
  name: "Demo",
  mode: "dark",
  catalogue: {
    category: "essentials",
    useLabel: "A demo",
    tags: ["demo"],
    stage: "none",
    order: 10,
  },
  colors: { background: "#0b0f14", text: "#ffffff", accent: "#3ad1c4", muted: "#8a97a6" },
  typography: { headline: "Inter", body: { family: "Inter", weight: 400 }, scale: 1.25 },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outQuad", emphasized: "outExpo" },
  },
  // An imaginary block from a newer build; nothing in the editor knows it exists.
  futureBlock: { keep: "me" },
});

describe("themeScope", () => {
  it("splits workspace ids from bundled ones", () => {
    expect(themeScope("ws:studio-white")).toEqual({ kind: "workspace", slug: "studio-white" });
    expect(themeScope("aurora")).toEqual({ kind: "bundled", id: "aurora" });
  });
});

describe("setIn", () => {
  it("patches a nested leaf without touching siblings", () => {
    const next = setIn(base(), ["colors", "accent"], "#ff0000");
    expect(getIn(next, ["colors", "accent"])).toBe("#ff0000");
    expect(getIn(next, ["colors", "muted"])).toBe("#8a97a6");
    expect(next.futureBlock).toEqual({ keep: "me" });
  });

  it("creates missing objects on the way down", () => {
    expect(getIn(setIn({}, ["card", "radius"], 0.2), ["card", "radius"])).toBe(0.2);
  });

  it("drops a parent left empty by deleting its last leaf", () => {
    const doc = setIn({ card: { radius: 0.2 } }, ["card", "radius"], undefined);
    expect(doc).toEqual({});
  });

  it("keeps a parent that still has other keys", () => {
    const doc = setIn({ card: { radius: 0.2, other: 1 } }, ["card", "radius"], undefined);
    expect(doc).toEqual({ card: { other: 1 } });
  });
});

describe("canonicalJson and isDirty", () => {
  it("ignores key order, so a native rewrite is not an edit", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    const saved = JSON.stringify({ b: 1, a: { d: 4, c: 3 } });
    expect(isDirty({ a: { c: 3, d: 4 }, b: 1 }, saved)).toBe(false);
  });

  it("sees a real change", () => {
    expect(isDirty({ a: 1 }, JSON.stringify({ a: 2 }))).toBe(true);
  });

  it("treats an unreadable saved text as dirty", () => {
    expect(isDirty({ a: 1 }, "not json")).toBe(true);
  });
});

describe("serialiseThemeDoc", () => {
  it("emits pretty JSON with a trailing newline", () => {
    expect(serialiseThemeDoc({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("identity", () => {
  it("reads the catalogue block", () => {
    expect(readIdentity(base())).toEqual({
      name: "Demo",
      mode: "dark",
      category: "essentials",
      tags: ["demo"],
      useLabel: "A demo",
      order: 10,
      hidden: false,
    });
  });

  it("rewrites the catalogue whole, so a one-field edit still parses", () => {
    const next = writeIdentity(base(), { useLabel: "Something else" });
    expect(getIn(next, ["catalogue", "useLabel"])).toBe("Something else");
    expect(getIn(next, ["catalogue", "category"])).toBe("essentials");
    expect(getIn(next, ["catalogue", "stage"])).toBe("none");
    expect(getIn(next, ["catalogue", "tags"])).toEqual(["demo"]);
  });

  it("seeds a stage for a document that has no catalogue block at all", () => {
    const doc = writeIdentity({ name: "Fresh" }, { useLabel: "New" });
    expect(getIn(doc, ["catalogue", "stage"])).toBe("none");
    expect(getIn(doc, ["catalogue", "category"])).toBe("essentials");
  });

  it("never writes a blank use label, which would drop the whole catalogue block", () => {
    const doc = writeIdentity({ name: "Fresh" }, { name: "Renamed" });
    expect(getIn(doc, ["catalogue", "useLabel"])).toBe(FALLBACK_USE_LABEL);
    expect(parseThemeCatalogueMetadata(getIn(doc, ["catalogue"]), "fresh")?.category).toBe(
      "essentials",
    );
  });

  it("clears order and hidden rather than writing null", () => {
    const next = writeIdentity(base(), { order: null, hidden: false });
    expect(getIn(next, ["catalogue", "order"])).toBeUndefined();
    expect(getIn(next, ["catalogue", "hidden"])).toBeUndefined();
  });

  it("keeps an entered order valid for the catalogue parser", () => {
    const doc = writeIdentity(base(), { order: 1.5 });
    expect(parseThemeCatalogueMetadata(doc.catalogue, "demo")?.order).toBe(2);
  });

  it("de-duplicates tags case-insensitively", () => {
    expect(addTag(["Demo"], "demo")).toEqual(["Demo"]);
    expect(addTag(["Demo"], "  quiet ")).toEqual(["Demo", "quiet"]);
    expect(addTag(["Demo"], "   ")).toEqual(["Demo"]);
    expect(removeTag(["Demo", "quiet"], "Demo")).toEqual(["quiet"]);
  });
});

describe("chart colours", () => {
  it("drops the key when the list empties, rather than writing an empty palette", () => {
    expect(writeChartColours(base(), []).chartColors).toBeUndefined();
    expect(writeChartColours(base(), ["#111111"]).chartColors).toEqual(["#111111"]);
  });
});

describe("gradients", () => {
  it("keeps stage references and extra gradient fields when renamed or removed", () => {
    const gradient = { type: "linear", angleDeg: 30, stops: defaultGradientStops(), future: 1 };
    const doc: ThemeDoc = {
      gradients: { brand: gradient },
      backdrop: { type: "gradient", gradient: "brand" },
      background: {
        type: "scene3d",
        look: "demo",
        backing: { type: "gradient", gradient: "brand" },
      },
    };
    const renamed = renameGradient(doc, "brand", "studio");
    expect(getIn(renamed, ["gradients", "studio"])).toEqual(gradient);
    expect(getIn(renamed, ["backdrop", "gradient"])).toBe("studio");
    expect(getIn(renamed, ["background", "backing", "gradient"])).toBe("studio");
    const edited = writeGradients(
      renamed,
      readGradients(renamed).map((entry) => ({ ...entry, angleDeg: 45 })),
    );
    expect(getIn(edited, ["gradients", "studio", "future"])).toBe(1);
    const removed = writeGradients(edited, []);
    expect(getIn(removed, ["backdrop", "gradient"])).toBeUndefined();
    expect(getIn(removed, ["backdrop", "spec", "angleDeg"])).toBe(45);
    expect(getIn(removed, ["background", "backing", "spec", "angleDeg"])).toBe(45);
  });

  it("replaces the inline spec when a named stage gradient is chosen", () => {
    for (const key of ["background", "backdrop"] as const) {
      const next = writeStageGradient(
        { [key]: { type: "gradient", spec: { old: true }, parallax: 0.2 } },
        key,
        "brand",
      );
      expect(next[key]).toEqual({ type: "gradient", gradient: "brand", parallax: 0.2 });
    }
  });
  it("round-trips through the list form", () => {
    const doc = writeGradients(base(), [
      {
        name: "brand",
        type: "linear",
        angleDeg: 135,
        stops: [
          ["#000000", 0],
          ["#ffffff", 1],
        ],
      },
    ]);
    expect(readGradients(doc)).toEqual([
      {
        name: "brand",
        type: "linear",
        angleDeg: 135,
        stops: [
          ["#000000", 0],
          ["#ffffff", 1],
        ],
      },
    ]);
    expect(writeGradients(doc, []).gradients).toBeUndefined();
  });

  it("repairs an entry the schema would drop, so the form can fix it", () => {
    const [entry] = readGradients({ gradients: { broken: { type: "linear" } } });
    expect(entry.stops).toHaveLength(2);
  });

  it("keeps gradient names unique", () => {
    const entries = readGradients(
      writeGradients({}, [
        {
          name: "brand",
          type: "linear",
          angleDeg: 0,
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
      ]),
    );
    expect(uniqueGradientName(entries, "brand")).toBe("brand-2");
    expect(uniqueGradientName(entries, "brand", 0)).toBe("brand");
  });
});

describe("parseThemeDraft", () => {
  it("resolves a valid document without warnings", () => {
    const { theme, warnings } = parseThemeDraft(base(), "demo");
    expect(theme?.colors.accent).toBe("#3ad1c4");
    expect(warnings).toEqual([]);
  });

  it("surfaces a dropped optional block instead of letting it vanish into the console", () => {
    const doc = setIn(base(), ["card"], { radius: 9 });
    const { theme, warnings } = parseThemeDraft(doc, "demo");
    expect(theme?.card).toBeUndefined();
    expect(warnings.join(" ")).toContain("card");
  });

  it("returns no theme when a required block is invalid", () => {
    const doc = setIn(base(), ["colors"], { background: "#000000" });
    expect(parseThemeDraft(doc, "demo").theme).toBeUndefined();
  });

  it("restores console.warn afterwards", () => {
    const before = console.warn;
    parseThemeDraft(setIn(base(), ["card"], { radius: 9 }), "demo");
    expect(console.warn).toBe(before);
  });
});

describe("stage blocks", () => {
  it("recognises the image background used by shipped static themes", () => {
    expect(
      readBackgroundKind({ background: { type: "image", src: "kookaburra:linen-intelligence" } }),
    ).toBe("image");
  });
  it("reads an absent and an explicit-none block as the same off state", () => {
    expect(readBackdropKind(base())).toBe("off");
    expect(readBackdropKind(setIn(base(), ["backdrop"], { type: "none" }))).toBe("off");
    expect(readBackdropKind(setIn(base(), ["backdrop"], { type: "floor", color: "#fff" }))).toBe(
      "floor",
    );
    expect(
      readBackgroundKind(setIn(base(), ["background"], { type: "shader", shader: "warp" })),
    ).toBe("shader");
    expect(readBackgroundKind(setIn(base(), ["background"], { type: "video", src: "a.mp4" }))).toBe(
      "off",
    );
  });

  it("names the first gradient a backdrop can reference", () => {
    expect(firstGradientName(base())).toBeNull();
    const withGradients = writeGradients(base(), [
      { name: "backdrop", type: "linear", angleDeg: 0, stops: defaultGradientStops() },
    ]);
    expect(firstGradientName(withGradients)).toBe("backdrop");
  });
});

describe("lighting blocks", () => {
  it("switches the sun off without dropping ambient or fills, then restores its settings", () => {
    const doc = setIn(base(), ["lighting"], {
      key: { azimuthDeg: 23, elevationDeg: 45, intensity: 3, kelvin: 3200 },
      ambient: 0.4,
      fills: [{ azimuthDeg: -40, elevationDeg: 10, intensity: 0.6 }],
    });
    const off = setSunEnabled(doc, false);
    const rig = parseThemeDraft(off, "demo").theme?.lighting;
    expect(rig?.sun?.enabled).toBe(false);
    expect(rig?.ambient).toBe(0.4);
    expect(rig?.fills).toHaveLength(1);
    const on = setSunEnabled(off, true);
    expect(parseThemeDraft(on, "demo").theme?.lighting?.sun).toMatchObject({
      azimuthDeg: 23,
      intensity: 3,
      kelvin: 3200,
    });
    expect(readSun(on)?.enabled).toBe(true);
  });
  it("adds a renderable sun to a theme that had no lighting", () => {
    const next = writeSun(base(), DEFAULT_SUN);
    expect(parseThemeDraft(next, "demo").theme?.lighting?.sun?.intensity).toBe(
      DEFAULT_SUN.intensity,
    );
    expect(getIn(next, ["lighting", "ambient"])).toBe(0);
  });
  it("turns off both sun aliases instead of reviving the legacy key", () => {
    const next = writeSun(
      { lighting: { sun: { intensity: 2 }, key: { intensity: 1 }, ambient: 0.5 } },
      null,
    );
    expect(next.lighting).toEqual({ ambient: 0.5 });
  });

  it("keeps extra environment and fill fields when changing intensity", () => {
    const doc: ThemeDoc = {
      environment: {
        source: "kookaburra:softbox",
        intensity: 1,
        rotationDeg: 0,
        future: "environment",
      },
      lighting: { fills: [{ azimuthDeg: 0, elevationDeg: 30, intensity: 1, future: "fill" }] },
    };
    expect(getIn(writeEnvironment(doc, { intensity: 2 }), ["environment", "future"])).toBe(
      "environment",
    );
    const next = writeFills(
      doc,
      readFills(doc).map((fill) => ({ ...fill, intensity: 2 })),
    );
    expect((getIn(next, ["lighting", "fills"]) as ThemeDoc[])[0].future).toBe("fill");
  });
  it("retains sun Kelvin and token fields when intensity changes", () => {
    const doc: ThemeDoc = {
      lighting: {
        sun: {
          azimuthDeg: 10,
          elevationDeg: 40,
          intensity: 2,
          kelvin: 3200,
          colorToken: "accent",
          future: 1,
        },
        lights: [
          {
            id: "spot",
            name: "Warm rim",
            type: "spot",
            intensity: 3,
            kelvin: 2900,
            colorToken: "accent",
            target: [1, 2, 3],
            distance: 12,
            decay: 1.5,
            angleDeg: 45,
            penumbra: 0.4,
            placement: { mode: "point", position: [3, 4, 5] },
            future: 2,
          },
        ],
      },
    };
    const sun = readSun(doc);
    if (!sun) throw new Error("Expected a parsed sun");
    const changedSun = writeSun(doc, { ...sun, intensity: 4 });
    expect(getIn(changedSun, ["lighting", "sun"])).toMatchObject({
      intensity: 4,
      kelvin: 3200,
      colorToken: "accent",
      future: 1,
    });
  });
  const v8 = () =>
    setIn(base(), ["lighting"], {
      key: { azimuthDeg: 20, elevationDeg: 40, intensity: 3, color: "#fff5e8" },
      ambient: 0.4,
      fills: [{ azimuthDeg: -50, elevationDeg: 10, intensity: 0.8, color: "#cfe4ff" }],
    });

  it("writes the key light back to the spelling the file already uses", () => {
    expect(sunPath(v8())).toEqual(["lighting", "key"]);
    expect(sunPath(base())).toEqual(["lighting", "sun"]);
    const patched = writeSun(v8(), { ...DEFAULT_SUN, intensity: 5 });
    expect(getIn(patched, ["lighting", "key", "intensity"])).toBe(5);
    expect(getIn(patched, ["lighting", "sun"])).toBeUndefined();
  });

  it("keeps engine defaults out of the file and round-trips the rest", () => {
    const sun = readSun(v8());
    expect(sun).toMatchObject({
      azimuthDeg: 20,
      castShadow: true,
      enabled: true,
      angularDeg: null,
    });
    const written = getIn(writeSun(v8(), { ...DEFAULT_SUN, castShadow: false }), [
      "lighting",
      "key",
    ]);
    expect(written).toMatchObject({ castShadow: false });
    expect(Object.keys(written as object)).not.toContain("angularDeg");
  });

  it("edits whichever environment block is the live one", () => {
    expect(environmentPath(base())).toEqual(["environment"]);
    const v9 = setIn(base(), ["lighting", "environment"], { source: "kookaburra:dawn" });
    expect(environmentPath(v9)).toEqual(["lighting", "environment"]);
    expect(readEnvironment(v9)).toEqual({
      source: "kookaburra:dawn",
      intensity: 1,
      rotationDeg: 0,
    });
    expect(
      getIn(writeEnvironment(v9, { source: "" }), ["lighting", "environment"]),
    ).toBeUndefined();
  });

  it("removes an emptied fill list", () => {
    expect(readFills(v8())).toHaveLength(1);
    expect(getIn(writeFills(v8(), []), ["lighting", "fills"])).toBeUndefined();
  });
});

describe("effects blocks", () => {
  it("retains extra effect fields when an existing control changes", () => {
    const doc = { effects: { grain: { intensity: 0.1, future: "keep" } } };
    expect(getIn(writeEffect(doc, "grain", { intensity: 0.2 }), ["effects", "grain"])).toEqual({
      intensity: 0.2,
      future: "keep",
    });
  });
  it("writes an effect whole and deletes it rather than zeroing it", () => {
    expect(readEffect(base(), "bloom")).toBeNull();
    const on = writeEffect(base(), "bloom", { ...EFFECT_DEFAULTS.bloom, intensity: 1.4 });
    expect(readEffect(on, "bloom")).toEqual({
      intensity: 1.4,
      luminanceThreshold: 0.6,
      luminanceSmoothing: 0.2,
    });
    expect(getIn(writeEffect(on, "bloom", null), ["effects"])).toBeUndefined();
  });
});

describe("duplicateThemeDoc", () => {
  it("copies the document, restamps it and keeps the catalogue block", () => {
    const source = setIn(base(), ["catalogue", "hidden"], true);
    const copy = duplicateThemeDoc(source, "my-copy", "My copy");
    expect(copy.id).toBe("my-copy");
    expect(copy.name).toBe("My copy");
    expect(copy.catalogue).toEqual({
      category: "essentials",
      useLabel: "A demo",
      tags: ["demo"],
      stage: "none",
      order: 10,
    });
    expect(parseThemeCatalogueMetadata(copy.catalogue, "copy")?.hidden).toBe(false);
    // The source is untouched: the browser hands over the globbed document itself.
    expect(getIn(source, ["catalogue", "hidden"])).toBe(true);
  });
});
