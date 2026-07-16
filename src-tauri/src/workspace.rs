//! The user workspace: a folder of self-contained projects, chosen at first run (default `~/Kookaburra Cut`, moved out of ~/Documents for TCC) and remembered in `$APPDATA/settings.json`; commands are custom `#[tauri::command]`s that bypass the webview fs ACL, each re-asserting the on-disk layout first (`ensure_layout`) so a user deleting or rearranging folders mid-session degrades gracefully instead of crashing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folder name created inside the chosen parent ("~" becomes "~/Kookaburra Cut").
pub const WORKSPACE_DIR_NAME: &str = "Kookaburra Cut";
/// App-state folder inside the workspace (snapshots, caches). Never user-edited.
const STATE_DIR_NAME: &str = ".kookaburra";

/// Current on-disk project manifest filename.
pub(crate) const MANIFEST_FILENAME: &str = "project.json";

/// Per-project provisioning, embedded so a packaged app needs no extra resources.
const PROJECT_CLAUDE_MD: &str = include_str!("../templates/project-CLAUDE.md");
const PROJECT_CLAUDE_SETTINGS: &str = include_str!("../templates/project-claude-settings.json");

/// Persisted app settings (`$APPDATA/settings.json`); absent `workspace_root` means the first-run dialog has not completed yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub workspace_root: Option<String>,
    /// Project id (`ws:<slug>` or a bundled id) to reopen on boot.
    #[serde(default)]
    pub last_project: Option<String>,
    /// Unix-ms of each workspace project's last open, keyed by slug, for welcome-screen sort.
    #[serde(default)]
    pub last_opened: HashMap<String, u64>,
    /// Last export-modal selection per project id, restored on modal open; values are preset ids (`kookaburra-standard` = the frozen path, bundled ids, `ws:<slug>`, or `custom`).
    #[serde(default)]
    pub last_export_preset_by_project: HashMap<String, String>,
    /// Global fallback when the project has no entry yet (the most recent pick anywhere).
    #[serde(default)]
    pub last_export_preset: Option<String>,
    /// Consented workspace projects (the F-001 trust gate), keyed by slug; a grant stands until the sources change outside a trusted session.
    #[serde(default)]
    pub trusted_projects: HashMap<String, TrustRecord>,
    /// Inverted so the serde/Default false means hardware ON; deterministic exports pin to software regardless.
    #[serde(default)]
    pub disable_hardware_video: bool,
}

/// One consent grant: the sources fingerprint and project path it was given for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    pub scenes_fingerprint: String,
    /// Absolute project folder of the grant, so a same-slug project under a different workspace root never inherits it.
    pub path: String,
    pub allowed_at_ms: u64,
}

/// Managed settings cache. `None` = not yet loaded from disk.
#[derive(Default)]
pub struct SettingsState(pub Mutex<Option<AppSettings>>);

/// A workspace project as listed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Folder name; doubles as the manifest id and the export filename stem.
    pub slug: String,
    /// Display name from the manifest (falls back to the slug).
    pub name: String,
    /// Absolute project path, used by the frontend to build `/@fs` module URLs.
    pub path: String,
    /// Project length (Σ scene durations − Σ transition overlaps), for the project card.
    pub duration_ms: u64,
    /// Absolute path of the snapshot image, when one exists (welcome-card thumbnail).
    pub snapshot_path: Option<String>,
    /// Snapshot file mtime (unix ms) if one exists, doubles as the card's cache-buster.
    pub snapshot_mtime_ms: Option<u64>,
    /// When this project was last opened (unix ms), for welcome-screen ordering.
    pub last_opened_ms: Option<u64>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

/// Load settings once into the managed cache (missing/corrupt file → defaults; a broken settings file re-offers first-run rather than wedging boot).
fn load_settings(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<AppSettings, String> {
    let mut guard = state.0.lock().map_err(|_| "settings state poisoned")?;
    if let Some(settings) = guard.as_ref() {
        return Ok(settings.clone());
    }
    let settings = match std::fs::read_to_string(settings_path(app)?) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    };
    *guard = Some(settings.clone());
    Ok(settings)
}

fn save_settings(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    let mut guard = state.0.lock().map_err(|_| "settings state poisoned")?;
    *guard = Some(settings);
    Ok(())
}

