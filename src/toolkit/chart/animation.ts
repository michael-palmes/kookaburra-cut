/** The chart build-in catalogue and its sampler. Every preset is DATA (a row of channel parameters), and `buildChartRevealSampler` turns one row plus the authored delivery, stagger and duration into a pure function of `(seriesIndex, categoryIndex)` closed over the current scene-local time: no clock reads, no state, no `Math.random` (`from: "shuffle"` is the seeded `unitHash01` order), so preview and the export loop agree byte for byte. The renderers only ever see the channels, never a preset id: `channels.enter` resolves to the `drop` channel for `fall`, and only `lift` (which moves the whole chart) is read back off the preset, by the host. */

import { ease } from "../../engine/ease";
import { unitHash01 } from "../text/presets";
import type {
  ChartAnimationConfig,
  ChartAnimationFrom,
  ChartReveal,
  ChartRevealFn,
  ChartRevealSampler,
  ChartSeriesReveal,
  ChartSeriesRevealFn,
  ChartType,
} from "./types";

/** The mark geometry a type shares with its siblings: what applicability and degrade are keyed on. */
export type ChartFamily = "bars" | "lines" | "pie";

export function chartFamilyOf(type: ChartType): ChartFamily {
  if (type === "pie") return "pie";
  return type === "line" || type === "area" || type === "stackedArea" ? "lines" : "bars";
}

const BAR_TYPES: ChartType[] = ["column", "bar", "stackedColumn", "stackedBar"];
const LINE_TYPES: ChartType[] = ["line", "area", "stackedArea"];
const STACKED_TYPES: ChartType[] = ["stackedColumn", "stackedBar", "stackedArea"];
const ALL_TYPES: ChartType[] = [...BAR_TYPES, ...LINE_TYPES, "pie"];

// ── Contract constants (pinned: changing any re-renders every project that uses the preset) ──

/** Where the overshoot lobe peaks inside an element's window; past it the lobe settles to exactly 1. */
const OVERSHOOT_PEAK = 0.62;
/** Attack fraction of every 0 → 1 → 0 envelope (pulse, squash): fast in, slower out. */
const BUMP_ATTACK = 0.28;
/** Tail of an element's window that a landing squash takes, after the arrival touches down. */
const SQUASH_P = 0.25;
/** Emphasis envelope width, ms. */
export const CHART_PULSE_MS = 420;
/** Gap between one element's pulse and the next under `pulse: "order"`. */
const PULSE_STEP_MS = 170;
/** Hold after the build lands before a post-build pulse fires. */
const PULSE_HOLD_MS = 120;
/** Shine band sweep width, ms, and the beat an element holds after landing before it sweeps. */
export const CHART_SHINE_MS = 520;
const SHINE_DELAY_MS = 80;
/** How far behind the rest of the build `lastLate` pushes the final category. */
const BREAKOUT_GAP_MS = 260;
/** Ripple cycles across the category axis (`channels.ripple` is its swing, in stagger units). */
const WAVE_CYCLES = 1.5;
/** Draw-on presets: how much of the draw an element's alpha takes to come up once the head passes. */
const PASS_SOFT = 0.12;
/** Surge: the share of the lift phase spent spreading the per-point starts left to right. */
const SURGE_SPREAD = 0.5;
/** `from: "shuffle"` order salt; the order is a pure hash of the index, never Math.random. */
const SHUFFLE_SALT = 7351;

/** Host and renderer entrance offsets, as a fraction of the plot's value-axis extent, driven by `(1 - count)`: `lift` moves the whole chart, `fall` drops each element in from beyond the far end of the value axis. */
export const CHART_ENTER_LIFT = 0.03;
export const CHART_ENTER_FALL = 0.45;

// ── The channel parameterisation ─────────────────────────────────────────────

