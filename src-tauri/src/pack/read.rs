//! Reading an untrusted `.kbpack`. Split so the cheap half runs before consent and the writing half runs only after it.
//!
//! The structural defence: extraction only ever writes into a staging directory this module created, symlinks are never
//! created at all, and every staged byte is hashed against the signed manifest before anything can move into the workspace.

use super::error::PackError;
use super::hash::{sha256_bytes, sha256_file};
use super::key;
use super::limits::*;
use super::model::{ItemKind, PackManifest, PACK_FORMAT, PACK_FORMAT_VERSION};
use super::paths::{is_agent_config, is_ignorable, validate_archive_path};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct PackInspection {
    pub manifest: PackManifest,
    pub manifest_bytes: Vec<u8>,
    pub signature: Option<Vec<u8>>,
    pub archive_bytes: u64,
    /// The scene code the pack would stage, built from `files` rather than read from `contents`.
    pub scene_sources: Vec<SceneSource>,
}

/// One `scenes/**/*.tsx` a project, template or preset carries. `file` is item-relative, as `project.json` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSource {
    pub kind: ItemKind,
    pub slug: String,
    pub name: String,
    pub file: String,
    /// The item's archive root, checked to be `payload/<kind dir>/<slug>`: the folder apply lands.
    #[serde(skip)]
    pub root: String,
}

impl SceneSource {
    pub fn archive_path(&self) -> String {
        format!("{}/{}", self.root, self.file)
    }

    /// The sidecar beside this source, which the pack may or may not carry.
    pub fn sidecar_path(&self) -> Option<String> {
        let (stem, _) = self.file.rsplit_once('.')?;
        Some(format!("{}/{stem}.json", self.root))
    }
}

/// Owns its staging tree: dropping it removes the tree, so a panic or an early return cannot leak an extracted pack.
pub struct StagedPack {
    pub root: PathBuf,
    pub manifest: PackManifest,
    /// Archive paths of agent configuration the pack carried and staging left out (`paths::is_agent_config`).
    pub dropped: Vec<String>,
}

impl Drop for StagedPack {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Stops inflation the moment a stream exceeds its budget, regardless of what the header claimed.
struct CountingReader<'a, R: Read> {
    inner: R,
    read: u64,
    cap: u64,
    path: &'a str,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if self.read > self.cap {
            return Err(std::io::Error::other(format!(
                "{} exceeded its size budget",
                self.path
            )));
        }
        Ok(n)
    }
}

fn open(archive: &Path) -> Result<(zip::ZipArchive<std::fs::File>, u64), PackError> {
    let file = std::fs::File::open(archive)?;
    let bytes = file.metadata()?.len();
    let zip = zip::ZipArchive::new(file)?;
    Ok((zip, bytes))
}

