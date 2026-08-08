/** The chart APPEARANCE catalogue and its resolver. Every preset is DATA (one flat facet, one lit facet and the treatments that cross both), and `resolveChartStyle` folds the authored `style` scalars and the theme into ONE `ChartStyleSurface` that both renderers read: no renderer ever sees a preset id, and no preset value is duplicated between the 2D and 3D paths. Pure throughout (no clock, no `Math.random`, no texture creation), so preview and the export loop agree byte for byte; the gradient ramp returns stop COLOURS and the renderers build their write-once `DataTexture` from them. */

import { bytesToHex, hexToOklch, mixOklch, oklchToBytes } from "../../theme/oklch";
import type { Theme } from "../../theme/tokens";
import { CHART_2D_APPEARANCE } from "./chart2dMath";
import type {
  ChartStyle,
  ChartStyleSurface,
  ChartStyleSurface2D,
  ChartStyleSurface3D,
} from "./types";

/** Classic is restrained and editorial, studio is crafted and video-native, market is finance-led, and dark is designed for night stages first. */
export type ChartStyleTier = "classic" | "studio" | "market" | "dark";

export interface ChartStylePreset {
  id: string;
  label: string;
  tier: ChartStyleTier;
  surface: ChartStyleSurface;
}

// ── Merge and adaptation constants (pinned: moving one restyles every chart on that preset) ──

/** A donut's gaps read wider at the inner edge, so a donut cuts a narrower one. */
const DONUT_GAP_RELIEF = 0.75;
/** Refraction thickness tracks the solid it passes through: `thickness * (BASE + depth)`, so the preset value lands exactly at the default depth of 0.5. */
const DEPTH_THICKNESS_BASE = 0.5;
/** Above this, a metallic finish is a dark-stage look. */
const DARK_FIRST_METALNESS = 0.5;
/** What a dark-first surface keeps on a light theme: glow and refraction both read as grime on white. */
const LIGHT_EMISSIVE = 0.35;
const LIGHT_TRANSMISSION = 0.55;
const LIGHT_METALNESS = 0.8;
/** Stack segments under `interiorFlatStacks`: matte, no gloss, no glow. */
const INTERIOR_ROUGHNESS = 0.72;

/** How far a vertical fill fades toward the background at its base, and the knee that keeps the falloff off a straight line. */
const CHART_GRADIENT_FADE = 0.82;
const RAMP_KNEE = 0.55;
const RAMP_KNEE_MIX = 0.35;

/** Series tinting clamps here, so a long series list never steps into the background or out of the gamut. */
const TINT_LIMITS = { lo: 0.18, hi: 0.94 };

const FALLBACK_BACKGROUND = "#000000";
const FALLBACK_ACCENT = "#3ad1c4";

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const hex = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return HEX.test(trimmed) ? trimmed : null;
};

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

const clamp01 = (v: number): number => clamp(v, 0, 1);

// ── The base surface: boardroom itself, and what every other preset states its deltas against ──

const BASE_2D: ChartStyleSurface2D = {
  ...CHART_2D_APPEARANCE,
  labelPill: false,
  tickWeight: 0,
  axisLine: false,
  areaGradient: "none",
  strokeWidthScale: 1,
};

const BASE_3D: ChartStyleSurface3D = {
  roughness: 0.42,
  metalness: 0.1,
  clearcoat: 0,
  clearcoatRoughness: 0.25,
  transmission: 0,
  thickness: 0,
  ior: 1.5,
  emissiveEdge: 0,
  bevelScale: 1,
  wallGrid: true,
  floorShadow: true,
  interiorFlatStacks: false,
};

type ChartStyleShared = Omit<ChartStyleSurface, "id" | "twod" | "threed">;

const BASE_SHARED: ChartStyleShared = {
  gridStyleWeight: 1,
  legendChrome: "plain",
  pieGapScale: 1,
  cornerRadiusScale: 1,
  fontEmphasis: "body",
  seriesLightnessStep: 0,
};

interface ChartStylePresetSeed {
  id: string;
  label: string;
  tier: ChartStyleTier;
  twod?: Partial<ChartStyleSurface2D>;
  threed?: Partial<ChartStyleSurface3D>;
  shared?: Partial<ChartStyleShared>;
}

