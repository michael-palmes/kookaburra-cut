//! Workspace gradient presets: `<workspaceRoot>/gradients/<slug>.json`, user-saved specs from the background picker's Custom builder; the frontend owns parsing/validation (`parseGradient` in `src/theme/schema.ts`, the one schema implementation), these commands only move text; listing failures degrade to "no presets", never errors.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::workspace::{require_root, validate_slug, SettingsState};

/// The gradients folder inside the workspace root; reserved as a project slug in `create_project` (a project named "gradients" would shadow it).
pub const GRADIENTS_DIR_NAME: &str = "gradients";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientListing {
    pub slug: String,
    /// The raw preset JSON text, parsed and validated frontend-side.
    pub json: String,
}

#[tauri::command]
pub fn list_gradients(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<GradientListing>, String> {
    let root = require_root(&app, &state)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(GRADIENTS_DIR_NAME)) else {
        return Ok(out); // no gradients folder yet; an empty library, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !path.is_file() || name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let slug = name.trim_end_matches(".json").to_owned();
        if let Ok(json) = std::fs::read_to_string(&path) {
            out.push(GradientListing { slug, json });
        }
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Write a workspace gradient preset (atomic tmp+rename, the write_scene_doc contract).
#[tauri::command]
pub fn write_gradient(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("gradient isn't valid JSON: {e}"))?;
    if !doc.is_object() {
        return Err("gradient must be a JSON object".into());
    }
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(GRADIENTS_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{slug}.json"));
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Delete a saved gradient preset (delete parity with export presets).
#[tauri::command]
pub fn delete_gradient(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let path = root.join(GRADIENTS_DIR_NAME).join(format!("{slug}.json"));
    if !path.is_file() {
        return Err(format!("no saved gradient named \"{slug}\""));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}