/// Central directory plus two small entries. Must stay fast on a 500 MB pack: nothing here inflates payload.
pub fn inspect(archive: &Path) -> Result<PackInspection, PackError> {
    let (mut zip, archive_bytes) = open(archive)?;

    if zip.len() > MAX_ENTRIES {
        return Err(PackError::TooManyEntries {
            found: zip.len(),
            max: MAX_ENTRIES,
        });
    }

    let mut declared_total: u64 = 0;
    let mut over_kind_cap: Option<PackError> = None;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i)?;
        declared_total = declared_total.saturating_add(entry.size());
        // A per-kind ceiling the header already breaks is refused before consent; staging re-checks the stream.
        if over_kind_cap.is_none() {
            if let Ok(name) = std::str::from_utf8(entry.name_raw()) {
                if name.starts_with(PAYLOAD_PREFIX) {
                    over_kind_cap = check_kind_cap(name, entry.size()).err();
                }
            }
        }
    }
    if declared_total > MAX_TOTAL_UNCOMPRESSED {
        return Err(PackError::TooLarge {
            bytes: declared_total,
            max: MAX_TOTAL_UNCOMPRESSED,
        });
    }
    if let Some(refusal) = over_kind_cap {
        return Err(refusal);
    }

    let manifest_bytes = {
        let mut entry = zip
            .by_name(MANIFEST_ENTRY)
            .map_err(|_| PackError::ManifestMissing)?;
        if entry.size() > MAX_MANIFEST_BYTES {
            return Err(PackError::ManifestTooLarge {
                bytes: entry.size(),
            });
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        let mut capped = CountingReader {
            inner: &mut entry,
            read: 0,
            cap: MAX_MANIFEST_BYTES,
            path: MANIFEST_ENTRY,
        };
        capped.read_to_end(&mut buf)?;
        buf
    };

    let signature = match zip.by_name(SIGNATURE_ENTRY) {
        Ok(mut entry) => {
            // A signature is 64 bytes; anything claiming more is not one, and the stream is bounded as well as the header.
            if entry.size() > MAX_SIGNATURE_BYTES {
                return Err(PackError::SignatureInvalid);
            }
            let mut buf = Vec::new();
            let mut capped = CountingReader {
                inner: &mut entry,
                read: 0,
                cap: MAX_SIGNATURE_BYTES,
                path: SIGNATURE_ENTRY,
            };
            capped
                .read_to_end(&mut buf)
                .map_err(|_| PackError::SignatureInvalid)?;
            // An empty entry is not a signature; treat it as absent rather than as an invalid one.
            if buf.is_empty() {
                None
            } else {
                Some(buf)
            }
        }
        Err(_) => None,
    };

    let manifest: PackManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| PackError::ManifestUnreadable(e.to_string()))?;

    if manifest.format != PACK_FORMAT {
        return Err(PackError::NotAPack(manifest.format.clone()));
    }
    if manifest.format_version > PACK_FORMAT_VERSION {
        return Err(PackError::FormatTooNew {
            found: manifest.format_version,
            supported: PACK_FORMAT_VERSION,
        });
    }
    // The id is a hash of the key beside it, so a declared id that differs is a lie, whatever the signature says.
    if key::key_id_of(&manifest.publisher.public_key).as_deref() != Some(&manifest.publisher.key_id) {
        return Err(PackError::KeyIdMismatch(manifest.publisher.key_id.clone()));
    }
    validate_contents_paths(&manifest)?;
    let scene_sources = staged_scene_sources(&manifest)?;

    Ok(PackInspection {
        manifest,
        manifest_bytes,
        signature,
        archive_bytes,
        scene_sources,
    })
}

fn is_scene_source(item_rel: &str) -> bool {
    item_rel.starts_with("scenes/")
        && item_rel
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("tsx"))
}

/// The scene code each project-shaped item would stage: every `scenes/**/*.tsx` under its root in `files`. The
/// manifest's `sceneFiles` must be exactly that set, so the code screen and the trust screen count what lands, never
/// what the author wrote down. The root must be the folder apply lands for that kind and slug, once per item, or the
/// screens would describe one folder while apply moved another. Items keep `sceneFiles` order, which is the film's order.
fn staged_scene_sources(manifest: &PackManifest) -> Result<Vec<SceneSource>, PackError> {
    let contents = &manifest.contents;
    let items = contents
        .projects
        .iter()
        .map(|p| (ItemKind::Project, p))
        .chain(contents.templates.iter().map(|p| (ItemKind::Template, p)))
        .chain(contents.presets.iter().map(|p| (ItemKind::Preset, p)));
    let mut sources = Vec::new();
    let mut roots: HashSet<String> = HashSet::new();
    for (kind, item) in items {
        let root = item.root.trim_end_matches('/');
        let expected = format!("{PAYLOAD_PREFIX}{}/{}", kind.payload_dir(), item.base.slug);
        if root != expected || !roots.insert(expected) {
            return Err(PackError::ItemRootMismatch(item.root.clone()));
        }
        let prefix = format!("{root}/");
        let staged: BTreeSet<&str> = manifest
            .files
            .iter()
            .filter_map(|f| f.path.strip_prefix(prefix.as_str()))
            .filter(|rel| is_scene_source(rel))
            .collect();
        let declared: BTreeSet<&str> = item.scene_files.iter().map(String::as_str).collect();
        if declared.len() != item.scene_files.len() || declared != staged {
            return Err(PackError::SceneFilesMismatch(item.root.clone()));
        }
        sources.extend(item.scene_files.iter().map(|file| SceneSource {
            kind,
            slug: item.base.slug.clone(),
            name: item.base.name.clone(),
            file: file.clone(),
            root: root.to_owned(),
        }));
    }
    Ok(sources)
}

