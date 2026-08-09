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
  it("keeps use-case collections in their decided order", () => {
    expect(THEME_CATEGORIES.map(({ label }) => label)).toEqual([
      "Essentials",
      "Quiet technology",
      "Human-centred AI",
      "Maker energy",
      "Sensory and surreal",
      "Digital assets",
      "Modern finance",
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
    expect(BUILTIN_THEME_CATALOGUE).toHaveLength(36);
    expect(new Set(BUILTIN_THEME_CATALOGUE.map(({ id }) => id))).toHaveLength(36);
    for (const entry of BUILTIN_THEME_CATALOGUE) {
      expect(entry.filename).toBe(`${entry.id}.json`);
      expect(entry.theme.id).toBe(entry.id);
    }
  });

  it("keeps only legacy fallbacks hidden", () => {
    const hidden = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE, { includeHidden: true })
      .filter(({ catalogue }) => catalogue.hidden)
      .map(({ id }) => id);
    expect(hidden).toEqual(["kookaburra-default", "kookaburra-fx"]);
    expect(THEME_LINEUP).toHaveLength(34);
    expect(THEME_LINEUP.slice(0, 10)).toEqual([
      "kookaburra-studio-white",
      "kookaburra-pacific",
      "kookaburra-paper",
      "kookaburra-gallery",
      "kookaburra-sunrise",
      "kookaburra-loft",
      "kookaburra-midnight",
      "kookaburra-neon",
      "kookaburra-abyss",
      "kookaburra-ember",
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
    expect(byId["kookaburra-midnight"]?.catalogue.stage).toBe("lighting-only");
    expect(byId["kookaburra-neon"]?.catalogue.stage).toBe("lighting-only");
    expect(byId["kookaburra-midnight"]?.theme.backdrop).toBeUndefined();
    expect(byId["kookaburra-midnight"]?.theme.lighting).toBeDefined();
    expect(byId["kookaburra-default"]?.catalogue.stage).toBe("none");
    expect(byId["kookaburra-default"]?.theme.lighting).toBeUndefined();
    const physical = BUILTIN_THEME_CATALOGUE.filter(
      ({ catalogue }) => catalogue.stage === "physical",
    );
    expect(physical).toHaveLength(8);
    expect(physical.every(({ theme }) => theme.backdrop !== undefined)).toBe(true);
  });

  it("searches names, labels, tags and categories with stable ordering", () => {
    expect(
      searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "editorial explain", {
        category: "essentials",
      }).map((e) => e.id),
    ).toEqual(["kookaburra-paper"]);
    expect(
      searchThemeCatalogue(BUILTIN_THEME_CATALOGUE, "warm story", {
        category: "essentials",
      }).map((e) => e.id),
    ).toEqual(["kookaburra-paper", "kookaburra-ember"]);
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
    ).toEqual(["kookaburra-midnight", "kookaburra-neon", "kookaburra-abyss", "kookaburra-ember"]);
  });

  it("counts visible and hidden entries without dropping empty categories", () => {
    expect(countThemesByCategory(BUILTIN_THEME_CATALOGUE)).toEqual({
      essentials: 10,
      "quiet-technology": 4,
      "human-centred-ai": 4,
      "maker-energy": 4,
      "sensory-and-surreal": 4,
      "digital-assets": 4,
      "modern-finance": 4,
    });
    expect(countThemesByCategory(BUILTIN_THEME_CATALOGUE, { includeHidden: true }).essentials).toBe(
      12,
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
      "synthetic-098",
      "synthetic-091",
      "synthetic-084",
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
});
