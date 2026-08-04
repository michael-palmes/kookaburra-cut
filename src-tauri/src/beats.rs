//! Beat-analysis cache: the webview decodes and analyses the soundtrack (Web Audio), Rust owns a content-hash-keyed JSON cache under `$APPDATA/cache/beats/` (beside `cache/loudness`) so re-opening a project is instant. The payload is opaque to Rust; the frontend versions and validates it.

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::workspace::{self, SettingsState};

fn cache_file(app: &AppHandle, abs: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let bytes = std::fs::read(abs).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let key = crate::hex_digest(hasher.finalize().as_slice());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("beats");
    Ok(dir.join(format!("{key}.json")))
}

/// Cached analysis JSON for the file's current bytes, or None on a cache miss.
#[tauri::command]
pub async fn beat_cache_load(
    app: AppHandle,
    state: State<'_, SettingsState>,
    path: String,
) -> Result<Option<String>, String> {
    let abs = workspace::confine_readable(&app, &state, &path)?;
    if !abs.is_file() {
        return Err(format!("audio file not found: {path}"));
    }
    Ok(std::fs::read_to_string(cache_file(&app, &abs)?).ok())
}

/// Store freshly-computed analysis JSON, keyed by the file's current bytes.
#[tauri::command]
pub async fn beat_cache_store(
    app: AppHandle,
    state: State<'_, SettingsState>,
    path: String,
    json: String,
) -> Result<(), String> {
    let abs = workspace::confine_readable(&app, &state, &path)?;
    if !abs.is_file() {
        return Err(format!("audio file not found: {path}"));
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("beat json: {e}"))?;
    let cache = cache_file(&app, &abs)?;
    if let Some(dir) = cache.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = cache.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &cache).map_err(|e| e.to_string())?;
    Ok(())
}
