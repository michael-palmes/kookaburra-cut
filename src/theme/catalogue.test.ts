import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_THEME_CATALOGUE,
  countThemesByCategory,
  discoverBuiltinThemeCatalogue,
  filterThemeCatalogue,
  MY_THEMES_COLLECTION,
  parseThemeCatalogueMetadata,
  searchThemeCatalogue,
  THEME_CATEGORIES,
  THEME_LINEUP,
} from "./catalogue";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function syntheticDoc(index: number) {
  const id = `synthetic-${String(index).padStart(3, "0")}`;
  const category = THEME_CATEGORIES[index % THEME_CATEGORIES.length].id;
  return {
    version: 2,
    id,
    name: `Synthetic ${String(index).padStart(3, "0")}`,
    mode: index % 2 === 0 ? "light" : "dark",
    catalogue: {
      category,
      useLabel: `Use case ${index}`,
      tags: [`batch-${index % 5}`, "synthetic"],
      stage: index % 3 === 0 ? "physical" : index % 3 === 1 ? "lighting-only" : "none",
      order: 100 - index,
    },
    colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#888888" },
    typography: { headline: "Inter", body: "Inter", scale: 1.25 },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
  };
}

describe("theme catalogue definitions", () => {
  it("keeps style collections in their decided order", () => {
    expect(THEME_CATEGORIES.map(({ label }) => label)).toEqual([
      "Essentials",
      "Studio",
      "Colour",
      "Retro",
    ]);
    expect(MY_THEMES_COLLECTION).toEqual({ id: "my-themes", label: "My themes" });
  });

  it("defaults hidden to false and rejects incomplete metadata", () => {
    expect(
      parseThemeCatalogueMetadata(
        {
          category: "essentials",
          useLabel: "Product launches",
          tags: ["Product", "product", " launch "],
          stage: "lighting-only",
        },
        "test",
      ),
    ).toEqual({
      category: "essentials",
      useLabel: "Product launches",
      tags: ["product", "launch"],
      stage: "lighting-only",
      hidden: false,
      order: Number.MAX_SAFE_INTEGER,
    });
    expect(
      parseThemeCatalogueMetadata(
        { category: "essentials", useLabel: "Missing tags", stage: "none" },
        "test",
      ),
    ).toBeUndefined();
    expect(
      parseThemeCatalogueMetadata(
        { category: "unknown", useLabel: "Unknown", tags: [], stage: "none" },
        "test",
      ),
    ).toBeUndefined();
  });
});

