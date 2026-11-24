//! Whether Claude Code's own managed policy pins sign-in to an organisation on this Mac: `forceLoginOrgUUID` in its managed settings file, a drop-in beside it, or forced in its preference domain. `RequireManagedClaude` (docs/mdm.md) keeps Claude off unless one of them holds it. Settings an organisation delivers only from the claude.ai admin console are not visible to another app, so they do not count here. Anything unreadable, oversized or malformed reads as missing.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::managed::PrefValue;

/// Claude Code's managed settings file on macOS.
pub const MANAGED_SETTINGS_FILE: &str =
    "/Library/Application Support/ClaudeCode/managed-settings.json";
/// The drop-in folder beside it; every `*.json` there is read.
pub const MANAGED_SETTINGS_DROP_INS: &str =
    "/Library/Application Support/ClaudeCode/managed-settings.d";
/// The preference domain a configuration profile for Claude Code targets.
pub const CLAUDE_CODE_DOMAIN: &str = "com.anthropic.claudecode";
/// The key that pins sign-in to an organisation; Claude Code enforces it only from a managed source.
pub const ORG_KEY: &str = "forceLoginOrgUUID";

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_DROP_INS: usize = 64;
const CACHE_FOR: Duration = Duration::from_secs(60);

/// Where the policy is read from; tests inject their own.
pub struct Sources<'a> {
    pub file: &'a Path,
    pub drop_ins: &'a Path,
    /// A forced key in Claude Code's preference domain.
    pub forced: &'a dyn Fn(&str) -> Option<PrefValue>,
    /// Count a file only when root owns it and nobody else can write it; off in tests, which can't make one.
    pub root_owned_only: bool,
}

/// What an installer or an MDM leaves, and what nobody makes without the administrator password: `/Library/Application Support` itself is writable by the admin group.
fn root_owned(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

/// A non-empty string, or a non-empty array of non-empty strings.
fn pins_json(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::String(id)) => !id.trim().is_empty(),
        Some(serde_json::Value::Array(ids)) => {
            !ids.is_empty()
                && ids
                    .iter()
                    .all(|id| id.as_str().is_some_and(|id| !id.trim().is_empty()))
        }
        _ => false,
    }
}

fn pins_pref(value: Option<PrefValue>) -> bool {
    match value {
        Some(PrefValue::String(id)) => !id.trim().is_empty(),
        Some(PrefValue::Array(ids)) => {
            !ids.is_empty()
                && ids
                    .iter()
                    .all(|id| matches!(id, PrefValue::String(id) if !id.trim().is_empty()))
        }
        _ => false,
    }
}

/// One settings file: a regular file (links followed, as Claude Code follows them) within the size cap that parses as a JSON object holding the key.
fn file_pins(path: &Path, root_owned_only: bool) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return false;
    }
    if root_owned_only && !root_owned(meta.uid(), meta.mode()) {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .is_ok_and(|settings| pins_json(settings.get(ORG_KEY)))
}

fn drop_in_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    files.sort();
    files.truncate(MAX_DROP_INS);
    files
}

/// Whether any source pins an organisation.
pub fn org_pinned_in(sources: &Sources) -> bool {
    pins_pref((sources.forced)(ORG_KEY))
        || file_pins(sources.file, sources.root_owned_only)
        || drop_in_files(sources.drop_ins)
            .iter()
            .any(|path| file_pins(path, sources.root_owned_only))
}

fn read_system() -> bool {
    org_pinned_in(&Sources {
        file: Path::new(MANAGED_SETTINGS_FILE),
        drop_ins: Path::new(MANAGED_SETTINGS_DROP_INS),
        forced: &|key| crate::managed::forced_in(CLAUDE_CODE_DOMAIN, key),
        root_owned_only: true,
    })
}

static CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/// This Mac's answer, re-read at most once a minute so the bridge's loops never hit the disk each tick.
pub fn org_pinned() -> bool {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, pinned)) = *cache {
        if at.elapsed() < CACHE_FOR {
            return pinned;
        }
    }
    let pinned = read_system();
    *cache = Some((Instant::now(), pinned));
    pinned
}

