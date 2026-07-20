import type {
  LayeredScreenshotItem,
  LayeredScreenshotLayer,
  SceneDocLayeredScreenshot,
} from "./sceneDocSchema";

/** Pure composition edits for the layered-screenshot block (the builder's mutations, the keyedTrack convention: every edit returns a NEW block, or null for unknown ids/illegal moves). Attach-graph invariants are preserved by construction: one root per layer, children re-chain on removal, never an orphan. */

/** Next free "l<n>" layer id. */
export function nextLayerId(block: SceneDocLayeredScreenshot): string {
  const taken = new Set(block.layers.map((l) => l.id));
  let n = 1;
  for (const layer of block.layers) {
    const m = /^l(\d+)$/.exec(layer.id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (taken.has(`l${n}`)) n++;
  return `l${n}`;
}

/** Next free "i<n>" item id, unique across ALL layers (text keys `ls-<id>` are per-scene). */
export function nextItemId(block: SceneDocLayeredScreenshot): string {
  const taken = new Set<string>();
  let n = 1;
  for (const layer of block.layers) {
    for (const item of layer.items) {
      taken.add(item.id);
      const m = /^i(\d+)$/.exec(item.id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  }
  while (taken.has(`i${n}`)) n++;
  return `i${n}`;
}

/** Layers in stacking order (back to front), the renderer's sort. */
export function layersInOrder(block: SceneDocLayeredScreenshot): LayeredScreenshotLayer[] {
  return [...block.layers].sort((a, b) => a.z - b.z);
}

/** Append an empty layer at the front of the stack. */
export function addLayer(block: SceneDocLayeredScreenshot): SceneDocLayeredScreenshot {
  const z = block.layers.reduce((max, l) => Math.max(max, l.z), -1) + 1;
  return {
    ...block,
    layers: [...block.layers, { id: nextLayerId(block), visible: true, items: [], z }],
  };
}

export function removeLayer(
  block: SceneDocLayeredScreenshot,
  layerId: string,
): SceneDocLayeredScreenshot | null {
  if (!block.layers.some((l) => l.id === layerId)) return null;
  return { ...block, layers: block.layers.filter((l) => l.id !== layerId) };
}

/** Move a layer one step through the stacking order; z values renumber to the new order so ties can never wedge a layer in place. */
export function moveLayer(
  block: SceneDocLayeredScreenshot,
  layerId: string,
  delta: -1 | 1,
): SceneDocLayeredScreenshot | null {
  const ordered = layersInOrder(block);
  const from = ordered.findIndex((l) => l.id === layerId);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= ordered.length) return null;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const zOf = new Map(ordered.map((l, i) => [l.id, i]));
  return {
    ...block,
    layers: block.layers.map((l) => ({ ...l, z: zOf.get(l.id) ?? l.z })),
  };
}

export function updateLayer(
  block: SceneDocLayeredScreenshot,
  layerId: string,
  patch: Partial<Pick<LayeredScreenshotLayer, "name" | "visible" | "gap" | "flat">>,
): SceneDocLayeredScreenshot | null {
  if (!block.layers.some((l) => l.id === layerId)) return null;
  return {
    ...block,
    layers: block.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
  };
}

/** Add a fully-formed item to a layer. Refuses (null) a second root, an unresolvable attach target, or a duplicate id anywhere in the block. */
export function addItem(
  block: SceneDocLayeredScreenshot,
  layerId: string,
  item: LayeredScreenshotItem,
): SceneDocLayeredScreenshot | null {
  const layer = block.layers.find((l) => l.id === layerId);
  if (!layer) return null;
  if (block.layers.some((l) => l.items.some((i) => i.id === item.id))) return null;
  if (item.attach === null) {
    if (layer.items.length > 0) return null;
  } else {
    const to = item.attach.to;
    if (!layer.items.some((i) => i.id === to)) return null;
  }
  return {
    ...block,
    layers: block.layers.map((l) => (l.id === layerId ? { ...l, items: [...l.items, item] } : l)),
  };
}

/** Remove an item and re-chain its children so the graph stays rooted: children re-attach to the removed item's parent keeping their own sides; removing the root promotes its first child to root and re-attaches the root's other children to it. */
export function removeItem(
  block: SceneDocLayeredScreenshot,
  layerId: string,
  itemId: string,
): SceneDocLayeredScreenshot | null {
  const layer = block.layers.find((l) => l.id === layerId);
  const removed = layer?.items.find((i) => i.id === itemId);
  if (!layer || !removed) return null;
  const rest = layer.items.filter((i) => i.id !== itemId);
  let items: LayeredScreenshotItem[];
  if (removed.attach !== null) {
    const parentId = removed.attach.to;
    items = rest.map((i) =>
      i.attach?.to === itemId ? { ...i, attach: { ...i.attach, to: parentId } } : i,
    );
  } else {
    const promotedId = rest.find((i) => i.attach?.to === itemId)?.id;
    items = rest.map((i) => {
      if (i.id === promotedId) return { ...i, attach: null };
      if (i.attach?.to === itemId && promotedId) {
        return { ...i, attach: { ...i.attach, to: promotedId } };
      }
      return i;
    });
  }
  return {
    ...block,
    layers: block.layers.map((l) => (l.id === layerId ? { ...l, items } : l)),
  };
}

export function updateItem(
  block: SceneDocLayeredScreenshot,
  layerId: string,
  itemId: string,
  patch: Partial<LayeredScreenshotItem>,
): SceneDocLayeredScreenshot | null {
  const layer = block.layers.find((l) => l.id === layerId);
  if (!layer?.items.some((i) => i.id === itemId)) return null;
  return {
    ...block,
    layers: block.layers.map((l) =>
      l.id === layerId
        ? {
            ...l,
            items: l.items.map((i) =>
              i.id === itemId ? ({ ...i, ...patch } as LayeredScreenshotItem) : i,
            ),
          }
        : l,
    ),
  };
}
