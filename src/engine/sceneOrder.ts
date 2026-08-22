/** Pure order maths for the Project tab's scene manager: multi-select drag reordering expressed as a desired order of original indices, and multi-select duplication as a block of insertions, both translated into the sequential single-scene calls the manifest editor exposes (`move_scene`, `duplicate_scene`). */

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

/** The `{from, at}` pairs that duplicate `selected` as ONE block after the LAST selected scene, keeping the sources' relative order: duplicating Title and Device gives `Title, Device, Title copy, Device copy`, and a gappy selection (scenes 2 and 5) puts both copies after scene 5. Issue them in the order returned, `from` as `duplicate_scene`'s index and `at` as its `position`: the cursor walks with the array, which grows by one per insertion, and no source index moves because every copy lands past the last of them. */
export function planDuplicates(selected: readonly number[]): { from: number; at: number }[] {
  const block = [...new Set(selected)].sort((a, b) => a - b);
  const last = block[block.length - 1];
  return block.map((from, n) => ({ from, at: last + 1 + n }));
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
