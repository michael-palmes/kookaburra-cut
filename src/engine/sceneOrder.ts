/** Pure order maths for the Project tab's scene manager: multi-select drag reordering expressed as a desired order of original indices, then translated into the sequential single-scene `move_scene` calls the manifest editor exposes. */

/** The order after dragging `selected` (kept in relative order) to sit before original index `insertBefore` (`count` = insert at the end). */
export function moveSelection(count: number, selected: number[], insertBefore: number): number[] {
  const sel = new Set(selected);
  const rest = [];
  for (let i = 0; i < count; i++) if (!sel.has(i)) rest.push(i);
  const block = [...selected].sort((a, b) => a - b);
  // The insertion point in `rest` space: unselected indices before the target keep their place.
  let at = 0;
  for (const i of rest) {
    if (i < insertBefore) at++;
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/** Minimal `{from, to}` move sequence (current-index space) realising `desired`, a permutation of 0..n-1. */
export function planMoves(desired: number[]): { from: number; to: number }[] {
  const current = desired.map((_, i) => i);
  const moves: { from: number; to: number }[] = [];
  for (let pos = 0; pos < desired.length; pos++) {
    if (current[pos] === desired[pos]) continue;
    const from = current.indexOf(desired[pos]);
    moves.push({ from, to: pos });
    const [scene] = current.splice(from, 1);
    current.splice(pos, 0, scene);
  }
  return moves;
}
