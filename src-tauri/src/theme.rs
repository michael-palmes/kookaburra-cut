//! Workspace themes: `<workspaceRoot>/themes/<slug>/theme.json`, user-created theme documents referenced by `ws:<slug>` ids (the workspace-project namespace pattern); the frontend owns parsing/validation (`src/theme/schema.ts`, one schema implementation), these commands only move text, plus the write path (`write_theme`, the theme wizard) and the theme-preview stores: the autorun batch renders bundled previews to `~/Kookaburra Cut/_autorun/theme-previews/` (the wrapper script copies them into the repo), and user-theme previews cache app-globally under `$APPDATA/cache/theme-previews/<key>/` keyed by a content hash of the theme JSON (the media-cache pattern); listing failures degrade to "no themes"/"no previews", never errors (the workspace.rs philosophy).

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::workspace::{require_root, validate_slug, SettingsState, WORKSPACE_DIR_NAME};

/// Newest theme-document version this build can rewrite (mirrors `THEME_DOC_VERSION` in `src/theme/schema.ts`).
const THEME_DOC_VERSION: u64 = 2;

/// Previews per theme, the 4 standard `theme-starter` scenes' middle frames.
const PREVIEWS_PER_THEME: u32 = 4;

/// The themes folder inside the workspace root; reserved as a project slug in `create_project` (a project named "themes" would shadow it).
pub const THEMES_DIR_NAME: &str = "themes";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeListing {
    pub slug: String,
    /// The raw `theme.json` text, parsed and validated frontend-side.
    pub json: String,
}

#[tauri::command]
pub fn list_themes(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<ThemeListing>, String> {
    let root = require_root(&app, &state)?;
    let mut themes = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(THEMES_DIR_NAME)) else {
        return Ok(themes); // no themes folder yet; an empty library, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !path.is_dir() || slug.starts_with('.') {
            continue;
        }
        if let Ok(json) = std::fs::read_to_string(path.join("theme.json")) {
            themes.push(ThemeListing { slug, json });
        }
    }
    themes.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(themes)
}

#[tauri::command]
pub fn read_theme(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<String, String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let file = root.join(THEMES_DIR_NAME).join(&slug).join("theme.json");
    std::fs::read_to_string(&file).map_err(|e| format!("reading theme \"{slug}\": {e}"))
}

/// Write a workspace theme document (atomic tmp+rename, the `write_scene_doc` contract); the text must parse as JSON with a supported `version`, a doc from a newer Kookaburra Cut is refused rather than rewritten blind. The frontend re-stamps `id` from the folder slug on read, so the doc's own `id` field is advisory.
#[tauri::command]
pub fn write_theme(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("theme doc isn't valid JSON: {e}"))?;
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version == 0 {
        return Err("theme doc needs a numeric \"version\"".into());
    }
    if version > THEME_DOC_VERSION {
        return Err(format!(
            "this theme doc uses version {version} — it needs a newer Kookaburra Cut"
        ));
    }
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let path = root.join(THEMES_DIR_NAME).join(&slug).join("theme.json");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Delete a workspace theme's folder (delete parity with export presets). Workspace themes only, bundled ids never reach this (the UI offers Delete for `ws:` themes alone, and the slug points inside `~/Kookaburra Cut/themes/`); projects still referencing the theme degrade to the default at resolve time. The content-hash preview cache entry is left behind, it is a cache, not state.
#[tauri::command]
pub fn delete_theme(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(THEMES_DIR_NAME).join(&slug);
    if !dir.join("theme.json").is_file() {
        return Err(format!("no workspace theme named \"{slug}\""));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ── Theme previews ──────────────────────────────────────────────────

/// App-global user-theme preview cache root (`$APPDATA/cache/theme-previews`).
fn preview_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("theme-previews"))
}

/// Where the bundled-preview autorun batch lands (`<workspace>/_autorun/theme-previews`); the `kookaburra:run` wrapper copies these into `src/assets/theme-previews/` for commit.
fn preview_autorun_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(WORKSPACE_DIR_NAME)
        .join("_autorun")
        .join("theme-previews"))
}

/// Persist one theme-preview JPEG; bytes arrive as the raw invoke body (the `write_snapshot` pattern), headers route it: `x-kookaburra-kind` = `autorun` (the bundled batch) or `cache` (a user theme, key = content hash), `x-kookaburra-key` names the theme folder, `x-kookaburra-index` is the 1-based scene index.
#[tauri::command]
pub fn write_theme_preview(app: AppHandle, request: tauri::ipc::Request) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {name} header"))
    };
    let kind = header("x-kookaburra-kind")?;
    let key = header("x-kookaburra-key")?;
    validate_slug(&key)?;
    let index: u32 = header("x-kookaburra-index")?
        .parse()
        .map_err(|_| "x-kookaburra-index must be a number".to_string())?;
    if index == 0 || index > PREVIEWS_PER_THEME {
        return Err(format!("preview index {index} out of range"));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_theme_preview expects a raw binary body".into());
    };
    const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];
    if bytes.len() < 4 || bytes[..3] != JPEG_MAGIC {
        return Err("theme preview body is not a JPEG".into());
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("theme preview too large".into());
    }
    let base = match kind.as_str() {
        "autorun" => preview_autorun_root(&app)?,
        "cache" => preview_cache_root(&app)?,
        other => return Err(format!("unknown preview kind {other:?}")),
    };
    let dir = base.join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{index}.jpg")), bytes).map_err(|e| e.to_string())
}

/// Persist one option-preview frame (the picker preview generator); bytes arrive as the raw invoke body, `x-kookaburra-set` names the option set (e.g. `textanim-fade-scale`), `x-kookaburra-index` is the 1-based frame number (stills = 1; clips = the whole zero-padded sequence the wrapper encodes). Frames land at `<workspace>/_autorun/option-previews/<set>/NNN.jpg`; the `kookaburra:run` wrapper promotes them into `src/assets/option-previews/` for commit.
#[tauri::command]
pub fn write_option_preview(app: AppHandle, request: tauri::ipc::Request) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {name} header"))
    };
    let set = header("x-kookaburra-set")?;
    validate_slug(&set)?;
    let index: u32 = header("x-kookaburra-index")?
        .parse()
        .map_err(|_| "x-kookaburra-index must be a number".to_string())?;
    if index == 0 || index > 600 {
        return Err(format!("option-preview frame index {index} out of range"));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_option_preview expects a raw binary body".into());
    };
    const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];
    if bytes.len() < 4 || bytes[..3] != JPEG_MAGIC {
        return Err("option preview body is not a JPEG".into());
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("option preview too large".into());
    }
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(WORKSPACE_DIR_NAME)
        .join("_autorun")
        .join("option-previews")
        .join(&set);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{index:03}.jpg")), bytes).map_err(|e| e.to_string())
}

/// The cached preview paths for a user theme's content-hash key, all 4 in scene order, or `None` when the set is incomplete (the picker falls back to placeholder art and the wizard re-captures). Never errors: a missing cache is "no previews".
#[tauri::command]
pub fn list_theme_previews(app: AppHandle, key: String) -> Result<Option<Vec<String>>, String> {
    validate_slug(&key)?;
    let dir = preview_cache_root(&app)?.join(&key);
    let mut paths = Vec::new();
    for index in 1..=PREVIEWS_PER_THEME {
        let file = dir.join(format!("{index}.jpg"));
        if !file.is_file() {
            return Ok(None);
        }
        paths.push(file.to_string_lossy().into_owned());
    }
    Ok(Some(paths))
}
