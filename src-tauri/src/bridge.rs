//! The capture bridge: a file-drop queue at `~/Kookaburra Cut/_bridge/` that lets Claude Code ask the RUNNING app (dev or packaged) to capture, check, vet fonts or insert presets (docs/agent-kit.md, "The bridge (v2)"; v1 `capture.py` requests carry no `kind` and still work). Clients write `requests/<id>.json`; the hidden render window claims one per tick via `bridge_claim_request`, serves it through the export path and answers via `bridge_write_response` + the bridge screenshot pair. The editor's one-second tick also writes the `app.json` heartbeat. Deliberately separate from the autorun screenshot commands (env-gated, cold-boot, single-instance): neither surface may regress the other.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::{media, workspace};

const BRIDGE_DIR: &str = "_bridge";
/// Requests older than this are deleted unanswered: their client gave up long ago.
const STALE_REQUEST_MS: u64 = 120_000;
/// Responses (and claimed-request forensics) older than this are pruned opportunistically.
const RESPONSE_TTL_MS: u64 = 600_000;
/// The heartbeat `kb` reads to tell whether the app is running (docs/agent-kit.md, "Heartbeat").
const HEARTBEAT_FILE: &str = "app.json";
/// The heartbeat is rewritten at most this often.
const HEARTBEAT_MIN_INTERVAL_MS: u64 = 2_000;
/// The request kinds this build serves; a request without `kind` is a v1 capture.
pub const BRIDGE_KINDS: [&str; 4] = ["capture", "check", "fonts", "insertPreset"];
/// More than this many asset references per check is a runaway sidecar, not a project.
const MAX_ASSET_CHECKS: usize = 4_000;

/// One frame of a multi-frame capture: a scene selector (index or file stem) and seconds into it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeFrame {
    #[serde(default, deserialize_with = "scene_selector")]
    pub scene: Option<String>,
    #[serde(default)]
    pub at: Option<f64>,
}

/// A bridge request, v1 (`capture.py`: no `kind`) or v2 (`kb`). Only the fields its kind reads matter; unknown fields are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    #[serde(default = "first_version")]
    pub version: u32,
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    /// Scene selector: index or file stem (the autorun screenshot semantics).
    #[serde(default, deserialize_with = "scene_selector")]
    pub scene: Option<String>,
    /// Seconds into the scene (or the project when no scene is given).
    #[serde(default)]
    pub at: Option<f64>,
    /// Zero when the client left it out; the file's age stands in.
    #[serde(default)]
    pub requested_at_ms: u64,
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub frames: Option<Vec<BridgeFrame>>,
    #[serde(default)]
    pub sheet: Option<bool>,
    #[serde(default)]
    pub render: Option<bool>,
    #[serde(default)]
    pub refs: Option<Vec<String>>,
    #[serde(default)]
    pub list_families: Option<bool>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
}

fn first_version() -> u32 {
    1
}

/// Clients send a scene as a stem or an index, string or number alike.
fn scene_selector<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => None,
        Some(Value::String(scene)) => Some(scene),
        Some(Value::Number(n)) => Some(n.as_u64().map_or_else(|| n.to_string(), |i| i.to_string())),
        Some(other) => {
            return Err(D::Error::custom(format!(
                "scene must be a file stem or an index, got {other}"
            )))
        }
    })
}

/// Parse one request file; the error is the sentence the client gets back.
pub(crate) fn parse_request(text: &str) -> Result<BridgeRequest, String> {
    serde_json::from_str::<BridgeRequest>(text).map_err(|e| format!("the request isn't valid: {e}"))
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
    /// Live playback in the editor; queued thumb jobs park while true (bridge captures still serve).
    pub playing: bool,
}

#[derive(Default)]
pub struct EditorContextState(pub Mutex<Option<EditorContext>>);

/// One scene that loaded as an error card (mirror of `SceneLoadError` in src/engine/loadDiagnostics.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSceneError {
    pub index: u32,
    pub file: String,
    pub phase: String,
    pub message: String,
}

/// One font that failed validation (mirror of `FontIssue`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadFontIssue {
    pub r#ref: String,
    pub message: String,
    pub fallback: Option<String>,
}

/// The editor's latest load attempt, reported after every success, degraded load or failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastLoad {
    pub project: String,
    pub ok: bool,
    pub at_ms: u64,
    pub error: Option<String>,
    #[serde(default)]
    pub scene_errors: Vec<LoadSceneError>,
    #[serde(default)]
    pub font_issues: Vec<LoadFontIssue>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Where this build reads its bundled content from; resolved once.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeartbeatPlaces {
    pub resources_dir: Option<String>,
    pub presets_dir: Option<String>,
    pub preset_previews_dir: Option<String>,
}

