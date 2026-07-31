import { describe, expect, it } from "vitest";
import { SCENE3D_BACKGROUND_PRESETS } from "../toolkit/stage/scene3d/presets";
import { SHADER_BACKGROUND_PRESETS } from "../toolkit/stage/shaders/presets";
import { TEXT_PRESET_NAMES } from "../toolkit/text/presets";
import { optionPreviewJobs } from "./optionPreviews";
import { largestSceneText } from "./sceneTextRegistry";

// The committed bgp-* fixtures, loaded through the same glob machinery the app uses for bundled docs.
const bgpFixtures = import.meta.glob<{ background?: Record<string, unknown> }>(
  "../../projects/preview-lab-bg-*/scenes/bgp-*.json",
  { eager: true, import: "default" },
);

// The committed bg-*-light fixtures: the light-theme type-card clips.
const bgLightFixtures = import.meta.glob<{ background?: Record<string, unknown> }>(
  "../../projects/preview-lab-bg-*/scenes/bg-*-light.json",
  { eager: true, import: "default" },
);

// Every lab project manifest, for the background/lab pairing guard.
const labManifests = import.meta.glob<{ id?: string }>(
  "../../projects/preview-lab-*/project.json",
  { eager: true, import: "default" },
);

/** Pins for the option-preview generator: the set-naming scheme is a CONTRACT between preview-lab's scene stems, the autorun capture, the wrapper's encode/promote step, and the pickers' asset lookups; a rename anywhere goes dark silently (cards degrade to swatches), so the vocabulary is pinned here. */

