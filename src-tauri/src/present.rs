//! Present window: live video/slideshow playback of a project in a chromeless second window (label `present`). Playback is interactive and wall-clock driven, never part of the byte-identical export path; the window loads the project from disk itself, so the only cross-window state is the launch target below.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// A display rectangle captured client-side when the display is picked (logical coordinates).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the present window should play; managed state read once on boot (`get_present_target`). Strings stay loose here (mode/quality/aspect are frontend enums) since nothing Rust-side branches on them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentTarget {
    pub project_id: String,
    pub mode: String,
    pub quality: String,
    pub aspect: String,
    pub soundtrack: bool,
    pub fullscreen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<MonitorRect>,
}

/// The pending present target (set just before the window opens / is refocused).
#[derive(Default)]
pub struct PresentState(pub Mutex<Option<PresentTarget>>);

/// Open the present window, retargeting and focusing it if it already exists; the `present` label picks up `capabilities/present.json` at runtime.
fn open_present_window(app: &AppHandle, target: &PresentTarget) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("present") {
        let _ = win.emit("kookaburra://present-target", target.clone());
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "present", WebviewUrl::App("present.html".into()))
        .title("Kookaburra Cut — Present")
        .inner_size(1280.0, 720.0)
        .min_inner_size(480.0, 270.0)
        // Chromeless: pure content for screen sharing; the page supplies its own drag region.
        .decorations(false)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x00, 0x00, 0x00, 0xFF));
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::deflash_webview(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

/// Stash the target and open/refocus the present window.
#[tauri::command]
pub fn open_present(
    app: AppHandle,
    present: State<'_, PresentState>,
    target: PresentTarget,
) -> Result<(), String> {
    *present.0.lock().map_err(|_| "present state poisoned")? = Some(target.clone());
    open_present_window(&app, &target)
}

/// The pending present target (read once by the present window on boot).
#[tauri::command]
pub fn get_present_target(
    present: State<'_, PresentState>,
) -> Result<Option<PresentTarget>, String> {
    Ok(present.0.lock().map_err(|_| "present state poisoned")?.clone())
}
