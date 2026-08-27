/** The bake step between a captured grid and the export truth: raster the resolved terminal through its colour preset, land the PNG at the scene's canonical asset home, and cache-bust mounted readers. The caller owns the sidecar write (grid + returned src) so the doc update and its history entry stay with the capture action. Workspace projects only, like every asset import. */

import { useAssetVersionStore } from "../store/assetVersionStore";
import type { Theme } from "../theme/tokens";
import { writeTerminalSnapshot } from "./media";
import { isWorkspaceProjectId, workspaceSlug } from "./project";
import type { ResolvedSceneTerminal } from "./sceneTerminal";
import { rasterTerminalSnapshot } from "./sceneTerminalRaster";
import { resolveTerminalColours } from "./sceneTerminalTheme";

/** Raster + save; returns the project-relative `assets/terminal-<stem>.png` for the sidecar's `snapshot.src`. */
export async function bakeTerminalSnapshot(
  projectId: string,
  sceneStem: string,
  terminal: ResolvedSceneTerminal,
  theme: Theme,
): Promise<string> {
  if (!isWorkspaceProjectId(projectId)) {
    throw new Error("terminal snapshots bake into workspace projects only");
  }
  const colours = resolveTerminalColours(terminal.theme, theme);
  const bytes = await rasterTerminalSnapshot(terminal, colours);
  const rel = await writeTerminalSnapshot(workspaceSlug(projectId), sceneStem, bytes);
  useAssetVersionStore.getState().bump(projectId, rel);
  return rel;
}
