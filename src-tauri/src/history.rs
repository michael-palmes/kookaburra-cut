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
/// A folder's `.git` arrives with it, so nothing in it may name a program. Keys the allow-list below can't see still lose to these.
const GUARDS: [&str; 10] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=/usr/bin/false",
    "-c",
    "core.pager=cat",
];
/// What `git init` and `git remote add` write. None names a program or moves the repository, and the app never fetches.
const INERT_KEYS: [&str; 11] = [
    "core.repositoryformatversion",
    "core.filemode",
    "core.bare",
    "core.logallrefupdates",
    "core.ignorecase",
    "core.precomposeunicode",
    "core.symlinks",
    "extensions.objectformat",
    "extensions.refstorage",
    "user.name",
    "user.email",
];
const IDENTITY: [&str; 4] = [
    "-c",
    "user.name=Kookaburra Cut",
    "-c",
    "user.email=kookaburra@localhost",
];

fn inert_key(key: &str) -> bool {
    if INERT_KEYS.contains(&key) {
        return true;
    }
    let Some((section, rest)) = key.split_once('.') else {
        return false;
    };
    let var = rest.rsplit_once('.').map(|(_, var)| var);
    match section {
        "remote" => matches!(var, Some("url" | "fetch")),
        "branch" => matches!(var, Some("remote" | "merge")),
        _ => false,
    }
}

fn isolated_git() -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null");
    command
}

/// Refuses a `.git` that reaches elsewhere for its settings, or a `.git/config` holding a key the app and git's own setup don't write. Git's own parser reads the file, with includes off, so no reading of it can differ from git's.
fn refuse_foreign(dir: &Path) -> Result<(), String> {
    let git_dir = dir.join(".git");
    match std::fs::symlink_metadata(&git_dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("reading .git: {e}")),
        Ok(meta) if !meta.is_dir() => return Err(".git is a link or a file".into()),
        Ok(_) => {}
    }
    if std::fs::symlink_metadata(git_dir.join("commondir")).is_ok() {
        return Err(".git/commondir takes its settings from another repository".into());
    }
    if let Some(link) = link_inside(&git_dir) {
        return Err(format!(
            "{} is a link or can't be read, and git would write or prune through it",
            shown(&Path::new(".git").join(link))
        ));
    }
    let config = git_dir.join("config");
    match std::fs::symlink_metadata(&config) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("reading .git/config: {e}")),
        Ok(meta) if !meta.is_file() => return Err(".git/config is not a plain file".into()),
        Ok(_) => {}
    }
    let out = isolated_git()
        .args(["config", "--file"])
        .arg(&config)
        .args(["--no-includes", "--list", "--name-only", "-z"])
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("reading .git/config: {e}"))?;
    if !out.status.success() {
        return Err(".git/config can't be read".into());
    }
    let names = String::from_utf8_lossy(&out.stdout);
    match names.split('\0').find(|k| !k.is_empty() && !inert_key(k)) {
        Some(key) => Err(format!(
            ".git/config sets {}, which the app didn't write",
            key.escape_debug().take(80).collect::<String>()
        )),
        None => Ok(()),
    }
}

/// The first link or unreadable folder anywhere below `git_dir`, as a path from it; links are never followed. Hooks never run under the guards and `live_hooks` judges them, so their folders aren't walked.
fn link_inside(git_dir: &Path) -> Option<PathBuf> {
    let parked = Path::new(crate::kit::HOOKS_ASIDE).strip_prefix(".git").ok();
    let unwalked = |rel: &Path| rel == Path::new("hooks") || Some(rel) == parked;
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let entries = match std::fs::read_dir(git_dir.join(&rel)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Some(rel),
        };
        for entry in entries.flatten() {
            let child = rel.join(entry.file_name());
            match entry.file_type() {
                Ok(kind) if kind.is_symlink() => return Some(child),
                Ok(kind) if kind.is_dir() && !unwalked(&child) => stack.push(child),
                _ => {}
            }
        }
    }
    None
}

/// What `.git/hooks` holds beyond git's own `.sample` files, of any kind, as paths from `dir`; a `.git/hooks` that isn't a real folder counts as one.
pub(crate) fn live_hooks(dir: &Path) -> Vec<PathBuf> {
    let rel = Path::new(".git").join("hooks");
    let hooks = dir.join(&rel);
    if std::fs::symlink_metadata(&hooks).is_err() {
        return Vec::new();
    }
    if !crate::real_dir::is_real_dir(&hooks) {
        return vec![rel];
    }
    let Ok(entries) = std::fs::read_dir(&hooks) else {
        return vec![rel];
    };
    let mut live: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.file_name())
        .filter(|name| !name.to_string_lossy().ends_with(".sample"))
        .map(|name| rel.join(name))
        .collect();
    live.sort();
    live
}

/// The first `.git` below the project's own, links never followed: git run in that folder uses its hooks and settings instead.
fn nested_repo(dir: &Path) -> Option<PathBuf> {
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for entry in std::fs::read_dir(dir.join(&rel))
            .into_iter()
            .flatten()
            .flatten()
        {
            let child = rel.join(entry.file_name());
            if entry.file_name() == ".git" {
                if !rel.as_os_str().is_empty() {
                    return Some(child);
                }
            } else if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push(child);
            }
        }
    }
    None
}

