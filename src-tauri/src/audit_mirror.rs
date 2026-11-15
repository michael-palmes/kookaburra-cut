//! The copy of the app log a configuration profile asks for (`AuditLogPath`, docs/mdm.md): every line the local log
//! takes, appended to `<folder>/<login>.log` for the fleet's log collector and rotated like the local log. It never
//! replaces the local log, and anything wrong stops the copy, never the app.

use std::fs::File;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Owner-only: a new file takes its folder's group, which may be one every user on the Mac is in. Root collectors read it.
pub(crate) const FILE_MODE: u32 = 0o600;
const MAX_FILE_BYTES: u64 = crate::audit::MAX_FILE_BYTES as u64;
const ROTATED_KEPT: usize = crate::audit::ROTATED_KEPT;

pub(crate) struct Mirror {
    state: Mutex<Option<MirrorFile>>,
}

struct MirrorFile {
    dir: PathBuf,
    stem: String,
    file: File,
}

impl MirrorFile {
    fn path(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.stem))
    }

    /// Reopens when the name no longer leads to our file: another launch rotated it, or a collector moved it away.
    fn current(&mut self) -> std::io::Result<()> {
        let ours = self.file.metadata()?;
        let named = std::fs::symlink_metadata(self.path());
        if named.is_ok_and(|named| named.dev() == ours.dev() && named.ino() == ours.ino()) {
            return Ok(());
        }
        self.file = open_file(&self.path())?;
        Ok(())
    }

    fn append(&mut self, line: &str) -> std::io::Result<()> {
        self.current()?;
        let size = self.file.metadata()?.len();
        if size > 0 && size + line.len() as u64 + 1 > MAX_FILE_BYTES {
            self.rotate()?;
        }
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        self.file.write_all(&bytes)
    }

    /// A copy already rotated this second keeps its name: the live file runs on until the next second rather than replace it.
    fn rotate(&mut self) -> std::io::Result<()> {
        let stamp = stamp(std::time::SystemTime::now());
        let rotated = self.dir.join(format!("{}_{stamp}.log", self.stem));
        if std::fs::symlink_metadata(&rotated).is_ok() {
            return Ok(());
        }
        std::fs::rename(self.path(), rotated)?;
        self.file = open_file(&self.path())?;
        remove_old(&self.dir, &self.stem, ROTATED_KEPT)
    }
}

impl Mirror {
    /// One formatted line; a failure stops the copy for this launch and says so once in the local log.
    pub(crate) fn write_line(&self, line: &str) {
        let failed = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let Some(file) = state.as_mut() else {
                return;
            };
            match file.append(line) {
                Ok(()) => None,
                Err(e) => {
                    let path = file.path();
                    *state = None;
                    Some(format!("{}: {e}", crate::audit::path(&path)))
                }
            }
        };
        // After the lock is released: this line comes back through write_line and finds the copy stopped.
        if let Some(why) = failed {
            log::warn!("[managed] AuditLogPath: the copy stopped for this launch: {why}");
        }
    }

    pub(crate) fn path(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(MirrorFile::path)
    }
}

/// The plugin's rotated-file stamp, UTC.
fn stamp(time: std::time::SystemTime) -> String {
    crate::pack::scan::rfc3339(time)
        .trim_end_matches('Z')
        .replace('T', "_")
        .replace(':', "-")
}