/** The catalogue in carousel order: the safe default first, then the rest of the classic shelf, studio, market and dark looks. Every row is deltas against boardroom. */
const SEEDS: ChartStylePresetSeed[] = [
  // ── Classic: restrained, editorial, safe in front of any audience ──
  {
    // Matte flat colour, hairline gridlines, generous whitespace: the default, and the null case for every other row.
    id: "boardroom",
    label: "Boardroom",
    tier: "classic",
  },
  {
    // Ultra minimal: thin marks, no gridlines, the axis reduced to a baseline.
    id: "print",
    label: "Print",
    tier: "classic",
    twod: {
      labelFraction: 0.046,
      strokeFraction: 0.007,
      strokeWidthScale: 0.7,
      areaOpacity: 0.28,
      pieGap: 0.004,
      pieRadius: 0.8,
      axisLine: true,
    },
    threed: { roughness: 0.85, metalness: 0, bevelScale: 0.5, wallGrid: false, floorShadow: false },
    shared: { gridStyleWeight: 0, cornerRadiusScale: 0.35 },
  },
  {
    // Editorial flat: no shine at all, and each series steps a little in lightness so the layers read as cut paper.
    id: "paperCut",
    label: "Paper cut",
    tier: "classic",
    twod: {
      gridFraction: 0.0018,
      gridOpacity: 0.18,
      strokeWidthScale: 0.85,
      areaOpacity: 0.75,
      areaStroke: false,
      tickWeight: 0.15,
    },
    threed: {
      roughness: 0.95,
      metalness: 0,
      bevelScale: 0.35,
      wallGrid: false,
      interiorFlatStacks: true,
    },
    shared: { gridStyleWeight: 0.6, cornerRadiusScale: 0.2, seriesLightnessStep: 0.05 },
  },
  {
    // Grid-forward ledger: square corners, dense ticks, everything on the rule.
    id: "terminal",
    label: "Terminal",
    tier: "classic",
    twod: {
      labelFraction: 0.046,
      strokeFraction: 0.006,
      gridFraction: 0.0026,
      gridOpacity: 0.42,
      dashFraction: 0.012,
      dashGapFraction: 0.012,
      areaOpacity: 0.35,
      points: true,
      pointFraction: 0.01,
      tickWeight: 0.55,
      axisLine: true,
    },
    threed: {
      roughness: 0.6,
      metalness: 0.05,
      bevelScale: 0.15,
      interiorFlatStacks: true,
    },
    shared: { gridStyleWeight: 1.35, pieGapScale: 0.5, cornerRadiusScale: 0 },
  },

  // ── Studio: crafted, video-native, the looks a launch film reaches for ──
  {
    // Soft top-light gloss, gentle radius, value labels in pills.
    id: "studio",
    label: "Studio",
    tier: "studio",
    twod: {
      gridOpacity: 0.22,
      areaOpacity: 0.5,
      points: true,
      pointFraction: 0.013,
      labelPill: true,
    },
    threed: { roughness: 0.3, metalness: 0.12, clearcoat: 0.35, bevelScale: 1.2 },
    shared: { legendChrome: "chips", cornerRadiusScale: 1.15 },
  },
  {
    // Theme-gradient fills rising vertically, no gridlines, labels floating clear: fintech landing-page energy.
    id: "gradientRise",
    label: "Gradient rise",
    tier: "studio",
    twod: {
      gridOpacity: 0.12,
      areaOpacity: 0.9,
      areaGradient: "vertical",
      pieRadius: 0.88,
    },
    threed: { roughness: 0.35, metalness: 0.05, clearcoat: 0.2, bevelScale: 1.1, wallGrid: false },
    shared: {
      gridStyleWeight: 0,
      legendChrome: "chips",
      cornerRadiusScale: 1.3,
      fontEmphasis: "headline",
    },
  },
  {
    // Frosted translucent solids with clearcoat edges: built for the dark stages first.
    id: "glass",
    label: "Glass",
    tier: "studio",
    twod: {
      gridOpacity: 0.2,
      areaOpacity: 0.3,
      strokeWidthScale: 1.15,
      labelPill: true,
    },
    threed: {
      roughness: 0.12,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.12,
      transmission: 0.85,
      thickness: 0.6,
      ior: 1.45,
      bevelScale: 1.25,
      wallGrid: false,
      interiorFlatStacks: true,
    },
    shared: { legendChrome: "chips", cornerRadiusScale: 1.25 },
  },
  {
    // High clearcoat over saturated fills, soft shadow, nothing sharp.
    id: "velvet",
    label: "Velvet",
    tier: "studio",
    twod: {
      gridOpacity: 0.16,
      areaOpacity: 0.7,
      strokeWidthScale: 1.1,
      labelPill: true,
    },
    threed: {
      roughness: 0.28,
      metalness: 0.05,
      clearcoat: 0.9,
      clearcoatRoughness: 0.35,
      bevelScale: 1.3,
      wallGrid: false,
    },
    shared: {
      gridStyleWeight: 0.6,
      legendChrome: "chips",
      cornerRadiusScale: 1.4,
      fontEmphasis: "headline",
    },
  },
  {
    // Area-first: a strong vertical ramp, no axis line, whitespace doing the framing.
    id: "horizon",
    label: "Horizon",
    tier: "studio",
    twod: {
      labelFraction: 0.052,
      gapScale: 0.72,
      strokeFraction: 0.01,
      gridOpacity: 0.14,
      areaOpacity: 0.95,
      areaGradient: "vertical",
      points: true,
      pointFraction: 0.012,
      pieRadius: 0.82,
    },
    threed: { roughness: 0.38, metalness: 0.06, clearcoat: 0.15, bevelScale: 1.1, wallGrid: false },
    shared: { gridStyleWeight: 0.35, cornerRadiusScale: 1.2, fontEmphasis: "headline" },
  },

  // ── Market: crypto and finance, customer-facing ──
  {
    // Deep stage, gold-leaning metal under a clearcoat: the premium finance shot.
    id: "midnightGold",
    label: "Midnight gold",
    tier: "market",
    twod: {
      strokeFraction: 0.009,
      gridOpacity: 0.2,
      areaOpacity: 0.6,
      points: true,
      pointFraction: 0.012,
      labelPill: true,
      tickWeight: 0.25,
    },
    threed: {
      roughness: 0.22,
      metalness: 0.75,
      clearcoat: 0.5,
      clearcoatRoughness: 0.18,
      emissiveEdge: 0.1,
      bevelScale: 1.15,
    },
    shared: {
      gridStyleWeight: 0.75,
      legendChrome: "chips",
      cornerRadiusScale: 0.9,
      fontEmphasis: "headline",
    },
  },
  {
    // Dark-first ledger: glowing edges, dashed hairlines, tick numerals carrying weight, tight enough for a compact frame.
    id: "neonLedger",
    label: "Neon ledger",
    tier: "market",
    twod: {
      labelFraction: 0.046,
      valueScale: 1,
      strokeFraction: 0.007,
      gridFraction: 0.0016,
      gridOpacity: 0.3,
      dashFraction: 0.014,
      dashGapFraction: 0.018,
      areaOpacity: 0.3,
      points: true,
      pointFraction: 0.011,
      tickWeight: 0.6,
      axisLine: true,
    },
    threed: {
      roughness: 0.5,
      metalness: 0.15,
      clearcoat: 0.15,
      emissiveEdge: 0.55,
      bevelScale: 0.5,
      floorShadow: false,
      interiorFlatStacks: true,
    },
    shared: { gridStyleWeight: 1.1, legendChrome: "chips", cornerRadiusScale: 0.25 },
  },
  {
    // Glass and glow together over a rising ramp: the crypto hero look, and the only preset that runs both.
    id: "pulseGlass",
    label: "Pulse glass",
    tier: "market",
    twod: {
      gridOpacity: 0.18,
      areaOpacity: 0.55,
      areaGradient: "vertical",
      strokeWidthScale: 1.25,
      points: true,
      pointFraction: 0.013,
      labelPill: true,
    },
    threed: {
      roughness: 0.1,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.1,
      transmission: 0.7,
      thickness: 0.75,
      ior: 1.5,
      emissiveEdge: 0.7,
      bevelScale: 1.3,
      wallGrid: false,
    },
    shared: {
      gridStyleWeight: 0.5,
      legendChrome: "chips",
      cornerRadiusScale: 1.3,
      fontEmphasis: "headline",
    },
  },

  // ── Dark: three distinct night-stage voices, from editorial to launch to material ──
  {
    // Restrained editorial: fine rules, compact type and a barely luminous edge over matte marks.
    id: "nightEditorial",
    label: "Night editorial",
    tier: "dark",
    twod: {
      labelFraction: 0.046,
      strokeFraction: 0.006,
      strokeWidthScale: 0.78,
      gridFraction: 0.0015,
      gridOpacity: 0.2,
      areaOpacity: 0.32,
      pieGap: 0.004,
      tickWeight: 0.2,
      axisLine: true,
    },
    threed: {
      roughness: 0.78,
      metalness: 0.05,
      clearcoat: 0,
      emissiveEdge: 0.08,
      bevelScale: 0.4,
      floorShadow: false,
      interiorFlatStacks: true,
    },
    shared: {
      gridStyleWeight: 0.55,
      pieGapScale: 0.65,
      cornerRadiusScale: 0.2,
    },
  },
  {
    // Luminous launch dashboard: a bright ramp, strong points and glowing dimensional edges.
    id: "launchGlow",
    label: "Launch glow",
    tier: "dark",
    twod: {
      gridOpacity: 0.16,
      areaOpacity: 0.82,
      areaGradient: "vertical",
      strokeWidthScale: 1.35,
      points: true,
      pointFraction: 0.016,
      labelPill: true,
    },
    threed: {
      roughness: 0.24,
      metalness: 0.08,
      clearcoat: 0.3,
      clearcoatRoughness: 0.18,
      emissiveEdge: 0.9,
      bevelScale: 1.15,
      wallGrid: false,
    },
    shared: {
      gridStyleWeight: 0.35,
      legendChrome: "chips",
      cornerRadiusScale: 1.25,
      fontEmphasis: "headline",
    },
  },
  {
    // Premium dimensional material: dense dark metal, broad clearcoat and a sculpted bevel without glow.
    id: "obsidian",
    label: "Obsidian",
    tier: "dark",
    twod: {
      gridOpacity: 0.12,
      areaOpacity: 0.58,
      strokeWidthScale: 1.05,
      labelPill: true,
      pieRadius: 0.86,
    },
    threed: {
      roughness: 0.16,
      metalness: 0.88,
      clearcoat: 0.82,
      clearcoatRoughness: 0.14,
      bevelScale: 1.45,
      wallGrid: false,
    },
    shared: {
      gridStyleWeight: 0.25,
      legendChrome: "chips",
      cornerRadiusScale: 0.75,
      fontEmphasis: "headline",
    },
  },
];

