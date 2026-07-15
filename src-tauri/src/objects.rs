//! Workspace 3D objects: `<workspaceRoot>/objects/<slug>/object.json` (+ the glb and an optional thumbnail beside it), referenced by `ws:<slug>` ids — the theme.rs pattern: the frontend owns parsing/validation (`src/toolkit/objects/schema.ts`), these commands only move text; listing failures degrade to "no objects", never errors.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::workspace::{require_root, validate_slug, SettingsState};

/// The objects folder inside the workspace root; reserved as a project slug in `create_project`.
pub const OBJECTS_DIR_NAME: &str = "objects";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectListing {
    pub slug: String,
    /// The raw `object.json` text, parsed and validated frontend-side.
    pub json: String,
}

#[tauri::command]
pub fn list_objects(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<ObjectListing>, String> {
    let root = require_root(&app, &state)?;
    let mut objects = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(OBJECTS_DIR_NAME)) else {
        return Ok(objects); // no objects folder yet; an empty library, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !path.is_dir() || slug.starts_with('.') {
            continue;
        }
        if let Ok(json) = std::fs::read_to_string(path.join("object.json")) {
            objects.push(ObjectListing { slug, json });
        }
    }
    objects.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(objects)
}

#[tauri::command]
pub fn read_object(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<String, String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let file = root.join(OBJECTS_DIR_NAME).join(&slug).join("object.json");
    std::fs::read_to_string(&file).map_err(|e| format!("reading object \"{slug}\": {e}"))
}
