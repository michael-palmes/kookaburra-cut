//! Conflict-aware app writes (docs/agent-kit.md, "Live edits"): files are the source of truth, so every app write to a sidecar or `project.json` can carry the content hash it was based on and is refused when the file changed outside the app; per-file stamps let the editor's reload poll tell its own writes from anyone else's.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::workspace::{self, SettingsState, MANIFEST_FILENAME};

/// The base a writer passes when it expects the file not to exist yet.
pub(crate) const ABSENT_BASE: &str = "absent";

/// Every refusal starts with this, so the frontend can tell a conflict from a failure.
pub(crate) const CONFLICT_PREFIX: &str = "conflict:";

/// Lowercase hex SHA-256 of the bytes; the frontend hashes text it holds the same way.
pub(crate) fn content_hash(bytes: &[u8]) -> String {
    crate::hex_digest(Sha256::digest(bytes).as_slice())
}

/// `<mtime nanos>:<size>`, or None when the file is missing.
pub(crate) fn file_stamp(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(format!("{mtime}:{}", meta.len()))
}

/// The file's content hash now, `ABSENT_BASE` when it doesn't exist.
pub(crate) fn current_hash(path: &Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(content_hash(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ABSENT_BASE.into()),
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

/// Refuse when `base` no longer describes the file on disk; no base skips the check.
pub(crate) fn check_base(path: &Path, rel: &str, base: Option<&str>) -> Result<(), String> {
    let Some(base) = base else {
        return Ok(());
    };
    if current_hash(path)? == base {
        Ok(())
    } else {
        Err(format!("{CONFLICT_PREFIX} {rel} changed outside the app"))
    }
}

/// Refuse an index-based manifest edit whose scene moved: `expected` is the module the caller saw at `index`.
pub(crate) fn expect_scene_file(
    scenes: &[Value],
    index: usize,
    expected: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let norm = |file: &str| file.trim_start_matches("./").to_string();
    let found = scenes
        .get(index)
        .and_then(|scene| scene.get("file"))
        .and_then(Value::as_str);
    if found.map(norm) == Some(norm(expected)) {
        return Ok(());
    }
    Err(format!(
        "{CONFLICT_PREFIX} project.json changed outside the app (scene {} is {}, not {expected})",
        index + 1,
        found.unwrap_or("missing")
    ))
}

/// One app write as the frontend sees it: the new content hash, plus the stamps either side so the reload poll adopts only its own change.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    /// Project-relative path (`project.json`, `scenes/<stem>.json`).
    pub file: String,
    pub hash: String,
    /// The stamp the write replaced; None when the file was new.
    pub before: Option<String>,
    pub stamp: String,
}

/// Bytes land through a temp file stamped before the rename (a rename keeps the file's mtime), so the stamp can never describe someone else's later write.
pub(crate) fn write_bytes_stamped(path: &Path, bytes: &[u8]) -> Result<(String, String), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let stamp = file_stamp(&tmp).unwrap_or_default();
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok((content_hash(bytes), stamp))
}

/// One source file's stamp for the reload poll.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStamp {
    pub file: String,
    pub stamp: String,
}

