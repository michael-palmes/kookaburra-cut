//! Hidden render window (label `render`): the background renderer's shell. Never shown; it will serve capture and thumbnail jobs without touching the editor's canvas or clock. Today it carries the liveness heartbeat: the window reports one beat a second and `render_window_status` exposes the gaps, which is both the R1 throttling spike (`--action render-spike`) and the future job loop's watchdog.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
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

/// Idle teardown: no work for this long closes the window (recreated lazily on the next job).
const IDLE_TEARDOWN_MS: u64 = 300_000;

#[derive(Default)]
pub struct RenderWindowState {
    pub beats: Mutex<VecDeque<RenderBeat>>,
    pub last_work_ms: Mutex<u64>,
}

/// One queued thumb capture: the scene file stem and its source stamp at request time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbJob {
    pub stem: String,
    pub stamp: String,
}

/// A wizard's thumb request; a new submission replaces the whole queue (latest wins), a cancel with the matching generation clears it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbBatch {
    pub slug: String,
    pub generation: u64,
    pub jobs: Vec<ThumbJob>,
}

#[derive(Default)]
pub struct ThumbQueueState(pub Mutex<Option<ThumbBatch>>);

/// One popped thumb job plus enough context to serve it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbTake {
    pub slug: String,
    pub generation: u64,
    pub stem: String,
    pub stamp: String,
    pub remaining: usize,
}

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

fn touch_work(state: &RenderWindowState) {
    *state.last_work_ms.lock().unwrap() = now_ms();
}

/// Open the hidden render window unless it is already alive; returns whether a new window was created. Background throttling is disabled for the same reason the main window disables it: a napped renderer cannot serve jobs.
#[tauri::command]
pub fn ensure_render_window(
    app: AppHandle,
    state: State<RenderWindowState>,
) -> Result<bool, String> {
    touch_work(&state);
    if app.get_webview_window("render").is_some() {
        return Ok(false);
    }
    state.beats.lock().unwrap().clear();
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

/// Queue (or replace) a wizard's thumb batch and make sure the window is up to drain it.
#[tauri::command]
pub fn render_submit_thumbs(
    app: AppHandle,
    queue: State<ThumbQueueState>,
    state: State<RenderWindowState>,
    batch: ThumbBatch,
) -> Result<(), String> {
    *queue.0.lock().unwrap() = Some(batch);
    ensure_render_window(app, state).map(|_| ())
}

/// Drop the queue if it still belongs to this generation (the requesting dialog closed).
#[tauri::command]
pub fn render_cancel_thumbs(queue: State<ThumbQueueState>, generation: u64) {
    let mut q = queue.0.lock().unwrap();
    if q.as_ref().is_some_and(|b| b.generation == generation) {
        *q = None;
    }
}

/// Pop the next thumb job (render window's drain loop); None when the queue is empty.
#[tauri::command]
pub fn render_take_thumb_job(
    queue: State<ThumbQueueState>,
    state: State<RenderWindowState>,
) -> Option<ThumbTake> {
    let mut q = queue.0.lock().unwrap();
    let batch = q.as_mut()?;
    if batch.jobs.is_empty() {
        *q = None;
        return None;
    }
    let job = batch.jobs.remove(0);
    let take = ThumbTake {
        slug: batch.slug.clone(),
        generation: batch.generation,
        stem: job.stem,
        stamp: job.stamp,
        remaining: batch.jobs.len(),
    };
    if batch.jobs.is_empty() {
        *q = None;
    }
    drop(q);
    touch_work(&state);
    Some(take)
}

/// Queued thumb jobs; the editor's pending probe alongside `bridge_pending_count`.
#[tauri::command]
pub fn thumbs_pending_count(queue: State<ThumbQueueState>) -> usize {
    queue.0.lock().unwrap().as_ref().map_or(0, |b| b.jobs.len())
}

/// Close the render window (export lockout, idle teardown); a no-op when it is not open.
#[tauri::command]
pub fn close_render_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("render") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Heartbeat sink, invoked once a second by the render window. Doubles as the idle-teardown check: a long-idle window with no queued work closes itself here.
#[tauri::command]
pub fn render_heartbeat(
    app: AppHandle,
    state: State<RenderWindowState>,
    queue: State<ThumbQueueState>,
    seq: u64,
    delta_ms: f64,
    gl_ms: f64,
) {
    {
        let mut beats = state.beats.lock().unwrap();
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
    let idle_ms = now_ms().saturating_sub(*state.last_work_ms.lock().unwrap());
    if idle_ms < IDLE_TEARDOWN_MS || queue.0.lock().unwrap().is_some() {
        return;
    }
    if crate::bridge::bridge_pending_count(app.clone()).unwrap_or(0) > 0 {
        return;
    }
    if let Some(win) = app.get_webview_window("render") {
        let _ = win.close();
    }
}

/// Liveness and beat history for the spike and the job watchdog.
#[tauri::command]
pub fn render_window_status(
    app: AppHandle,
    state: State<RenderWindowState>,
) -> RenderWindowStatus {
    let beats: Vec<RenderBeat> = state.beats.lock().unwrap().iter().cloned().collect();
    let last_beat_ago_ms = beats.last().map(|b| now_ms().saturating_sub(b.at_ms));
    RenderWindowStatus {
        alive: app.get_webview_window("render").is_some(),
        last_beat_ago_ms,
        beats,
    }
}
