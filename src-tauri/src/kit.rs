//! The Claude Code kit a workspace project carries (docs/agent-kit.md, "Stamping"): the managed skill directories (`SHIPPED_SKILLS`, each with its own `kit.json`), the user's `CLAUDE.md`, and the managed keys of `.claude/settings.json`. Every step is idempotent and writes only when something changed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The primary skill: CLAUDE.md imports its RULES and the managed hooks run its kb.
pub(crate) const SKILL_NAME: &str = "kookaburra-scene-authoring";
pub(crate) const VIDEO_SKILL_NAME: &str = "kookaburra-video-editing";
pub(crate) const BRAND_SKILL_NAME: &str = "kookaburra-brand-packs";
/// Every skill stamped into a project, primary first; each lands at `.claude/skills/<name>`.
pub(crate) const SHIPPED_SKILLS: [&str; 3] = [SKILL_NAME, VIDEO_SKILL_NAME, BRAND_SKILL_NAME];
/// The kit contract version written to `kit.json` (bridge v3, Bash hooks, the `./kb` shim and `.kb/` state).
pub(crate) const KIT_VERSION: u64 = 4;
const KIT_FILE: &str = "kit.json";
const CLAUDE_MD_TEMPLATE: &str = include_str!("../templates/project-CLAUDE.md");
const SETTINGS_TEMPLATE: &str = include_str!("../templates/project-claude-settings.json");
const SHIM_TEMPLATE: &str = include_str!("../templates/project-kb.sh");
/// A root `kb` file is the app's to replace only while one of its first lines starts with this.
const SHIM_MARKER: &str = "# kookaburra-cut kb shim";
pub(crate) const SHIM_NAME: &str = "kb";
const SHIM_MODE: u32 = 0o755;
/// Every default `CLAUDE.md` shipped before the current one: a file still matching one is the app's to replace.
const PREVIOUS_CLAUDE_MD: [&str; 3] = [
    include_str!("../templates/claude-md-history/gannet.md"),
    include_str!("../templates/claude-md-history/2026-07-16.md"),
    include_str!("../templates/claude-md-history/2026-07-31.md"),
];
pub(crate) const RULES_IMPORT: &str = "@.claude/skills/kookaburra-scene-authoring/RULES.md";
const MANAGED_HOOK_MARKER: &str = "kookaburra-scene-authoring/scripts/kb.py hook";
const NAME_PLACEHOLDER: &str = "{{name}}";
/// Never copied or compared: bytecode and Finder litter would make every dev comparison differ.
const SKIPPED_NAMES: [&str; 2] = ["__pycache__", ".DS_Store"];
/// Shipped in the source tree but never stamped: kb's test suite and its fixtures stay out of user projects.
const SKIPPED_PATHS: [&str; 1] = ["scripts/tests"];
/// Staged or retired skill copies older than this belong to a stamp that crashed.
const STALE_SIBLING_MS: u128 = 600_000;

static STAMP_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct StampOptions {
    pub app_version: String,
    /// Dev builds restamp whenever the shipped tree differs; release builds when the app version does.
    pub dev: bool,
    pub now_ms: u64,
}

