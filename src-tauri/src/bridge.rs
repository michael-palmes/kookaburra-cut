//! The capture bridge: a file-drop queue at `~/Kookaburra Cut/_bridge/` that lets Claude Code ask the RUNNING app (dev or packaged) to capture, check, vet fonts, insert presets, refresh changed media or open the video editor (docs/agent-kit.md, "The bridge (v2)"; v1 `capture.py` requests carry no `kind` and still work). Clients write `requests/<id>.json`; the hidden render window claims one per tick via `bridge_claim_request`, serves it through the export path and answers via `bridge_write_response` + the bridge screenshot pair. The native kinds (`NATIVE_KINDS`) never reach the render window: `spawn_native_bridge` claims and serves them from Rust. Several app instances can share the queue: `init` decides once whether this one serves (`bridge_role`), every claim and the pending count go through `claimable`, and every answer carries `servedBy`. The editor's one-second tick also writes this instance's `apps/<pid>.json` heartbeat (plus `app.json` when it is the elected primary). Deliberately separate from the autorun screenshot commands (env-gated, cold-boot, single-instance): neither surface may regress the other.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{media, workspace};

const BRIDGE_DIR: &str = "_bridge";
/// Requests without a `deadlineAtMs` older than this are deleted unanswered: their client gave up long ago.
const STALE_REQUEST_MS: u64 = 120_000;
/// A request's `deadlineAtMs` counts for at most this long after it was sent.
const MAX_DEADLINE_MS: u64 = 3_600_000;
/// Responses (and claimed-request forensics) older than this are pruned by their owner.
pub(crate) const RESPONSE_TTL_MS: u64 = 3_600_000;
/// Responses past this total are pruned oldest first.
pub(crate) const RESPONSE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The primary heartbeat older kits read (docs/agent-kit.md, "Heartbeat"); written only by the elected primary.
const HEARTBEAT_FILE: &str = "app.json";
/// Per-process heartbeats: `apps/<pid>.json`, written by every interactive instance, serving or not.
const APPS_DIR: &str = "apps";
const HEARTBEAT_VERSION: u32 = 3;
/// The heartbeat is rewritten at most this often.
const HEARTBEAT_MIN_INTERVAL_MS: u64 = 2_000;
/// kb's liveness window; an older primary heartbeat may be taken over.
const HEARTBEAT_FRESH_MS: u64 = 30_000;
/// Another instance's heartbeat this old is pruned even when its pid is alive (pid reuse after a crash).
const INSTANCE_PRUNE_MS: u64 = 600_000;
/// The request kinds this build serves; a request without `kind` is a v1 capture.
pub const BRIDGE_KINDS: &[&str] = &[
    "capture",
    "check",
    "fonts",
    "insertPreset",
    "mediaChanged",
    "openEdit",
    "debug",
    "export",
    "cancelExport",
];
/// The kinds `spawn_native_bridge` serves from Rust; the render window never claims them (a `debug` request routes by its op, `RoutePeek::native`).
pub const NATIVE_KINDS: &[&str] = &["mediaChanged", "openEdit", "export", "cancelExport"];
/// The headless edit CLI contract this binary answers (`<exe> edit caps` reports the same `cli`).
pub const CLI_VERSION: u32 = 1;
/// Where kb finds this binary's CLI while the app is closed (docs/agent-kit.md, "Heartbeat").
const CLI_MARKER_FILE: &str = "cli.json";
/// The native loop's poll cadence.
const NATIVE_POLL: Duration = Duration::from_millis(300);
/// More media paths than this in one `mediaChanged` is a runaway client.
const MAX_MEDIA_PATHS: usize = 256;
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
    /// Project-relative media paths (`mediaChanged`).
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// The edit a `mediaChanged` render came from.
    #[serde(default)]
    pub edit: Option<String>,
    /// The client's project folder; a native request must name the same folder the workspace has.
    #[serde(default)]
    pub project_path: Option<String>,
    /// The client's workspace root: only an instance on the same folder claims the request.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// The instance kb elected; every other instance leaves the request alone.
    #[serde(default)]
    pub instance_pid: Option<u32>,
    /// The agent that sent the request.
    #[serde(default)]
    pub client: Option<String>,
    /// When the client stops waiting; freshness follows it (capped at 1 h).
    #[serde(default)]
    pub deadline_at_ms: Option<u64>,
    /// The request this one retries after a GPU stall; it keeps the original's queue place.
    #[serde(default)]
    pub retry_of: Option<String>,
    /// Capture width in pixels (literal), else `scale` in (0, 1] of the native size.
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub scale: Option<f64>,
    /// Pixels to sample from each frame, `[[x, y], ...]` in the returned image.
    #[serde(default)]
    pub probe: Option<Value>,
    /// The `debug` kind's operation and target window.
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub window: Option<String>,
    /// The dev-only `spawn-contexts` debug op's count.
    #[serde(default)]
    pub n: Option<u32>,
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

/// v1 clients get v1 answers (mirror of `responseVersion` in src/render/bridgeRequests.ts).
pub(crate) fn response_version(request: &BridgeRequest) -> u32 {
    if request.kind.is_some() || request.version >= 2 {
        2
    } else {
        1
    }
}

/// When the client stops waiting: `deadlineAtMs` capped at 1 h after sending, else the 120 s rule; the file's age stands in for a missing `requestedAtMs`.
pub(crate) fn request_deadline(request: &BridgeRequest, age_ms: u64, now: u64) -> u64 {
    let sent = if request.requested_at_ms == 0 {
        now.saturating_sub(age_ms)
    } else {
        request.requested_at_ms
    };
    match request.deadline_at_ms {
        Some(deadline) => deadline.min(sent + MAX_DEADLINE_MS),
        None => sent + STALE_REQUEST_MS,
    }
}

pub(crate) fn request_fresh(request: &BridgeRequest, age_ms: u64, now: u64) -> bool {
    now <= request_deadline(request, age_ms, now)
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
    /// Device ids this build renders with their own model (the rest render as Android).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_devices: Vec<String>,
}

/// Where this build reads its bundled content from; resolved once.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeartbeatPlaces {
    pub resources_dir: Option<String>,
    pub presets_dir: Option<String>,
    pub preset_previews_dir: Option<String>,
    /// This binary, which answers `edit <command>` as the headless CLI.
    pub cli_path: Option<String>,
}

#[derive(Default)]
struct HeartbeatInner {
    last_write_ms: u64,
    last_load: Option<LastLoad>,
    places: Option<HeartbeatPlaces>,
}

#[derive(Default)]
pub struct HeartbeatState(Mutex<HeartbeatInner>);

/// `_bridge/apps/<pid>.json` (and `app.json` from the primary): the docs/agent-kit.md shape plus `presetsDir`/`presetPreviewsDir` (dev keeps preset posters outside the repo root).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub version: u32,
    pub pid: u32,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub app_version: String,
    pub build: &'static str,
    pub bundle_id: String,
    pub exe_path: Option<String>,
    pub checkout: Option<Checkout>,
    pub workspace_root: Option<String>,
    pub root_source: &'static str,
    pub bridge: BridgeRole,
    pub primary: bool,
    pub resources_dir: Option<String>,
    pub presets_dir: Option<String>,
    pub preset_previews_dir: Option<String>,
    pub open_project: Option<String>,
    pub aspect: Option<String>,
    pub playhead_ms: u64,
    pub exporting: bool,
    pub playing: bool,
    pub kinds: &'static [&'static str],
    pub cli_path: Option<String>,
    pub cli_version: u32,
    pub last_load: Option<LastLoad>,
    /// Filled by the bridge export.
    pub export_job: Option<Value>,
    /// Filled by the capture service (`bridge_health`); serving instances only.
    pub health: Option<Value>,
    /// Folders the app's own file dialogs returned this session: the only places outside the workspace kb may write.
    pub picked_dirs: Vec<String>,
}

// ── Picked folders ─────────────────────────────────────────────────────────

/// Folders a person chose in one of the app's native dialogs this session (`note_picked_folder`); published in the heartbeat so kb and the headless CLI can honour them, forgotten when the app quits.
#[derive(Default)]
pub struct PickedFolders(Mutex<Vec<PathBuf>>);

const PICKED_FOLDERS_CAP: usize = 32;

impl PickedFolders {
    pub(crate) fn note(&self, path: &Path) {
        let Ok(mut list) = self.0.lock() else {
            return;
        };
        list.retain(|p| p != path);
        list.push(path.to_path_buf());
        let excess = list.len().saturating_sub(PICKED_FOLDERS_CAP);
        list.drain(..excess);
    }

    pub(crate) fn list(&self) -> Vec<PathBuf> {
        self.0.lock().map(|list| list.clone()).unwrap_or_default()
    }
}

/// Folders too broad to hand kb as a write root even when a dialog returned them: the filesystem root, the volume and user roots, and the home folder itself.
fn too_broad_to_pick(dir: &Path, home: Option<&Path>) -> bool {
    let depth = dir.components().count();
    depth <= 2 || home.is_some_and(|home| dir == home)
}

/// Folders whose contents are credentials (the same set kb refuses to read).
const NEVER_PICKED: [&str; 5] = [".ssh", ".aws", ".config", ".gnupg", "Library/Keychains"];

/// A folder the person just chose in a native dialog (a Save dialog's parent counts). Only an existing directory is kept, and never one broad enough to make the confinement moot or one that holds credentials; the command comes from the webview, so it trusts the path no further than that.
#[tauri::command]
pub fn note_picked_folder(
    app: AppHandle,
    state: State<'_, PickedFolders>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("a picked folder must be an absolute path".into());
    }
    let dir = if path.is_dir() {
        path
    } else {
        path.parent()
            .filter(|p| p.is_dir())
            .map(Path::to_path_buf)
            .ok_or("that path is not inside an existing folder")?
    };
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    let home = app
        .path()
        .home_dir()
        .ok()
        .map(|h| std::fs::canonicalize(&h).unwrap_or(h));
    if too_broad_to_pick(&dir, home.as_deref()) {
        return Err("that folder is too broad to hand to Claude; pick a folder inside it".into());
    }
    if home
        .as_deref()
        .is_some_and(|home| NEVER_PICKED.iter().any(|rel| dir.starts_with(home.join(rel))))
    {
        return Err("that folder holds credentials and is never handed to Claude".into());
    }
    state.note(&dir);
    Ok(())
}

/// `pickedDirs` of every live heartbeat under `bridge`, for a process with no app handle (the headless CLI).
pub(crate) fn picked_dirs_in(bridge: &Path) -> Vec<PathBuf> {
    let now = now_ms();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(bridge.join(APPS_DIR)) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(body) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let fresh = body
            .get("updatedAtMs")
            .and_then(Value::as_u64)
            .is_some_and(|at| now.saturating_sub(at) <= HEARTBEAT_FRESH_MS);
        if !fresh {
            continue;
        }
        for dir in body
            .get("pickedDirs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let path = PathBuf::from(dir);
            if path.is_absolute() && !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// The bridge folder for a process without an app handle: the test override, else the fixed home location.
pub(crate) fn bridge_root_without_app() -> Option<PathBuf> {
    if let Some(dir) = bridge_dir_env() {
        return Some(dir.clone());
    }
    crate::tools::home_dir()
        .ok()
        .map(|home| home.join(workspace::WORKSPACE_DIR_NAME).join(BRIDGE_DIR))
}

// ── Cross-project confirmation ─────────────────────────────────────────────

/// A request for a workspace project other than the one open in the editor renders or opens that project on an agent's say-so, so the person confirms it once per project per session; a refusal holds for a minute so a flood of requests cannot flood dialogs.
#[derive(Default)]
pub struct BridgeGrants {
    allowed: Mutex<HashSet<String>>,
    declined_until: Mutex<HashMap<String, Instant>>,
    prompting: Mutex<()>,
}

const DECLINE_HOLD: Duration = Duration::from_secs(60);

fn access_verb(kind: &str) -> &'static str {
    match kind {
        "capture" => "render frames of",
        "check" => "load and check",
        "insertPreset" => "add a scene to",
        "openEdit" => "open the video editor for",
        _ => "use",
    }
}

/// Whether the agent may act on `slug`: true without asking when the editor has it open or the person already allowed it this session, else one native dialog (off the main thread).
pub(crate) fn confirm_project_access(
    app: &AppHandle,
    slug: &str,
    kind: &str,
    client: Option<&str>,
) -> bool {
    let project_id = format!("ws:{slug}");
    if editor_context(app).and_then(|c| c.project_id) == Some(project_id.clone()) {
        return true;
    }
    let grants = app.state::<BridgeGrants>();
    if grants
        .allowed
        .lock()
        .is_ok_and(|allowed| allowed.contains(slug))
    {
        return true;
    }
    if grants.declined_until.lock().is_ok_and(|held| {
        held.get(slug)
            .is_some_and(|until| Instant::now() < *until)
    }) {
        return false;
    }
    let _one_at_a_time = grants.prompting.lock().unwrap_or_else(|p| p.into_inner());
    if grants
        .allowed
        .lock()
        .is_ok_and(|allowed| allowed.contains(slug))
    {
        return true;
    }
    let name = crate::clean_text::clean_text_with_cap(slug, 80);
    let who = client
        .map(|c| crate::clean_text::clean_text_with_cap(c, 40))
        .filter(|c| !c.is_empty())
        .map(|c| format!(" (request from {c})"))
        .unwrap_or_default();
    let message = format!(
        "Claude asked to {} \"{name}\", which is not the project open in Kookaburra Cut{who}.\n\nAllow it for the rest of this session?",
        access_verb(kind)
    );
    let allowed = app
        .dialog()
        .message(message)
        .title("Allow Claude to use another project?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".into(),
            "Don't allow".into(),
        ))
        .blocking_show();
    if allowed {
        if let Ok(mut set) = grants.allowed.lock() {
            set.insert(slug.to_owned());
        }
    } else if let Ok(mut held) = grants.declined_until.lock() {
        held.insert(slug.to_owned(), Instant::now() + DECLINE_HOLD);
    }
    allowed
}

