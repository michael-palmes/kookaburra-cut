import { describe, expect, it } from "vitest";
import type { PresetManifest } from "../engine/presets";
import { type TemplateManifest, templateManifestSchema } from "../engine/templates";
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
  category: "update",
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

  it("writes a version 2 manifest's bring, song and looks after the highlights", () => {
    const v2: TemplateManifest = {
      ...template,
      version: 2,
      bring: ["Logo"],
      song: { title: "First light", bpm: 128 },
      looks: ["kookaburra-onyx"],
    };
    const keys = Object.keys(JSON.parse(templateManifestJson(v2)));
    expect(keys.slice(keys.indexOf("highlights"), keys.indexOf("preview") + 1)).toEqual([
      "highlights",
      "bring",
      "song",
      "looks",
      "preview",
    ]);
  });

  it("keeps an edited version 1 manifest readable as version 1", () => {
    const parsed = templateManifestSchema.parse({ ...template, category: "app-updates" });
    const text = templateManifestJson(patchTemplateManifest(parsed, templateDetailsDraft(parsed)));
    const written = JSON.parse(text);
    expect(written.version).toBe(1);
    expect(written.category).toBe("update");
    expect(templateManifestSchema.safeParse(written).success).toBe(true);
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