/// Recreate the workspace skeleton idempotently; called by every command that touches the workspace, so a deleted subfolder heals on the next action.
fn ensure_layout(root: &Path) -> Result<(), String> {
    for dir in [
        root.to_path_buf(),
        root.join(STATE_DIR_NAME).join("snapshots"),
        root.join(STATE_DIR_NAME).join("cache"),
    ] {
        std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Move `path` to the Trash. Always route deletes through here: `trash`'s default macOS backend drives Finder via osascript, and TCC blames the Apple Event on us, so a hardened-runtime build silently fails every delete; `NsFileManager` trashes in-process (and still records Put Back).
pub fn trash_path(path: &Path) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

/// The configured workspace root, layout re-asserted. Errors if first-run hasn't completed.
pub fn require_root(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<PathBuf, String> {
    let settings = load_settings(app, state)?;
    let root = settings
        .workspace_root
        .ok_or("no workspace configured — complete first-run setup")?;
    let root = PathBuf::from(root);
    ensure_layout(&root)?;
    // Workspace files load in the webview as asset-protocol URLs (posters, pinned fonts, editor sources, snapshots; see engine/media.ts `fsUrl`); the static config scope only covers $APPDATA/cache + ~/Kookaburra Cut, so a user-chosen root elsewhere is allowed here at runtime instead, idempotent and best-effort since the read path reports its own errors if this fails.
    let _ = app.asset_protocol_scope().allow_directory(&root, true);
    Ok(root)
}

/// Folder-safe project slug: lowercase, alnum + single hyphens.
pub(crate) fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut last_hyphen = true; // suppress leading hyphens
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_hyphen = false;
        } else if !last_hyphen {
            slug.push('-');
            last_hyphen = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

/// Reject slugs that could escape the workspace when joined onto the root.
pub(crate) fn validate_slug(slug: &str) -> Result<(), String> {
    let ok = !slug.is_empty()
        && !slug.starts_with('.')
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid project name: {slug:?}"))
    }
}

/// The roots a frontend-supplied absolute path is allowed to resolve inside: the configured workspace (ws: assets + their exports/), the bundled projects tree (VideoClip/device media), and the default ~/Kookaburra Cut (where bundled-project exports land); any may be absent since a missing root simply can't contain the file, best-effort so an unconfigured workspace still permits bundled assets.
pub fn allowed_read_roots(app: &AppHandle, state: &State<'_, SettingsState>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(root) = require_root(app, state) {
        roots.push(root);
    }
    roots.push(templates_root(app));
    if let Ok(home) = app.path().home_dir() {
        roots.push(home.join(WORKSPACE_DIR_NAME));
    }
    roots
}

/// Canonicalise `path` and require it to sit inside one of `roots` (each canonicalised, so symlink and `..` escapes are resolved before comparison); the absolute-path analogue of `media::resolve_asset` for commands that take an already-resolved path from the frontend.
pub(crate) fn confine_to_roots(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("cannot access {path}: {e}"))?;
    for root in roots {
        if let Ok(root) = root.canonicalize() {
            if canonical.starts_with(&root) {
                return Ok(canonical);
            }
        }
    }
    Err(format!("path is outside the workspace: {path}"))
}

/// Confine a frontend-supplied absolute path to the workspace-readable roots (TAU-01).
pub fn confine_readable(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    path: &str,
) -> Result<PathBuf, String> {
    confine_to_roots(path, &allowed_read_roots(app, state))
}

/// Where the bundled templates live: dev = the LIVE repo tree (baked in at compile time), packaged = the resource tree (`bundle.resources` maps ../projects → Resources/projects); the repo tree is checked FIRST because in dev, Tauri also copies resources beside the debug exe and that stale copy has previously shadowed newly added templates with outdated content, matching the frontend's dev-tree-first resolution (engine/project.ts).
fn templates_root(app: &AppHandle) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../projects");
    if dev.is_dir() {
        return dev;
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("projects");
        if bundled.is_dir() {
            return bundled;
        }
    }
    dev
}

