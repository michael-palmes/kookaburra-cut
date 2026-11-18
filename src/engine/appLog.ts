import { invoke } from "@tauri-apps/api/core";

/** Settings ▸ About ▸ Export log (audit.rs): Rust opens the Save panel itself. The saved file's name, or null when the person cancels. */
export function exportAppLog(): Promise<string | null> {
  return invoke<string | null>("export_app_log");
}