impl StampOptions {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> Self {
        Self {
            app_version: app.package_info().version.to_string(),
            dev: cfg!(debug_assertions),
            now_ms: now_ms(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The shipped skills found under `root`, and the names of any that are missing.
pub(crate) fn shipped_skills_in(root: &Path) -> (Vec<(&'static str, PathBuf)>, Vec<&'static str>) {
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for name in SHIPPED_SKILLS {
        let src = root.join(name);
        if src.is_dir() {
            found.push((name, src));
        } else {
            missing.push(name);
        }
    }
    (found, missing)
}

/// Stamp every part of the kit into a project folder (each `(name, source)` skill to `.claude/skills/<name>`), carrying on past a failed part and reporting the first error.
pub(crate) fn stamp_project(
    skills: &[(&str, &Path)],
    dir: &Path,
    opts: &StampOptions,
) -> Result<(), String> {
    let _guard = STAMP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let skills_dir = dir.join(".claude").join("skills");
    let mut results = vec![
        stamp_claude_md(dir),
        stamp_settings(&dir.join(".claude").join("settings.json")),
        stamp_shim(dir),
    ];
    results.extend(skills.iter().map(|(name, src)| {
        stamp_skill(src, &skills_dir.join(name), opts).map_err(|e| format!("{name}: {e}"))
    }));
    results
        .into_iter()
        .collect::<Result<Vec<()>, String>>()
        .map(|_| ())
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("bad path {}", path.display()))?;
    let tmp = path.with_file_name(format!(".{name}.kit-tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("writing {name}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("writing {name}: {e}")
    })
}

// ── CLAUDE.md ──────────────────────────────────────────────────────────────

fn normalise(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The project's name for the heading: one line, control characters flattened, capped.
fn heading_name(raw: &str) -> String {
    let flat = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let flat = normalise(&flat);
    if flat.chars().count() > 120 {
        flat.chars().take(120).collect()
    } else {
        flat
    }
}

fn project_name(dir: &Path) -> String {
    let manifest = std::fs::read_to_string(dir.join(crate::workspace::MANIFEST_FILENAME))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("name").and_then(Value::as_str).map(heading_name))
        .filter(|name| !name.is_empty());
    manifest.unwrap_or_else(|| {
        heading_name(
            &dir.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
    })
}

pub(crate) fn render_claude_md(name: &str) -> String {
    CLAUDE_MD_TEMPLATE.replace(NAME_PLACEHOLDER, name)
}

fn split_first_line(text: &str) -> (&str, &str) {
    let text = text.trim_start();
    text.split_once('\n').unwrap_or((text, ""))
}

/// Whitespace-normalised equality; a template whose heading is `{{name}}` matches any first heading.
fn matches_template(text: &str, template: &str) -> bool {
    if !template.contains(NAME_PLACEHOLDER) {
        return normalise(text) == normalise(template);
    }
    let (head, rest) = split_first_line(text);
    let (_, template_rest) = split_first_line(template);
    head.starts_with("# ") && normalise(rest) == normalise(template_rest)
}

fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes)
        && line[hashes..]
            .chars()
            .next()
            .map_or(true, char::is_whitespace)
}

/// Insert the RULES import after the first heading outside a code fence (or at the top when there is none).
pub(crate) fn insert_rules_import(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + RULES_IMPORT.len() + 4);
    let mut fenced = false;
    let mut inserted = false;
    let mut gap_owed = false;
    for line in text.split_inclusive('\n') {
        if gap_owed {
            if !line.trim().is_empty() {
                out.push('\n');
            }
            gap_owed = false;
        }
        out.push_str(line);
        if inserted {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        } else if !fenced && is_heading(trimmed) {
            if !line.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
            out.push_str(RULES_IMPORT);
            out.push('\n');
            inserted = true;
            gap_owed = true;
        }
    }
    if inserted {
        out
    } else {
        format!("{RULES_IMPORT}\n\n{text}")
    }
}

/// What `CLAUDE.md` should become, or None to leave it alone.
pub(crate) fn next_claude_md(existing: Option<&str>, name: &str) -> Option<String> {
    let current = render_claude_md(name);
    let Some(text) = existing else {
        return Some(current);
    };
    if normalise(text) == normalise(&current) {
        return None;
    }
    if matches_template(text, CLAUDE_MD_TEMPLATE)
        || PREVIOUS_CLAUDE_MD.iter().any(|p| matches_template(text, p))
    {
        return Some(current);
    }
    if text.contains(RULES_IMPORT) {
        return None;
    }
    Some(insert_rules_import(text))
}

fn stamp_claude_md(dir: &Path) -> Result<(), String> {
    let path = dir.join("CLAUDE.md");
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        // Unreadable or not UTF-8: the user's file, left alone.
        Err(_) => return Ok(()),
    };
    match next_claude_md(existing.as_deref(), &project_name(dir)) {
        Some(next) => atomic_write(&path, &next),
        None => Ok(()),
    }
}

// ── .claude/settings.json ──────────────────────────────────────────────────

/// The managed keys, exactly as docs/agent-kit.md lists them.
pub(crate) fn managed_settings() -> Value {
    let hook = |name: &str, timeout: u64| {
        json!({
            "type": "command",
            "timeout": timeout,
            // A missing kb.py must never block an edit, so the guard exits 0 before python3 can exit 2.
            "command": format!(
                "[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook {name}"
            ),
        })
    };
    json!({
        "permissions": {
            "allow": [
                "Bash(./kb *)",
                "Bash(python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
                "Bash(python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py *)",
                "Read(~/Kookaburra Cut/_bridge/**)",
                "Read(~/Kookaburra Cut/themes/**)",
                "Read(~/Kookaburra Cut/brands/**)",
                "Read(//Applications/Kookaburra Cut.app/Contents/Resources/**)"
            ]
        },
        "hooks": {
            "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [hook("session-start", 20)] }],
            "PreToolUse": [
                { "matcher": "Edit|Write", "hooks": [hook("pre-edit", 20)] },
                { "matcher": "Bash", "hooks": [hook("bash-pre", 10)] }
            ],
            "PostToolUse": [
                { "matcher": "Edit|Write", "hooks": [hook("post-edit", 30)] },
                { "matcher": "Bash", "hooks": [hook("bash-post", 30)] }
            ],
            // A Bash command that exits non-zero fires PostToolUseFailure, not PostToolUse.
            "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [hook("bash-post", 30)] }]
        }
    })
}

fn is_managed_hook(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(MANAGED_HOOK_MARKER))
}

/// Remove the managed hooks wherever they sit, re-add the current set, and add missing managed permissions; user entries are never removed.
fn merge_managed_settings(root: &mut Value) {
    let managed = managed_settings();
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if let Some(perms) = obj
        .entry("permissions")
        .or_insert_with(|| json!({}))
        .as_object_mut()
    {
        if let Some(allow) = perms
            .entry("allow")
            .or_insert_with(|| json!([]))
            .as_array_mut()
        {
            for rule in managed["permissions"]["allow"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if !allow.contains(rule) {
                    allow.push(rule.clone());
                }
            }
        }
    }
    let Some(hooks) = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
    else {
        return;
    };
    let mut emptied = BTreeSet::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        let before = groups.len();
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let count = list.len();
            list.retain(|hook| !is_managed_hook(hook));
            count == list.len() || !list.is_empty()
        });
        if before > 0 && groups.is_empty() {
            emptied.insert(event.clone());
        }
    }
    for event in emptied {
        hooks.remove(&event);
    }
    for (event, groups) in managed["hooks"].as_object().into_iter().flatten() {
        if let Some(slot) = hooks
            .entry(event.clone())
            .or_insert_with(|| json!([]))
            .as_array_mut()
        {
            slot.extend(groups.as_array().into_iter().flatten().cloned());
        }
    }
}

