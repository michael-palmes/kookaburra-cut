//! The app Settings window: a small native-chrome window opened from the application menu ("Settings...", Cmd+,), scoped to cache management (media previews + clip extractions: sizes on disk, per-cache clear, the clip cache cap), forgetting an Allow, clearing all app data, the log folder and read-only info (workspace path, sidecar versions; app version lives frontend-side).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{bridge, clip_cache, media, native_alert, privacy, workspace};

const LOG_DIR: &str = "logs";
/// `cache/` entries the files half of a clear leaves: the Spotlight marker, and the two caches whose own clears tell the windows.
const CACHE_KEPT: [&str; 3] = [privacy::NEVER_INDEX_MARKER, "clips", "media"];
/// The bridge folders a clear empties: queued and answered requests and the per-process heartbeats. kb's export records, film runs, video scratch and font verdicts stay.
const BRIDGE_QUEUES: [&str; 3] = ["responses", "requests", "apps"];

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
            .min_inner_size(440.0, 360.0)
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
    clear_media(&app)
}

fn clear_media(app: &AppHandle) -> Result<(), String> {
    let dir = media::media_cache_root(app)?;
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

/// Settings ▸ Allowed projects: forget one Allow (a workspace slug, `ws-template:` or `ws-preset:` id), stored and session alike, so the next open asks again. It only narrows what runs, so no sheet confirms it.
#[tauri::command]
pub fn forget_allowed_project(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, workspace::SettingsState>,
    trust: State<'_, workspace::TrustState>,
    slug: String,
) -> Result<(), String> {
    workspace::require_window(&window, "settings")?;
    let open = workspace::load_settings(&app, &state)?.last_project;
    if open.as_deref() == Some(main_window_id(&slug).as_str()) {
        return Err("that project is open: close it in Kookaburra Cut first".into());
    }
    workspace::forget_project_trust(&app, &state, &trust, &slug)?;
    log::info!(
        "[trust] {}: forgotten in Settings",
        crate::audit::field(&slug)
    );
    Ok(())
}

/// A grant's key as the main window names the project: workspace slugs carry `ws:`, library ids already have their scope.
fn main_window_id(key: &str) -> String {
    if key.contains(':') {
        key.to_owned()
    } else {
        format!("ws:{key}")
    }
}

/// Why Clear all app data must wait: each of these reads what the clear removes.
fn clear_blocked(app: &AppHandle) -> Option<&'static str> {
    if app.state::<crate::ExportState>().busy() {
        Some("an export is running: clear app data after it finishes")
    } else if app.state::<crate::pack::commands::PackState>().importing() {
        Some("a pack import is open: finish or cancel it before clearing app data")
    } else if crate::edit::rendering_edit(app).is_some() {
        Some("the video editor is rendering: clear app data after it finishes")
    } else if clip_cache::other_autorun_queued(app) {
        Some("a terminal run is using the app's caches: clear app data after it finishes")
    } else {
        None
    }
}