/** How a mark's extent arrives: `rise` fills over its own window, `full` is there from the start (the reveal rides alpha, draw or the entrance), `surge` holds at the baseline through the draw phase then lifts in category order. */
export type ChartGrowMode = "rise" | "full" | "surge";
/** Where `alpha` comes from: the element's own window, the draw head passing it, or the series completing its draw. */
export type ChartAlphaMode = "window" | "pass" | "afterDraw";
/** Where `count` comes from: the element's arrival, the draw head passing it, or (final category only) the whole series draw. */
export type ChartCountMode = "window" | "pass" | "lastDraw";
/** When the emphasis envelope fires: on arrival, once on the final category after the build, or once per element in legend order after the build. */
export type ChartPulseMode = "none" | "land" | "final" | "order";
export type ChartShineMode = "none" | "afterLand";
/** The entrance transform the arrival curve cannot carry, driven by `(1 - count)`: `lift` moves the whole chart (the HOST applies it, `chartEnterOffset`), `fall` displaces each element along the value axis (the sampler carries it on `ChartReveal.drop`, every renderer applies it). */
export type ChartEnterMode = "none" | "lift" | "fall";

export interface ChartPresetChannels {
  /** Arrival ease (an `engine/ease` name) for `grow` and `count`. */
  ease: string;
  grow: ChartGrowMode;
  /** Past-1 overshoot on `grow`, 0 to 0.06, settled by one hermite lobe; gated to the final category when `lastLate`. */
  overshoot: number;
  /** Landing squash depth on `grow`, 0 to 0.03: the arrival lands early and the window's tail squashes and releases. */
  squash: number;
  /** Fraction of an element's window spent fading `alpha` in. */
  fadeP: number;
  /** Fraction of the SERIES window the draw edge takes; 0 = no draw channel (`draw` stays 1, `headX` -1). */
  drawP: number;
  alpha: ChartAlphaMode;
  count: ChartCountMode;
  pulse: ChartPulseMode;
  shine: ChartShineMode;
  /** Sine ripple added to each element's delay across the category axis, in stagger units; 0 = none. */
  ripple: number;
  /** Multiplies the authored `staggerMs`. */
  staggerScale: number;
  /** The final category arrives after the whole build, and takes the overshoot and shine on its own. */
  lastLate: boolean;
  enter: ChartEnterMode;
}

export type ChartPresetTier = "core" | "signature" | "market";

export interface ChartAnimationPreset {
  id: string;
  label: string;
  tier: ChartPresetTier;
  /** The chart types the preset was designed for. */
  types: ChartType[];
  /** Where it hands over when it meets a family it does not fully cover: its own id for the families it does. */
  degrade: Record<ChartFamily, string>;
  channels: ChartPresetChannels;
}

const BASE_CHANNELS: ChartPresetChannels = {
  ease: "outExpo",
  grow: "rise",
  overshoot: 0,
  squash: 0,
  fadeP: 0.35,
  drawP: 0,
  alpha: "window",
  count: "window",
  pulse: "none",
  shine: "none",
  ripple: 0,
  staggerScale: 1,
  lastLate: false,
  enter: "none",
};

/** Each family's core default: what every preset degrades to on a family it does not fully cover. */
const CORE_DEFAULT: Record<ChartFamily, string> = { bars: "rise", lines: "draw", pie: "sweep" };

interface ChartPresetSeed {
  id: string;
  label: string;
  tier: ChartPresetTier;
  types: ChartType[];
  channels: Partial<ChartPresetChannels>;
}

