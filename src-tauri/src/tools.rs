//! App-free paths shared by the Tauri commands and the headless `edit` CLI: the app data folder, the bundled ffmpeg/ffprobe sidecars and the hardware-video setting, all resolved without an `AppHandle` so both entry points reach the same files.

use std::path::{Path, PathBuf};

/// The bundle identifier (`tauri.conf.json` `identifier`); Tauri's macOS `app_data_dir` is named after it.
pub(crate) const APP_IDENTIFIER: &str = "com.mpalmes.kookaburracut";

/// `$HOME/Library/Application Support/<identifier>`, exactly what Tauri's `app.path().app_data_dir()` returns on macOS.
pub(crate) fn app_data_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join("Library")
        .join("Application Support")
        .join(APP_IDENTIFIER))
}

/// `$HOME` when set and non-empty, else the password database entry: the `dirs` crate's rule, which Tauri's path resolver uses.
fn home_dir() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    passwd_home().ok_or_else(|| "cannot find the home folder: HOME is not set".to_string())
}

fn passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    (!dir.to_bytes().is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
}

/// A bundled sidecar's path, resolved like tauri-plugin-shell's `relative_command_path`: beside the running executable (packaged `Contents/MacOS/ffmpeg`, dev `target/debug/ffmpeg`), stepping out of `deps/` when a test binary runs.
pub(crate) fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe()
        .or_else(|_| std::env::current_exe().and_then(|p| p.canonicalize()))
        .map_err(|e| format!("cannot locate the app binary: {e}"))?;
    let dir = exe.parent().ok_or("the app binary has no parent folder")?;
    let base = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    Ok(base.join(name))
}

/// The two media tools every edit core runs.
#[derive(Debug, Clone)]
pub(crate) struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// The sidecars shipped beside this executable.
    pub(crate) fn beside_exe() -> Result<Self, String> {
        Ok(Self {
            ffmpeg: sidecar_path("ffmpeg")?,
            ffprobe: sidecar_path("ffprobe")?,
        })
    }
}

/// The Settings "hardware video" toggle as saved in `<app data>/settings.json`; missing or unreadable settings mean on, like the app.
pub(crate) fn hardware_enabled(app_data: &Path) -> bool {
    !crate::workspace::read_settings_file(&app_data.join("settings.json")).disable_hardware_video
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identifier_matches_the_tauri_config() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(config["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    #[test]
    fn app_data_sits_under_application_support() {
        let dir = app_data_dir().unwrap();
        assert!(dir.ends_with(format!("Library/Application Support/{APP_IDENTIFIER}")));
    }

    #[test]
    fn sidecars_resolve_beside_the_binary_outside_deps() {
        let path = sidecar_path("ffmpeg").unwrap();
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("ffmpeg"));
        assert!(
            !path.parent().unwrap().ends_with("deps"),
            "{}",
            path.display()
        );
    }

    #[test]
    fn hardware_follows_the_saved_toggle_and_defaults_on() {
        let dir = std::env::temp_dir().join(format!("kc-tools-hw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(hardware_enabled(&dir));
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disableHardwareVideo":true}"#,
        )
        .unwrap();
        assert!(!hardware_enabled(&dir));
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert!(hardware_enabled(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
