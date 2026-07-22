/** Layered-screenshot layout solver: pure geometry from a validated layer's attach chains to centre-based rects on the layer plane, plus the stack-level fit and the non-clipping spread mapping. No React, no three.js, no clock; the renderer and builder both consume these, so preview and export agree by construction. */

import type { LayeredScreenshotItem, LayeredScreenshotLayer } from "./sceneDocSchema";

/** Measured width/height ratio per item id (image intrinsics, video probe, measured text); absent ids take the kind fallback. */
export interface MeasuredAspect {
  id: string;
  aspect: number;
}

/** Centre-based rect on the layer's local plane (world units, y up). */
export interface SolvedItemRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SolvedLayerLayout {
  id: string;
  items: SolvedItemRect[];
  /** Bounding box of the whole chain, centred on the layer origin. */
  width: number;
  height: number;
}

/** Shared screen height on a layer, world units; widths follow each item's aspect. */
export const SCREEN_HEIGHT = 2.4;
/** Default edge-to-edge gap between chained items. */
export const DEFAULT_ITEM_GAP = 0.18;
/** Screen aspect fallback before an image's intrinsics land. */
export const DEFAULT_SCREEN_ASPECT = 0.75;
/** Text box fallbacks: width as a share of the screen height, and width/height ratio. */
export const DEFAULT_TEXT_WIDTH_RATIO = 0.9;
export const DEFAULT_TEXT_ASPECT = 2.5;
/** Layer Z step at spread 0 (a hairline that still clears the card and its shadow) and at spread 1. */
export const MIN_LAYER_STEP = 0.06;
export const MAX_LAYER_STEP = 1.2;

function itemSize(
  item: LayeredScreenshotItem,
  aspectOf: Map<string, number>,
): { width: number; height: number } {
  if (item.kind === "screen") {
    const aspect = aspectOf.get(item.id) ?? DEFAULT_SCREEN_ASPECT;
    return { width: SCREEN_HEIGHT * aspect, height: SCREEN_HEIGHT };
  }
  const width = item.width ?? SCREEN_HEIGHT * DEFAULT_TEXT_WIDTH_RATIO;
  const aspect = aspectOf.get(item.id) ?? DEFAULT_TEXT_ASPECT;
  return { width, height: width / aspect };
}

/** Solve one layer: the root sits at the origin, chained items stack outward side by side with their gaps, then the whole chain re-centres on its bounding box so layers stack concentrically. Items must be pre-validated (normalizeLayeredScreenshot): rooted, acyclic, resolvable. */
export function solveLayerLayout(
  layer: LayeredScreenshotLayer,
  aspects: readonly MeasuredAspect[],
  defaultGap = DEFAULT_ITEM_GAP,
): SolvedLayerLayout {
  const aspectOf = new Map(aspects.map((a) => [a.id, a.aspect]));
  const placed = new Map<string, SolvedItemRect>();
  const pending = [...layer.items];

  // The validated graph is rooted, so each pass places at least one item.
  while (pending.length > 0) {
    const before = pending.length;
    for (let idx = pending.length - 1; idx >= 0; idx--) {
      const item = pending[idx];
      const { width, height } = itemSize(item, aspectOf);
      if (item.attach === null) {
        placed.set(item.id, { id: item.id, x: 0, y: 0, width, height });
        pending.splice(idx, 1);
        continue;
      }
      const parent = placed.get(item.attach.to);
      if (!parent) continue;
      const gap = item.gap ?? layer.gap ?? defaultGap;
      let x = parent.x;
      let y = parent.y;
      switch (item.attach.side) {
        case "left":
          x = parent.x - parent.width / 2 - gap - width / 2;
          break;
        case "right":
          x = parent.x + parent.width / 2 + gap + width / 2;
          break;
        case "top":
          y = parent.y + parent.height / 2 + gap + height / 2;
          break;
        case "bottom":
          y = parent.y - parent.height / 2 - gap - height / 2;
          break;
      }
      placed.set(item.id, { id: item.id, x, y, width, height });
      pending.splice(idx, 1);
    }
    if (pending.length === before) break; // unreachable on validated input, never spin
  }

  const rects = layer.items
    .map((i) => placed.get(i.id))
    .filter((r): r is SolvedItemRect => r !== undefined);
  if (rects.length === 0) return { id: layer.id, items: [], width: 0, height: 0 };

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x - r.width / 2);
    maxX = Math.max(maxX, r.x + r.width / 2);
    minY = Math.min(minY, r.y - r.height / 2);
    maxY = Math.max(maxY, r.y + r.height / 2);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    id: layer.id,
    items: rects.map((r) => ({ ...r, x: r.x - cx, y: r.y - cy })),
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Uniform scale fitting the visible layers' union bounding box into the safe frame at spread 0 (spread is a pose parameter applied after the fit; zoom compensates when an expanded stack crowds the edges). */
export function fitStackScale(
  layouts: readonly SolvedLayerLayout[],
  safeWidth: number,
  safeHeight: number,
): number {
  let width = 0;
  let height = 0;
  for (const layout of layouts) {
    width = Math.max(width, layout.width);
    height = Math.max(height, layout.height);
  }
  if (width <= 0 || height <= 0) return 1;
  return Math.min(safeWidth / width, safeHeight / height);
}

/** Per-layer local Z offsets for a spread in [0,1]: a fixed minimum step keeps layers from ever clipping (hairline stack at 0), growing linearly to the expanded step at 1; offsets centre the stack on z 0, later layers toward the camera. */
export function spreadZToLocal(spread: number, layerCount: number): number[] {
  const s = Math.min(1, Math.max(0, spread));
  const step = MIN_LAYER_STEP + s * (MAX_LAYER_STEP - MIN_LAYER_STEP);
  const mid = (layerCount - 1) / 2;
  return Array.from({ length: layerCount }, (_, i) => (i - mid) * step);
}
