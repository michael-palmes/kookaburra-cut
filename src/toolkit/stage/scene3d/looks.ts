import { SCENE3D_FAMILIES } from "./families";
import type { Scene3dBackgroundDef, Scene3dBackgroundPreset, Scene3dLookModule } from "./types";

export interface DiscoveredScene3dLook {
  folder: string;
  look: Scene3dBackgroundDef;
  presets: Scene3dBackgroundPreset[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Folder-per-look discovery: keeps modules exporting `look` and `presets`, drops duplicate ids (warned), and orders by family, then name, then id. */
export function collectScene3dLooks(
  modules: Record<string, Partial<Scene3dLookModule>>,
): DiscoveredScene3dLook[] {
  const out: DiscoveredScene3dLook[] = [];
  const seen = new Set<string>();
  for (const [path, mod] of Object.entries(modules)) {
    const folder = path.split("/").at(-2) ?? path;
    if (!mod.look || !Array.isArray(mod.presets)) {
      console.warn(
        `[stage] 3D look folder "${folder}" needs \`look\` and \`presets\` exports, skipped`,
      );
      continue;
    }
    if (seen.has(mod.look.id)) {
      console.warn(`[stage] duplicate 3D look id "${mod.look.id}" in "${folder}", skipped`);
      continue;
    }
    seen.add(mod.look.id);
    out.push({ folder, look: mod.look, presets: mod.presets });
  }
  const rank = (look: Scene3dBackgroundDef) => SCENE3D_FAMILIES.indexOf(look.family);
  return out.sort(
    (a, b) =>
      rank(a.look) - rank(b.look) ||
      byText(a.look.name, b.look.name) ||
      byText(a.look.id, b.look.id),
  );
}

export const DISCOVERED_SCENE3D_LOOKS = collectScene3dLooks(
  import.meta.glob<Partial<Scene3dLookModule>>("./looks/*/index.ts", { eager: true }),
);
