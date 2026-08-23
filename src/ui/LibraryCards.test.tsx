import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPresetEntry } from "../engine/presets";
import type { ProjectManifest } from "../engine/project";
import type { TemplateEntry } from "../engine/templates";
import { ItemDetailsModal } from "./ItemDetailsModal";
import { PresetCard } from "./PresetCard";
import { TemplateCard } from "./TemplateCard";

const project = {
  id: "cold-open",
  name: "Cold open",
  version: 2,
  themeId: "kookaburra-studio-white",
  formats: ["16:9"],
  scenes: [{ file: "scenes/01-cold-open.tsx", durationMs: 8000 }],
} as unknown as ProjectManifest;

const preset = buildPresetEntry(
  "ws:cold-open",
  {
    version: 1,
    name: "Cold open",
    tagline: "A hard cut in.",
    category: "openers",
    tags: ["opener"],
    preview: { scene: 0, atMs: 1500 },
    order: 10,
    status: "stable",
    source: "user",
  },
  project,
);

const template: TemplateEntry = {
  id: "ws:launch-film",
  slug: "launch-film",
  projectId: "ws-template:launch-film",
  source: "user",
  manifest: {
    version: 1,
    name: "Launch film",
    tagline: "One handset, one claim.",
    tags: [],
    personas: [],
    level: "standard",
    tier: "safe",
    uses: [],
    preview: { poster: 1, frames: [0, 0, 0, 0] },
    order: 10,
    status: "stable",
    source: "user",
  },
  name: "Launch film",
  tagline: "One handset, one claim.",
  category: null,
  categoryLabel: null,
  tags: [],
  personas: [],
  level: "standard",
  tier: "safe",
  storeLegal: false,
  uses: [],
  highlights: [],
  order: 10,
  status: "stable",
  sceneCount: 3,
  durationMs: 24000,
  aspects: ["16:9"],
  primaryAspect: "16:9",
  themeId: "kookaburra-studio-white",
  previews: null,
  haystack: "launch film",
};

describe("library cards", () => {
  it("opens rather than selects in the library, and flags the user's own template", () => {
    const html = renderToStaticMarkup(
      <TemplateCard
        entry={template}
        selected={false}
        tabStop
        onSelect={() => {}}
        interaction={{ mode: "open" }}
      />,
    );
    expect(html).toContain('role="button"');
    expect(html).not.toContain("aria-checked");
    expect(html).toContain("My template");
    expect(html).toContain("3 scenes · 24s · 16:9");
  });

  it("keeps the wizard's radio semantics", () => {
    const html = renderToStaticMarkup(
      <TemplateCard entry={template} selected tabStop onSelect={() => {}} />,
    );
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
  });

  it("shows a preset's category, length and drop marker", () => {
    const html = renderToStaticMarkup(
      <PresetCard
        entry={preset}
        selected={false}
        tabStop
        onSelect={() => {}}
        interaction={{ mode: "open", drop: "before" }}
      />,
    );
    expect(html).toContain("Openers");
    expect(html).toContain("8s · 16:9");
    expect(html).toContain("drop-before");
  });
});

describe("ItemDetailsModal", () => {
  it("offers the preset categories and hides the authoring facets on a user item", () => {
    const html = renderToStaticMarkup(
      <ItemDetailsModal
        target={{
          kind: "preset",
          source: "user",
          slug: "cold-open",
          manifest: preset.manifest,
        }}
        title="Preset details"
        submitLabel="Save"
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Preset details"');
    expect(html).toContain("Stats &amp; charts");
    expect(html).toContain("item-details-tags");
    expect(html).not.toContain("item-details-facets");
  });

  it("exposes level, tier and status on a bundled item", () => {
    const html = renderToStaticMarkup(
      <ItemDetailsModal
        target={{
          kind: "template",
          source: "bundled",
          slug: "launch-film",
          manifest: template.manifest,
        }}
        title="Template details"
        submitLabel="Save"
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("item-details-facets");
    expect(html).toContain("Level");
    expect(html).toContain("Tier");
    expect(html).toContain("showcase");
  });
});
