//! Archive-path validation. Structural, not a blocklist: anything not provably safe is refused.

use super::error::PackError;
use super::limits::{MAX_PATH_BYTES, MAX_PATH_DEPTH, PAYLOAD_PREFIX};
use super::model::ItemKind;
use std::path::PathBuf;

/// Per-subtree allowlist. Anything not listed refuses with the path named.
fn allowed_extensions(kind: ItemKind) -> &'static [&'static str] {
    match kind {
        ItemKind::Project => &[
            "tsx", "json", "md", "txt", "png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "m4v",
            "webm", "hdr", "exr", "mp3", "wav", "m4a", "aac", "flac", "ogg",
        ],
        ItemKind::Font => &["ttf", "otf"],
        ItemKind::Object => &["json", "glb", "png", "jpg", "jpeg", "webp"],
        ItemKind::Theme | ItemKind::Gradient | ItemKind::ExportPreset => &["json"],
        ItemKind::Screenshot => &["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "m4v", "webm"],
    }
}

fn kind_for_dir(dir: &str) -> Option<ItemKind> {
    ItemKind::APPLY_ORDER
        .iter()
        .copied()
        .find(|k| k.payload_dir() == dir)
}

/// Names macOS archivers add that carry no payload; ignored rather than refused.
pub fn is_ignorable(raw: &str) -> bool {
    let name = raw.rsplit('/').next().unwrap_or(raw);
    raw.starts_with("__MACOSX/")
        || name == ".DS_Store"
        || (name.starts_with("._") && name.len() > 2)
}

/// Validate a raw zip entry name and return a relative path that is safe to join onto the staging root.
pub fn validate_archive_path(raw: &str) -> Result<PathBuf, PackError> {
    let owned = raw.to_string();

    if raw.is_empty() {
        return Err(PackError::PathSuspicious(owned));
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(PackError::PathTooLong(owned));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err(PackError::PathNotUtf8(owned));
    }
    // Bidi overrides and zero-width joiners make one name render as another.
    if raw
        .chars()
        .any(|c| matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{FEFF}'))
    {
        return Err(PackError::PathSuspicious(owned));
    }
    if raw.contains('\\') {
        return Err(PackError::PathTraversal(owned));
    }
    if raw.starts_with('/') {
        return Err(PackError::PathAbsolute(owned));
    }
    // A Windows drive letter is absolute even without a leading slash.
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        return Err(PackError::PathAbsolute(owned));
    }
    if raw.ends_with('/') {
        return Err(PackError::NotARegularFile(owned));
    }
    if !raw.starts_with(PAYLOAD_PREFIX) {
        return Err(PackError::PathOutsidePayload(owned));
    }

    let mut out = PathBuf::new();
    let mut depth = 0usize;
    for component in raw.split('/') {
        if component.is_empty() || component == "." {
            return Err(PackError::PathTraversal(owned));
        }
        if component == ".." {
            return Err(PackError::PathTraversal(owned));
        }
        if component != component.trim() {
            return Err(PackError::PathSuspicious(owned));
        }
        depth += 1;
        if depth > MAX_PATH_DEPTH {
            return Err(PackError::PathTooDeep(owned));
        }
        out.push(component);
    }

    check_extension(raw)?;
    Ok(out)
}

/// `payload/<kind-dir>/…` must carry an extension the kind allows. `.claude/` is the only dotted directory accepted.
fn check_extension(raw: &str) -> Result<(), PackError> {
    let rest = &raw[PAYLOAD_PREFIX.len()..];
    let mut parts = rest.split('/');
    let Some(dir) = parts.next() else {
        return Err(PackError::PathOutsidePayload(raw.to_string()));
    };
    let Some(kind) = kind_for_dir(dir) else {
        return Err(PackError::PathOutsidePayload(raw.to_string()));
    };

    let tail: Vec<&str> = parts.collect();
    if tail.is_empty() {
        return Err(PackError::PathOutsidePayload(raw.to_string()));
    }
    for segment in &tail[..tail.len() - 1] {
        if segment.starts_with('.') && *segment != ".claude" {
            return Err(PackError::ExtensionNotAllowed(raw.to_string()));
        }
    }

    let name = tail[tail.len() - 1];
    // CLAUDE.md and .claude/settings.json are user content and carry allowed extensions already.
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext.is_empty() || !allowed_extensions(kind).contains(&ext.as_str()) {
        return Err(PackError::ExtensionNotAllowed(raw.to_string()));
    }
    Ok(())
}

/// Which store an already-validated payload path belongs to, and its slug.
pub fn classify(raw: &str) -> Option<(ItemKind, String)> {
    let rest = raw.strip_prefix(PAYLOAD_PREFIX)?;
    let (dir, tail) = rest.split_once('/')?;
    let kind = kind_for_dir(dir)?;
    let slug = match kind {
        // Flat stores key off the file name; the rest key off their folder.
        ItemKind::Gradient | ItemKind::ExportPreset => {
            tail.rsplit_once('.').map(|(s, _)| s).unwrap_or(tail).into()
        }
        ItemKind::Font | ItemKind::Screenshot => tail.into(),
        _ => tail.split('/').next()?.into(),
    };
    Some((kind, slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(raw: &str) -> &'static str {
        validate_archive_path(raw).unwrap_err().variant()
    }

    #[test]
    fn accepts_ordinary_payload_paths() {
        assert!(validate_archive_path("payload/projects/acme/scenes/01-hero.tsx").is_ok());
        assert!(validate_archive_path("payload/projects/acme/CLAUDE.md").is_ok());
        assert!(validate_archive_path("payload/projects/acme/.claude/settings.json").is_ok());
        assert!(validate_archive_path("payload/themes/acme-dark/theme.json").is_ok());
        assert!(validate_archive_path("payload/fonts/AcmeSans-Bold.ttf").is_ok());
        assert!(validate_archive_path("payload/objects/widget/model.glb").is_ok());
        assert!(validate_archive_path("payload/gradients/sunrise.json").is_ok());
        assert!(validate_archive_path("payload/screenshots/shot.png").is_ok());
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        assert_eq!(err("payload/../../../.zshrc"), "pathTraversal");
        assert_eq!(err("payload/projects/a/./../../b.tsx"), "pathTraversal");
        assert_eq!(err("/etc/passwd"), "pathAbsolute");
        assert_eq!(err("C:/Windows/system32"), "pathAbsolute");
        assert_eq!(err("payload\\projects\\a.tsx"), "pathTraversal");
        assert_eq!(err("payload//projects/a.tsx"), "pathTraversal");
    }

    #[test]
    fn rejects_outside_payload() {
        assert_eq!(err("manifest.json"), "pathOutsidePayload");
        assert_eq!(err("payload/secrets/x.json"), "pathOutsidePayload");
        assert_eq!(err("payload/projects"), "pathOutsidePayload");
    }

    #[test]
    fn rejects_shape_abuse() {
        let deep = format!("payload/projects/{}/x.tsx", vec!["a"; 20].join("/"));
        assert_eq!(err(&deep), "pathTooDeep");
        let long = format!("payload/projects/a/{}.tsx", "n".repeat(600));
        assert_eq!(err(&long), "pathTooLong");
        assert_eq!(err("payload/projects/a/b\u{202E}gnp.tsx"), "pathSuspicious");
        assert_eq!(err("payload/projects/a/x.tsx\u{0000}"), "pathNotUtf8");
        assert_eq!(err("payload/projects/a/ b.tsx"), "pathSuspicious");
        assert_eq!(err("payload/projects/acme/"), "notARegularFile");
        assert_eq!(err(""), "pathSuspicious");
    }

    #[test]
    fn rejects_disallowed_extensions() {
        assert_eq!(err("payload/projects/a/scenes/evil.sh"), "extensionNotAllowed");
        assert_eq!(err("payload/fonts/evil.dylib"), "extensionNotAllowed");
        assert_eq!(err("payload/projects/a/.git/config"), "extensionNotAllowed");
        assert_eq!(err("payload/themes/a/theme.tsx"), "extensionNotAllowed");
        assert_eq!(err("payload/projects/a/noext"), "extensionNotAllowed");
    }

    #[test]
    fn classifies_by_subtree() {
        assert_eq!(
            classify("payload/projects/acme/scenes/01.tsx"),
            Some((ItemKind::Project, "acme".into()))
        );
        assert_eq!(
            classify("payload/gradients/sunrise.json"),
            Some((ItemKind::Gradient, "sunrise".into()))
        );
        assert_eq!(
            classify("payload/fonts/AcmeSans-Bold.ttf"),
            Some((ItemKind::Font, "AcmeSans-Bold.ttf".into()))
        );
    }

    #[test]
    fn ignorables_are_recognised() {
        assert!(is_ignorable("__MACOSX/payload/x"));
        assert!(is_ignorable("payload/projects/a/.DS_Store"));
        assert!(is_ignorable("payload/projects/a/._hero.tsx"));
        assert!(!is_ignorable("payload/projects/a/hero.tsx"));
    }
}