/// What `.claude/settings.json` should become, or None to leave it alone (unchanged, or not a JSON object).
pub(crate) fn next_settings(existing: Option<&str>) -> Option<String> {
    let (mut root, before) = match existing {
        None => (
            serde_json::from_str::<Value>(SETTINGS_TEMPLATE).unwrap_or_else(|_| json!({})),
            None,
        ),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(value) if value.is_object() => (value.clone(), Some(value)),
            _ => return None,
        },
    };
    merge_managed_settings(&mut root);
    if before.as_ref() == Some(&root) {
        return None;
    }
    serde_json::to_string_pretty(&root)
        .ok()
        .map(|text| text + "\n")
}

fn stamp_settings(path: &Path) -> Result<(), String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Ok(()),
    };
    let Some(next) = next_settings(existing.as_deref()) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(path, &next)
}

// ── The ./kb shim ──────────────────────────────────────────────────────────

fn is_managed_shim(text: &str) -> bool {
    text.lines().take(3).any(|line| line.starts_with(SHIM_MARKER))
}

/// Write the root `kb` shim (mode 0755) when it is missing or still carries the marker; a user's own `kb`, folder or link is left alone.
fn stamp_shim(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(SHIM_NAME);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() => return Ok(()),
        Ok(meta) => {
            let Ok(text) = std::fs::read_to_string(&path) else {
                return Ok(());
            };
            if !is_managed_shim(&text) {
                return Ok(());
            }
            if text == SHIM_TEMPLATE && meta.permissions().mode() & 0o777 == SHIM_MODE {
                return Ok(());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Ok(()),
    }
    let tmp = dir.join(format!(".{SHIM_NAME}.kit-tmp"));
    let result = std::fs::write(&tmp, SHIM_TEMPLATE)
        .and_then(|()| {
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(SHIM_MODE))
        })
        .and_then(|()| std::fs::rename(&tmp, &path));
    result.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("writing the kb shim: {e}")
    })
}

// ── The managed skill directory ────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Node {
    Dir,
    File(Vec<u8>),
    /// A file by size only: the release check, which must not read the whole kit on every load.
    Sized(u64),
    Link(PathBuf),
}

fn skipped(name: &std::ffi::OsStr) -> bool {
    SKIPPED_NAMES.iter().any(|s| name == *s)
}

/// A source path (relative to the skill root) that is never stamped.
fn unshipped(rel: &Path) -> bool {
    SKIPPED_PATHS.iter().any(|p| rel == Path::new(p))
}

/// `source` applies the unshipped paths: a stamped copy that still has them must differ, so the restamp drops them.
fn snapshot(root: &Path, contents: bool, source: bool) -> Option<BTreeMap<PathBuf, Node>> {
    fn walk(
        root: &Path,
        dir: &Path,
        contents: bool,
        source: bool,
        out: &mut BTreeMap<PathBuf, Node>,
    ) -> Option<()> {
        for entry in std::fs::read_dir(dir).ok()? {
            let entry = entry.ok()?;
            if skipped(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).ok()?.to_path_buf();
            if source && unshipped(&rel) {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path).ok()?;
            if meta.file_type().is_symlink() {
                out.insert(rel, Node::Link(std::fs::read_link(&path).ok()?));
            } else if meta.is_dir() {
                out.insert(rel, Node::Dir);
                walk(root, &path, contents, source, out)?;
            } else if contents {
                out.insert(rel, Node::File(std::fs::read(&path).ok()?));
            } else {
                out.insert(rel, Node::Sized(meta.len()));
            }
        }
        Some(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, contents, source, &mut out)?;
    Some(out)
}

/// Same files and links, compared byte for byte (`contents`) or by size.
fn trees_match(src: &Path, dst: &Path, contents: bool) -> bool {
    let (Some(shipped), Some(mut stamped)) = (
        snapshot(src, contents, true),
        snapshot(dst, contents, false),
    ) else {
        return false;
    };
    stamped.remove(Path::new(KIT_FILE));
    shipped == stamped
}

fn read_kit(dst: &Path) -> Option<Value> {
    let meta = std::fs::symlink_metadata(dst).ok()?;
    if !meta.is_dir() {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(dst.join(KIT_FILE)).ok()?).ok()
}

fn needs_restamp(src: &Path, dst: &Path, opts: &StampOptions) -> bool {
    let Some(kit) = read_kit(dst) else {
        return true;
    };
    if opts.dev {
        return !trees_match(src, dst, true);
    }
    // The shape check heals a file deleted or truncated inside the kit without reading it all.
    kit.get("appVersion").and_then(Value::as_str) != Some(opts.app_version.as_str())
        || kit.get("kitVersion").and_then(Value::as_u64) != Some(KIT_VERSION)
        || !trees_match(src, dst, false)
}

/// Symlinks are recreated, never followed; `rel` is `from` relative to the skill root.
fn copy_kit_tree(from: &Path, to: &Path, rel: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_rel = rel.join(entry.file_name());
        if skipped(&entry.file_name()) || unshipped(&entry_rel) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&src).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(&target, &dst)
                .map_err(|e| format!("linking {}: {e}", src.display()))?;
        } else if meta.is_dir() {
            copy_kit_tree(&src, &dst, &entry_rel)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

fn remove_tree(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let _ = std::fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(path);
        }
        Err(_) => {}
    }
}

