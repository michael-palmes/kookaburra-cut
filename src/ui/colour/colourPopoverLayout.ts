/** Colour-popover geometry, extracted so the anchor/flip/clamp rules are unit-testable. */

export const POPOVER_MARGIN = 8;
export const POPOVER_GAP = 6;
export const POPOVER_MIN_HEIGHT = 220;
/** Sized so a folded popover fits without scrolling, Reset row included, and a tall window still cannot turn the picker into a column. */
export const POPOVER_MAX_HEIGHT = 470;

export interface PopoverAnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/** Prefers below the anchor, flips above only when that side genuinely has more room, and caps the height so the popover scrolls internally instead of running off screen or dominating a tall window. */
export function placeColourPopover(
  anchor: PopoverAnchorRect,
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): PopoverPlacement {
  const left = Math.max(
    POPOVER_MARGIN,
    Math.min(anchor.left, viewport.width - box.width - POPOVER_MARGIN),
  );
  const below = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  const wanted = Math.min(box.height, POPOVER_MAX_HEIGHT);
  const flip = wanted > below && above > below;
  const maxHeight = Math.min(
    POPOVER_MAX_HEIGHT,
    Math.max(POPOVER_MIN_HEIGHT, flip ? above : below),
  );
  const height = Math.min(box.height, maxHeight);
  const top = flip
    ? Math.max(POPOVER_MARGIN, anchor.top - POPOVER_GAP - height)
    : Math.min(
        anchor.bottom + POPOVER_GAP,
        Math.max(POPOVER_MARGIN, viewport.height - POPOVER_MARGIN - height),
      );
  return { left, top, maxHeight };
}
