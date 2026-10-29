//! The per-project git repository holds the project's authored history only: `project.json`, `scenes/` and the edit
//! documents the kit checkpoints. Footage and renders (`assets/`, `exports/`) are excluded from the first commit, so a
//! trashed screenshot is gone rather than kept in `.git`. A project created before this rule carries asset blobs in its
//! history; its next open rewrites that history without them, expires the reflog and prunes, off the load path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Top-level folders the repository never tracks.
const EXCLUDED: [&str; 2] = ["assets", "exports"];
/// Projects with a purge in flight in this process; a second open or a terminal start must not start another.
static PURGING: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static INDEX_SEQ: AtomicU64 = AtomicU64::new(0);

/// The exclude line for one folder: anchored, so a scene folder of the same name would still be seen.
fn exclude_line(name: &str) -> String {
    format!("/{name}/")
}
const APP_EMAIL: &str = "kookaburra@localhost";
const IDENTITY: [&str; 4] = [
    "-c",
    "user.name=Kookaburra Cut",
    "-c",
    "user.email=kookaburra@localhost",
];

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_env(dir, args, &[], None)
}

fn git_env(
    dir: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(dir)
        .envs(env.iter().copied())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("git {}: {e}", args.first().unwrap_or(&"")))?;
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `.git/info/exclude` carries the excluded folders (the kit's `kb` appends its own lines to the same file).
pub(crate) fn ensure_excludes(dir: &Path) -> std::io::Result<()> {
    let git_dir = dir.join(".git");
    if !git_dir.is_dir() {
        return Ok(());
    }
    let path = git_dir.join("info").join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let missing: Vec<String> = EXCLUDED
        .iter()
        .map(|name| exclude_line(name))
        .filter(|line| !current.lines().any(|have| have == line))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap_or(&git_dir))?;
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in missing {
        text.push_str(&line);
        text.push('\n');
    }
    std::fs::write(&path, text)
}

/// `git init` plus one commit of everything but the excluded folders; an explicit identity so it succeeds without a global git config.
pub(crate) fn init_repo(dir: &Path, message: &str) -> Result<(), String> {
    git(dir, &["init", "-q"])?;
    ensure_excludes(dir).map_err(|e| format!("writing .git/info/exclude: {e}"))?;
    git(dir, &["add", "-A"])?;
    let mut args: Vec<&str> = IDENTITY.to_vec();
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    git(dir, &args)?;
    Ok(())
}

/// Whether the repository's index or any commit still carries an excluded folder.
pub(crate) fn holds_excluded(dir: &Path) -> bool {
    if !dir.join(".git").is_dir() {
        return false;
    }
    let tracked = git(dir, &["ls-files", "--", "assets", "exports"]).unwrap_or_default();
    if !tracked.trim().is_empty() {
        return true;
    }
    let mut args = vec!["log", "--all", "--format=%H", "-1", "--"];
    args.extend(EXCLUDED);
    git(dir, &args).is_ok_and(|out| !out.trim().is_empty())
}

/// Runs `purge_excluded` unless this process already has one running for `dir`.
pub(crate) fn purge_excluded_once(dir: &Path) -> Option<Result<Purged, String>> {
    let claimed = {
        let mut guard = PURGING.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .get_or_insert_with(HashSet::new)
            .insert(dir.to_path_buf())
    };
    if !claimed {
        return None;
    }
    let outcome = purge_excluded(dir);
    let mut guard = PURGING.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(dir);
    }
    Some(outcome)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Purged {
    pub commits_rewritten: usize,
    pub freed_bytes: u64,
}