/// Refuse an entry over the ceiling for its kind, naming the kind.
fn check_kind_cap(path: &str, bytes: u64) -> Result<(), PackError> {
    let (kind, max) = kind_cap(path);
    if bytes > max {
        return Err(PackError::KindTooLarge {
            path: path.to_string(),
            kind,
            bytes,
            max,
        });
    }
    Ok(())
}

/// `manifest.contents` carries paths too, and apply joins them onto the staging root to find what to move. `Path::join`
/// with an absolute path DISCARDS the base, so an unvalidated `file: "/etc/passwd"` would read clean outside the tree.
/// Every one of them is validated here and required to appear in `files`, the same as any zip entry.
fn validate_contents_paths(manifest: &PackManifest) -> Result<(), PackError> {
    let listed: HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    let check = |path: &str| -> Result<(), PackError> {
        validate_archive_path(path)?;
        if !listed.contains(path) {
            return Err(PackError::EntryNotInManifest(path.to_string()));
        }
        Ok(())
    };

    for font in &manifest.contents.fonts {
        if let Some(file) = &font.file {
            check(file)?;
        }
    }
    for object in &manifest.contents.objects {
        check(&object.glb)?;
        if let Some(thumb) = &object.thumbnail {
            check(thumb)?;
        }
    }
    for shot in &manifest.contents.screenshots {
        check(&shot.file)?;
    }
    // A project root is a directory, so it is checked as a prefix rather than as an entry. Templates and presets are
    // project folders and reach `apply` the same way, so they go through the same check.
    let contents = &manifest.contents;
    for project in contents
        .projects
        .iter()
        .chain(&contents.templates)
        .chain(&contents.presets)
    {
        let root = project.root.trim_end_matches('/');
        let probe = format!("{root}/project.json");
        validate_archive_path(&probe)?;
        if !manifest
            .files
            .iter()
            .any(|f| f.path.starts_with(&format!("{root}/")))
        {
            return Err(PackError::ManifestEntryMissing(project.root.clone()));
        }
        // Project-relative, exactly as `project.json` records them ("scenes/01-intro.tsx"), so they are validated as a
        // payload path rather than as a bare name.
        for scene in &project.scene_files {
            validate_archive_path(&format!("{root}/{scene}"))?;
        }
    }
    Ok(())
}