/// Whether git runs without macOS offering to install the developer tools, as kb's `git_available` decides.
fn git_usable() -> bool {
    static USABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *USABLE.get_or_init(|| {
        let Some(exe) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("git"))
                .find(|candidate| candidate.is_file())
        }) else {
            return false;
        };
        if std::fs::canonicalize(&exe).ok().as_deref() != Some(Path::new("/usr/bin/git")) {
            return true;
        }
        Command::new("xcode-select")
            .arg("-p")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn shown(rel: &Path) -> String {
    crate::clean_text::clean_text_with_cap(
        &crate::clean_text::clean_name(&rel.to_string_lossy()),
        80,
    )
}

/// Whether the agent's own plain `git` may run here: only where the app would run git itself, no hook would fire under it and no repository sits below it.
pub(crate) fn agent_git_verdict(dir: &Path) -> Result<(), String> {
    if let Some(nested) = nested_repo(dir) {
        return Err(format!("{} is another repository", shown(&nested)));
    }
    if std::fs::symlink_metadata(dir.join(".git")).is_err() {
        return Ok(());
    }
    if !git_usable() {
        return Err("git isn't set up on this Mac".into());
    }
    refuse_foreign(dir)?;
    match live_hooks(dir).first() {
        Some(hook) => Err(format!("{} would run under git", shown(hook))),
        None => Ok(()),
    }
}

const AGENT_FILES_COMMIT: &str = "chore: keep the agent files Kookaburra Cut checked";
const LITERAL_PATHS: [(&str, &str); 1] = [("GIT_LITERAL_PATHSPECS", "1")];

/// Agent files a worktree or a checkout would bring back: `HEAD`'s and the index's, each set by path.
#[derive(Default)]
struct Differing {
    head: std::collections::BTreeSet<String>,
    index: std::collections::BTreeSet<String>,
    /// Every agent entry read, as `(index, path, mode, object, stage)`.
    entries: Vec<(bool, String, String, String, String)>,
}

/// What the history holds that the swept folder doesn't, by who wrote it.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct CommittedAgentFiles {
    /// The app's own earlier stamps, with the folder holding its latest: saved without asking.
    pub own: Vec<String>,
    /// App-owned paths whose committed copy the app has no record of writing.
    pub unrecorded: Vec<String>,
    pub foreign: Vec<String>,
}

impl CommittedAgentFiles {
    /// What the person is shown: everything the app can't vouch for.
    pub fn listed(&self) -> Vec<String> {
        let mut listed: Vec<String> = self
            .unrecorded
            .iter()
            .chain(&self.foreign)
            .cloned()
            .collect();
        listed.sort();
        listed
    }

    pub fn is_clean(&self) -> bool {
        self.own.is_empty() && self.unrecorded.is_empty() && self.foreign.is_empty()
    }
}

/// The app's record of what it stamped in a project, kept outside the folder (`kit::stamp_key` keys).
pub(crate) struct Stamps<'a> {
    pub latest: &'a std::collections::HashSet<String>,
    pub earlier: &'a std::collections::HashSet<String>,
}

/// Whether the folder's copy at `rel` is the latest stamp, or gone because the new kit dropped it.
fn folder_holds_latest(dir: &Path, rel: &str, latest: &std::collections::HashSet<String>) -> bool {
    if !plain_file_in(dir, rel) {
        return std::fs::symlink_metadata(dir.join(rel)).is_err()
            && crate::kit::in_shipped_skill(rel);
    }
    let path = dir.join(rel);
    std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.len() <= crate::kit::STAMP_FILE_MAX)
        && std::fs::read(&path)
            .is_ok_and(|bytes| latest.contains(&crate::kit::stamp_key(rel, &bytes)))
}

/// Each object's bytes, in order, or `None` for one that isn't a blob of at most `kit::STAMP_FILE_MAX`; sizes are asked first so a huge object is never read.
fn blob_contents(dir: &Path, oids: &[&str]) -> Result<Vec<Option<Vec<u8>>>, String> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let ask = |args: &[&str], wanted: &[&str]| -> Result<Vec<u8>, String> {
        let input: String = wanted.iter().map(|oid| format!("{oid}\n")).collect();
        let out = git_output(dir, args, &[], Some(input.as_bytes()))?;
        if out.status.success() {
            Ok(out.stdout)
        } else {
            Err("git couldn't read the history's files".into())
        }
    };
    let checked = ask(&["cat-file", "--batch-check"], oids)?;
    let small: Vec<bool> = String::from_utf8_lossy(&checked)
        .lines()
        .map(|line| {
            let mut parts = line.split(' ');
            parts.nth(1) == Some("blob")
                && parts
                    .next()
                    .and_then(|size| size.parse::<u64>().ok())
                    .is_some_and(|size| size <= crate::kit::STAMP_FILE_MAX)
        })
        .collect();
    if small.len() != oids.len() {
        return Err("git's answer ended early".into());
    }
    let fetch: Vec<&str> = oids
        .iter()
        .zip(&small)
        .filter_map(|(oid, small)| small.then_some(*oid))
        .collect();
    let mut rest: &[u8] = &if fetch.is_empty() {
        Vec::new()
    } else {
        ask(&["cat-file", "--batch"], &fetch)?
    };
    let mut blobs = Vec::with_capacity(oids.len());
    for small in small {
        if !small {
            blobs.push(None);
            continue;
        }
        let end = rest
            .iter()
            .position(|b| *b == b'\n')
            .ok_or("git's answer ended early")?;
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        let size: usize = header
            .split(' ')
            .nth(2)
            .and_then(|size| size.parse().ok())
            .ok_or("git gave a size it can't have")?;
        let body = rest
            .get(end + 1..end + 1 + size)
            .ok_or("git's answer ended early")?;
        blobs.push(Some(body.to_vec()));
        rest = rest.get(end + 2 + size..).unwrap_or_default();
    }
    Ok(blobs)
}

