//! Hidden render window (label `render`): the background renderer's shell. Never shown; it will serve capture and thumbnail jobs without touching the editor's canvas or clock. Today it carries the liveness heartbeat: the window reports one beat a second and `render_window_status` exposes the gaps, which is both the R1 throttling spike (`--action render-spike`) and the future job loop's watchdog.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// One heartbeat from the render window; `at_ms` is stamped on receipt so status can compute beat age without trusting the webview's clock.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBeat {
    pub seq: u64,
    pub delta_ms: f64,
    pub gl_ms: f64,
    pub at_ms: u64,
}

/// Ring capacity: about 68 minutes of one-a-second beats.
const BEAT_CAP: usize = 4096;

#[derive(Default)]
pub struct RenderWindowState(pub Mutex<VecDeque<RenderBeat>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderWindowStatus {
    pub alive: bool,
    pub last_beat_ago_ms: Option<u64>,
    pub beats: Vec<RenderBeat>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Open the hidden render window unless it is already alive; returns whether a new window was created. Background throttling is disabled for the same reason the main window disables it: a napped renderer cannot serve jobs.
#[tauri::command]
pub fn ensure_render_window(
    app: AppHandle,
    state: State<RenderWindowState>,
) -> Result<bool, String> {
    if app.get_webview_window("render").is_some() {
        return Ok(false);
    }
    state.0.lock().unwrap().clear();
    WebviewWindowBuilder::new(&app, "render", WebviewUrl::App("render.html".into()))
        .title("Kookaburra Cut — Render")
        .inner_size(640.0, 360.0)
        .visible(false)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .theme(Some(tauri::Theme::Dark))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Close the render window (export lockout, idle teardown); a no-op when it is not open.
#[tauri::command]
pub fn close_render_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("render") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Heartbeat sink, invoked once a second by the render window.
#[tauri::command]
pub fn render_heartbeat(state: State<RenderWindowState>, seq: u64, delta_ms: f64, gl_ms: f64) {
    let mut beats = state.0.lock().unwrap();
    if beats.len() >= BEAT_CAP {
        beats.pop_front();
    }
    beats.push_back(RenderBeat {
        seq,
        delta_ms,
        gl_ms,
        at_ms: now_ms(),
    });
}

/// Liveness and beat history for the spike and the future job watchdog.
#[tauri::command]
pub fn render_window_status(
    app: AppHandle,
    state: State<RenderWindowState>,
) -> RenderWindowStatus {
    let beats: Vec<RenderBeat> = state.0.lock().unwrap().iter().cloned().collect();
    let last_beat_ago_ms = beats.last().map(|b| now_ms().saturating_sub(b.at_ms));
    RenderWindowStatus {
        alive: app.get_webview_window("render").is_some(),
        last_beat_ago_ms,
        beats,
    }
}
