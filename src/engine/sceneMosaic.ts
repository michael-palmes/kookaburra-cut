/** The mosaic (split field) core: defaults, the per-aspect grid, tile rects and reveal ranks. Pure functions of the block, the area and the clock, so preview and export agree; the consumer registry lets the host fallback stand down when the scene places a `SplitField` itself. */

import { create } from "zustand";
import type { Theme } from "../theme/tokens";
import { ramp } from "../toolkit/motion/math";
import {
  type MosaicRevealOrder,
  mosaicSourceKind,
  type SceneDoc,
  type SceneDocMosaic,
  type SceneDocMosaicReveal,
  type SceneDocMosaicTile,
} from "./sceneDocSchema";

export interface ResolvedMosaicReveal {
  at: number;
  staggerMs: number;
  durationMs: number;
  order: MosaicRevealOrder;
  ease: string;
}

export interface ResolvedMosaic {
  tiles: SceneDocMosaicTile[];
  columns?: number;
  gap: number;
  reveal: ResolvedMosaicReveal;
}

export const MOSAIC_DEFAULT_GAP = 0.02;
export const MOSAIC_DEFAULT_REVEAL: ResolvedMosaicReveal = {
  at: 0,
  staggerMs: 90,
  durationMs: 500,
  order: "rows",
  ease: "outCubic",
};
/** Tiles grow from this scale as they reveal. */
export const MOSAIC_REVEAL_FROM_SCALE = 0.92;

/** Fills the reveal's defaults; each layer's present fields win over the one before. */
export function resolveMosaicReveal(
  ...layers: (SceneDocMosaicReveal | undefined)[]
): ResolvedMosaicReveal {
  const out = { ...MOSAIC_DEFAULT_REVEAL };
  for (const layer of layers) {
    out.at = layer?.at ?? out.at;
    out.staggerMs = layer?.staggerMs ?? out.staggerMs;
    out.durationMs = layer?.durationMs ?? out.durationMs;
    out.order = layer?.order ?? out.order;
    out.ease = layer?.ease ?? out.ease;
  }
  return out;
}

export function resolveMosaic(block: SceneDocMosaic | undefined): ResolvedMosaic | null {
  if (!block || block.tiles.length === 0) return null;
  return {
    tiles: block.tiles,
    ...(block.columns !== undefined ? { columns: block.columns } : {}),
    gap: block.gap ?? MOSAIC_DEFAULT_GAP,
    reveal: resolveMosaicReveal(block.reveal),
  };
}

export function mosaicTileKind(tile: SceneDocMosaicTile): "image" | "video" | "colour" {
  return tile.src === undefined ? "colour" : (mosaicSourceKind(tile.src) ?? "colour");
}

/** The sidecar mosaic's video sources, for the export preamble's extract barrier. */
export function mosaicVideoSources(doc: SceneDoc | null | undefined): string[] {
  return (doc?.mosaic?.tiles ?? [])
    .filter((tile) => mosaicTileKind(tile) === "video")
    .map((tile) => tile.src as string);
}

/** Columns and rows for `count` tiles in an area of `aspect` (width / height): the most square tiles, with a cost per empty cell in the last row, so the field reflows per aspect; a fixed `columns` is clamped to the tile count. */
export function mosaicGrid(
  count: number,
  aspect: number,
  columns?: number,
): { columns: number; rows: number } {
  const n = Math.max(1, Math.floor(count));
  if (columns !== undefined) {
    const c = Math.min(n, Math.max(1, Math.round(columns)));
    return { columns: c, rows: Math.ceil(n / c) };
  }
  let best = { columns: 1, rows: n };
  let bestCost = Number.POSITIVE_INFINITY;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const tileAspect = (aspect * rows) / c;
    const cost = Math.abs(Math.log(tileAspect)) + (rows * c - n) / c;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = { columns: c, rows };
    }
  }
  return best;
}

export interface MosaicTileRect {
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
  column: number;
}