fn classify(dir: &Path, found: &Differing, stamps: &Stamps) -> Result<CommittedAgentFiles, String> {
    let mut out = CommittedAgentFiles::default();
    let mut candidates: Vec<(String, Vec<&str>)> = Vec::new();
    for rel in found.head.union(&found.index) {
        let entries: Vec<_> = found
            .entries
            .iter()
            .filter(|(in_index, path, ..)| {
                path == rel
                    && if *in_index {
                        found.index.contains(rel)
                    } else {
                        found.head.contains(rel)
                    }
            })
            .collect();
        let regular = entries.iter().all(|(_, _, mode, _, stage)| {
            matches!(mode.as_str(), "100644" | "100755") && stage == "0"
        });
        if !crate::kit::app_owned(rel) || !regular || !folder_holds_latest(dir, rel, stamps.latest)
        {
            out.foreign.push(rel.clone());
        } else {
            candidates.push((
                rel.clone(),
                entries
                    .iter()
                    .map(|(_, _, _, oid, _)| oid.as_str())
                    .collect(),
            ));
        }
    }
    let oids: Vec<&str> = candidates
        .iter()
        .flat_map(|(_, oids)| oids.iter().copied())
        .collect();
    let mut blobs = blob_contents(dir, &oids)?.into_iter();
    for (rel, oids) in candidates {
        let mine: Vec<Option<Vec<u8>>> = blobs.by_ref().take(oids.len()).collect();
        let recorded = mine.len() == oids.len()
            && mine.iter().all(|bytes| {
                bytes.as_ref().is_some_and(|bytes| {
                    let key = crate::kit::stamp_key(&rel, bytes);
                    stamps.earlier.contains(&key) || stamps.latest.contains(&key)
                })
            });
        if recorded {
            out.own.push(rel);
        } else {
            out.unrecorded.push(rel);
        }
    }
    Ok(out)
}

/// A regular file at `rel` reached through real folders only, as the sweep leaves them.
fn plain_file_in(dir: &Path, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut at = dir.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        let Ok(meta) = std::fs::symlink_metadata(&at) else {
            return false;
        };
        let last = i + 1 == parts.len();
        if (last && !meta.is_file()) || (!last && !meta.is_dir()) {
            return false;
        }
    }
    true
}

/// `(path, mode, object, stage)` for each agent file a `-z` listing names; `index` reads `ls-files -s`, otherwise `ls-tree`.
fn agent_entries(listing: &str, index: bool) -> Vec<(String, String, String, String)> {
    listing
        .split('\0')
        .filter_map(|record| {
            let (meta, rel) = record.split_once('\t')?;
            let mut meta = meta.split_whitespace();
            let mode = meta.next()?.to_owned();
            let (oid, stage) = if index {
                (meta.next()?.to_owned(), meta.next()?.to_owned())
            } else {
                (meta.nth(1)?.to_owned(), "0".to_owned())
            };
            crate::kit::steers_agent(rel).then(|| (rel.to_owned(), mode, oid, stage))
        })
        .collect()
}