/// Only a repository the app made is rewritten: one with a remote, a root commit by someone else, or a `.git` file (a
/// worktree or submodule) has history people may have pushed or shared, so its hashes stay as they are.
fn owned_by_app(dir: &Path) -> Result<(), String> {
    if !dir.join(".git").is_dir() {
        return Err("the folder is a worktree or submodule".into());
    }
    let remotes = git(dir, &["remote"])?;
    if let Some(remote) = remotes.lines().next() {
        return Err(format!("the repository has a remote ({remote})"));
    }
    let roots = git(dir, &["rev-list", "--max-parents=0", "--all"])?;
    for root in roots.lines() {
        let email = git(dir, &["show", "-s", "--format=%ae", root])?;
        if email.trim() != APP_EMAIL {
            return Err(format!(
                "the first commit is by {}, not the app",
                email.trim()
            ));
        }
    }
    Ok(())
}

/// Rewrites every branch and lightweight tag without the excluded folders (authors, dates and messages kept), untracks them in the
/// index, expires the reflog and prunes. A ref another writer moved meanwhile is left alone and the next open tries again.
pub(crate) fn purge_excluded(dir: &Path) -> Result<Purged, String> {
    owned_by_app(dir)?;
    let before = crate::clip_cache::dir_bytes(&dir.join(".git"));
    ensure_excludes(dir).map_err(|e| format!("writing .git/info/exclude: {e}"))?;
    let refs = commit_refs(dir)?;
    let index = temp_index(dir);
    let rewritten = rewrite_refs(dir, &index, &refs);
    let _ = std::fs::remove_file(&index);
    let rewritten = rewritten?;
    untrack_excluded(dir)?;
    git(dir, &["reflog", "expire", "--expire=now", "--all"])?;
    git(dir, &["gc", "--prune=now", "--quiet"])?;
    let after = crate::clip_cache::dir_bytes(&dir.join(".git"));
    Ok(Purged {
        commits_rewritten: rewritten,
        freed_bytes: before.saturating_sub(after),
    })
}

/// Rewrites each ref's history without the excluded folders and moves the ref only if nothing else moved it first; returns the commits rewritten.
fn rewrite_refs(dir: &Path, index: &Path, refs: &[String]) -> Result<usize, String> {
    let mut map: std::collections::HashMap<String, String> = Default::default();
    let mut rewritten = 0usize;
    for name in refs {
        let old = git(
            dir,
            &["rev-parse", "--verify", &format!("{name}^{{commit}}")],
        )?;
        let old = old.trim().to_owned();
        let listing = git(
            dir,
            &["rev-list", "--reverse", "--topo-order", "--parents", &old],
        )?;
        for line in listing.lines() {
            let mut ids = line.split_whitespace();
            let Some(commit) = ids.next() else { continue };
            if map.contains_key(commit) {
                continue;
            }
            let parents: Vec<String> = ids
                .map(|p| map.get(p).cloned().unwrap_or_else(|| p.to_owned()))
                .collect();
            let parents_moved = parents
                .iter()
                .zip(line.split_whitespace().skip(1))
                .any(|(new, old)| new != old);
            let mut args = vec!["ls-tree", "--name-only", commit, "--"];
            args.extend(EXCLUDED);
            let has_excluded = !git(dir, &args)?.trim().is_empty();
            if !has_excluded && !parents_moved {
                map.insert(commit.to_owned(), commit.to_owned());
                continue;
            }
            let new = rewrite_commit(dir, index, commit, &parents)?;
            map.insert(commit.to_owned(), new);
            rewritten += 1;
        }
        let new = map.get(&old).cloned().unwrap_or_else(|| old.clone());
        if new != old {
            git(dir, &["update-ref", name, &new, &old])?;
        }
    }
    Ok(rewritten)
}

/// Local branches and lightweight tags, plus a detached HEAD, each naming a commit.
fn commit_refs(dir: &Path) -> Result<Vec<String>, String> {
    let listing = git(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname) %(objecttype)",
            "refs/heads",
            "refs/tags",
        ],
    )?;
    let mut refs: Vec<String> = listing
        .lines()
        .filter_map(|line| line.strip_suffix(" commit"))
        .map(str::to_owned)
        .collect();
    if git(dir, &["symbolic-ref", "-q", "HEAD"]).is_err()
        && git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
    {
        refs.push("HEAD".into());
    }
    Ok(refs)
}

