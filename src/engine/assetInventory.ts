import { invoke } from "@tauri-apps/api/core";

/** Workspace asset inventory by project id (`ws:<slug>`), fetched at project load and refreshed on media imports, so `resolveAssetUrl` can reject a missing file synchronously (the workspace mirror of the bundled glob check). A project with no entry fails open to the suspense load + AssetBoundary. Its own module (not project.ts) so media.ts can refresh it without an import cycle. */
const workspaceAssets = new Map<string, Set<string>>();

export async function refreshWorkspaceAssets(projectId: string): Promise<void> {
  if (!projectId.startsWith("ws:")) return;
  try {
    const rels = await invoke<string[]>("list_project_assets", { slug: projectId.slice(3) });
    workspaceAssets.set(projectId, new Set(rels.map((rel) => rel.replace(/^\.?\//, ""))));
  } catch {
    workspaceAssets.delete(projectId);
  }
}

/** True only when the inventory is loaded AND the path is absent from it. */
export function workspaceAssetMissing(projectId: string, relPath: string): boolean {
  const inventory = workspaceAssets.get(projectId);
  return inventory !== undefined && !inventory.has(relPath.replace(/^\.?\//, ""));
}