#[derive(Default)]
struct HeartbeatInner {
    last_write_ms: u64,
    last_load: Option<LastLoad>,
    places: Option<HeartbeatPlaces>,
}

#[derive(Default)]
pub struct HeartbeatState(Mutex<HeartbeatInner>);

/// `_bridge/app.json`, exactly the docs/agent-kit.md shape plus `presetsDir`/`presetPreviewsDir` (dev keeps preset posters outside the repo root).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub version: u32,
    pub pid: u32,
    pub app_version: String,
    pub build: &'static str,
    pub updated_at_ms: u64,
    pub workspace_root: Option<String>,
    pub resources_dir: Option<String>,
    pub presets_dir: Option<String>,
    pub preset_previews_dir: Option<String>,
    pub open_project: Option<String>,
    pub aspect: Option<String>,
    pub playhead_ms: u64,
    pub exporting: bool,
    pub playing: bool,
    pub kinds: [&'static str; 4],
    pub last_load: Option<LastLoad>,
}

pub(crate) fn heartbeat_body(
    app_version: &str,
    workspace_root: Option<String>,
    places: &HeartbeatPlaces,
    context: Option<&EditorContext>,
    last_load: Option<&LastLoad>,
    now: u64,
) -> Heartbeat {
    Heartbeat {
        version: 2,
        pid: std::process::id(),
        app_version: app_version.to_owned(),
        build: if cfg!(debug_assertions) {
            "dev"
        } else {
            "release"
        },
        updated_at_ms: now,
        workspace_root,
        resources_dir: places.resources_dir.clone(),
        presets_dir: places.presets_dir.clone(),
        preset_previews_dir: places.preset_previews_dir.clone(),
        open_project: context.and_then(|c| c.project_id.clone()),
        aspect: context.map(|c| c.aspect.clone()),
        playhead_ms: context.map_or(0, |c| c.current_ms.max(0.0).round() as u64),
        exporting: context.is_some_and(|c| c.export_locked),
        playing: context.is_some_and(|c| c.playing),
        kinds: BRIDGE_KINDS,
        last_load: last_load.cloned(),
    }
}

fn path_text(path: PathBuf) -> String {
    std::fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// Dev resolves against the repo root (presets beside it, posters under src/assets), release against the bundle's Resources.
fn heartbeat_places(app: &AppHandle) -> HeartbeatPlaces {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let (resources, previews) = if cfg!(debug_assertions) {
        (
            Some(dev.clone()),
            Some(dev.join("src/assets/preset-previews")),
        )
    } else {
        let resources = app.path().resource_dir().ok();
        let previews = resources.as_ref().map(|r| r.join("preset-previews"));
        (resources, previews)
    };
    HeartbeatPlaces {
        resources_dir: resources.map(path_text),
        presets_dir: Some(path_text(workspace::presets_root(app))),
        preset_previews_dir: previews.map(path_text),
    }
}

fn workspace_root_text(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
) -> Option<String> {
    match std::env::var("KOOKABURRA_WORKSPACE_ROOT") {
        Ok(over) if !over.trim().is_empty() => Some(over.trim().to_owned()),
        _ => workspace::load_settings(app, settings).ok()?.workspace_root,
    }
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("bridge");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The native refresh cadence; the webview tick usually writes first, this covers it while macOS throttles a hidden window's timers.
const HEARTBEAT_REFRESH: Duration = Duration::from_secs(5);

/// Set once the app is exiting, so the refresh thread can't rewrite a heartbeat `remove_heartbeat` just removed.
static HEARTBEAT_STOPPED: AtomicBool = AtomicBool::new(false);

/// Keep the heartbeat fresh from a native thread: the editor's one-second tick runs in the webview, whose timers macOS throttles while the app is hidden (App Nap, an occluded window), and a stale heartbeat reads as "not running" to kb.
pub fn spawn_heartbeat(app: AppHandle) {
    if crate::is_autorun() {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(HEARTBEAT_REFRESH);
        if HEARTBEAT_STOPPED.load(Ordering::Relaxed) {
            return;
        }
        let context = app
            .state::<EditorContextState>()
            .0
            .lock()
            .ok()
            .and_then(|c| c.clone());
        let heartbeat = app.state::<HeartbeatState>();
        let settings = app.state::<workspace::SettingsState>();
        write_heartbeat(&app, &heartbeat, &settings, context.as_ref());
    });
}

/// Rewrite `_bridge/app.json` unless it was written under two seconds ago; interactive app only.
fn write_heartbeat(
    app: &AppHandle,
    heartbeat: &HeartbeatState,
    settings: &State<'_, workspace::SettingsState>,
    context: Option<&EditorContext>,
) {
    if crate::is_autorun() || HEARTBEAT_STOPPED.load(Ordering::Relaxed) {
        return;
    }
    let now = now_ms();
    let (places, last_load) = {
        let Ok(mut inner) = heartbeat.0.lock() else {
            return;
        };
        if now.saturating_sub(inner.last_write_ms) < HEARTBEAT_MIN_INTERVAL_MS {
            return;
        }
        inner.last_write_ms = now;
        let places = inner
            .places
            .get_or_insert_with(|| heartbeat_places(app))
            .clone();
        (places, inner.last_load.clone())
    };
    let body = heartbeat_body(
        &app.package_info().version.to_string(),
        workspace_root_text(app, settings),
        &places,
        context,
        last_load.as_ref(),
        now,
    );
    let Ok(root) = bridge_root(app) else {
        return;
    };
    let written = std::fs::create_dir_all(&root)
        .map_err(|e| e.to_string())
        .and_then(|()| serde_json::to_string_pretty(&body).map_err(|e| e.to_string()))
        .and_then(|text| write_atomic(&root.join(HEARTBEAT_FILE), &text));
    if let Err(e) = written {
        log::warn!("[bridge] heartbeat write failed: {e}");
    }
}

/// Remove this process's heartbeat on exit; another instance's file is left alone.
pub fn remove_heartbeat(app: &AppHandle) {
    if crate::is_autorun() {
        return;
    }
    HEARTBEAT_STOPPED.store(true, Ordering::Relaxed);
    let Ok(path) = bridge_root(app).map(|root| root.join(HEARTBEAT_FILE)) else {
        return;
    };
    let ours = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("pid").and_then(Value::as_u64))
        == Some(u64::from(std::process::id()));
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

/// The editor's one-second tick (every view, the welcome screen included): the render window's context, and the heartbeat.
#[tauri::command]
pub fn set_editor_context(
    app: AppHandle,
    state: State<'_, EditorContextState>,
    heartbeat: State<'_, HeartbeatState>,
    settings: State<'_, workspace::SettingsState>,
    context: EditorContext,
) {
    write_heartbeat(&app, &heartbeat, &settings, Some(&context));
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(context);
    }
}