function buildCatalogue(): Record<string, ChartStylePreset> {
  const table: Record<string, ChartStylePreset> = {};
  for (const seed of SEEDS) {
    table[seed.id] = {
      id: seed.id,
      label: seed.label,
      tier: seed.tier,
      surface: {
        ...BASE_SHARED,
        ...seed.shared,
        id: seed.id,
        twod: { ...BASE_2D, ...seed.twod },
        threed: { ...BASE_3D, ...seed.threed },
      },
    };
  }
  return table;
}

/** The appearance catalogue, keyed by preset id. */
export const CHART_STYLE_PRESETS: Record<string, ChartStylePreset> = buildCatalogue();

/** Carousel order (boardroom first, then the rest of classic, studio, market and dark): what a picker lists. */
export const CHART_STYLE_PRESET_IDS: string[] = SEEDS.map((s) => s.id);

/** The id every unknown preset degrades to. */
export const CHART_STYLE_DEFAULT_ID = "boardroom";

export function isChartStylePresetId(id: string): boolean {
  return id in CHART_STYLE_PRESETS;
}

const warnedPresets = new Set<string>();

function presetFor(requestedId: string): ChartStylePreset {
  const preset = CHART_STYLE_PRESETS[requestedId];
  if (preset) return preset;
  if (!warnedPresets.has(requestedId)) {
    warnedPresets.add(requestedId);
    console.warn(
      `[chart] unknown style preset "${requestedId}", using "${CHART_STYLE_DEFAULT_ID}"`,
    );
  }
  return CHART_STYLE_PRESETS[CHART_STYLE_DEFAULT_ID];
}

