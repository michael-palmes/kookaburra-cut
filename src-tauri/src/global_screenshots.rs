//! Global screenshots: a flat workspace folder (`~/Kookaburra Cut/screenshots/`) any project's picker can browse. Picking always copies into the project's `assets/` (copy-on-use, via the existing `import_media`), so projects never reference the shared folder in place; previews ride the same content-hash media cache as project assets.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::media::{self, MediaMeta};
use crate::workspace::{self, SettingsState};

const SCREENSHOTS_DIR: &str = "screenshots";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalScreenshot {
    pub name: String,
    /// Absolute path: the webview previews it via the asset protocol, and copy-on-use imports it.
    pub abs_path: String,
}

fn screenshots_root(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<PathBuf, String> {
    let root = workspace::require_root(app, state)?;
    let dir = root.join(SCREENSHOTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("invalid screenshot name: {name}"));
    }
    Ok(())
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Copy `source` into `dir` under the first free `base.ext`, `base-2.ext`, … (the import_media convention); returns the chosen name.
fn copy_with_free_name(source: &Path, dir: &Path) -> Result<String, String> {
    let ext = extension_of(source);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("screenshot");
    let mut base = workspace::slugify(stem);
    if base.is_empty() {
        base = "screenshot".into();
    }
    let mut candidate = format!("{base}.{ext}");
    let mut n = 1u32;
    while dir.join(&candidate).exists() {
        n += 1;
        candidate = format!("{base}-{n}.{ext}");
    }
    std::fs::copy(source, dir.join(&candidate))
        .map_err(|e| format!("copying {}: {e}", source.display()))?;
    Ok(candidate)
}

/// Every media file in the global folder, newest first.
#[tauri::command]
pub fn list_global_screenshots(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<GlobalScreenshot>, String> {
    let dir = screenshots_root(&app, &state)?;
    let mut entries: Vec<(std::time::SystemTime, GlobalScreenshot)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = extension_of(&path);
        if !workspace::MEDIA_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((
            modified,
            GlobalScreenshot {
                name: name.to_string(),
                abs_path: path.to_string_lossy().into_owned(),
            },
        ));
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.0));
    Ok(entries.into_iter().map(|(_, s)| s).collect())
}

/// Copy external files into the global folder; returns the stored names.
#[tauri::command]
pub fn import_global_screenshots(
    app: AppHandle,
    state: State<'_, SettingsState>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let dir = screenshots_root(&app, &state)?;
    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        let ext = extension_of(&source);
        if !workspace::MEDIA_EXTENSIONS.contains(&ext.as_str()) {
            log::warn!("skipping non-media screenshot import: {}", source.display());
            continue;
        }
        imported.push(copy_with_free_name(&source, &dir)?);
    }
    Ok(imported)
}

/// Metadata + thumbnails for one global screenshot (the shared content-hash cache, so a file that also lives in a project dedupes).
#[tauri::command]
pub async fn global_screenshot_meta(
    app: AppHandle,
    state: State<'_, SettingsState>,
    name: String,
) -> Result<MediaMeta, String> {
    validate_name(&name)?;
    let dir = screenshots_root(&app, &state)?;
    let abs = dir.join(&name);
    if !abs.is_file() {
        return Err(format!("screenshot not found: {name}"));
    }
    media::ensure_media_cache(&app, &abs, &name).await
}

/// The media-card action: copy a project asset out to the global folder; returns the stored name.
#[tauri::command]
pub fn copy_to_global_screenshots(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<String, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let source = media::resolve_asset(&root, &slug, &rel)?;
    if !source.is_file() {
        return Err(format!("asset not found: {rel}"));
    }
    let dir = screenshots_root(&app, &state)?;
    copy_with_free_name(&source, &dir)
}

#[cfg(test)]
mod copy_naming_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-gs-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn free_names_never_collide() {
        let dir = scratch("names");
        let source = dir.join("My Shot.PNG");
        std::fs::write(&source, b"png").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        assert_eq!(copy_with_free_name(&source, &out).unwrap(), "my-shot.png");
        assert_eq!(copy_with_free_name(&source, &out).unwrap(), "my-shot-2.png");
        assert_eq!(copy_with_free_name(&source, &out).unwrap(), "my-shot-3.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn junk_stems_fall_back_and_names_validate() {
        let dir = scratch("junk");
        let source = dir.join("---.png");
        std::fs::write(&source, b"png").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        assert_eq!(copy_with_free_name(&source, &out).unwrap(), "screenshot.png");
        assert!(validate_name("shot.png").is_ok());
        assert!(validate_name("../evil.png").is_err());
        assert!(validate_name("a/b.png").is_err());
        assert!(validate_name("").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