/// Where the shipped project skills live (same dev-tree-first split as `templates_root`; bundled as the `claude-skills` resource so packaged apps provision projects exactly like dev).
fn skills_root(app: &AppHandle) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.claude/skills");
    if dev.is_dir() {
        return dev;
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("claude-skills");
        if bundled.is_dir() {
            return bundled;
        }
    }
    dev
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Parse a project's manifest for listing: display name + total duration, following the overlap model (`total = Σdurations − Σoverlaps`) where a scene's `transition` pulls its start back by the transition duration; the first scene's transition has nothing to overlap and is ignored, matching `engine/sceneTimeline.ts`.
fn manifest_summary(project_dir: &Path) -> Option<(String, u64)> {
    let text = std::fs::read_to_string(project_dir.join(MANIFEST_FILENAME)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = value.get("name")?.as_str().map(str::to_owned)?;
    let mut total: i64 = 0;
    if let Some(scenes) = value.get("scenes").and_then(|s| s.as_array()) {
        for (i, scene) in scenes.iter().enumerate() {
            total += scene.get("durationMs").and_then(|d| d.as_i64()).unwrap_or(0);
            if i > 0 {
                if let Some(overlap) = scene
                    .get("transition")
                    .and_then(|t| t.get("durationMs"))
                    .and_then(|d| d.as_i64())
                {
                    total -= overlap;
                }
            }
        }
    }
    Some((name, total.max(0) as u64))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// A workspace project's snapshot image path (`.kookaburra/snapshots/<slug>.png`).
fn snapshot_file(root: &Path, slug: &str) -> PathBuf {
    root.join(STATE_DIR_NAME)
        .join("snapshots")
        .join(format!("{slug}.png"))
}

// ── Commands ───────────────────────────────────────────────────────────────

/// Current app settings (first-run check). Missing/corrupt settings read as defaults.
#[tauri::command]
pub fn get_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    load_settings(&app, &state)
}

/// Create (or adopt) the workspace under `parent` (default: the home folder) and persist it; picking a folder already named "Kookaburra Cut" adopts it rather than nesting another.
#[tauri::command]
pub fn init_workspace(
    app: AppHandle,
    state: State<'_, SettingsState>,
    parent: Option<String>,
) -> Result<String, String> {
    let parent = match parent {
        Some(p) => PathBuf::from(p),
        None => app.path().home_dir().map_err(|e| e.to_string())?,
    };
    let root = if parent.file_name().and_then(|n| n.to_str()) == Some(WORKSPACE_DIR_NAME) {
        parent
    } else {
        parent.join(WORKSPACE_DIR_NAME)
    };
    ensure_layout(&root)?;
    let mut settings = load_settings(&app, &state)?;
    settings.workspace_root = Some(root.to_string_lossy().into_owned());
    save_settings(&app, &state, settings)?;
    Ok(root.to_string_lossy().into_owned())
}

/// Workspace projects: direct child folders carrying a `project.json`; everything else (legacy render folders, user clutter) is ignored, not an error state.
#[tauri::command]
pub fn list_projects(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<ProjectInfo>, String> {
    let root = require_root(&app, &state)?;
    let last_opened = load_settings(&app, &state)?.last_opened;
    let mut projects = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !path.is_dir() || slug.starts_with('.') || !path.join(MANIFEST_FILENAME).is_file() {
            continue;
        }
        let (name, duration_ms) =
            manifest_summary(&path).unwrap_or_else(|| (slug.clone(), 0));
        let snap = snapshot_file(&root, &slug);
        let snapshot_mtime_ms = file_mtime_ms(&snap);
        projects.push(ProjectInfo {
            name,
            path: path.to_string_lossy().into_owned(),
            duration_ms,
            snapshot_path: snapshot_mtime_ms
                .is_some()
                .then(|| snap.to_string_lossy().into_owned()),
            snapshot_mtime_ms,
            last_opened_ms: last_opened.get(&slug).copied(),
            slug,
        });
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

/// Remember the project to reopen on next boot; workspace projects also get a last-opened stamp for welcome-screen ordering; `None` clears it (back at the welcome screen).
#[tauri::command]
pub fn set_last_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    project_id: Option<String>,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    if let Some(slug) = project_id.as_deref().and_then(|id| id.strip_prefix("ws:")) {
        validate_slug(slug)?;
        settings.last_opened.insert(slug.to_owned(), now_unix_ms());
    }
    settings.last_project = project_id;
    save_settings(&app, &state, settings)
}

/// Whether hardware video (VideoToolbox decode/encode on non-gated paths) is enabled; the everyday default is on.
pub(crate) fn hardware_video_enabled(app: &AppHandle) -> bool {
    let state = app.state::<SettingsState>();
    load_settings(app, &state).map_or(true, |s| !s.disable_hardware_video)
}

/// Toggle hardware video for the everyday paths (thumbnails, clip extraction, editor render) and tell the main window so its decode lane follows live.
#[tauri::command]
pub fn set_hardware_video(
    app: AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    settings.disable_hardware_video = !enabled;
    save_settings(&app, &state, settings)?;
    let _ = app.emit("kookaburra://hardware-video-changed", enabled);
    Ok(())
}

/// Rename a project's DISPLAY name; the slug/folder deliberately stays, since renaming it would orphan exports, Claude sessions (cwd), git history and settings.
#[tauri::command]
pub fn rename_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let display_name = name.trim().to_owned();
    if display_name.is_empty() {
        return Err("the project needs a name".into());
    }
    let root = require_root(&app, &state)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    manifest["name"] = serde_json::Value::String(display_name);
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Duplicate a project into a fresh slug; copies everything except `exports/` (outputs) and `.kookaburra/` (per-project caches, since snapshots/thumbs regenerate), `.git` rides along so Claude Code's workspace trust and history survive, and the manifest id/name are rewritten to the new identity.
#[tauri::command]
pub fn duplicate_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<String, String> {
    validate_slug(&slug)?;
    let display_name = name.trim().to_owned();
    let new_slug = slugify(&display_name);
    validate_slug(&new_slug)?;
    if new_slug == "themes" || new_slug == "fonts" || new_slug == "gradients" || new_slug == "export-presets" || new_slug == "objects" {
        return Err(format!("\"{new_slug}\" is a reserved folder name — pick another"));
    }
    let root = require_root(&app, &state)?;
    let src = root.join(&slug);
    if !src.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("no project named \"{slug}\""));
    }
    let dst = root.join(&new_slug);
    if dst.exists() {
        return Err(format!("a project named \"{new_slug}\" already exists"));
    }
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&src).map_err(|e| e.to_string())?.flatten() {
        let file_name = entry.file_name();
        let skip = matches!(file_name.to_str(), Some("exports") | Some(".kookaburra"));
        if skip {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&file_name);
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    std::fs::create_dir_all(dst.join("exports")).map_err(|e| e.to_string())?;
    let manifest_path = dst.join(MANIFEST_FILENAME);
    let text =
        std::fs::read_to_string(&manifest_path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    manifest["id"] = serde_json::Value::String(new_slug.clone());
    manifest["name"] = serde_json::Value::String(display_name);
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&manifest_path, pretty + "\n").map_err(|e| e.to_string())?;
    stamp_claude_provisioning(&app, &dst)?;
    Ok(new_slug)
}