/// Read again now: before a handoff and when a person turns Claude on, so a policy IT just installed counts at once.
pub fn refresh() -> bool {
    let pinned = read_system();
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), pinned));
    pinned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kc-claude-policy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pinned(dir: &Path, forced: Option<PrefValue>) -> bool {
        org_pinned_in(&Sources {
            file: &dir.join("managed-settings.json"),
            drop_ins: &dir.join("managed-settings.d"),
            forced: &|key| (key == ORG_KEY).then(|| forced.clone()).flatten(),
            root_owned_only: false,
        })
    }

    const ORG: &str = "0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9";

    #[test]
    fn a_file_counts_only_when_root_owns_it_and_nobody_else_can_write_it() {
        assert!(root_owned(0, 0o100644));
        assert!(root_owned(0, 0o100600));
        assert!(!root_owned(501, 0o100644));
        assert!(!root_owned(0, 0o100664));
        assert!(!root_owned(0, 0o100646));

        let dir = scratch("owner");
        std::fs::write(
            dir.join("managed-settings.json"),
            format!(r#"{{"forceLoginOrgUUID":"{ORG}"}}"#),
        )
        .unwrap();
        let strict = org_pinned_in(&Sources {
            file: &dir.join("managed-settings.json"),
            drop_ins: &dir.join("managed-settings.d"),
            forced: &|_| None,
            root_owned_only: true,
        });
        assert!(!strict, "a file this test wrote is not root's");
        assert!(pinned(&dir, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_installed_reads_as_missing() {
        let dir = scratch("none");
        assert!(!pinned(&dir, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_managed_file_pins_with_a_string_or_a_list() {
        let dir = scratch("file");
        let file = dir.join("managed-settings.json");
        for (body, want) in [
            (format!(r#"{{"forceLoginOrgUUID":"{ORG}"}}"#), true),
            (format!(r#"{{"forceLoginOrgUUID":["{ORG}"]}}"#), true),
            (
                format!(
                    r#"{{"forceLoginMethod":"claudeai","forceLoginOrgUUID":["{ORG}","{ORG}"]}}"#
                ),
                true,
            ),
            (r#"{"forceLoginOrgUUID":""}"#.to_owned(), false),
            (r#"{"forceLoginOrgUUID":"  "}"#.to_owned(), false),
            (r#"{"forceLoginOrgUUID":[]}"#.to_owned(), false),
            (format!(r#"{{"forceLoginOrgUUID":["{ORG}",7]}}"#), false),
            (format!(r#"{{"forceLoginOrgUUID":["{ORG}",""]}}"#), false),
            (r#"{"forceLoginOrgUUID":true}"#.to_owned(), false),
            (r#"{"forceLoginMethod":"claudeai"}"#.to_owned(), false),
            (format!(r#"["forceLoginOrgUUID","{ORG}"]"#), false),
            (format!(r#"{{"forceLoginOrgUUID":"{ORG}""#), false),
            (String::new(), false),
        ] {
            std::fs::write(&file, &body).unwrap();
            assert_eq!(pinned(&dir, None), want, "{body}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_file_or_a_folder_in_its_place_reads_as_missing() {
        let dir = scratch("odd");
        let file = dir.join("managed-settings.json");
        let padding = " ".repeat(MAX_FILE_BYTES as usize);
        std::fs::write(
            &file,
            format!(r#"{{"forceLoginOrgUUID":"{ORG}"}}{padding}"#),
        )
        .unwrap();
        assert!(!pinned(&dir, None));
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir_all(&file).unwrap();
        assert!(!pinned(&dir, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_drop_in_pins_and_only_json_files_are_read() {
        let dir = scratch("drop-ins");
        let drop_ins = dir.join("managed-settings.d");
        std::fs::create_dir_all(&drop_ins).unwrap();
        std::fs::write(drop_ins.join("10-model.json"), r#"{"model":"opus"}"#).unwrap();
        std::fs::write(
            drop_ins.join("20-login.txt"),
            format!(r#"{{"forceLoginOrgUUID":"{ORG}"}}"#),
        )
        .unwrap();
        assert!(!pinned(&dir, None));
        std::fs::write(
            drop_ins.join("20-login.json"),
            format!(r#"{{"forceLoginOrgUUID":"{ORG}"}}"#),
        )
        .unwrap();
        assert!(pinned(&dir, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_forced_preference_pins_without_any_file() {
        let dir = scratch("pref");
        assert!(pinned(&dir, Some(PrefValue::String(ORG.into()))));
        assert!(pinned(
            &dir,
            Some(PrefValue::Array(vec![PrefValue::String(ORG.into())]))
        ));
        for odd in [
            PrefValue::String(String::new()),
            PrefValue::Array(Vec::new()),
            PrefValue::Array(vec![PrefValue::String(ORG.into()), PrefValue::Bool(true)]),
            PrefValue::Bool(true),
            PrefValue::Other("a number"),
        ] {
            assert!(!pinned(&dir, Some(odd.clone())), "{odd:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What this Mac's Claude Code policy says, as the gate reads it (docs/mdm.md, "Verifying").
    #[test]
    #[ignore = "reads this Mac's Claude Code managed settings; run by hand with --ignored --nocapture"]
    fn this_mac_pins() {
        println!("organisation pinned: {}", read_system());
    }
}
