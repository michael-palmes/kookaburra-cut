/** Chart number formatting: hand-rolled, pure, and deliberately free of `Intl` (its locale data varies across macOS versions, which would break byte-identical export). One formatter serves axis labels, value labels and the counter tick-up, so a counting label settles on exactly the printed static value. */

import type { ChartValueFormat } from "./types";

/** Schema defaults: auto decimals, thousands separator on, no affixes, no compaction. */
export const CHART_DEFAULT_FORMAT: ChartValueFormat = {
  decimals: null,
  separator: true,
  prefix: "",
  suffix: "",
  compact: false,
};

/** Fixed decimal places cap (auto is `null`); the sidecar resolver clamps to the same bound. */
export const CHART_DECIMALS_MAX = 4;

const AUTO_DECIMALS = 2;
const AUTO_COMPACT_DECIMALS = 1;

const COMPACT_UNITS = [
  { divisor: 1e3, symbol: "k" },
  { divisor: 1e6, symbol: "M" },
  { divisor: 1e9, symbol: "B" },
] as const;

type CompactUnit = (typeof COMPACT_UNITS)[number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const groupThousands = (whole: string): string => whole.replace(/\B(?=(\d{3})+$)/g, ",");

/** `toFixed` rounding is spec-defined (ties away from zero), so the same value prints the same string on every machine. */
function digits(value: number, places: number, trim: boolean, separator: boolean): string {
  const fixed = value.toFixed(places);
  const dot = fixed.indexOf(".");
  let whole = dot < 0 ? fixed : fixed.slice(0, dot);
  let frac = dot < 0 ? "" : fixed.slice(dot + 1);
  if (trim) frac = frac.replace(/0+$/, "");
  if (separator && /^\d+$/.test(whole)) whole = groupThousands(whole);
  return frac ? `${whole}.${frac}` : whole;
}

const divisorAt = (index: number): number => (index < 0 ? 1 : COMPACT_UNITS[index].divisor);

/** The unit a magnitude prints in, after rounding: 999,999 settles on 1M, never 1000.0k. */
function compactUnit(magnitude: number, places: number): CompactUnit | null {
  let i = -1;
  while (i + 1 < COMPACT_UNITS.length && magnitude >= COMPACT_UNITS[i + 1].divisor) i++;
  while (
    i + 1 < COMPACT_UNITS.length &&
    Number((magnitude / divisorAt(i)).toFixed(places)) >= COMPACT_UNITS[0].divisor
  ) {
    i++;
  }
  return i < 0 ? null : COMPACT_UNITS[i];
}

/** Formats one value for display: sign, then prefix, then digits, then any compact unit, then suffix (so a negative dollar million reads `-$1.2M`). Non-finite input prints as zero, matching how the layout reads broken cells. */
export function formatChartValue(value: number, format: Partial<ChartValueFormat> = {}): string {
  const n = Number.isFinite(value) ? value : 0;
  const compact = format.compact === true;
  const fixed = typeof format.decimals === "number" && Number.isFinite(format.decimals);
  const places = fixed
    ? Math.round(clamp(format.decimals as number, 0, CHART_DECIMALS_MAX))
    : compact
      ? AUTO_COMPACT_DECIMALS
      : AUTO_DECIMALS;
  const magnitude = Math.abs(n);
  const unit = compact ? compactUnit(magnitude, places) : null;
  const text = digits(
    unit ? magnitude / unit.divisor : magnitude,
    places,
    !fixed,
    format.separator !== false,
  );
  // A value that rounds to nothing prints as 0, not -0, so a counter crossing zero never flickers a sign.
  const sign = n < 0 && /[1-9]/.test(text) ? "-" : "";
  return `${sign}${format.prefix ?? ""}${text}${unit?.symbol ?? ""}${format.suffix ?? ""}`;
}