/// Move a project to the TRASH, never `rm -rf`, so Finder's Put Back works; a matching `last_project` is cleared so the next boot lands on the welcome screen.
#[tauri::command]
pub fn delete_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(&slug);
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("no project named \"{slug}\""));
    }
    trash_path(&dir).map_err(|e| format!("couldn't move the project to the Trash: {e}"))?;
    let mut settings = load_settings(&app, &state)?;
    // The trust grant dies with the project, so a later same-slug project starts untrusted.
    let mut changed = settings.trusted_projects.remove(&slug).is_some();
    if settings.last_project.as_deref() == Some(&format!("ws:{slug}")) {
        settings.last_project = None;
        changed = true;
    }
    if changed {
        save_settings(&app, &state, settings)?;
    }
    Ok(())
}

/// Remember the export modal's selection, written on each successful export, restored per project with the global pick as fallback.
#[tauri::command]
pub fn set_last_export_preset(
    app: AppHandle,
    state: State<'_, SettingsState>,
    project_id: String,
    preset_id: String,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    settings
        .last_export_preset_by_project
        .insert(project_id, preset_id.clone());
    settings.last_export_preset = Some(preset_id);
    save_settings(&app, &state, settings)
}

/// Persist a project's welcome-screen snapshot; the PNG bytes arrive as the raw invoke body (`InvokeBody::Raw`, same zero-copy path as `push_frame`), the target slug rides in the `x-kookaburra-slug` header, and there's light sanity checking: PNG magic + a size cap.
#[tauri::command]
pub fn write_snapshot(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let slug = request
        .headers()
        .get("x-kookaburra-slug")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-kookaburra-slug header")?
        .to_owned();
    validate_slug(&slug)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_snapshot expects a raw binary body".into());
    };
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if bytes.len() < 8 || bytes[..4] != PNG_MAGIC {
        return Err("snapshot body is not a PNG".into());
    }
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("snapshot too large".into());
    }
    let root = require_root(&app, &state)?;
    std::fs::write(snapshot_file(&root, &slug), bytes).map_err(|e| e.to_string())
}

// ── Scene thumbnails ──────────────────────────────────────────────────────
// Centre-frame picker thumbs, cached per project under the workspace state dir and invalidated as a SET by the project fingerprint (the `.stamp` file); purely UI, the frontend captures lazily when a picker opens, never during export/autorun.

fn scene_thumbs_dir(root: &Path, slug: &str) -> PathBuf {
    root.join(STATE_DIR_NAME).join("scene-thumbs").join(slug)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneThumbs {
    /// The `project_fingerprint` value the set was captured under (None = no cache).
    pub stamp: Option<String>,
    /// Scene file stem → absolute PNG path.
    pub thumbs: std::collections::HashMap<String, String>,
}

/// The cached thumb set for a project (the frontend compares `stamp` to the live fingerprint and recaptures when they differ).
#[tauri::command]
pub fn list_scene_thumbs(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<SceneThumbs, String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    let dir = scene_thumbs_dir(&root, &slug);
    let stamp = std::fs::read_to_string(dir.join(".stamp"))
        .ok()
        .map(|s| s.trim().to_owned());
    let mut thumbs = std::collections::HashMap::new();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("png") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    thumbs.insert(stem.to_owned(), path.to_string_lossy().into_owned());
                }
            }
        }
    }
    Ok(SceneThumbs { stamp, thumbs })
}

