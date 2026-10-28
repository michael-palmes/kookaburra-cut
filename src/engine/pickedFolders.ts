import { invoke } from "@tauri-apps/api/core";

/** Tell the app a native dialog returned this path, so kb and the headless CLI may write under its folder for the rest of the session (docs/agent-kit.md, "kb reach"). A Save dialog's file counts as its parent. Never throws: the dialog's own result is what matters. */
export async function notePickedFolder(path: string | null | undefined): Promise<void> {
  if (typeof path !== "string" || path.length === 0) return;
  try {
    await invoke("note_picked_folder", { path });
  } catch (e) {
    console.warn("[picked-folders] not recorded:", e);
  }
}
