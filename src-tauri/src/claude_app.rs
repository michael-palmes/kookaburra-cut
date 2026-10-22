//! Edit with Claude: open a project in the Claude desktop app (`claude://code/new`), or Finder and the download page as fallbacks.

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, State};

use crate::workspace::{self, SettingsState};

/// The desktop app truncates `q` here; capping first keeps the `open` argv small too.
const MAX_PROMPT_CHARS: usize = 14_336;
const DOWNLOAD_URL: &str = "https://claude.ai/download";

/// `claude://code/new?folder=…&q=…`, form-encoded the way the app's URLSearchParams reads it back.
fn code_session_link(folder: &Path, prompt: Option<&str>) -> String {
    let mut url = url::Url::parse("claude://code/new").expect("static URL");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("folder", &folder.to_string_lossy());
        if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
            let capped: String = prompt.chars().take(MAX_PROMPT_CHARS).collect();
            query.append_pair("q", &capped);
        }
    }
    url.into()
}

/// Whether any app handles `claude://`; LaunchServices answers, so a moved or renamed install still counts.
#[cfg(target_os = "macos")]
fn claude_app_installed() -> bool {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    // The async command calls this from a worker thread, which has no pool of its own.
    autoreleasepool(|_| {
        let Some(url) = NSURL::URLWithString(&NSString::from_str("claude://code/new")) else {
            return false;
        };
        NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenURL(&url)
            .is_some()
    })
}

#[cfg(not(target_os = "macos"))]
fn claude_app_installed() -> bool {
    false
}

/// `open <target>`, waited on so a missing handler surfaces as an error instead of a silent no-op.
fn open_target(target: &str) -> Result<(), String> {
    let output = Command::new("open")
        .arg(target)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("macOS couldn't open it ({})", output.status)
    } else {
        stderr
    })
}

#[tauri::command]
pub fn claude_app_status() -> bool {
    claude_app_installed()
}

/// Start a Claude Code session in the project's folder, re-stamping the kit first exactly as the built-in terminal does; `Err("claude-app-missing")` lets the launcher fall back to its install steps.
#[tauri::command]
pub async fn open_in_claude(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    prompt: Option<String>,
) -> Result<(), String> {
    let dir = workspace::project_dir_mut(&app, &state, &slug)?;
    if !dir.join(workspace::MANIFEST_FILENAME).is_file() {
        return Err(format!("\"{slug}\" is not a project folder"));
    }
    if !claude_app_installed() {
        return Err("claude-app-missing".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = workspace::stamp_claude_provisioning(&app, &dir) {
            log::warn!("kit stamp before opening Claude failed: {e}");
        }
        open_target(&code_session_link(&dir, prompt.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `open_target` off the main thread, which sync commands would otherwise hold while `open` runs.
async fn open_in_background(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_target(&target))
        .await
        .map_err(|e| e.to_string())?
}

/// Open the project folder itself in Finder (not `-R`, which would select it in its parent).
#[tauri::command]
pub async fn open_project_folder(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    let dir = workspace::project_dir(&app, &state, &slug)?;
    if !dir.is_dir() {
        return Err(format!("\"{slug}\" has no folder on disk"));
    }
    open_in_background(dir.to_string_lossy().into_owned()).await
}

/// The fixed download page; nothing about the caller reaches the URL.
#[tauri::command]
pub async fn open_claude_download() -> Result<(), String> {
    open_in_background(DOWNLOAD_URL.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn query(link: &str) -> Vec<(String, String)> {
        url::Url::parse(link)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[test]
    fn link_round_trips_a_folder_with_spaces_and_a_prompt() {
        let link = code_session_link(
            &PathBuf::from("/Users/x/Kookaburra Cut/product-tour"),
            Some("Change the look: "),
        );
        assert!(link.starts_with("claude://code/new?"));
        assert_eq!(
            query(&link),
            vec![
                (
                    "folder".into(),
                    "/Users/x/Kookaburra Cut/product-tour".into()
                ),
                ("q".into(), "Change the look: ".into()),
            ]
        );
    }

    #[test]
    fn blank_prompts_are_left_out() {
        let link = code_session_link(&PathBuf::from("/Users/x/p"), Some("   "));
        assert_eq!(query(&link), vec![("folder".into(), "/Users/x/p".into())]);
    }

    #[test]
    fn prompts_are_capped_at_the_app_limit() {
        let long = "é".repeat(MAX_PROMPT_CHARS + 50);
        let link = code_session_link(&PathBuf::from("/Users/x/p"), Some(&long));
        let q = query(&link).into_iter().find(|(k, _)| k == "q").unwrap().1;
        assert_eq!(q.chars().count(), MAX_PROMPT_CHARS);
    }
}