/// A login name that is safe as a file name on its own.
fn usable_login(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Append-only, never through a link, never a FIFO that would block the logger, and only a file this account owns alone.
fn open_file(path: &Path) -> std::io::Result<File> {
    let file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    let uid = crate::tools::current_uid();
    if !meta.is_file() {
        return Err(std::io::Error::other("it is not a plain file"));
    }
    if meta.uid() != uid {
        return Err(std::io::Error::other("another account owns it"));
    }
    if meta.nlink() != 1 {
        return Err(std::io::Error::other("it has another name (a hard link)"));
    }
    if meta.permissions().mode() & 0o7777 != FILE_MODE {
        file.set_permissions(std::fs::Permissions::from_mode(FILE_MODE))?;
    }
    Ok(file)
}

/// Rotated copies past `keep`, oldest first, and only this account's: `bob` never touches `bob_smith`'s files.
fn remove_old(dir: &Path, stem: &str, keep: usize) -> std::io::Result<()> {
    let uid = crate::tools::current_uid();
    let mut rotated: Vec<(String, PathBuf)> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stamp = name
                .strip_prefix(stem)?
                .strip_prefix('_')?
                .strip_suffix(".log")?;
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            (crate::audit::is_stamp(stamp) && meta.is_file() && meta.uid() == uid)
                .then(|| (stamp.to_owned(), entry.path()))
        })
        .collect();
    rotated.sort();
    let excess = rotated.len().saturating_sub(keep);
    for (_, path) in rotated.into_iter().take(excess) {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Whether `dir` (already resolved) is one of `homes` or inside one, by folder identity, so case, links and firmlinks can't hide it.
fn inside_a_home(dir: &Path, homes: &[PathBuf]) -> bool {
    let ids: Vec<(u64, u64)> = homes
        .iter()
        .filter_map(|home| std::fs::metadata(home).ok())
        .map(|meta| (meta.dev(), meta.ino()))
        .collect();
    dir.ancestors().any(|step| {
        std::fs::metadata(step).is_ok_and(|meta| ids.contains(&(meta.dev(), meta.ino())))
    })
}

/// The copy for `login` in `dir`, which is made (0700) when missing. Every refusal is the one `[managed]` line's reason.
pub(crate) fn open(dir: &Path, login: &str, homes: &[PathBuf]) -> Result<Mirror, String> {
    if !usable_login(login) {
        return Err(format!(
            "the account name {} can't name a file",
            crate::audit::field(login)
        ));
    }
    let existing = dir
        .ancestors()
        .find(|step| std::fs::symlink_metadata(step).is_ok())
        .and_then(|step| step.canonicalize().ok());
    if existing.is_some_and(|existing| inside_a_home(&existing, homes)) {
        return Err(format!(
            "{} is inside a home folder",
            crate::audit::path(dir)
        ));
    }
    if std::fs::symlink_metadata(dir).is_err() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("the folder could not be made: {e}"))?;
    }
    let real = dir
        .canonicalize()
        .map_err(|e| format!("the folder can't be read: {e}"))?;
    if !real.is_dir() {
        return Err("it is not a folder".into());
    }
    if inside_a_home(&real, homes) {
        return Err(format!(
            "{} is inside a home folder",
            crate::audit::path(&real)
        ));
    }
    let stem = login.to_owned();
    let path = real.join(format!("{stem}.log"));
    let file = open_file(&path).map_err(|e| format!("{}: {e}", crate::audit::path(&path)))?;
    let mut mirror = MirrorFile {
        dir: real,
        stem,
        file,
    };
    let full = mirror
        .file
        .metadata()
        .is_ok_and(|meta| meta.len() >= MAX_FILE_BYTES);
    if full {
        mirror
            .rotate()
            .map_err(|e| format!("{}: {e}", crate::audit::path(&path)))?;
    } else {
        remove_old(&mirror.dir, &mirror.stem, ROTATED_KEPT)
            .map_err(|e| format!("the folder can't be listed to remove old copies: {e}"))?;
    }
    Ok(Mirror {
        state: Mutex::new(Some(mirror)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("kc-mirror-{tag}-{}", std::process::id()));
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

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_copy_takes_every_line_owner_only_in_a_folder_it_makes() {
        let root = temp("writes");
        let dir = root.join("Logs/Kookaburra Cut");
        let mirror = open(&dir, "alex", &[]).unwrap();
        mirror.write_line("[trust] product-tour: allowed");
        mirror.write_line("[pack] key a1b2c3d4e5f60718: imported");
        let file = dir.canonicalize().unwrap().join("alex.log");
        assert_eq!(mirror.path(), Some(file.clone()));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[trust] product-tour: allowed\n[pack] key a1b2c3d4e5f60718: imported\n"
        );
        assert_eq!(mode(&file), FILE_MODE);
        assert_eq!(mode(&dir), 0o700);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_existing_copy_is_appended_to_and_held_owner_only() {
        let dir = temp("append");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("alex.log");
        std::fs::write(&file, "earlier\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        open(&dir, "alex", &[]).unwrap().write_line("later");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "earlier\nlater\n");
        assert_eq!(mode(&file), FILE_MODE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_copy_rotates_like_the_local_log_and_keeps_two() {
        let dir = temp("rotate");
        std::fs::create_dir_all(&dir).unwrap();
        for stamp in [
            "2026-11-01_09-00-00",
            "2026-11-02_09-00-00",
            "2026-11-03_09-00-00",
        ] {
            std::fs::write(dir.join(format!("alex_{stamp}.log")), "old\n").unwrap();
        }
        let neighbour = dir.join("alex_smith_2026-11-01_09-00-00.log");
        std::fs::write(&neighbour, "theirs\n").unwrap();
        std::fs::write(dir.join("alex.log"), vec![b'x'; MAX_FILE_BYTES as usize]).unwrap();

        let mirror = open(&dir, "alex", &[]).unwrap();
        mirror.write_line("fresh");
        assert_eq!(
            std::fs::read_to_string(dir.join("alex.log")).unwrap(),
            "fresh\n"
        );
        let rotated: Vec<String> = names(&dir)
            .into_iter()
            .filter(|n| n.starts_with("alex_2"))
            .collect();
        assert_eq!(rotated.len(), ROTATED_KEPT, "{rotated:?}");
        assert!(rotated[0].starts_with("alex_2026-11-03"), "{rotated:?}");
        assert!(neighbour.exists(), "another account's files stay");

        let taken = format!("alex_{}.log", stamp(std::time::SystemTime::now()));
        std::fs::write(dir.join(&taken), "an earlier rotation this second\n").unwrap();
        let line = "y".repeat(400_000);
        for _ in 0..3 {
            mirror.write_line(&line);
        }
        let live = std::fs::metadata(dir.join("alex.log")).unwrap().len();
        assert!(live <= 2 * MAX_FILE_BYTES, "{live}");
        if dir.join(&taken).exists() {
            assert_eq!(
                std::fs::read_to_string(dir.join(&taken)).unwrap(),
                "an earlier rotation this second\n",
                "never replaced"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[allow(unsafe_code)]
    fn a_planted_file_or_link_gets_no_copy() {
        let dir = temp("planted");
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "keep\n").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("alex.log")).unwrap();
        assert!(open(&dir, "alex", &[]).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep\n");

        std::fs::hard_link(&victim, dir.join("sam.log")).unwrap();
        assert!(open(&dir, "sam", &[]).err().unwrap().contains("hard link"));

        let fifo =
            std::ffi::CString::new(dir.join("kim.log").to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(
            open(&dir, "kim", &[]).is_err(),
            "a FIFO never blocks the logger"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_inside_a_home_is_refused_however_it_is_reached() {
        let root = temp("home");
        let home = root.join("home");
        let inside = home.join("Library/Logs/KC");
        std::fs::create_dir_all(&inside).unwrap();
        let link = root.join("looks-elsewhere");
        std::os::unix::fs::symlink(&inside, &link).unwrap();
        for dir in [
            home.clone(),
            inside.clone(),
            link.clone(),
            link.join("not/made/yet"),
        ] {
            let err = open(&dir, "alex", std::slice::from_ref(&home))
                .err()
                .unwrap();
            assert!(err.contains("inside a home folder"), "{dir:?}: {err}");
        }
        assert!(!inside.join("alex.log").exists());
        assert!(
            !inside.join("not").exists(),
            "nothing is made inside a home"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unusable_folder_or_name_gets_no_copy() {
        let root = temp("unusable");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("a-file");
        std::fs::write(&file, "").unwrap();
        assert!(open(&file, "alex", &[]).is_err());
        let locked = root.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(open(&locked, "alex", &[]).is_err(), "unwritable");
        assert!(
            open(&locked.join("below"), "alex", &[]).is_err(),
            "uncreatable"
        );
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        for login in ["", "../x", "a/b", ".hidden", "name with space"] {
            assert!(open(&root, login, &[]).is_err(), "{login:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_copy_that_breaks_stops_and_never_takes_the_app_with_it() {
        let dir = temp("breaks");
        std::fs::create_dir_all(&dir).unwrap();
        let mirror = open(&dir, "alex", &[]).unwrap();
        mirror.write_line("before");
        std::fs::remove_dir_all(&dir).unwrap();
        mirror.write_line("after the folder went");
        assert_eq!(mirror.path(), None, "stopped for this launch");
        mirror.write_line("still nothing, and no panic");
    }

    #[test]
    fn a_collector_moving_the_file_away_starts_a_new_one() {
        let dir = temp("moved");
        std::fs::create_dir_all(&dir).unwrap();
        let mirror = open(&dir, "alex", &[]).unwrap();
        mirror.write_line("one");
        std::fs::rename(dir.join("alex.log"), dir.join("collected.log")).unwrap();
        mirror.write_line("two");
        assert_eq!(
            std::fs::read_to_string(dir.join("collected.log")).unwrap(),
            "one\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("alex.log")).unwrap(),
            "two\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamps_match_the_plugins_rotated_names() {
        let at = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_609_459_199);
        assert_eq!(stamp(at), "2020-12-31_23-59-59");
        assert!(crate::audit::is_stamp(&stamp(at)));
    }
}