fn temp_index(dir: &Path) -> PathBuf {
    dir.join(".git").join(format!(
        "kookaburra-index-{}-{}",
        std::process::id(),
        INDEX_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The same commit over a tree without the excluded folders, built in a private index so the real one and the working tree never move.
fn rewrite_commit(
    dir: &Path,
    index: &Path,
    commit: &str,
    parents: &[String],
) -> Result<String, String> {
    let index = index.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", index.as_str())];
    git_env(dir, &["read-tree", commit], &env, None)?;
    let mut rm = vec!["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--"];
    rm.extend(EXCLUDED);
    git_env(dir, &rm, &env, None)?;
    let tree = git_env(dir, &["write-tree"], &env, None)?;
    let tree = tree.trim().to_owned();
    let meta = git(
        dir,
        &[
            "show",
            "-s",
            "--date=raw",
            "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B",
            commit,
        ],
    )?;
    let fields: Vec<&str> = meta.splitn(7, '\0').collect();
    let [an, ae, ad, cn, ce, cd, body] = fields[..] else {
        return Err(format!("unreadable commit {commit}"));
    };
    let identity = [
        ("GIT_AUTHOR_NAME", an),
        ("GIT_AUTHOR_EMAIL", ae),
        ("GIT_AUTHOR_DATE", ad),
        ("GIT_COMMITTER_NAME", cn),
        ("GIT_COMMITTER_EMAIL", ce),
        ("GIT_COMMITTER_DATE", cd),
    ];
    let mut args = vec!["commit-tree", tree.as_str()];
    for parent in parents {
        args.push("-p");
        args.push(parent);
    }
    let message = body.strip_suffix('\n').unwrap_or(body);
    let new = git_env(dir, &args, &identity, Some(message.as_bytes()))?;
    Ok(new.trim().to_owned())
}

/// Drops the excluded folders from the real index whatever their staged state, retrying briefly when the kit holds `index.lock`.
fn untrack_excluded(dir: &Path) -> Result<(), String> {
    let mut args = vec!["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--"];
    args.extend(EXCLUDED);
    let mut delay = 50u64;
    loop {
        match git(dir, &args) {
            Ok(_) => return Ok(()),
            Err(e) if e.contains("index.lock") && delay <= 1600 => {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                delay *= 2;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-history-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("exports")).unwrap();
        std::fs::write(dir.join("project.json"), b"{\"id\":\"product-tour\"}\n").unwrap();
        std::fs::write(dir.join("scenes/intro.tsx"), b"export default 1;\n").unwrap();
        std::fs::write(dir.join("scenes/intro.json"), b"{}\n").unwrap();
        std::fs::write(dir.join("assets/shot.png"), vec![7u8; 4096]).unwrap();
        std::fs::write(dir.join("exports/film.mp4"), vec![9u8; 4096]).unwrap();
        dir
    }

    fn tracked(dir: &Path) -> Vec<String> {
        git(dir, &["ls-files"])
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_fresh_repo_tracks_the_authored_files_and_ignores_footage() {
        let dir = temp("fresh");
        init_repo(&dir, "chore: create project").unwrap();
        assert_eq!(
            tracked(&dir),
            ["project.json", "scenes/intro.json", "scenes/intro.tsx"]
        );
        assert_eq!(
            git(&dir, &["status", "--porcelain"]).unwrap().trim(),
            "",
            "excluded folders never show as untracked"
        );
        assert!(!holds_excluded(&dir));
        std::fs::write(dir.join("assets/later.png"), b"x").unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        assert_eq!(tracked(&dir).len(), 3, "add -A skips the excluded folders");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repository_the_app_did_not_make_is_left_alone() {
        let dir = temp("foreign");
        git(&dir, &["init", "-q"]).unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        git(
            &dir,
            &[
                "-c",
                "user.name=Someone",
                "-c",
                "user.email=someone@example.com",
                "commit",
                "-q",
                "--no-verify",
                "-m",
                "their own first commit",
            ],
        )
        .unwrap();
        assert!(holds_excluded(&dir));
        let refused = purge_excluded(&dir).unwrap_err();
        assert!(refused.contains("someone@example.com"), "{refused}");
        assert!(tracked(&dir).contains(&"assets/shot.png".to_owned()));

        let dir = temp("remote");
        init_repo(&dir, "chore: create project").unwrap();
        git(&dir, &["add", "-f", "assets/shot.png"]).unwrap();
        let mut args: Vec<&str> = IDENTITY.to_vec();
        args.extend(["commit", "-q", "--no-verify", "-m", "footage"]);
        git(&dir, &args).unwrap();
        git(&dir, &["remote", "add", "origin", "/Users/x/shared.git"]).unwrap();
        assert!(holds_excluded(&dir));
        let head = git(&dir, &["rev-parse", "HEAD"]).unwrap();
        let refused = purge_excluded(&dir).unwrap_err();
        assert!(refused.contains("remote (origin)"), "{refused}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(tracked(&dir).contains(&"assets/shot.png".to_owned()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_legacy_history_loses_its_footage_and_keeps_its_scenes() {
        let dir = temp("legacy");
        git(&dir, &["init", "-q"]).unwrap();
        let commit = |msg: &str| {
            git(&dir, &["add", "-A"]).unwrap();
            let mut args: Vec<&str> = IDENTITY.to_vec();
            args.extend(["commit", "-q", "--no-verify", "-m", msg]);
            git(&dir, &args).unwrap();
        };
        commit("chore: create project");
        std::fs::write(dir.join("scenes/intro.tsx"), b"export default 2;\n").unwrap();
        std::fs::write(dir.join("assets/shot.png"), vec![8u8; 4096]).unwrap();
        commit("checkpoint: second take");
        std::fs::write(dir.join("assets/more.png"), vec![3u8; 2048]).unwrap();
        commit("checkpoint: more footage");
        std::fs::write(dir.join("scenes/intro.tsx"), b"export default 3;\n").unwrap();
        std::fs::write(dir.join("assets/staged.png"), vec![4u8; 1024]).unwrap();
        git(&dir, &["add", "assets/staged.png"]).unwrap();
        std::fs::write(dir.join("assets/staged.png"), vec![5u8; 1024]).unwrap();
        let blob = git(&dir, &["rev-parse", "HEAD:assets/shot.png"]).unwrap();
        let blob = blob.trim().to_owned();
        let log = ["log", "--format=%an <%ae> %at %cn <%ce> %ct %B"];
        let before = git(&dir, &log).unwrap();
        assert!(holds_excluded(&dir));

        let purged = purge_excluded(&dir).unwrap();
        assert_eq!(purged.commits_rewritten, 3);
        assert_eq!(
            git(&dir, &log).unwrap(),
            before,
            "authors, dates and messages survive"
        );
        assert!(!holds_excluded(&dir));
        assert_eq!(
            tracked(&dir),
            ["project.json", "scenes/intro.json", "scenes/intro.tsx"]
        );
        assert_eq!(
            git(&dir, &["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "3"
        );
        assert_eq!(
            git(&dir, &["show", "HEAD~1:scenes/intro.tsx"]).unwrap(),
            "export default 2;\n"
        );
        assert_eq!(
            git(&dir, &["log", "--format=%s", "-1"]).unwrap().trim(),
            "checkpoint: more footage"
        );
        assert!(
            git(&dir, &["cat-file", "-e", &blob]).is_err(),
            "the asset blob is gone from the object store"
        );
        assert!(
            dir.join("assets/shot.png").is_file(),
            "the working tree keeps the file"
        );
        assert_eq!(
            std::fs::read(dir.join("assets/staged.png")).unwrap(),
            vec![5u8; 1024]
        );
        assert_eq!(
            git(&dir, &["status", "--porcelain"]).unwrap().trim_end(),
            " M scenes/intro.tsx",
            "an uncommitted scene edit survives untouched"
        );
        assert_eq!(
            purge_excluded_once(&dir)
                .unwrap()
                .unwrap()
                .commits_rewritten,
            0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
