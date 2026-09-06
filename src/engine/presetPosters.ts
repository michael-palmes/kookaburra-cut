import { invoke } from "@tauri-apps/api/core";
import { nativeProjectSlug, parseProjectId } from "./project";
import { ensureProjectTrusted } from "./projectTrust";

export function canQueuePresetPoster(projectId: string, dev = import.meta.env.DEV): boolean {
  const { scope } = parseProjectId(projectId);
  return (
    scope === "ws-preset" ||
    scope === "ws-template" ||
    (dev && (scope === "preset" || scope === "template"))
  );
}

export async function queuePresetPoster(projectId: string, prioritySlot?: number): Promise<void> {
  if (!canQueuePresetPoster(projectId)) return;
  const { settlePendingContentEdits } = await import("../ui/settleContentEdits");
  await settlePendingContentEdits();
  const slug = nativeProjectSlug(projectId);
  if (["ws-preset", "ws-template"].includes(parseProjectId(projectId).scope))
    await ensureProjectTrusted(slug, slug);
  await invoke("render_submit_preset_poster", { slug, prioritySlot });
}
