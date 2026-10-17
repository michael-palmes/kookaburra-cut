//! App-free paths shared by the Tauri commands and the headless `edit` CLI: the app data folder, the bundled ffmpeg/ffprobe sidecars and the hardware-video setting, all resolved without an `AppHandle` so both entry points reach the same files.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The config identifier (`tauri.conf.json` `identifier`) that Tauri's macOS `app_data_dir` is named after; a bundle's own `Info.plist` overrides it.
pub(crate) const APP_IDENTIFIER: &str = "com.mpalmes.kookaburracut";

/// `$HOME/Library/Application Support/<identifier>`, exactly what Tauri's `app.path().app_data_dir()` returns on macOS.
pub(crate) fn app_data_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join("Library")
        .join("Application Support")
        .join(bundle_identifier()))
}

/// This executable's identifier: its bundle's `CFBundleIdentifier` (an acceptance build carries its own), else the config identifier for a dev binary outside a bundle.
pub(crate) fn bundle_identifier() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        current_exe()
            .ok()
            .and_then(|exe| bundle_identifier_of(&exe))
            .unwrap_or_else(|| APP_IDENTIFIER.to_owned())
    })
}

/// The `CFBundleIdentifier` of the `.app` holding `exe` in its `Contents/MacOS/`; None outside a bundle.
fn bundle_identifier_of(exe: &Path) -> Option<String> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if macos.file_name()? != "MacOS"
        || contents.file_name()? != "Contents"
        || bundle.extension()? != "app"
    {
        return None;
    }
    plist_string(
        &std::fs::read_to_string(contents.join("Info.plist")).ok()?,
        "CFBundleIdentifier",
    )
}

/// The `<string>` right after `<key>KEY</key>` in an XML plist (Tauri writes `Info.plist` as XML).
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let (_, rest) = plist.split_once(&format!("<key>{key}</key>"))?;
    let (value, _) = rest
        .trim_start()
        .strip_prefix("<string>")?
        .split_once("</string>")?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
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
    let exe = current_exe().map_err(|e| format!("cannot locate the app binary: {e}"))?;
    let dir = exe.parent().ok_or("the app binary has no parent folder")?;
    let base = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    Ok(base.join(name))
}

fn current_exe() -> std::io::Result<PathBuf> {
    tauri::utils::platform::current_exe()
        .or_else(|_| std::env::current_exe().and_then(|p| p.canonicalize()))
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

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>kookaburra-cut</string>
	<key>CFBundleIdentifier</key>
	<string>com.mpalmes.kookaburracut.acceptance.abc12345</string>
</dict>
</plist>
"#;

    #[test]
    fn a_bundled_binary_reads_its_own_identifier() {
        let dir = std::env::temp_dir().join(format!("kc-tools-plist-{}", std::process::id()));
        let contents = dir.join("Kookaburra Cut Acceptance.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        let exe = contents.join("MacOS/kookaburra-cut");
        assert_eq!(bundle_identifier_of(&exe), None);
        std::fs::write(contents.join("Info.plist"), PLIST).unwrap();
        assert_eq!(
            bundle_identifier_of(&exe).as_deref(),
            Some("com.mpalmes.kookaburracut.acceptance.abc12345")
        );
        let keyless = PLIST.replace("<key>CFBundleIdentifier</key>", "<key>Other</key>");
        std::fs::write(contents.join("Info.plist"), keyless).unwrap();
        assert_eq!(bundle_identifier_of(&exe), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn binaries_outside_a_bundle_use_the_config_identifier() {
        let dir = std::env::temp_dir().join(format!("kc-tools-nobundle-{}", std::process::id()));
        for exe in [
            "target/debug/kookaburra-cut",
            "X.app/MacOS/kookaburra-cut",
            "X/Contents/MacOS/kookaburra-cut",
        ] {
            let exe = dir.join(exe);
            let contents = exe.parent().unwrap().parent().unwrap();
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(contents.join("Info.plist"), PLIST).unwrap();
            assert_eq!(bundle_identifier_of(&exe), None, "{}", exe.display());
        }
        assert_eq!(bundle_identifier(), APP_IDENTIFIER);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plist_strings_need_the_key_then_a_string() {
        assert_eq!(
            plist_string(PLIST, "CFBundleExecutable").as_deref(),
            Some("kookaburra-cut")
        );
        assert_eq!(plist_string(PLIST, "CFBundleName"), None);
        assert_eq!(
            plist_string("<key>CFBundleIdentifier</key><true/>", "CFBundleIdentifier"),
            None
        );
        assert_eq!(
            plist_string(
                "<key>CFBundleIdentifier</key>\n<string> </string>",
                "CFBundleIdentifier"
            ),
            None
        );
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