#[cfg(target_os = "macos")]
fn swap_paths(a: &Path, b: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let a = CString::new(a.as_os_str().as_bytes())?;
    let b = CString::new(b.as_os_str().as_bytes())?;
    // RENAME_SWAP exchanges both entries in one step, so the skill path never goes missing.
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn swap_in(staged: &Path, dst: &Path, retired: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(dst).is_err() {
        return std::fs::rename(staged, dst).map_err(|e| format!("installing the skill: {e}"));
    }
    #[cfg(target_os = "macos")]
    if swap_paths(staged, dst).is_ok() {
        remove_tree(staged);
        return Ok(());
    }
    std::fs::rename(dst, retired).map_err(|e| format!("retiring the old skill: {e}"))?;
    if let Err(e) = std::fs::rename(staged, dst) {
        let _ = std::fs::rename(retired, dst);
        return Err(format!("installing the skill: {e}"));
    }
    remove_tree(retired);
    Ok(())
}

fn remove_stale_siblings(parent: &Path, name: &str) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let staged = format!(".{name}.tmp-");
    let retired = format!(".{name}.old-");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&staged) && !name.starts_with(&retired) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age.as_millis() > STALE_SIBLING_MS);
        if old {
            remove_tree(&entry.path());
        }
    }
}

/// Replace the managed skill wholesale (staged copy, then swap) so files the kit no longer ships disappear.
pub(crate) fn stamp_skill(src: &Path, dst: &Path, opts: &StampOptions) -> Result<(), String> {
    let parent = dst.parent().ok_or("the skill path has no parent")?;
    let name = dst
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the skill path has no name")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    remove_stale_siblings(parent, name);
    if !needs_restamp(src, dst, opts) {
        return Ok(());
    }
    let tag = format!("{}-{}", std::process::id(), opts.now_ms);
    let staged = parent.join(format!(".{name}.tmp-{tag}"));
    let retired = parent.join(format!(".{name}.old-{tag}"));
    remove_tree(&staged);
    let result = copy_kit_tree(src, &staged, Path::new(""))
        .and_then(|()| {
            let kit = json!({
                "kitVersion": KIT_VERSION,
                "appVersion": opts.app_version,
                "stampedAtMs": opts.now_ms,
            });
            let text = serde_json::to_string_pretty(&kit).map_err(|e| e.to_string())? + "\n";
            std::fs::write(staged.join(KIT_FILE), text)
                .map_err(|e| format!("writing kit.json: {e}"))
        })
        .and_then(|()| swap_in(&staged, dst, &retired));
    if result.is_err() {
        remove_tree(&staged);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kookaburra-kit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn opts(version: &str, dev: bool, now_ms: u64) -> StampOptions {
        StampOptions {
            app_version: version.into(),
            dev,
            now_ms,
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    // Changing the default template? Add the old one to templates/claude-md-history first, so projects still on it migrate.
    #[test]
    fn current_template_is_pinned_until_its_predecessor_is_archived() {
        let digest = Sha256::digest(normalise(CLAUDE_MD_TEMPLATE).as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(&hex[..16], "6d27c179166f70d1");
    }

    #[test]
    fn template_names_the_project_and_imports_the_rules() {
        let text = render_claude_md("Launch 2026");
        assert!(text.starts_with("# Launch 2026\n"));
        assert!(text.contains(&format!("\n{RULES_IMPORT}\n")));
        assert!(text.contains("## Notes for this project"));
        assert!(!text.contains('\u{2014}'));
    }

    #[test]
    fn missing_claude_md_is_written() {
        assert_eq!(next_claude_md(None, "Demo"), Some(render_claude_md("Demo")));
    }

    #[test]
    fn every_previous_default_is_replaced() {
        for previous in PREVIOUS_CLAUDE_MD {
            assert_eq!(
                next_claude_md(Some(previous), "Demo"),
                Some(render_claude_md("Demo"))
            );
            let reflowed = previous.replace('\n', "\n\n  ");
            assert_eq!(
                next_claude_md(Some(&reflowed), "Demo"),
                Some(render_claude_md("Demo"))
            );
        }
    }

    #[test]
    fn current_default_follows_a_rename_and_is_otherwise_left_alone() {
        let old = render_claude_md("Old name");
        assert_eq!(next_claude_md(Some(&old), "Old name"), None);
        assert_eq!(
            next_claude_md(Some(&old), "New name"),
            Some(render_claude_md("New name"))
        );
    }

    #[test]
    fn a_custom_claude_md_gets_the_import_once_after_its_first_heading() {
        let custom = "# My video\nKeep the logo top left.\n\n## Style\nWarm colours.\n";
        let next = next_claude_md(Some(custom), "Demo").unwrap();
        assert_eq!(
            next,
            format!("# My video\n\n{RULES_IMPORT}\n\nKeep the logo top left.\n\n## Style\nWarm colours.\n")
        );
        assert_eq!(next_claude_md(Some(&next), "Demo"), None);
        assert_eq!(next.matches(RULES_IMPORT).count(), 1);
    }

    #[test]
    fn the_import_skips_fenced_headings_and_prepends_without_any_heading() {
        let fenced = "Intro\n```\n# not a heading\n```\n## Real\n";
        let next = insert_rules_import(fenced);
        assert!(next.contains(&format!("## Real\n\n{RULES_IMPORT}\n")));
        assert!(next.contains("```\n# not a heading\n```"));
        assert_eq!(
            insert_rules_import("Just notes."),
            format!("{RULES_IMPORT}\n\nJust notes.")
        );
        assert_eq!(
            insert_rules_import("#hashtag line\n# Title"),
            format!("#hashtag line\n# Title\n\n{RULES_IMPORT}\n")
        );
    }

    #[test]
    fn stamping_claude_md_uses_the_manifest_name() {
        let dir = scratch("claude-md");
        write(&dir.join("project.json"), r#"{"name":"Launch\nDay"}"#);
        stamp_claude_md(&dir).unwrap();
        let text = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert!(text.starts_with("# Launch Day\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_settings_are_created_with_the_managed_keys() {
        let settings: Value = serde_json::from_str(&next_settings(None).unwrap()).unwrap();
        let allow = settings["permissions"]["allow"].as_array().unwrap();
        assert!(allow.contains(&json!("Bash(git status)")));
        for rule in managed_settings()["permissions"]["allow"]
            .as_array()
            .unwrap()
        {
            assert!(allow.contains(rule));
        }
        assert_eq!(settings["hooks"], managed_settings()["hooks"]);
    }

    #[test]
    fn the_merge_keeps_user_entries_and_replaces_stale_managed_hooks() {
        let existing = json!({
            "model": "opus",
            "permissions": { "allow": ["Bash(ls)"], "deny": ["Read(.env)"] },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo mine" }] },
                    { "matcher": "Edit", "hooks": [
                        { "type": "command", "command": "./lint.sh" },
                        { "type": "command", "timeout": 5, "command": "python3 x/.claude/skills/kookaburra-scene-authoring/scripts/kb.py hook pre-edit-old" }
                    ] },
                    { "matcher": "Bash", "hooks": [
                        { "type": "command", "command": "python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py hook bash-pre" }
                    ] }
                ],
                "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [
                    { "type": "command", "command": "python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py hook bash-post-old" }
                ] }],
                "SessionStart": [{ "matcher": "startup", "hooks": [
                    { "type": "command", "command": "python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py hook session-start" }
                ] }],
                "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]
            }
        });
        let merged: Value =
            serde_json::from_str(&next_settings(Some(&existing.to_string())).unwrap()).unwrap();
        assert_eq!(merged["model"], "opus");
        assert_eq!(merged["permissions"]["deny"], json!(["Read(.env)"]));
        assert_eq!(merged["permissions"]["allow"][0], "Bash(ls)");
        assert_eq!(merged["permissions"]["allow"].as_array().unwrap().len(), 8);
        let pre = merged["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 4);
        assert_eq!(pre[0]["hooks"][0]["command"], "echo mine");
        assert_eq!(
            pre[1]["hooks"],
            json!([{ "type": "command", "command": "./lint.sh" }])
        );
        assert_eq!(
            &pre[2..],
            managed_settings()["hooks"]["PreToolUse"]
                .as_array()
                .unwrap()
                .as_slice()
        );
        assert_eq!(
            merged["hooks"]["PostToolUseFailure"],
            managed_settings()["hooks"]["PostToolUseFailure"]
        );
        assert_eq!(
            merged["hooks"]["SessionStart"],
            managed_settings()["hooks"]["SessionStart"]
        );
        assert_eq!(merged["hooks"]["Stop"], existing["hooks"]["Stop"]);
        let again = serde_json::to_string_pretty(&merged).unwrap();
        assert_eq!(next_settings(Some(&again)), None);
    }

    #[test]
    fn the_managed_hooks_cover_bash_before_after_and_on_failure() {
        let hooks = &managed_settings()["hooks"];
        for (event, matcher, name, timeout) in [
            ("PreToolUse", "Bash", "bash-pre", 10),
            ("PostToolUse", "Bash", "bash-post", 30),
            ("PostToolUseFailure", "Bash", "bash-post", 30),
            ("PreToolUse", "Edit|Write", "pre-edit", 20),
            ("PostToolUse", "Edit|Write", "post-edit", 30),
        ] {
            let group = hooks[event]
                .as_array()
                .and_then(|groups| groups.iter().find(|g| g["matcher"] == matcher))
                .unwrap_or_else(|| panic!("{event} {matcher} missing"));
            let hook = &group["hooks"][0];
            let cmd = hook["command"].as_str().unwrap();
            assert!(cmd.ends_with(&format!("kb.py hook {name}")), "{cmd}");
            assert!(cmd.starts_with("[ ! -f \"$CLAUDE_PROJECT_DIR\"/.claude/skills/kookaburra-scene-authoring/scripts/kb.py ] || python3 -I "));
            assert!(is_managed_hook(hook));
            assert_eq!(hook["timeout"], timeout);
        }
    }

    #[test]
    fn unparseable_or_non_object_settings_are_left_alone() {
        assert_eq!(next_settings(Some("{ \"permissions\": ")), None);
        assert_eq!(next_settings(Some("[]")), None);
    }

    #[test]
    fn stamping_settings_writes_once() {
        let dir = scratch("settings");
        let path = dir.join(".claude/settings.json");
        stamp_settings(&path).unwrap();
        let first = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        stamp_settings(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), first);
        assert!(!dir.join(".claude/.settings.json.kit-tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn skill_source(dir: &Path) -> PathBuf {
        let src = dir.join("source");
        write(&src.join("SKILL.md"), "skill");
        write(&src.join("scripts/kb.py"), "print('kb')");
        write(&src.join("scripts/kblib/__pycache__/x.pyc"), "bytecode");
        write(&src.join("scripts/tests/test_kb.py"), "import unittest");
        write(&src.join("scripts/tests/fixtures/vectors.json"), "{}");
        src
    }

    fn video_source(dir: &Path) -> PathBuf {
        let src = dir.join("video-source");
        write(&src.join("SKILL.md"), "video");
        write(&src.join("reference/recipes.md"), "recipes");
        src
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn age(path: &Path) {
        let old = SystemTime::now() - std::time::Duration::from_secs(3_600);
        std::fs::File::open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    #[test]
    fn the_swap_removes_files_the_kit_no_longer_ships() {
        let dir = scratch("swap");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        write(&dst.join("REFERENCE.md"), "stale");
        write(&dst.join("SKILL.md"), "old");
        stamp_skill(&src, &dst, &opts("0.19.0", false, 1)).unwrap();
        assert!(!dst.join("REFERENCE.md").exists());
        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).unwrap(),
            "skill"
        );
        assert!(dst.join("scripts/kb.py").is_file());
        assert!(!dst.join("scripts/kblib/__pycache__").exists());
        assert!(!dst.join("scripts/tests").exists());
        assert_eq!(
            read_json(&dst.join(KIT_FILE)),
            json!({ "kitVersion": KIT_VERSION, "appVersion": "0.19.0", "stampedAtMs": 1 })
        );
        let leftovers: Vec<_> = std::fs::read_dir(dst.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(SKILL_NAME)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_builds_restamp_only_when_the_app_version_changes() {
        let dir = scratch("release");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        stamp_skill(&src, &dst, &opts("0.19.0", false, 1)).unwrap();
        write(&src.join("SKILL.md"), "newer");
        stamp_skill(&src, &dst, &opts("0.19.0", false, 2)).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).unwrap(),
            "skill"
        );
        stamp_skill(&src, &dst, &opts("0.20.0", false, 3)).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).unwrap(),
            "newer"
        );
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_builds_heal_a_file_removed_from_the_kit() {
        let dir = scratch("release-heal");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        stamp_skill(&src, &dst, &opts("0.19.0", false, 1)).unwrap();
        std::fs::remove_file(dst.join("scripts/kb.py")).unwrap();
        stamp_skill(&src, &dst, &opts("0.19.0", false, 2)).unwrap();
        assert!(dst.join("scripts/kb.py").is_file());
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_builds_restamp_whenever_the_shipped_tree_differs() {
        let dir = scratch("dev");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        stamp_skill(&src, &dst, &opts("0.19.0", true, 1)).unwrap();
        write(
            &dst.join("scripts/kblib/__pycache__/y.pyc"),
            "runtime bytecode",
        );
        stamp_skill(&src, &dst, &opts("0.19.0", true, 2)).unwrap();
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 1);
        write(&src.join("scripts/kb.py"), "print('kb v2')");
        stamp_skill(&src, &dst, &opts("0.19.0", true, 3)).unwrap();
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 3);
        assert_eq!(
            std::fs::read_to_string(dst.join("scripts/kb.py")).unwrap(),
            "print('kb v2')"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_kb_tests_never_reach_a_project_and_dev_builds_settle() {
        let dir = scratch("no-tests");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        write(
            &dst.join("scripts/tests/test_old.py"),
            "stale tests from an older kit",
        );
        write(&dst.join(KIT_FILE), "{}");
        stamp_skill(&src, &dst, &opts("0.19.0", true, 1)).unwrap();
        assert!(!dst.join("scripts/tests").exists());
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 1);
        stamp_skill(&src, &dst, &opts("0.19.0", true, 2)).unwrap();
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 1);
        stamp_skill(&src, &dst, &opts("0.19.0", false, 3)).unwrap();
        assert_eq!(read_json(&dst.join(KIT_FILE))["stampedAtMs"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_builds_restamp_a_kit_from_an_older_contract() {
        let dir = scratch("kit-version");
        let src = skill_source(&dir);
        let dst = dir.join("project/.claude/skills").join(SKILL_NAME);
        stamp_skill(&src, &dst, &opts("0.19.0", false, 1)).unwrap();
        assert_eq!(KIT_VERSION, 4);
        let mut kit = read_json(&dst.join(KIT_FILE));
        kit["kitVersion"] = json!(3);
        write(&dst.join(KIT_FILE), &kit.to_string());
        stamp_skill(&src, &dst, &opts("0.19.0", false, 2)).unwrap();
        assert_eq!(
            read_json(&dst.join(KIT_FILE)),
            json!({ "kitVersion": 4, "appVersion": "0.19.0", "stampedAtMs": 2 })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_shipped_skill_is_stamped_with_its_own_kit_file() {
        let dir = scratch("multi");
        let (scene, video) = (skill_source(&dir), video_source(&dir));
        let brand = dir.join("brand-source");
        write(&brand.join("SKILL.md"), "brand");
        let project = dir.join("project");
        write(&project.join("project.json"), r#"{"name":"Demo"}"#);
        stamp_project(
            &[
                (SKILL_NAME, &scene),
                (VIDEO_SKILL_NAME, &video),
                (BRAND_SKILL_NAME, &brand),
            ],
            &project,
            &opts("0.19.0", false, 5),
        )
        .unwrap();
        let skills = project.join(".claude/skills");
        assert_eq!(
            names_in(&skills),
            [BRAND_SKILL_NAME, SKILL_NAME, VIDEO_SKILL_NAME]
        );
        assert_eq!(
            std::fs::read_to_string(skills.join(VIDEO_SKILL_NAME).join("SKILL.md")).unwrap(),
            "video"
        );
        assert!(skills
            .join(VIDEO_SKILL_NAME)
            .join("reference/recipes.md")
            .is_file());
        for name in SHIPPED_SKILLS {
            assert_eq!(
                read_json(&skills.join(name).join(KIT_FILE)),
                json!({ "kitVersion": KIT_VERSION, "appVersion": "0.19.0", "stampedAtMs": 5 })
            );
        }
        let settings = read_json(&project.join(".claude/settings.json"));
        assert_eq!(settings["hooks"], managed_settings()["hooks"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_skill_does_not_stop_the_others() {
        let dir = scratch("one-missing");
        let video = video_source(&dir);
        let project = dir.join("project");
        write(&project.join("project.json"), r#"{"name":"Demo"}"#);
        let error = stamp_project(
            &[
                (SKILL_NAME, &dir.join("absent")),
                (VIDEO_SKILL_NAME, &video),
            ],
            &project,
            &opts("0.19.0", false, 1),
        )
        .unwrap_err();
        assert!(error.starts_with(SKILL_NAME), "{error}");
        let skills = project.join(".claude/skills");
        assert_eq!(names_in(&skills), [VIDEO_SKILL_NAME]);
        assert!(project.join("CLAUDE.md").is_file());
        assert!(project.join(".claude/settings.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_skill_clears_only_its_own_crashed_copies() {
        let dir = scratch("siblings");
        let (scene, video) = (skill_source(&dir), video_source(&dir));
        let skills = dir.join("project/.claude/skills");
        let stale = [
            format!(".{SKILL_NAME}.tmp-1-1"),
            format!(".{SKILL_NAME}.old-1-1"),
            format!(".{VIDEO_SKILL_NAME}.tmp-1-1"),
            format!(".{VIDEO_SKILL_NAME}.old-1-1"),
        ];
        for name in &stale {
            write(&skills.join(name).join("SKILL.md"), "crashed");
            age(&skills.join(name));
        }
        let young = format!(".{VIDEO_SKILL_NAME}.tmp-2-2");
        write(&skills.join(&young).join("SKILL.md"), "in flight");
        write(&skills.join(".other-skill.tmp-1-1/SKILL.md"), "not ours");
        age(&skills.join(".other-skill.tmp-1-1"));
        stamp_skill(
            &video,
            &skills.join(VIDEO_SKILL_NAME),
            &opts("0.19.0", false, 3),
        )
        .unwrap();
        assert!(skills.join(&stale[0]).exists() && skills.join(&stale[1]).exists());
        assert!(!skills.join(&stale[2]).exists() && !skills.join(&stale[3]).exists());
        stamp_skill(&scene, &skills.join(SKILL_NAME), &opts("0.19.0", false, 4)).unwrap();
        assert_eq!(
            names_in(&skills),
            [
                young.as_str(),
                ".other-skill.tmp-1-1",
                SKILL_NAME,
                VIDEO_SKILL_NAME
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shipped_skills_are_found_by_name() {
        let dir = scratch("shipped");
        write(&dir.join(SKILL_NAME).join("SKILL.md"), "skill");
        let (found, missing) = shipped_skills_in(&dir);
        assert_eq!(found, vec![(SKILL_NAME, dir.join(SKILL_NAME))]);
        assert_eq!(missing, vec![VIDEO_SKILL_NAME, BRAND_SKILL_NAME]);
        write(&dir.join(VIDEO_SKILL_NAME).join("SKILL.md"), "video");
        write(&dir.join(BRAND_SKILL_NAME).join("SKILL.md"), "brand");
        assert_eq!(shipped_skills_in(&dir).0.len(), 3);
        assert!(shipped_skills_in(&dir).1.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Where a `tauri.conf.json` resource entry puts `rel` (a path inside `.agents/skills`), mirroring tauri-utils: a directory keeps its structure, a `dir/*.ext` glob lands by file name, a file lands at its target.
    fn bundled_at(resources: &serde_json::Map<String, Value>, rel: &Path) -> Option<PathBuf> {
        let src = Path::new("../.agents/skills").join(rel);
        resources.iter().find_map(|(key, dest)| {
            let dest = PathBuf::from(dest.as_str()?);
            if let Some((dir, ext)) = key.split_once("/*.") {
                let in_dir = src.parent() == Some(Path::new(dir));
                return (in_dir && src.extension().is_some_and(|e| e == ext))
                    .then(|| dest.join(src.file_name().unwrap()));
            }
            let key = Path::new(key);
            if src == key {
                Some(dest)
            } else {
                src.strip_prefix(key).ok().map(|rest| dest.join(rest))
            }
        })
    }

    fn shipped_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            let in_skill: PathBuf = rel.components().skip(1).collect();
            if skipped(&entry.file_name()) || unshipped(&in_skill) {
                continue;
            }
            if path.is_dir() {
                shipped_files(root, &path, out);
            } else {
                out.push(rel);
            }
        }
    }

    #[test]
    fn the_repo_bundles_every_skill_file_and_no_kit_tests() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.agents/skills");
        assert!(shipped_skills_in(&root).1.is_empty());
        let conf: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let resources = conf["bundle"]["resources"].as_object().unwrap();
        for name in SHIPPED_SKILLS {
            let mut files = Vec::new();
            shipped_files(&root, &root.join(name), &mut files);
            assert!(!files.is_empty());
            for rel in files {
                assert_eq!(
                    bundled_at(resources, &rel),
                    Some(Path::new("claude-skills").join(&rel)),
                    "{} must be bundled at claude-skills/{0}",
                    rel.display()
                );
            }
            let test = Path::new(name).join("scripts/tests/test_kb.py");
            assert_eq!(
                bundled_at(resources, &test),
                None,
                "kit tests stay out of the app"
            );
        }
    }

    #[test]
    fn the_managed_settings_allow_the_kb_shim() {
        let allow = managed_settings()["permissions"]["allow"].clone();
        assert!(allow.as_array().unwrap().contains(&json!("Bash(./kb *)")));
    }

    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_shim_is_created_executable_and_runs_kb() {
        let dir = scratch("shim-new");
        stamp_shim(&dir).unwrap();
        let shim = dir.join(SHIM_NAME);
        assert_eq!(std::fs::read_to_string(&shim).unwrap(), SHIM_TEMPLATE);
        assert_eq!(mode(&shim), 0o755);
        assert!(SHIM_TEMPLATE.starts_with("#!/bin/sh\n"));
        assert!(is_managed_shim(SHIM_TEMPLATE));
        assert!(SHIM_TEMPLATE.contains("exec python3 -I \"$kb\" \"$@\""));
        assert!(!dir.join(".kb.kit-tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_marked_shim_is_upgraded_and_its_mode_restored() {
        let dir = scratch("shim-upgrade");
        let shim = dir.join(SHIM_NAME);
        write(
            &shim,
            "#!/bin/sh\n# kookaburra-cut kb shim v0 (managed by Kookaburra Cut; replaced on update)\nexec python3 old\n",
        );
        stamp_shim(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&shim).unwrap(), SHIM_TEMPLATE);
        assert_eq!(mode(&shim), 0o755);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o644)).unwrap();
        stamp_shim(&dir).unwrap();
        assert_eq!(mode(&shim), 0o755);
        let before = std::fs::metadata(&shim).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        stamp_shim(&dir).unwrap();
        assert_eq!(std::fs::metadata(&shim).unwrap().modified().unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_users_own_kb_is_left_alone() {
        let dir = scratch("shim-user");
        let mine = "#!/bin/sh\necho my own kb\n";
        write(&dir.join(SHIM_NAME), mine);
        stamp_shim(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(SHIM_NAME)).unwrap(), mine);
        let folder = scratch("shim-folder");
        std::fs::create_dir_all(folder.join(SHIM_NAME)).unwrap();
        stamp_shim(&folder).unwrap();
        assert!(folder.join(SHIM_NAME).is_dir());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn the_shim_exits_2_when_the_kit_is_missing_and_runs_kb_when_present() {
        let dir = scratch("shim-run");
        stamp_shim(&dir).unwrap();
        let missing = std::process::Command::new(dir.join(SHIM_NAME))
            .arg("status")
            .current_dir(&dir)
            .output()
            .unwrap();
        assert_eq!(missing.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&missing.stderr).contains("the kit is missing"));
        write(
            &dir.join(".claude/skills/kookaburra-scene-authoring/scripts/kb.py"),
            "import sys\nprint('kb', ' '.join(sys.argv[1:]))\n",
        );
        let ran = std::process::Command::new(dir.join(SHIM_NAME))
            .args(["status", "--json", "two words"])
            .current_dir(std::env::temp_dir())
            .output()
            .unwrap();
        assert_eq!(ran.status.code(), Some(0));
        assert_eq!(String::from_utf8_lossy(&ran.stdout), "kb status --json two words\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamping_a_project_is_idempotent() {
        let dir = scratch("project");
        let src = skill_source(&dir);
        let project = dir.join("project");
        write(&project.join("project.json"), r#"{"name":"Demo"}"#);
        write(&project.join("CLAUDE.md"), PREVIOUS_CLAUDE_MD[2]);
        stamp_project(&[(SKILL_NAME, &src)], &project, &opts("0.19.0", false, 1)).unwrap();
        let claude = std::fs::read_to_string(project.join("CLAUDE.md")).unwrap();
        assert_eq!(claude, render_claude_md("Demo"));
        let settings = std::fs::read_to_string(project.join(".claude/settings.json")).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join(SHIM_NAME)).unwrap(),
            SHIM_TEMPLATE
        );
        stamp_project(&[(SKILL_NAME, &src)], &project, &opts("0.19.0", false, 2)).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("CLAUDE.md")).unwrap(),
            claude
        );
        assert_eq!(
            std::fs::read_to_string(project.join(".claude/settings.json")).unwrap(),
            settings
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
