//! The app's own log, in release builds too: `$APPDATA/logs/app.log`, owner-only and never indexed, at most three
//! files of 1 MiB. It records what the app did as paths, slugs, origins, key ids, versions and counts, never a file's
//! contents, and nothing in it leaves the Mac. The headless CLI never starts it, so kb still reads stderr.

use std::path::{Path, PathBuf};

use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};

pub(crate) const LOG_DIR: &str = "logs";
const FILE_STEM: &str = "app";
const MAX_FILE_BYTES: u128 = 1 << 20;
/// Rotated files kept beside the live one.
const ROTATED_KEPT: usize = 2;
const QUIET: [&str; 5] = ["tao", "wry", "hyper", "reqwest", "tauri"];
const OWN_TARGET: &str = "kookaburra_cut_lib";
const FIELD_CAP: usize = 200;

/// The log for this launch: the file in a folder made private first (the plugin's files take the umask), plus stdout in a debug build.
pub(crate) fn builder(app_data: Option<&Path>) -> Builder {
    let mut builder = Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(ROTATED_KEPT));
    for quiet in QUIET {
        builder = builder.level_for(quiet, log::LevelFilter::Off);
    }
    if let Some(path) = app_data.and_then(log_dir) {
        let file = TargetKind::Folder {
            path,
            file_name: Some(FILE_STEM.into()),
        };
        builder = builder.target(Target::new(file).filter(|meta| own_target(meta.target())));
    }
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder
}

/// `$APPDATA/logs`, 0700 and never indexed, or None (and no file) when it can't be made so.
fn log_dir(app_data: &Path) -> Option<PathBuf> {
    let dir = app_data.join(LOG_DIR);
    let ready = crate::privacy::private_dir(app_data)
        .and_then(|()| crate::privacy::private_dir(&dir))
        .and_then(|()| {
            if crate::real_dir::is_real_dir(&dir) {
                crate::privacy::never_index(&dir)
            } else {
                Err(std::io::Error::other("it is a link, not a folder"))
            }
        });
    match ready {
        Ok(()) => Some(dir),
        Err(e) => {
            eprintln!("[audit] no app log this launch: {}: {e}", dir.display());
            None
        }
    }
}

fn own_target(target: &str) -> bool {
    target
        .strip_prefix(OWN_TARGET)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
}

/// A value a folder, pack, page or person chose, kept to one escaped, capped line so it can't pass as another.
pub(crate) fn field(text: &str) -> String {
    crate::clean_text::clean_text_with_cap(&crate::clean_text::clean_name(text), FIELD_CAP)
}

pub(crate) fn path(path: &Path) -> String {
    field(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn the_log_folder_is_owner_only_unindexed_and_sealed_at_launch() {
        let app_data = temp("sealed");
        let dir = log_dir(&app_data).unwrap();
        assert_eq!(dir, app_data.join(LOG_DIR));
        assert_eq!(mode(&app_data), 0o700);
        assert_eq!(mode(&dir), 0o700);
        assert!(dir.join(crate::privacy::NEVER_INDEX_MARKER).is_file());
        let live = dir.join("app.log");
        let rotated = dir.join("app_2026-11-06_10-00-00.log");
        for file in [&live, &rotated] {
            std::fs::write(file, b"[kit] line\n").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        crate::privacy::seal_at_startup(app_data.clone(), Vec::new());
        for _ in 0..200 {
            if mode(&live) == 0o600 && mode(&rotated) == 0o600 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(mode(&live), 0o600);
        assert_eq!(mode(&rotated), 0o600);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn a_linked_log_folder_keeps_no_log_and_is_never_written_through() {
        let app_data = temp("linked");
        let elsewhere = temp("linked-elsewhere");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, app_data.join(LOG_DIR)).unwrap();
        assert_eq!(log_dir(&app_data), None);
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        assert_eq!(mode(&elsewhere), 0o755);
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn only_the_apps_own_lines_reach_the_file() {
        assert!(own_target("kookaburra_cut_lib"));
        assert!(own_target("kookaburra_cut_lib::workspace"));
        assert!(own_target("kookaburra_cut_lib::pack::commands"));
        for other in [
            "webview",
            "webview::scene",
            "tauri::app",
            "wry",
            "kookaburra_cut_libx",
            "reqwest::connect",
        ] {
            assert!(!own_target(other), "{other}");
        }
    }

    #[test]
    fn a_chosen_value_stays_on_one_line() {
        assert_eq!(field("Demo\n[trust] forged"), "Demo\\u000A[trust] forged");
        assert!(field(&"x".repeat(500)).chars().count() < 220);
        assert_eq!(
            path(Path::new("/Users/x/Kookaburra Cut/product-tour")),
            "/Users/x/Kookaburra Cut/product-tour"
        );
    }
}