const cloneSurface = (s: ChartStyleSurface): ChartStyleSurface => ({
  ...s,
  twod: { ...s.twod },
  threed: { ...s.threed },
});

/** True when the preset was designed for a dark stage: glass, glow or a metallic finish all lose their point on white. Derived, so no preset carries a flag that could disagree with its own numbers. */
export function isDarkFirstSurface(surface: ChartStyleSurface): boolean {
  const { transmission, emissiveEdge, metalness } = surface.threed;
  return transmission > 0 || emissiveEdge > 0 || metalness >= DARK_FIRST_METALNESS;
}

const isLightTheme = (theme: Theme): boolean =>
  hexToOklch(hex(theme.colors.background) ?? FALLBACK_BACKGROUND).l >= 0.5;

/** The finish a STACK SEGMENT takes: under `interiorFlatStacks` the segments go matte and drop gloss and glow, so a tall stack reads as blocks rather than a column of highlights. Identity otherwise. */
export function chartStackSurface(threed: ChartStyleSurface3D): ChartStyleSurface3D {
  if (!threed.interiorFlatStacks) return threed;
  return {
    ...threed,
    roughness: Math.max(threed.roughness, INTERIOR_ROUGHNESS),
    clearcoat: 0,
    emissiveEdge: 0,
  };
}

