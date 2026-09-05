import { describe, expect, it } from "vitest";
import {
  buildPresetEntry,
  canonicalJson,
  comparePresetEntries,
  formatPresetDuration,
  listPresets,
  PRESET_CATEGORIES,
  PRESET_MANIFEST_VERSION,
  type PresetCategoryId,
  type PresetEntry,
  type PresetManifest,
  presetCategoryCounts,
  presetManifestSchema,
  presetPreviewFrame,
  presetProjectId,
  previewContentHash,
  searchPresets,
  sortPresetEntries,
} from "./presets";
import type { ProjectManifest } from "./project";

/** The bundled tree, read the way the registry reads it: a manifest the schema rejects drops out with a warning, and vanishing silently is the failure to catch here. Empty until the starter set is authored, which the folder checks below simply skip. */
const manifestGlob = import.meta.glob<unknown>("../../presets/*/preset.json", {
  eager: true,
  import: "default",
});
const projectGlob = import.meta.glob<ProjectManifest>("../../presets/*/project.json", {
  eager: true,
  import: "default",
});
// Existence only: a lazy glob is a map of loaders, so nothing here is read or decoded.
const sceneModuleGlob = import.meta.glob("../../presets/*/scenes/*.tsx");
const sceneDocGlob = import.meta.glob("../../presets/*/scenes/*.json");

const presetSlugs = Object.keys(manifestGlob)
  .map((key) => key.split("/")[3])
  .sort();

/** The manifest `save_scene_as_preset` writes: no category, an empty tagline, the details modal fills the rest in. */
const MINIMAL: PresetManifest = {
  version: 1,
  name: "Stat hero",
  tagline: "",
  tags: [],
  order: 10,
  status: "stable",
  preview: { scene: 0, atMs: 1500 },
};

const project = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  id: "stat-hero",
  name: "Stat hero",
  themeId: "kookaburra-noir",
  formats: ["16:9", "9:16", "1:1", "4:5"],
  scenes: [{ file: "scenes/01-stat.tsx", durationMs: 4000 }],
  ...over,
});

const entry = (over: Partial<PresetManifest> & { id?: string } = {}): PresetEntry => {
  const { id = "stat-hero", ...manifest } = over;
  return buildPresetEntry(id, { ...MINIMAL, ...manifest }, project());
};

