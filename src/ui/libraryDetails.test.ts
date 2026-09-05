import { describe, expect, it } from "vitest";
import type { PresetManifest } from "../engine/presets";
import type { TemplateManifest } from "../engine/templates";
import {
  cleanTags,
  itemDetailsJson,
  patchPresetManifest,
  patchTemplateManifest,
  templateDetailsDraft,
  templateManifestJson,
} from "./libraryDetails";

const template: TemplateManifest = {
  version: 1,
  name: "Launch film",
  tagline: "One handset, one claim.",
  category: "app-updates",
  tags: ["launch"],
  personas: ["marketer"],
  level: "standard",
  tier: "safe",
  uses: ["device"],
  highlights: ["A single orbit"],
  preview: { poster: 1, frames: [0, 0, 0, 0] },
  order: 10,
  status: "stable",
  source: "user",
};

const preset: PresetManifest = {
  version: 1,
  name: "Cold open",
  tagline: "",
  tags: [],
  preview: { scene: 0, atMs: 1500 },
  order: 10,
  status: "stable",
  source: "user",
};

describe("cleanTags", () => {
  it("trims, drops empties and keeps the first spelling of a repeat", () => {
    expect(cleanTags([" launch ", "", "Launch", "device"])).toEqual(["launch", "device"]);
  });
});

describe("patchTemplateManifest", () => {
  it("keeps every field the modal does not edit", () => {
    const next = patchTemplateManifest(template, {
      ...templateDetailsDraft(template),
      name: "  Launch film v2 ",
      tier: "bold",
    });
    expect(next.name).toBe("Launch film v2");
    expect(next.tier).toBe("bold");
    expect(next.preview).toEqual(template.preview);
    expect(next.highlights).toEqual(template.highlights);
    expect(next.uses).toEqual(template.uses);
    expect(next.order).toBe(10);
    expect(next.source).toBe("user");
  });

  it("drops the category field when it is cleared", () => {
    const next = patchTemplateManifest(template, {
      ...templateDetailsDraft(template),
      category: null,
    });
    expect("category" in next).toBe(false);
  });
});

describe("patchPresetManifest", () => {
  it("files a preset under a category and cleans its tags", () => {
    const next = patchPresetManifest(preset, {
      name: "Cold open",
      tagline: " A hard cut in. ",
      category: "openers",
      tags: ["opener", " opener "],
      level: "standard",
      tier: "safe",
      status: "beta",
    });
    expect(next.category).toBe("openers");
    expect(next.tagline).toBe("A hard cut in.");
    expect(next.tags).toEqual(["opener"]);
    expect(next.status).toBe("beta");
  });
});

describe("manifest serialisation", () => {
  it("writes the authored field order, 2-space indented, newline terminated", () => {
    const text = templateManifestJson(template);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")[1]).toBe('  "version": 1,');
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "name",
      "tagline",
      "category",
      "tags",
      "personas",
      "level",
      "tier",
      "uses",
      "highlights",
      "preview",
      "order",
      "status",
      "source",
    ]);
  });

  it("routes a preset through the preset field order", () => {
    const text = itemDetailsJson(
      { kind: "preset", source: "user", slug: "cold-open", manifest: preset },
      { ...templateDetailsDraft(template), category: "openers", tags: [] },
    );
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "name",
      "tagline",
      "category",
      "tags",
      "preview",
      "order",
      "status",
      "source",
    ]);
  });
});