/// Semver-ish compare, tolerant of pre-release suffixes: only the numeric prefix decides.
pub fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split(['.', '-', '+'])
            .take(3)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..3 {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

/// Inflate one payload entry before staging, for the code and sidecar reviews. Refuses anything the manifest does not
/// list, and anything whose bytes differ from the signed hash: what is reviewed is what staging would verify.
pub fn read_verified_entry(
    archive: &Path,
    manifest: &PackManifest,
    archive_path: &str,
    cap: u64,
) -> Result<Vec<u8>, PackError> {
    let (mut zip, _) = open(archive)?;
    read_verified_from(&mut zip, manifest, archive_path, cap)
}

/// Several entries through one open archive, each verified as `read_verified_entry` does.
pub fn read_verified_entries(
    archive: &Path,
    manifest: &PackManifest,
    archive_paths: &[String],
    cap: u64,
) -> Result<Vec<Vec<u8>>, PackError> {
    let (mut zip, _) = open(archive)?;
    archive_paths
        .iter()
        .map(|path| read_verified_from(&mut zip, manifest, path, cap))
        .collect()
}

fn read_verified_from(
    zip: &mut zip::ZipArchive<std::fs::File>,
    manifest: &PackManifest,
    archive_path: &str,
    cap: u64,
) -> Result<Vec<u8>, PackError> {
    let Some(declared) = manifest.files.iter().find(|f| f.path == archive_path) else {
        return Err(PackError::EntryNotInManifest(archive_path.to_string()));
    };
    validate_archive_path(archive_path)?;
    let mut entry = zip
        .by_name(archive_path)
        .map_err(|_| PackError::ManifestEntryMissing(archive_path.to_string()))?;
    if entry.size() > cap {
        return Err(PackError::EntryTooLarge {
            path: archive_path.to_string(),
            bytes: entry.size(),
            max: cap,
        });
    }
    let mut buf = Vec::new();
    let mut capped = CountingReader {
        inner: &mut entry,
        read: 0,
        cap,
        path: archive_path,
    };
    capped.read_to_end(&mut buf)?;
    if sha256_bytes(&buf) != declared.sha256 {
        return Err(PackError::HashMismatch(archive_path.to_string()));
    }
    Ok(buf)
}

/// One scene source as text, for the code-disclosure viewer.
pub fn read_entry(
    archive: &Path,
    manifest: &PackManifest,
    archive_path: &str,
    cap: u64,
) -> Result<String, PackError> {
    let buf = read_verified_entry(archive, manifest, archive_path, cap)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn staging_root(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(crate::workspace::STATE_DIR_NAME)
        .join(STAGING_DIR)
}

/// A name no caller supplies, so a staging dir can never be aimed.
fn unique_name(seed: &[u8]) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    super::hash::sha256_bytes(&[seed, &nanos.to_le_bytes()].concat())[..24].to_string()
}

/// Full extraction into a fresh staging directory, hash-verified against the manifest. Never writes into the workspace tree.
pub fn stage(
    archive: &Path,
    workspace_root: &Path,
    manifest: &PackManifest,
    mut on_progress: impl FnMut(u64, u64),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<StagedPack, PackError> {
    let root =
        staging_root(workspace_root).join(unique_name(archive.as_os_str().as_encoded_bytes()));
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir(&root)?;

    let mut staged = StagedPack {
        root: root.clone(),
        manifest: manifest.clone(),
        dropped: Vec::new(),
    };

    let expected: HashMap<&str, &super::model::PackFile> = manifest
        .files
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect();
    let total_bytes: u64 = manifest
        .files
        .iter()
        .filter(|f| !is_agent_config(&f.path))
        .map(|f| f.bytes)
        .sum();
    let mut seen: HashSet<String> = HashSet::new();
    let mut written: u64 = 0;

    let (mut zip, _) = open(archive)?;
    for i in 0..zip.len() {
        if is_cancelled() {
            return Err(PackError::Cancelled);
        }
        let mut entry = zip.by_index(i)?;
        // Our writer only emits UTF-8 names, so never accept zip's CP437 fallback.
        let raw = String::from_utf8(entry.name_raw().to_vec()).map_err(|e| {
            PackError::PathNotUtf8(String::from_utf8_lossy(e.as_bytes()).into_owned())
        })?;

        if raw == MANIFEST_ENTRY || raw == SIGNATURE_ENTRY || is_ignorable(&raw) {
            continue;
        }
        if entry.is_dir() {
            continue;
        }
        // Agent configuration is never written: the app stamps its own. Listed in `files` or not, it is dropped and named.
        if is_agent_config(&raw) {
            seen.insert(raw.clone());
            staged.dropped.push(raw);
            continue;
        }
        // A symlink earlier in the archive is how CVE-2025-29787 escapes: refuse them outright, and never create one.
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(PackError::SymlinkRejected(raw));
            }
            if mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 {
                return Err(PackError::NotARegularFile(raw));
            }
        }

        let relative = validate_archive_path(&raw)?;
        let Some(declared) = expected.get(raw.as_str()) else {
            return Err(PackError::EntryNotInManifest(raw));
        };

        if entry.size() > MAX_SINGLE_UNCOMPRESSED {
            return Err(PackError::EntryTooLarge {
                path: raw,
                bytes: entry.size(),
                max: MAX_SINGLE_UNCOMPRESSED,
            });
        }
        check_kind_cap(&raw, entry.size().max(declared.bytes))?;
        let compressed = entry.compressed_size().max(1);
        let ratio = entry.size() / compressed;
        if ratio > MAX_RATIO_PER_ENTRY {
            return Err(PackError::RatioExceeded {
                path: raw,
                ratio,
                max: MAX_RATIO_PER_ENTRY,
            });
        }

        let destination = root.join(&relative);
        // Re-check after joining: the validator is not the only defence.
        if !destination.starts_with(&root) {
            return Err(PackError::PathTraversal(raw));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
            set_dir_mode(parent);
        }

        let remaining = MAX_TOTAL_UNCOMPRESSED.saturating_sub(written);
        let mut capped = CountingReader {
            inner: &mut entry,
            read: 0,
            cap: declared.bytes.min(remaining).min(kind_cap(&raw).1),
            path: &raw,
        };
        let mut out = std::fs::File::create(&destination)?;
        std::io::copy(&mut capped, &mut out)?;
        drop(out);
        set_file_mode(&destination);

        written = written.saturating_add(capped.read);
        if written > MAX_TOTAL_UNCOMPRESSED {
            return Err(PackError::TooLarge {
                bytes: written,
                max: MAX_TOTAL_UNCOMPRESSED,
            });
        }
        seen.insert(raw);
        on_progress(written, total_bytes);
    }

    for file in &manifest.files {
        if !seen.contains(&file.path) {
            return Err(PackError::ManifestEntryMissing(file.path.clone()));
        }
    }

    // Nothing moves into the workspace until every staged byte matches what was signed.
    for file in &manifest.files {
        if is_cancelled() {
            return Err(PackError::Cancelled);
        }
        if staged.dropped.contains(&file.path) {
            continue;
        }
        // `validate_archive_path` keeps the `payload/` segment, so staged paths mirror the archive exactly.
        let actual = sha256_file(&root.join(&file.path))?;
        if actual != file.sha256 {
            return Err(PackError::HashMismatch(file.path.clone()));
        }
    }

    Ok(staged)
}