/// The render window asks before serving a request for a project the editor does not have open.
#[tauri::command]
pub async fn bridge_confirm_project(
    app: AppHandle,
    slug: String,
    kind: String,
    client: Option<String>,
) -> Result<bool, String> {
    workspace::validate_slug(&slug)?;
    tauri::async_runtime::spawn_blocking(move || {
        confirm_project_access(&app, &slug, &kind, client.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// The sentence a refused request carries.
pub(crate) fn access_refused(slug: &str, kind: &str) -> String {
    format!(
        "the person did not allow Claude to {} \"ws:{slug}\" (it is not the project open in Kookaburra Cut); ask them to open it in the app, or to allow it when the app asks",
        access_verb(kind)
    )
}

fn build_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

// ── Instances ──────────────────────────────────────────────────────────────

/// The source checkout of a debug build; `worktree` when it is a linked git worktree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub path: String,
    pub worktree: bool,
}

/// Who this process is, fixed at start.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIdentity {
    pub pid: u32,
    pub bundle_id: String,
    pub build: &'static str,
    pub app_version: String,
    pub exe_path: Option<String>,
    pub started_at_ms: u64,
    pub checkout: Option<Checkout>,
}

/// Whether this instance serves the bridge, and why (or why not).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BridgeRole {
    pub serving: bool,
    pub reason: Option<String>,
}

/// Everything `bridge_role` decides on.
#[derive(Debug, Clone, Default)]
pub(crate) struct RoleInputs<'a> {
    pub autorun: bool,
    /// `KOOKABURRA_BRIDGE`, trimmed.
    pub bridge_env: Option<&'a str>,
    pub root_overridden: bool,
    pub bundle_id: &'a str,
    /// A debug build compiled from a linked git worktree.
    pub worktree_build: bool,
}

/// Default servers are the packaged app and a dev build from the main checkout; everything else opts in with `KOOKABURRA_BRIDGE=1` (docs/agent-kit.md, "Instances and addressing").
pub(crate) fn bridge_role(inputs: &RoleInputs) -> BridgeRole {
    let off = |reason: String| BridgeRole {
        serving: false,
        reason: Some(reason),
    };
    if inputs.autorun {
        return off("autorun".into());
    }
    match inputs.bridge_env {
        Some("0") => return off("turned off by KOOKABURRA_BRIDGE=0".into()),
        Some("1") => {
            return BridgeRole {
                serving: true,
                reason: Some("opted in by KOOKABURRA_BRIDGE=1".into()),
            }
        }
        _ => {}
    }
    if inputs.root_overridden {
        return off("workspace root overridden by KOOKABURRA_WORKSPACE_ROOT".into());
    }
    if inputs.bundle_id != crate::tools::APP_IDENTIFIER {
        return off(format!("non-production bundle id {}", inputs.bundle_id));
    }
    if inputs.worktree_build {
        return off("dev build from a git worktree".into());
    }
    BridgeRole {
        serving: true,
        reason: None,
    }
}

struct Instance {
    identity: BridgeIdentity,
    role: BridgeRole,
}

static INSTANCE: OnceLock<Instance> = OnceLock::new();

fn dev_checkout() -> Option<Checkout> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let worktree = repo.join(".git").is_file();
    Some(Checkout {
        path: path_text(repo),
        worktree,
    })
}

/// Decide this instance's role and identity once, before the heartbeat and native loop start.
pub fn init(app: &AppHandle) {
    INSTANCE.get_or_init(|| {
        let checkout = dev_checkout();
        let bundle_id = app.config().identifier.clone();
        let bridge_env = std::env::var("KOOKABURRA_BRIDGE").ok();
        let bridge_env = bridge_env.as_deref().map(str::trim);
        if let Some(other) = bridge_env.filter(|v| !matches!(*v, "" | "0" | "1")) {
            log::warn!("[bridge] ignoring KOOKABURRA_BRIDGE={other:?} (use 0 or 1)");
        }
        let role = bridge_role(&RoleInputs {
            autorun: crate::is_autorun(),
            bridge_env,
            root_overridden: workspace::root_override().is_some(),
            bundle_id: &bundle_id,
            worktree_build: checkout.as_ref().is_some_and(|c| c.worktree),
        });
        log::info!(
            "[bridge] {} ({})",
            if role.serving {
                "serving"
            } else {
                "not serving"
            },
            role.reason.as_deref().unwrap_or("default")
        );
        Instance {
            identity: BridgeIdentity {
                pid: std::process::id(),
                bundle_id,
                build: build_name(),
                app_version: app.package_info().version.to_string(),
                exe_path: cli_exe(),
                started_at_ms: now_ms(),
                checkout,
            },
            role,
        }
    });
}

fn instance() -> Option<&'static Instance> {
    INSTANCE.get()
}

/// Whether this instance claims bridge requests (false until `init`).
pub(crate) fn serving() -> bool {
    instance().is_some_and(|i| i.role.serving)
}

/// `servedBy` on every answer: kb discards one whose root is not its project's.
pub(crate) fn served_by_value(identity: &BridgeIdentity, workspace_root: Option<&str>) -> Value {
    json!({
        "pid": identity.pid,
        "bundleId": identity.bundle_id,
        "build": identity.build,
        "appVersion": identity.app_version,
        "workspaceRoot": workspace_root,
    })
}

/// Add `servedBy` to a response object; a body that already names its server keeps it.
pub(crate) fn stamp_served_by(body: &mut Value, served_by: Option<&Value>) {
    if let (Some(object), Some(served_by)) = (body.as_object_mut(), served_by) {
        object
            .entry("servedBy")
            .or_insert_with(|| served_by.clone());
    }
}

pub(crate) fn own_served_by(app: &AppHandle) -> Option<Value> {
    let instance = instance()?;
    let (root, _) = effective_root(app, &app.state::<workspace::SettingsState>());
    Some(served_by_value(&instance.identity, root.as_deref()))
}

/// The same folder by device and inode, so case, symlinks and firmlinks (`/System/Volumes/Data`) never split one root.
pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.is_dir() && b.is_dir() && a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Whether this instance claims a request: one addressed to its pid; else one naming its workspace root; else (older kits) the native loop's project rule.
pub(crate) fn claimable(own_root: Option<&Path>, request: &BridgeRequest, own_pid: u32) -> bool {
    if let Some(pid) = request.instance_pid {
        return pid == own_pid;
    }
    if let Some(client) = request.workspace_root.as_deref() {
        return own_root.is_some_and(|own| same_dir(own, Path::new(client)));
    }
    native_claimable(own_root, request)
}

/// A live pid: `kill(pid, 0)` succeeds, or fails with EPERM (alive, owned by someone else).
pub(crate) fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// How an instance ranks for `app.json`: release over dev, then the earliest start, then the lowest pid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PrimaryRank {
    pub release: bool,
    pub started_at_ms: u64,
    pub pid: u32,
}

impl PrimaryRank {
    fn key(&self) -> (bool, u64, u32) {
        (!self.release, self.started_at_ms, self.pid)
    }

    fn outranks(&self, other: &PrimaryRank) -> bool {
        self.key() < other.key()
    }
}

/// Whether this serving instance (re)writes `app.json`: it is missing, unreadable, ours, stale, written by a dead or passive process, or by one that ranks below us. An older app without `startedAtMs` counts as the earliest, so the two never fight.
pub(crate) fn should_write_primary(
    current: Option<&Value>,
    ours: &PrimaryRank,
    now: u64,
    alive: impl Fn(u32) -> bool,
) -> bool {
    let Some(current) = current.and_then(Value::as_object) else {
        return true;
    };
    let Some(pid) = current
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|p| u32::try_from(p).ok())
    else {
        return true;
    };
    if pid == ours.pid {
        return true;
    }
    let updated = current
        .get("updatedAtMs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if now.saturating_sub(updated) > HEARTBEAT_FRESH_MS || !alive(pid) {
        return true;
    }
    if current.get("bridge").and_then(|b| b.get("serving")) == Some(&Value::Bool(false)) {
        return true;
    }
    let theirs = PrimaryRank {
        release: current.get("build").and_then(Value::as_str) == Some("release"),
        started_at_ms: current
            .get("startedAtMs")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pid,
    };
    ours.outranks(&theirs)
}

/// Remove other instances' heartbeats whose pid is dead or that are over 10 min old; leftover temp files go after 10 min too.
pub(crate) fn prune_instances(apps: &Path, own_pid: u32, now: u64, alive: impl Fn(u32) -> bool) {
    let Ok(entries) = std::fs::read_dir(apps) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let old = file_age_ms(&path) > INSTANCE_PRUNE_MS;
        let pid = name
            .strip_suffix(".json")
            .and_then(|stem| stem.parse::<u32>().ok());
        let remove = match pid {
            Some(pid) if pid == own_pid => false,
            Some(pid) => {
                let updated = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|body| body.get("updatedAtMs").and_then(Value::as_u64));
                !alive(pid)
                    || match updated {
                        Some(updated) => now.saturating_sub(updated) > INSTANCE_PRUNE_MS,
                        None => old,
                    }
            }
            None => old,
        };
        if remove {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The effective workspace root and where it came from: `env` (`KOOKABURRA_WORKSPACE_ROOT`), `settings` or `none`.
fn effective_root(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
) -> (Option<String>, &'static str) {
    if let Some(over) = workspace::root_override() {
        return (Some(over.to_string_lossy().into_owned()), "env");
    }
    match workspace::load_settings(app, settings)
        .ok()
        .and_then(|s| s.workspace_root)
    {
        Some(root) => (Some(root), "settings"),
        None => (None, "none"),
    }
}

/// This instance's identity, role and effective workspace root (the "not found" errors name it).
#[tauri::command]
pub fn bridge_instance(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
) -> Result<Value, String> {
    let instance = instance().ok_or("the bridge has not started yet")?;
    let (root, source) = effective_root(&app, &settings);
    let mut value = serde_json::to_value(&instance.identity).map_err(|e| e.to_string())?;
    value["bridge"] = serde_json::to_value(&instance.role).map_err(|e| e.to_string())?;
    value["workspaceRoot"] = json!(root);
    value["rootSource"] = json!(source);
    Ok(value)
}

/// What the heartbeat says about where this instance's workspace lives.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RootInfo {
    pub root: Option<String>,
    pub source: &'static str,
}

