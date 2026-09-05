import { invoke } from "@tauri-apps/api/core";
import { nativeProjectSlug, parseProjectId } from "./project";
import { ensureProjectTrusted } from "./projectTrust";

export function canQueuePresetPoster(projectId: string, dev = import.meta.env.DEV): boolean {
  const { scope } = parseProjectId(projectId);
  return scope === "ws-preset" || (dev && scope === "preset");
}

export async function queuePresetPoster(projectId: string): Promise<void> {
  if (!canQueuePresetPoster(projectId)) return;
  const slug = nativeProjectSlug(projectId);
  if (parseProjectId(projectId).scope === "ws-preset") await ensureProjectTrusted(slug, slug);
  await invoke("render_submit_preset_poster", { slug });
}
