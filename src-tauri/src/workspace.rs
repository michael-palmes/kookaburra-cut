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
pub(crate) const STATE_DIR_NAME: &str = ".kookaburra";
/// `EXDEV`: the one `rename` failure a copy can still satisfy. Same value on every platform this ships to.
const EXDEV: i32 = 18;

/// Current on-disk project manifest filename.
pub(crate) const MANIFEST_FILENAME: &str = "project.json";

/// The template manifest a bundled project must carry to be creatable from; the frontend registry (`src/engine/templates.ts`) globs the same file. Spikes and preview labs never carry one, so they self-exclude from both.
const TEMPLATE_FILENAME: &str = "template.json";

/// The shared sample media pool inside the bundled tree, seeded into every new project's assets/ rather than copied into every template.
const SAMPLES_DIR_NAME: &str = "_samples";

/// Per-project provisioning, embedded so a packaged app needs no extra resources.
const PROJECT_CLAUDE_MD: &str = include_str!("../templates/project-CLAUDE.md");
const PROJECT_CLAUDE_SETTINGS: &str = include_str!("../templates/project-claude-settings.json");

/// Sample screenshots seeded into every new project's assets (screen pickers never start empty).
const SAMPLE_SCREENSHOTS: [(&str, &[u8]); 4] = [
    (
        "sample-screenshot-1.jpg",
        include_bytes!("../templates/samples/sample-screenshot-1.jpg"),
    ),
    (
        "sample-screenshot-2.jpg",
        include_bytes!("../templates/samples/sample-screenshot-2.jpg"),
    ),
    (
        "sample-screenshot-3.jpg",
        include_bytes!("../templates/samples/sample-screenshot-3.jpg"),
    ),
    (
        "sample-screenshot-4.jpg",
        include_bytes!("../templates/samples/sample-screenshot-4.jpg"),
    ),
];

/// Persisted app settings (`$APPDATA/settings.json`); absent `workspace_root` means first run has not set one up yet.
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
    /// Inverted so the serde/Default false means opening poster frames are ON across the app.
    #[serde(default)]
    pub disable_opening_poster_frame: bool,
    /// Consented workspace projects (the F-001 trust gate), keyed by slug; a grant stands until the sources change outside a trusted session.
    #[serde(default)]
    pub trusted_projects: HashMap<String, TrustRecord>,
    /// Inverted so the serde/Default false means hardware ON; deterministic exports pin to software regardless.
    #[serde(default)]
    pub disable_hardware_video: bool,
    /// Inverted so the serde/Default false means Downloads ON: app-triggered exports land in ~/Downloads; terminal autoruns always keep the canonical paths.
    #[serde(default)]
    pub keep_exports_in_project: bool,
    /// Playback slowdown-badge sensitivity: "off" | "sustained" | "strict"; absent = "off".
    #[serde(default)]
    pub lag_warning: Option<String>,
    /// Tri-state auto-update consent: None = undecided (first-run ask still owed), Some(true) = on, Some(false) = off.
    #[serde(default)]
    pub update_check_consent: Option<bool>,
    /// Unix-ms of the last update check; only written while consent is on (launch-check throttle marker).
    #[serde(default)]
    pub last_update_check_ms: Option<u64>,
    /// Last version offered and declined ("Later"), so the same version isn't re-offered every launch.
    #[serde(default)]
    pub last_offered_version: Option<String>,
    /// Unix-ms of the last Claude Code version check (the daily throttle marker; stamped on attempt).
    #[serde(default)]
    pub last_claude_check_ms: Option<u64>,
    /// Cached latest Claude Code version from the last successful check.
    #[serde(default)]
    pub last_claude_latest: Option<String>,
    /// Last Claude Code version offered and dismissed, so the banner isn't re-shown for it.
    #[serde(default)]
    pub last_offered_claude_version: Option<String>,
    /// Last Present-modal selection per project id, restored on modal open.
    #[serde(default)]
    pub present_options_by_project: HashMap<String, PresentOptionsDoc>,
    /// Cross-project default, written by the modal's "Save as default".
    #[serde(default)]
    pub present_options_default: Option<PresentOptionsDoc>,
    /// Who this install says it is on the packs it signs; absent means never configured (the macOS full name stands in).
    #[serde(default)]
    pub publisher: Option<PublisherProfile>,
    /// Publishers whose packs have been imported before, keyed by manifest key id (trust on first use).
    #[serde(default)]
    pub known_publishers: HashMap<String, KnownPublisher>,
}

/// Self-declared pack publisher details. Never verified: the signing key is what identifies an install, this is only what it calls itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherProfile {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organisation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

/// One publisher a pack has been imported from, first seen when its key was accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownPublisher {
    /// `ed25519:<base64>`, so a key id collision can never be mistaken for the same publisher.
    pub public_key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organisation: Option<String>,
    /// RFC3339, UTC.
    pub first_seen: String,
    pub last_seen: String,
    pub pack_count: u32,
    pub last_pack_name: String,
}

/// The Present modal's remembered options (mode/quality strings are frontend enums, nothing Rust-side branches on them).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentOptionsDoc {
    pub mode: String,
    pub quality: String,
    pub soundtrack: bool,
    pub fullscreen: bool,
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
    /// Newest content edit (unix ms) across the manifest, scenes and assets, for last-updated ordering.
    pub content_mtime_ms: Option<u64>,
    /// Welcome-screen group heading from the manifest, when the project belongs to one.
    pub group: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

