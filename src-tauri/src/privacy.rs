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

/// Drop the Spotlight opt-out marker in `dir`, which must already exist.
pub(crate) fn never_index(dir: &Path) -> std::io::Result<()> {
    let marker = dir.join(NEVER_INDEX_MARKER);
    if !marker.exists() {
        std::fs::write(&marker, [])?;
    }
    private_file(&marker)
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

/// The startup check: the roots are created and sealed at once, then the whole trees in the background (a clip cache
/// holds hundreds of thousands of frames). One log line names what had to be corrected.
pub(crate) fn seal_at_startup(app_data: PathBuf, sinks: Vec<PathBuf>) {
    let cache = app_data.join("cache");
    for dir in [&app_data, &cache] {
        if let Err(e) = private_dir(dir) {
            log::warn!("[privacy] could not seal {}: {e}", dir.display());
        }
    }
    let _ = never_index(&cache);
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
