//! The packs window (label `packs`): export a `.kbpack`, or import one. A window rather than a modal because export spans
//! eight categories with a dependency tree, and import must be openable from a double-clicked file at any moment.
//!
//! Native drag-drop stays ENABLED here (unlike the editor window), because a dropped `.kbpack` must arrive as a real path.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// What the window should show on mount. Read once by `get_packs_target`, or pushed as an event when the window already exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum PacksTarget {
    Export,
    Import {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        /// Packs still waiting after this one, so the summary screen can offer "Next pack".
        #[serde(default)]
        queued: usize,
    },
}

#[derive(Default)]
pub struct PacksState {
    pub target: Mutex<Option<PacksTarget>>,
    /// Extra paths from a multi-file Open. Imported one at a time: resolving conflicts across overlapping packs has no good UI.
    pub queue: Mutex<VecDeque<PathBuf>>,
}

impl PacksState {
    pub fn set_target(&self, target: PacksTarget) {
        if let Ok(mut guard) = self.target.lock() {
            *guard = Some(target);
        }
    }

    pub fn push_queue(&self, paths: Vec<PathBuf>) {
        if let Ok(mut guard) = self.queue.lock() {
            guard.extend(paths);
        }
    }

    pub fn queued(&self) -> usize {
        self.queue.lock().map(|q| q.len()).unwrap_or(0)
    }

    pub fn take_next(&self) -> Option<PathBuf> {
        self.queue.lock().ok().and_then(|mut q| q.pop_front())
    }
}

/// Open or focus the packs window; the `packs` label picks up `capabilities/packs.json` at runtime.
pub(crate) fn open_packs_window(app: &AppHandle, target: PacksTarget) -> Result<(), String> {
    let state = app.state::<PacksState>();
    state.set_target(target.clone());

    if let Some(win) = app.get_webview_window("packs") {
        let _ = win.emit("kookaburra://packs-target", target);
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, "packs", WebviewUrl::App("packs.html".into()))
        .title("Kookaburra Cut — Packs")
        .inner_size(1000.0, 720.0)
        .min_inner_size(860.0, 600.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x0E, 0x11, 0x13, 0xFF));
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 20.0));

    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::deflash_webview(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

#[tauri::command]
pub fn get_packs_target(state: State<'_, PacksState>) -> Option<PacksTarget> {
    state.target.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn open_pack_export(app: AppHandle) -> Result<(), String> {
    open_packs_window(&app, PacksTarget::Export)
}

#[tauri::command]
pub fn open_pack_import(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let queued = app.state::<PacksState>().queued();
    open_packs_window(&app, PacksTarget::Import { path, queued })
}

/// Pull the next queued pack after one finishes, so a multi-file Open drains in order.
#[tauri::command]
pub fn next_queued_pack(app: AppHandle, state: State<'_, PacksState>) -> Option<PacksTarget> {
    let next = state.take_next()?;
    let target = PacksTarget::Import {
        path: Some(next.to_string_lossy().into_owned()),
        queued: state.queued(),
    };
    state.set_target(target.clone());
    let _ = app.emit("kookaburra://packs-target", target.clone());
    Some(target)
}

/// A path handed to us by the OS (Open With, drag-drop) before it is allowed anywhere near the reader.
pub fn validate_incoming(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{} no longer exists.", path.display()));
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext != crate::pack::limits::PACK_EXTENSION {
        return Err(format!(
            "{} is not a Kookaburra Pack.",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(())
}

/// `file://` URLs from `RunEvent::Opened`, percent-decoded. A pack on a path with spaces or non-ASCII must work.
pub fn paths_from_urls(urls: &[url::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_non_packs() {
        let dir = std::env::temp_dir().join("kbpack-validate-test");
        let _ = std::fs::create_dir_all(&dir);

        let missing = dir.join("nope.kbpack");
        assert!(validate_incoming(&missing).is_err());

        let wrong = dir.join("thing.zip");
        std::fs::write(&wrong, b"x").unwrap();
        assert!(validate_incoming(&wrong)
            .unwrap_err()
            .contains("not a Kookaburra Pack"));

        assert!(validate_incoming(&dir).unwrap_err().contains("not a file"));

        let good = dir.join("thing.kbpack");
        std::fs::write(&good, b"x").unwrap();
        assert!(validate_incoming(&good).is_ok());

        let upper = dir.join("thing.KBPACK");
        std::fs::write(&upper, b"x").unwrap();
        assert!(validate_incoming(&upper).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The exact JSON `src/packs/PacksApp.tsx` switches on. `rename_all` renames the VARIANTS here, so the tag is
    /// lowercase; comparing against "Export" silently rendered the import flow for every export.
    #[test]
    fn target_tag_is_lowercase_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&PacksTarget::Export).unwrap(),
            r#"{"mode":"export"}"#
        );
        assert_eq!(
            serde_json::to_string(&PacksTarget::Import {
                path: None,
                queued: 0
            })
            .unwrap(),
            r#"{"mode":"import","queued":0}"#
        );
    }

    #[test]
    fn queue_drains_in_order() {
        let state = PacksState::default();
        state.push_queue(vec![PathBuf::from("/a.kbpack"), PathBuf::from("/b.kbpack")]);
        assert_eq!(state.queued(), 2);
        assert_eq!(state.take_next(), Some(PathBuf::from("/a.kbpack")));
        assert_eq!(state.take_next(), Some(PathBuf::from("/b.kbpack")));
        assert_eq!(state.take_next(), None);
    }
}