/** The catalogue in tier order. Applicability is `types`; the degrade column is derived (a family the preset does not cover WHOLE hands over to that family's core default), so `draw` on a column becomes `rise` and `ticker` on a pie becomes `sweep`. */
const SEEDS: ChartPresetSeed[] = [
  // ── Core: safe, restrained, motion-design timing ──
  {
    id: "rise",
    label: "Rise",
    tier: "core",
    types: BAR_TYPES,
    channels: {},
  },
  {
    id: "draw",
    label: "Draw",
    tier: "core",
    types: LINE_TYPES,
    // The stroke draws on left to right, then the fill and the labels come up behind it.
    channels: {
      ease: "outQuint",
      grow: "full",
      drawP: 0.75,
      alpha: "afterDraw",
      count: "pass",
      fadeP: 0.2,
    },
  },
  {
    id: "sweep",
    label: "Sweep",
    tier: "core",
    types: ["pie"],
    channels: { ease: "outQuint", fadeP: 0.25 },
  },
  {
    id: "fadeUp",
    label: "Fade up",
    tier: "core",
    types: ALL_TYPES,
    channels: { ease: "outQuad", grow: "full", fadeP: 1, enter: "lift" },
  },
  {
    id: "wipe",
    label: "Wipe",
    tier: "core",
    types: ALL_TYPES,
    channels: {
      ease: "outQuad",
      grow: "full",
      drawP: 1,
      alpha: "pass",
      count: "pass",
      fadeP: 0.15,
    },
  },
  {
    id: "pop",
    label: "Pop",
    tier: "core",
    types: ALL_TYPES,
    channels: { ease: "outQuint", overshoot: 0.03, pulse: "land", fadeP: 0.25 },
  },

  // ── Signature: engaging, video-native ──
  {
    id: "ticker",
    label: "Ticker",
    tier: "signature",
    types: BAR_TYPES,
    channels: { ease: "outQuint", overshoot: 0.045, fadeP: 0.2 },
  },
  {
    id: "trace",
    label: "Trace",
    tier: "signature",
    types: LINE_TYPES,
    channels: {
      ease: "outQuint",
      grow: "full",
      drawP: 1,
      alpha: "pass",
      count: "pass",
      fadeP: 0.15,
    },
  },
  {
    id: "assemble",
    label: "Assemble",
    tier: "signature",
    types: STACKED_TYPES,
    channels: { ease: "outQuint", grow: "full", enter: "fall", fadeP: 0.3, staggerScale: 0.6 },
  },
  {
    id: "bloom",
    label: "Bloom",
    tier: "signature",
    types: ["pie"],
    channels: { ease: "outQuint", overshoot: 0.05, pulse: "land", fadeP: 0.25 },
  },
  {
    id: "drop",
    label: "Drop",
    tier: "signature",
    types: BAR_TYPES,
    // Gravity in, then the catch: the arrival lands at 75 percent of the window and the tail squashes and releases.
    channels: {
      ease: "inQuad",
      grow: "full",
      squash: 0.028,
      pulse: "land",
      fadeP: 0.15,
      enter: "fall",
    },
  },
  {
    id: "orbitBuild",
    label: "Orbit build",
    tier: "signature",
    types: ALL_TYPES,
    channels: { staggerScale: 1.6, fadeP: 0.3 },
  },
  {
    id: "wave",
    label: "Wave",
    tier: "signature",
    types: ALL_TYPES,
    channels: { ripple: 1.4, fadeP: 0.3 },
  },

  // ── Market: crypto and finance, customer-facing ──
  {
    id: "marketPulse",
    label: "Market pulse",
    tier: "market",
    types: LINE_TYPES,
    channels: {
      ease: "outQuint",
      grow: "full",
      drawP: 1,
      alpha: "pass",
      count: "lastDraw",
      pulse: "final",
      fadeP: 0.15,
    },
  },
  {
    id: "surge",
    label: "Surge",
    tier: "market",
    types: LINE_TYPES,
    channels: { ease: "outQuint", grow: "surge", drawP: 0.45, alpha: "pass", fadeP: 0.15 },
  },
  {
    id: "momentum",
    label: "Momentum",
    tier: "market",
    types: BAR_TYPES,
    channels: { shine: "afterLand", fadeP: 0.25 },
  },
  {
    id: "ledger",
    label: "Ledger",
    tier: "market",
    types: STACKED_TYPES,
    // Bottom-up per category is the cascade rank order itself: category major, series ascending.
    channels: { ease: "outQuint", fadeP: 0.2, staggerScale: 0.8 },
  },
  {
    id: "allocation",
    label: "Allocation",
    tier: "market",
    types: ["pie"],
    channels: { ease: "outQuint", pulse: "order", fadeP: 0.2 },
  },
  {
    id: "breakout",
    label: "Breakout",
    tier: "market",
    types: ALL_TYPES,
    // Additive: nothing dims, the final category simply arrives late with the overshoot, a pulse and a shine.
    channels: {
      overshoot: 0.05,
      pulse: "final",
      shine: "afterLand",
      lastLate: true,
      fadeP: 0.25,
    },
  },
];