/** Tile rects centred on the area's origin, in reading order; gaps only between tiles (the field bleeds to the area's edges) and a short last row stretches to fill the width. */
export function mosaicTileRects(
  count: number,
  area: { width: number; height: number },
  grid: { columns: number; rows: number },
  gap: number,
): MosaicTileRect[] {
  const rects: MosaicTileRect[] = [];
  const height = Math.max(0, (area.height - (grid.rows - 1) * gap) / grid.rows);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / grid.columns);
    const column = i % grid.columns;
    const inRow = Math.min(grid.columns, count - row * grid.columns);
    const width = Math.max(0, (area.width - (inRow - 1) * gap) / inRow);
    rects.push({
      x: -area.width / 2 + column * (width + gap) + width / 2,
      y: area.height / 2 - row * (height + gap) - height / 2,
      width,
      height,
      row,
      column,
    });
  }
  return rects;
}

/** Reveal rank per tile: reading order, columns left to right, or rings out from the centre (equidistant tiles share a rank). */
export function mosaicRevealRanks(rects: MosaicTileRect[], order: MosaicRevealOrder): number[] {
  if (order === "rows") return rects.map((_, i) => i);
  if (order === "columns") {
    const sorted = rects
      .map((rect, i) => ({ i, x: Math.round(rect.x * 1e6), y: Math.round(rect.y * 1e6) }))
      .sort((a, b) => a.x - b.x || b.y - a.y || a.i - b.i);
    const ranks = new Array<number>(rects.length);
    sorted.forEach((entry, rank) => {
      ranks[entry.i] = rank;
    });
    return ranks;
  }
  const distances = rects.map((rect) => Math.round(Math.hypot(rect.x, rect.y) * 1e6));
  const levels = [...new Set(distances)].sort((a, b) => a - b);
  return distances.map((d) => levels.indexOf(d));
}

/** A tile's reveal, 0..1 (an overshooting ease may pass 1), at scene-local `localMs`. */
/** Scene-local ms when the last tile's reveal settles, for Present holds and automatic stills. */
export function mosaicRevealEndMs(ranks: readonly number[], reveal: ResolvedMosaicReveal): number {
  return reveal.at + Math.max(0, ...ranks) * reveal.staggerMs + reveal.durationMs;
}

export function mosaicTileReveal(
  localMs: number,
  rank: number,
  reveal: ResolvedMosaicReveal,
): number {
  const start = reveal.at + rank * reveal.staggerMs;
  return ramp(localMs, start, start + reveal.durationMs, reveal.ease);
}

const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;

/** A hex, or a theme colour token resolved against the scene's theme; absent or unknown takes `fallback`'s token. */
export function resolveSceneColour(
  value: string | undefined,
  colors: Theme["colors"],
  fallback: (typeof COLOUR_TOKENS)[number],
): string {
  if (value !== undefined && (COLOUR_TOKENS as readonly string[]).includes(value)) {
    return colors[value as (typeof COLOUR_TOKENS)[number]];
  }
  return value?.startsWith("#") ? value : colors[fallback];
}

interface MosaicRegistryState {
  consumers: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

/** Which mounted scenes place a `SplitField` (the chartRegistry pattern): the host `MosaicFallback` draws the sidecar block only when none does. */
export const useMosaicRegistry = create<MosaicRegistryState>((set) => ({
  consumers: {},
  register: (index) =>
    set((s) => ({ consumers: { ...s.consumers, [index]: (s.consumers[index] ?? 0) + 1 } })),
  unregister: (index) =>
    set((s) => {
      const n = (s.consumers[index] ?? 0) - 1;
      const consumers = { ...s.consumers };
      if (n <= 0) delete consumers[index];
      else consumers[index] = n;
      return { consumers };
    }),
}));

export function useSceneConsumesMosaic(index: number | undefined): boolean {
  return useMosaicRegistry((s) => index !== undefined && (s.consumers[index] ?? 0) > 0);
}
