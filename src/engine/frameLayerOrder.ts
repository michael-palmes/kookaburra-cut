import type { FrameDecorationLayer } from "../toolkit/frame/types";

export const FRAME_LAYER_BAND = { below: -1000, above: 1000 } as const;

export function frameLayerRenderOrder(
  layer: FrameDecorationLayer | undefined,
  stackOrder: number,
): number {
  return FRAME_LAYER_BAND[layer === "below" ? "below" : "above"] + stackOrder;
}

export function nextFrameStackOrder(items: readonly { stackOrder?: number }[]): number {
  return items.reduce((next, item, index) => Math.max(next, (item.stackOrder ?? index) + 1), 0);
}
