import { invoke } from "@tauri-apps/api/core";

/** Once per project per session; the Rust side is idempotent regardless. */
const healed = new Set<string>();

/** What a heal rewrote: one entry per scene file whose `defineScene` id changed, plus the files it couldn't parse (left alone). */
export interface SceneIdHeal {
  renamed: { file: string; from: string; to: string }[];
  unparsed: string[];
}

/** Break duplicate `defineScene` ids in a workspace project's scene files (a duplicated scene carries its id across, and colliding ids orphan React fibers); never fails the load. */
export async function ensureUniqueSceneIds(slug: string): Promise<SceneIdHeal | null> {
  if (healed.has(slug)) return null;
  healed.add(slug);
  // The rewrite moves the content fingerprint the stored grant is bound to; Rust re-stamps the grant as part of the heal.
  return invoke<SceneIdHeal>("ensure_unique_scene_ids", { slug }).catch((e) => {
    console.warn("[scene-ids] heal failed:", e);
    return null;
  });
}
