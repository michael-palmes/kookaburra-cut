import { describe, expect, it } from "vitest";
import { CHART_ANIMATION_PRESET_IDS, chartAnimationEndMs } from "../toolkit/chart/animation";
import { CHART_STYLE_PRESET_IDS } from "../toolkit/chart/stylePresets";
import { SCENE3D_BACKGROUND_PRESETS } from "../toolkit/stage/scene3d/presets";
import { SHADER_BACKGROUND_PRESETS } from "../toolkit/stage/shaders/presets";
import { TEXT_PRESET_NAMES } from "../toolkit/text/presets";
import { optionPreviewJobs } from "./optionPreviews";
import { resolveChart } from "./sceneChart";
import { parseSceneDoc } from "./sceneDocSchema";
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

// Every lab project manifest, for the background/lab pairing guard and the chart capture windows.
const labManifests = import.meta.glob<{
  id?: string;
  scenes?: { file: string; durationMs: number }[];
}>("../../projects/preview-lab-*/project.json", { eager: true, import: "default" });

// The committed chart fixtures: appearance stills and build-in clips, with the manifests that time them.
const chartFixtures = import.meta.glob<Record<string, unknown>>(
  "../../projects/preview-lab-chart/scenes/*.json",
  { eager: true, import: "default" },
);

const chartAnimFixtures = import.meta.glob<Record<string, unknown>>(
  "../../projects/preview-lab-chart-anim/scenes/*.json",
  { eager: true, import: "default" },
);

// The wizard's Chart kind card, which stages a chart of its own.
const kindChartFixture = import.meta.glob<Record<string, unknown>>(
  "../../projects/preview-lab-stage/scenes/kind-chart.json",
  { eager: true, import: "default" },
);

/** One chart fixture's build length against the window its capture sees: a still captures the scene MIDDLE, a clip the whole window, so a build running past either shows a half-drawn chart on the card. */
function chartBuildMs(doc: unknown, stem: string): number {
  const parsed = parseSceneDoc(doc, stem);
  const chart = resolveChart(parsed);
  expect(chart, stem).not.toBeNull();
  if (!chart) return Number.POSITIVE_INFINITY;
  return chartAnimationEndMs(chart.animation, {
    seriesCount: chart.data.series.length,
    categoryCount: chart.data.categories.length,
    type: chart.type,
  });
}

function chartSceneMs(lab: string, stem: string): number {
  const manifest = labManifests[`../../projects/${lab}/project.json`];
  const entry = manifest?.scenes?.find((s) => s.file === `scenes/${stem}.tsx`);
  expect(entry, `${lab}/${stem} registered in project.json`).toBeDefined();
  return entry?.durationMs ?? 0;
}

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

  it("maps chart-<preset> stems to STILL sets and chartanim-<preset> stems to CLIP sets", () => {
    // An appearance card is a settled chart (a still says everything); a build-in card IS motion.
    const jobs = optionPreviewJobs(["chart-glass", "chartanim-drop"]);
    expect(jobs).toEqual([
      { stem: "chart-glass", set: "chart-glass", kind: "still" },
      { stem: "chartanim-drop", set: "chartanim-drop", kind: "clip" },
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
    expect(labIds).toContain("preview-lab-chart");
    expect(labIds).toContain("preview-lab-chart-anim");
  });

  it("preview-lab covers EVERY chart appearance preset, each fixture on its own preset", () => {
    // The carousel shows these stills as "the preset"; a fixture drifting from stylePresets.ts would sell a look the click doesn't apply.
    for (const id of CHART_STYLE_PRESET_IDS) {
      const stem = `chart-${id}`;
      const doc = chartFixtures[`../../projects/preview-lab-chart/scenes/${stem}.json`];
      expect(doc, stem).toBeDefined();
      expect((doc?.chart as { style?: { preset?: string } })?.style?.preset, stem).toBe(id);
    }
    const stems = Object.keys(chartFixtures).map((p) => p.split("/").pop()?.replace(".json", ""));
    expect(stems.sort()).toEqual(CHART_STYLE_PRESET_IDS.map((id) => `chart-${id}`).sort());
  });

  it("preview-lab covers EVERY chart build-in, each fixture on its own preset", () => {
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const stem = `chartanim-${id}`;
      const doc = chartAnimFixtures[`../../projects/preview-lab-chart-anim/scenes/${stem}.json`];
      expect(doc, stem).toBeDefined();
      expect((doc?.chart as { animation?: { preset?: string } })?.animation?.preset, stem).toBe(id);
    }
    const stems = Object.keys(chartAnimFixtures).map((p) =>
      p.split("/").pop()?.replace(".json", ""),
    );
    expect(stems.sort()).toEqual(CHART_ANIMATION_PRESET_IDS.map((id) => `chartanim-${id}`).sort());
  });

  it("every chart STILL has settled by its capture, the scene middle", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      const stem = `chart-${id}`;
      const doc = chartFixtures[`../../projects/preview-lab-chart/scenes/${stem}.json`];
      expect(chartBuildMs(doc, stem), stem).toBeLessThanOrEqual(
        chartSceneMs("preview-lab-chart", stem) / 2,
      );
    }
    // The kind card runs the SCAFFOLDER's animation defaults, so a slower default would capture it mid-build.
    const kind = kindChartFixture["../../projects/preview-lab-stage/scenes/kind-chart.json"];
    expect(chartBuildMs(kind, "kind-chart")).toBeLessThanOrEqual(
      chartSceneMs("preview-lab-stage", "kind-chart") / 2,
    );
  });

  it("every chart build-in fixture finishes inside its clip window, hold included", () => {
    // A build still running at the last captured frame reads as a broken card, so every fixture lands with room to spare.
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const stem = `chartanim-${id}`;
      const doc = chartAnimFixtures[`../../projects/preview-lab-chart-anim/scenes/${stem}.json`];
      expect(chartBuildMs(doc, stem), stem).toBeLessThanOrEqual(
        chartSceneMs("preview-lab-chart-anim", stem) - 200,
      );
    }
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
