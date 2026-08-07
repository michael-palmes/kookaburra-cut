/** The named chart COLOUR SCHEME catalogue: ten hand-tuned six-swatch sets a chart can wear instead of its theme's `chartColors` (`chart.palette` in the sidecar). Pure data, modelled on `CHART_STYLE_PRESETS`, so a scheme is the same hexes on every machine and an unset `palette` changes nothing (docs/determinism.md).
 *
 * A scheme is BACKGROUND-AGNOSTIC: unlike a theme palette, which is curated against one background, a scheme has to hold on the darkest and the lightest bundled theme alike. That pins every swatch into a mid-tone luminance band, so the schemes differ by hue family and chroma rather than by tone, and no scheme runs to neon-bright or pastel-pale. The contract each one holds (pinned by `paletteSchemes.test.ts`): 3:1 against every bundled theme background, neighbouring swatches separated in OKLab so a two-series chart never reads as one, and no two swatches in a set colliding. */

export interface ChartPaletteScheme {
  id: string;
  label: string;
  /** Six hexes, indexed by series (by CATEGORY for pie); indices wrap like every other palette source. */
  swatches: readonly string[];
}

const SCHEMES: ChartPaletteScheme[] = [
  {
    id: "reef",
    label: "Reef",
    swatches: ["#1a9590", "#af4c4c", "#458864", "#be6e92", "#00769c", "#a46d35"],
  },
  {
    id: "sunrise",
    label: "Sunrise",
    swatches: ["#d16a45", "#ae4977", "#a66c29", "#b56baf", "#bd4856", "#8b74b5"],
  },
  {
    id: "eucalypt",
    label: "Eucalypt",
    swatches: ["#4a9468", "#766e05", "#2e8679", "#74914d", "#8a6d32", "#66866c"],
  },
  {
    id: "outback",
    label: "Outback",
    swatches: ["#b57938", "#af4c46", "#8b7734", "#c06b82", "#a76c51", "#7a7250"],
  },
  {
    id: "harbour",
    label: "Harbour",
    swatches: ["#4b89cb", "#00768a", "#7371ba", "#4390b1", "#21867d", "#70809e"],
  },
  {
    id: "orchid",
    label: "Orchid",
    swatches: ["#a572c3", "#a44d81", "#6f72c1", "#c76b83", "#93618f", "#6880a9"],
  },
  {
    id: "citrus",
    label: "Citrus",
    swatches: ["#928800", "#aa5223", "#5d8740", "#b57c27", "#b35054", "#7b8252"],
  },
  {
    id: "vivid",
    label: "Vivid",
    swatches: ["#b666ce", "#00787b", "#4d73d8", "#429a4d", "#bf4535", "#0088bc"],
  },
  {
    id: "muted",
    label: "Muted",
    swatches: ["#6e8aa7", "#8f5e62", "#4e846a", "#9082a5", "#8b674d", "#5d8688"],
  },
  {
    id: "slate",
    label: "Slate",
    swatches: ["#5b8ab6", "#467278", "#7b79a1", "#6c7375", "#49938d", "#607c91"],
  },
];

/** The scheme catalogue, keyed by id. */
export const CHART_PALETTE_SCHEMES: Record<string, ChartPaletteScheme> = Object.fromEntries(
  SCHEMES.map((s) => [s.id, s]),
);

/** Picker order: what the inspector lists after the "Theme" tile. */
export const CHART_PALETTE_SCHEME_IDS: string[] = SCHEMES.map((s) => s.id);

export function isChartPaletteSchemeId(id: string): boolean {
  return id in CHART_PALETTE_SCHEMES;
}

const warned = new Set<string>();

/** The six swatches for an authored `chart.palette`, or null for "no scheme": absent, blank, or an id this build does not know (which warns once and falls through to the theme, the style-preset degrade). */
export function chartPaletteSwatches(id: string | null | undefined): readonly string[] | null {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed.length === 0) return null;
  const scheme = CHART_PALETTE_SCHEMES[trimmed];
  if (scheme) return scheme.swatches;
  if (!warned.has(trimmed)) {
    warned.add(trimmed);
    console.warn(`[chart] unknown colour scheme "${trimmed}", using the theme palette`);
  }
  return null;
}
