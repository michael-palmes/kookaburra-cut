//! Workspace export presets: `<workspaceRoot>/export-presets/<slug>.json`, user-saved preset docs from the export modal's Save-as/Duplicate flows, listed under *Your presets* with `ws:<slug>` ids; the frontend owns parsing/validation (`parseExportPreset` in `src/export/presetSchema.ts`), these commands only move text with the theme.rs version guard (a doc from a newer Kookaburra Cut is refused, never mangled); listing failures degrade to "no presets", never errors.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::workspace::{require_root, validate_slug, SettingsState};

/// The export-presets folder inside the workspace root; reserved as a project slug in `create_project` (a project named "export-presets" would shadow it).
pub const EXPORT_PRESETS_DIR_NAME: &str = "export-presets";

/// Newest preset-document version this build can rewrite (mirrors `EXPORT_PRESET_VERSION` in `src/export/presetSchema.ts`).
const EXPORT_PRESET_DOC_VERSION: u64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPresetListing {
    pub slug: String,
    /// The raw preset JSON text, parsed and validated frontend-side.
    pub json: String,
}

#[tauri::command]
pub fn list_export_presets(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<ExportPresetListing>, String> {
    let root = require_root(&app, &state)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(EXPORT_PRESETS_DIR_NAME)) else {
        return Ok(out); // no presets folder yet; an empty library, not an error
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
            out.push(ExportPresetListing { slug, json });
        }
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Write a workspace export preset (atomic tmp+rename, the write_scene_doc contract; version-guarded, the write_theme contract).
#[tauri::command]
pub fn write_export_preset(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("preset isn't valid JSON: {e}"))?;
    if !doc.is_object() {
        return Err("preset must be a JSON object".into());
    }
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version == 0 {
        return Err("preset doc needs a numeric \"version\"".into());
    }
    if version > EXPORT_PRESET_DOC_VERSION {
        return Err(format!(
            "this preset doc uses version {version} — it needs a newer Kookaburra Cut"
        ));
    }
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(EXPORT_PRESETS_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{slug}.json"));
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Delete a workspace export preset (the modal's Your-presets remove affordance).
#[tauri::command]
pub fn delete_export_preset(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let path = root.join(EXPORT_PRESETS_DIR_NAME).join(format!("{slug}.json"));
    if !path.is_file() {
        return Ok(()); // already gone; deleting twice isn't an error
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}