/// Settings ▸ Storage ▸ Clear all app data, behind a native sheet whose Return is Cancel (a webview can ask, only a person can confirm). Every cache, the bridge's queues, terminal run folders, window positions, every grant and every preference but the workspace location and the update answer go; projects, the workspace, the pack signing key and the log stay. False when the person cancels.
#[tauri::command]
pub async fn clear_app_data(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, workspace::SettingsState>,
    trust: State<'_, workspace::TrustState>,
) -> Result<bool, String> {
    workspace::require_window(&window, "settings")?;
    if let Some(why) = clear_blocked(&app) {
        return Err(why.into());
    }
    let declined = native_alert::ask(
        &app,
        "settings",
        native_alert::Prompt {
            title: "Clear all app data?",
            body: "Kookaburra Cut forgets every project you allowed, your recent projects and preferences, and empties its caches. Each project asks again before it runs.\n\nYour projects, workspace and pack signing key stay.",
            default_button: "Cancel",
            other_button: "Clear All Data",
        },
    )
    .await?;
    if declined {
        return Ok(false);
    }
    // The sheet can stay up a while, and an export started meanwhile reads these caches.
    if let Some(why) = clear_blocked(&app) {
        return Err(why.into());
    }
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    workspace::forget_session_trust(&trust);
    bridge::forget_session_grants(&app);
    if let Err(e) = workspace::reset_settings(&app, &state) {
        failed.push(format!("settings: {e}"));
    } else {
        crate::agent_gate::note(None);
        bridge::apply_gate(&app);
        let _ = app.emit(crate::agent_gate::CHANGED_EVENT, ());
    }
    if let Err(e) = clip_cache::clear(&app) {
        failed.push(format!("clip cache: {e}"));
    }
    if let Err(e) = clear_media(&app) {
        failed.push(format!("media previews: {e}"));
    }
    let autorun = app
        .path()
        .home_dir()
        .ok()
        .map(|home| home.join(workspace::WORKSPACE_DIR_NAME).join("_autorun"));
    failed.extend(clear_files(
        &app_data,
        bridge::bridge_root_without_app().as_deref(),
        autorun.as_deref(),
    ));
    privacy::seal_cache_roots(&app_data);
    log::info!(
        "[settings] cleared all app data; {} part(s) could not be cleared",
        failed.len()
    );
    let _ = app.emit("kookaburra://app-data-cleared", ());
    if failed.is_empty() {
        Ok(true)
    } else {
        Err(format!(
            "Some app data could not be cleared: {}",
            failed.join("; ")
        ))
    }
}

/// The files half of the clear: the rest of `cache/`, the window geometry, the bridge queues and the terminal runs. Returns what stayed, by path.
fn clear_files(app_data: &Path, bridge: Option<&Path>, autorun: Option<&Path>) -> Vec<String> {
    let mut stayed = Vec::new();
    let cache = app_data.join("cache");
    let mut targets: Vec<PathBuf> = match real_root(&cache, &mut stayed) {
        Some(cache) => std::fs::read_dir(cache)
            .map(|read| {
                read.flatten()
                    .filter(|entry| !CACHE_KEPT.iter().any(|kept| entry.file_name() == *kept))
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };
    targets.push(app_data.join(".window-state.json"));
    if let Some(bridge) = bridge.and_then(|root| real_root(root, &mut stayed)) {
        targets.extend(BRIDGE_QUEUES.iter().map(|name| bridge.join(name)));
    }
    if let Some(autorun) = autorun.and_then(|root| real_root(root, &mut stayed)) {
        targets.push(autorun.join("runs"));
    }
    stayed.extend(targets.into_iter().filter_map(|path| {
        remove_entry(&path)
            .err()
            .map(|e| format!("{}: {e}", path.display()))
    }));
    stayed
}

/// A root the clear works inside, only when it is a real folder; a link or file there is reported and never followed.
fn real_root<'a>(root: &'a Path, stayed: &mut Vec<String>) -> Option<&'a Path> {
    if crate::real_dir::is_real_dir(root) {
        return Some(root);
    }
    if std::fs::symlink_metadata(root).is_ok() {
        stayed.push(format!(
            "{}: not a folder, so it was left alone",
            root.display()
        ));
    }
    None
}

/// A file, folder or link removed without following a link; already gone counts as removed.
fn remove_entry(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    }
}

