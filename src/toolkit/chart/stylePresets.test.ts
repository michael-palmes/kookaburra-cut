import { afterEach, describe, expect, it, vi } from "vitest";
import { hexToOklch } from "../../theme/oklch";
import { builtinThemes } from "../../theme/registry";
import type { Theme } from "../../theme/tokens";
import { CHART_2D_APPEARANCE } from "./chart2dMath";
import {
  CHART_STYLE_DEFAULT_ID,
  CHART_STYLE_PRESET_IDS,
  CHART_STYLE_PRESETS,
  chartGradientRamp,
  chartSeriesTint,
  chartStackSurface,
  isChartStylePresetId,
  isDarkFirstSurface,
  resolveChartStyle,
} from "./stylePresets";
import type { ChartStyle, ChartStyleSurface } from "./types";

const dark = builtinThemes["kookaburra-default"];
const light = builtinThemes["kookaburra-pacific"];

const style = (parts: Partial<ChartStyle> = {}): ChartStyle => ({
  preset: "boardroom",
  depth: 0.5,
  gap: 1,
  cornerRadius: 0.25,
  rotation: [18.5, -18.1],
  innerRadius: 0,
  offset: [0, 0],
  scale: 1,
  ...parts,
});

const resolve = (id: string, parts: Partial<ChartStyle> = {}, theme: Theme = dark) =>
  resolveChartStyle(id, style(parts), theme);

const presets = CHART_STYLE_PRESET_IDS.map((id) => CHART_STYLE_PRESETS[id]);

/** Every leaf of a surface, so "resolves complete" means no undefined and no NaN anywhere, not just at the top level. */
function leaves(value: unknown, path = ""): [string, unknown][] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, path ? `${path}.${k}` : k),
    );
  }
  return [[path, value]];
}

describe("catalogue", () => {
  it("preserves the existing shelves and appends the dark tier", () => {
    expect(CHART_STYLE_PRESET_IDS).toEqual([
      "boardroom",
      "print",
      "paperCut",
      "terminal",
      "studio",
      "gradientRise",
      "glass",
      "velvet",
      "horizon",
      "midnightGold",
      "neonLedger",
      "pulseGlass",
      "nightEditorial",
      "launchGlow",
      "obsidian",
    ]);
    expect(CHART_STYLE_PRESET_IDS).toHaveLength(15);
    expect(new Set(CHART_STYLE_PRESET_IDS).size).toBe(15);
    expect(CHART_STYLE_PRESET_IDS[0]).toBe(CHART_STYLE_DEFAULT_ID);
  });

  it("keys every listed id, with its own id on its surface", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      expect(isChartStylePresetId(id)).toBe(true);
      expect(CHART_STYLE_PRESETS[id].id).toBe(id);
      expect(CHART_STYLE_PRESETS[id].surface.id).toBe(id);
    }
    expect(Object.keys(CHART_STYLE_PRESETS).sort()).toEqual([...CHART_STYLE_PRESET_IDS].sort());
    expect(isChartStylePresetId("nope")).toBe(false);
  });

  it("labels each preset once, and groups the tiers in carousel order", () => {
    const labels = presets.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(presets.map((p) => p.tier)).toEqual([
      "classic",
      "classic",
      "classic",
      "classic",
      "studio",
      "studio",
      "studio",
      "studio",
      "studio",
      "market",
      "market",
      "market",
      "dark",
      "dark",
      "dark",
    ]);
  });
});