/// Persist one scene thumb (raw PNG body, `write_snapshot` pattern); headers: `x-kookaburra-slug`, `x-kookaburra-stem` (the scene FILE stem), `x-kookaburra-stamp` (the fingerprint the capture ran under, rewritten per write since the whole set shares it).
#[tauri::command]
pub fn write_scene_thumb(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {name} header"))
    };
    let slug = header("x-kookaburra-slug")?;
    let stem = header("x-kookaburra-stem")?;
    let stamp = header("x-kookaburra-stamp")?;
    validate_slug(&slug)?;
    validate_slug(&stem)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_scene_thumb expects a raw binary body".into());
    };
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if bytes.len() < 8 || bytes[..4] != PNG_MAGIC {
        return Err("thumb body is not a PNG".into());
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("thumb too large".into());
    }
    let root = require_root(&app, &state)?;
    let dir = scene_thumbs_dir(&root, &slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{stem}.png")), bytes).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".stamp"), stamp).map_err(|e| e.to_string())
}

/// Persist one colour-emoji raster into the project's own `assets/.emoji-cache/` (raw PNG body, the `write_scene_thumb` pattern). Write-once: an existing file is NEVER overwritten, so the first-rasterised bytes stay the determinism source even across macOS emoji-artwork updates (the system-font pinning contract).
#[tauri::command]
pub fn write_emoji_raster(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {name} header"))
    };
    let slug = header("x-kookaburra-slug")?;
    let key = header("x-kookaburra-key")?;
    validate_slug(&slug)?;
    // Key shape: hex codepoints dash-joined plus a @size suffix, e.g. `1f680-fe0f@256`.
    let valid_key = !key.is_empty()
        && key.len() <= 128
        && key.chars().all(|c| c.is_ascii_hexdigit() || c == '-' || c == '@')
        && key.matches('@').count() == 1
        && !key.starts_with(['-', '@']);
    if !valid_key {
        return Err(format!("invalid raster key \"{key}\""));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_emoji_raster expects a raw binary body".into());
    };
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if bytes.len() < 8 || bytes[..4] != PNG_MAGIC {
        return Err("raster body is not a PNG".into());
    }
    if bytes.len() > 512 * 1024 {
        return Err("raster too large".into());
    }
    let root = require_root(&app, &state)?;
    let dir = root.join(&slug).join("assets").join(".emoji-cache");
    let file = dir.join(format!("{key}.png"));
    if file.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&file, bytes).map_err(|e| e.to_string())
}

