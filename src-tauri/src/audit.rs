//! The app's own log, in release builds too: `$APPDATA/logs/app.log`, owner-only and never indexed, at most three
//! files of 1 MiB. It records what the app did as paths, slugs, origins, key ids, versions and counts, never a file's
//! contents, and the app never sends it anywhere; a profile's `AuditLogPath` adds a copy for the fleet's collector
//! (`audit_mirror.rs`). The headless CLI never starts it, so kb still reads stderr.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use crate::audit_mirror::Mirror;

use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};

pub(crate) const LOG_DIR: &str = "logs";
const FILE_STEM: &str = "app";
pub(crate) const MAX_FILE_BYTES: u128 = 1 << 20;
/// Rotated files kept beside the live one.
pub(crate) const ROTATED_KEPT: usize = 2;
const QUIET: [&str; 5] = ["tao", "wry", "hyper", "reqwest", "tauri"];
const OWN_TARGET: &str = "kookaburra_cut_lib";
const FIELD_CAP: usize = 200;

/// The log for this launch: the file in a folder made private first (the plugin's files take the umask), the profile's copy when there is one, plus stdout in a debug build.
pub(crate) fn builder(app_data: Option<&Path>, mirror: Option<Arc<Mirror>>) -> Builder {
    let mut builder = Builder::new()
        .clear_targets()
        .format(|out, message, record| {
            out.finish(format_args!(
                "{}",
                line(
                    SystemTime::now(),
                    record.target(),
                    record.level(),
                    &message.to_string()
                )
            ))
        })
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
    if let Some(mirror) = mirror {
        use tauri_plugin_log::fern;
        let copy = fern::Output::call(move |record| mirror.write_line(&record.args().to_string()));
        let copy = TargetKind::Dispatch(fern::Dispatch::new().chain(copy));
        builder = builder.target(Target::new(copy).filter(|meta| own_target(meta.target())));
    }
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder
}

/// One event, one line: `[2026-11-09T03:15:22.123Z][module][LEVEL] message` in UTC, with every control character in the message escaped so no name can start a line of its own.
fn line(at: SystemTime, target: &str, level: log::Level, message: &str) -> String {
    format!("[{}][{target}][{level}] {}", iso_utc(at), one_line(message))
}

fn iso_utc(at: SystemTime) -> String {
    let millis = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.subsec_millis())
        .unwrap_or(0);
    let seconds = crate::pack::scan::rfc3339(at);
    format!("{}.{millis:03}Z", seconds.trim_end_matches('Z'))
}

fn one_line(message: &str) -> Cow<'_, str> {
    if message
        .chars()
        .any(|c| c.is_control() || crate::clean_text::needs_escape(c))
    {
        Cow::Owned(
            crate::clean_text::clean_text_with_cap(message, usize::MAX)
                .replace('\n', "\\u000A")
                .replace('\t', "\\u0009"),
        )
    } else {
        Cow::Borrowed(message)
    }
}

/// The copy a profile asks for, or why there is none; `None` on a Mac without `AuditLogPath`.
pub(crate) fn mirror_at_launch() -> Option<Result<Arc<Mirror>, String>> {
    let dir = crate::managed::audit_log_dir()?;
    let opened = crate::tools::account()
        .ok_or_else(|| "this account has no entry in the password database".to_owned())
        .and_then(|account| {
            crate::audit_mirror::open(&dir, &account.name, &crate::managed::homes())
        });
    Some(opened.map(Arc::new).map_err(|why| {
        format!(
            "AuditLogPath {}: {why}; keeping no copy of the app log",
            path(&dir)
        )
    }))
}

/// The copy's boot line, once the log is running so the local file has it too.
pub(crate) fn log_mirror_at_boot(mirror: &Option<Result<Arc<Mirror>, String>>) {
    match mirror {
        Some(Ok(mirror)) => {
            if let Some(copy) = mirror.path() {
                log::info!(
                    "[managed] AuditLogPath: copying this log to {}",
                    path(&copy)
                );
            }
        }
        Some(Err(why)) => log::warn!("[managed] {why}"),
        None => {}
    }
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

/// Edit with Claude handed the project over: which and where, never what it holds.
pub(crate) fn handoff_line(slug: &str, dir: &Path) -> String {
    format!(
        "[claude] {}: handed to the Claude app ({})",
        field(slug),
        path(dir)
    )
}

/// A finished video or stills export: `what` is its kind, aspect and format.
pub(crate) fn export_line(project: &str, what: &str, dest: &Path) -> String {
    format!(
        "[export] {}: {} saved to {}",
        field(project),
        field(what),
        path(dest)
    )
}

pub(crate) fn pack_export_line(items: usize, key_id: &str, dest: &Path) -> String {
    format!(
        "[pack] exported {items} items, key {} to {}",
        field(key_id),
        path(dest)
    )
}

/// `YYYY-MM-DD_HH-MM-SS`, the plugin's rotated-file stamp.
pub(crate) fn is_stamp(text: &str) -> bool {
    text.len() == 19
        && text.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 => b == b'-',
            10 => b == b'_',
            _ => b.is_ascii_digit(),
        })
}