describe("surface completeness", () => {
  it("resolves every preset with no undefined or NaN field", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      for (const [path, value] of leaves(resolve(id))) {
        expect(value, `${id}.${path}`).toBeDefined();
        if (typeof value === "number") expect(Number.isFinite(value), `${id}.${path}`).toBe(true);
      }
    }
  });

  it("carries every Chart2DAppearance field on the flat facet", () => {
    const twod = resolve("boardroom").twod;
    for (const key of Object.keys(CHART_2D_APPEARANCE)) {
      expect(twod, key).toHaveProperty(key);
    }
    expect(twod).toMatchObject(CHART_2D_APPEARANCE);
  });

  it("holds the shared treatments to their vocabularies", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      const s = resolve(id);
      expect(["plain", "chips"]).toContain(s.legendChrome);
      expect(["body", "headline"]).toContain(s.fontEmphasis);
      expect(["none", "vertical"]).toContain(s.twod.areaGradient);
      expect(s.gridStyleWeight).toBeGreaterThanOrEqual(0);
      expect(s.gridStyleWeight).toBeLessThanOrEqual(2);
      expect(s.twod.tickWeight).toBeGreaterThanOrEqual(0);
      expect(s.twod.tickWeight).toBeLessThanOrEqual(1);
      expect(s.threed.emissiveEdge).toBeGreaterThanOrEqual(0);
      expect(s.threed.emissiveEdge).toBeLessThanOrEqual(1);
      expect(s.seriesLightnessStep).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps boardroom the null case: the base look with nothing switched on", () => {
    const s = resolve("boardroom");
    expect(s.twod).toMatchObject({
      labelPill: false,
      tickWeight: 0,
      axisLine: false,
      areaGradient: "none",
      strokeWidthScale: 1,
    });
    expect(s.threed).toMatchObject({
      clearcoat: 0,
      transmission: 0,
      emissiveEdge: 0,
      interiorFlatStacks: false,
    });
    expect(s.gridStyleWeight).toBe(1);
    expect(s.legendChrome).toBe("plain");
    expect(s.seriesLightnessStep).toBe(0);
  });
});

describe("preset intent", () => {
  it("declares glass and glow only where the look calls for them, and both only on pulseGlass", () => {
    const glassy = CHART_STYLE_PRESET_IDS.filter((id) => resolve(id).threed.transmission > 0);
    const glowing = CHART_STYLE_PRESET_IDS.filter((id) => resolve(id).threed.emissiveEdge > 0);
    expect(glassy).toEqual(["glass", "pulseGlass"]);
    expect(glowing).toEqual([
      "midnightGold",
      "neonLedger",
      "pulseGlass",
      "nightEditorial",
      "launchGlow",
    ]);
    expect(glassy.filter((id) => glowing.includes(id))).toEqual(["pulseGlass"]);
  });

  it("keeps every glass preset a dielectric with real refraction", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      const { transmission, metalness, thickness, ior } = resolve(id).threed;
      if (transmission === 0) continue;
      expect(metalness, id).toBe(0);
      expect(thickness, id).toBeGreaterThan(0);
      expect(ior, id).toBeGreaterThan(1);
    }
  });

  it("marks the dark-first looks and only those", () => {
    const darkFirst = CHART_STYLE_PRESET_IDS.filter((id) => isDarkFirstSurface(resolve(id)));
    expect(darkFirst).toEqual([
      "glass",
      "midnightGold",
      "neonLedger",
      "pulseGlass",
      "nightEditorial",
      "launchGlow",
      "obsidian",
    ]);
  });

  it("drops the gridlines on the presets that trade them for whitespace", () => {
    const gridless = CHART_STYLE_PRESET_IDS.filter((id) => resolve(id).gridStyleWeight === 0);
    expect(gridless).toEqual(["print", "gradientRise"]);
    expect(resolve("terminal").gridStyleWeight).toBeGreaterThan(1);
  });

  it("puts the vertical ramp on the gradient looks", () => {
    const ramped = CHART_STYLE_PRESET_IDS.filter((id) => resolve(id).twod.areaGradient !== "none");
    expect(ramped).toEqual(["gradientRise", "horizon", "pulseGlass", "launchGlow"]);
  });

  it("squares terminal's corners and steps paperCut's series", () => {
    expect(resolve("terminal").cornerRadiusScale).toBe(0);
    expect(resolve("paperCut").seriesLightnessStep).toBeGreaterThan(0);
    expect(resolve("boardroom").seriesLightnessStep).toBe(0);
  });

  it("gives the dark tier three materially different treatments", () => {
    const editorial = resolve("nightEditorial");
    const launch = resolve("launchGlow");
    const material = resolve("obsidian");

    expect(editorial.twod.labelPill).toBe(false);
    expect(editorial.threed.roughness).toBeGreaterThan(0.7);
    expect(editorial.threed.emissiveEdge).toBeLessThan(0.1);

    expect(launch.twod.areaGradient).toBe("vertical");
    expect(launch.twod.points).toBe(true);
    expect(launch.threed.emissiveEdge).toBeGreaterThan(0.8);

    expect(material.threed.metalness).toBeGreaterThan(0.8);
    expect(material.threed.clearcoat).toBeGreaterThan(0.8);
    expect(material.threed.emissiveEdge).toBe(0);
  });
});