/// Load settings once into the managed cache (missing/corrupt file → defaults; a broken settings file re-offers first-run rather than wedging boot).
pub(crate) fn load_settings(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<AppSettings, String> {
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

pub(crate) fn save_settings(
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

/// Rewrite a file's CREATION time (APFS setattrlist); the media listings sort by it as "date added". Best effort: a failed stamp only costs sort position.
fn stamp_crtime(path: &Path, at: std::time::SystemTime) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(cpath) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    let Ok(dur) = at.duration_since(std::time::SystemTime::UNIX_EPOCH) else {
        return;
    };
    let ts = libc::timespec {
        tv_sec: dur.as_secs() as libc::time_t,
        tv_nsec: dur.subsec_nanos() as _,
    };
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attrs.commonattr = libc::ATTR_CMN_CRTIME;
    unsafe {
        libc::setattrlist(
            cpath.as_ptr(),
            &mut attrs as *mut _ as *mut libc::c_void,
            &ts as *const _ as *mut libc::c_void,
            std::mem::size_of::<libc::timespec>(),
            0,
        );
    }
}

/// Stamp "added just now": every user-caused asset write routes through here (imports, an app-icon replace, an edit render), because APFS clones and in-place rewrites both keep old dates. The creation stamp is what puts a file on top of the listings.
pub fn touch_now(path: &Path) {
    let now = std::time::SystemTime::now();
    stamp_crtime(path, now);
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(now);
    }
}

/// Stamp bundled content "never added": an epoch creation time sinks seeded samples and the default app icon below every user file (mtime stays real so Finder reads sanely); `index` keeps their relative order stable.
pub fn touch_ancient(path: &Path, index: u64) {
    stamp_crtime(
        path,
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(index),
    );
}

/// True when `path` already carries an ancient (seeded) creation stamp.
fn is_ancient(path: &Path) -> bool {
    let cutoff = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(86_400);
    std::fs::metadata(path)
        .and_then(|m| m.created())
        .map(|c| c <= cutoff)
        .unwrap_or(false)
}

/// Ancient-stamp `dst` when its content still equals the bundled bytes: heals projects seeded by older versions without ever touching a file the user has replaced.
fn heal_seeded_stamp(dst: &Path, bundled: &[u8], index: u64) {
    let len_ok = std::fs::metadata(dst)
        .map(|m| m.len() == bundled.len() as u64)
        .unwrap_or(false);
    if len_ok && std::fs::read(dst).map(|a| a == bundled).unwrap_or(false) {
        touch_ancient(dst, index);
    }
}

/// Move `path` to the Trash. Always route deletes through here: `trash`'s default macOS backend drives Finder via osascript, and TCC blames the Apple Event on us, so a hardened-runtime build silently fails every delete; `NsFileManager` trashes in-process (and still records Put Back).
pub fn trash_path(path: &Path) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

/// The configured workspace root, layout re-asserted. Errors if first-run hasn't completed.
pub fn require_root(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<PathBuf, String> {
    // A gate can point one boot at a throwaway root without mutating the user's settings (the pack round trip does exactly this).
    let root = match std::env::var("KOOKABURRA_WORKSPACE_ROOT") {
        Ok(over) if !over.trim().is_empty() => PathBuf::from(over.trim()),
        _ => {
            let settings = load_settings(app, state)?;
            PathBuf::from(
                settings
                    .workspace_root
                    .ok_or("no workspace configured — complete first-run setup")?,
            )
        }
    };
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

/// The roots a frontend-supplied absolute path is allowed to resolve inside: the configured workspace (ws: assets + their exports/), the bundled projects tree (VideoClip/device media), the dev-only fixtures tree (gate spikes and preview labs, debug builds only) and the default ~/Kookaburra Cut (where bundled-project exports land); any may be absent since a missing root simply can't contain the file, best-effort so an unconfigured workspace still permits bundled assets.
pub fn allowed_read_roots(app: &AppHandle, state: &State<'_, SettingsState>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(root) = require_root(app, state) {
        roots.push(root);
    }
    roots.push(templates_root(app));
    if let Some(fixtures) = dev_fixtures_root() {
        roots.push(fixtures);
    }
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

/// Where the bundled templates live: DEBUG binaries prefer the LIVE repo tree (baked in at compile time) because in dev, Tauri also copies resources beside the debug exe and that stale copy has previously shadowed newly added templates, matching the frontend's dev-tree-first resolution (engine/project.ts). RELEASE binaries prefer the resource tree (`bundle.resources` maps ../projects → Resources/projects): the packaged frontend resolves bundled assets against the resource dir, and preferring a dev checkout that happens to exist on the machine put that dir outside `allowed_read_roots`, silently failing clip extraction and breaking dev/packaged export parity on dev machines.
fn templates_root(app: &AppHandle) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../projects");
    if cfg!(debug_assertions) && dev.is_dir() {
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

/// The repo's dev-only fixture tree (`fixtures/`: gate spikes and preview labs), which is never bundled: DEBUG binaries read its clips like any bundled project, release binaries never see one (the frontend's fixture globs are dev-gated too).
fn dev_fixtures_root() -> Option<PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    (cfg!(debug_assertions) && dev.is_dir()).then_some(dev)
}

/// Where the shipped project skills live (same debug-tree-first / release-resource-first split as `templates_root`; bundled as the `claude-skills` resource so packaged apps provision projects exactly like dev).
fn skills_root(app: &AppHandle) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.agents/skills");
    if cfg!(debug_assertions) && dev.is_dir() {
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

/// Symlinks are recreated, never followed: a link pointing at an ancestor would recurse until the disk gave out, and a
/// broken one would abort the whole copy on a file nobody can read.
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&src).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&dst);
            std::os::unix::fs::symlink(&target, &dst)
                .map_err(|e| format!("linking {}: {e}", src.display()))?;
        } else if meta.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Parse a project's manifest for listing: display name + total duration, following the overlap model (`total = Σdurations − Σoverlaps`) where a scene's `transition` pulls its start back by the transition duration; the first scene's transition has nothing to overlap and is ignored, matching `engine/sceneTimeline.ts`.
pub(crate) fn manifest_summary(project_dir: &Path) -> Option<(String, u64, Option<String>)> {
    let text = std::fs::read_to_string(project_dir.join(MANIFEST_FILENAME)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = value.get("name")?.as_str().map(str::to_owned)?;
    let group = value
        .get("group")
        .and_then(|g| g.as_str())
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(str::to_owned);
    let mut total: i64 = 0;
    if let Some(scenes) = value.get("scenes").and_then(|s| s.as_array()) {
        for (i, scene) in scenes.iter().enumerate() {
            total += scene
                .get("durationMs")
                .and_then(|d| d.as_i64())
                .unwrap_or(0);
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
    Some((name, total.max(0) as u64, group))
}

pub(crate) fn now_unix_ms() -> u64 {
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

/// Newest mtime (unix ms) across the files a project edit touches: the manifest plus everything directly under `scenes/` and `assets/`.
fn content_mtime_ms(project: &Path) -> Option<u64> {
    let mut newest = file_mtime_ms(&project.join(MANIFEST_FILENAME));
    for dir in ["scenes", "assets"] {
        let Ok(entries) = std::fs::read_dir(project.join(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            newest = newest.max(file_mtime_ms(&entry.path()));
        }
    }
    newest
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

/// The root a chosen parent resolves to: picking a folder already named "Kookaburra Cut" adopts it rather than nesting another.
fn root_under(parent: PathBuf) -> PathBuf {
    if parent.file_name().and_then(|n| n.to_str()) == Some(WORKSPACE_DIR_NAME) {
        parent
    } else {
        parent.join(WORKSPACE_DIR_NAME)
    }
}

/// Where a workspace lands with no parent chosen, and the target "Reset to default" moves back to.
fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_under(
        app.path().home_dir().map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
pub fn default_workspace_root(app: AppHandle) -> Result<String, String> {
    Ok(default_root(&app)?.to_string_lossy().into_owned())
}

/// So the UI can show `~/Desktop/Vids` where a full path would not fit; the tooltip still carries the real one.
#[tauri::command]
pub fn user_home_dir(app: AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned())
}

/// A path with every symlink it can resolve resolved, so `/tmp` and `/private/tmp` compare equal. Falls back to the
/// nearest existing ancestor, since a move destination does not exist yet and `canonicalize` refuses those outright.
fn resolved(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => resolved(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// Everything that makes a move unsafe, before a single byte is touched.
///
/// Refuses rather than merges: two workspaces folded together would silently pick a winner for every clashing slug.
fn check_move(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() {
        return Err(format!(
            "your workspace is not where it used to be: {}",
            from.display()
        ));
    }
    // `rename` would move the link and leave every byte on the other volume, then report success.
    if std::fs::symlink_metadata(from).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "{} is a linked folder: move the folder it points at instead",
            from.display()
        ));
    }
    let (from_real, to_real) = (resolved(from), resolved(to));
    if to_real == from_real {
        return Err("your workspace is already there".into());
    }
    if to_real.starts_with(&from_real) {
        return Err("that folder is inside your workspace, pick one outside it".into());
    }
    if std::fs::read_dir(to).is_ok_and(|mut d| d.next().is_some()) {
        return Err(format!(
            "there is already a workspace at {}: move or rename it first",
            to.display()
        ));
    }
    Ok(())
}

/// Relocate the workspace tree itself, once `check_move` has cleared it.
fn perform_move(from: &Path, to: &Path) -> Result<(), String> {
    // Staging and backup trees are transient (swept after a day) and can be large; they do not travel.
    for transient in [
        crate::pack::limits::STAGING_DIR,
        crate::pack::limits::BACKUP_DIR,
    ] {
        let _ = std::fs::remove_dir_all(from.join(STATE_DIR_NAME).join(transient));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Rename is atomic and instant, but only within one volume; a workspace on an external disk needs the slow path.
    match std::fs::rename(from, to) {
        Ok(()) => return Ok(()),
        // Only a cross-volume refusal is worth copying for. Anything else is a real failure, reported as itself.
        Err(e) if e.raw_os_error() != Some(EXDEV) => return Err(e.to_string()),
        Err(_) => {}
    }
    if let Err(error) = copy_dir_recursive(from, to) {
        // The source is untouched, so the half-copy is pure waste, and leaving it would refuse every later attempt.
        let _ = std::fs::remove_dir_all(to);
        return Err(error);
    }
    std::fs::remove_dir_all(from).map_err(|e| {
        format!(
            "copied to {} but could not remove the old folder: {e}",
            to.display()
        )
    })
}

/// Trust is keyed by absolute project folder, so a move would otherwise re-ask the F-001 gate for every project.
fn retarget_trust(settings: &mut AppSettings, from: &Path, to: &Path) {
    let (from_prefix, to_prefix) = (from.to_string_lossy(), to.to_string_lossy());
    for record in settings.trusted_projects.values_mut() {
        // The remainder must start at a path boundary: a sibling named "Kookaburra Cut copy" is not inside this move.
        let Some(rest) = record.path.strip_prefix(from_prefix.as_ref()) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with('/') {
            record.path = format!("{to_prefix}{rest}");
        }
    }
}

/// Move the whole workspace to a new home and repoint settings at it. `parent` of `None` is the reset to default.
#[tauri::command]
pub fn move_workspace(
    app: AppHandle,
    state: State<'_, SettingsState>,
    export: State<'_, crate::ExportState>,
    packs: State<'_, crate::pack::commands::PackState>,
    parent: Option<String>,
) -> Result<String, String> {
    if export.busy() {
        return Err("an export is running: move your workspace after it finishes".into());
    }
    // The packs window imports from its own window: moving now would pull staging and the rollback backups out from under it.
    if packs.importing() {
        return Err(
            "a pack import is open: finish or cancel it before moving your workspace".into(),
        );
    }
    // A gate boot runs against a throwaway root the settings file knows nothing about; moving would repoint the real one.
    if std::env::var("KOOKABURRA_WORKSPACE_ROOT").is_ok_and(|v| !v.trim().is_empty()) {
        return Err("this run is pinned to a workspace by KOOKABURRA_WORKSPACE_ROOT".into());
    }
    let settings = load_settings(&app, &state)?;
    let from = PathBuf::from(
        settings
            .workspace_root
            .clone()
            .ok_or("no workspace configured yet")?,
    );
    let to = match parent {
        Some(p) => root_under(PathBuf::from(p)),
        None => default_root(&app)?,
    };
    check_move(&from, &to)?;
    perform_move(&from, &to)?;

    ensure_layout(&to)?;
    // Re-read rather than reusing the clone above: a cross-volume copy runs for minutes, and saving a stale snapshot
    // would silently revert anything the main window persisted meanwhile (last opened, a trust grant, consent).
    let mut settings = load_settings(&app, &state)?;
    settings.workspace_root = Some(to.to_string_lossy().into_owned());
    retarget_trust(&mut settings, &from, &to);
    save_settings(&app, &state, settings)?;
    let _ = app.asset_protocol_scope().allow_directory(&to, true);
    let _ = app.emit("kookaburra://workspace-moved", to.to_string_lossy());
    Ok(to.to_string_lossy().into_owned())
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
    let root = root_under(parent);
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
        let (name, duration_ms, group) =
            manifest_summary(&path).unwrap_or_else(|| (slug.clone(), 0, None));
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
            content_mtime_ms: content_mtime_ms(&path),
            group,
            slug,
        });
    }
    projects.sort_by_key(|p| p.name.to_lowercase());
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

/// Toggle the Downloads export destination (app-triggered exports only; the inverted field keeps Downloads the serde/Default ON state).
#[tauri::command]
pub fn set_export_to_downloads(
    app: AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    settings.keep_exports_in_project = !enabled;
    save_settings(&app, &state, settings)?;
    Ok(())
}

/// Set the playback slowdown-badge sensitivity and tell the main window so the detector follows live.
#[tauri::command]
pub fn set_lag_warning(
    app: AppHandle,
    state: State<'_, SettingsState>,
    mode: String,
) -> Result<(), String> {
    if !["off", "sustained", "strict"].contains(&mode.as_str()) {
        return Err(format!("unknown lag-warning mode: {mode}"));
    }
    let mut settings = load_settings(&app, &state)?;
    settings.lag_warning = Some(mode.clone());
    save_settings(&app, &state, settings)?;
    let _ = app.emit("kookaburra://lag-warning-changed", mode);
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

/// Set or clear the project's welcome-screen group (empty or missing clears the field).
#[tauri::command]
pub fn set_project_group(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    group: Option<String>,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let group = group.map(|g| g.trim().to_owned()).filter(|g| !g.is_empty());
    let root = require_root(&app, &state)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    match group {
        Some(g) => manifest["group"] = serde_json::Value::String(g),
        None => {
            if let Some(obj) = manifest.as_object_mut() {
                obj.remove("group");
            }
        }
    }
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Set or clear the project's typography override ("Family" or "Family@weight" per slot, `chart` being the project's default chart face); every slot empty clears the whole block.
#[tauri::command]
pub fn set_project_typography(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    headline: Option<String>,
    body: Option<String>,
    chart: Option<String>,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let headline = headline
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    let body = body.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let chart = chart.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let root = require_root(&app, &state)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    if headline.is_none() && body.is_none() && chart.is_none() {
        if let Some(obj) = manifest.as_object_mut() {
            obj.remove("typography");
        }
    } else {
        let mut block = serde_json::Map::new();
        if let Some(h) = headline {
            block.insert("headline".into(), serde_json::Value::String(h));
        }
        if let Some(b) = body {
            block.insert("body".into(), serde_json::Value::String(b));
        }
        if let Some(c) = chart {
            block.insert("chart".into(), serde_json::Value::String(c));
        }
        manifest["typography"] = serde_json::Value::Object(block);
    }
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
    if new_slug == "themes"
        || new_slug == "fonts"
        || new_slug == "gradients"
        || new_slug == "export-presets"
        || new_slug == "objects"
    {
        return Err(format!(
            "\"{new_slug}\" is a reserved folder name — pick another"
        ));
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
    for entry in std::fs::read_dir(&src)
        .map_err(|e| e.to_string())?
        .flatten()
    {
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
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("reading project.json: {e}"))?;
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

/// Remember the app-wide opening poster-frame choice; the inverted field keeps old and fresh settings default-on.
#[tauri::command]
pub fn set_opening_poster_frame(
    app: AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    settings.disable_opening_poster_frame = !enabled;
    save_settings(&app, &state, settings)
}

/// Remember the Present modal's selection per project (and, on request, as the cross-project default).
#[tauri::command]
pub fn set_present_options(
    app: AppHandle,
    state: State<'_, SettingsState>,
    project_id: String,
    options: PresentOptionsDoc,
    save_as_default: bool,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    settings
        .present_options_by_project
        .insert(project_id, options.clone());
    if save_as_default {
        settings.present_options_default = Some(options);
    }
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
// Centre-frame picker thumbs, cached per project under the workspace state dir and stamped PER SCENE (`<stem>.stamp` beside `<stem>.png`), so editing or adding one scene recaptures one thumb instead of the whole set; purely UI, the frontend captures lazily when a thumb grid mounts, never during export/autorun.

fn scene_thumbs_dir(root: &Path, slug: &str) -> PathBuf {
    root.join(STATE_DIR_NAME).join("scene-thumbs").join(slug)
}

/// Content stamp for one scene's thumb: its module plus its sidecar. Deliberately narrower than `project_fingerprint`, which moves on every insert (project.json) and so invalidated every thumb at once.
fn scene_source_stamp(scenes: &Path, stem: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    for ext in ["tsx", "json"] {
        std::fs::read(scenes.join(format!("{stem}.{ext}")))
            .unwrap_or_default()
            .hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Live source stamps for every scene module in a project, stem → stamp.
fn scene_source_stamps(project: &Path) -> HashMap<String, String> {
    let scenes = project.join("scenes");
    let mut stamps = HashMap::new();
    if let Ok(read) = std::fs::read_dir(&scenes) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("tsx") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                stamps.insert(stem.to_owned(), scene_source_stamp(&scenes, stem));
            }
        }
    }
    stamps
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneThumbs {
    /// The `project_fingerprint` a pre-per-scene cache was captured under; superseded by `stamps`, still reported so an older frontend keeps working.
    pub stamp: Option<String>,
    /// Scene file stem → absolute PNG path.
    pub thumbs: HashMap<String, String>,
    /// Scene file stem → the source stamp its cached thumb was captured under.
    pub stamps: HashMap<String, String>,
    /// Scene file stem → its CURRENT source stamp; a thumb is fresh when the two agree.
    pub source_stamps: HashMap<String, String>,
}

/// The cached thumb set for a project, plus both sides of the freshness comparison (read together so the two can't skew).
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
    let mut thumbs = HashMap::new();
    let mut stamps = HashMap::new();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            match path.extension().and_then(|e| e.to_str()) {
                Some("png") => {
                    thumbs.insert(stem.to_owned(), path.to_string_lossy().into_owned());
                }
                Some("stamp") => {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        stamps.insert(stem.to_owned(), text.trim().to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(SceneThumbs {
        stamp,
        thumbs,
        stamps,
        source_stamps: scene_source_stamps(&root.join(&slug)),
    })
}

/// Persist one scene thumb (raw PNG body, `write_snapshot` pattern); headers: `x-kookaburra-slug`, `x-kookaburra-stem` (the scene FILE stem), `x-kookaburra-stamp` (that scene's source stamp at capture time).
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
    std::fs::write(dir.join(format!("{stem}.stamp")), stamp).map_err(|e| e.to_string())
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
        && key
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-' || c == '@')
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

/// A bundled folder is a TEMPLATE only when it carries a project manifest AND declares itself with a readable `template.json`, so gate fixtures, preview labs and the sample pool can never be created from. Presence plus valid JSON is the whole native contract; the manifest's schema is validated in TS (`engine/templates.ts`).
fn require_template(template: &Path, template_id: &str) -> Result<(), String> {
    if !template.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("template \"{template_id}\" not found"));
    }
    let declared = std::fs::read_to_string(template.join(TEMPLATE_FILENAME))
        .map_err(|_| format!("template \"{template_id}\" not found"))?;
    serde_json::from_str::<serde_json::Value>(&declared)
        .map_err(|e| format!("template \"{template_id}\" has an unreadable template.json: {e}"))?;
    Ok(())
}

/// Create a project from a bundled template: copy `project.json` + `scenes/` + `assets/`, rewrite the manifest id/name, add `exports/`/`edits/`, stamp the Claude Code provisioning (CLAUDE.md, `.claude/settings.json`, the scene-authoring skill), and `git init` (best-effort, since Claude Code only persists folder trust for git repos).
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    name: String,
    template_id: String,
    group: Option<String>,
) -> Result<ProjectInfo, String> {
    let root = require_root(&app, &state)?;
    let display_name = name.trim().to_owned();
    let slug = slugify(&display_name);
    validate_slug(&slug)?;
    validate_slug(&template_id)?;
    // Workspace folders owned by the app, not by projects, so these names are reserved.
    if slug == "themes"
        || slug == "fonts"
        || slug == "gradients"
        || slug == "export-presets"
        || slug == "objects"
    {
        return Err(format!(
            "\"{slug}\" is a reserved folder name — pick another"
        ));
    }

    let template = templates_root(&app).join(&template_id);
    require_template(&template, &template_id)?;

    let dir = root.join(&slug);
    if dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("a project named \"{slug}\" already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Legacy migration: pre-v6 exports were written straight to the old default workspace root's <project>/ folder, so creating over such a folder folds its loose renders into exports/ first.
    let exports = dir.join("exports");
    std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
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
    // Templates reference the shared samples by name without shipping them, so seed the pool here (same ancient stamping as the backfill, so they sort below the user's own media).
    copy_missing_sample_assets(&samples_root(&app), &dir.join("assets"))?;
    for (i, (name, bytes)) in SAMPLE_SCREENSHOTS.iter().enumerate() {
        let dest = dir.join("assets").join(name);
        if !dest.exists() {
            std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
            touch_ancient(&dest, SAMPLE_SCREENSHOT_STAMP_OFFSET + i as u64);
        }
    }

    // Manifest: copy with id/name rewritten (id must match the folder slug).
    let manifest_text =
        std::fs::read_to_string(template.join(MANIFEST_FILENAME)).map_err(|e| e.to_string())?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| format!("template manifest: {e}"))?;
    manifest["id"] = serde_json::Value::String(slug.clone());
    manifest["name"] = serde_json::Value::String(display_name.clone());
    let group = group.map(|g| g.trim().to_owned()).filter(|g| !g.is_empty());
    if let Some(g) = &group {
        manifest["group"] = serde_json::Value::String(g.clone());
    }
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

    let duration_ms = manifest_summary(&dir).map(|(_, d, _)| d).unwrap_or(0);
    Ok(ProjectInfo {
        name: display_name,
        path: dir.to_string_lossy().into_owned(),
        duration_ms,
        snapshot_path: None,
        snapshot_mtime_ms: None,
        last_opened_ms: None,
        content_mtime_ms: content_mtime_ms(&dir),
        group,
        slug,
    })
}

/// Claude Code provisioning for a project folder: the skill copy is MANAGED, re-stamped wholesale so app updates propagate, while `CLAUDE.md` and `.claude/settings.json` are only written when missing since the user (or Claude itself) may legitimately customise them, so a re-stamp heals deletion without clobbering edits; skill source is best-effort since it may be absent in packaged builds.
pub(crate) fn stamp_claude_provisioning(app: &AppHandle, dir: &Path) -> Result<bool, String> {
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
        copy_dir_recursive(
            &skill_src,
            &claude_dir.join("skills/kookaburra-scene-authoring"),
        )?;
        Ok(true)
    } else {
        // A packaging defect, reported honestly: the terminal warns before Claude starts (a silent no-op left projects with no skill at all).
        log::warn!("scene-authoring skill not found at {}", skill_src.display());
        Ok(false)
    }
}

/// Re-stamp a project's Claude Code provisioning (called when a session opens, so a project created by an older app version, or a user deletion, heals in place).
#[tauri::command]
pub fn provision_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<bool, String> {
    let root = require_root(&app, &state)?;
    validate_slug(&slug)?;
    let dir = root.join(&slug);
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("\"{slug}\" is not a project folder"));
    }
    stamp_claude_provisioning(&app, &dir)
}

/// Media the pool seeds; anything else in `_samples` (README, dotfiles) stays put.
const SAMPLE_MEDIA_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "mp4", "mov", "m4a"];

/// The screenshots' ancient-stamp indices start here so a growing pool never reorders them.
const SAMPLE_SCREENSHOT_STAMP_OFFSET: u64 = 100;

/// The samples `ensure_sample_assets` restores at every project load; deleting one only brings it back, so the unused sweep leaves the whole pool alone.
pub(crate) fn backfilled_sample_names(app: &AppHandle) -> Vec<String> {
    pool_sample_names(&samples_root(app))
}

/// The shared sample pool inside the bundled tree (`projects/_samples/`), the one source both creation and the backfill seed from.
fn samples_root(app: &AppHandle) -> PathBuf {
    templates_root(app).join(SAMPLES_DIR_NAME)
}

/// Every seedable media file in the pool, sorted so ancient-stamp indices stay stable.
fn pool_sample_names(source_assets: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(source_assets)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|name| {
                    !name.starts_with('.')
                        && Path::new(name)
                            .extension()
                            .and_then(|x| x.to_str())
                            .is_some_and(|x| {
                                SAMPLE_MEDIA_EXTENSIONS.contains(&x.to_ascii_lowercase().as_str())
                            })
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Copy each pool sample into the project's assets/ only when missing; never clobbers. Fresh copies and existing untouched copies are ancient-stamped so they sit below the user's own media; a user-replaced file never matches the bundled bytes and keeps its own dates.
fn copy_missing_sample_assets(source_assets: &Path, project_assets: &Path) -> Result<(), String> {
    std::fs::create_dir_all(project_assets).map_err(|e| e.to_string())?;
    for (i, name) in pool_sample_names(source_assets).iter().enumerate() {
        let dst = project_assets.join(name);
        let src = source_assets.join(name);
        if dst.exists() {
            if !is_ancient(&dst) {
                if let Ok(bundled) = std::fs::read(&src) {
                    heal_seeded_stamp(&dst, &bundled, i as u64);
                }
            }
            continue;
        }
        if src.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {name}: {e}"))?;
            touch_ancient(&dst, i as u64);
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
    let project_assets = dir.join("assets");
    copy_missing_sample_assets(&samples_root(&app), &project_assets)?;
    // The creation-seeded screenshots heal the same way (their bundled bytes are embedded).
    for (i, (name, bytes)) in SAMPLE_SCREENSHOTS.iter().enumerate() {
        let dst = project_assets.join(name);
        if dst.is_file() && !is_ancient(&dst) {
            heal_seeded_stamp(&dst, bytes, SAMPLE_SCREENSHOT_STAMP_OFFSET + i as u64);
        }
    }
    Ok(())
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
pub(crate) fn trust_record_matches(
    record: &TrustRecord,
    dir: &Path,
    live_fingerprint: &str,
) -> bool {
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
    Ok(trust_record_matches(
        record,
        &dir,
        &compute_project_fingerprint(&dir),
    ))
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

pub(crate) const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
/// User environment maps (v9 lighting): lighting-only IBL sources, never visible media.
pub(crate) const ENVIRONMENT_EXTENSIONS: &[&str] = &["hdr", "exr"];
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

/// Relative paths of a project's environment maps (.hdr/.exr) for the lighting picker and the environment preload inventory.
#[tauri::command]
pub fn list_project_environments(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    list_by_extension(&app, &state, &slug, ENVIRONMENT_EXTENSIONS)
}

/// Relative paths of ALL media in a project's assets/ (videos + images), newest modified first so every picker surfaces fresh imports/edits on top: used by the helper wizards' file dropdown and the media library's listing.
#[tauri::command]
pub fn list_project_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    project_media_rels(&require_root(&app, &state)?, &slug)
}

/// Every media rel in a project's `assets/`, newest added first: `list_project_media`'s body with the root already in hand, so other modules can list without plumbing a `State` through.
pub(crate) fn project_media_rels(root: &Path, slug: &str) -> Result<Vec<String>, String> {
    let mut files = list_by_extension_in(root, slug, MEDIA_EXTENSIONS)?;
    sort_media_by_added(&root.join(slug), &mut files);
    Ok(files)
}

/// Newest ADDED first: creation time, stamped now by touch_now at every user action and ancient on bundled content, so imports always surface, in-place rewrites never resurface a file, and seeded samples sit last. Stable, so the alphabetical pass breaks ties; unreadable stamps sink last. Rels carry the `assets/` prefix, so they join the PROJECT dir (joining the assets dir made every stat miss and silently left the list alphabetical).
fn sort_media_by_added(project_dir: &Path, files: &mut [String]) {
    files.sort_by_cached_key(|rel| {
        std::cmp::Reverse(
            std::fs::metadata(project_dir.join(rel))
                .and_then(|m| m.created().or_else(|_| m.modified()))
                .ok(),
        )
    });
}

fn list_by_extension(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    slug: &str,
    extensions: &[&str],
) -> Result<Vec<String>, String> {
    list_by_extension_in(&require_root(app, state)?, slug, extensions)
}

fn list_by_extension_in(
    root: &Path,
    slug: &str,
    extensions: &[&str],
) -> Result<Vec<String>, String> {
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
    fn opening_poster_frame_defaults_on_and_round_trips_the_opt_out() {
        let defaults: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(!defaults.disable_opening_poster_frame);

        let disabled = AppSettings {
            disable_opening_poster_frame: true,
            ..Default::default()
        };
        let saved = serde_json::to_string(&disabled).unwrap();
        let loaded: AppSettings = serde_json::from_str(&saved).unwrap();
        assert!(loaded.disable_opening_poster_frame);
    }

    #[test]
    fn slugify_flattens_names() {
        assert_eq!(slugify("My Launch Video"), "my-launch-video");
        assert_eq!(slugify("  Q3 — Update!  "), "q3-update");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("Ünïcode Née"), "n-code-n-e");
    }

    #[test]
    fn root_under_adopts_a_folder_already_named_for_the_workspace() {
        assert_eq!(
            root_under(PathBuf::from("/Users/x/Desktop/Vids")),
            PathBuf::from("/Users/x/Desktop/Vids/Kookaburra Cut")
        );
        assert_eq!(
            root_under(PathBuf::from("/Users/x/Kookaburra Cut")),
            PathBuf::from("/Users/x/Kookaburra Cut")
        );
    }

    #[test]
    fn a_move_refuses_the_cases_that_would_lose_work() {
        let base = scratch_dir();
        let from = base.join("Kookaburra Cut");
        std::fs::create_dir_all(from.join("my-video")).unwrap();

        assert!(check_move(&from, &base.join("elsewhere")).is_ok());
        // Already there, including the path that only differs by a symlinked prefix.
        assert!(check_move(&from, &from).is_err());
        // Into itself: the move would consume its own source.
        assert!(check_move(&from, &from.join("nested")).is_err());
        // A destination holding someone else's work is never merged into.
        let occupied = base.join("occupied");
        std::fs::create_dir_all(occupied.join("their-video")).unwrap();
        assert!(check_move(&from, &occupied).is_err());
        // An empty folder is a fine destination; only content refuses.
        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(check_move(&from, &empty).is_ok());
        // A workspace that has been moved or deleted behind our back.
        assert!(check_move(&base.join("gone"), &base.join("elsewhere")).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_move_takes_the_work_and_leaves_the_transient_trees() {
        let base = scratch_dir();
        let from = base.join("Kookaburra Cut");
        let to = base.join("moved/Kookaburra Cut");
        std::fs::create_dir_all(from.join("my-video/scenes")).unwrap();
        std::fs::write(from.join("my-video/project.json"), r#"{"id":"my-video"}"#).unwrap();
        std::fs::create_dir_all(from.join("fonts")).unwrap();
        std::fs::write(from.join("fonts/fonts.json"), "{}").unwrap();
        let state = from.join(STATE_DIR_NAME);
        std::fs::create_dir_all(state.join("snapshots")).unwrap();
        std::fs::write(state.join("snapshots/one.png"), "snap").unwrap();
        std::fs::create_dir_all(state.join(crate::pack::limits::STAGING_DIR)).unwrap();
        std::fs::create_dir_all(state.join(crate::pack::limits::BACKUP_DIR)).unwrap();

        perform_move(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(
            std::fs::read_to_string(to.join("my-video/project.json")).unwrap(),
            r#"{"id":"my-video"}"#
        );
        assert_eq!(
            std::fs::read_to_string(to.join(STATE_DIR_NAME).join("snapshots/one.png")).unwrap(),
            "snap"
        );
        assert!(to.join("fonts/fonts.json").is_file());
        assert!(!to
            .join(STATE_DIR_NAME)
            .join(crate::pack::limits::STAGING_DIR)
            .exists());
        assert!(!to
            .join(STATE_DIR_NAME)
            .join(crate::pack::limits::BACKUP_DIR)
            .exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `rename` on a symlinked root moves the link and leaves every byte behind, while reporting success.
    #[test]
    fn a_linked_workspace_is_refused_rather_than_relinked() {
        let base = scratch_dir();
        let real = base.join("on-the-external-disk");
        let link = base.join("Kookaburra Cut");
        std::fs::create_dir_all(real.join("my-video")).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let error = check_move(&link, &base.join("elsewhere")).unwrap_err();
        assert!(error.contains("linked folder"), "{error}");
        // The folder it points at is a fine thing to move.
        assert!(check_move(&real, &base.join("elsewhere")).is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Following a link that points at an ancestor never terminates, and a broken one aborts the whole move.
    #[test]
    fn copying_recreates_symlinks_instead_of_following_them() {
        let base = scratch_dir();
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(from.join("assets")).unwrap();
        std::fs::write(from.join("assets/real.mp4"), "bytes").unwrap();
        std::os::unix::fs::symlink(&from, from.join("assets/loop")).unwrap();
        std::os::unix::fs::symlink(base.join("nothing-here"), from.join("assets/broken")).unwrap();

        copy_dir_recursive(&from, &to).unwrap();

        assert_eq!(
            std::fs::read_to_string(to.join("assets/real.mp4")).unwrap(),
            "bytes"
        );
        for link in ["assets/loop", "assets/broken"] {
            let meta = std::fs::symlink_metadata(to.join(link)).unwrap();
            assert!(meta.file_type().is_symlink(), "{link} was followed");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_move_carries_trust_grants_across() {
        let mut settings = AppSettings {
            trusted_projects: HashMap::from([
                (
                    "mine".to_string(),
                    TrustRecord {
                        scenes_fingerprint: "abc".into(),
                        path: "/Users/x/Desktop/Vids/Kookaburra Cut/mine".into(),
                        allowed_at_ms: 1,
                    },
                ),
                (
                    "elsewhere".to_string(),
                    TrustRecord {
                        scenes_fingerprint: "def".into(),
                        path: "/Users/x/Other/elsewhere".into(),
                        allowed_at_ms: 2,
                    },
                ),
                (
                    "sibling".to_string(),
                    TrustRecord {
                        scenes_fingerprint: "ghi".into(),
                        path: "/Users/x/Desktop/Vids/Kookaburra Cut copy/sibling".into(),
                        allowed_at_ms: 3,
                    },
                ),
            ]),
            ..Default::default()
        };
        retarget_trust(
            &mut settings,
            Path::new("/Users/x/Desktop/Vids/Kookaburra Cut"),
            Path::new("/Users/x/Kookaburra Cut"),
        );

        assert_eq!(
            settings.trusted_projects["mine"].path,
            "/Users/x/Kookaburra Cut/mine"
        );
        // A grant for a project outside the workspace is not ours to rewrite.
        assert_eq!(
            settings.trusted_projects["elsewhere"].path,
            "/Users/x/Other/elsewhere"
        );
        // Nor one whose folder merely starts with the same characters.
        assert_eq!(
            settings.trusted_projects["sibling"].path,
            "/Users/x/Desktop/Vids/Kookaburra Cut copy/sibling"
        );
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
        assert_eq!(
            std::fs::read(dest.join("app-icon.png")).unwrap(),
            b"icon-bytes"
        );

        // A project's own same-named file survives a later backfill.
        std::fs::write(dest.join("app-icon.png"), b"user-file").unwrap();
        copy_missing_sample_assets(&source, &dest).unwrap();
        assert_eq!(
            std::fs::read(dest.join("app-icon.png")).unwrap(),
            b"user-file"
        );

        // A missing source file is skipped, not an error (sample-laptop-recording.mp4 here).
        assert!(!dest.join("sample-laptop-recording.mp4").exists());

        let _ = std::fs::remove_dir_all(&source);
        let _ = std::fs::remove_dir_all(&dest_root);
    }

    #[test]
    fn pool_seeding_enumerates_media_and_skips_notes() {
        let source = scratch_dir();
        std::fs::write(source.join("README.md"), b"notes").unwrap();
        std::fs::write(source.join(".DS_Store"), b"junk").unwrap();
        std::fs::write(source.join("home-light-sample.jpg"), b"jpg").unwrap();
        std::fs::write(source.join("app-icon.png"), b"png").unwrap();
        let dest_root = scratch_dir();
        let dest = dest_root.join("assets");
        copy_missing_sample_assets(&source, &dest).unwrap();
        assert!(dest.join("home-light-sample.jpg").is_file());
        assert!(dest.join("app-icon.png").is_file());
        assert!(!dest.join("README.md").exists());
        assert!(!dest.join(".DS_Store").exists());
        assert_eq!(
            pool_sample_names(&source),
            vec![
                "app-icon.png".to_string(),
                "home-light-sample.jpg".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(&source);
        let _ = std::fs::remove_dir_all(&dest_root);
    }

    #[test]
    fn the_backfilled_samples_are_left_out_of_the_unused_sweep() {
        let source = scratch_dir();
        std::fs::write(source.join("home-light-sample.jpg"), b"jpg").unwrap();
        std::fs::write(source.join("README.md"), b"notes").unwrap();
        let pool = pool_sample_names(&source);
        assert!(pool.contains(&"home-light-sample.jpg".to_string()));
        // The seeded screenshots are only written at creation, so deleting one sticks.
        assert!(!pool.contains(&"sample-screenshot-1.jpg".to_string()));
        assert!(!pool.contains(&"README.md".to_string()));
        let _ = std::fs::remove_dir_all(&source);
    }

    #[test]
    fn require_template_needs_a_readable_declaration() {
        let root = scratch_dir();
        let fixture = root.join("transition-spike");
        std::fs::create_dir_all(&fixture).unwrap();
        std::fs::write(fixture.join(MANIFEST_FILENAME), b"{}").unwrap();
        // A spike carries a project manifest but declares no template, so it is not creatable from.
        assert!(require_template(&fixture, "transition-spike").is_err());
        assert!(require_template(&root.join("missing"), "missing").is_err());

        let template = root.join("blank");
        std::fs::create_dir_all(&template).unwrap();
        std::fs::write(template.join(MANIFEST_FILENAME), b"{}").unwrap();
        std::fs::write(template.join(TEMPLATE_FILENAME), b"not json").unwrap();
        assert!(require_template(&template, "blank").is_err());
        std::fs::write(template.join(TEMPLATE_FILENAME), br#"{"version":1}"#).unwrap();
        assert!(require_template(&template, "blank").is_ok());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scene_thumb_stamps_move_per_scene_not_per_project() {
        let project = scratch_dir();
        let scenes = project.join("scenes");
        std::fs::create_dir_all(&scenes).unwrap();
        std::fs::write(scenes.join("01-intro.tsx"), b"intro").unwrap();
        std::fs::write(scenes.join("01-intro.json"), b"{}").unwrap();
        std::fs::write(scenes.join("02-outro.tsx"), b"outro").unwrap();

        let before = scene_source_stamps(&project);
        assert_eq!(before.len(), 2);
        assert!(before.contains_key("01-intro"));

        // Adding a scene leaves every existing stamp alone (project.json is deliberately not hashed).
        std::fs::write(project.join(MANIFEST_FILENAME), b"{}").unwrap();
        std::fs::write(scenes.join("03-new.tsx"), b"new").unwrap();
        let added = scene_source_stamps(&project);
        assert_eq!(added["01-intro"], before["01-intro"]);
        assert_eq!(added["02-outro"], before["02-outro"]);
        assert_eq!(added.len(), 3);

        // Editing a sidecar moves only that scene's stamp.
        std::fs::write(scenes.join("01-intro.json"), b"{\"name\":\"Intro\"}").unwrap();
        let edited = scene_source_stamps(&project);
        assert_ne!(edited["01-intro"], before["01-intro"]);
        assert_eq!(edited["02-outro"], before["02-outro"]);

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_scene_stamp_separates_its_module_from_its_sidecar() {
        let project = scratch_dir();
        let scenes = project.join("scenes");
        std::fs::create_dir_all(&scenes).unwrap();
        std::fs::write(scenes.join("a.tsx"), b"ab").unwrap();
        std::fs::write(scenes.join("a.json"), b"c").unwrap();
        let split_one = scene_source_stamp(&scenes, "a");
        std::fs::write(scenes.join("a.tsx"), b"a").unwrap();
        std::fs::write(scenes.join("a.json"), b"bc").unwrap();
        assert_ne!(split_one, scene_source_stamp(&scenes, "a"));

        // A missing sidecar reads as empty, so writing an empty one is not a change.
        std::fs::write(scenes.join("b.tsx"), b"a").unwrap();
        let bare = scene_source_stamp(&scenes, "b");
        std::fs::write(scenes.join("b.json"), b"").unwrap();
        assert_eq!(bare, scene_source_stamp(&scenes, "b"));

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn media_sort_orders_by_added_and_sinks_seeded() {
        let project = scratch_dir();
        let assets = project.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        for name in ["alpha.png", "beta.png", "sample.png"] {
            std::fs::write(assets.join(name), b"x").unwrap();
        }
        // Two files pinned ancient with distinct indices; beta keeps its fresh creation time.
        touch_ancient(&assets.join("sample.png"), 0);
        touch_ancient(&assets.join("alpha.png"), 5);
        let mut files = vec![
            "assets/alpha.png".to_string(),
            "assets/beta.png".to_string(),
            "assets/sample.png".to_string(),
        ];
        sort_media_by_added(&project, &mut files);
        assert_eq!(
            files,
            ["assets/beta.png", "assets/alpha.png", "assets/sample.png"]
        );
        let _ = std::fs::remove_dir_all(&project);
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
        let escape = root
            .join("../")
            .join(outside.file_name().unwrap())
            .join("secret.pdf");
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
        assert!(!trust_record_matches(
            &record,
            &PathBuf::from("/other/demo"),
            "abc"
        ));
    }
}
