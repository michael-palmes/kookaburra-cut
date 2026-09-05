//! The theme editor window (label `theme-editor`): one theme document at a time, edited as a raw JSON draft so the
//! `catalogue` block and any forward-compatible fields survive a round trip. A window rather than a modal because the
//! sections span the whole schema and the live specimen wants its own canvas beside the form.
//!
//! Opening is check-and-focus with a retarget event, the video editor's pattern: a second Edit… on another card
//! retargets the open window instead of stacking a new one.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Which theme the window loads on mount. Read once by `get_theme_editor_target`, or pushed as an event when the
/// window already exists. The id carries its own scope: `ws:<slug>` for a workspace theme, a bare id for a bundled one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEditorTarget {
    pub theme_id: String,
}

#[derive(Default)]
pub struct ThemeEditorState(pub Mutex<Option<ThemeEditorTarget>>);

/// Open or focus the theme editor on `target`; the `theme-editor` label picks up `capabilities/theme-editor.json` at runtime.
pub(crate) fn open_theme_editor(app: &AppHandle, target: ThemeEditorTarget) -> Result<(), String> {
    if target.theme_id.trim().is_empty() {
        return Err("the theme editor needs a theme id".into());
    }
    if let Ok(mut guard) = app.state::<ThemeEditorState>().0.lock() {
        *guard = Some(target.clone());
    }

    if let Some(win) = app.get_webview_window("theme-editor") {
        let _ = win.emit("kookaburra://theme-editor-target", target);
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        app,
        "theme-editor",
        WebviewUrl::App("theme-editor.html".into()),
    )
    .title("Kookaburra Cut — Theme")
    .inner_size(1280.0, 860.0)
    .min_inner_size(1020.0, 660.0)
    .resizable(true)
    .theme(Some(tauri::Theme::Dark))
    // --surface-window; the NSWindow layer of the anti-flash work.
    .background_color(tauri::window::Color(0x0D, 0x10, 0x16, 0xFF));
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
pub fn open_theme_editor_window(app: AppHandle, theme_id: String) -> Result<(), String> {
    open_theme_editor(&app, ThemeEditorTarget { theme_id })
}

#[tauri::command]
pub fn get_theme_editor_target(state: State<'_, ThemeEditorState>) -> Option<ThemeEditorTarget> {
    state.0.lock().ok().and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact JSON `src/ui/theme-editor/ThemeEditorApp.tsx` reads; a snake_case field would silently retarget to nothing.
    #[test]
    fn target_travels_as_camel_case() {
        let target = ThemeEditorTarget {
            theme_id: "ws:studio-white".into(),
        };
        assert_eq!(
            serde_json::to_string(&target).unwrap(),
            r#"{"themeId":"ws:studio-white"}"#
        );
        assert_eq!(
            serde_json::from_str::<ThemeEditorTarget>(r#"{"themeId":"aurora"}"#).unwrap(),
            ThemeEditorTarget {
                theme_id: "aurora".into()
            }
        );
    }
}