/**
 * The appearance surface for one chart: the preset, then the authored `style` scalars, then the theme. A fresh object every call, so a renderer can hold it without touching the catalogue.
 *
 * Merge rules, per authored field:
 * - `preset`: picks the base surface; an unknown id degrades to boardroom (warned once).
 * - `cornerRadius`: SCALES, never replaces. The renderers take `style.cornerRadius * surface.cornerRadiusScale`; resolve caps the scale so the product cannot pass 1 (velvet rounds further, terminal squares everything, neither can overshoot the geometric limit).
 * - `innerRadius`: a donut narrows `pieGapScale` by `DONUT_GAP_RELIEF`, since the same angular gap opens wider at the inner edge.
 * - `depth`: scales `threed.thickness`, so refraction tracks the solid it passes through and the preset value lands exactly at the default depth.
 * - `gap`: no surface effect. Layout owns it (it moves the marks, never the finish), and crowding is the renderer's own mark geometry to judge.
 * - theme: a dark-first surface (glass, glow or metal) relaxes its glow, its refraction (transmission and thickness) and its metalness on a light theme, where they read as grime rather than shine.
 */
export function resolveChartStyle(
  presetId: string,
  style: ChartStyle,
  theme: Theme,
): ChartStyleSurface {
  const surface = cloneSurface(presetFor(presetId).surface);
  const radius = clamp01(style.cornerRadius);
  if (radius > 0) surface.cornerRadiusScale = Math.min(surface.cornerRadiusScale, 1 / radius);
  if (style.innerRadius > 0) surface.pieGapScale *= DONUT_GAP_RELIEF;
  surface.threed.thickness *= DEPTH_THICKNESS_BASE + clamp01(style.depth);
  if (isLightTheme(theme) && isDarkFirstSurface(surface)) {
    surface.threed.emissiveEdge *= LIGHT_EMISSIVE;
    surface.threed.transmission *= LIGHT_TRANSMISSION;
    surface.threed.thickness *= LIGHT_TRANSMISSION;
    surface.threed.metalness *= LIGHT_METALNESS;
  }
  return surface;
}

/** Stop colours for a vertical fill under `areaGradient: "vertical"`, base to top: the series colour itself at 1 (the value curve), mixed toward the theme background through OKLCH on the way down to 0 (the baseline or the stack layer below), which is the same axis a ramp texture's v runs along. Colours only: the renderers build their write-once `DataTexture` from these, so the ramp stays a pure function of (theme, colour, fade). */
export function chartGradientRamp(
  theme: Theme,
  seriesColour: string,
  fade: number = CHART_GRADIENT_FADE,
): [string, number][] {
  const top = hex(seriesColour) ?? hex(theme.colors.accent) ?? FALLBACK_ACCENT;
  const colour = hexToOklch(top);
  const background = hexToOklch(hex(theme.colors.background) ?? FALLBACK_BACKGROUND);
  const k = clamp01(fade);
  const mix = (t: number): string => bytesToHex(oklchToBytes(mixOklch(colour, background, t)));
  return [
    [mix(k), 0],
    [mix(k * RAMP_KNEE_MIX), RAMP_KNEE],
    [top, 1],
  ];
}

/** The palette swatch a series takes under `seriesLightnessStep`: each successive index steps that far in OKLCH lightness AWAY from the background, so a flat editorial look still separates its layers without a second hue. Index 0 and a zero step are the swatch untouched. */
export function chartSeriesTint(
  colour: string,
  background: string,
  index: number,
  step: number,
): string {
  const swatch = hex(colour);
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  if (!swatch || i === 0 || !Number.isFinite(step) || step === 0) return swatch ?? colour;
  const bg = hexToOklch(hex(background) ?? FALLBACK_BACKGROUND);
  const lch = hexToOklch(swatch);
  const away = bg.l >= 0.5 ? -1 : 1;
  return bytesToHex(
    oklchToBytes({ ...lch, l: clamp(lch.l + away * step * i, TINT_LIMITS.lo, TINT_LIMITS.hi) }),
  );
}
