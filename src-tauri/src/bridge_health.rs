//! The serving instance's `health` block in its bridge heartbeat (docs/agent-kit.md, "Health"): queue order and estimate, render-window liveness, recycles, the GPU state, WebGL contexts per window and per-client usage. Built by the capture service from memory plus one scan of the pending requests, at the heartbeat's 2 s cadence.

use tauri::AppHandle;

/// This instance's health for the heartbeat.
pub(crate) fn snapshot(app: &AppHandle) -> Option<serde_json::Value> {
    Some(crate::capture_service::health(app))
}
