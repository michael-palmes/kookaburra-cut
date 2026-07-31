//! Workspace 3D objects: `<workspaceRoot>/objects/<slug>/object.json` (+ the glb and an optional thumbnail beside it), referenced by `ws:<slug>` ids — the theme.rs pattern: the frontend owns parsing/validation (`src/toolkit/objects/schema.ts`), these commands only move text; listing failures degrade to "no objects", never errors.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::workspace::{self, require_root, validate_slug, SettingsState};

/// The objects folder inside the workspace root; reserved as a project slug in `create_project`.
pub const OBJECTS_DIR_NAME: &str = "objects";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectListing {
    pub slug: String,
    /// The raw `object.json` text, parsed and validated frontend-side.
    pub json: String,
    /// Absolute object folder; the frontend builds glb/thumbnail URLs from it (native owns paths).
    pub dir: String,
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
            let dir = path.to_string_lossy().into_owned();
            objects.push(ObjectListing { slug, json, dir });
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
) -> Result<ObjectListing, String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    let dir = root.join(OBJECTS_DIR_NAME).join(&slug);
    let json = std::fs::read_to_string(dir.join("object.json"))
        .map_err(|e| format!("reading object \"{slug}\": {e}"))?;
    Ok(ObjectListing {
        slug,
        json,
        dir: dir.to_string_lossy().into_owned(),
    })
}

fn objects_root(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<PathBuf, String> {
    let dir = require_root(app, state)?.join(OBJECTS_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Import a picked .glb into the library: native-side copy (the import_media shape, no bytes over IPC), a slugified auto-suffixed folder, and an atomic starter manifest. Returns the new slug.
#[tauri::command]
pub fn import_object(
    app: AppHandle,
    state: State<'_, SettingsState>,
    name: String,
    source_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("no file at {source_path}"));
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if ext != "glb" {
        return Err("objects import as .glb (glTF binary) only".into());
    }
    let display = name.trim();
    let mut base = workspace::slugify(if display.is_empty() {
        "object"
    } else {
        display
    });
    if base.is_empty() {
        base = "object".into();
    }
    let root = objects_root(&app, &state)?;
    let mut slug = base.clone();
    let mut n = 1u32;
    while root.join(&slug).exists() {
        n += 1;
        slug = format!("{base}-{n}");
    }
    let dir = root.join(&slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&source, dir.join("model.glb")).map_err(|e| format!("copying the glb: {e}"))?;
    let manifest = serde_json::json!({
        "version": 1,
        "id": slug,
        "name": if display.is_empty() { slug.as_str() } else { display },
        "glb": "model.glb",
        "thumbnail": "thumbnail.png",
    });
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let path = dir.join("object.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(slug)
}

/// Write an object's thumbnail.png from a raw PNG body (the write_theme_preview shape).
#[tauri::command]
pub fn write_object_thumbnail(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let slug = request
        .headers()
        .get("x-kookaburra-slug")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or("missing x-kookaburra-slug header")?;
    validate_slug(&slug)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_object_thumbnail expects a raw binary body".into());
    };
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if bytes.len() < 8 || bytes[..4] != PNG_MAGIC {
        return Err("object thumbnail body is not a PNG".into());
    }
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("object thumbnail too large".into());
    }
    let dir = objects_root(&app, &state)?.join(&slug);
    if !dir.join("object.json").is_file() {
        return Err(format!("no object named {slug}"));
    }
    std::fs::write(dir.join("thumbnail.png"), bytes).map_err(|e| e.to_string())
}