#[cfg(unix)]
fn set_file_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644));
}

#[cfg(unix)]
fn set_dir_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path) {}
#[cfg(not(unix))]
fn set_dir_mode(_path: &Path) {}

/// Remove staging and backup trees left by a crashed or killed run. Called once at app start.
pub fn sweep_stale(workspace_root: &Path) {
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(STALE_STAGING_SECS);
    for dir in [STAGING_DIR, BACKUP_DIR] {
        let base = workspace_root
            .join(crate::workspace::STATE_DIR_NAME)
            .join(dir);
        let Ok(entries) = std::fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|m| m < cutoff)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_caps_follow_the_extension() {
        assert_eq!(kind_cap("payload/fonts/Acme.ttf"), ("font", MAX_FONT_BYTES));
        assert_eq!(kind_cap("payload/objects/w/model.GLB"), ("3D model", MAX_MODEL_BYTES));
        assert_eq!(kind_cap("payload/projects/a/assets/sky.exr").1, MAX_IMAGE_BYTES);
        assert_eq!(kind_cap("payload/projects/a/assets/take.mov").1, MAX_VIDEO_BYTES);
        assert_eq!(kind_cap("payload/projects/a/assets/bed.wav").1, MAX_AUDIO_BYTES);
        assert_eq!(kind_cap("payload/projects/a/scenes/01.tsx").1, MAX_TEXT_BYTES);
        assert_eq!(kind_cap("payload/projects/a/noext").1, MAX_SINGLE_UNCOMPRESSED);
        assert!(check_kind_cap("payload/fonts/Acme.ttf", MAX_FONT_BYTES).is_ok());
        assert_eq!(
            check_kind_cap("payload/fonts/Acme.ttf", MAX_FONT_BYTES + 1)
                .unwrap_err()
                .variant(),
            "kindTooLarge"
        );
    }

    #[test]
    fn version_compare_handles_prerelease() {
        assert!(version_lt("0.6.0", "0.7.0"));
        assert!(version_lt("0.6.9", "0.7.0"));
        assert!(!version_lt("0.7.0", "0.7.0"));
        assert!(!version_lt("1.0.0", "0.7.0"));
        assert!(!version_lt("0.7.0-beta.1", "0.7.0"));
    }
}
