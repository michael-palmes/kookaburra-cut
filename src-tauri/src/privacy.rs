//! Confidential work at rest belongs to its user alone. The app data folder (`settings.json`, `cache/`, `pack-key/`) and
//! the workspace sinks the app owns (`_bridge/`, `_autorun/`) are held at 0700 for directories and 0600 for files,
//! checked and corrected once at startup, and carry a `.metadata_never_index` marker so Spotlight never indexes a frame of
//! footage. Projects are the user's documents and keep their ordinary modes.

use std::path::{Path, PathBuf};

pub(crate) const NEVER_INDEX_MARKER: &str = ".metadata_never_index";
const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

/// Create `dir` (parents included) and hold it at 0700.
pub(crate) fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    set_mode(dir, DIR_MODE).map(|_| ())
}

/// Hold a file the app wrote at 0600.
pub(crate) fn private_file(path: &Path) -> std::io::Result<()> {
    set_mode(path, FILE_MODE).map(|_| ())
}

/// Atomic text write of a file that is 0600 from its first byte, so no reader catches the temporary under the umask. A leftover temporary, or a link planted in its place, is removed and never written through.
pub(crate) fn atomic_write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .open(&tmp)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Drop the Spotlight opt-out marker in `dir`, which must already exist.
pub(crate) fn never_index(dir: &Path) -> std::io::Result<()> {
    let marker = dir.join(NEVER_INDEX_MARKER);
    if !marker.exists() {
        std::fs::write(&marker, [])?;
    }
    private_file(&marker)
}

/// Time Machine's per-item exclusion, the attribute `tmutil addexclusion` sets.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &std::ffi::CStr = c"com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = b"com.apple.backupd";

