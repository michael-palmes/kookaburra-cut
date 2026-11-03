import { invoke } from "@tauri-apps/api/core";

export type PickPurpose = "workspaceLocation" | "terminalStartFolder";

/** Run the folder dialog from Rust on this window (docs/agent-kit.md, "kb reach"). Resolves to the chosen path, or null when cancelled. */
export function pickFolder(purpose: PickPurpose): Promise<string | null> {
  return invoke<string | null>("pick_folder", { purpose });
}
