import { describe, expect, it } from "vitest";
import {
  buildPresetEntry,
  listPresets,
  type PresetCategoryId,
  type PresetEntry,
  type PresetManifest,
  presetCategoryCounts,
  searchPresets,
} from "../engine/presets";
import type { ProjectManifest } from "../engine/project";
import {
  categoryRows,
  effectiveChip,
  insertButtonLabel,
  presetsForPool,
  resolvePresetSelection,
} from "./PresetGalleryModal";

const MANIFEST: PresetManifest = {
  version: 1,
  name: "Stat hero",
  tagline: "A big animated counter.",
  tags: [],
  order: 10,
  status: "stable",
  preview: { scene: 0 },
};

const project: ProjectManifest = {
  id: "stat-hero",
  name: "Stat hero",
  themeId: "kookaburra-noir",
  formats: ["16:9"],
  scenes: [{ file: "scenes/01-stat.tsx", durationMs: 4000 }],
};

const entry = (id: string, category?: PresetCategoryId): PresetEntry =>
  buildPresetEntry(id, { ...MANIFEST, name: id, ...(category ? { category } : {}) }, project);

describe("the shared App and My preset pool", () => {
  it("shows every canonical App entry beside the user's own by default", () => {
    const app = listPresets();
    const mine = entry("ws:my-title");
    const visible = presetsForPool([...app, mine], false);

    expect(visible).toHaveLength(22);
    expect(visible.slice(0, 21)).toEqual(app);
    visible.slice(0, 21).forEach((preset, index) => {
      expect(preset).toBe(app[index]);
    });
    expect(visible[21]).toBe(mine);
    expect(visible.slice(0, 15).map((preset) => preset.id)).toEqual([
      "device",
      "deviceonly",
      "comparison",
      "title",
      "titleicon",
      "appversion",
      "layeredscreenshot",
      "chart",
      "video",
      "image",
      "videowindow",
      "overlaystart",
      "overlayend",
      "overlaypanel",
      "blank",
    ]);
  });

  it("narrows to workspace copies under My presets only, keeping pack entries in the default pool", () => {
    const app = entry("title");
    const mine = entry("ws:title");
    const pack = { ...entry("pack-title"), source: "pack" as const };

    expect(presetsForPool([app, mine, pack], false)).toEqual([app, mine, pack]);
    expect(presetsForPool([app, mine, pack], true)).toEqual([mine]);
  });
});

describe("preset selection across catalogue updates", () => {
  it("selects nothing before an explicit pick", () => {
    const first = entry("first");
    const selected = entry("selected");

    expect(resolvePresetSelection([first, selected], null)).toBeNull();
    expect(resolvePresetSelection([first, selected], selected.id)).toBe(selected);
    expect(resolvePresetSelection([], null)).toBeNull();
  });

  it("disables insertion after the selected preset is removed instead of substituting another", () => {
    const selected = entry("selected");
    const other = entry("other");
    const updated = [other];

    expect(resolvePresetSelection(updated, selected.id)).toBeNull();
    expect(resolvePresetSelection(updated, other.id)).toBe(other);
  });

  it("follows the picked identity through a reorder", () => {
    const focused = entry("focused");
    const other = entry("other");
    const reordered = [other, focused];

    expect(resolvePresetSelection(reordered, null)).toBeNull();
    expect(resolvePresetSelection(reordered, focused.id)).toBe(focused);
    expect(resolvePresetSelection([other], focused.id)).toBeNull();
  });

  it("retains the selected identity when a rename moves it out of the search results", () => {
    const selected = entry("launch");
    const other = entry("launch-other");
    const renamed = buildPresetEntry(selected.id, { ...MANIFEST, name: "Renamed preset" }, project);
    const updated = [other, renamed];
    const filtered = searchPresets(updated, { query: "launch" });

    expect(filtered).toEqual([other]);
    expect(resolvePresetSelection(filtered, selected.id)).toBeNull();
    expect(resolvePresetSelection(updated, selected.id)).toBe(renamed);
  });
});

describe("the category rail", () => {
  it("lists All first, then only the categories with presets, in catalogue order", () => {
    const counts = presetCategoryCounts([
      entry("closer", "closers"),
      entry("opener", "openers"),
      entry("chart", "stats-charts"),
      entry("loose"),
    ]);
    const rows = categoryRows(counts);

    expect(rows.map((row) => row.id)).toEqual(["all", "openers", "stats-charts", "closers"]);
    expect(rows.map((row) => row.label)).toEqual(["All", "Openers", "Stats & charts", "Closers"]);
    expect(rows.map((row) => row.count)).toEqual([4, 1, 1, 1]);
  });

  it("hides the categories the search empties", () => {
    const counts = presetCategoryCounts(
      [entry("Launch opener", "openers"), entry("Closing line", "closers")],
      { query: "launch" },
    );

    expect(categoryRows(counts).map((row) => row.id)).toEqual(["all", "openers"]);
    expect(categoryRows(counts)[0].count).toBe(1);
  });

  it("falls back to All when the chosen category is emptied, and returns once it fills again", () => {
    const entries = [entry("Launch opener", "openers"), entry("Closing line", "closers")];
    const searched = presetCategoryCounts(entries, { query: "launch" });
    const cleared = presetCategoryCounts(entries);

    expect(effectiveChip("closers", searched)).toBe("all");
    expect(effectiveChip("openers", searched)).toBe("openers");
    expect(effectiveChip("all", searched)).toBe("all");
    expect(effectiveChip("closers", cleared)).toBe("closers");
  });

  it("returns only All for an empty catalogue", () => {
    expect(categoryRows(presetCategoryCounts([]))).toEqual([{ id: "all", label: "All", count: 0 }]);
  });
});

describe("insertButtonLabel", () => {
  const names = ["Headline", "Device 2", "Outro"];

  it("stays generic until a preset is chosen", () => {
    expect(insertButtonLabel(false, 2, names)).toBe("Insert scene");
  });

  it("names the gap once a preset is chosen", () => {
    expect(insertButtonLabel(true, 0, names)).toBe("Insert at the start");
    expect(insertButtonLabel(true, 2, names)).toBe("Insert after Device 2");
    expect(insertButtonLabel(true, 3, names)).toBe("Insert at the end");
  });

  it("keeps the scene name's own casing", () => {
    expect(insertButtonLabel(true, 1, ["ACME launch", "Outro"])).toBe("Insert after ACME launch");
  });
});