fn heartbeat_body(
    instance: &Instance,
    root: RootInfo,
    places: &HeartbeatPlaces,
    context: Option<&EditorContext>,
    last_load: Option<&LastLoad>,
    health: Option<Value>,
    now: u64,
) -> Heartbeat {
    let (identity, role) = (&instance.identity, &instance.role);
    Heartbeat {
        version: HEARTBEAT_VERSION,
        pid: identity.pid,
        started_at_ms: identity.started_at_ms,
        updated_at_ms: now,
        app_version: identity.app_version.clone(),
        build: identity.build,
        bundle_id: identity.bundle_id.clone(),
        exe_path: identity.exe_path.clone(),
        checkout: identity.checkout.clone(),
        workspace_root: root.root,
        root_source: root.source,
        bridge: role.clone(),
        primary: false,
        resources_dir: places.resources_dir.clone(),
        presets_dir: places.presets_dir.clone(),
        preset_previews_dir: places.preset_previews_dir.clone(),
        open_project: context.and_then(|c| c.project_id.clone()),
        aspect: context.map(|c| c.aspect.clone()),
        playhead_ms: context.map_or(0, |c| c.current_ms.max(0.0).round() as u64),
        exporting: context.is_some_and(|c| c.export_locked),
        playing: context.is_some_and(|c| c.playing),
        kinds: BRIDGE_KINDS,
        cli_path: places.cli_path.clone(),
        cli_version: CLI_VERSION,
        last_load: last_load.cloned(),
        export_job: crate::bridge_export::job_value(),
        health,
        picked_dirs: Vec::new(),
    }
}

/// `_bridge/cli.json`: kb's way to this binary's CLI while the app is closed.
pub(crate) fn cli_marker_body(path: &str, app_version: &str, now: u64) -> Value {
    json!({
        "path": path,
        "appVersion": app_version,
        "build": build_name(),
        "cli": CLI_VERSION,
        "writtenAtMs": now,
    })
}

fn cli_exe() -> Option<String> {
    std::env::current_exe().ok().map(path_text)
}

/// Written once per interactive launch and never removed, so a closed app still leaves kb a CLI to run.
fn write_cli_marker(app: &AppHandle) {
    let (Some(path), Ok(root)) = (cli_exe(), bridge_root(app)) else {
        return;
    };
    let body = cli_marker_body(&path, &app.package_info().version.to_string(), now_ms());
    let written = crate::privacy::private_dir(&root)
        .map_err(|e| e.to_string())
        .and_then(|()| serde_json::to_string_pretty(&body).map_err(|e| e.to_string()))
        .and_then(|text| write_atomic(&root.join(CLI_MARKER_FILE), &text));
    if let Err(e) = written {
        log::warn!("[bridge] cli.json write failed: {e}");
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
        cli_path: cli_exe(),
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Write `apps/<pid>.json`, and `app.json` too when `rank` (serving instances only) wins the primary election; `body.primary` records the outcome.
pub(crate) fn publish_heartbeat(
    bridge: &Path,
    body: &mut Heartbeat,
    rank: Option<PrimaryRank>,
    now: u64,
    alive: impl Fn(u32) -> bool,
) -> Result<(), String> {
    let apps = bridge.join(APPS_DIR);
    std::fs::create_dir_all(&apps).map_err(|e| e.to_string())?;
    body.primary = rank.is_some_and(|rank| {
        should_write_primary(
            read_json_file(&bridge.join(HEARTBEAT_FILE)).as_ref(),
            &rank,
            now,
            alive,
        )
    });
    let text = serde_json::to_string_pretty(body).map_err(|e| e.to_string())?;
    write_atomic(&apps.join(format!("{}.json", body.pid)), &text)?;
    if body.primary {
        write_atomic(&bridge.join(HEARTBEAT_FILE), &text)?;
    }
    Ok(())
}

/// This process's heartbeat files: its `apps/<pid>.json`, and `app.json` while it still names us.
pub(crate) fn remove_heartbeat_files(bridge: &Path, pid: u32) {
    let _ = std::fs::remove_file(bridge.join(APPS_DIR).join(format!("{pid}.json")));
    let path = bridge.join(HEARTBEAT_FILE);
    let ours = read_json_file(&path).and_then(|value| value.get("pid").and_then(Value::as_u64))
        == Some(u64::from(pid));
    if ours {
        let _ = std::fs::remove_file(path);
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

/// Rewrite this instance's heartbeat unless it was written under two seconds ago; interactive app only (a passive instance writes `apps/<pid>.json` and nothing else).
fn write_heartbeat(
    app: &AppHandle,
    heartbeat: &HeartbeatState,
    settings: &State<'_, workspace::SettingsState>,
    context: Option<&EditorContext>,
) {
    if crate::is_autorun() || HEARTBEAT_STOPPED.load(Ordering::Relaxed) {
        return;
    }
    let Some(instance) = instance() else {
        return;
    };
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
    let (root, source) = effective_root(app, settings);
    let serving = instance.role.serving;
    let health = if serving {
        crate::bridge_health::snapshot(app)
    } else {
        None
    };
    let mut body = heartbeat_body(
        instance,
        RootInfo { root, source },
        &places,
        context,
        last_load.as_ref(),
        health,
        now,
    );
    body.picked_dirs = app
        .state::<PickedFolders>()
        .list()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let Ok(bridge) = bridge_root(app) else {
        return;
    };
    let rank = serving.then(|| PrimaryRank {
        release: instance.identity.build == "release",
        started_at_ms: instance.identity.started_at_ms,
        pid: instance.identity.pid,
    });
    if let Err(e) = publish_heartbeat(&bridge, &mut body, rank, now, pid_alive) {
        log::warn!("[bridge] heartbeat write failed: {e}");
    }
}

/// Remove this process's heartbeat on exit; other instances' files are left alone.
pub fn remove_heartbeat(app: &AppHandle) {
    if crate::is_autorun() {
        return;
    }
    HEARTBEAT_STOPPED.store(true, Ordering::Relaxed);
    if let Ok(bridge) = bridge_root(app) {
        remove_heartbeat_files(&bridge, std::process::id());
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

/// Unclaimed requests for the render window: the editor's cheap pending probe (no claims). Native kinds and other instances' requests never count, so they never spawn (or keep alive) this instance's window.
#[tauri::command]
pub fn bridge_pending_count(app: AppHandle) -> Result<usize, String> {
    Ok(served_pending_count(&app))
}

/// The render-window requests this instance would claim; 0 when it does not serve.
pub(crate) fn served_pending_count(app: &AppHandle) -> usize {
    if !serving() {
        return 0;
    }
    let Ok(root) = bridge_root(app) else {
        return 0;
    };
    let own = own_workspace_root(app);
    render_pending_count(&root, true, own.as_deref(), std::process::id())
}

pub(crate) fn render_pending_count(
    root: &Path,
    serving: bool,
    own_root: Option<&Path>,
    pid: u32,
) -> usize {
    if !serving {
        return 0;
    }
    pending_routes(root)
        .iter()
        .filter(|(_, path, route)| !route.native() && pending_claimable(path, own_root, pid))
        .count()
}

/// The render-window requests this instance would claim, parsed and fresh, oldest first, each with its file age; empty when it does not serve.
pub(crate) fn served_pending(app: &AppHandle) -> Vec<(BridgeRequest, u64)> {
    if !serving() {
        return Vec::new();
    }
    let Ok(root) = bridge_root(app) else {
        return Vec::new();
    };
    let own = own_workspace_root(app);
    pending_claimable_requests(&root, own.as_deref(), std::process::id(), now_ms())
}

pub(crate) fn pending_claimable_requests(
    root: &Path,
    own_root: Option<&Path>,
    pid: u32,
    now: u64,
) -> Vec<(BridgeRequest, u64)> {
    pending_routes(root)
        .into_iter()
        .filter(|(_, _, route)| !route.native())
        .filter_map(|(_, path, _)| {
            let request = parse_request(&std::fs::read_to_string(&path).ok()?).ok()?;
            let age = file_age_ms(&path);
            (request_fresh(&request, age, now) && claimable(own_root, &request, pid))
                .then_some((request, age))
        })
        .collect()
}

/// An unreadable or unparseable request counts: the claim answers its error.
fn pending_claimable(path: &Path, own_root: Option<&Path>, pid: u32) -> bool {
    match std::fs::read_to_string(path).map(|text| parse_request(&text)) {
        Ok(Ok(request)) => claimable(own_root, &request, pid),
        _ => true,
    }
}

pub(crate) fn own_workspace_root(app: &AppHandle) -> Option<PathBuf> {
    effective_root(app, &app.state::<workspace::SettingsState>())
        .0
        .map(PathBuf::from)
}

/// What routes a request without parsing it whole: its kind, and a `debug` request's op and window.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(crate) struct RoutePeek {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub window: Option<String>,
}

impl RoutePeek {
    /// Served by the native loop: the native kinds, plus the `debug` ops that never need the render window (`contexts`, and a lose-context aimed at the editor).
    pub(crate) fn native(&self) -> bool {
        is_native_kind(self.kind.as_deref())
            || (self.kind.as_deref() == Some("debug")
                && (self.op.as_deref() == Some("contexts")
                    || self.window.as_deref() == Some("editor")))
    }
}

/// Request files with a valid id, oldest first, each with its `kind`; an unreadable or unparseable file reads as None, so the render window claims it and answers the error.
pub(crate) fn pending_requests(root: &Path) -> Vec<(String, PathBuf, Option<String>)> {
    pending_routes(root)
        .into_iter()
        .map(|(id, path, route)| (id, path, route.kind))
        .collect()
}

/// `pending_requests` with each file's routing fields.
pub(crate) fn pending_routes(root: &Path) -> Vec<(String, PathBuf, RoutePeek)> {
    let Ok(entries) = std::fs::read_dir(root.join("requests")) else {
        return Vec::new();
    };
    let mut pending: Vec<(String, PathBuf, RoutePeek)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_owned();
            if !valid_id(&id) {
                return None;
            }
            let route = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<RoutePeek>(&text).ok())
                .unwrap_or_default();
            Some((id, path, route))
        })
        .collect();
    // Lexicographic id order = oldest first (ids lead with a zero-padded timestamp).
    pending.sort_by(|a, b| a.0.cmp(&b.0));
    pending
}

pub(crate) fn is_native_kind(kind: Option<&str>) -> bool {
    kind.is_some_and(|kind| NATIVE_KINDS.contains(&kind))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `KOOKABURRA_BRIDGE_DIR` (tests only): an absolute path, else an error naming the value.
pub(crate) fn bridge_dir_override(raw: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Ok(Some(path))
    } else {
        Err(format!(
            "KOOKABURRA_BRIDGE_DIR must be an absolute path, got {raw:?}"
        ))
    }
}

fn bridge_dir_env() -> Option<&'static PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        bridge_dir_override(std::env::var("KOOKABURRA_BRIDGE_DIR").ok().as_deref()).unwrap_or_else(
            |e| {
                log::warn!("[bridge] {e}; using the default bridge folder");
                None
            },
        )
    })
    .as_ref()
}

/// Always beside `_autorun` under the fixed home location, unaffected by a relocated workspace root; `KOOKABURRA_BRIDGE_DIR` redirects it for tests.
pub(crate) fn bridge_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = bridge_dir_env() {
        return Ok(dir.clone());
    }
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

/// Every answer an agent reads passes through `clean_text` first: names and messages from project files are escaped and capped.
pub(crate) fn write_response_value(root: &Path, id: &str, body: &Value) -> Result<(), String> {
    let dir = root.join("responses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut body = body.clone();
    crate::clean_text::clean_value(&mut body);
    write_atomic(&dir.join(format!("{id}.json")), &body.to_string())
}

fn file_age_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map_or(0, |age| age.as_millis() as u64)
}