/// Stamps for `project.json` and everything under `scenes/` (the trust fingerprint's set, minus dotfiles and in-flight temp files), sorted by path.
pub(crate) fn source_stamps(dir: &Path) -> Vec<SourceStamp> {
    let mut out = Vec::new();
    if let Some(stamp) = file_stamp(&dir.join(MANIFEST_FILENAME)) {
        out.push(SourceStamp {
            file: MANIFEST_FILENAME.into(),
            stamp,
        });
    }
    let mut stack = vec![("scenes".to_string(), dir.join("scenes"))];
    while let Some((rel, current)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".tmp") {
                continue;
            }
            let path = entry.path();
            let child = format!("{rel}/{name}");
            if path.is_dir() {
                stack.push((child, path));
            } else if let Some(stamp) = file_stamp(&path) {
                out.push(SourceStamp { file: child, stamp });
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// Per-file stamps of a project's sources: the editor's reload poll diffs these against its own baseline.
#[tauri::command]
pub fn project_file_stamps(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<SourceStamp>, String> {
    Ok(source_stamps(&workspace::project_dir(&app, &state, &slug)?))
}

/// A project-relative source path the hash check may read: `project.json` or one flat file under `scenes/`.
fn source_path(project: &Path, file: &str) -> Result<PathBuf, String> {
    if file == MANIFEST_FILENAME {
        return Ok(project.join(file));
    }
    let ok = file.strip_prefix("scenes/").is_some_and(|rest| {
        !rest.is_empty() && !rest.contains('/') && !rest.contains("..") && !rest.starts_with('.')
    });
    if !ok {
        return Err(format!("not a project source file: {file:?}"));
    }
    Ok(project.join(file))
}

pub(crate) fn source_hashes(project: &Path, files: &[String]) -> Result<Vec<String>, String> {
    files
        .iter()
        .map(|file| current_hash(&source_path(project, file)?))
        .collect()
}

/// Content hashes of named source files (`absent` for a missing one), so undo can check a whole entry before it writes anything.
#[tauri::command]
pub fn project_file_hashes(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    files: Vec<String>,
) -> Result<Vec<String>, String> {
    source_hashes(&workspace::project_dir(&app, &state, &slug)?, &files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_project() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-live-edits-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        dir
    }

    #[test]
    fn content_hash_is_plain_sha256_hex() {
        assert_eq!(
            content_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn check_base_refuses_a_changed_file_and_an_unexpected_one() {
        let dir = temp_project();
        let path = dir.join("scenes/01-a.json");
        assert!(check_base(&path, "scenes/01-a.json", Some(ABSENT_BASE)).is_ok());
        std::fs::write(&path, b"{\"version\":1}").unwrap();
        let err = check_base(&path, "scenes/01-a.json", Some(ABSENT_BASE)).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "{err}");
        let hash = content_hash(b"{\"version\":1}");
        assert!(check_base(&path, "scenes/01-a.json", Some(&hash)).is_ok());
        assert!(check_base(&path, "scenes/01-a.json", None).is_ok());
        std::fs::write(&path, b"{\"version\":1,\"name\":\"Claude\"}").unwrap();
        assert!(check_base(&path, "scenes/01-a.json", Some(&hash))
            .unwrap_err()
            .starts_with(CONFLICT_PREFIX));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expect_scene_file_names_what_moved() {
        let scenes = vec![
            json!({ "file": "scenes/01-a.tsx" }),
            json!({ "file": "./scenes/02-b.tsx" }),
        ];
        assert!(expect_scene_file(&scenes, 0, Some("scenes/01-a.tsx")).is_ok());
        assert!(expect_scene_file(&scenes, 1, Some("scenes/02-b.tsx")).is_ok());
        assert!(expect_scene_file(&scenes, 5, None).is_ok());
        let err = expect_scene_file(&scenes, 0, Some("scenes/02-b.tsx")).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX));
        assert!(err.contains("scenes/01-a.tsx"), "{err}");
        assert!(expect_scene_file(&scenes, 2, Some("scenes/03-c.tsx")).is_err());
    }

    #[test]
    fn stamped_writes_report_the_landed_stamp_and_hash() {
        let dir = temp_project();
        let path = dir.join("project.json");
        let (hash, stamp) = write_bytes_stamped(&path, b"{}\n").unwrap();
        assert_eq!(hash, content_hash(b"{}\n"));
        assert_eq!(Some(stamp), file_stamp(&path));
        assert!(!dir.join("project.json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn source_stamps_cover_the_manifest_and_scenes_but_not_temp_files() {
        let dir = temp_project();
        std::fs::write(dir.join("project.json"), b"{}").unwrap();
        std::fs::write(dir.join("scenes/01-a.tsx"), b"x").unwrap();
        std::fs::write(dir.join("scenes/01-a.json.tmp"), b"x").unwrap();
        std::fs::write(dir.join("scenes/.DS_Store"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("scenes/shared")).unwrap();
        std::fs::write(dir.join("scenes/shared/util.tsx"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/a.png"), b"x").unwrap();
        let files: Vec<String> = source_stamps(&dir).into_iter().map(|s| s.file).collect();
        assert_eq!(
            files,
            vec!["project.json", "scenes/01-a.tsx", "scenes/shared/util.tsx"]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn source_hashes_confine_paths_and_mark_missing_files() {
        let dir = temp_project();
        std::fs::write(dir.join("project.json"), b"abc").unwrap();
        let hashes = source_hashes(
            &dir,
            &["project.json".to_string(), "scenes/01-a.json".to_string()],
        )
        .unwrap();
        assert_eq!(hashes[0], content_hash(b"abc"));
        assert_eq!(hashes[1], ABSENT_BASE);
        assert!(source_hashes(&dir, &["../secret".to_string()]).is_err());
        assert!(source_hashes(&dir, &["scenes/../project.json".to_string()]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