describe("authored overrides", () => {
  it("caps the corner scale so the authored radius can never pass the geometric limit", () => {
    expect(resolve("velvet", { cornerRadius: 0.25 }).cornerRadiusScale).toBeCloseTo(1.4, 10);
    expect(resolve("velvet", { cornerRadius: 0.9 }).cornerRadiusScale).toBeCloseTo(1 / 0.9, 10);
    expect(resolve("velvet", { cornerRadius: 1 }).cornerRadiusScale).toBe(1);
    // A square-cornered preset stays square whatever the author asked for.
    expect(resolve("terminal", { cornerRadius: 1 }).cornerRadiusScale).toBe(0);
  });

  it("leaves the scale alone at radius 0, since nothing multiplies through", () => {
    expect(resolve("velvet", { cornerRadius: 0 }).cornerRadiusScale).toBeCloseTo(1.4, 10);
  });

  it("narrows the pie gap for a donut only", () => {
    const flat = resolve("boardroom", { innerRadius: 0 }).pieGapScale;
    const donut = resolve("boardroom", { innerRadius: 0.5 }).pieGapScale;
    expect(flat).toBe(1);
    expect(donut).toBeCloseTo(0.75, 10);
    expect(resolve("terminal", { innerRadius: 0.5 }).pieGapScale).toBeCloseTo(0.5 * 0.75, 10);
  });

  it("tracks refraction thickness with the authored depth, landing on the preset value at 0.5", () => {
    expect(resolve("glass", { depth: 0.5 }).threed.thickness).toBeCloseTo(0.6, 10);
    expect(resolve("glass", { depth: 0 }).threed.thickness).toBeCloseTo(0.3, 10);
    expect(resolve("glass", { depth: 1 }).threed.thickness).toBeCloseTo(0.9, 10);
    expect(resolve("boardroom", { depth: 1 }).threed.thickness).toBe(0);
  });

  it("ignores gap, which layout owns", () => {
    expect(resolve("studio", { gap: 0.1 })).toEqual(resolve("studio", { gap: 4 }));
  });
});

describe("theme adaptation", () => {
  it("relaxes glow, refraction and metal on a light theme", () => {
    const onDark = resolve("pulseGlass", {}, dark).threed;
    const onLight = resolve("pulseGlass", {}, light).threed;
    expect(onLight.emissiveEdge).toBeLessThan(onDark.emissiveEdge);
    expect(onLight.transmission).toBeLessThan(onDark.transmission);
    expect(onLight.thickness).toBeLessThan(onDark.thickness);
    expect(resolve("midnightGold", {}, light).threed.metalness).toBeLessThan(
      resolve("midnightGold", {}, dark).threed.metalness,
    );
  });

  it("leaves a preset that was never dark-first alone", () => {
    for (const id of ["boardroom", "print", "paperCut", "terminal", "studio", "horizon"]) {
      expect(resolve(id, {}, light), id).toEqual(resolve(id, {}, dark));
    }
  });
});

describe("degrade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to boardroom, warning once per unknown id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = resolve("chartreuse-supreme");
    const second = resolve("chartreuse-supreme");
    expect(first).toEqual(resolve("boardroom"));
    expect(first.id).toBe("boardroom");
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("chartreuse-supreme");
  });
});