fn prune_dir(dir: &Path, ttl_ms: u64) {
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

/// Claim the oldest fresh request whose kind `wanted` accepts.
#[cfg(test)]
pub(crate) fn claim_next(
    root: &Path,
    wanted: impl Fn(Option<&str>) -> bool,
) -> Result<Option<BridgeRequest>, String> {
    claim_next_served(
        root,
        |route| wanted(route.kind.as_deref()),
        |_| true,
        || None,
    )
}

/// A fresh request this instance could claim, before the claim.
pub(crate) struct PendingClaim {
    pub id: String,
    pub path: PathBuf,
    pub request: BridgeRequest,
}

/// Claim the oldest fresh request whose route `wanted` accepts and that `serves` accepts once parsed (a declined one stays for another app instance): renamed into `.claimed/` before anything serves it, so two pollers (ticks, windows or app instances) never serve one file and the loser skips it. Stale requests are deleted and unparseable ones answered (with `served_by`). Serving instances only.
pub(crate) fn claim_next_served(
    root: &Path,
    wanted: impl Fn(&RoutePeek) -> bool,
    serves: impl Fn(&BridgeRequest) -> bool,
    served_by: impl Fn() -> Option<Value>,
) -> Result<Option<BridgeRequest>, String> {
    claim_next_ordered(root, wanted, serves, served_by, |_| {})
}

/// `claim_next_served` with the candidates (oldest first) reordered or filtered by `order` before the first claim attempt.
pub(crate) fn claim_next_ordered(
    root: &Path,
    wanted: impl Fn(&RoutePeek) -> bool,
    serves: impl Fn(&BridgeRequest) -> bool,
    served_by: impl Fn() -> Option<Value>,
    order: impl FnOnce(&mut Vec<PendingClaim>),
) -> Result<Option<BridgeRequest>, String> {
    let requests = root.join("requests");
    let now = now_ms();
    let mut candidates: Vec<PendingClaim> = Vec::new();
    for (id, path, route) in pending_routes(root) {
        if !wanted(&route) {
            continue;
        }
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
                let mut body = json!({ "version": 2, "id": id, "ok": false, "error": error });
                stamp_served_by(&mut body, served_by().as_ref());
                let _ = write_response_value(root, &id, &body);
                continue;
            }
        };
        if !request_fresh(&request, age_ms, now) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if !serves(&request) {
            continue;
        }
        candidates.push(PendingClaim { id, path, request });
    }
    order(&mut candidates);
    for PendingClaim { id, path, request } in candidates {
        let claimed = requests.join(".claimed");
        std::fs::create_dir_all(&claimed).map_err(|e| e.to_string())?;
        match std::fs::rename(&path, claimed.join(format!("{id}.json"))) {
            Ok(()) => return Ok(Some(request)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(None)
}

/// Whether a pending request file is still worth serving; an unparseable one keeps the 120 s rule.
fn request_file_fresh(path: &Path, now: u64) -> bool {
    let age = file_age_ms(path);
    match std::fs::read_to_string(path).map(|text| parse_request(&text)) {
        Ok(Ok(request)) => request_fresh(&request, age, now),
        _ => age <= STALE_REQUEST_MS,
    }
}

/// Old responses (owner only, `capture_service`) and claimed requests, other instances' dead or old heartbeats, and stale requests whichever instance they were for (their client gave up); serving instances only.
fn prune_bridge(root: &Path, own_pid: u32) {
    crate::capture_service::maybe_prune_responses(root, own_pid);
    prune_dir(&root.join("requests").join(".claimed"), RESPONSE_TTL_MS);
    prune_instances(&root.join(APPS_DIR), own_pid, now_ms(), pid_alive);
    let now = now_ms();
    for (_, path, _) in pending_requests(root) {
        if !request_file_fresh(&path, now) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The render window's claim for this instance: nothing unless it serves; native kinds stay for the native loop, other instances' requests stay for them.
#[cfg(test)]
pub(crate) fn claim_render_request(
    root: &Path,
    serving: bool,
    own_root: Option<&Path>,
    pid: u32,
    served_by: impl Fn() -> Option<Value>,
) -> Result<Option<BridgeRequest>, String> {
    claim_render_request_ordered(root, serving, own_root, pid, served_by, |_| {})
}

/// `claim_render_request` in `order` (the capture service's fair queue).
pub(crate) fn claim_render_request_ordered(
    root: &Path,
    serving: bool,
    own_root: Option<&Path>,
    pid: u32,
    served_by: impl Fn() -> Option<Value>,
    order: impl FnOnce(&mut Vec<PendingClaim>),
) -> Result<Option<BridgeRequest>, String> {
    if !serving {
        return Ok(None);
    }
    prune_bridge(root, pid);
    claim_next_ordered(
        root,
        |route| !route.native(),
        |request| claimable(own_root, request, pid),
        served_by,
        order,
    )
}

/// The render window's claim: the next pending request this instance serves, in the capture service's fair order; old responses are pruned. `None` = nothing to serve.
#[tauri::command]
pub fn bridge_claim_request(app: AppHandle) -> Result<Option<BridgeRequest>, String> {
    if !serving() {
        return Ok(None);
    }
    let root = bridge_root(&app)?;
    let own = own_workspace_root(&app);
    let claimed = claim_render_request_ordered(
        &root,
        true,
        own.as_deref(),
        std::process::id(),
        || own_served_by(&app),
        |pending| crate::capture_service::order_claims(&app, pending),
    )?;
    if let Some(request) = &claimed {
        crate::capture_service::on_claim(&app, request);
    }
    Ok(claimed)
}

/// The render window's check before each frame: the client still waits (`.claimed/<id>.json` exists and its deadline has not passed) and no export started. `frame` reports progress for the queue's estimate.
#[tauri::command]
pub fn bridge_request_live(
    app: AppHandle,
    id: String,
    frame: Option<u32>,
) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err(format!("invalid bridge id {id:?}"));
    }
    if let Some(frame) = frame {
        crate::capture_service::note_progress(&id, frame);
    }
    let claimed = bridge_root(&app)?
        .join("requests")
        .join(".claimed")
        .join(format!("{id}.json"));
    let export_locked = editor_context(&app).is_some_and(|c| c.export_locked);
    Ok(request_liveness(&claimed, export_locked, now_ms()))
}

pub(crate) fn request_liveness(claimed: &Path, export_locked: bool, now: u64) -> Value {
    let Ok(text) = std::fs::read_to_string(claimed) else {
        return json!({ "live": false, "reason": "cancelled" });
    };
    if let Ok(request) = parse_request(&text) {
        let gone = request.deadline_at_ms.is_some()
            && now > request_deadline(&request, file_age_ms(claimed), now);
        if gone {
            return json!({ "live": false, "reason": "cancelled" });
        }
    }
    if export_locked {
        return json!({ "live": false, "reason": "busy" });
    }
    json!({ "live": true })
}

/// A render-window answer with `servedBy` added (the window never sets it).
pub(crate) fn stamped_body(json_text: &str, served_by: Option<&Value>) -> Result<Value, String> {
    let mut body = serde_json::from_str::<Value>(json_text)
        .map_err(|e| format!("bridge response isn't valid JSON: {e}"))?;
    stamp_served_by(&mut body, served_by);
    Ok(body)
}

#[cfg(test)]
pub(crate) fn stamped_response(
    json_text: &str,
    served_by: Option<&Value>,
) -> Result<String, String> {
    stamped_body(json_text, served_by).map(|body| body.to_string())
}

/// Answer one claimed request (atomic tmp + rename; the client polls for this file).
#[tauri::command]
pub fn bridge_write_response(app: AppHandle, id: String, json_text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("invalid bridge id {id:?}"));
    }
    let mut body = stamped_body(&json_text, own_served_by(&app).as_ref())?;
    if !crate::capture_service::on_response(&app, &id, &mut body) {
        return Ok(());
    }
    write_response_value(&bridge_root(&app)?, &id, &body)
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

// ── Native kinds ───────────────────────────────────────────────────────────

/// Claim and serve the native kinds from Rust, never the render window: poll `requests/` every 300 ms, oldest first, claiming only what `claimable` gives this instance, each served on the async runtime. Writes `_bridge/cli.json` first; serving interactive instances only, and it stops with the heartbeat.
pub fn spawn_native_bridge(app: AppHandle) {
    if crate::is_autorun() || !serving() {
        return;
    }
    write_cli_marker(&app);
    let Ok(root) = bridge_root(&app) else {
        return;
    };
    let pid = std::process::id();
    std::thread::spawn(move || {
        let mut pruned: Option<Instant> = None;
        loop {
            std::thread::sleep(NATIVE_POLL);
            if HEARTBEAT_STOPPED.load(Ordering::Relaxed) {
                return;
            }
            // Resolved at most once a tick, and only when a fresh native request needs it.
            let own_root = OnceCell::new();
            let serves = |request: &BridgeRequest| {
                let ours = own_root.get_or_init(|| own_workspace_root(&app));
                claimable(ours.as_deref(), request, pid)
            };
            loop {
                match claim_next_served(&root, RoutePeek::native, serves, || own_served_by(&app)) {
                    Ok(Some(request)) => {
                        let app = app.clone();
                        let root = root.clone();
                        tauri::async_runtime::spawn(async move {
                            serve_native(&app, &root, request).await;
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("[bridge] native claim failed: {e}");
                        break;
                    }
                }
            }
            let waiting = crate::capture_service::triage(&app, &root, pid);
            let thumbs = crate::render_win::thumbs_pending_count(app.state(), app.state());
            crate::capture_service::watchdog(&app, waiting + thumbs);
            // The render window prunes on every claim, but it may never open in a session that only edits videos.
            if pruned.map_or(true, |at| at.elapsed() >= Duration::from_secs(60)) {
                prune_bridge(&root, pid);
                pruned = Some(Instant::now());
            }
        }
    });
}

/// A native kind's answer: its payload or error, the envelope fields and `servedBy`.
pub(crate) fn native_response_body(
    id: &str,
    served: Result<Value, String>,
    served_by: Option<&Value>,
) -> Value {
    let mut body = served.unwrap_or_else(|error| json!({ "ok": false, "error": error }));
    body["version"] = json!(2);
    body["id"] = json!(id);
    stamp_served_by(&mut body, served_by);
    body
}

async fn serve_native(app: &AppHandle, root: &Path, request: BridgeRequest) {
    let served = match request.kind.as_deref() {
        Some("mediaChanged") => serve_media_changed(app, &request).await,
        Some("openEdit") => serve_open_edit(app, &request).await,
        Some("debug") => serve_debug(app, &request),
        Some("export" | "cancelExport") => crate::bridge_export::serve(app, root, &request).await,
        other => Err(format!("{other:?} isn't a native bridge kind")),
    };
    let body = native_response_body(&request.id, served, own_served_by(app).as_ref());
    if let Err(e) = write_response_value(root, &request.id, &body) {
        log::warn!("[bridge] response write failed: {e}");
    }
}

fn busy(error: &str) -> Value {
    json!({ "ok": false, "busy": true, "error": error })
}

fn editor_context(app: &AppHandle) -> Option<EditorContext> {
    app.state::<EditorContextState>()
        .0
        .lock()
        .ok()
        .and_then(|c| c.clone())
}

/// The slug of a `ws:<slug>` project id; anything else is not a workspace project.
pub(crate) fn workspace_slug(project: Option<&str>) -> Option<&str> {
    let slug = project?.strip_prefix("ws:")?;
    workspace::validate_slug(slug).ok().map(|()| slug)
}

/// The folder must hold a project, and when the client names its folder, the same one (canonical paths).
pub(crate) fn check_project_dir(dir: &Path, client: Option<&str>) -> Result<(), String> {
    if !dir.join(workspace::MANIFEST_FILENAME).is_file() {
        return Err(format!("there is no project at {}", dir.display()));
    }
    let Some(client) = client else {
        return Ok(());
    };
    if !Path::new(client).exists() {
        return Err(format!("projectPath {client} doesn't exist"));
    }
    if same_dir(dir, Path::new(client)) {
        Ok(())
    } else {
        Err(format!(
            "the app's workspace has this project at {}, not {client}; open the project the app knows, or point the app at this workspace",
            path_text(dir.to_path_buf())
        ))
    }
}

/// The older kits' rule (requests without `instancePid` or `workspaceRoot`): only a request naming a project under this instance's own workspace root, so two running apps never answer each other's. A request no instance could serve (no `ws:<slug>`, or a `projectPath` that doesn't exist) is claimed to answer its error.
pub(crate) fn native_claimable(workspace: Option<&Path>, request: &BridgeRequest) -> bool {
    let Some(slug) = workspace_slug(request.project.as_deref()) else {
        return true;
    };
    let client = request.project_path.as_deref().map(Path::new);
    if client.is_some_and(|client| !client.exists()) {
        return true;
    }
    let Some(workspace) = workspace else {
        return false;
    };
    let dir = workspace.join(slug);
    match client {
        Some(client) => same_dir(&dir, client),
        None => dir.is_dir(),
    }
}

/// The workspace project a native request names, as (slug, folder).
fn native_project(app: &AppHandle, request: &BridgeRequest) -> Result<(String, PathBuf), String> {
    let kind = request.kind.as_deref().unwrap_or("this request");
    let slug = workspace_slug(request.project.as_deref())
        .ok_or_else(|| format!("{kind} needs a workspace project (ws:<folder>)"))?
        .to_owned();
    let settings = app.state::<workspace::SettingsState>();
    let dir = workspace::project_dir(app, &settings, &slug)?;
    check_project_dir(&dir, request.project_path.as_deref())?;
    Ok((slug, dir))
}

/// `mediaChanged` paths after validation: every path cleaned and deduplicated in order, the files to warm, and the ones not on disk. A path outside `assets/` fails the whole request.
#[derive(Debug, PartialEq)]
pub(crate) struct MediaPaths {
    pub paths: Vec<String>,
    pub existing: Vec<(String, PathBuf)>,
    pub missing: Vec<String>,
}

pub(crate) fn media_changed_paths(dir: &Path, paths: &[String]) -> Result<MediaPaths, String> {
    if paths.is_empty() {
        return Err("mediaChanged needs paths (project-relative, under assets/)".into());
    }
    if paths.len() > MAX_MEDIA_PATHS {
        return Err(format!(
            "mediaChanged takes at most {MAX_MEDIA_PATHS} paths (got {})",
            paths.len()
        ));
    }
    let mut out = MediaPaths {
        paths: Vec::new(),
        existing: Vec::new(),
        missing: Vec::new(),
    };
    for raw in paths {
        let abs = media::resolve_asset_in(dir, raw)?;
        let rel = raw.trim_start_matches("./").to_owned();
        if out.paths.contains(&rel) {
            continue;
        }
        out.paths.push(rel.clone());
        if abs.is_file() {
            out.existing.push((rel, abs));
        } else {
            out.missing.push(rel);
        }
    }
    Ok(out)
}

fn edit_name(raw: Option<&str>, what: &str) -> Result<Option<String>, String> {
    let Some(name) = raw.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    workspace::validate_slug(name).map_err(|_| format!("invalid {what} {name:?}"))?;
    Ok(Some(name.to_owned()))
}

/// Warm the media cache for changed files and tell every window (contract: never busy; while exporting the warm-up waits for the next view and the answer says `deferred`).
async fn serve_media_changed(app: &AppHandle, request: &BridgeRequest) -> Result<Value, String> {
    let (slug, dir) = native_project(app, request)?;
    let edit = edit_name(request.edit.as_deref(), "edit name")?;
    let plan = media_changed_paths(&dir, request.paths.as_deref().unwrap_or_default())?;
    let deferred = editor_context(app).is_some_and(|c| c.export_locked);
    let mut warmed = Vec::new();
    if !deferred {
        for (rel, abs) in &plan.existing {
            match media::ensure_media_cache(app, abs, rel).await {
                Ok(_) => warmed.push(rel.clone()),
                Err(e) => log::warn!("[bridge] mediaChanged couldn't warm {rel}: {e}"),
            }
        }
    }
    // No `name`: an agent's render must never consume a re-point the editor armed.
    app.emit(
        "kookaburra://media-changed",
        json!({ "slug": slug, "paths": plan.paths, "edit": edit, "origin": "agent" }),
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "project": format!("ws:{slug}"),
        "paths": plan.paths,
        "warmed": warmed,
        "missing": plan.missing,
        "deferred": deferred,
    }))
}

/// A scene selector (index or file stem) as a manifest index.
pub(crate) fn scene_index(manifest: &Value, selector: &str) -> Option<usize> {
    let scenes = manifest.get("scenes")?.as_array()?;
    if let Ok(index) = selector.parse::<usize>() {
        return (index < scenes.len()).then_some(index);
    }
    scenes.iter().position(|scene| {
        scene
            .as_str()
            .or_else(|| scene.get("file").and_then(Value::as_str))
            .and_then(|file| Path::new(file).file_stem())
            .and_then(|stem| stem.to_str())
            == Some(selector)
    })
}

/// What opening (slug, name) does to the editor window: an existing window already on it only takes focus, since re-sending the target resets the editor's UI.
pub(crate) fn open_kind(window_exists: bool, targeted: bool) -> &'static str {
    match (window_exists, targeted) {
        (true, true) => "focused",
        (true, false) => "retargeted",
        (false, _) => "created",
    }
}