function degradeFor(types: ChartType[]): Record<ChartFamily, string> {
  const own = new Set(types);
  const covers = (family: ChartFamily): boolean =>
    ALL_TYPES.filter((t) => chartFamilyOf(t) === family).every((t) => own.has(t));
  return {
    bars: covers("bars") ? "" : CORE_DEFAULT.bars,
    lines: covers("lines") ? "" : CORE_DEFAULT.lines,
    pie: covers("pie") ? "" : CORE_DEFAULT.pie,
  };
}

function buildCatalogue(): Record<string, ChartAnimationPreset> {
  const table: Record<string, ChartAnimationPreset> = {};
  for (const seed of SEEDS) {
    const degrade = degradeFor(seed.types);
    for (const family of ["bars", "lines", "pie"] as ChartFamily[]) {
      if (degrade[family] === "") degrade[family] = seed.id;
    }
    table[seed.id] = {
      id: seed.id,
      label: seed.label,
      tier: seed.tier,
      types: seed.types,
      degrade,
      channels: { ...BASE_CHANNELS, ...seed.channels },
    };
  }
  return table;
}

/** The build-in catalogue, keyed by preset id. */
export const CHART_ANIMATION_PRESETS: Record<string, ChartAnimationPreset> = buildCatalogue();

/** Catalogue order (core, then signature, then market): what a picker lists. */
export const CHART_ANIMATION_PRESET_IDS: string[] = SEEDS.map((s) => s.id);

export function isChartPresetId(id: string): boolean {
  return id in CHART_ANIMATION_PRESETS;
}

const warnedPresets = new Set<string>();

/** The preset a type actually plays: an unknown id degrades to `rise` (warned once), then applicability degrades per family, so `draw` on a column plays `rise` and `ticker` on a pie plays `sweep`. */
export function chartPresetFor(type: ChartType, requestedId: string): ChartAnimationPreset {
  let preset = CHART_ANIMATION_PRESETS[requestedId];
  if (!preset) {
    if (!warnedPresets.has(requestedId)) {
      warnedPresets.add(requestedId);
      console.warn(`[chart] unknown animation preset "${requestedId}", using "rise"`);
    }
    preset = CHART_ANIMATION_PRESETS.rise;
  }
  const family = chartFamilyOf(type);
  for (let hop = 0; hop < 3 && !preset.types.includes(type); hop++) {
    const next = CHART_ANIMATION_PRESETS[preset.degrade[family]];
    if (!next || next.id === preset.id) break;
    preset = next;
  }
  return preset;
}

// ── Curves ───────────────────────────────────────────────────────────────────

const clampUnit = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The cubic hermite the local settle and envelope curves are built from. */
const smooth = (u: number): number => {
  const x = clampUnit(u);
  return x * x * (3 - 2 * x);
};

/** One 0 → 1 → 0 lobe, fast attack and slower release, flat at both ends (the pulse and squash envelope). */
function bump(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return u < BUMP_ATTACK
    ? smooth(u / BUMP_ATTACK)
    : smooth(1 - (u - BUMP_ATTACK) / (1 - BUMP_ATTACK));
}

function bumpAt(localMs: number, startMs: number, widthMs: number): number {
  return widthMs <= 0 ? 0 : bump((localMs - startMs) / widthMs);
}

