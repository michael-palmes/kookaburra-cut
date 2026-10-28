//! Native confirmations a webview cannot answer: an `NSAlert` sheet issued from Rust on the window that asked, so a compromised webview can show the question but never press the button (docs/decisions.md, "Native consent").

use tauri::AppHandle;

/// One two-button question. The default button answers Return; the alert decides nothing else.
pub struct Prompt<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub default_button: &'a str,
    pub other_button: &'a str,
}

/// Show `prompt` as a sheet on the window labelled `parent` (app-modal when that window is gone) and resolve to whether the DEFAULT button was chosen.
#[cfg(target_os = "macos")]
pub async fn ask(app: &AppHandle, parent: &str, prompt: Prompt<'_>) -> Result<bool, String> {
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponse, NSWindow,
    };
    use objc2_foundation::{MainThreadMarker, NSString};
    use tauri::Manager;

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let title = prompt.title.to_owned();
    let body = prompt.body.to_owned();
    let default_button = prompt.default_button.to_owned();
    let other_button = prompt.other_button.to_owned();
    let parent = parent.to_owned();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        // run_on_main_thread guarantees the marker AppKit requires.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&title));
        alert.setInformativeText(&NSString::from_str(&body));
        alert.setAlertStyle(NSAlertStyle::Warning);
        let _ = alert.addButtonWithTitle(&NSString::from_str(&default_button));
        let _ = alert.addButtonWithTitle(&NSString::from_str(&other_button));
        let window = handle
            .get_webview_window(&parent)
            .filter(|w| w.is_visible().unwrap_or(false));
        let ns_window = window.as_ref().and_then(|w| w.ns_window().ok());
        match (window, ns_window) {
            (Some(window), Some(ptr)) => {
                let _ = window.set_focus();
                let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                let tx = std::sync::Mutex::new(Some(tx));
                let handler = block2::RcBlock::new(move |response: NSModalResponse| {
                    if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send(response == NSAlertFirstButtonReturn);
                    }
                });
                alert.beginSheetModalForWindow_completionHandler(ns_window, Some(&handler));
            }
            _ => {
                let response = alert.runModal();
                let _ = tx.send(response == NSAlertFirstButtonReturn);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "the confirmation closed without an answer".to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn ask(_app: &AppHandle, _parent: &str, _prompt: Prompt<'_>) -> Result<bool, String> {
    Err("native confirmations are only available on macOS".into())
}
