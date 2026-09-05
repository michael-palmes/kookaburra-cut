import { describe, expect, it } from "vitest";
import {
  buildPresetEntry,
  listPresets,
  type PresetCategoryId,
  type PresetEntry,
  type PresetManifest,
  searchPresets,
} from "../engine/presets";
import type { ProjectManifest } from "../engine/project";
import {
  groupPresetsByCategory,
  presetsForSource,
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

describe("the shared App and My preset catalogue", () => {
  it("uses the canonical App entries with identical names and previews", () => {
    const app = listPresets();
    const mine = entry("ws:my-title");
    const visible = presetsForSource([...app, mine], "app");

    expect(visible).toHaveLength(21);
    expect(visible).toEqual(app);
    visible.forEach((preset, index) => {
      expect(preset).toBe(app[index]);
    });
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

  it("shows workspace copies only under My presets without hiding pack App entries", () => {
    const app = entry("title");
    const mine = entry("ws:title");
    const pack = { ...entry("pack-title"), source: "pack" as const };

    expect(presetsForSource([app, mine, pack], "app")).toEqual([app, pack]);
    expect(presetsForSource([app, mine, pack], "mine")).toEqual([mine]);
  });
});

describe("preset selection across catalogue updates", () => {
  it("defaults to the first preset only before an explicit selection", () => {
    const first = entry("first");
    const selected = entry("selected");

    expect(resolvePresetSelection([first, selected], null)).toBe(first);
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

  it("activates the focused card after a reorder instead of the new default", () => {
    const focused = entry("focused");
    const other = entry("other");
    const reordered = [other, focused];

    expect(resolvePresetSelection(reordered, null)).toBe(other);
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

describe("groupPresetsByCategory", () => {
  it("keeps the catalogue's category order and drops empty groups", () => {
    const groups = groupPresetsByCategory([
      entry("closer", "closers"),
      entry("opener", "openers"),
      entry("chart", "stats-charts"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["openers", "stats-charts", "closers"]);
    expect(groups.map((g) => g.label)).toEqual(["Openers", "Stats & charts", "Closers"]);
  });

  it("files uncategorised presets in a trailing group", () => {
    const groups = groupPresetsByCategory([entry("loose"), entry("opener", "openers")]);
    expect(groups.map((g) => g.id)).toEqual(["openers", "uncategorised"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual(["loose"]);
  });

  it("preserves the order entries arrive in inside a group", () => {
    const groups = groupPresetsByCategory([entry("second", "openers"), entry("first", "openers")]);
    expect(groups[0].entries.map((e) => e.id)).toEqual(["second", "first"]);
  });

  it("returns nothing for an empty catalogue", () => {
    expect(groupPresetsByCategory([])).toEqual([]);
  });
});