/// Create a project from a bundled template: copy `project.json` + `scenes/` + `assets/`, rewrite the manifest id/name, add `exports/`/`edits/`, stamp the Claude Code provisioning (CLAUDE.md, `.claude/settings.json`, the scene-authoring skill), and `git init` (best-effort, since Claude Code only persists folder trust for git repos).
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    name: String,
    template_id: String,
) -> Result<ProjectInfo, String> {
    let root = require_root(&app, &state)?;
    let display_name = name.trim().to_owned();
    let slug = slugify(&display_name);
    validate_slug(&slug)?;
    validate_slug(&template_id)?;
    // Workspace folders owned by the app, not by projects, so these names are reserved.
    if slug == "themes" || slug == "fonts" || slug == "gradients" || slug == "export-presets" || slug == "objects" {
        return Err(format!("\"{slug}\" is a reserved folder name — pick another"));
    }

    let template = templates_root(&app).join(&template_id);
    if !template.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("template \"{template_id}\" not found"));
    }

    let dir = root.join(&slug);
    if dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("a project named \"{slug}\" already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Legacy migration: pre-v6 exports were written straight to the old default workspace root's <project>/ folder, so creating over such a folder folds its loose renders into exports/ first.
    let exports = dir.join("exports");
    std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let is_render = matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("mp4") | Some("mov")
        );
        if path.is_file() && is_render {
            let _ = std::fs::rename(&path, exports.join(entry.file_name()));
        }
    }

    for sub in ["scenes", "assets"] {
        let src = template.join(sub);
        if src.is_dir() {
            copy_dir_recursive(&src, &dir.join(sub))?;
        }
    }
    // Always present even when the template ships none (e.g. "blank", since empty dirs don't survive git): media import and relative asset references expect the folder.
    std::fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("edits")).map_err(|e| e.to_string())?;

    // Manifest: copy with id/name rewritten (id must match the folder slug).
    let manifest_text =
        std::fs::read_to_string(template.join(MANIFEST_FILENAME)).map_err(|e| e.to_string())?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| format!("template manifest: {e}"))?;
    manifest["id"] = serde_json::Value::String(slug.clone());
    manifest["name"] = serde_json::Value::String(display_name.clone());
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST_FILENAME), pretty + "\n").map_err(|e| e.to_string())?;

    // Claude Code provisioning, shared with the per-open re-stamp (see `stamp_claude_provisioning`).
    stamp_claude_provisioning(&app, &dir)?;

    // git init + initial commit gives Claude Code persisted workspace trust and history; best-effort since git may be missing (Xcode CLT prompt on a fresh Mac), in which case the project still works but Claude re-asks for trust each session.
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&dir)
            .output()
    };
    match git(&["init"]) {
        Ok(out) if out.status.success() => {
            let _ = git(&["add", "-A"]);
            // Explicit identity so the commit succeeds without global git config.
            let _ = git(&[
                "-c",
                "user.name=Kookaburra Cut",
                "-c",
                "user.email=kookaburra@localhost",
                "commit",
                "-m",
                &format!("chore: create project from template {template_id}"),
            ]);
        }
        Ok(out) => log::warn!("git init failed: {}", String::from_utf8_lossy(&out.stderr)),
        Err(e) => log::warn!("git unavailable, skipping repo init: {e}"),
    }

    let duration_ms = manifest_summary(&dir).map(|(_, d)| d).unwrap_or(0);
    Ok(ProjectInfo {
        name: display_name,
        path: dir.to_string_lossy().into_owned(),
        duration_ms,
        snapshot_path: None,
        snapshot_mtime_ms: None,
        last_opened_ms: None,
        slug,
    })
}

/// Claude Code provisioning for a project folder: the skill copy is MANAGED, re-stamped wholesale so app updates propagate, while `CLAUDE.md` and `.claude/settings.json` are only written when missing since the user (or Claude itself) may legitimately customise them, so a re-stamp heals deletion without clobbering edits; skill source is best-effort since it may be absent in packaged builds.
pub(crate) fn stamp_claude_provisioning(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let claude_md = dir.join("CLAUDE.md");
    if !claude_md.is_file() {
        std::fs::write(&claude_md, PROJECT_CLAUDE_MD).map_err(|e| e.to_string())?;
    }
    let claude_dir = dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    let settings = claude_dir.join("settings.json");
    if !settings.is_file() {
        std::fs::write(&settings, PROJECT_CLAUDE_SETTINGS).map_err(|e| e.to_string())?;
    }
    let skill_src = skills_root(app).join("kookaburra-scene-authoring");
    if skill_src.is_dir() {
        copy_dir_recursive(&skill_src, &claude_dir.join("skills/kookaburra-scene-authoring"))?;
    } else {
        log::warn!("scene-authoring skill not found at {}", skill_src.display());
    }
    Ok(())
}

/// Re-stamp a project's Claude Code provisioning (called when a session opens, so a project created by an older app version, or a user deletion, heals in place).
#[tauri::command]
pub fn provision_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    let dir = root.join(&slug);
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("\"{slug}\" is not a project folder"));
    }
    stamp_claude_provisioning(&app, &dir)
}

/// The bundled sample files every project template ships (see `projects/*/assets/`).
const SAMPLE_ASSET_FILES: [&str; 3] = [
    "sample-phone-recording.mp4",
    "sample-laptop-recording.mp4",
    "app-icon.png",
];

/// Copy each sample file into the project's assets/ only when missing; never clobbers.
fn copy_missing_sample_assets(source_assets: &Path, project_assets: &Path) -> Result<(), String> {
    std::fs::create_dir_all(project_assets).map_err(|e| e.to_string())?;
    for name in SAMPLE_ASSET_FILES {
        let dst = project_assets.join(name);
        if dst.exists() {
            continue;
        }
        let src = source_assets.join(name);
        if src.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {name}: {e}"))?;
        }
    }
    Ok(())
}

/// Backfill the bundled sample assets into a workspace project (projects created before the samples were vendored into every template).
#[tauri::command]
pub fn ensure_sample_assets(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    let dir = root.join(&slug);
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("\"{slug}\" is not a project folder"));
    }
    let source_assets = templates_root(&app).join("theme-starter").join("assets");
    copy_missing_sample_assets(&source_assets, &dir.join("assets"))
}