/// The editor reports every load attempt; it rides the next heartbeat.
#[tauri::command]
pub fn set_last_load(
    app: AppHandle,
    state: State<'_, EditorContextState>,
    heartbeat: State<'_, HeartbeatState>,
    settings: State<'_, workspace::SettingsState>,
    load: LastLoad,
) {
    if let Ok(mut inner) = heartbeat.0.lock() {
        inner.last_load = Some(load);
    }
    let context = state.0.lock().ok().and_then(|c| c.clone());
    write_heartbeat(&app, &heartbeat, &settings, context.as_ref());
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
    valid_name(id, 64)
}

/// Response file names: an id, or an id plus a frame suffix.
fn valid_name(name: &str, max: usize) -> bool {
    !name.is_empty()
        && name.len() <= max
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn write_response_value(root: &Path, id: &str, body: &Value) -> Result<(), String> {
    let dir = root.join("responses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("{id}.json")), &body.to_string())
}

fn file_age_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map_or(0, |age| age.as_millis() as u64)
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
        let age_ms = file_age_ms(&path);
        let request = match parse_request(&text) {
            Ok(request) => request,
            Err(error) => {
                // Answer instead of dropping, so the client fails fast with the reason.
                let _ = std::fs::remove_file(&path);
                let body = json!({ "version": 2, "id": id, "ok": false, "error": error });
                let _ = write_response_value(&root, &id, &body);
                continue;
            }
        };
        let fresh = if request.requested_at_ms == 0 {
            age_ms <= STALE_REQUEST_MS
        } else {
            request.requested_at_ms + STALE_REQUEST_MS >= now
        };
        if !fresh {
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
    write_atomic(&dir.join(format!("{id}.json")), &json_text)
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
    if !valid_name(&name, 96) {
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

/// Write a capture's contact sheet (raw PNG body; header `x-kookaburra-id`) beside its response.
#[tauri::command]
pub fn bridge_write_sheet(app: AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let id = request
        .headers()
        .get("x-kookaburra-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or("missing x-kookaburra-id header")?;
    if !valid_id(&id) {
        return Err(format!("invalid bridge id {id:?}"));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("bridge_write_sheet expects a raw binary body".into());
    };
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if bytes.len() < 8 || bytes[..4] != PNG_MAGIC {
        return Err("contact sheet body is not a PNG".into());
    }
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("contact sheet too large".into());
    }
    let dir = bridge_root(&app)?.join("responses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}-sheet.png"));
    let tmp = dir.join(format!(".{id}-sheet.png.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCheck {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether a project-relative path names a file with exactly this spelling (macOS volumes are case-insensitive, exports elsewhere may not be).
pub(crate) fn exact_case_file(root: &Path, rel: &str) -> Result<(), String> {
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    let parts: Vec<&str> = rel.split('/').collect();
    if rel.starts_with('/')
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return Err("not a project-relative path".into());
    }
    let mut current = root.to_path_buf();
    let mut on_disk: Vec<String> = Vec::with_capacity(parts.len());
    for part in &parts {
        let names: Vec<String> = std::fs::read_dir(&current)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let found = names.iter().find(|n| n.as_str() == *part).or_else(|| {
            names
                .iter()
                .find(|n| n.to_lowercase() == part.to_lowercase())
        });
        let Some(found) = found else {
            return Err("no such file".into());
        };
        current.push(found);
        on_disk.push(found.clone());
    }
    let actual = on_disk.join("/");
    if actual != parts.join("/") {
        return Err(format!("the file on disk is spelled {actual}"));
    }
    if current.is_dir() {
        return Err("is a folder, not a file".into());
    }
    Ok(())
}

/// The `check` request's asset pass: each project-relative path, existing with exact case.
#[tauri::command]
pub fn bridge_check_assets(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    slug: String,
    paths: Vec<String>,
) -> Result<Vec<AssetCheck>, String> {
    let dir = workspace::project_dir(&app, &settings, &slug)?;
    Ok(paths
        .into_iter()
        .take(MAX_ASSET_CHECKS)
        .map(|path| {
            let result = exact_case_file(&dir, &path);
            AssetCheck {
                path,
                ok: result.is_ok(),
                error: result.err(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kookaburra-bridge-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn v1_captures_still_parse() {
        let request = parse_request(
            r#"{"version":1,"id":"0001792020000000-1-abc","project":"ws:demo","scene":"01-hero","at":1.5,"requestedAtMs":1792020000000}"#,
        )
        .unwrap();
        assert_eq!(request.kind, None);
        assert_eq!(request.version, 1);
        assert_eq!(request.scene.as_deref(), Some("01-hero"));
        assert_eq!(request.at, Some(1.5));
        assert_eq!(request.requested_at_ms, 1_792_020_000_000);
        assert_eq!(request.frames, None);
    }

    #[test]
    fn v2_requests_carry_every_kind_field() {
        let request = parse_request(
            r#"{ "version": 2, "id": "0001792020000000-123-abc", "kind": "capture",
              "project": "ws:demo", "requestedAtMs": 1792020000000,
              "scene": 3, "at": 1.5, "aspect": "9:16",
              "frames": [{ "scene": "3", "at": 2.0 }, { "scene": 4 }, {}], "sheet": true,
              "render": false, "refs": ["Menlo@400"], "listFamilies": false,
              "preset": "title", "position": 4, "name": "Highlights", "future": [1] }"#,
        )
        .unwrap();
        assert_eq!(request.kind.as_deref(), Some("capture"));
        assert_eq!(request.scene.as_deref(), Some("3"));
        assert_eq!(request.aspect.as_deref(), Some("9:16"));
        assert_eq!(
            request.frames.unwrap(),
            vec![
                BridgeFrame {
                    scene: Some("3".into()),
                    at: Some(2.0)
                },
                BridgeFrame {
                    scene: Some("4".into()),
                    at: None
                },
                BridgeFrame::default(),
            ]
        );
        assert_eq!(request.sheet, Some(true));
        assert_eq!(request.render, Some(false));
        assert_eq!(request.refs.unwrap(), vec!["Menlo@400".to_string()]);
        assert_eq!(request.list_families, Some(false));
        assert_eq!(request.preset.as_deref(), Some("title"));
        assert_eq!(request.position, Some(4));
        assert_eq!(request.name.as_deref(), Some("Highlights"));
    }

    #[test]
    fn minimal_and_malformed_requests() {
        let request = parse_request(r#"{"id":"abc","kind":"check"}"#).unwrap();
        assert_eq!((request.version, request.requested_at_ms), (1, 0));
        assert!(parse_request(r#"{"id":"abc","scene":["x"]}"#)
            .unwrap_err()
            .contains("scene must be"));
        assert!(parse_request("{").is_err());
    }

    #[test]
    fn the_request_round_trips_to_the_render_window_in_camel_case() {
        let request = parse_request(r#"{"id":"abc","kind":"fonts","listFamilies":true}"#).unwrap();
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["listFamilies"], true);
        assert_eq!(value["requestedAtMs"], 0);
        assert_eq!(value["kind"], "fonts");
    }

    #[test]
    fn the_heartbeat_has_the_contract_shape() {
        let context = EditorContext {
            project_id: Some("ws:product-tour".into()),
            aspect: "16:9".into(),
            current_ms: 61_000.4,
            export_locked: false,
            playing: true,
        };
        let load = LastLoad {
            project: "ws:product-tour".into(),
            ok: true,
            at_ms: 1_792_019_990_000,
            error: None,
            scene_errors: vec![LoadSceneError {
                index: 12,
                file: "scenes/224-x.tsx".into(),
                phase: "compile".into(),
                message: "line 4".into(),
            }],
            font_issues: vec![LoadFontIssue {
                r#ref: "Menlo@400".into(),
                message: "unknown cmap table format 6".into(),
                fallback: Some("Inter@400".into()),
            }],
            warnings: vec![],
        };
        let places = HeartbeatPlaces {
            resources_dir: Some("/Applications/Kookaburra Cut.app/Contents/Resources".into()),
            presets_dir: Some("/x/presets".into()),
            preset_previews_dir: Some("/x/preset-previews".into()),
        };
        let body = heartbeat_body(
            "0.19.0",
            Some("/Users/x/Kookaburra Cut".into()),
            &places,
            Some(&context),
            Some(&load),
            1_792_020_000_000,
        );
        let value = serde_json::to_value(&body).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "appVersion",
                "aspect",
                "build",
                "exporting",
                "kinds",
                "lastLoad",
                "openProject",
                "pid",
                "playheadMs",
                "playing",
                "presetPreviewsDir",
                "presetsDir",
                "resourcesDir",
                "updatedAtMs",
                "version",
                "workspaceRoot",
            ]
        );
        assert_eq!(value["version"], 2);
        assert_eq!(value["playheadMs"], 61_000);
        assert_eq!(value["openProject"], "ws:product-tour");
        assert_eq!(
            value["kinds"],
            json!(["capture", "check", "fonts", "insertPreset"])
        );
        assert_eq!(
            value["lastLoad"],
            json!({
                "project": "ws:product-tour", "ok": true, "atMs": 1_792_019_990_000u64, "error": null,
                "sceneErrors": [{ "index": 12, "file": "scenes/224-x.tsx", "phase": "compile", "message": "line 4" }],
                "fontIssues": [{ "ref": "Menlo@400", "message": "unknown cmap table format 6", "fallback": "Inter@400" }],
                "warnings": []
            })
        );
        let welcome =
            serde_json::to_value(heartbeat_body("0.19.0", None, &places, None, None, 1)).unwrap();
        assert_eq!(welcome["openProject"], Value::Null);
        assert_eq!(welcome["lastLoad"], Value::Null);
    }

    #[test]
    fn last_load_accepts_absent_diagnostics() {
        let load: LastLoad = serde_json::from_value(json!({
            "project": "ws:x", "ok": false, "atMs": 1, "error": "boom"
        }))
        .unwrap();
        assert!(load.scene_errors.is_empty() && load.font_issues.is_empty());
    }

    #[test]
    fn assets_must_exist_with_exact_case() {
        let dir = scratch("assets");
        std::fs::create_dir_all(dir.join("assets/Shots")).unwrap();
        std::fs::write(dir.join("assets/Shots/Hero.png"), b"png").unwrap();
        assert_eq!(exact_case_file(&dir, "assets/Shots/Hero.png"), Ok(()));
        assert_eq!(exact_case_file(&dir, "./assets/Shots/Hero.png"), Ok(()));
        assert_eq!(
            exact_case_file(&dir, "assets/shots/hero.png"),
            Err("the file on disk is spelled assets/Shots/Hero.png".into())
        );
        assert_eq!(
            exact_case_file(&dir, "assets/Shots/Missing.png"),
            Err("no such file".into())
        );
        assert_eq!(
            exact_case_file(&dir, "assets/Shots"),
            Err("is a folder, not a file".into())
        );
        for bad in ["/etc/hosts", "assets/../project.json", "assets//x.png", ""] {
            assert_eq!(
                exact_case_file(&dir, bad),
                Err("not a project-relative path".into())
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn frame_names_allow_a_suffix_but_stay_path_safe() {
        assert!(valid_name("0001792020000000-123-abc-12", 96));
        assert!(!valid_name("../x", 96));
        assert!(!valid_id(&"a".repeat(65)));
    }
}
