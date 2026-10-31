//! Folders the app owns inside a project. A shared folder keeps the links a pack refuses, so what is already at one of these paths is never trusted.

use std::path::{Component, Path, PathBuf};

/// Whether `path` is a real folder, not a link to one.
pub(crate) fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// `root/rel` as a real folder, made when missing. A link or file at any step of `rel` is refused by name; `root` is the caller's.
pub(crate) fn real_dir(root: &Path, rel: impl AsRef<Path>) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("creating {}: {e}", root.display()))?;
    let mut path = root.to_path_buf();
    for part in rel.as_ref().components() {
        let Component::Normal(name) = part else {
            return Err(format!(
                "{} is not inside {}",
                rel.as_ref().display(),
                root.display()
            ));
        };
        path.push(name);
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !is_real_dir(&path) {
                    return Err(format!(
                        "{} is a link or a file, not a folder, so nothing was changed: move it aside and try again",
                        path.display()
                    ));
                }
            }
            Err(e) => return Err(format!("creating {}: {e}", path.display())),
        }
    }
    Ok(path)
}

#[cfg(test)]
pub(crate) mod hostile {
    use std::path::{Path, PathBuf};

    /// A folder of old files that a planted link points at, and the project beside it.
    pub(crate) fn folder(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "kc-hostile-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let (project, victim) = (base.join("product-tour"), base.join("victim"));
        std::fs::create_dir_all(project.join("assets")).unwrap();
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(
            project.join("project.json"),
            r#"{"name":"Demo","scenes":[]}"#,
        )
        .unwrap();
        std::fs::write(victim.join("old.txt"), b"mine").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(victim.join("old.txt"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        (project, victim)
    }

    pub(crate) fn plant(project: &Path, rel: &str, target: &Path) {
        let link = project.join(rel);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    pub(crate) fn assert_untouched(victim: &Path) {
        let names = std::fs::read_dir(victim)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, ["old.txt"]);
        assert_eq!(std::fs::read(victim.join("old.txt")).unwrap(), b"mine");
    }

    pub(crate) fn clean_up(project: &Path) {
        let _ = std::fs::remove_dir_all(project.parent().unwrap());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_folder_is_made_and_a_real_one_kept() {
        let (project, victim) = hostile::folder("made");
        let made = real_dir(&project, ".kb/kit-replaced").unwrap();
        assert_eq!(made, project.join(".kb/kit-replaced"));
        assert!(is_real_dir(&made));
        std::fs::write(made.join("kept"), b"x").unwrap();
        assert_eq!(real_dir(&project, ".kb/kit-replaced").unwrap(), made);
        assert!(made.join("kept").exists());
        hostile::assert_untouched(&victim);
        hostile::clean_up(&project);
    }

    #[test]
    fn a_link_or_file_at_any_step_is_refused_by_name_and_nothing_lands_behind_it() {
        let (project, victim) = hostile::folder("refused");
        hostile::plant(&project, ".kb", &victim);
        let e = real_dir(&project, ".kb/thumbs").unwrap_err();
        assert!(e.contains(".kb is a link or a file"), "{e}");
        hostile::assert_untouched(&victim);

        hostile::plant(&project, "assets/.kc-render", &victim);
        assert!(!is_real_dir(&project.join("assets/.kc-render")));
        let e = real_dir(&project.join("assets"), ".kc-render").unwrap_err();
        assert!(e.contains(".kc-render is a link or a file"), "{e}");

        hostile::plant(&project, "gone", &victim.join("nowhere"));
        assert!(real_dir(&project, "gone").is_err());
        assert!(!victim.join("nowhere").exists());

        std::fs::write(project.join("plain"), b"x").unwrap();
        assert!(real_dir(&project, "plain").is_err());
        assert!(real_dir(&project, "../escape").is_err());
        hostile::assert_untouched(&victim);
        hostile::clean_up(&project);
    }
}
