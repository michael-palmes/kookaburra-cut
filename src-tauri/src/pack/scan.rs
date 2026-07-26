//! Scanning an item on disk into the shape a manifest records.
//!
//! Both sides of a conflict compare `content_hash`, so both sides MUST build it the same way: over paths relative to the
//! item's own root, never including the `payload/` prefix or the workspace path. Anything else makes every item look
//! changed the moment it moves machines, which is exactly the case the hash exists to rule out.

use super::error::PackError;
use super::hash::{content_hash, sha256_file};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub struct ScannedItem {
    pub bytes: u64,
    pub content_hash: String,
    pub modified_at: SystemTime,
}

/// Generated files that never travel and never count towards an item's identity.
///
/// Export and import MUST agree on this exactly. If they disagree, a project re-imported from its own pack hashes
/// differently on the two sides and reports as a conflict instead of identical, which is the one behaviour the whole
/// conflict model rests on.
pub fn is_excluded(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    if matches!(first, "exports" | ".git" | ".kookaburra") {
        return true;
    }
    // `.claude/settings.json` is user content (only written when missing); the rest of the folder is provisioned.
    if rel.starts_with(".claude/") && rel != ".claude/settings.json" {
        return true;
    }
    if rel.starts_with("assets/.emoji-cache/") {
        return true;
    }
    if rel == "edits/_tap_prefs.json" {
        return true;
    }
    // Bundled and legacy projects render to the project ROOT rather than `exports/` (`start_export` in lib.rs), and
    // source media always lives in `assets/` by the authoring rule, so a video at the root is always an output.
    if !rel.contains('/') {
        let ext = rel
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm") {
            return true;
        }
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == ".DS_Store" || (name.starts_with("._") && name.len() > 2)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), PackError> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if is_excluded(&rel) {
            continue;
        }
        let meta = entry.metadata()?;
        // Never follow a symlink out of the item.
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk(&entry.path(), &rel, out)?;
        } else if meta.is_file() {
            out.push((rel, entry.path()));
        }
    }
    Ok(())
}

/// Scan a directory-shaped item (project, theme, object).
pub fn scan_dir(root: &Path) -> Result<ScannedItem, PackError> {
    let mut found = Vec::new();
    walk(root, "", &mut found)?;
    found.sort_by(|a, b| a.0.cmp(&b.0));

    let mut files = Vec::with_capacity(found.len());
    let mut bytes = 0u64;
    let mut modified_at = SystemTime::UNIX_EPOCH;
    for (rel, path) in &found {
        let meta = std::fs::metadata(path)?;
        bytes += meta.len();
        if let Ok(m) = meta.modified() {
            if m > modified_at {
                modified_at = m;
            }
        }
        files.push((rel.clone(), sha256_file(path)?));
    }
    let hash = content_hash(&files);
    Ok(ScannedItem {
        bytes,
        content_hash: hash,
        modified_at,
    })
}

/// Scan a single-file item (gradient, export preset, font, screenshot). The relative path is the file name, so the same
/// file under a different folder still hashes equal.
pub fn scan_file(path: &Path) -> Result<ScannedItem, PackError> {
    let meta = std::fs::metadata(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let files = vec![(name, sha256_file(path)?)];
    let hash = content_hash(&files);
    Ok(ScannedItem {
        bytes: meta.len(),
        content_hash: hash,
        modified_at: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    })
}

/// RFC3339 UTC, seconds precision. No chrono in this crate, so the civil-date conversion is done here.
pub fn rfc3339(time: SystemTime) -> String {
    let secs = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's days-from-civil, inverted. Correct across leap years and century boundaries.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_known_epochs() {
        let at = |s: u64| rfc3339(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(s));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(1_000_000_000), "2001-09-09T01:46:40Z");
        // Leap day.
        assert_eq!(at(1_583_020_800), "2020-03-01T00:00:00Z");
        assert_eq!(at(1_582_934_400), "2020-02-29T00:00:00Z");
        // Year boundary.
        assert_eq!(at(1_609_459_199), "2020-12-31T23:59:59Z");
        assert_eq!(at(1_609_459_200), "2021-01-01T00:00:00Z");
    }

    #[test]
    fn exclusions_cover_the_generated_set() {
        assert!(is_excluded("exports/out.mp4"));
        assert!(is_excluded(".git/config"));
        assert!(is_excluded(".claude/skills/x/SKILL.md"));
        assert!(is_excluded("assets/.emoji-cache/a.png"));
        assert!(is_excluded("edits/_tap_prefs.json"));
        // Legacy export path: rendered outputs sit at the project root, not in exports/.
        assert!(is_excluded("launch-2026-16x9.mp4"));
        assert!(is_excluded("launch-2026-9x16.mov"));
        assert!(is_excluded("launch-2026-16x9-ctv.mp4"));
        assert!(!is_excluded("assets/sample-recording.mp4"));
        assert!(!is_excluded("assets/hero.mov"));
        assert!(is_excluded("assets/.DS_Store"));
        assert!(!is_excluded("assets/hero.mp4"));
        assert!(!is_excluded("CLAUDE.md"));
        assert!(!is_excluded(".claude/settings.json"));
        assert!(!is_excluded("edits/clip.json"));
        assert!(!is_excluded("scenes/01-hero.tsx"));
    }

    #[test]
    fn content_hash_ignores_location() {
        let base = std::env::temp_dir().join("kbpack-scan-test");
        let _ = std::fs::remove_dir_all(&base);
        for name in ["one", "two"] {
            let dir = base.join(name).join("scenes");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("01.tsx"), b"export default 1").unwrap();
            std::fs::write(base.join(name).join("project.json"), b"{}").unwrap();
        }
        let a = scan_dir(&base.join("one")).unwrap();
        let b = scan_dir(&base.join("two")).unwrap();
        assert_eq!(a.content_hash, b.content_hash);
        assert!(a.bytes > 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
