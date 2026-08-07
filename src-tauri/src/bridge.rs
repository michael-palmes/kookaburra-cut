//! The capture bridge: a file-drop queue at `~/Kookaburra Cut/_bridge/` that lets the embedded Claude Code terminal ask the RUNNING app (dev or packaged) for a deterministic frame. `capture.py` writes `requests/<id>.json`; the frontend polls `bridge_claim_request` once a second (the fingerprint-poll cadence), renders through the export path, and answers via `bridge_write_response` + the bridge screenshot pair. Deliberately separate from the autorun screenshot commands (env-gated, cold-boot, single-instance): neither surface may regress the other.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{media, workspace};

const BRIDGE_DIR: &str = "_bridge";
/// Requests older than this are deleted unanswered: their client gave up long ago.
const STALE_REQUEST_MS: u64 = 120_000;
/// Responses (and claimed-request forensics) older than this are pruned opportunistically.
const RESPONSE_TTL_MS: u64 = 600_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub version: u32,
    pub id: String,
    pub project: Option<String>,
    /// Scene selector: index or file stem (the autorun screenshot semantics).
    pub scene: Option<String>,
    /// Seconds into the scene (or the project when no scene is given).
    pub at: Option<f64>,
    pub requested_at_ms: u64,
}

struct PendingBridgeShot {
    width: u32,
    height: u32,
    out: PathBuf,
}

#[derive(Default)]
pub struct BridgeScreenshotState(Mutex<Option<PendingBridgeShot>>);

/// What the render window needs from the editor to serve a request: pushed by the editor's pending-check tick, read by the render window at claim time. `project_id` is None on the welcome screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub project_id: Option<String>,
    pub aspect: String,
    pub current_ms: f64,
    pub export_locked: bool,
}

#[derive(Default)]
pub struct EditorContextState(pub Mutex<Option<EditorContext>>);

#[tauri::command]
pub fn set_editor_context(state: State<EditorContextState>, context: EditorContext) {
    *state.0.lock().unwrap() = Some(context);
}

#[tauri::command]
pub fn get_editor_context(state: State<EditorContextState>) -> Option<EditorContext> {
    state.0.lock().unwrap().clone()
}

/// Unclaimed request count: the editor's cheap pending probe (one directory read, no claims).
#[tauri::command]
pub fn bridge_pending_count(app: AppHandle) -> Result<usize, String> {
    let requests = bridge_root(&app)?.join("requests");
    let Ok(entries) = std::fs::read_dir(&requests) else {
        return Ok(0);
    };
    Ok(entries
        .flatten()
        .filter(|e| {
            let path = e.path();
            path.is_file() && path.extension().and_then(|x| x.to_str()) == Some("json")
        })
        .count())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Always beside `_autorun` under the fixed home location, unaffected by a relocated workspace root.
fn bridge_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(workspace::WORKSPACE_DIR_NAME)
        .join(BRIDGE_DIR))
}

/// Ids come from the client script; path-safety is non-negotiable.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn prune_dir(dir: &PathBuf, ttl_ms: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let ok = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|age| age.as_millis() as u64 <= ttl_ms)
            .unwrap_or(true);
        if !ok {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Claim the oldest pending request (rename into `.claimed/` before any await, so two ticks can never grab one file); stale requests are deleted, old responses pruned. `None` = empty queue.
#[tauri::command]
pub fn bridge_claim_request(app: AppHandle) -> Result<Option<BridgeRequest>, String> {
    let root = bridge_root(&app)?;
    let requests = root.join("requests");
    let Ok(entries) = std::fs::read_dir(&requests) else {
        return Ok(None);
    };
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        if valid_id(&stem) {
            pending.push((stem, path));
        }
    }
    // Lexicographic id order = oldest first (ids lead with a zero-padded timestamp).
    pending.sort_by(|a, b| a.0.cmp(&b.0));
    prune_dir(&root.join("responses"), RESPONSE_TTL_MS);
    prune_dir(&requests.join(".claimed"), RESPONSE_TTL_MS);
    let now = now_ms();
    for (id, path) in pending {
        let Ok(text) = std::fs::read_to_string(&path) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        let Ok(request) = serde_json::from_str::<BridgeRequest>(&text) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if request.requested_at_ms + STALE_REQUEST_MS < now {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let claimed = requests.join(".claimed");
        std::fs::create_dir_all(&claimed).map_err(|e| e.to_string())?;
        std::fs::rename(&path, claimed.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
        return Ok(Some(request));
    }
    Ok(None)
}

/// Answer one claimed request (atomic tmp + rename; the client polls for this file).
#[tauri::command]
pub fn bridge_write_response(app: AppHandle, id: String, json_text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("invalid bridge id {id:?}"));
    }
    serde_json::from_str::<serde_json::Value>(&json_text)
        .map_err(|e| format!("bridge response isn't valid JSON: {e}"))?;
    let dir = bridge_root(&app)?.join("responses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json_text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Arm a bridge capture (the begin_screenshot shape, gated on a configured workspace instead of the autorun env; the PNG lands beside the response JSON).
#[tauri::command]
pub fn begin_bridge_screenshot(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, BridgeScreenshotState>,
    width: u32,
    height: u32,
    name: String,
) -> Result<String, String> {
    workspace::require_root(&app, &settings)?;
    if !valid_id(&name) {
        return Err(format!("invalid bridge id {name:?}"));
    }
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(format!("implausible screenshot geometry {width}x{height}"));
    }
    let dir = bridge_root(&app)?.join("responses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{name}.png"));
    let path = out.to_string_lossy().into_owned();
    *state
        .0
        .lock()
        .map_err(|_| "bridge screenshot state poisoned")? =
        Some(PendingBridgeShot { width, height, out });
    Ok(path)
}

/// Writes the armed bridge capture: one raw RGBA frame (bottom-up, hence vflip) to PNG via the ffmpeg sidecar.
#[tauri::command]
pub async fn save_bridge_screenshot(
    app: AppHandle,
    state: State<'_, BridgeScreenshotState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_bridge_screenshot expects a raw binary body".into());
    };
    let pending = state
        .0
        .lock()
        .map_err(|_| "bridge screenshot state poisoned")?
        .take()
        .ok_or("no bridge screenshot armed (call begin_bridge_screenshot first)")?;
    let expected = (pending.width as usize) * (pending.height as usize) * 4;
    if bytes.len() != expected {
        return Err(format!(
            "frame is {} bytes, expected {expected} for {}x{} RGBA",
            bytes.len(),
            pending.width,
            pending.height
        ));
    }
    media::write_rgba_png(&app, bytes, pending.width, pending.height, &pending.out).await?;
    Ok(pending.out.to_string_lossy().into_owned())
}