fn has_head(dir: &Path) -> Result<bool, String> {
    let out = git_output(
        dir,
        &["rev-parse", "-q", "--verify", "HEAD^{commit}"],
        &[],
        None,
    )?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) if out.stdout.is_empty() => Ok(false),
        _ => Err(format!(
            "git couldn't read HEAD: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

fn differing(dir: &Path) -> Result<Differing, String> {
    let mut found = Differing::default();
    if std::fs::symlink_metadata(dir.join(".git")).is_err() {
        return Ok(found);
    }
    if !git_usable() {
        return Err("git isn't set up on this Mac".into());
    }
    refuse_foreign(dir)?;
    let head = if has_head(dir)? {
        git(dir, &["ls-tree", "-r", "-z", "--full-tree", "HEAD"])?
    } else {
        String::new()
    };
    let index = git(dir, &["ls-files", "-s", "-z"])?;
    let mut entries: Vec<(bool, String, String)> = Vec::new();
    for (in_index, listing) in [(false, &head), (true, &index)] {
        for (rel, mode, oid, stage) in agent_entries(listing, in_index) {
            found.entries.push((
                in_index,
                rel.clone(),
                mode.clone(),
                oid.clone(),
                stage.clone(),
            ));
            let into = if in_index {
                &mut found.index
            } else {
                &mut found.head
            };
            match mode.as_str() {
                // A gitlink checks out as an empty folder: nothing in it reaches the agent.
                "160000" => {}
                "120000" => {
                    into.insert(rel);
                }
                _ if stage != "0" || rel.contains('\n') || !plain_file_in(dir, &rel) => {
                    into.insert(rel);
                }
                _ => entries.push((in_index, rel, oid)),
            }
        }
    }
    entries.retain(|(in_index, rel, oid)| {
        let kept_default = rel == "CLAUDE.md"
            && blob_contents(dir, &[oid.as_str()]).is_ok_and(|blobs| {
                blobs.into_iter().flatten().next().is_some_and(|bytes| {
                    std::str::from_utf8(&bytes).is_ok_and(crate::kit::is_default_claude_md)
                })
            });
        if kept_default {
            return false;
        }
        let set = if *in_index { &found.index } else { &found.head };
        !set.contains(rel)
    });
    if entries.is_empty() {
        return Ok(found);
    }
    let paths: String = entries
        .iter()
        .map(|(_, rel, _)| format!("{rel}\n"))
        .collect();
    let hashed = git_env(
        dir,
        &["hash-object", "--stdin-paths"],
        &[],
        Some(paths.as_bytes()),
    )?;
    let hashed: Vec<&str> = hashed.lines().collect();
    if hashed.len() != entries.len() {
        return Err("git hashed a different number of files than it was given".into());
    }
    for ((in_index, rel, oid), now) in entries.into_iter().zip(hashed) {
        if now.trim() != oid {
            if in_index {
                found.index.insert(rel);
            } else {
                found.head.insert(rel);
            }
        }
    }
    Ok(found)
}

/// Agent files the project's git holds that the swept folder doesn't, byte for byte: what a Claude worktree or a checkout would bring back, sorted by whether the app wrote them. A gitlink, and a root `CLAUDE.md` that is still a shipped default, don't count. `Err` when git can't be asked, which keeps Claude off.
pub(crate) fn committed_agent_files(
    dir: &Path,
    stamps: &Stamps,
) -> Result<CommittedAgentFiles, String> {
    classify(dir, &differing(dir)?, stamps)
}

/// Save the folder's own copy of each file `HEAD` differs on (or its removal, where the sweep moved it) in one commit of those paths alone, and put back `HEAD`'s entry for each the index alone differs on; anything else staged stays staged. Returns how many `HEAD` paths changed.
/// With `own_only`, refuses unless every difference is the app's own earlier stamp: the commit made without asking.
pub(crate) fn commit_agent_files(
    dir: &Path,
    stamps: &Stamps,
    own_only: bool,
) -> Result<usize, String> {
    let found = differing(dir)?;
    let sorted = classify(dir, &found, stamps)?;
    if own_only && !(sorted.unrecorded.is_empty() && sorted.foreign.is_empty()) {
        return Err("the history holds files Kookaburra Cut didn't write".into());
    }
    let index_only: Vec<&str> = found
        .index
        .difference(&found.head)
        .map(String::as_str)
        .collect();
    if !index_only.is_empty() {
        let mut restore = if has_head(dir)? {
            vec!["reset", "-q", "--"]
        } else {
            vec!["rm", "-q", "--cached", "--ignore-unmatch", "--"]
        };
        restore.extend(&index_only);
        git_env(dir, &restore, &LITERAL_PATHS, None)?;
    }
    if found.head.is_empty() {
        return Ok(0);
    }
    let mut add = vec!["add", "-A", "--"];
    add.extend(found.head.iter().map(String::as_str));
    git_env(dir, &add, &LITERAL_PATHS, None)?;
    let mut commit: Vec<&str> = IDENTITY.to_vec();
    commit.extend([
        "commit",
        "-q",
        "--no-verify",
        "--only",
        "-m",
        AGENT_FILES_COMMIT,
        "--",
    ]);
    commit.extend(found.head.iter().map(String::as_str));
    git_env(dir, &commit, &LITERAL_PATHS, None)?;
    Ok(found.head.len())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_env(dir, args, &[], None)
}

fn git_env(
    dir: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let out = git_output(dir, args, env, stdin)?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_output(
    dir: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut command = isolated_git();
    if let Some(parent) = dir.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }
    command
        .args(GUARDS)
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
    child.wait_with_output().map_err(|e| e.to_string())
}

/// `.git/info/exclude` carries the excluded folders (the kit's `kb` appends its own lines to the same file).
pub(crate) fn ensure_excludes(dir: &Path) -> std::io::Result<()> {
    let git_dir = dir.join(".git");
    if !crate::real_dir::is_real_dir(&git_dir) {
        return Ok(());
    }
    refuse_foreign(dir).map_err(std::io::Error::other)?;
    let path = git_dir.join("info").join("exclude");
    let current = match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() => {
            return Err(std::io::Error::other(
                ".git/info/exclude is not a plain file",
            ))
        }
        Ok(_) => std::fs::read_to_string(&path).unwrap_or_default(),
        Err(_) => String::new(),
    };
    let missing: Vec<String> = EXCLUDED
        .iter()
        .map(|name| exclude_line(name))
        .filter(|line| !current.lines().any(|have| have == line))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let info = crate::real_dir::real_dir(dir, ".git/info").map_err(std::io::Error::other)?;
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in missing {
        text.push_str(&line);
        text.push('\n');
    }
    let temp = info.join(format!(
        ".exclude.{}-{}",
        std::process::id(),
        INDEX_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut file| std::io::Write::write_all(&mut file, text.as_bytes()))
        .and_then(|()| std::fs::rename(&temp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// `git init` plus one commit of everything but the excluded folders; an explicit identity so it succeeds without a global git config.
pub(crate) fn init_repo(dir: &Path, message: &str) -> Result<(), String> {
    refuse_foreign(dir)?;
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
    if let Err(e) = refuse_foreign(dir) {
        log::warn!("[history] git left alone in {}: {e}", dir.display());
        return false;
    }
    if !crate::real_dir::is_real_dir(&dir.join(".git")) {
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
    if !crate::real_dir::is_real_dir(&dir.join(".git")) {
        return Err("the folder is a worktree or submodule".into());
    }
    refuse_foreign(dir)?;
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
/// index, expires the reflog and prunes objects (never gc, whose worktree prune deletes records). A ref another writer moved meanwhile is left alone and the next open tries again.
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
    git(dir, &["repack", "-a", "-d", "-q"])?;
    git(dir, &["prune", "--expire=now"])?;
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

    /// A program that only leaves a marker beside the project, so a test can tell it ran.
    fn marker_program(dir: &Path) -> (String, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let marker = dir.with_file_name(format!("{name}.ran"));
        let program = dir.with_file_name(format!("{name}.program"));
        let _ = std::fs::remove_file(&marker);
        std::fs::write(
            &program,
            format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        (program.to_string_lossy().into_owned(), marker)
    }

    fn app_repo(tag: &str) -> PathBuf {
        let dir = temp(tag);
        init_repo(&dir, "chore: create project").unwrap();
        dir
    }

    fn set_config(dir: &Path, key: &str, value: &str) {
        let config = dir.join(".git/config");
        let status = Command::new("git")
            .args(["config", "--file"])
            .arg(config)
            .args([key, value])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_folders_own_config_never_runs_a_program() {
        for key in [
            "core.fsmonitor",
            "core.hooksPath",
            "core.sshCommand",
            "diff.external",
            "filter.mark.clean",
            "filter.mark.smudge",
            "diff.mark.textconv",
            "gpg.program",
            "include.path",
        ] {
            let dir = app_repo(&format!("planted-{key}"));
            let (program, marker) = marker_program(&dir);
            std::fs::write(dir.join(".gitattributes"), "* filter=mark diff=mark\n").unwrap();
            std::fs::write(dir.join("scenes/intro.tsx"), b"export default 2;\n").unwrap();
            set_config(&dir, key, &program);
            assert!(!holds_excluded(&dir), "{key}");
            let name = key.to_lowercase();
            assert!(purge_excluded(&dir).unwrap_err().contains(&name), "{key}");
            assert!(
                init_repo(&dir, "again").unwrap_err().contains(&name),
                "{key}"
            );
            assert!(!marker.exists(), "{key} ran its program");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_guards_hold_where_the_refusal_is_not_consulted() {
        let dir = app_repo("guards");
        let (program, marker) = marker_program(&dir);
        let hook = dir.join(".git/hooks/reference-transaction");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::copy(&program, &hook).unwrap();
        let head = git(&dir, &["rev-parse", "HEAD"]).unwrap();
        let head = head.trim();
        let plain = Command::new("git")
            .args(["update-ref", "refs/heads/control", head])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(plain.success());
        assert!(marker.exists(), "the control run fires the hook");
        std::fs::remove_file(&marker).unwrap();
        std::fs::remove_file(&hook).unwrap();

        set_config(&dir, "core.fsmonitor", &program);
        set_config(&dir, "log.showSignature", "true");
        set_config(&dir, "gpg.program", &program);
        std::fs::copy(&program, &hook).unwrap();
        let tree = git(&dir, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let signed = format!(
            "tree {}\nauthor T <t@example.com> 1 +0000\ncommitter T <t@example.com> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n iQ\n -----END PGP SIGNATURE-----\n\nsigned\n",
            tree.trim()
        );
        let signed = git_env(
            &dir,
            &["hash-object", "-t", "commit", "-w", "--stdin"],
            &[],
            Some(signed.as_bytes()),
        )
        .unwrap();
        let signed = signed.trim();
        git(&dir, &["update-ref", "refs/heads/signed", signed]).unwrap();
        git(&dir, &["ls-files", "--", "assets", "exports"]).unwrap();
        git(&dir, &["status", "--porcelain"]).unwrap();
        git(&dir, &["log", "--all", "--format=%H", "-1", "--", "assets"]).unwrap();
        git(&dir, &["show", "-s", "--format=%ae", signed]).unwrap();
        assert!(!marker.exists(), "a planted program ran");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_git_folder_that_reaches_elsewhere_is_refused() {
        let elsewhere = app_repo("elsewhere");
        let target = elsewhere.join(".git");

        let dir = temp("git-file");
        std::fs::write(dir.join(".git"), format!("gitdir: {}\n", target.display())).unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains(".git is a link"));
        assert!(!holds_excluded(&dir));

        let dir = temp("git-link");
        std::os::unix::fs::symlink(&target, dir.join(".git")).unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains(".git is a link"));
        assert!(purge_excluded(&dir).is_err());

        let dir = app_repo("commondir");
        std::fs::write(dir.join(".git/commondir"), target.display().to_string()).unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains("commondir"));

        let dir = app_repo("config-link");
        std::fs::remove_file(dir.join(".git/config")).unwrap();
        std::os::unix::fs::symlink(target.join("config"), dir.join(".git/config")).unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains("link"));

        let dir = app_repo("config-broken");
        std::fs::write(dir.join(".git/config"), "[core\nfsmonitor = x\n").unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains("can't be read"));

        for tag in [
            "git-file",
            "git-link",
            "commondir",
            "config-link",
            "config-broken",
            "elsewhere",
        ] {
            let _ = std::fs::remove_dir_all(temp(tag));
        }
    }

    #[test]
    fn an_invalid_git_folder_never_reaches_a_parent_repository() {
        let outer = app_repo("outer");
        let (program, marker) = marker_program(&outer);
        set_config(&outer, "core.fsmonitor", &program);
        let nested = outer.join("scenes/nested");
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        assert_eq!(refuse_foreign(&nested), Ok(()));
        assert!(!holds_excluded(&nested));
        assert!(git(&nested, &["rev-parse", "--show-toplevel"]).is_err());
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&outer);
    }

    #[test]
    fn what_git_itself_writes_is_not_refused() {
        let dir = temp("inert");
        assert_eq!(refuse_foreign(&dir), Ok(()), "no repository yet");
        init_repo(&dir, "chore: create project").unwrap();
        assert_eq!(refuse_foreign(&dir), Ok(()));
        git(&dir, &["remote", "add", "origin", "/Users/x/shared.git"]).unwrap();
        for (key, value) in [
            ("branch.main.remote", "origin"),
            ("branch.main.merge", "refs/heads/main"),
            ("user.name", "Someone"),
            ("user.email", "someone@example.com"),
        ] {
            set_config(&dir, key, value);
        }
        assert_eq!(refuse_foreign(&dir), Ok(()));
        set_config(&dir, "remote.origin.uploadpack", "/bin/false");
        assert!(refuse_foreign(&dir).unwrap_err().contains("uploadpack"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_hooks_ignores_samples_and_counts_links_and_folders() {
        let dir = app_repo("live-hooks");
        let hooks = dir.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        assert_eq!(
            live_hooks(&dir),
            Vec::<PathBuf>::new(),
            "git init's own samples"
        );
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink("/bin/true", hooks.join("post-checkout")).unwrap();
        std::fs::create_dir(hooks.join("pre-push.d")).unwrap();
        std::fs::write(hooks.join("commit-msg.sample"), "").unwrap();
        assert_eq!(
            live_hooks(&dir),
            [
                ".git/hooks/post-checkout",
                ".git/hooks/pre-commit",
                ".git/hooks/pre-push.d"
            ]
            .map(PathBuf::from)
        );
        std::fs::remove_dir_all(&hooks).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), &hooks).unwrap();
        assert_eq!(live_hooks(&dir), [PathBuf::from(".git/hooks")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Attributes only name a driver; a folder can't define one while its config is held to the inert keys.
    #[test]
    fn attributes_naming_a_driver_never_run_one_under_the_agents_git() {
        let dir = app_repo("agent-attributes");
        let (program, marker) = marker_program(&dir);
        let named = "* filter=mark diff=mark merge=mark\n";
        std::fs::write(dir.join(".gitattributes"), named).unwrap();
        std::fs::create_dir_all(dir.join(".git/info")).unwrap();
        std::fs::write(dir.join(".git/info/attributes"), named).unwrap();
        std::fs::write(dir.join("scenes/intro.tsx"), b"export default 3;\n").unwrap();
        assert_eq!(agent_git_verdict(&dir), Ok(()));
        for args in [
            &["status", "--porcelain"][..],
            &["diff"],
            &["add", "-A"],
            &["commit", "-q", "-m", "x"],
            &["log", "-p", "-1"],
        ] {
            let ran = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(ran.status.success(), "{args:?}");
        }
        assert!(!marker.exists(), "an attribute ran a program");
        for key in [
            "filter.mark.clean",
            "filter.mark.smudge",
            "filter.mark.process",
            "diff.mark.command",
            "diff.mark.textconv",
            "merge.mark.driver",
            "core.attributesFile",
        ] {
            set_config(&dir, key, &program);
            let withheld = agent_git_verdict(&dir).unwrap_err();
            assert!(withheld.contains(&key.to_lowercase()), "{key}: {withheld}");
            let unset = Command::new("git")
                .args(["config", "--file"])
                .arg(dir.join(".git/config"))
                .args(["--unset", key])
                .status()
                .unwrap();
            assert!(unset.success());
        }
        assert!(!marker.exists(), "the verdict ran a program");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_live_hook_or_foreign_config_withholds_the_agents_git() {
        let dir = temp("agent-git");
        assert_eq!(agent_git_verdict(&dir), Ok(()), "no repository yet");
        init_repo(&dir, "chore: create project").unwrap();
        assert_eq!(agent_git_verdict(&dir), Ok(()));
        let hook = dir.join(".git/hooks/pre-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\n").unwrap();
        let withheld = agent_git_verdict(&dir).unwrap_err();
        assert!(withheld.contains(".git/hooks/pre-commit"), "{withheld}");
        std::fs::remove_file(&hook).unwrap();
        set_config(&dir, "core.fsmonitor", "/bin/true");
        let withheld = agent_git_verdict(&dir).unwrap_err();
        assert!(withheld.contains("core.fsmonitor"), "{withheld}");

        let nested = temp("agent-git-nested");
        std::fs::create_dir_all(nested.join("scenes/shared/.git/hooks")).unwrap();
        assert_eq!(
            agent_git_verdict(&nested).unwrap_err(),
            "scenes/shared/.git is another repository",
            "cd into it and git uses its hooks, with no root repository at all"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&nested);
    }

    fn commit_all(dir: &Path, message: &str) {
        git(dir, &["add", "-A"]).unwrap();
        let mut args: Vec<&str> = IDENTITY.to_vec();
        args.extend(["commit", "-q", "--no-verify", "-m", message]);
        git(dir, &args).unwrap();
    }

    #[test]
    fn agent_files_only_the_history_still_holds_are_found_and_saved_clean() {
        let dir = temp("committed-agent-files");
        let none = std::collections::HashSet::new();
        let stamps = Stamps {
            latest: &none,
            earlier: &none,
        };
        assert!(
            committed_agent_files(&dir, &stamps).unwrap().is_clean(),
            "no git, nothing committed"
        );
        let default_md = crate::kit::render_claude_md("Product tour");
        std::fs::write(dir.join("CLAUDE.md"), &default_md).unwrap();
        std::fs::create_dir_all(dir.join(".claude/skills/kookaburra-scene-authoring")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), "{}\n").unwrap();
        std::fs::write(
            dir.join(".claude/skills/kookaburra-scene-authoring/kb.py"),
            "ok\n",
        )
        .unwrap();
        init_repo(&dir, "chore: create project").unwrap();
        assert!(
            committed_agent_files(&dir, &stamps).unwrap().is_clean(),
            "the app's own first commit is clean"
        );

        std::fs::write(dir.join(".claude/settings.json"), "{\"hooks\":{\"x\":1}}\n").unwrap();
        std::fs::write(dir.join("AGENTſ.md"), "steer\n").unwrap();
        std::fs::create_dir_all(dir.join("scenes/.CLAUDE")).unwrap();
        std::fs::write(dir.join("scenes/.CLAUDE/commands.md"), "steer\n").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", dir.join(".mcp.json")).unwrap();
        commit_all(&dir, "shared");
        std::fs::write(dir.join("CLAUDE.md"), "# Mine\n").unwrap();
        commit_all(&dir, "my rules");
        // The sweep and stamp put the folder back; the history keeps what came in.
        std::fs::write(dir.join(".claude/settings.json"), "{}\n").unwrap();
        std::fs::remove_file(dir.join("AGENTſ.md")).unwrap();
        std::fs::remove_dir_all(dir.join("scenes/.CLAUDE")).unwrap();
        std::fs::remove_file(dir.join(".mcp.json")).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), &default_md).unwrap();
        std::fs::write(dir.join("scenes/intro.tsx"), "export default 2;\n").unwrap();
        git(&dir, &["add", "scenes/intro.tsx"]).unwrap();
        std::fs::write(dir.join("kb"), "#!/bin/sh\nplanted\n").unwrap();
        git(&dir, &["add", "-f", "kb"]).unwrap();
        std::fs::write(dir.join("kb"), "#!/bin/sh\n").unwrap();

        let found = committed_agent_files(&dir, &stamps).unwrap().listed();
        assert_eq!(
            found,
            [
                ".claude/settings.json",
                ".mcp.json",
                "AGENTſ.md",
                "CLAUDE.md",
                "kb",
                "scenes/.CLAUDE/commands.md"
            ]
        );
        assert_eq!(commit_agent_files(&dir, &stamps, false).unwrap(), 5);
        assert!(
            committed_agent_files(&dir, &stamps).unwrap().is_clean(),
            "{:?}",
            committed_agent_files(&dir, &stamps)
        );
        let staged = git(&dir, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(
            staged.trim(),
            "scenes/intro.tsx",
            "other staged work stays staged"
        );
        let last = git(&dir, &["log", "-1", "--name-only", "--format=%s"]).unwrap();
        assert!(last.starts_with(AGENT_FILES_COMMIT), "{last}");
        assert!(!last.contains("intro.tsx"), "{last}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_apps_own_earlier_stamps_save_without_asking_and_nothing_else_does() {
        let dir = temp("committed-own-stamps");
        let skill = ".claude/skills/kookaburra-scene-authoring";
        std::fs::create_dir_all(dir.join(skill)).unwrap();
        std::fs::write(dir.join(skill).join("RULES.md"), "v1\n").unwrap();
        std::fs::write(dir.join(skill).join("old.md"), "dropped later\n").unwrap();
        std::fs::write(dir.join(".claude/settings.json"), "{}\n").unwrap();
        init_repo(&dir, "chore: create project").unwrap();
        let first: std::collections::HashSet<String> =
            crate::kit::own_stamp(&dir, &crate::kit::SHIPPED_SKILLS)
                .into_iter()
                .collect();

        // An update restamps the folder; the history still holds the first stamp.
        std::fs::write(dir.join(skill).join("RULES.md"), "v2\n").unwrap();
        std::fs::remove_file(dir.join(skill).join("old.md")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), "{\"v\":2}\n").unwrap();
        let latest: std::collections::HashSet<String> =
            crate::kit::own_stamp(&dir, &crate::kit::SHIPPED_SKILLS)
                .into_iter()
                .collect();
        let earlier: std::collections::HashSet<String> =
            first.difference(&latest).cloned().collect();
        let none = std::collections::HashSet::new();
        let recorded = Stamps {
            latest: &latest,
            earlier: &earlier,
        };
        let unrecorded = Stamps {
            latest: &latest,
            earlier: &none,
        };

        let legacy = committed_agent_files(&dir, &unrecorded).unwrap();
        assert!(
            legacy.own.is_empty() && legacy.foreign.is_empty(),
            "{legacy:?}"
        );
        assert_eq!(
            legacy.unrecorded.len(),
            3,
            "no record of the first stamp: shown once"
        );

        let found = committed_agent_files(&dir, &recorded).unwrap();
        assert_eq!(
            found.own,
            [
                ".claude/settings.json".to_owned(),
                format!("{skill}/RULES.md"),
                format!("{skill}/old.md")
            ]
        );
        assert!(found.listed().is_empty());
        assert_eq!(commit_agent_files(&dir, &recorded, true).unwrap(), 3);
        assert!(committed_agent_files(&dir, &recorded).unwrap().is_clean());

        // A copy the app never wrote, at a path it owns or not, is never saved without asking.
        std::fs::write(dir.join(skill).join("RULES.md"), "planted\n").unwrap();
        std::fs::create_dir_all(dir.join(".claude/commands")).unwrap();
        std::fs::write(dir.join(".claude/commands/go.md"), "steer\n").unwrap();
        commit_all(&dir, "shared");
        std::fs::write(dir.join(skill).join("RULES.md"), "v2\n").unwrap();
        std::fs::remove_dir_all(dir.join(".claude/commands")).unwrap();
        let found = committed_agent_files(&dir, &recorded).unwrap();
        assert_eq!(found.unrecorded, [format!("{skill}/RULES.md")]);
        assert_eq!(found.foreign, [".claude/commands/go.md"]);
        assert!(commit_agent_files(&dir, &recorded, true).is_err());
        assert!(git(&dir, &["log", "-1", "--format=%s"])
            .unwrap()
            .starts_with("shared"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_path_is_judged_by_its_own_copies_and_a_huge_one_is_never_read() {
        let dir = temp("committed-alignment");
        let skill = ".claude/skills/kookaburra-scene-authoring";
        std::fs::create_dir_all(dir.join(skill)).unwrap();
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(dir.join(skill).join(name), format!("{name} v1\n")).unwrap();
        }
        init_repo(&dir, "chore: create project").unwrap();
        let stamp = |dir: &Path| -> std::collections::HashSet<String> {
            crate::kit::own_stamp(dir, &crate::kit::SHIPPED_SKILLS)
                .into_iter()
                .collect()
        };
        let first = stamp(&dir);
        // a.md: a planted copy in HEAD and another staged; b.md: the app's own earlier stamp; c.md: too big to read.
        std::fs::write(dir.join(skill).join("a.md"), "planted\n").unwrap();
        std::fs::write(
            dir.join(skill).join("c.md"),
            vec![b'x'; (crate::kit::STAMP_FILE_MAX + 1) as usize],
        )
        .unwrap();
        commit_all(&dir, "shared");
        std::fs::write(dir.join(skill).join("a.md"), "staged\n").unwrap();
        git(&dir, &["add", "--", &format!("{skill}/a.md")]).unwrap();
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(dir.join(skill).join(name), format!("{name} v2\n")).unwrap();
        }
        let latest = stamp(&dir);
        let earlier: std::collections::HashSet<String> =
            first.difference(&latest).cloned().collect();
        let found = committed_agent_files(
            &dir,
            &Stamps {
                latest: &latest,
                earlier: &earlier,
            },
        )
        .unwrap();
        assert_eq!(found.own, [format!("{skill}/b.md")], "{found:?}");
        assert_eq!(
            found.unrecorded,
            [format!("{skill}/a.md"), format!("{skill}/c.md")]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_history_git_cant_be_trusted_with_is_never_passed_as_clean() {
        let dir = temp("committed-agent-files-foreign");
        init_repo(&dir, "chore: create project").unwrap();
        git(&dir, &["config", "core.pager", "less"]).unwrap();
        let none = std::collections::HashSet::new();
        let stamps = Stamps {
            latest: &none,
            earlier: &none,
        };
        assert!(committed_agent_files(&dir, &stamps).is_err());
        let _ = std::fs::remove_dir_all(&dir);
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

    fn legacy_repo(tag: &str) -> PathBuf {
        let dir = app_repo(tag);
        git(&dir, &["add", "-f", "assets/shot.png"]).unwrap();
        let mut args: Vec<&str> = IDENTITY.to_vec();
        args.extend(["commit", "-q", "--no-verify", "-m", "checkpoint"]);
        git(&dir, &args).unwrap();
        assert!(holds_excluded(&dir));
        dir
    }

    fn victim(dir: &Path) -> PathBuf {
        let victim = dir.with_file_name(format!(
            "{}.victim",
            dir.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&victim);
        std::fs::create_dir_all(victim.join("other-project")).unwrap();
        std::fs::write(victim.join("other-project/project.json"), b"{}").unwrap();
        std::fs::write(victim.join("notes.txt"), b"mine\n").unwrap();
        victim
    }

    fn assert_victim_untouched(victim: &Path) {
        assert_eq!(
            std::fs::read(victim.join("other-project/project.json")).unwrap(),
            b"{}"
        );
        assert_eq!(std::fs::read(victim.join("notes.txt")).unwrap(), b"mine\n");
        let _ = std::fs::remove_dir_all(victim);
    }

    #[test]
    fn a_link_inside_the_git_folder_is_never_written_or_pruned_through() {
        for rel in ["worktrees", "objects/pack", "logs", "refs/tags", "info"] {
            let dir = legacy_repo(&format!("inner-link-{}", rel.replace('/', "-")));
            let victim = victim(&dir);
            let link = dir.join(".git").join(rel);
            let _ = std::fs::remove_dir_all(&link);
            std::os::unix::fs::symlink(&victim, &link).unwrap();
            let purged = purge_excluded(&dir);
            let excluded = ensure_excludes(&dir);
            assert_victim_untouched(&victim);
            assert!(purged.is_err(), "{rel}");
            assert!(excluded.is_err(), "{rel}");
            assert!(refuse_foreign(&dir).unwrap_err().contains("link"), "{rel}");
            assert!(!holds_excluded(&dir), "{rel}");
            assert!(agent_git_verdict(&dir).is_err(), "{rel}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        use std::os::unix::fs::PermissionsExt;
        let dir = legacy_repo("unreadable");
        let shut = dir.join(".git/objects/info");
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o300)).unwrap();
        assert!(refuse_foreign(&dir).unwrap_err().contains("can't be read"));
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let dir = legacy_repo("exclude-link");
        let victim = victim(&dir);
        let exclude = dir.join(".git/info/exclude");
        std::fs::remove_file(&exclude).unwrap();
        std::os::unix::fs::symlink(victim.join("notes.txt"), &exclude).unwrap();
        assert!(ensure_excludes(&dir).is_err());
        assert!(init_repo(&dir, "again").is_err());
        assert!(purge_excluded(&dir).is_err());
        assert_victim_untouched(&victim);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_trim_never_prunes_worktree_records() {
        let dir = legacy_repo("worktree-records");
        let record = dir.join(".git/worktrees/elsewhere");
        std::fs::create_dir_all(&record).unwrap();
        std::fs::write(record.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        purge_excluded(&dir).unwrap();
        assert!(record.join("HEAD").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