describe("determinism", () => {
  it("returns the same values for the same inputs", () => {
    for (const id of CHART_STYLE_PRESET_IDS) {
      expect(resolve(id, { depth: 0.3, cornerRadius: 0.4, innerRadius: 0.2 })).toEqual(
        resolve(id, { depth: 0.3, cornerRadius: 0.4, innerRadius: 0.2 }),
      );
    }
  });

  it("hands out a fresh surface, so a renderer can never edit the catalogue", () => {
    const first = resolve("glass") as ChartStyleSurface;
    first.threed.transmission = 0;
    first.twod.labelPill = false;
    first.gridStyleWeight = 99;
    const second = resolve("glass");
    expect(second.threed.transmission).toBeGreaterThan(0);
    expect(second.twod.labelPill).toBe(true);
    expect(second.gridStyleWeight).toBe(1);
    expect(CHART_STYLE_PRESETS.glass.surface.threed.transmission).toBeGreaterThan(0);
  });
});

describe("chartStackSurface", () => {
  it("goes matte and drops gloss and glow under interiorFlatStacks", () => {
    const threed = resolve("neonLedger").threed;
    const stack = chartStackSurface(threed);
    expect(stack.roughness).toBeGreaterThanOrEqual(threed.roughness);
    expect(stack.roughness).toBeGreaterThanOrEqual(0.72);
    expect(stack.clearcoat).toBe(0);
    expect(stack.emissiveEdge).toBe(0);
    expect(stack.transmission).toBe(threed.transmission);
  });

  it("passes a preset that keeps its stacks lit straight through", () => {
    const threed = resolve("studio").threed;
    expect(chartStackSurface(threed)).toBe(threed);
  });
});

describe("chartGradientRamp", () => {
  const colour = "#f0a848";

  it("runs base to top with the series colour intact at the curve", () => {
    const stops = chartGradientRamp(dark, colour);
    expect(stops).toHaveLength(3);
    expect(stops.map(([, at]) => at)).toEqual([0, 0.55, 1]);
    expect(stops[2][0]).toBe(colour);
    for (const [value] of stops) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("mixes toward the background on the way down", () => {
    const [base, knee, top] = chartGradientRamp(dark, colour).map(([value]) => hexToOklch(value));
    const background = hexToOklch(dark.colors.background);
    const gap = (a: { l: number }) => Math.abs(a.l - background.l);
    expect(gap(base)).toBeLessThan(gap(knee));
    expect(gap(knee)).toBeLessThan(gap(top));
  });

  it("fades further at a stronger fade, and not at all at zero", () => {
    const soft = hexToOklch(chartGradientRamp(dark, colour, 0.2)[0][0]);
    const hard = hexToOklch(chartGradientRamp(dark, colour, 1)[0][0]);
    const background = hexToOklch(dark.colors.background);
    expect(Math.abs(hard.l - background.l)).toBeLessThan(Math.abs(soft.l - background.l));
    expect(chartGradientRamp(dark, colour, 0)[0][0]).toBe(colour);
  });

  it("is pure, and degrades a broken colour to the theme accent", () => {
    expect(chartGradientRamp(light, colour)).toEqual(chartGradientRamp(light, colour));
    expect(chartGradientRamp(dark, "not-a-colour")[2][0]).toBe(dark.colors.accent);
  });
});

describe("chartSeriesTint", () => {
  const colour = "#4f8cff";

  it("leaves the first series and a zero step untouched", () => {
    expect(chartSeriesTint(colour, dark.colors.background, 0, 0.05)).toBe(colour);
    expect(chartSeriesTint(colour, dark.colors.background, 3, 0)).toBe(colour);
  });

  it("steps away from the background, further with each index", () => {
    const one = hexToOklch(chartSeriesTint(colour, dark.colors.background, 1, 0.05)).l;
    const three = hexToOklch(chartSeriesTint(colour, dark.colors.background, 3, 0.05)).l;
    expect(one).toBeGreaterThan(hexToOklch(colour).l);
    expect(three).toBeGreaterThan(one);

    const onLight = hexToOklch(chartSeriesTint(colour, light.colors.background, 2, 0.05)).l;
    expect(onLight).toBeLessThan(hexToOklch(colour).l);
  });

  it("clamps a long series list inside the readable band", () => {
    const far = hexToOklch(chartSeriesTint(colour, dark.colors.background, 40, 0.05)).l;
    expect(far).toBeLessThanOrEqual(0.95);
    expect(chartSeriesTint("nope", dark.colors.background, 2, 0.05)).toBe("nope");
  });
});
