import { invoke } from "@tauri-apps/api/core";

/** Once per project per session; the Rust side is idempotent regardless. */
const backfilled = new Set<string>();

/** Backfill the bundled sample media (sample phone/laptop recordings + app-icon.png) into a workspace project's assets/ when missing; never fails the load. */
export async function ensureSampleAssets(slug: string): Promise<void> {
  if (backfilled.has(slug)) return;
  backfilled.add(slug);
  await invoke("ensure_sample_assets", { slug }).catch((e) => {
    console.warn("[sample-assets] backfill failed:", e);
  });
}