/** The arrival curve: the preset's ease when it does not overshoot, otherwise a local hermite lobe peaking at `1 + over` and settling back to exactly 1 by the end of the window (one lobe, never a second bounce). */
function settle(t: number, over: number, easeName: string): number {
  if (over <= 0) return ease(easeName, t);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t <= OVERSHOOT_PEAK) return (1 + over) * smooth(t / OVERSHOOT_PEAK);
  return 1 + over * (1 - smooth((t - OVERSHOOT_PEAK) / (1 - OVERSHOOT_PEAK)));
}

/** Linear progress through one element's window; a zero duration snaps at its delay. */
function windowT(localMs: number, delayMs: number, durationMs: number): number {
  if (durationMs <= 0) return localMs >= delayMs ? 1 : 0;
  return clampUnit((localMs - delayMs) / durationMs);
}

/** Delivery order of `n` elements under `from`: `ranks[i]` is element i's place in the queue. `shuffle` sorts on a seeded hash, ties broken by index, so the same inputs always give the same order. */
function orderRanks(n: number, from: ChartAnimationFrom): number[] {
  const ranks = new Array<number>(Math.max(0, n)).fill(0);
  if (n <= 1) return ranks;
  const centre = (n - 1) / 2;
  const keyed = Array.from({ length: n }, (_, i) => ({ index: i, key: orderKey(i, centre, from) }));
  keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key));
  for (let rank = 0; rank < keyed.length; rank++) ranks[keyed[rank].index] = rank;
  return ranks;
}

function orderKey(index: number, centre: number, from: ChartAnimationFrom): number {
  switch (from) {
    case "end":
      return -index;
    case "centre":
      return Math.abs(index - centre);
    case "edges":
      return -Math.abs(index - centre);
    case "shuffle":
      return unitHash01(index, SHUFFLE_SALT);
    default:
      return index;
  }
}

// ── The sampler ──────────────────────────────────────────────────────────────

export interface ChartRevealDims {
  seriesCount: number;
  categoryCount: number;
  type: ChartType;
}

/** Total build length including tails (post-build pulses, shine sweeps, the breakout beat): what the timeline shows and what "the build has finished" means. */
export function chartAnimationEndMs(
  animation: ChartAnimationConfig,
  dims: ChartRevealDims,
): number {
  const plan = planBuild(animation, dims);
  const ch = plan.channels;
  let end = plan.buildEndMs;
  if (ch.pulse === "land") end = Math.max(end, plan.buildEndMs + CHART_PULSE_MS);
  if (ch.pulse === "final") end = Math.max(end, plan.buildEndMs + PULSE_HOLD_MS + CHART_PULSE_MS);
  if (ch.pulse === "order") {
    const steps = Math.max(0, plan.categoryCount - 1) * PULSE_STEP_MS;
    end = Math.max(end, plan.buildEndMs + PULSE_HOLD_MS + steps + CHART_PULSE_MS);
  }
  if (ch.shine === "afterLand") {
    end = Math.max(end, plan.buildEndMs + SHINE_DELAY_MS + CHART_SHINE_MS);
  }
  return end;
}

interface BuildPlan {
  channels: ChartPresetChannels;
  seriesCount: number;
  categoryCount: number;
  durationMs: number;
  /** Per-element delay, indexed `series * categoryCount + category`. */
  delays: Float64Array;
  seriesStart: Float64Array;
  seriesEnd: Float64Array;
  /** When the last element lands: the whole build, marks only, before any tail. */
  buildEndMs: number;
}