/// Main thread only (window creation).
fn open_or_focus(
    app: &AppHandle,
    slug: String,
    name: String,
    scene: Option<usize>,
) -> Result<&'static str, String> {
    let window = app.get_webview_window("editor");
    let targeted = app
        .state::<crate::edit::EditorState>()
        .0
        .lock()
        .ok()
        .and_then(|t| t.as_ref().map(|t| t.slug == slug && t.name == name))
        .unwrap_or(false);
    let opened = open_kind(window.is_some(), targeted);
    match window {
        Some(win) if opened == "focused" => {
            let _ = win.unminimize();
            win.set_focus().map_err(|e| e.to_string())?;
        }
        _ => {
            crate::edit::open_edit_named(app.clone(), app.state(), app.state(), slug, name, scene)?;
        }
    }
    Ok(opened)
}

/// Open the video editor on an existing edit of any workspace project (busy while exporting or while the editor renders another edit).
async fn serve_open_edit(app: &AppHandle, request: &BridgeRequest) -> Result<Value, String> {
    let (slug, dir) = native_project(app, request)?;
    let name =
        edit_name(request.name.as_deref(), "edit name")?.ok_or("openEdit needs the edit's name")?;
    let (handle, s, client) = (app.clone(), slug.clone(), request.client.clone());
    let allowed = tauri::async_runtime::spawn_blocking(move || {
        confirm_project_access(&handle, &s, "openEdit", client.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;
    if !allowed {
        return Err(access_refused(&slug, "openEdit"));
    }
    let context = editor_context(app);
    if context.as_ref().is_some_and(|c| c.export_locked) {
        return Ok(busy("Kookaburra Cut is exporting right now; retry shortly"));
    }
    if let Some((rs, rn)) = crate::edit::rendering_edit(app) {
        if rs != slug || rn != name {
            return Ok(busy(&format!(
                "the video editor is rendering {rn}; retry once it finishes"
            )));
        }
    }
    let scene = match request.scene.as_deref() {
        None => None,
        Some(selector) => {
            let manifest = std::fs::read_to_string(dir.join(workspace::MANIFEST_FILENAME))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .unwrap_or(Value::Null);
            Some(
                scene_index(&manifest, selector)
                    .ok_or_else(|| format!("this project has no scene {selector:?}"))?,
            )
        }
    };
    let project_id = format!("ws:{slug}");
    let project_open = context.and_then(|c| c.project_id).as_deref() == Some(project_id.as_str());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let (s, n) = (slug.clone(), name.clone());
    app.run_on_main_thread(move || {
        let _ = sender.send(open_or_focus(&handle, s, n, scene));
    })
    .map_err(|e| e.to_string())?;
    let opened = tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "opening the editor timed out".to_owned())?
        .map_err(|_| "opening the editor was cancelled".to_owned())??;
    Ok(json!({
        "ok": true,
        "project": project_id,
        "name": name,
        "opened": opened,
        "projectOpen": project_open,
    }))
}

/// The native `debug` ops: every window's WebGL census, and (dev builds) a forced loss of the editor's stage canvas. The render window serves `lose-context` on itself.
fn serve_debug(app: &AppHandle, request: &BridgeRequest) -> Result<Value, String> {
    match (request.op.as_deref(), request.window.as_deref()) {
        (Some("contexts"), _) => Ok(crate::capture_service::contexts_report(app)),
        (Some("lose-context"), Some("editor")) => {
            if !cfg!(debug_assertions) {
                return Err("lose-context on the editor works only in dev builds; use --window render".into());
            }
            app.emit_to("main", "kookaburra://debug-lose-context", json!({ "window": "editor" }))
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "op": "lose-context", "window": "editor", "lost": true }))
        }
        (op, window) => Err(format!(
            "unknown debug op {op:?} for window {window:?}; this app serves contexts and lose-context"
        )),
    }
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
        let request = parse_request(
            r#"{"id":"abc","kind":"fonts","listFamilies":true,"projectPath":"/Users/x/Kookaburra Cut/demo","paths":["assets/a.mp4"],"edit":"a"}"#,
        )
        .unwrap();
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["listFamilies"], true);
        assert_eq!(value["requestedAtMs"], 0);
        assert_eq!(value["kind"], "fonts");
        assert_eq!(value["projectPath"], "/Users/x/Kookaburra Cut/demo");
        assert_eq!(value["paths"], json!(["assets/a.mp4"]));
        assert_eq!(value["edit"], "a");
    }

    #[test]
    fn native_requests_carry_their_fields() {
        let media = parse_request(
            r#"{ "version": 2, "id": "0001-1-a", "kind": "mediaChanged", "project": "ws:demo",
              "projectPath": "/Users/x/Kookaburra Cut/demo", "paths": ["assets/clip-edited.mp4"], "edit": "clip" }"#,
        )
        .unwrap();
        assert_eq!(
            media.project_path.as_deref(),
            Some("/Users/x/Kookaburra Cut/demo")
        );
        assert_eq!(
            media.paths.unwrap(),
            vec!["assets/clip-edited.mp4".to_string()]
        );
        assert_eq!(media.edit.as_deref(), Some("clip"));
        let open = parse_request(
            r#"{ "version": 2, "id": "0001-1-b", "kind": "openEdit", "project": "ws:demo", "name": "clip", "scene": 2 }"#,
        )
        .unwrap();
        assert_eq!(open.name.as_deref(), Some("clip"));
        assert_eq!(open.scene.as_deref(), Some("2"));
        assert_eq!(
            (open.paths, open.edit, open.project_path),
            (None, None, None)
        );
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
            available_devices: vec![],
        };
        let places = HeartbeatPlaces {
            resources_dir: Some("/Applications/Kookaburra Cut.app/Contents/Resources".into()),
            presets_dir: Some("/x/presets".into()),
            preset_previews_dir: Some("/x/preset-previews".into()),
            cli_path: Some("/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut".into()),
        };
        let instance = test_instance(87186, "release", true);
        let body = heartbeat_body(
            &instance,
            RootInfo {
                root: Some("/Users/x/Kookaburra Cut".into()),
                source: "settings",
            },
            &places,
            Some(&context),
            Some(&load),
            None,
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
                "bridge",
                "build",
                "bundleId",
                "checkout",
                "cliPath",
                "cliVersion",
                "exePath",
                "exportJob",
                "exporting",
                "health",
                "kinds",
                "lastLoad",
                "openProject",
                "pickedDirs",
                "pid",
                "playheadMs",
                "playing",
                "presetPreviewsDir",
                "presetsDir",
                "primary",
                "resourcesDir",
                "rootSource",
                "startedAtMs",
                "updatedAtMs",
                "version",
                "workspaceRoot",
            ]
        );
        assert_eq!(value["version"], 3);
        assert_eq!(value["pid"], 87186);
        assert_eq!(value["startedAtMs"], 1_792_019_000_000u64);
        assert_eq!(value["bundleId"], "com.mpalmes.kookaburracut");
        assert_eq!(value["build"], "release");
        assert_eq!(value["rootSource"], "settings");
        assert_eq!(value["bridge"], json!({ "serving": true, "reason": null }));
        assert_eq!(value["primary"], false);
        assert_eq!(value["checkout"], Value::Null);
        assert_eq!(value["health"], Value::Null);
        assert_eq!(value["exportJob"], Value::Null);
        assert_eq!(value["playheadMs"], 61_000);
        assert_eq!(value["openProject"], "ws:product-tour");
        assert_eq!(
            value["kinds"],
            json!([
                "capture",
                "check",
                "fonts",
                "insertPreset",
                "mediaChanged",
                "openEdit",
                "debug",
                "export",
                "cancelExport"
            ])
        );
        assert_eq!(
            value["cliPath"],
            "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut"
        );
        assert_eq!(value["cliVersion"], 1);
        assert_eq!(
            value["lastLoad"],
            json!({
                "project": "ws:product-tour", "ok": true, "atMs": 1_792_019_990_000u64, "error": null,
                "sceneErrors": [{ "index": 12, "file": "scenes/224-x.tsx", "phase": "compile", "message": "line 4" }],
                "fontIssues": [{ "ref": "Menlo@400", "message": "unknown cmap table format 6", "fallback": "Inter@400" }],
                "warnings": []
            })
        );
        let passive = test_instance(91234, "dev", false);
        let welcome = serde_json::to_value(heartbeat_body(
            &passive,
            RootInfo {
                root: None,
                source: "none",
            },
            &places,
            None,
            None,
            Some(json!({ "version": 1 })),
            1,
        ))
        .unwrap();
        assert_eq!(welcome["openProject"], Value::Null);
        assert_eq!(welcome["lastLoad"], Value::Null);
        assert_eq!(welcome["workspaceRoot"], Value::Null);
        assert_eq!(welcome["rootSource"], "none");
        assert_eq!(
            welcome["bridge"],
            json!({ "serving": false, "reason": "workspace root overridden by KOOKABURRA_WORKSPACE_ROOT" })
        );
        assert_eq!(
            welcome["checkout"],
            json!({ "path": "/Users/x/kookaburra-cut", "worktree": true })
        );
        assert_eq!(welcome["health"], json!({ "version": 1 }));
    }

    #[test]
    fn last_load_accepts_absent_diagnostics() {
        let load: LastLoad = serde_json::from_value(json!({
            "project": "ws:x", "ok": false, "atMs": 1, "error": "boom"
        }))
        .unwrap();
        assert!(load.scene_errors.is_empty() && load.font_issues.is_empty());
        assert!(load.available_devices.is_empty());
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
    fn every_native_kind_is_a_served_kind() {
        assert!(NATIVE_KINDS.iter().all(|kind| BRIDGE_KINDS.contains(kind)));
        assert!(is_native_kind(Some("openEdit")) && is_native_kind(Some("mediaChanged")));
        assert!(!is_native_kind(Some("capture")) && !is_native_kind(None));
    }

    #[test]
    fn the_cli_marker_has_the_contract_shape() {
        let body = cli_marker_body("/x/kookaburra-cut", "0.19.0", 7);
        assert_eq!(
            body,
            json!({ "path": "/x/kookaburra-cut", "appVersion": "0.19.0", "build": build_name(), "cli": 1, "writtenAtMs": 7 })
        );
    }

    fn queue(root: &Path, id: &str, body: &str) -> PathBuf {
        let dir = root.join("requests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.json"));
        std::fs::write(&path, body).unwrap();
        path
    }

    fn request_body(id: &str, kind: Option<&str>) -> String {
        let mut body = json!({ "version": 2, "id": id, "requestedAtMs": now_ms() });
        if let Some(kind) = kind {
            body["kind"] = json!(kind);
        }
        body.to_string()
    }

    #[test]
    fn the_render_window_never_counts_or_claims_native_kinds() {
        let root = scratch("render-claim");
        let native = queue(
            &root,
            "0001-1-a",
            &request_body("0001-1-a", Some("openEdit")),
        );
        queue(
            &root,
            "0002-1-b",
            &request_body("0002-1-b", Some("mediaChanged")),
        );
        queue(
            &root,
            "0003-1-c",
            &request_body("0003-1-c", Some("capture")),
        );
        queue(&root, "0004-1-d", &request_body("0004-1-d", None));
        queue(&root, ".0005-1-e", &request_body("0005-1-e", None));
        assert_eq!(pending_requests(&root).len(), 4);
        assert_eq!(render_pending_count(&root, true, None, 1), 2);
        let wanted = |kind: Option<&str>| !is_native_kind(kind);
        assert_eq!(claim_next(&root, wanted).unwrap().unwrap().id, "0003-1-c");
        assert_eq!(claim_next(&root, wanted).unwrap().unwrap().id, "0004-1-d");
        assert_eq!(claim_next(&root, wanted).unwrap(), None);
        assert!(native.is_file());
        assert_eq!(render_pending_count(&root, true, None, 1), 0);
        assert!(root.join("requests/.claimed/0003-1-c.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_native_loop_claims_only_its_kinds_oldest_first() {
        let root = scratch("native-claim");
        queue(
            &root,
            "0003-1-c",
            &request_body("0003-1-c", Some("openEdit")),
        );
        let capture = queue(
            &root,
            "0001-1-a",
            &request_body("0001-1-a", Some("capture")),
        );
        queue(
            &root,
            "0002-1-b",
            &request_body("0002-1-b", Some("mediaChanged")),
        );
        let first = claim_next(&root, is_native_kind).unwrap().unwrap();
        assert_eq!(
            (first.id.as_str(), first.kind.as_deref()),
            ("0002-1-b", Some("mediaChanged"))
        );
        let second = claim_next(&root, is_native_kind).unwrap().unwrap();
        assert_eq!(
            (second.id.as_str(), second.kind.as_deref()),
            ("0003-1-c", Some("openEdit"))
        );
        assert_eq!(claim_next(&root, is_native_kind).unwrap(), None);
        assert!(capture.is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn native_claims_drop_stale_requests_and_answer_broken_ones() {
        let root = scratch("native-stale");
        let stale = queue(
            &root,
            "0001-1-a",
            &json!({ "id": "0001-1-a", "kind": "openEdit", "requestedAtMs": 1 }).to_string(),
        );
        queue(
            &root,
            "0002-1-b",
            r#"{ "id": "0002-1-b", "kind": "mediaChanged", "scene": ["x"] }"#,
        );
        assert_eq!(claim_next(&root, is_native_kind).unwrap(), None);
        assert!(!stale.exists());
        let answer: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("responses/0002-1-b.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(answer["ok"], false);
        assert!(answer["error"].as_str().unwrap().contains("scene must be"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn native_request(id: &str, project: &str, project_path: Option<&Path>) -> String {
        let mut body = json!({
            "version": 2, "id": id, "kind": "mediaChanged", "project": project,
            "requestedAtMs": now_ms(), "paths": ["assets/a.mp4"],
        });
        if let Some(path) = project_path {
            body["projectPath"] = json!(path.to_str().unwrap());
        }
        body.to_string()
    }

    #[test]
    fn each_instance_claims_only_requests_for_its_own_workspace() {
        let root = scratch("native-instances");
        let (ours, theirs) = (root.join("ours"), root.join("theirs"));
        std::fs::create_dir_all(ours.join("demo")).unwrap();
        std::fs::create_dir_all(theirs.join("demo")).unwrap();
        std::fs::create_dir_all(theirs.join("only-theirs")).unwrap();
        let bridge = root.join("bridge");
        let foreign = queue(
            &bridge,
            "0001-1-a",
            &native_request("0001-1-a", "ws:demo", Some(&theirs.join("demo"))),
        );
        let unknown = queue(
            &bridge,
            "0002-1-b",
            &native_request("0002-1-b", "ws:only-theirs", None),
        );
        queue(
            &bridge,
            "0003-1-c",
            &native_request("0003-1-c", "ws:demo", Some(&ours.join("../ours/demo"))),
        );
        queue(
            &bridge,
            "0004-1-d",
            &native_request("0004-1-d", "ws:demo", None),
        );
        let claim = |workspace: &Path| {
            claim_next_served(
                &bridge,
                RoutePeek::native,
                |r| claimable(Some(workspace), r, 1),
                || None,
            )
            .unwrap()
            .map(|r| r.id)
        };
        assert_eq!(claim(&ours).as_deref(), Some("0003-1-c"));
        assert_eq!(claim(&ours).as_deref(), Some("0004-1-d"));
        assert_eq!(claim(&ours), None);
        assert!(foreign.is_file() && unknown.is_file());
        assert!(!bridge.join("responses").exists());
        assert_eq!(claim(&theirs).as_deref(), Some("0001-1-a"));
        assert_eq!(claim(&theirs).as_deref(), Some("0002-1-b"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn requests_no_instance_can_serve_are_claimed_and_stale_ones_still_dropped() {
        let root = scratch("native-unservable");
        let ours = root.join("ours");
        std::fs::create_dir_all(ours.join("demo")).unwrap();
        let claimable = |project: &str, path: Option<&Path>, workspace: Option<&Path>| {
            native_claimable(
                workspace,
                &parse_request(&native_request("0001-1-a", project, path)).unwrap(),
            )
        };
        for bad in ["demo", "ws:../x", "template:demo"] {
            assert!(claimable(bad, None, Some(ours.as_path())), "{bad}");
        }
        assert!(claimable(
            "ws:demo",
            Some(&root.join("gone")),
            Some(ours.as_path())
        ));
        assert!(!claimable("ws:demo", None, None));
        assert!(!claimable("ws:missing", None, Some(ours.as_path())));
        let stale = queue(
            &root,
            "0001-1-a",
            &json!({ "id": "0001-1-a", "kind": "openEdit", "project": "ws:missing", "requestedAtMs": 1 })
                .to_string(),
        );
        let none = claim_next_served(
            &root,
            RoutePeek::native,
            |r| native_claimable(Some(ours.as_path()), r),
            || None,
        );
        assert_eq!(none.unwrap(), None);
        assert!(!stale.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn native_requests_name_a_workspace_project() {
        assert_eq!(workspace_slug(Some("ws:demo")), Some("demo"));
        for bad in ["demo", "ws:", "ws:../x", "template:demo", "ws:a/b"] {
            assert_eq!(workspace_slug(Some(bad)), None, "{bad}");
        }
        assert_eq!(workspace_slug(None), None);
        let root = scratch("project-dir");
        let dir = root.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check_project_dir(&dir, None)
            .unwrap_err()
            .contains("no project"));
        std::fs::write(dir.join(workspace::MANIFEST_FILENAME), "{}").unwrap();
        assert_eq!(check_project_dir(&dir, None), Ok(()));
        let spelled = root.join("demo/../demo");
        assert_eq!(check_project_dir(&dir, spelled.to_str()), Ok(()));
        std::fs::create_dir_all(root.join("other")).unwrap();
        assert!(check_project_dir(&dir, root.join("other").to_str())
            .unwrap_err()
            .contains("not "));
        assert!(check_project_dir(&dir, Some("/nope/x"))
            .unwrap_err()
            .contains("doesn't exist"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_changed_paths_stay_inside_assets() {
        let dir = scratch("media-paths");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/clip-edited.mp4"), b"mp4").unwrap();
        let owned = |paths: &[&str]| paths.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let plan = media_changed_paths(
            &dir,
            &owned(&[
                "./assets/clip-edited.mp4",
                "assets/gone.mp4",
                "assets/clip-edited.mp4",
            ]),
        )
        .unwrap();
        assert_eq!(
            plan.paths,
            owned(&["assets/clip-edited.mp4", "assets/gone.mp4"])
        );
        assert_eq!(
            plan.existing,
            vec![(
                "assets/clip-edited.mp4".to_string(),
                dir.join("assets/clip-edited.mp4")
            )]
        );
        assert_eq!(plan.missing, owned(&["assets/gone.mp4"]));
        for bad in [
            "project.json",
            "assets/../project.json",
            "/etc/hosts",
            "edits/clip.json",
        ] {
            assert!(
                media_changed_paths(&dir, &owned(&[bad]))
                    .unwrap_err()
                    .contains("not a project asset path"),
                "{bad}"
            );
        }
        assert!(media_changed_paths(&dir, &[])
            .unwrap_err()
            .contains("needs paths"));
        let many = vec!["assets/x.mp4".to_string(); MAX_MEDIA_PATHS + 1];
        assert!(media_changed_paths(&dir, &many)
            .unwrap_err()
            .contains("at most"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_names_are_slugs() {
        assert_eq!(edit_name(None, "edit name"), Ok(None));
        assert_eq!(edit_name(Some("  "), "edit name"), Ok(None));
        assert_eq!(
            edit_name(Some(" clip "), "edit name"),
            Ok(Some("clip".into()))
        );
        assert!(edit_name(Some("../x"), "edit name").is_err());
    }

    #[test]
    fn open_edit_scenes_resolve_by_index_or_stem() {
        let manifest = json!({ "scenes": [
            { "file": "scenes/01-hero.tsx" },
            "scenes/02-stats.tsx",
            { "file": "./scenes/03-outro.tsx" }
        ] });
        assert_eq!(scene_index(&manifest, "1"), Some(1));
        assert_eq!(scene_index(&manifest, "3"), None);
        assert_eq!(scene_index(&manifest, "01-hero"), Some(0));
        assert_eq!(scene_index(&manifest, "02-stats"), Some(1));
        assert_eq!(scene_index(&manifest, "03-outro"), Some(2));
        assert_eq!(scene_index(&manifest, "missing"), None);
        assert_eq!(scene_index(&Value::Null, "0"), None);
    }

    #[test]
    fn opening_an_edit_focuses_only_the_window_already_on_it() {
        assert_eq!(open_kind(true, true), "focused");
        assert_eq!(open_kind(true, false), "retargeted");
        assert_eq!(open_kind(false, true), "created");
        assert_eq!(open_kind(false, false), "created");
    }

    #[test]
    fn frame_names_allow_a_suffix_but_stay_path_safe() {
        assert!(valid_name("0001792020000000-123-abc-12", 96));
        assert!(!valid_name("../x", 96));
        assert!(!valid_id(&"a".repeat(65)));
    }

    // ── Instances and addressing ───────────────────────────────────────────

    fn test_instance(pid: u32, build: &'static str, serving: bool) -> Instance {
        Instance {
            identity: BridgeIdentity {
                pid,
                bundle_id: crate::tools::APP_IDENTIFIER.into(),
                build,
                app_version: "0.19.0".into(),
                exe_path: Some(
                    "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut".into(),
                ),
                started_at_ms: 1_792_019_000_000,
                checkout: (!serving).then(|| Checkout {
                    path: "/Users/x/kookaburra-cut".into(),
                    worktree: true,
                }),
            },
            role: BridgeRole {
                serving,
                reason: (!serving)
                    .then(|| "workspace root overridden by KOOKABURRA_WORKSPACE_ROOT".into()),
            },
        }
    }

    fn addressed(id: &str, kind: &str, fields: Value) -> String {
        let mut body = json!({ "version": 2, "id": id, "kind": kind, "project": "ws:demo", "requestedAtMs": now_ms() });
        for (key, value) in fields.as_object().unwrap() {
            body[key] = value.clone();
        }
        body.to_string()
    }

    fn served() -> Value {
        served_by_value(
            &test_instance(1, "release", true).identity,
            Some("/Users/x/Kookaburra Cut"),
        )
    }

    #[test]
    fn the_role_decides_who_serves() {
        const ACCEPTANCE: &str = "com.mpalmes.kookaburracut.acceptance.x1";
        let main = RoleInputs {
            bundle_id: crate::tools::APP_IDENTIFIER,
            ..RoleInputs::default()
        };
        let stray = RoleInputs {
            root_overridden: true,
            bundle_id: ACCEPTANCE,
            worktree_build: true,
            ..RoleInputs::default()
        };
        assert_eq!(
            bridge_role(&main),
            BridgeRole {
                serving: true,
                reason: None
            }
        );
        let with = |base: &RoleInputs<'static>, env: Option<&'static str>| RoleInputs {
            bridge_env: env,
            ..base.clone()
        };
        let cases = [
            (
                RoleInputs {
                    autorun: true,
                    ..with(&main, Some("1"))
                },
                false,
                "autorun",
            ),
            (with(&main, Some("0")), false, "KOOKABURRA_BRIDGE=0"),
            (with(&stray, Some("1")), true, "KOOKABURRA_BRIDGE=1"),
            (with(&stray, Some("0")), false, "KOOKABURRA_BRIDGE=0"),
            (
                RoleInputs {
                    root_overridden: true,
                    ..main.clone()
                },
                false,
                "KOOKABURRA_WORKSPACE_ROOT",
            ),
            (
                RoleInputs {
                    bundle_id: ACCEPTANCE,
                    ..main.clone()
                },
                false,
                ACCEPTANCE,
            ),
            (
                RoleInputs {
                    worktree_build: true,
                    ..with(&main, Some("yes"))
                },
                false,
                "worktree",
            ),
            (with(&main, Some("")), true, ""),
        ];
        for (inputs, serving, reason) in cases {
            let got = bridge_role(&inputs);
            assert_eq!(got.serving, serving, "{inputs:?}");
            assert!(
                got.reason.as_deref().unwrap_or("").contains(reason),
                "{got:?} should name {reason}"
            );
        }
    }

    #[test]
    fn requests_carry_their_address() {
        let request = parse_request(&addressed(
            "0001-1-a",
            "capture",
            json!({ "workspaceRoot": "/Users/x/Kookaburra Cut", "projectPath": "/Users/x/Kookaburra Cut/demo", "instancePid": 87186, "client": "session-1a2b3c4d" }),
        ))
        .unwrap();
        assert_eq!(
            request.workspace_root.as_deref(),
            Some("/Users/x/Kookaburra Cut")
        );
        assert_eq!(request.instance_pid, Some(87186));
        assert_eq!(request.client.as_deref(), Some("session-1a2b3c4d"));
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["workspaceRoot"], "/Users/x/Kookaburra Cut");
        assert_eq!(value["instancePid"], 87186);
        assert_eq!(value["client"], "session-1a2b3c4d");
        assert!(parse_request(&addressed(
            "0001-1-b",
            "capture",
            json!({ "instancePid": -1 })
        ))
        .is_err());
    }

    #[test]
    fn claims_follow_the_pid_then_the_root_then_the_project() {
        let root = scratch("claimable");
        let (ours, theirs) = (root.join("ws"), root.join("other"));
        std::fs::create_dir_all(ours.join("demo")).unwrap();
        std::fs::create_dir_all(theirs.join("demo")).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&ours, &alias).unwrap();
        let req = |fields: Value| parse_request(&addressed("0001-1-a", "capture", fields)).unwrap();
        let text = |p: &Path| p.to_str().unwrap().to_owned();

        let to_pid = req(json!({ "instancePid": 7, "workspaceRoot": text(&theirs) }));
        assert!(claimable(Some(&ours), &to_pid, 7));
        assert!(!claimable(Some(&ours), &to_pid, 8));

        let to_root = req(json!({ "workspaceRoot": text(&ours) }));
        assert!(claimable(Some(&ours), &to_root, 1));
        assert!(claimable(Some(&alias), &to_root, 1));
        assert!(!claimable(Some(&theirs), &to_root, 1));
        assert!(!claimable(None, &to_root, 1));
        assert!(claimable(
            Some(&ours),
            &req(json!({ "workspaceRoot": text(&alias) })),
            1
        ));
        let upper = text(&ours).replace("/ws", "/WS");
        if Path::new(&upper).exists() {
            assert!(claimable(
                Some(&ours),
                &req(json!({ "workspaceRoot": upper })),
                1
            ));
        }
        assert!(!claimable(
            Some(&ours),
            &req(json!({ "workspaceRoot": text(&root.join("gone")) })),
            1
        ));

        let legacy = req(json!({}));
        assert!(claimable(Some(&ours), &legacy, 1));
        assert!(!claimable(Some(&root.join("empty")), &legacy, 1));
        let legacy_path = req(json!({ "projectPath": text(&theirs.join("demo")) }));
        assert!(!claimable(Some(&ours), &legacy_path, 1));
        assert!(claimable(Some(&theirs), &legacy_path, 1));
        assert!(same_dir(&alias, &ours) && !same_dir(&ours, &theirs));
        assert!(!same_dir(&ours, &root.join("gone")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pending_count_and_claim_skip_other_instances_requests() {
        let root = scratch("pending-foreign");
        let (ours, theirs) = (root.join("ws"), root.join("other"));
        std::fs::create_dir_all(ours.join("demo")).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        let bridge = root.join("bridge");
        let ours_text = ours.to_str().unwrap();
        let theirs_text = theirs.to_str().unwrap();
        queue(
            &bridge,
            "0001-1-a",
            &addressed("0001-1-a", "capture", json!({ "instancePid": 1 })),
        );
        let foreign_pid = queue(
            &bridge,
            "0002-1-b",
            &addressed("0002-1-b", "capture", json!({ "instancePid": 2 })),
        );
        let foreign_root = queue(
            &bridge,
            "0003-1-c",
            &addressed("0003-1-c", "check", json!({ "workspaceRoot": theirs_text })),
        );
        queue(
            &bridge,
            "0004-1-d",
            &addressed("0004-1-d", "fonts", json!({ "workspaceRoot": ours_text })),
        );
        let native = queue(
            &bridge,
            "0005-1-e",
            &addressed("0005-1-e", "openEdit", json!({ "instancePid": 1 })),
        );
        queue(
            &bridge,
            "0006-1-f",
            &request_body("0006-1-f", Some("capture")),
        );
        queue(
            &bridge,
            "0007-1-g",
            r#"{ "id": "0007-1-g", "kind": "capture", "scene": ["x"] }"#,
        );
        assert_eq!(render_pending_count(&bridge, true, Some(&ours), 1), 4);
        assert_eq!(render_pending_count(&bridge, true, Some(&theirs), 2), 4);
        assert_eq!(render_pending_count(&bridge, false, Some(&ours), 1), 0);
        let claim = || {
            claim_render_request(&bridge, true, Some(&ours), 1, || Some(served()))
                .unwrap()
                .map(|r| r.id)
        };
        assert_eq!(claim().as_deref(), Some("0001-1-a"));
        assert_eq!(claim().as_deref(), Some("0004-1-d"));
        assert_eq!(claim().as_deref(), Some("0006-1-f"));
        assert_eq!(claim(), None);
        assert!(foreign_pid.is_file() && foreign_root.is_file() && native.is_file());
        let answer: Value = serde_json::from_str(
            &std::fs::read_to_string(bridge.join("responses/0007-1-g.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["servedBy"], served());
        assert_eq!(render_pending_count(&bridge, true, Some(&ours), 1), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_instance_that_does_not_serve_touches_no_request() {
        let root = scratch("passive");
        let ours = root.join("ws");
        std::fs::create_dir_all(ours.join("demo")).unwrap();
        let bridge = root.join("bridge");
        let stale = queue(
            &bridge,
            "0001-1-a",
            &json!({ "id": "0001-1-a", "kind": "capture", "requestedAtMs": 1 }).to_string(),
        );
        let broken = queue(&bridge, "0002-1-b", "{");
        let fresh = queue(
            &bridge,
            "0003-1-c",
            &request_body("0003-1-c", Some("capture")),
        );
        assert_eq!(
            claim_render_request(&bridge, false, Some(&ours), 1, || Some(served())).unwrap(),
            None
        );
        assert!(fresh.is_file() && stale.is_file() && broken.is_file());
        assert!(!bridge.join("responses").exists() && !bridge.join("requests/.claimed").exists());
        assert_eq!(render_pending_count(&bridge, false, Some(&ours), 1), 0);
        let claimed = claim_render_request(&bridge, true, Some(&ours), 1, || Some(served()))
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, "0003-1-c");
        assert!(!stale.exists() && !broken.exists());
        let answer: Value = serde_json::from_str(
            &std::fs::read_to_string(bridge.join("responses/0002-1-b.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(answer["servedBy"], served());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_answer_names_its_server() {
        let by = served();
        let mut keys: Vec<&str> = by.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["appVersion", "build", "bundleId", "pid", "workspaceRoot"]
        );
        let stamped: Value = serde_json::from_str(
            &stamped_response(
                r#"{"version":2,"id":"a","ok":true,"path":"/x.png"}"#,
                Some(&by),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(stamped["servedBy"], by);
        assert_eq!(stamped["path"], "/x.png");
        let kept: Value = serde_json::from_str(
            &stamped_response(r#"{"ok":true,"servedBy":{"pid":2}}"#, Some(&by)).unwrap(),
        )
        .unwrap();
        assert_eq!(kept["servedBy"], json!({ "pid": 2 }));
        assert!(stamped_response("{", Some(&by))
            .unwrap_err()
            .contains("isn't valid JSON"));
        let ok = native_response_body("0001-1-a", Ok(json!({ "ok": true })), Some(&by));
        assert_eq!(
            ok,
            json!({ "ok": true, "version": 2, "id": "0001-1-a", "servedBy": by })
        );
        let failed = native_response_body("0001-1-a", Err("boom".into()), Some(&by));
        assert_eq!(
            (&failed["ok"], &failed["error"], &failed["servedBy"]),
            (&json!(false), &json!("boom"), &by)
        );
        let bare = native_response_body("0001-1-a", Ok(json!({ "ok": true })), None);
        assert!(bare.get("servedBy").is_none());
    }

    #[test]
    fn the_primary_heartbeat_goes_to_the_best_serving_instance() {
        let now = 1_792_020_000_000u64;
        let ours = PrimaryRank {
            release: false,
            started_at_ms: 100,
            pid: 10,
        };
        let alive = |_: u32| true;
        let hb = |pid: u32, build: &str, started: Option<u64>, updated: u64| {
            let mut body = json!({ "pid": pid, "build": build, "updatedAtMs": updated, "bridge": { "serving": true } });
            if let Some(started) = started {
                body["startedAtMs"] = json!(started);
            }
            body
        };
        let write =
            |current: Option<Value>| should_write_primary(current.as_ref(), &ours, now, alive);
        assert!(write(None));
        assert!(write(Some(json!("x"))));
        assert!(write(Some(json!({}))));
        assert!(write(Some(hb(10, "dev", Some(100), now))));
        assert!(write(Some(hb(
            11,
            "release",
            Some(50),
            now - HEARTBEAT_FRESH_MS - 1
        ))));
        assert!(should_write_primary(
            Some(&hb(11, "release", Some(50), now)),
            &ours,
            now,
            |pid| pid != 11
        ));
        let mut passive = hb(11, "release", Some(50), now);
        passive["bridge"]["serving"] = json!(false);
        assert!(write(Some(passive)));
        assert!(!write(Some(hb(11, "release", Some(500), now))));
        assert!(write(Some(hb(11, "dev", Some(200), now))));
        assert!(!write(Some(hb(11, "dev", Some(50), now))));
        assert!(!write(Some(hb(9, "dev", Some(100), now))));
        assert!(write(Some(hb(11, "dev", Some(100), now))));
        assert!(!write(Some(hb(11, "dev", None, now))));
        let release = PrimaryRank {
            release: true,
            started_at_ms: 900,
            pid: 99,
        };
        assert!(should_write_primary(
            Some(&hb(11, "dev", Some(50), now)),
            &release,
            now,
            alive
        ));
    }

    #[test]
    fn picked_folders_refuse_roots_the_home_folder_and_credentials() {
        let home = Path::new("/Users/x");
        assert!(too_broad_to_pick(Path::new("/"), Some(home)));
        assert!(too_broad_to_pick(Path::new("/Users"), Some(home)));
        assert!(too_broad_to_pick(Path::new("/Volumes"), Some(home)));
        assert!(too_broad_to_pick(Path::new("/Users/x"), Some(home)));
        assert!(!too_broad_to_pick(Path::new("/Users/x/Desktop"), Some(home)));
        assert!(!too_broad_to_pick(Path::new("/Volumes/Work/review"), None));
        assert!(NEVER_PICKED
            .iter()
            .any(|rel| Path::new("/Users/x/.ssh/keys").starts_with(home.join(rel))));
        let picked = PickedFolders::default();
        picked.note(Path::new("/Users/x/Desktop"));
        picked.note(Path::new("/Users/x/Movies"));
        picked.note(Path::new("/Users/x/Desktop"));
        assert_eq!(
            picked.list(),
            vec![PathBuf::from("/Users/x/Movies"), PathBuf::from("/Users/x/Desktop")]
        );
    }

    #[test]
    fn heartbeats_land_per_process_and_app_json_follows_the_primary() {
        let root = scratch("publish");
        let places = HeartbeatPlaces::default();
        let root_info = || RootInfo {
            root: Some("/Users/x/Kookaburra Cut".into()),
            source: "settings",
        };
        let publish = |instance: &Instance| {
            let mut body = heartbeat_body(instance, root_info(), &places, None, None, None, 5);
            let rank = instance.role.serving.then(|| PrimaryRank {
                release: instance.identity.build == "release",
                started_at_ms: instance.identity.started_at_ms,
                pid: instance.identity.pid,
            });
            publish_heartbeat(&root, &mut body, rank, 5, |_| true).unwrap();
            body.primary
        };
        let pid_of = |path: &str| read_json_file(&root.join(path)).map(|v| v["pid"].clone());
        assert!(publish(&test_instance(4242, "dev", true)));
        assert_eq!(
            std::fs::read_to_string(root.join("apps/4242.json")).unwrap(),
            std::fs::read_to_string(root.join("app.json")).unwrap()
        );
        assert!(!publish(&test_instance(4343, "release", false)));
        assert_eq!(pid_of("apps/4343.json"), Some(json!(4343)));
        assert_eq!(
            read_json_file(&root.join("apps/4343.json")).unwrap()["primary"],
            false
        );
        assert_eq!(pid_of("app.json"), Some(json!(4242)));
        assert!(publish(&test_instance(4444, "release", true)));
        assert!(!publish(&test_instance(4242, "dev", true)));
        assert_eq!(pid_of("app.json"), Some(json!(4444)));
        assert_eq!(
            read_json_file(&root.join("apps/4242.json")).unwrap()["primary"],
            false
        );
        remove_heartbeat_files(&root, 4242);
        assert!(!root.join("apps/4242.json").exists());
        assert_eq!(pid_of("app.json"), Some(json!(4444)));
        remove_heartbeat_files(&root, 4444);
        assert!(!root.join("app.json").exists() && !root.join("apps/4444.json").exists());
        assert!(root.join("apps/4343.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dead_and_old_instance_heartbeats_are_pruned() {
        let apps = scratch("prune-instances");
        let now = 1_792_020_000_000u64;
        let beat = |pid: &str, updated: u64| {
            std::fs::write(
                apps.join(format!("{pid}.json")),
                json!({ "pid": pid, "updatedAtMs": updated }).to_string(),
            )
            .unwrap();
        };
        beat("1", 0);
        beat("2", now);
        beat("3", now);
        beat("4", now - INSTANCE_PRUNE_MS - 1);
        beat("junk", now);
        std::fs::write(apps.join("5.json"), "{").unwrap();
        prune_instances(&apps, 1, now, |pid| pid != 3 && pid != 1);
        let mut left: Vec<String> = std::fs::read_dir(&apps)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort_unstable();
        assert_eq!(left, ["1.json", "2.json", "5.json", "junk.json"]);
        let _ = std::fs::remove_dir_all(&apps);
    }

    #[test]
    fn pid_liveness_treats_eperm_as_alive() {
        assert!(pid_alive(std::process::id()));
        assert!(
            pid_alive(1),
            "launchd is alive even though we may not signal it"
        );
        assert!(!pid_alive(0));
        assert!(!pid_alive(u32::MAX));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!pid_alive(pid));
    }

    #[test]
    fn freshness_follows_the_deadline_capped_at_15_minutes() {
        let now = 1_792_020_000_000u64;
        let req = |fields: Value| parse_request(&addressed("0001-1-a", "capture", fields)).unwrap();
        let legacy = req(json!({ "requestedAtMs": now - 100_000 }));
        assert!(request_fresh(&legacy, 0, now));
        assert!(!request_fresh(
            &req(json!({ "requestedAtMs": now - 120_001 })),
            0,
            now
        ));
        let by_age = req(json!({ "requestedAtMs": 0 }));
        assert!(request_fresh(&by_age, 120_000, now) && !request_fresh(&by_age, 120_001, now));
        let long = req(json!({ "requestedAtMs": now - 500_000, "deadlineAtMs": now + 100_000 }));
        assert!(request_fresh(&long, 0, now));
        let short = req(json!({ "requestedAtMs": now - 20_000, "deadlineAtMs": now - 1 }));
        assert!(!request_fresh(&short, 0, now));
        let capped = req(
            json!({ "requestedAtMs": now - MAX_DEADLINE_MS - 1, "deadlineAtMs": now + 3_600_000 }),
        );
        assert!(!request_fresh(&capped, 0, now));
        assert_eq!(
            request_deadline(
                &req(json!({ "requestedAtMs": 0, "deadlineAtMs": now + 10 })),
                5_000,
                now
            ),
            now + 10
        );
        let root = scratch("deadline-claim");
        queue(
            &root,
            "0001-1-a",
            &json!({ "id": "0001-1-a", "kind": "capture", "requestedAtMs": now_ms() - 300_000, "deadlineAtMs": now_ms() + 60_000 }).to_string(),
        );
        let stale = queue(
            &root,
            "0002-1-b",
            &json!({ "id": "0002-1-b", "kind": "capture", "requestedAtMs": now_ms() - 300_000 })
                .to_string(),
        );
        prune_bridge(&root, 1);
        assert!(!stale.exists() && root.join("requests/0001-1-a.json").is_file());
        assert_eq!(claim_next(&root, |_| true).unwrap().unwrap().id, "0001-1-a");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn debug_requests_route_by_op_and_window() {
        let route = |body: &str| serde_json::from_str::<RoutePeek>(body).unwrap();
        assert!(route(r#"{"kind":"debug","op":"contexts"}"#).native());
        assert!(route(r#"{"kind":"debug","op":"lose-context","window":"editor"}"#).native());
        assert!(!route(r#"{"kind":"debug","op":"lose-context","window":"render"}"#).native());
        assert!(!route(r#"{"kind":"debug","op":"lose-context"}"#).native());
        assert!(!route(r#"{"kind":"debug","op":"spawn-contexts","n":17}"#).native());
        assert!(
            route(r#"{"kind":"openEdit"}"#).native() && !route(r#"{"kind":"capture"}"#).native()
        );
        let root = scratch("debug-route");
        queue(
            &root,
            "0001-1-a",
            &addressed(
                "0001-1-a",
                "debug",
                json!({ "op": "contexts", "instancePid": 1 }),
            ),
        );
        queue(
            &root,
            "0002-1-b",
            &addressed(
                "0002-1-b",
                "debug",
                json!({ "op": "lose-context", "window": "render", "instancePid": 1 }),
            ),
        );
        queue(
            &root,
            "0003-1-c",
            &addressed(
                "0003-1-c",
                "debug",
                json!({ "op": "lose-context", "window": "editor", "instancePid": 1 }),
            ),
        );
        assert_eq!(render_pending_count(&root, true, None, 1), 1);
        let render = claim_render_request(&root, true, None, 1, || None)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                render.id.as_str(),
                render.op.as_deref(),
                render.window.as_deref()
            ),
            ("0002-1-b", Some("lose-context"), Some("render"))
        );
        let native = |root: &Path| {
            claim_next_served(root, RoutePeek::native, |_| true, || None)
                .unwrap()
                .map(|r| r.id)
        };
        assert_eq!(native(&root).as_deref(), Some("0001-1-a"));
        assert_eq!(native(&root).as_deref(), Some("0003-1-c"));
        assert_eq!(native(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn capture_fields_parse_and_claims_follow_the_order() {
        let request = parse_request(&addressed(
            "0001-1-a",
            "capture",
            json!({ "deadlineAtMs": 5, "retryOf": "0000-1-z", "width": 1280, "scale": 0.5, "probe": [[1, 2]], "n": 17 }),
        ))
        .unwrap();
        assert_eq!(
            (request.deadline_at_ms, request.retry_of.as_deref()),
            (Some(5), Some("0000-1-z"))
        );
        assert_eq!(
            (request.width, request.scale, request.n),
            (Some(1280.0), Some(0.5), Some(17))
        );
        assert_eq!(request.probe, Some(json!([[1, 2]])));
        assert_eq!(response_version(&request), 2);
        assert_eq!(
            response_version(&parse_request(r#"{"id":"a"}"#).unwrap()),
            1
        );
        let root = scratch("ordered");
        for id in ["0001-1-a", "0002-1-b", "0003-1-c"] {
            queue(&root, id, &request_body(id, Some("capture")));
        }
        let claim = || {
            claim_render_request_ordered(
                &root,
                true,
                None,
                1,
                || None,
                |c| {
                    c.reverse();
                    c.retain(|p| p.id != "0002-1-b");
                },
            )
            .unwrap()
            .map(|r| r.id)
        };
        assert_eq!(claim().as_deref(), Some("0003-1-c"));
        assert_eq!(claim().as_deref(), Some("0001-1-a"));
        assert_eq!(claim(), None);
        assert!(root.join("requests/0002-1-b.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_request_is_live_while_its_client_waits() {
        let root = scratch("liveness");
        let claimed = root.join("0001-1-a.json");
        assert_eq!(
            request_liveness(&claimed, false, now_ms()),
            json!({ "live": false, "reason": "cancelled" })
        );
        std::fs::write(&claimed, request_body("0001-1-a", Some("capture"))).unwrap();
        assert_eq!(
            request_liveness(&claimed, false, now_ms()),
            json!({ "live": true })
        );
        assert_eq!(
            request_liveness(&claimed, true, now_ms()),
            json!({ "live": false, "reason": "busy" })
        );
        std::fs::write(
            &claimed,
            json!({ "id": "0001-1-a", "requestedAtMs": now_ms(), "deadlineAtMs": now_ms() - 1 })
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            request_liveness(&claimed, false, now_ms()),
            json!({ "live": false, "reason": "cancelled" })
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_bridge_dir_override_must_be_absolute() {
        assert_eq!(bridge_dir_override(None), Ok(None));
        assert_eq!(bridge_dir_override(Some("  ")), Ok(None));
        assert_eq!(
            bridge_dir_override(Some(" /tmp/kc-e2e/_bridge ")),
            Ok(Some(PathBuf::from("/tmp/kc-e2e/_bridge")))
        );
        assert!(bridge_dir_override(Some("kc-e2e/_bridge"))
            .unwrap_err()
            .contains("absolute"));
    }
}
