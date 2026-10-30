/** The asset URLs a stage worker may load, per project: resolved by the window (`buildStageAssetTable` in stageClient.ts) from its inventories and handed over with the project, so the worker never composes a path. Images and environment maps are keyed by their clean project-relative path; a lookup miss is a missing asset. Bundled projects need no table: their URLs come from the app's own globs in either realm. */

export interface StageAssetTable {
  images: Record<string, string>;
  environments: Record<string, string>;
}

const tables = new Map<string, StageAssetTable>();
const listeners = new Set<() => void>();
let version = 0;

export function setStageAssetTable(projectId: string, table: StageAssetTable | null): void {
  if (table) tables.set(projectId, table);
  else tables.delete(projectId);
  version += 1;
  for (const listener of listeners) listener();
}

export function stageAssetTable(projectId: string): StageAssetTable | undefined {
  return tables.get(projectId);
}

/** Bumps whenever any table changes; the worker's asset-revision hooks re-render on it. */
export function stageAssetVersion(): number {
  return version;
}

export function subscribeStageAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cleanAssetRel(rel: string): string {
  return rel.replace(/^\.?\//, "");
}
