import { invoke } from "@tauri-apps/api/core";

/** Restore the pool samples a workspace project names (and app-icon.png) into its assets/ when missing; never fails the load. Every load, so a sample a scene starts naming mid-session lands before the scene draws. */
export async function ensureSampleAssets(slug: string): Promise<void> {
  await invoke("ensure_sample_assets", { slug }).catch((e) => {
    console.warn("[sample-assets] backfill failed:", e);
  });
}
