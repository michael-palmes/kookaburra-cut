/** Pointer maths for dragging a card inside a library grid. The grid is a wrapping CSS grid, so an insertion point is "before which card", read off the laid-out boxes rather than any assumed column count: the same drag reads correctly at one column or four. `catalogueOrder.ts` owns what happens to the list once these two numbers are known. */

/** A laid-out card, in the same coordinate space as the pointer (viewport pixels from `getBoundingClientRect`). */
export interface CardBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the dragged card would land, as an index in the CURRENT list (0 = before the first card, `boxes.length` = after the last). A pointer past every row lands at the end. */
export function gridInsertionIndex(boxes: readonly CardBox[], x: number, y: number): number {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    // Rows read top to bottom: anything wholly above the pointer is behind it.
    if (y > box.bottom) continue;
    if (y < box.top || x < (box.left + box.right) / 2) return i;
  }
  return boxes.length;
}

/** `moveInList`'s destination index for a drop: the insertion point is measured before the card is lifted out, so a move to the right shifts one place back. */
export function dropTargetIndex(from: number, insertBefore: number): number {
  return insertBefore > from ? insertBefore - 1 : insertBefore;
}

/** Where Move up and Move down drop a card, as `insertBefore` for the drag's commit, or null with the reason. Stable items keep ahead of beta ones, as a drag does. */
export function cardMoveTargets(
  statuses: readonly (string | undefined)[],
  index: number,
  searching: boolean,
): { up: number | null; down: number | null; upTitle?: string; downTitle?: string } {
  if (searching) {
    const title = "Clear the search to reorder";
    return { up: null, down: null, upTitle: title, downTitle: title };
  }
  const status = "Stable items stay before beta items";
  const crosses = (to: number) => statuses[to] !== statuses[index];
  const up = index <= 0 ? null : crosses(index - 1) ? null : index - 1;
  const down = index >= statuses.length - 1 ? null : crosses(index + 1) ? null : index + 2;
  return {
    up,
    down,
    upTitle: index > 0 && up === null ? status : undefined,
    downTitle: index < statuses.length - 1 && down === null ? status : undefined,
  };
}