/** The per-element schedule: delivery ranks, stagger, ripple and the breakout beat, resolved once so sampling is an array lookup. */
function planBuild(animation: ChartAnimationConfig, dims: ChartRevealDims): BuildPlan {
  const channels = chartPresetFor(dims.type, animation.preset).channels;
  const seriesCount = Math.max(0, Math.floor(dims.seriesCount));
  const categoryCount = Math.max(0, Math.floor(dims.categoryCount));
  const durationMs = Math.max(0, animation.durationMs);
  const staggerMs = Math.max(0, animation.staggerMs) * channels.staggerScale;
  const seriesOrder = orderRanks(seriesCount, animation.from);
  const categoryOrder = orderRanks(categoryCount, animation.from);
  const shuffleOrder =
    animation.delivery === "cascade" && animation.from === "shuffle"
      ? orderRanks(seriesCount * categoryCount, "shuffle")
      : null;

  const ripple = (c: number): number => {
    if (channels.ripple <= 0 || categoryCount <= 1) return 0;
    const phase = c / (categoryCount - 1);
    return (staggerMs * channels.ripple * (1 - Math.cos(2 * Math.PI * WAVE_CYCLES * phase))) / 2;
  };

  const delays = new Float64Array(seriesCount * categoryCount);
  let plainMax = 0;
  for (let s = 0; s < seriesCount; s++) {
    for (let c = 0; c < categoryCount; c++) {
      let rank = 0;
      if (animation.delivery === "series") rank = seriesOrder[s];
      else if (animation.delivery === "cascade") {
        rank = shuffleOrder
          ? shuffleOrder[c * seriesCount + s]
          : categoryOrder[c] * seriesCount + s;
      }
      const delay = rank * staggerMs + ripple(c);
      delays[s * categoryCount + c] = delay;
      if (delay > plainMax) plainMax = delay;
    }
  }
  if (channels.lastLate && categoryCount > 0) {
    const late = plainMax + BREAKOUT_GAP_MS;
    for (let s = 0; s < seriesCount; s++) delays[s * categoryCount + (categoryCount - 1)] = late;
  }

  const seriesStart = new Float64Array(seriesCount);
  const seriesEnd = new Float64Array(seriesCount);
  let buildEndMs = durationMs;
  for (let s = 0; s < seriesCount; s++) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (let c = 0; c < categoryCount; c++) {
      const delay = delays[s * categoryCount + c];
      if (delay < lo) lo = delay;
      if (delay > hi) hi = delay;
    }
    if (!Number.isFinite(lo)) lo = 0;
    seriesStart[s] = lo;
    seriesEnd[s] = hi + durationMs;
    if (seriesEnd[s] > buildEndMs) buildEndMs = seriesEnd[s];
  }
  return {
    channels,
    seriesCount,
    categoryCount,
    durationMs,
    delays,
    seriesStart,
    seriesEnd,
    buildEndMs,
  };
}

