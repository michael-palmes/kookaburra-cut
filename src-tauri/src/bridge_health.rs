//! The serving instance's `health` block in its bridge heartbeat (docs/agent-kit.md, "Instances and addressing"): queue depth, render-window liveness, GPU state. Filled in by the capture service; `bridge::served_pending_count` gives the queue depth.

use tauri::AppHandle;

/// This instance's health for the heartbeat, or None until the capture service reports one.
pub(crate) fn snapshot(app: &AppHandle) -> Option<serde_json::Value> {
    let _ = app;
    None
}