describe("presetManifestSchema", () => {
  it("accepts the manifest a saved scene writes", () => {
    const parsed = presetManifestSchema.safeParse(MINIMAL);
    expect(parsed.success).toBe(true);
  });

  it("accepts every shipped category", () => {
    for (const category of PRESET_CATEGORIES) {
      expect(presetManifestSchema.safeParse({ ...MINIMAL, category: category.id }).success).toBe(
        true,
      );
    }
  });

  it("accepts both preview forms", () => {
    expect(presetManifestSchema.parse({ ...MINIMAL, preview: 0 }).preview).toBe(0);
    expect(presetManifestSchema.parse({ ...MINIMAL, preview: { scene: 0 } }).preview).toEqual({
      scene: 0,
    });
    expect(presetPreviewFrame(presetManifestSchema.parse({ ...MINIMAL, preview: 2 }))).toEqual({
      scene: 2,
    });
  });

  it("rejects an unknown field rather than stripping it", () => {
    const parsed = presetManifestSchema.safeParse({ ...MINIMAL, catagory: "openers" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual({ path: "catagory", message: "unknown field" });
    }
  });

  it("rejects a manifest from a newer build", () => {
    const parsed = presetManifestSchema.safeParse({
      ...MINIMAL,
      version: PRESET_MANIFEST_VERSION + 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("names every bad field at once", () => {
    const parsed = presetManifestSchema.safeParse({
      version: 1,
      name: "",
      tagline: 7,
      category: "openers-ish",
      tags: ["ok", 3],
      order: "10",
      status: "draft",
      source: "downloaded",
      preview: { atMs: 500 },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path).sort()).toEqual([
        "category",
        "name",
        "order",
        "preview",
        "source",
        "status",
        "tagline",
        "tags[1]",
      ]);
    }
  });

  it("rejects anything that isn't an object", () => {
    expect(presetManifestSchema.safeParse(null).success).toBe(false);
    expect(presetManifestSchema.safeParse([MINIMAL]).success).toBe(false);
  });

  it("throws with every issue named when parsing strictly", () => {
    expect(() => presetManifestSchema.parse({}, "hero/preset.json")).toThrow(/hero\/preset\.json/);
  });
});

describe("buildPresetEntry", () => {
  it("derives the card facts from project.json, never the manifest", () => {
    const built = entry();
    expect(built.sceneCount).toBe(1);
    expect(built.durationMs).toBe(4000);
    expect(built.themeId).toBe("kookaburra-noir");
    expect(built.primaryAspect).toBe("16:9");
    expect(built.previewUrl).toBeNull();
  });

  it("routes a bundled preset to a `preset:` project id", () => {
    expect(entry().projectId).toBe("preset:stat-hero");
    expect(entry().source).toBe("bundled");
    expect(presetProjectId("hero")).toBe("preset:hero");
  });

  it("routes a user preset to a `ws-preset:` project id", () => {
    const built = entry({ id: "ws:my-stat" });
    expect(built.slug).toBe("my-stat");
    expect(built.projectId).toBe("ws-preset:my-stat");
    expect(built.source).toBe("user");
  });

  it("takes the native listing's counts when it has them", () => {
    const built = buildPresetEntry("ws:my-stat", MINIMAL, project(), {
      sceneCount: 1,
      durationMs: 2500,
      previewUrl: "asset://poster.jpg",
    });
    expect(built.durationMs).toBe(2500);
    expect(built.previewUrl).toBe("asset://poster.jpg");
  });

  it("indexes name, tagline, tags and the category label for search", () => {
    const built = entry({ name: "Stat hero", tagline: "A big counter", tags: ["Counter"] });
    expect(built.haystack).toContain("stat hero");
    expect(built.haystack).toContain("big counter");
    expect(built.haystack).toContain("counter");
  });
});

describe("preset ordering", () => {
  const of = (id: string, over: Partial<PresetManifest>) => entry({ id, ...over });

  it("sorts by category, then stable before beta, then order, then name", () => {
    const entries = [
      of("d", { category: "closers", order: 10, name: "Sign off" }),
      of("c", { category: "openers", order: 20, name: "Second" }),
      of("b", { category: "openers", order: 10, name: "Beta one", status: "beta" }),
      of("a", { category: "openers", order: 10, name: "First" }),
    ];
    expect(sortPresetEntries(entries).map((e) => e.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("files an uncategorised preset last", () => {
    const entries = [of("loose", {}), of("opener", { category: "openers", order: 10 })];
    expect(sortPresetEntries(entries).map((e) => e.id)).toEqual(["opener", "loose"]);
  });

  it("breaks an order tie on name", () => {
    const a = of("a", { category: "devices", order: 10, name: "Alpha" });
    const b = of("b", { category: "devices", order: 10, name: "Bravo" });
    expect(comparePresetEntries(a, b)).toBeLessThan(0);
    expect(comparePresetEntries(b, a)).toBeGreaterThan(0);
  });
});

describe("searchPresets", () => {
  const entries = [
    entry({ id: "counter", name: "Stat hero", tags: ["counter"], category: "stats-charts" }),
    entry({ id: "handset", name: "Device pane", tags: ["phone"], category: "devices" }),
    entry({ id: "ws:mine", name: "My opener", tags: ["counter"], category: "openers" }),
  ];

  it("matches every whitespace-separated term", () => {
    expect(searchPresets(entries, { query: "stat hero" }).map((e) => e.id)).toEqual(["counter"]);
    expect(searchPresets(entries, { query: "counter" }).map((e) => e.id)).toEqual([
      "counter",
      "ws:mine",
    ]);
    expect(searchPresets(entries, { query: "stat phone" })).toEqual([]);
  });

  it("filters by category and by source", () => {
    expect(searchPresets(entries, { category: "devices" }).map((e) => e.id)).toEqual(["handset"]);
    expect(searchPresets(entries, { source: "user" }).map((e) => e.id)).toEqual(["ws:mine"]);
    expect(searchPresets(entries, {})).toHaveLength(3);
  });

  it("counts each category against the live search", () => {
    const counts = presetCategoryCounts(entries, { query: "counter" });
    expect(counts.all).toBe(2);
    expect(counts.byCategory["stats-charts"]).toBe(1);
    expect(counts.byCategory.openers).toBe(1);
    expect(counts.byCategory.devices).toBe(0);
    expect(counts.uncategorised).toBe(0);
  });

  it("counts an uncategorised preset separately", () => {
    expect(presetCategoryCounts([entry({ id: "loose" })]).uncategorised).toBe(1);
  });
});

describe("formatPresetDuration", () => {
  it("shows seconds under a minute and m:ss above it", () => {
    expect(formatPresetDuration(4000)).toBe("4s");
    expect(formatPresetDuration(75_000)).toBe("1:15");
    expect(formatPresetDuration(-1)).toBe("0s");
  });
});

describe("bundled presets", () => {
  it("registers every folder that carries a preset.json", () => {
    expect(
      listPresets()
        .map((preset) => preset.id)
        .sort(),
    ).toEqual(presetSlugs);
  });

  it("gives every preset a unique order within its category", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const preset of listPresets()) {
      const key = `${preset.category ?? "none"}/${preset.order}`;
      const first = seen.get(key);
      if (first) clashes.push(`${key} in ${first} and ${preset.id}`);
      else seen.set(key, preset.id);
    }
    expect(clashes).toEqual([]);
  });
});

describe("preview content hash", () => {
  it("canonicalises objects by sorted key", () => {
    expect(canonicalJson({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":4}],"b":2}');
  });

  // The golden vector scripts/preset-preview-stale.test.mjs pins too: the app and the
  // ledger writer must digest identically or every bundled card would read as stale.
  it("hashes to the golden vector the ledger script pins", () => {
    expect(
      previewContentHash([
        ["scenes/01.json", { z: [1, 2], a: "x", n: null }],
        ["preset.json", { version: 1, name: "Golden" }],
      ]),
    ).toBe("68cbea3520274af8");
  });

  it("is order-independent across documents", () => {
    const docs: [string, unknown][] = [
      ["preset.json", { version: 1 }],
      ["project.json", { id: "a" }],
    ];
    expect(previewContentHash(docs)).toBe(previewContentHash([...docs].reverse()));
  });
});

describe.skipIf(presetSlugs.length === 0)("each bundled preset", () => {
  it.each(presetSlugs)("%s carries a manifest the schema accepts", (slug) => {
    const parsed = presetManifestSchema.safeParse(
      manifestGlob[`../../presets/${slug}/preset.json`],
      `${slug}/preset.json`,
    );
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    expect(issues).toEqual([]);
  });

  it.each(presetSlugs)("%s is exactly one scene with its sidecar", (slug) => {
    const manifest = projectGlob[`../../presets/${slug}/project.json`];
    expect(manifest?.scenes ?? []).toHaveLength(1);
    const file = manifest?.scenes?.[0]?.file ?? "";
    expect(`../../presets/${slug}/${file}` in sceneModuleGlob).toBe(true);
    expect(`../../presets/${slug}/${file.replace(/\.tsx$/, ".json")}` in sceneDocGlob).toBe(true);
  });

  it.each(presetSlugs)("%s files itself under a known category", (slug) => {
    const category = (manifestGlob[`../../presets/${slug}/preset.json`] as PresetManifest).category;
    const known: readonly string[] = PRESET_CATEGORIES.map((c) => c.id);
    if (category !== undefined) expect(known).toContain(category as PresetCategoryId);
  });

  it.each(presetSlugs)("%s targets every aspect", (slug) => {
    const formats = projectGlob[`../../presets/${slug}/project.json`]?.formats ?? [];
    expect([...formats].sort()).toEqual(["16:9", "9:16", "1:1", "4:5"].sort());
  });
});