/** The build state of a whole chart at one scene-local time. Pure: same inputs, same numbers, forever. `at` and `series` are fresh closures every call, which is what the instanced writers key their dep arrays on. */
export function buildChartRevealSampler(
  animation: ChartAnimationConfig,
  dims: ChartRevealDims,
  localMs: number,
): ChartRevealSampler {
  const plan = planBuild(animation, dims);
  const ch = plan.channels;
  const { seriesCount, categoryCount, durationMs } = plan;
  const lastCategory = categoryCount - 1;
  const landP = ch.squash > 0 ? 1 - SQUASH_P : 1;
  const liftDur = Math.max(1e-6, (1 - ch.drawP) * (1 - SURGE_SPREAD));
  const fadeP = Math.max(1e-6, ch.fadeP);

  const inRange = (s: number, c: number): boolean =>
    s >= 0 && s < seriesCount && c >= 0 && c < categoryCount;
  const delayAt = (s: number, c: number): number =>
    inRange(s, c) ? plan.delays[s * categoryCount + c] : 0;
  /** An element's position along the category axis, 0..1; the head walks this, not the delivery rank. */
  const axisPos = (c: number): number =>
    categoryCount > 1 ? clampUnit(c / (categoryCount - 1)) : 0;

  const seriesT = (s: number): number => {
    if (s < 0 || s >= seriesCount) return windowT(localMs, 0, durationMs);
    const start = plan.seriesStart[s];
    return windowT(localMs, start, plan.seriesEnd[s] - start);
  };
  const drawOf = (s: number): number =>
    ch.drawP <= 0 ? 1 : ease(ch.ease, clampUnit(seriesT(s) / ch.drawP));
  // The head runs PASS_SOFT ahead of the alpha edge, scaled so the last element completes exactly as the draw does.
  const passOf = (s: number, c: number): number =>
    clampUnit((drawOf(s) * (1 + PASS_SOFT) - axisPos(c)) / PASS_SOFT);

  const at: ChartRevealFn = (s, c): ChartReveal => {
    const isLate = ch.lastLate && categoryCount > 0 && c === lastCategory;
    const delay = delayAt(s, c);
    const t = windowT(localMs, delay, durationMs);
    const arrival =
      ch.grow === "surge"
        ? clampUnit(
            (seriesT(s) - (ch.drawP + (1 - ch.drawP) * axisPos(c) * SURGE_SPREAD)) / liftDur,
          )
        : clampUnit(t / landP);
    const overshoot = ch.lastLate && !isLate ? 0 : ch.overshoot;
    // One arrival curve drives both: `grow` takes it whole, `count` takes it clamped, so a label never prints past its value while the mark overshoots.
    const curve = settle(arrival, ch.grow === "full" ? 0 : overshoot, ch.ease);

    let grow = ch.grow === "full" ? 1 : curve;
    if (ch.squash > 0 && t > landP) grow -= ch.squash * bump((t - landP) / SQUASH_P);

    let alpha: number;
    if (ch.alpha === "pass") alpha = passOf(s, c);
    else if (ch.alpha === "afterDraw") {
      alpha = ease("outQuad", clampUnit((seriesT(s) - ch.drawP) / Math.max(1e-6, 1 - ch.drawP)));
    } else alpha = ease("outQuad", clampUnit(t / fadeP));

    let count: number;
    if (ch.count === "pass") count = passOf(s, c);
    else if (ch.count === "lastDraw") {
      count = categoryCount > 0 && c === lastCategory ? drawOf(s) : passOf(s, c);
    } else count = clampUnit(curve);

    let pulse = 0;
    if (ch.pulse === "land") pulse = bumpAt(localMs, delay + durationMs, CHART_PULSE_MS);
    else if (ch.pulse === "final" && categoryCount > 0 && c === lastCategory) {
      pulse = bumpAt(localMs, plan.buildEndMs + PULSE_HOLD_MS, CHART_PULSE_MS);
    } else if (ch.pulse === "order") {
      const start = plan.buildEndMs + PULSE_HOLD_MS + Math.max(0, c) * PULSE_STEP_MS;
      pulse = bumpAt(localMs, start, CHART_PULSE_MS);
    }

    let shine = -1;
    if (ch.shine === "afterLand" && (!ch.lastLate || isLate)) {
      const start = delay + durationMs + SHINE_DELAY_MS;
      shine = localMs < start ? -1 : clampUnit((localMs - start) / CHART_SHINE_MS);
    }

    // `fall` is the one entrance no scaling channel can express: the element arrives already at size, displaced along the value axis, and slides home on the counting progress.
    const drop = ch.enter === "fall" ? (1 - count) * CHART_ENTER_FALL : 0;

    return { grow, alpha, count, pulse, shine, drop };
  };

  const series: ChartSeriesRevealFn = (s): ChartSeriesReveal => {
    const draw = drawOf(s);
    const headX =
      ch.drawP <= 0 || categoryCount === 0 || draw <= 0 || draw >= 1
        ? -1
        : (0.5 + draw * (categoryCount - 1)) / categoryCount;
    let alpha: number;
    if (ch.drawP > 0) alpha = ease("outQuad", clampUnit(seriesT(s) / fadeP));
    else if (categoryCount === 0) alpha = 1;
    else {
      let total = 0;
      for (let c = 0; c < categoryCount; c++) total += at(s, c).alpha;
      alpha = total / categoryCount;
    }
    return { draw, headX, alpha };
  };

  return { at, series };
}