/// Settings ▸ About ▸ Activity log: Finder at `$APPDATA/logs`, made owner-only and unindexed first when no launch has written it yet. `reveal_in_finder` reaches only the workspace, so this names its one folder itself.
#[tauri::command]
pub fn reveal_app_logs(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    workspace::require_window(&window, "settings")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(LOG_DIR);
    privacy::private_dir(&dir).map_err(|e| e.to_string())?;
    if !crate::real_dir::is_real_dir(&dir) {
        return Err("the log folder is a link, so Kookaburra Cut won't open it".into());
    }
    privacy::never_index(&dir).map_err(|e| e.to_string())?;
    let log = dir.join("app.log");
    let mut open = std::process::Command::new("open");
    if log.is_file() {
        open.arg("-R").arg(&log);
    } else {
        open.arg(&dir);
    }
    open.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Settings ▸ About ▸ Acknowledgements: Finder at the bundle's `licenses` folder, the notices selected when this build carries them.
#[tauri::command]
pub fn reveal_licences(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    workspace::require_window(&window, "settings")?;
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("licenses");
    if !dir.is_dir() {
        return Err("this build carries no licences folder".into());
    }
    let notices = dir.join("THIRD-PARTY-NOTICES.txt");
    let mut open = std::process::Command::new("open");
    if notices.is_file() {
        open.arg("-R").arg(&notices);
    } else {
        open.arg(&dir);
    }
    open.spawn().map(|_| ()).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn a_grant_key_matches_the_main_windows_project_id() {
        assert_eq!(main_window_id("product-tour"), "ws:product-tour");
        assert_eq!(
            main_window_id("ws-template:launch-kit"),
            "ws-template:launch-kit"
        );
    }

    #[test]
    fn clearing_app_data_removes_caches_and_queues_and_keeps_the_key_log_and_records() {
        let root = std::env::temp_dir().join(format!("kc-clear-all-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, bridge, autorun) = (
            root.join("data"),
            root.join("_bridge"),
            root.join("_autorun"),
        );
        let outside = root.join("outside");
        touch(&outside.join("keep.txt"));
        let gone = [
            data.join("cache/theme-previews/a.jpg"),
            data.join("cache/beats/a.json"),
            data.join("cache/loudness/a.json"),
            data.join("cache/font-embedding.json"),
            data.join("cache/tapdot/a.png"),
            data.join("cache/export-mezz/a.mkv"),
            data.join("cache/export-audio/a.m4a"),
            data.join(".window-state.json"),
            bridge.join("responses/a.json"),
            bridge.join("requests/.claimed/a.json"),
            bridge.join("apps/1.json"),
            autorun.join("runs/r1/last-run.json"),
        ];
        let kept = [
            data.join("settings.json"),
            data.join("pack-key/identity.json"),
            data.join("pack-key-dev/ed25519.key"),
            data.join("logs/app.log"),
            data.join("cache").join(privacy::NEVER_INDEX_MARKER),
            data.join("cache/clips/a/0001.png"),
            data.join("cache/media/a/poster.jpg"),
            bridge.join("app.json"),
            bridge.join("cli.json"),
            bridge.join("font-verdicts.json"),
            bridge.join("exports/p/a.json"),
            bridge.join("film/p/run/a.png"),
            bridge.join("video/p/drafts/a.json"),
            autorun.join("queue/t.json"),
        ];
        for path in gone.iter().chain(&kept) {
            touch(path);
        }
        std::os::unix::fs::symlink(&outside, data.join("cache/linked")).unwrap();

        assert!(clear_files(&data, Some(&bridge), Some(&autorun)).is_empty());
        for path in &gone {
            assert!(!path.exists(), "{} should go", path.display());
        }
        for path in &kept {
            assert!(path.exists(), "{} should stay", path.display());
        }
        assert!(
            std::fs::symlink_metadata(data.join("cache/linked")).is_err(),
            "the link goes"
        );
        assert!(outside.join("keep.txt").exists(), "never what it points at");
        assert!(
            clear_files(&data, None, None).is_empty(),
            "a second clear finds nothing to fail on"
        );
        let linked_bridge = root.join("linked-bridge");
        touch(&outside.join("responses/a.json"));
        std::os::unix::fs::symlink(&outside, &linked_bridge).unwrap();
        assert_eq!(clear_files(&data, Some(&linked_bridge), None).len(), 1);
        assert!(
            outside.join("responses/a.json").exists(),
            "a linked root is never cleared through"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