describe("bundled theme catalogue", () => {
  it("discovers every file with unique ids matching its filename", () => {
    expect(BUILTIN_THEME_CATALOGUE).toHaveLength(58);
    expect(new Set(BUILTIN_THEME_CATALOGUE.map(({ id }) => id))).toHaveLength(58);
    for (const entry of BUILTIN_THEME_CATALOGUE) {
      expect(entry.filename).toBe(`${entry.id}.json`);
      expect(entry.theme.id).toBe(entry.id);
    }
  });

  it("hides the fallbacks and every retired theme, which still resolve", () => {
    const hidden = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE, { includeHidden: true })
      .filter(({ catalogue }) => catalogue.hidden)
      .map(({ id }) => id);
    expect(hidden).toHaveLength(36);
    expect(hidden).toContain("kookaburra-default");
    expect(hidden).toContain("kookaburra-studio-white");
    expect(hidden).toContain("kookaburra-velvet-physics");
    expect(THEME_LINEUP).toEqual([
      "kookaburra-daylight",
      "kookaburra-onyx",
      "kookaburra-ivory",
      "kookaburra-ink",
      "kookaburra-afterglow",
      "kookaburra-blue-hour",
      "kookaburra-soft-field",
      "kookaburra-frost",
      "kookaburra-lilac",
      "kookaburra-moss",
      "kookaburra-sage",
      "kookaburra-sky",
      "kookaburra-blush",
      "kookaburra-citrus",
      "kookaburra-tangerine",
      "kookaburra-lagoon",
      "kookaburra-basel",
      "kookaburra-hi-fi",
      "kookaburra-mid-century",
      "kookaburra-canyon",
      "kookaburra-mainframe",
      "kookaburra-night-drive",
    ]);
  });

  it("carries complete Essentials metadata and honest stage states", () => {
    const essentials = BUILTIN_THEME_CATALOGUE.filter(
      ({ catalogue }) => catalogue.category === "essentials",
    );
    for (const { catalogue } of essentials) {
      expect(catalogue.category).toBe("essentials");
      expect(catalogue.useLabel.length).toBeGreaterThan(0);
      expect(catalogue.tags.length).toBeGreaterThan(0);
    }
    const byId = Object.fromEntries(BUILTIN_THEME_CATALOGUE.map((entry) => [entry.id, entry]));
    expect(byId["kookaburra-studio-white"]?.catalogue.stage).toBe("lighting-only");
    expect(byId["kookaburra-studio-white"]?.theme.backdrop).toBeUndefined();
    expect(byId["kookaburra-studio-white"]?.theme.lighting).toBeDefined();
    expect(byId["kookaburra-midnight"]?.catalogue.stage).toBe("lighting-only");
    expect(byId["kookaburra-neon"]?.catalogue.stage).toBe("lighting-only");
    expect(byId["kookaburra-midnight"]?.theme.backdrop).toBeUndefined();
    expect(byId["kookaburra-midnight"]?.theme.lighting).toBeDefined();
    expect(byId["kookaburra-default"]?.catalogue.stage).toBe("none");
    expect(byId["kookaburra-default"]?.theme.lighting).toBeUndefined();
    const physical = BUILTIN_THEME_CATALOGUE.filter(
      ({ catalogue }) => catalogue.stage === "physical",
    );
    expect(physical).toHaveLength(7);
    expect(physical.every(({ theme }) => theme.backdrop !== undefined)).toBe(true);
  });

  it("searches names, labels, tags and categories with stable ordering", () => {
    expect(
      searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "editorial serif", {
        category: "essentials",
      }).map((e) => e.id),
    ).toEqual(["kookaburra-ivory", "kookaburra-ink"]);
    expect(searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "1980s").map((e) => e.id)).toEqual([
      "kookaburra-mainframe",
      "kookaburra-night-drive",
    ]);
    expect(searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "1970s").map((e) => e.id)).toEqual([
      "kookaburra-hi-fi",
      "kookaburra-canyon",
    ]);
    expect(searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "legacy")).toEqual([]);
    expect(
      searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "legacy", { includeHidden: true }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["kookaburra-default", "kookaburra-fx"]);
    expect(
      filterThemeCatalogue(BUILTIN_THEME_CATALOGUE, {
        category: "essentials",
        mode: "dark",
      }).map((e) => e.id),
    ).toEqual(["kookaburra-onyx", "kookaburra-ink"]);
  });

  it("counts visible and hidden entries without dropping empty categories", () => {
    expect(countThemesByCategory(BUILTIN_THEME_CATALOGUE)).toEqual({
      essentials: 4,
      studio: 6,
      colour: 6,
      retro: 6,
    });
    expect(countThemesByCategory(BUILTIN_THEME_CATALOGUE, { includeHidden: true }).essentials).toBe(
      40,
    );
  });
});

describe("scalable bundled discovery", () => {
  it("discovers, sorts, searches and counts a synthetic set of 100", () => {
    const modules = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const doc = syntheticDoc(index);
        return [`./builtin/${doc.id}.json`, index % 2 === 0 ? doc : { default: doc }];
      }),
    );
    const entries = discoverBuiltinThemeCatalogue(modules);
    expect(entries).toHaveLength(100);
    expect(new Set(entries.map(({ id }) => id))).toHaveLength(100);
    expect(entries.slice(0, 3).map(({ id }) => id)).toEqual([
      "synthetic-096",
      "synthetic-092",
      "synthetic-088",
    ]);
    expect(searchThemeCatalogue(entries, "batch-4 synthetic")).toHaveLength(20);
    expect(
      Object.values(countThemesByCategory(entries)).reduce((sum, count) => sum + count, 0),
    ).toBe(100);
  });

  it("rejects duplicate ids and filename mismatches", () => {
    const first = syntheticDoc(1);
    expect(() =>
      discoverBuiltinThemeCatalogue({
        "./builtin/synthetic-001.json": first,
        "./other/synthetic-001.json": first,
      }),
    ).toThrow('Duplicate bundled theme id "synthetic-001"');
    expect(() =>
      discoverBuiltinThemeCatalogue({ "./builtin/not-the-id.json": syntheticDoc(2) }),
    ).toThrow("expected not-the-id");
  });

  it("refuses a bundled theme that extends another", () => {
    expect(() =>
      discoverBuiltinThemeCatalogue({
        "./builtin/synthetic-003.json": { ...syntheticDoc(3), extends: "kookaburra-default" },
      }),
    ).toThrow("can't extend another theme");
  });
});