describe("optionPreviewJobs (the set-naming contract)", () => {
  it("maps tm-<preset> stems to textanim-<preset> clip sets (tm-none = a still)", () => {
    const jobs = optionPreviewJobs(["tm-fade", "tm-none", "tm-scatter-scale"]);
    expect(jobs).toEqual([
      { stem: "tm-fade", set: "textanim-fade", kind: "clip" },
      { stem: "tm-none", set: "textanim-none", kind: "still" },
      { stem: "tm-scatter-scale", set: "textanim-scatter-scale", kind: "clip" },
    ]);
  });

  it("maps shadow-*, stage-*, kind-* and object-* stems to same-named still sets", () => {
    const jobs = optionPreviewJobs([
      "shadow-soft",
      "stage-gradient",
      "kind-appversion",
      "object-lantern",
    ]);
    expect(jobs).toEqual([
      { stem: "shadow-soft", set: "shadow-soft", kind: "still" },
      { stem: "stage-gradient", set: "stage-gradient", kind: "still" },
      { stem: "kind-appversion", set: "kind-appversion", kind: "still" },
      { stem: "object-lantern", set: "object-lantern", kind: "still" },
    ]);
  });

  it("maps bg-<shader> stems to same-named CLIP sets (animated fills preview in motion)", () => {
    const jobs = optionPreviewJobs(["bg-mesh-gradient", "bg-swirl"]);
    expect(jobs).toEqual([
      { stem: "bg-mesh-gradient", set: "bg-mesh-gradient", kind: "clip" },
      { stem: "bg-swirl", set: "bg-swirl", kind: "clip" },
    ]);
  });

  it("maps bgp-<shader>-<preset> stems to same-named STILL sets (small tiles)", () => {
    const jobs = optionPreviewJobs(["bgp-mesh-gradient-p1", "bgp-smoke-ring-p6"]);
    expect(jobs).toEqual([
      { stem: "bgp-mesh-gradient-p1", set: "bgp-mesh-gradient-p1", kind: "still" },
      { stem: "bgp-smoke-ring-p6", set: "bgp-smoke-ring-p6", kind: "still" },
    ]);
  });

  it("skips unknown stems (lab experiments never break the batch)", () => {
    expect(optionPreviewJobs(["scratch", "01-title"])).toEqual([]);
  });

  it("preview-lab covers EVERY text preset — the picker's cards stay complete", () => {
    // The committed project's tm- stems must track the preset vocabulary; if a preset is added, add its scene to projects/preview-lab and regenerate the previews.
    const labStems = TEXT_PRESET_NAMES.map((p) => `tm-${p}`);
    const sets = optionPreviewJobs(labStems).map((j) => j.set);
    expect(sets).toEqual(TEXT_PRESET_NAMES.map((p) => `textanim-${p}`));
  });

  it("preview-lab's bgp-* fixtures match SHADER_BACKGROUND_PRESETS exactly (no drift)", () => {
    // The tiles show these committed stills as "the preset"; a fixture drifting from presets.ts would sell a look the click doesn't apply. Regenerate fixtures + stills when presets change.
    let checked = 0;
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      for (const preset of presets) {
        const stem = `bgp-${shader}-${preset.id}`;
        const doc = bgpFixtures[`../../projects/preview-lab-bg-${shader}/scenes/${stem}.json`];
        expect(doc, stem).toBeDefined();
        expect(doc.background, stem).toEqual({
          type: "shader",
          shader,
          colors: preset.colors,
          speed: preset.speed ?? 1,
          ...(preset.scale !== undefined ? { scale: preset.scale } : {}),
          ...(preset.params ? { params: preset.params } : {}),
          preset: preset.id,
        });
        checked++;
      }
    }
    // Both sides enumerated within the type: the scene3d packs check their own fixtures below.
    const shaderFixtures = Object.values(bgpFixtures).filter(
      (d) => (d.background as { type?: string } | undefined)?.type === "shader",
    ).length;
    expect(checked).toBe(shaderFixtures);
  });

  it("preview-lab's scene3d bgp-* fixtures match SCENE3D_BACKGROUND_PRESETS exactly (no drift)", () => {
    let checked = 0;
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      for (const preset of presets) {
        const stem = `bgp-${look}-${preset.id}`;
        const doc = bgpFixtures[`../../projects/preview-lab-bg-${look}/scenes/${stem}.json`];
        expect(doc, stem).toBeDefined();
        expect(doc.background, stem).toEqual({
          type: "scene3d",
          look,
          colors: preset.colors,
          speed: preset.speed ?? 1,
          ...(preset.params ? { params: preset.params } : {}),
          backing: { type: "color", color: preset.backing },
          preset: preset.id,
        });
        checked++;
      }
    }
    const scene3dFixtures = Object.values(bgpFixtures).filter(
      (d) => (d.background as { type?: string } | undefined)?.type === "scene3d",
    ).length;
    expect(checked).toBe(scene3dFixtures);
    expect(checked + Object.keys(SHADER_BACKGROUND_PRESETS).length * 9).toBe(
      Object.keys(bgpFixtures).length,
    );
  });

  it("preview-lab's bg-*-light fixtures match each shader's p1 preset exactly (no drift)", () => {
    // Light-theme type cards show these clips as "the shader"; they must render what applying p1 writes.
    let checked = 0;
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      const p1 = presets.find((p) => p.id === "p1");
      expect(p1, shader).toBeDefined();
      if (!p1) continue;
      const stem = `bg-${shader}-light`;
      const doc = bgLightFixtures[`../../projects/preview-lab-bg-${shader}/scenes/${stem}.json`];
      expect(doc, stem).toBeDefined();
      expect(doc.background, stem).toEqual({
        type: "shader",
        shader,
        colors: p1.colors,
        speed: p1.speed ?? 1,
        ...(p1.scale !== undefined ? { scale: p1.scale } : {}),
        ...(p1.params ? { params: p1.params } : {}),
        preset: "p1",
      });
      checked++;
    }
    const shaderLights = Object.values(bgLightFixtures).filter(
      (d) => (d.background as { type?: string } | undefined)?.type === "shader",
    ).length;
    expect(checked).toBe(shaderLights);
  });

  it("preview-lab's scene3d bg-*-light fixtures match each look's p1 preset exactly (no drift)", () => {
    let checked = 0;
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      const p1 = presets.find((p) => p.id === "p1");
      expect(p1, look).toBeDefined();
      if (!p1) continue;
      const stem = `bg-${look}-light`;
      const doc = bgLightFixtures[`../../projects/preview-lab-bg-${look}/scenes/${stem}.json`];
      expect(doc, stem).toBeDefined();
      expect(doc.background, stem).toEqual({
        type: "scene3d",
        look,
        colors: p1.colors,
        speed: p1.speed ?? 1,
        ...(p1.params ? { params: p1.params } : {}),
        backing: { type: "color", color: p1.backing },
        preset: "p1",
      });
      checked++;
    }
    const scene3dLights = Object.values(bgLightFixtures).filter(
      (d) => (d.background as { type?: string } | undefined)?.type === "scene3d",
    ).length;
    expect(checked).toBe(scene3dLights);
  });

  it("every background has its preview-lab-bg-* project (the discovery convention)", () => {
    // The option-previews action finds lab projects by directory prefix; a background without one silently ships with placeholder cards.
    const labIds = Object.values(labManifests)
      .map((m) => m.id)
      .filter((id): id is string => !!id);
    for (const shader of Object.keys(SHADER_BACKGROUND_PRESETS)) {
      expect(labIds, shader).toContain(`preview-lab-bg-${shader}`);
    }
    for (const look of Object.keys(SCENE3D_BACKGROUND_PRESETS)) {
      expect(labIds, look).toContain(`preview-lab-bg-${look}`);
    }
    expect(labIds).toContain("preview-lab-text");
    expect(labIds).toContain("preview-lab-stage");
  });
});

describe("largestSceneText (the default scene name)", () => {
  it("picks the largest font size and trims to the first line", () => {
    const texts = {
      0: {
        a: { text: "Small caption", fontSize: 0.2 },
        b: { text: "Make it move\nsecond line", fontSize: 0.6 },
      },
    };
    expect(largestSceneText(texts, 0)).toBe("Make it move");
  });

  it("returns null for unmounted scenes or whitespace-only text", () => {
    expect(largestSceneText({}, 0)).toBeNull();
    expect(largestSceneText({ 0: { a: { text: "  \n  ", fontSize: 1 } } }, 0)).toBeNull();
  });
});
