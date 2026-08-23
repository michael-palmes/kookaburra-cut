import { describe, expect, it } from "vitest";
import {
  buildPresetEntry,
  type PresetCategoryId,
  type PresetEntry,
  type PresetManifest,
} from "../engine/presets";
import type { ProjectManifest } from "../engine/project";
import { groupPresetsByCategory } from "./PresetGalleryModal";

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