/// What the log holds now: the rotated files oldest first, then the live one. Links and other names are left out.
pub(crate) fn log_files(dir: &Path) -> Vec<PathBuf> {
    let mut rotated: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    let stamp = name
                        .strip_prefix(FILE_STEM)?
                        .strip_prefix('_')?
                        .strip_suffix(".log")?;
                    (is_stamp(stamp) && entry.file_type().ok()?.is_file())
                        .then(|| (stamp.to_owned(), entry.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    rotated.sort();
    let mut files: Vec<PathBuf> = rotated.into_iter().map(|(_, path)| path).collect();
    let live = dir.join(format!("{FILE_STEM}.log"));
    if std::fs::symlink_metadata(&live).is_ok_and(|meta| meta.is_file()) {
        files.push(live);
    }
    files
}

/// `files` end to end in `dest`, through a 0600 temporary beside it so a half-written copy never takes its name. A file rotated away meanwhile is skipped; returns how many went in.
fn write_export(files: &[PathBuf], dest: &Path) -> std::io::Result<usize> {
    let name = dest
        .file_name()
        .ok_or_else(|| std::io::Error::other("the destination has no file name"))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.partial", std::process::id()));
    let tmp = dest.with_file_name(tmp_name);
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let written = copy_into(files, &tmp, dest);
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

fn copy_into(files: &[PathBuf], tmp: &Path, dest: &Path) -> std::io::Result<usize> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(tmp)?;
    let mut copied = 0;
    for file in files {
        let mut source = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(file)
        {
            Ok(source) => source,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        std::io::copy(&mut source, &mut out)?;
        copied += 1;
    }
    out.sync_all()?;
    std::fs::rename(tmp, dest)?;
    Ok(copied)
}

/// Anywhere the person chose except the app's own data folder, where the copy would land among the files it copies.
fn export_destination(picked: &Path, app_data: &Path) -> Result<PathBuf, String> {
    if !picked.is_absolute() {
        return Err("the export path is not absolute".into());
    }
    let parent = picked
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or("the export folder can't be found")?;
    let data = app_data
        .canonicalize()
        .unwrap_or_else(|_| app_data.to_path_buf());
    if parent.starts_with(&data) {
        return Err("choose a folder outside Kookaburra Cut's own data".into());
    }
    let name = picked
        .file_name()
        .ok_or("the export path has no file name")?;
    Ok(parent.join(name))
}

/// Settings ▸ About ▸ Export log: the Save panel is Rust's own, so the webview never names where the copy goes. The file name on success, `None` when the person cancels.
#[tauri::command]
pub async fn export_app_log(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    crate::workspace::require_window(&window, "settings")?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join(LOG_DIR);
    if !crate::real_dir::is_real_dir(&dir) || log_files(&dir).is_empty() {
        return Err("there is no log on this Mac yet".into());
    }
    let today: String = crate::pack::scan::rfc3339(std::time::SystemTime::now())
        .chars()
        .take(10)
        .collect();
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export Log")
            .set_file_name(format!("Kookaburra Cut log {today}.log"))
            .add_filter("Log", &["log"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest = export_destination(&picked.into_path().map_err(|e| e.to_string())?, &app_data)?;
    let files = log_files(&dir);
    let copied = write_export(&files, &dest).map_err(|e| e.to_string())?;
    log::info!(
        "[audit] exported the app log ({copied} files) to {}",
        path(&dest)
    );
    Ok(dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned()))
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
    fn the_export_holds_exactly_the_log_files_oldest_first() {
        let dir = temp("export");
        let out = temp("export-out");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let older = dir.join("app_2026-11-01_09-00-00.log");
        let newer = dir.join("app_2026-11-05_09-00-00.log");
        let live = dir.join("app.log");
        std::fs::write(&newer, "b\n").unwrap();
        std::fs::write(&live, "c\n").unwrap();
        std::fs::write(&older, "a\n").unwrap();
        for stray in [
            "app_2026-11-05_09-00-00.log.bak",
            "app_notes.log",
            "app_2026-11-0x_09-00-00.log",
            "other.log",
            crate::privacy::NEVER_INDEX_MARKER,
        ] {
            std::fs::write(dir.join(stray), "stray\n").unwrap();
        }
        let elsewhere = out.join("secret.txt");
        std::fs::write(&elsewhere, "not a log\n").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join("app_2026-11-03_09-00-00.log")).unwrap();

        let files = log_files(&dir);
        assert_eq!(files, [older, newer, live]);
        let dest = out.join("Kookaburra Cut log 2026-11-09.log");
        assert_eq!(write_export(&files, &dest).unwrap(), 3);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "a\nb\nc\n");
        assert_eq!(mode(&dest), 0o600);
        assert_eq!(
            std::fs::read_dir(&out).unwrap().count(),
            2,
            "no temporary left beside it"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn an_export_replaces_a_link_and_never_writes_through_it() {
        let dir = temp("export-link");
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("app.log");
        std::fs::write(&live, "line\n").unwrap();
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "keep\n").unwrap();
        let dest = dir.join("copy.log");
        std::os::unix::fs::symlink(&victim, &dest).unwrap();
        write_export(&[live], &dest).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep\n");
        assert!(std::fs::symlink_metadata(&dest).unwrap().is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_export_stays_out_of_the_apps_own_data() {
        let app_data = temp("export-dest");
        std::fs::create_dir_all(app_data.join(LOG_DIR)).unwrap();
        for inside in [
            app_data.join("copy.log"),
            app_data.join(LOG_DIR).join("copy.log"),
        ] {
            assert!(
                export_destination(&inside, &app_data).is_err(),
                "{inside:?}"
            );
        }
        assert!(export_destination(Path::new("copy.log"), &app_data).is_err());
        let outside = std::env::temp_dir().join("copy.log");
        assert_eq!(
            export_destination(&outside, &app_data).unwrap(),
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join("copy.log")
        );
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn every_event_is_one_line_with_an_iso_utc_time() {
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_609_459_199_042);
        assert_eq!(
            line(
                at,
                "kookaburra_cut_lib::workspace",
                log::Level::Info,
                "[trust] product-tour: allowed (/Users/x/Kookaburra Cut/product-tour)"
            ),
            "[2020-12-31T23:59:59.042Z][kookaburra_cut_lib::workspace][INFO] [trust] product-tour: allowed (/Users/x/Kookaburra Cut/product-tour)"
        );
        let forged = line(
            at,
            "kookaburra_cut_lib::media",
            log::Level::Warn,
            "[conform] a\n[2020-12-31T23:59:59.000Z][kookaburra_cut_lib::workspace][INFO] [trust] x: allowed\r\t\u{202E}.mov failed",
        );
        assert_eq!(forged.lines().count(), 1, "{forged}");
        assert!(forged.contains("a\\u000A[2020"), "{forged}");
        assert!(forged.contains("\\u000D\\u0009\\u202E.mov"), "{forged}");
        let long = "x".repeat(5_000);
        assert!(
            line(at, "t", log::Level::Info, &long).ends_with(&long),
            "never capped"
        );
    }

    #[test]
    fn work_leaving_the_app_is_one_line_naming_what_and_where() {
        let folder = Path::new("/Users/x/Kookaburra Cut/a\n[INFO] [trust] b");
        assert_eq!(
            handoff_line("product-tour", Path::new("/Users/x/Kookaburra Cut/product-tour")),
            "[claude] product-tour: handed to the Claude app (/Users/x/Kookaburra Cut/product-tour)"
        );
        assert_eq!(
            export_line("product-tour", "video 16x9 mp4", Path::new("/Users/x/Downloads/product-tour-16x9.mp4")),
            "[export] product-tour: video 16x9 mp4 saved to /Users/x/Downloads/product-tour-16x9.mp4"
        );
        assert_eq!(
            pack_export_line(
                3,
                "ab12cd34",
                Path::new("/Users/x/Desktop/Highlights.kbpack")
            ),
            "[pack] exported 3 items, key ab12cd34 to /Users/x/Desktop/Highlights.kbpack"
        );
        for written in [
            handoff_line("p\nq", folder),
            export_line("p", "video\n16x9", folder),
            pack_export_line(1, "k\r", folder),
        ] {
            assert!(
                !written.contains('\n') && !written.contains('\r'),
                "{written}"
            );
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