/// Change fingerprint of a project's SOURCES (project.json + everything under scenes/); the frontend polls this to hot-reload the preview when Claude, or any external editor, writes files (workspace projects sit outside Vite's watch scope); returned as a hex string since u64 hashes don't survive JSON's f64 numbers.
#[tauri::command]
pub fn project_fingerprint(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<String, String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    Ok(compute_project_fingerprint(&root.join(&slug)))
}

/// The fingerprint behind `project_fingerprint`, shared with the trust gate so consent is bound to the exact sources it was given for.
pub(crate) fn compute_project_fingerprint(dir: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // (path, mtime-nanos, size) for project.json + scenes/**, sorted for stability.
    let mut entries: Vec<(String, u128, u64)> = Vec::new();
    let mut stat = |path: &Path| {
        if let Ok(meta) = std::fs::metadata(path) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            entries.push((path.to_string_lossy().into_owned(), mtime, meta.len()));
        }
    };
    stat(&dir.join(MANIFEST_FILENAME));
    let mut stack = vec![dir.join("scenes")];
    while let Some(current) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                stat(&path);
            }
        }
    }
    entries.sort();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// A stored grant still stands only if both the project path and its live sources fingerprint match.
pub(crate) fn trust_record_matches(record: &TrustRecord, dir: &Path, live_fingerprint: &str) -> bool {
    record.path == dir.to_string_lossy() && record.scenes_fingerprint == live_fingerprint
}

/// Whether the user has consented to running this project's scene code and its sources are unchanged since (the F-001 trust gate).
#[tauri::command]
pub fn is_project_trusted(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<bool, String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let settings = load_settings(&app, &state)?;
    let Some(record) = settings.trusted_projects.get(&slug) else {
        return Ok(false);
    };
    let dir = root.join(&slug);
    Ok(trust_record_matches(record, &dir, &compute_project_fingerprint(&dir)))
}

/// Record consent for a project's current sources; called on Allow, on autorun auto-trust, and to re-stamp in-session edits so your own work never re-asks.
#[tauri::command]
pub fn trust_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(&slug);
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("no project named \"{slug}\""));
    }
    let allowed_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let mut settings = load_settings(&app, &state)?;
    settings.trusted_projects.insert(
        slug,
        TrustRecord {
            scenes_fingerprint: compute_project_fingerprint(&dir),
            path: dir.to_string_lossy().into_owned(),
            allowed_at_ms,
        },
    );
    save_settings(&app, &state, settings)
}

/// A workspace project's manifest text (the frontend parses + validates it).
#[tauri::command]
pub fn read_project_manifest(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<String, String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    std::fs::read_to_string(root.join(&slug).join(MANIFEST_FILENAME))
        .map_err(|e| format!("reading {slug}/project.json: {e}"))
}

/// A workspace scene module's TSX source, for the runtime compiler; `file` is the manifest's project-relative module path (`scenes/<stem>.tsx`, persistent modules share the folder); traversal-hardened the same way as sidecar reads (`scene_doc::scene_doc_path`): exactly one flat path segment under `scenes/`.
#[tauri::command]
pub fn read_scene_source(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    file: String,
) -> Result<String, String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    let rest = file
        .strip_prefix("scenes/")
        .ok_or_else(|| format!("scene module path must live under scenes/: {file:?}"))?;
    let ok = rest.ends_with(".tsx")
        && !rest.contains('/')
        && !rest.contains("..")
        && !rest.starts_with('.');
    if !ok {
        return Err(format!("invalid scene module path: {file:?}"));
    }
    std::fs::read_to_string(root.join(&slug).join(&file))
        .map_err(|e| format!("reading {slug}/{file}: {e}"))
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
pub(crate) const MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "m4v", "webm",
];
pub(crate) const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm"];
/// Project-soundtrack sources, kept small and boring; ffmpeg decodes them all.
pub(crate) const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg"];

/// Relative paths of a project's IMAGE assets (for texture preloading, the workspace equivalent of the bundled projects' eager asset glob).
#[tauri::command]
pub fn list_project_assets(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    list_by_extension(&app, &state, &slug, IMAGE_EXTENSIONS)
}

/// Relative paths of ALL media in a project's assets/ (videos + images): used by the helper wizards' file dropdown and the media library's listing.
#[tauri::command]
pub fn list_project_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    list_by_extension(&app, &state, &slug, MEDIA_EXTENSIONS)
}