/// Keeps `dir` out of Time Machine backups; `true` when the attribute had to be written. Projects are never excluded: the
/// caches here hold only what a project's own footage decodes to again.
#[cfg(target_os = "macos")]
pub(crate) fn exclude_from_backup(dir: &Path) -> std::io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let mut current = [0u8; 64];
    let read = unsafe {
        libc::getxattr(
            path.as_ptr(),
            BACKUP_EXCLUDE_XATTR.as_ptr(),
            current.as_mut_ptr().cast(),
            current.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if read >= 0 && &current[..read as usize] == BACKUP_EXCLUDE_VALUE {
        return Ok(false);
    }
    let wrote = unsafe {
        libc::setxattr(
            path.as_ptr(),
            BACKUP_EXCLUDE_XATTR.as_ptr(),
            BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if wrote != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn exclude_from_backup(_dir: &Path) -> std::io::Result<bool> {
    Ok(false)
}

/// `true` when the mode had to change. A symlink is never followed: a planted link must not reach outside the tree.
fn set_mode(path: &Path, mode: u32) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    let md = std::fs::symlink_metadata(path)?;
    if md.file_type().is_symlink() || md.permissions().mode() & 0o777 == mode {
        return Ok(false);
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(true)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Sealed {
    pub corrected: usize,
    pub failed: usize,
}

/// Every directory under `root` to 0700 and every file to 0600, `root` included; counts what it had to change.
pub(crate) fn seal_tree(root: &Path) -> Sealed {
    let mut sealed = Sealed::default();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        match set_mode(&dir, DIR_MODE) {
            Ok(true) => sealed.corrected += 1,
            Ok(false) => {}
            Err(_) => {
                sealed.failed += 1;
                continue;
            }
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            sealed.failed += 1;
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                sealed.failed += 1;
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(path);
            } else {
                match set_mode(&path, FILE_MODE) {
                    Ok(true) => sealed.corrected += 1,
                    Ok(false) => {}
                    Err(_) => sealed.failed += 1,
                }
            }
        }
    }
    sealed
}

/// The startup check: the roots are created and sealed at once, the decoded-footage caches leave Time Machine, then the
/// whole trees in the background (a clip cache holds hundreds of thousands of frames). One log line names what had to be corrected.
pub(crate) fn seal_at_startup(app_data: PathBuf, sinks: Vec<PathBuf>) {
    let cache = app_data.join("cache");
    let clips = cache.join("clips");
    let media = cache.join("media");
    for dir in [&app_data, &cache, &clips, &media] {
        if let Err(e) = private_dir(dir) {
            log::warn!("[privacy] could not seal {}: {e}", dir.display());
        }
    }
    let _ = never_index(&cache);
    for dir in [&clips, &media] {
        match exclude_from_backup(dir) {
            Ok(true) => log::info!("[privacy] {} now stays out of Time Machine", dir.display()),
            Ok(false) => {}
            Err(e) => log::warn!(
                "[privacy] could not exclude {} from Time Machine: {e}",
                dir.display()
            ),
        }
    }
    for sink in &sinks {
        if sink.is_dir() {
            let _ = set_mode(sink, DIR_MODE);
            let _ = never_index(sink);
        }
    }
    std::thread::spawn(move || {
        let mut total = Sealed::default();
        for root in std::iter::once(app_data).chain(sinks).filter(|r| r.is_dir()) {
            let sealed = seal_tree(&root);
            total.corrected += sealed.corrected;
            total.failed += sealed.failed;
        }
        if total.corrected > 0 || total.failed > 0 {
            log::info!(
                "[privacy] made {} app files and folders owner-only ({} could not be changed)",
                total.corrected,
                total.failed
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-privacy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn private_dir_and_file_hold_owner_only_modes() {
        let root = temp("modes");
        let nested = root.join("cache").join("clips");
        private_dir(&nested).unwrap();
        assert_eq!(mode(&nested), 0o700);
        let file = nested.join("frame.png");
        std::fs::write(&file, b"x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        private_file(&file).unwrap();
        assert_eq!(mode(&file), 0o600);
        never_index(&nested).unwrap();
        assert_eq!(mode(&nested.join(NEVER_INDEX_MARKER)), 0o600);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_private_write_is_owner_only_whatever_it_finds() {
        let root = temp("write");
        private_dir(&root).unwrap();
        let file = root.join("settings.json");
        let tmp = root.join("settings.json.tmp");
        let outside = temp("write-outside");
        std::fs::write(&outside, b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, &tmp).unwrap();
        atomic_write_private(&file, "{}").unwrap();
        assert_eq!(mode(&file), 0o600);
        assert_eq!(
            std::fs::read(&outside).unwrap(),
            b"keep",
            "a planted link is never written through"
        );
        assert!(!tmp.exists(), "the temporary is renamed away");

        std::fs::write(&tmp, b"stale").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
        atomic_write_private(&file, "{\"a\":1}").unwrap();
        assert_eq!(
            mode(&file),
            0o600,
            "a stale 0644 temporary lends the file nothing"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn an_existing_install_ends_up_owner_only() {
        let app_data = temp("existing");
        let cache = app_data.join("cache").join("clips");
        std::fs::create_dir_all(&cache).unwrap();
        let settings = app_data.join("settings.json");
        let frame = cache.join("frame.png");
        for file in [&settings, &frame] {
            std::fs::write(file, b"x").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        for dir in [&app_data, &app_data.join("cache"), &cache] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        seal_at_startup(app_data.clone(), Vec::new());
        assert_eq!(
            mode(&app_data),
            0o700,
            "the root is sealed before startup goes on"
        );
        for _ in 0..200 {
            if mode(&settings) == 0o600 && mode(&frame) == 0o600 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(mode(&settings), 0o600);
        assert_eq!(mode(&frame), 0o600);
        assert_eq!(mode(&cache), 0o700);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn backup_exclusion_is_written_once_and_reads_back_as_tmutil_sets_it() {
        let dir = temp("backup");
        private_dir(&dir).unwrap();
        assert!(exclude_from_backup(&dir).unwrap());
        assert!(
            !exclude_from_backup(&dir).unwrap(),
            "a second call finds it set"
        );
        let out = std::process::Command::new("xattr")
            .args(["-p", "com.apple.metadata:com_apple_backup_excludeItem"])
            .arg(&dir)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "com.apple.backupd"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seal_tree_corrects_every_level_and_skips_symlinks() {
        let root = temp("seal");
        let deep = root.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        let inside = deep.join("f.json");
        std::fs::write(&inside, b"{}").unwrap();
        for dir in [&root, &root.join("a"), &deep] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::set_permissions(&inside, std::fs::Permissions::from_mode(0o644)).unwrap();
        let outside = temp("seal-outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let sealed = seal_tree(&root);
        assert_eq!(sealed, Sealed { corrected: 4, failed: 0 });
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&deep), 0o700);
        assert_eq!(mode(&inside), 0o600);
        assert_eq!(mode(&outside), 0o755, "a symlink is never followed");
        assert_eq!(seal_tree(&root), Sealed::default(), "a sealed tree needs no change");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
