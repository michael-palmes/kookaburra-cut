import { formatBytes } from "../engine/appCache";
import type { MediaDeleteFailure, UnusedAsset } from "../engine/media";

/** The selection maths and copy behind the "Delete unused media" sheet, kept out of the component so it can be unit tested (vitest runs without a DOM). */

export interface UnusedTotals {
  count: number;
  bytes: number;
}

/** Every rel ticked: the sheet opens fully armed and the user unticks what to keep. */
export function allUnusedRels(assets: readonly UnusedAsset[]): Set<string> {
  return new Set(assets.map((asset) => asset.rel));
}

/** Ticked count and byte total, over the rels still in the list (a stale tick for a row that has gone never counts). */
export function unusedTotals(
  assets: readonly UnusedAsset[],
  selected: ReadonlySet<string>,
): UnusedTotals {
  return assets.reduce<UnusedTotals>(
    (totals, asset) =>
      selected.has(asset.rel)
        ? { count: totals.count + 1, bytes: totals.bytes + asset.bytes }
        : totals,
    { count: 0, bytes: 0 },
  );
}

/** Add or drop one rel; a new Set every time, so React sees the change. */
export function toggleUnusedRel(selected: ReadonlySet<string>, rel: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(rel)) next.add(rel);
  return next;
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The footer sentence, e.g. "4 files · 12.4 MB will move to the Trash". Sizes are what the scan measured, so it promises a Trash move, never a guaranteed reclaim. */
export function unusedSummary(totals: UnusedTotals): string {
  if (totals.count === 0) return "Nothing ticked";
  return `${fileCount(totals.count)} · ${formatBytes(totals.bytes)} will move to the Trash`;
}

/** What to say once a sweep finishes; null when everything went and the sheet can just close. */
export function unusedOutcome(
  deleted: number,
  failures: readonly MediaDeleteFailure[],
): string | null {
  if (failures.length === 0) return null;
  const moved =
    deleted === 0 ? "Nothing was deleted." : `Moved ${fileCount(deleted)} to the Trash.`;
  return `${moved} ${fileCount(failures.length)} stayed put:`;
}