fn list_by_extension(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    slug: &str,
    extensions: &[&str],
) -> Result<Vec<String>, String> {
    let root = require_root(app, state)?;
    validate_slug(slug)?;
    let assets = root.join(slug).join("assets");
    let mut files = Vec::new();
    collect_files(&assets, &assets, extensions, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files(
    base: &Path,
    dir: &Path,
    extensions: &[&str],
    out: &mut Vec<String>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(()); // no assets folder is fine
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Dot-prefixed folders are app caches (.emoji-cache), never user media.
        if path.is_dir() {
            let hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false);
            if !hidden {
                collect_files(base, &path, extensions, out)?;
            }
        } else if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| extensions.contains(&ext.to_lowercase().as_str()))
            .unwrap_or(false)
        {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(format!("assets/{}", rel.to_string_lossy()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_flattens_names() {
        assert_eq!(slugify("My Launch Video"), "my-launch-video");
        assert_eq!(slugify("  Q3 — Update!  "), "q3-update");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("Ünïcode Née"), "n-code-n-e");
    }

    #[test]
    fn validate_slug_rejects_escapes() {
        assert!(validate_slug("my-video").is_ok());
        assert!(validate_slug("").is_err());
        assert!(validate_slug(".kookaburra").is_err());
        assert!(validate_slug("a/b").is_err());
        assert!(validate_slug("..").is_err());
    }

    // A unique scratch dir under the OS temp root (avoids a tempfile dev-dependency).
    fn scratch_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-confine-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_missing_sample_assets_is_idempotent_and_never_clobbers() {
        let source = scratch_dir();
        std::fs::write(source.join("sample-phone-recording.mp4"), b"video-bytes").unwrap();
        std::fs::write(source.join("app-icon.png"), b"icon-bytes").unwrap();
        let dest_root = scratch_dir();
        let dest = dest_root.join("assets");

        copy_missing_sample_assets(&source, &dest).unwrap();
        assert_eq!(
            std::fs::read(dest.join("sample-phone-recording.mp4")).unwrap(),
            b"video-bytes"
        );
        assert_eq!(std::fs::read(dest.join("app-icon.png")).unwrap(), b"icon-bytes");

        // A project's own same-named file survives a later backfill.
        std::fs::write(dest.join("app-icon.png"), b"user-file").unwrap();
        copy_missing_sample_assets(&source, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("app-icon.png")).unwrap(), b"user-file");

        // A missing source file is skipped, not an error (sample-laptop-recording.mp4 here).
        assert!(!dest.join("sample-laptop-recording.mp4").exists());

        let _ = std::fs::remove_dir_all(&source);
        let _ = std::fs::remove_dir_all(&dest_root);
    }

    #[test]
    fn confine_to_roots_contains_and_rejects() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::fs::write(root.join("clip.mp4"), b"x").unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/nested.mp4"), b"x").unwrap();
        std::fs::write(outside.join("secret.pdf"), b"x").unwrap();
        let roots = [root.clone()];

        // Inside the root (direct + nested) resolves and canonicalises.
        assert!(confine_to_roots(root.join("clip.mp4").to_str().unwrap(), &roots).is_ok());
        assert!(confine_to_roots(root.join("assets/nested.mp4").to_str().unwrap(), &roots).is_ok());

        // A `..` escape to a real file outside the root is rejected.
        let escape = root.join("../").join(outside.file_name().unwrap()).join("secret.pdf");
        assert!(confine_to_roots(escape.to_str().unwrap(), &roots).is_err());
        // A file plainly outside every root is rejected.
        assert!(confine_to_roots(outside.join("secret.pdf").to_str().unwrap(), &roots).is_err());
        // A non-existent path and an empty root list are rejected.
        assert!(confine_to_roots(root.join("missing.mp4").to_str().unwrap(), &roots).is_err());
        assert!(confine_to_roots(root.join("clip.mp4").to_str().unwrap(), &[]).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn project_fingerprint_tracks_source_changes() {
        let dir = scratch_dir();
        std::fs::write(dir.join("project.json"), b"{}").unwrap();
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        std::fs::write(dir.join("scenes/intro.tsx"), b"a").unwrap();

        let before = compute_project_fingerprint(&dir);
        // Stable while untouched, moves on a source edit (size change, mtime aside).
        assert_eq!(before, compute_project_fingerprint(&dir));
        std::fs::write(dir.join("scenes/intro.tsx"), b"ab").unwrap();
        assert_ne!(before, compute_project_fingerprint(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trust_record_matches_requires_path_and_fingerprint() {
        let dir = PathBuf::from("/ws/demo");
        let record = TrustRecord {
            scenes_fingerprint: "abc".into(),
            path: dir.to_string_lossy().into_owned(),
            allowed_at_ms: 0,
        };
        assert!(trust_record_matches(&record, &dir, "abc"));
        // Changed sources or a different workspace root both invalidate the grant.
        assert!(!trust_record_matches(&record, &dir, "def"));
        assert!(!trust_record_matches(&record, &PathBuf::from("/other/demo"), "abc"));
    }
}
