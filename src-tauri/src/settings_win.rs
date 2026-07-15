//! The app Settings window: a small native-chrome window opened from the application menu ("Settings...", Cmd+,), scoped to cache management (media previews + clip extractions: sizes on disk, per-cache clear) and read-only info (workspace path, sidecar versions; app version lives frontend-side).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::media;

/// Open (or focus) the settings window; native titlebar, should feel like a stock macOS Settings panel, not app chrome.
pub(crate) fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(520.0, 480.0)
        .resizable(false)
        .maximizable(false)
        .theme(Some(tauri::Theme::Dark))
        // --surface-window; the NSWindow layer of the anti-flash work.
        .background_color(tauri::window::Color(0x0E, 0x11, 0x13, 0xFF))
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::deflash_webview(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

fn clips_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("clips"))
}

fn dir_bytes(dir: &Path) -> u64 {
    let mut bytes = 0u64;
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                bytes += dir_bytes(&path);
            } else if let Ok(md) = entry.metadata() {
                bytes += md.len();
            }
        }
    }
    bytes
}

/// Top-level cache entries (sha dirs); `skip` excludes bookkeeping dirs like `by-path`.
fn dir_entries(dir: &Path, skip: &str) -> u64 {
    std::fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy() != skip)
                .count() as u64
        })
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    media_bytes: u64,
    media_entries: u64,
    clips_bytes: u64,
    clips_entries: u64,
}

#[tauri::command]
pub fn cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let media_dir = media::media_cache_root(&app)?;
    let clips_dir = clips_cache_root(&app)?;
    Ok(CacheStats {
        media_bytes: dir_bytes(&media_dir),
        media_entries: dir_entries(&media_dir, "by-path"),
        clips_bytes: dir_bytes(&clips_dir),
        clips_entries: dir_entries(&clips_dir, ""),
    })
}

/// Clear the media-preview cache (posters/scrub frames/stamps); open browsers re-scan via the media-changed broadcast and regenerate on view.
#[tauri::command]
pub fn clear_media_cache(app: AppHandle) -> Result<(), String> {
    let dir = media::media_cache_root(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("kookaburra://media-changed", ());
    Ok(())
}

/// Clear the clip-extraction cache (CFR PNG sequences); refused while an export is running, since the export loop reads extracted frames from it.
#[tauri::command]
pub fn clear_clips_cache(
    app: AppHandle,
    export: State<'_, crate::ExportState>,
) -> Result<(), String> {
    if export.busy() {
        return Err("an export is running — clear the clip cache after it finishes".into());
    }
    let dir = clips_cache_root(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // Mounted videos hold in-memory extractions keyed to this cache; tell the main window to drop them.
    let _ = app.emit("kookaburra://clips-cache-cleared", ());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarVersions {
    ffmpeg: String,
    ffprobe: String,
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_owned()
}

#[tauri::command]
pub async fn sidecar_versions(app: AppHandle) -> Result<SidecarVersions, String> {
    let ffmpeg = media::run_sidecar(&app, "ffmpeg", vec!["-version".into()]).await?;
    let ffprobe = media::run_sidecar(&app, "ffprobe", vec!["-version".into()]).await?;
    Ok(SidecarVersions {
        ffmpeg: first_line(&ffmpeg),
        ffprobe: first_line(&ffprobe),
    })
}
