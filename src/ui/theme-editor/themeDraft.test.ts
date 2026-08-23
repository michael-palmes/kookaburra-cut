import { describe, expect, it } from "vitest";
import { parseThemeCatalogueMetadata } from "../../theme/catalogue";
import {
  addTag,
  canonicalJson,
  FALLBACK_USE_LABEL,
  getIn,
  isDirty,
  parseThemeDraft,
  readGradients,
  readIdentity,
  removeTag,
  serialiseThemeDoc,
  setIn,
  type ThemeDoc,
  themeScope,
  uniqueGradientName,
  writeChartColours,
  writeGradients,
  writeIdentity,
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
