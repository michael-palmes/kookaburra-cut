//! Claude Code version checks for the embedded terminal. Everything runs locally
//! except one anonymous HTTPS GET for the latest version string (the same endpoint
//! the CLI's own updater polls), throttled to daily and cached in settings;
//! offline or failed checks stay silent.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::workspace::{self, SettingsState};

/// The distribution server's latest pointer: a bare unauthenticated GET returning a plaintext version.
const LATEST_URL: &str = "https://downloads.claude.ai/claude-code-releases/latest";
const CHECK_THROTTLE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeVersionInfo {
    pub path: String,
    /// "native" | "brew" | "npm" | "other", from symlink-target heuristics (Anthropic's own diagnostic sequence).
    pub method: String,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub outdated: bool,
    /// True when this latest was already offered and dismissed.
    pub dismissed: bool,
}

/// First `major.minor.patch` token in version output (e.g. "2.1.211 (Claude Code)").
fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|t| {
            let dots = t.matches('.').count();
            dots == 2 && !t.starts_with('.') && t.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
        .map(str::to_string)
}

/// Numeric segment-wise compare; missing segments count as 0.
fn is_older(installed: &str, latest: &str) -> bool {
    let nums = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let a = nums(installed);
    let b = nums(latest);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

/// Install method from the binary path plus its resolved symlink target: npm globals live in
/// node_modules, brew casks in Caskroom/Cellar, the native installer in ~/.local/share/claude.
fn detect_method(path: &str) -> String {
    let resolved = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let joined = format!("{path} {resolved}");
    if joined.contains("node_modules") {
        "npm".into()
    } else if joined.contains("Caskroom") || joined.contains("Cellar") {
        "brew".into()
    } else if joined.contains("/.local/share/claude/") || joined.contains("/.local/bin/claude") {
        "native".into()
    } else if joined.contains("/homebrew/") {
        "brew".into()
    } else {
        "other".into()
    }
}

/// `<path> --version`, parsed; None when the binary can't run or prints no version.
fn installed_version(path: &str) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// One anonymous GET via the system curl (macOS always ships /usr/bin/curl); hard 10s cap.
fn fetch_latest() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/curl")
        .args(["-fsSL", "--max-time", "10", LATEST_URL])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_version(String::from_utf8_lossy(&out.stdout).trim())
}

/// The terminal panel's version probe: local `--version` plus the daily-cached latest.
/// Never errors the UI for a missing install; that returns Ok(None).
#[tauri::command]
pub async fn claude_version_info(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Option<ClaudeVersionInfo>, String> {
    let Some(path) = crate::pty::detect_claude().await? else {
        return Ok(None);
    };

    let probe_path = path.clone();
    let (installed, method) = tauri::async_runtime::spawn_blocking(move || {
        (installed_version(&probe_path), detect_method(&probe_path))
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut settings = workspace::load_settings(&app, &state)?;
    let now = workspace::now_unix_ms();
    let stale = settings
        .last_claude_check_ms
        .map_or(true, |t| now.saturating_sub(t) >= CHECK_THROTTLE_MS);
    if stale {
        // Stamp the attempt, not just success, so an offline machine retries daily rather than per mount.
        settings.last_claude_check_ms = Some(now);
        if let Some(latest) = tauri::async_runtime::spawn_blocking(fetch_latest)
            .await
            .map_err(|e| e.to_string())?
        {
            settings.last_claude_latest = Some(latest);
        }
        workspace::save_settings(&app, &state, settings.clone())?;
    }

    let latest = settings.last_claude_latest.clone();
    let outdated = matches!((&installed, &latest), (Some(i), Some(l)) if is_older(i, l));
    let dismissed = latest.is_some() && settings.last_offered_claude_version == latest;
    Ok(Some(ClaudeVersionInfo {
        path,
        method,
        installed,
        latest,
        outdated,
        dismissed,
    }))
}

/// "Later" on the update banner: this latest is not offered again.
#[tauri::command]
pub fn dismiss_claude_update(
    app: AppHandle,
    state: State<'_, SettingsState>,
    version: String,
) -> Result<(), String> {
    let mut settings = workspace::load_settings(&app, &state)?;
    settings.last_offered_claude_version = Some(version);
    workspace::save_settings(&app, &state, settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_from_cli_and_endpoint_output() {
        assert_eq!(
            parse_version("2.1.211 (Claude Code)"),
            Some("2.1.211".into())
        );
        assert_eq!(parse_version("2.1.220"), Some("2.1.220".into()));
        assert_eq!(parse_version("Claude Code"), None);
        assert_eq!(parse_version("v2.1"), None);
        assert_eq!(parse_version("<html>oops</html>"), None);
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(is_older("2.1.9", "2.1.10"));
        assert!(is_older("1.9.9", "2.0.0"));
        assert!(!is_older("2.1.10", "2.1.10"));
        assert!(!is_older("2.2.0", "2.1.220"));
    }

    #[test]
    fn classifies_install_methods_by_path() {
        assert_eq!(
            detect_method("/opt/homebrew/lib/node_modules/x/claude"),
            "npm"
        );
        assert_eq!(
            detect_method("/opt/homebrew/Caskroom/claude-code/bin/claude"),
            "brew"
        );
        assert_eq!(detect_method("/Users/x/.local/bin/claude"), "native");
        assert_eq!(detect_method("/usr/bin/claude"), "other");
    }
}
