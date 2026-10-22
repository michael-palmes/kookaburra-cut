//! The app Settings window: a small native-chrome window opened from the application menu ("Settings...", Cmd+,), scoped to cache management (media previews + clip extractions: sizes on disk, per-cache clear, the clip cache cap) and read-only info (workspace path, sidecar versions; app version lives frontend-side).

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{clip_cache, media, workspace};

/// The webview's way in (the Claude launcher's Claude settings… item); the menu's ⌘, calls the helper directly.
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

/// Open (or focus) the settings window; native titlebar, should feel like a stock macOS Settings panel, not app chrome.
pub(crate) fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
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

fn dir_bytes(dir: &Path) -> u64 {
    clip_cache::dir_bytes(dir)
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
    /// The clip cache's cap (Settings, default 20 GB); eviction keeps the cache under it.
    clips_cap_bytes: u64,
}

#[tauri::command]
pub fn cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let media_dir = media::media_cache_root(&app)?;
    let clips_dir = clip_cache::clips_root(&app)?;
    Ok(CacheStats {
        media_bytes: dir_bytes(&media_dir),
        media_entries: dir_entries(&media_dir, "by-path"),
        clips_bytes: dir_bytes(&clips_dir),
        clips_entries: dir_entries(&clips_dir, ""),
        clips_cap_bytes: clip_cache::cap_bytes(&app),
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

/// Clear the clip-extraction cache (CFR PNG sequences): refused while an export runs (the loop reads extracted frames from it), deferred while another terminal run is queued (other sessions' gates read it too).
#[tauri::command]
pub fn clear_clips_cache(app: AppHandle) -> Result<clip_cache::ClearOutcome, String> {
    clip_cache::clear(&app)
}

/// The largest clip cache cap Settings accepts, in GB.
const MAX_CLIP_CACHE_CAP_GB: u32 = 1000;

/// Set the clip cache cap; a lower cap evicts least recently used chunks straight away (never pinned ones).
#[tauri::command]
pub fn set_clip_cache_cap(
    app: AppHandle,
    state: State<'_, workspace::SettingsState>,
    gb: u32,
) -> Result<(), String> {
    if !(1..=MAX_CLIP_CACHE_CAP_GB).contains(&gb) {
        return Err(format!(
            "the clip cache cap must be 1 to {MAX_CLIP_CACHE_CAP_GB} GB, got {gb}"
        ));
    }
    workspace::update_settings(&app, &state, |settings| {
        settings.clip_cache_cap_gb = Some(gb)
    })?;
    clip_cache::recheck_cap(&app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarVersions {
    ffmpeg: String,
    ffprobe: String,
}

/// What the bundled sidecar's VideoToolbox support actually covers, probed live so a swapped sidecar can't lie.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareVideoSupport {
    decode: bool,
    h264: bool,
    hevc: bool,
    prores: bool,
}

#[tauri::command]
pub async fn hardware_video_support(app: AppHandle) -> Result<HardwareVideoSupport, String> {
    let encoders = media::run_sidecar(
        &app,
        "ffmpeg",
        vec!["-hide_banner".into(), "-encoders".into()],
        media::SidecarPriority::Foreground,
    )
    .await?;
    let hwaccels = media::run_sidecar(
        &app,
        "ffmpeg",
        vec!["-hide_banner".into(), "-hwaccels".into()],
        media::SidecarPriority::Foreground,
    )
    .await?;
    Ok(HardwareVideoSupport {
        decode: hwaccels.contains("videotoolbox"),
        h264: encoders.contains("h264_videotoolbox"),
        hevc: encoders.contains("hevc_videotoolbox"),
        prores: encoders.contains("prores_videotoolbox"),
    })
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_owned()
}

#[tauri::command]
pub async fn sidecar_versions(app: AppHandle) -> Result<SidecarVersions, String> {
    let ffmpeg = media::run_sidecar(
        &app,
        "ffmpeg",
        vec!["-version".into()],
        media::SidecarPriority::Foreground,
    )
    .await?;
    let ffprobe = media::run_sidecar(
        &app,
        "ffprobe",
        vec!["-version".into()],
        media::SidecarPriority::Foreground,
    )
    .await?;
    Ok(SidecarVersions {
        ffmpeg: first_line(&ffmpeg),
        ffprobe: first_line(&ffprobe),
    })
}
