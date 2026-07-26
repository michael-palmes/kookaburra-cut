//! Container tests: the write/inspect/stage round trip, and one refusal per extraction-checklist item.
//!
//! Hostile packs are built at test time rather than committed, because a committed malicious zip upsets scanners.

use super::error::PackError;
use super::hash::{sha256_bytes, sha256_file};
use super::limits::{
    MANIFEST_ENTRY, MAX_ENTRIES, MAX_MANIFEST_BYTES, MAX_PATH_BYTES, SIGNATURE_ENTRY, STAGING_DIR,
};
use super::model::{
    FontEmbedding, PackContents, PackFile, PackFont, PackItemBase, PackManifest, PackMeta,
    PackObject, PackProject, PackPublisher, PackScreenshot, PackSimpleItem, PackTheme, PackTotals,
    PACK_FORMAT, PACK_FORMAT_VERSION,
};
use super::read::{inspect, stage, sweep_stale};
use super::write::{write_pack, PackEntry};
use crate::workspace::STATE_DIR_NAME;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PUBLISHER_SEED: [u8; 32] = [7u8; 32];
const IMPOSTER_SEED: [u8; 32] = [9u8; 32];

// Temp scaffolding.

/// Self-deleting temp directory: `tempfile` is not a dependency and this batch is not the place to add one.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "kbpack-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn write_file(path: &Path, data: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(path, data).expect("write");
}

/// Files and symlinks under `root`, relative path plus content hash. Empty directories are deliberately ignored:
/// `stage` leaves the `import-staging` parent behind by design, and only leaked *content* is a failure.
fn snapshot(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let Ok(entry) = entry else { continue };
        let relative = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .into_owned();
        if entry.file_type().is_symlink() {
            out.push((relative, "<symlink>".to_string()));
        } else if entry.file_type().is_file() {
            out.push((relative, sha256_file(entry.path()).expect("hash")));
        }
    }
    out.sort();
    out
}

/// A workspace root with a few files in it, so "nothing changed" is an assertion with something to lose.
struct Workspace {
    dir: TempDir,
}

impl Workspace {
    fn new(tag: &str) -> Self {
        let dir = TempDir::new(&format!("ws-{tag}"));
        write_file(&dir.path().join("projects/keep/project.json"), b"{\"id\":\"keep\"}");
        write_file(&dir.path().join("themes/keep/theme.json"), b"{\"id\":\"keep\"}");
        write_file(&dir.path().join("fonts/fonts.json"), b"[]");
        Self { dir }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn snapshot(&self) -> Vec<(String, String)> {
        snapshot(self.root())
    }

    fn staging_is_empty(&self) -> bool {
        let base = self.root().join(STATE_DIR_NAME).join(STAGING_DIR);
        match std::fs::read_dir(&base) {
            Ok(mut entries) => entries.next().is_none(),
            Err(_) => true,
        }
    }
}

// Signing.
// `pack::key` and `pack::publisher` are being written alongside this file, so signing is inline here and
// depends on nothing but ed25519-dalek.

fn signing_key(seed: [u8; 32]) -> SigningKey {
    SigningKey::from_bytes(&seed)
}

fn publisher(seed: [u8; 32]) -> PackPublisher {
    let raw = signing_key(seed).verifying_key().to_bytes();
    PackPublisher {
        name: "Test Publisher".into(),
        organisation: None,
        website: None,
        device: "Test Mac".into(),
        public_key: format!(
            "ed25519:{}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        ),
        key_id: sha256_bytes(&raw)[..16].to_string(),
    }
}

fn verify_signature(manifest: &PackManifest, manifest_bytes: &[u8], signature: &[u8]) -> bool {
    let Some(encoded) = manifest.publisher.public_key.strip_prefix("ed25519:") else {
        return false;
    };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    let Ok(raw): Result<[u8; 32], _> = raw.try_into() else {
        return false;
    };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&raw) else {
        return false;
    };
    let Ok(signature): Result<[u8; 64], _> = signature.try_into() else {
        return false;
    };
    key.verify(manifest_bytes, &Signature::from_bytes(&signature))
        .is_ok()
}

// Fixture builder.

#[derive(Clone, Copy, PartialEq, Eq)]
enum SigMode {
    Valid,
    Forged,
    Absent,
}

struct Entry {
    name: String,
    data: Vec<u8>,
    /// What the manifest describes, when that is deliberately not what the zip carries.
    signed_as: Option<Vec<u8>>,
    mode: Option<u32>,
    symlink_target: Option<String>,
    listed: bool,
    stored: bool,
}

impl Entry {
    fn new(name: &str, data: &[u8]) -> Self {
        Self {
            name: name.to_string(),
            data: data.to_vec(),
            signed_as: None,
            mode: None,
            symlink_target: None,
            listed: true,
            stored: false,
        }
    }

    fn symlink(name: &str, target: &Path) -> Self {
        let mut entry = Self::new(name, target.to_string_lossy().as_bytes());
        entry.symlink_target = Some(target.to_string_lossy().into_owned());
        entry
    }

    /// In the zip, absent from `manifest.files`.
    fn unlisted(mut self) -> Self {
        self.listed = false;
        self
    }

    fn mode(mut self, mode: u32) -> Self {
        self.mode = Some(mode);
        self
    }

    fn stored(mut self) -> Self {
        self.stored = true;
        self
    }

    /// The manifest hashes `signed`, the zip carries `self.data`.
    fn tampered(mut self, signed: &[u8]) -> Self {
        self.signed_as = Some(signed.to_vec());
        self
    }

    fn described_bytes(&self) -> &[u8] {
        self.signed_as.as_deref().unwrap_or(&self.data)
    }
}

struct Fixture {
    entries: Vec<Entry>,
    /// Manifest paths with no zip entry behind them.
    ghosts: Vec<String>,
    format_version: u32,
    min_app_version: String,
    description: Option<String>,
    signature: SigMode,
    contents: PackContents,
    /// Rewrites every payload entry's declared uncompressed size in the central directory.
    declared_size_override: Option<u32>,
}

impl Fixture {
    /// A pack that is refused for exactly the reason the caller adds, and nothing else.
    fn valid() -> Self {
        Self {
            entries: vec![Entry::new(
                "payload/projects/acme/project.json",
                b"{\"id\":\"acme\"}",
            )],
            ghosts: Vec::new(),
            format_version: PACK_FORMAT_VERSION,
            min_app_version: "0.1.0".into(),
            description: None,
            signature: SigMode::Valid,
            contents: PackContents::default(),
            declared_size_override: None,
        }
    }

    fn entry(mut self, entry: Entry) -> Self {
        self.entries.push(entry);
        self
    }

    fn ghost(mut self, path: &str) -> Self {
        self.ghosts.push(path.to_string());
        self
    }

    fn format_version(mut self, version: u32) -> Self {
        self.format_version = version;
        self
    }

    fn min_app_version(mut self, version: &str) -> Self {
        self.min_app_version = version.to_string();
        self
    }

    fn description(mut self, description: String) -> Self {
        self.description = Some(description);
        self
    }

    fn signature(mut self, mode: SigMode) -> Self {
        self.signature = mode;
        self
    }

    fn declared_sizes(mut self, bytes: u32) -> Self {
        self.declared_size_override = Some(bytes);
        self
    }

    fn contents(mut self, contents: PackContents) -> Self {
        self.contents = contents;
        self
    }

    fn manifest(&self) -> PackManifest {
        let mut files: Vec<PackFile> = self
            .entries
            .iter()
            .filter(|e| e.listed)
            .map(|e| PackFile {
                path: e.name.clone(),
                sha256: sha256_bytes(e.described_bytes()),
                bytes: e.described_bytes().len() as u64,
            })
            .collect();
        for ghost in &self.ghosts {
            files.push(PackFile {
                path: ghost.clone(),
                sha256: sha256_bytes(b"ghost"),
                bytes: 5,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let totals = PackTotals {
            files: files.len(),
            bytes: files.iter().map(|f| f.bytes).sum(),
        };
        PackManifest {
            format: PACK_FORMAT.into(),
            format_version: self.format_version,
            app_version: APP_VERSION.into(),
            min_app_version: self.min_app_version.clone(),
            pack: PackMeta {
                name: "Test Pack".into(),
                description: self.description.clone(),
                created_at: "2026-07-26T00:00:00Z".into(),
            },
            publisher: publisher(PUBLISHER_SEED),
            contents: self.contents.clone(),
            files,
            totals,
        }
    }

    fn build(&self, dir: &Path) -> PathBuf {
        let manifest_bytes = serde_json::to_vec(&self.manifest()).expect("manifest");
        let mut buffer = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            zip.start_file(MANIFEST_ENTRY, deflated()).unwrap();
            zip.write_all(&manifest_bytes).unwrap();

            if self.signature != SigMode::Absent {
                let seed = if self.signature == SigMode::Forged {
                    IMPOSTER_SEED
                } else {
                    PUBLISHER_SEED
                };
                let signature = signing_key(seed).sign(&manifest_bytes).to_bytes();
                zip.start_file(SIGNATURE_ENTRY, stored()).unwrap();
                zip.write_all(&signature).unwrap();
            }

            for entry in &self.entries {
                if let Some(target) = &entry.symlink_target {
                    zip.add_symlink(&entry.name, target, stored()).unwrap();
                    continue;
                }
                let mut options = if entry.stored { stored() } else { deflated() };
                if let Some(mode) = entry.mode {
                    options = options.unix_permissions(mode);
                }
                zip.start_file(&entry.name, options).unwrap();
                zip.write_all(&entry.data).unwrap();
            }
            zip.finish().unwrap();
        }

        if let Some(bytes) = self.declared_size_override {
            overwrite_declared_sizes(&mut buffer, bytes);
        }

        let path = dir.join("fixture.kbpack");
        write_file(&path, &buffer);
        path
    }
}

fn stored() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644)
        .last_modified_time(zip::DateTime::default())
}

fn deflated() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
        .last_modified_time(zip::DateTime::default())
}

/// Make every `payload/` entry claim `bytes` uncompressed, so the pre-inflation total guard has something to catch.
/// The central directory is what `inspect` reads, so only it needs rewriting.
fn overwrite_declared_sizes(buffer: &mut [u8], bytes: u32) {
    let eocd = buffer
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .expect("end of central directory");
    let offset = u32::from_le_bytes(buffer[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(buffer[eocd + 10..eocd + 12].try_into().unwrap()) as usize;

    let mut at = offset;
    for _ in 0..count {
        assert_eq!(&buffer[at..at + 4], b"PK\x01\x02", "central directory header");
        let name_len = u16::from_le_bytes(buffer[at + 28..at + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(buffer[at + 30..at + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(buffer[at + 32..at + 34].try_into().unwrap()) as usize;
        let name = String::from_utf8_lossy(&buffer[at + 46..at + 46 + name_len]).into_owned();
        if name.starts_with("payload/") {
            buffer[at + 24..at + 28].copy_from_slice(&bytes.to_le_bytes());
        }
        at += 46 + name_len + extra_len + comment_len;
    }
}

// The import seam under test.

/// What an importer does before it is allowed to touch the workspace: inspect, then stage and hash-verify.
fn import(archive: &Path, workspace: &Path, app_version: &str) -> Result<(), PackError> {
    let inspection = inspect(archive, app_version)?;
    let staged = stage(
        archive,
        workspace,
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )?;
    drop(staged);
    Ok(())
}

fn assert_refused(tag: &str, fixture: Fixture, expected: &str) {
    let source = TempDir::new(tag);
    let workspace = Workspace::new(tag);
    let archive = fixture.build(source.path());

    let before = workspace.snapshot();
    let error = import(&archive, workspace.root(), APP_VERSION)
        .expect_err(&format!("{tag} should have been refused"));

    assert_eq!(
        error.variant(),
        expected,
        "{tag}: wrong refusal ({})",
        error.user_message()
    );
    assert_eq!(workspace.snapshot(), before, "{tag} changed the workspace");
    assert!(
        workspace.staging_is_empty(),
        "{tag} leaked a staging directory"
    );
}

// Happy path.

/// One file per payload subtree, so the round trip covers every kind a pack can carry.
const SOURCE_TREE: &[(&str, &[u8])] = &[
    ("projects/acme/project.json", b"{\"id\":\"acme\",\"version\":9}"),
    ("projects/acme/scenes/01-hero.tsx", b"export default defineScene({});\n"),
    ("projects/acme/scenes/01-hero.json", b"{\"text\":{\"title\":\"Hi\"}}"),
    ("projects/acme/assets/logo.png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
    ("projects/acme/CLAUDE.md", b"# Acme\n"),
    ("projects/acme/.claude/settings.json", b"{\"permissions\":{}}"),
    ("themes/acme-dark/theme.json", b"{\"id\":\"acme-dark\",\"version\":9}"),
    ("fonts/AcmeSans-Bold.ttf", b"\x00\x01\x00\x00 not really a font"),
    ("objects/widget/object.json", b"{\"slug\":\"widget\"}"),
    ("objects/widget/model.glb", b"glTF\x02\x00\x00\x00"),
    ("gradients/sunrise.json", b"{\"slug\":\"sunrise\"}"),
    ("export-presets/tiktok.json", b"{\"slug\":\"tiktok\"}"),
    ("screenshots/shot.png", b"\x89PNG shot"),
];

fn build_source_tree(root: &Path) {
    for (relative, data) in SOURCE_TREE {
        write_file(&root.join(relative), data);
    }
}

/// A manifest with every entity kind populated, so `serde(flatten)` and the optional fields are all exercised.
fn full_manifest(source: &Path) -> PackManifest {
    let files: Vec<PackFile> = SOURCE_TREE
        .iter()
        .map(|(relative, _)| PackFile {
            path: format!("payload/{relative}"),
            sha256: sha256_file(&source.join(relative)).expect("hash"),
            bytes: std::fs::metadata(source.join(relative)).expect("meta").len(),
        })
        .collect();
    let totals = PackTotals {
        files: files.len(),
        bytes: files.iter().map(|f| f.bytes).sum(),
    };

    let base = |slug: &str| PackItemBase {
        slug: slug.into(),
        name: slug.into(),
        bytes: 128,
        modified_at: "2026-07-26T00:00:00Z".into(),
        content_hash: sha256_bytes(slug.as_bytes()),
    };

    PackManifest {
        format: PACK_FORMAT.into(),
        format_version: PACK_FORMAT_VERSION,
        app_version: APP_VERSION.into(),
        min_app_version: "0.1.0".into(),
        pack: PackMeta {
            name: "Acme Brand Kit".into(),
            description: Some("Round-trip fixture".into()),
            created_at: "2026-07-26T00:00:00Z".into(),
        },
        publisher: PackPublisher {
            organisation: Some("Acme".into()),
            website: Some("https://example.com".into()),
            ..publisher(PUBLISHER_SEED)
        },
        contents: PackContents {
            projects: vec![PackProject {
                base: base("acme"),
                root: "payload/projects/acme".into(),
                manifest_version: 9,
                scene_count: 1,
                scene_files: vec!["01-hero.tsx".into()],
                duration_ms: 4000,
                formats: vec!["16:9".into()],
                theme_id: "ws:acme-dark".into(),
                requires: Default::default(),
                has_scene_code: true,
            }],
            themes: vec![PackTheme {
                base: base("acme-dark"),
                mode: "dark".into(),
                doc_version: 9,
                swatches: vec!["#101014".into()],
                requires: Default::default(),
            }],
            fonts: vec![PackFont {
                base: base("AcmeSans-Bold"),
                family: "Acme Sans".into(),
                weight: 700,
                postscript: "AcmeSans-Bold".into(),
                file: Some("payload/fonts/AcmeSans-Bold.ttf".into()),
                sha256: Some(sha256_bytes(b"\x00\x01\x00\x00 not really a font")),
                instanced: None,
                embedding: FontEmbedding::Installable,
                reference_only: None,
            }],
            objects: vec![PackObject {
                base: base("widget"),
                glb: "payload/objects/widget/model.glb".into(),
                thumbnail: None,
                licence: Some("CC0".into()),
                tags: vec!["prop".into()],
            }],
            gradients: vec![PackSimpleItem {
                base: base("sunrise"),
            }],
            export_presets: vec![PackSimpleItem {
                base: base("tiktok"),
            }],
            screenshots: vec![PackScreenshot {
                base: base("shot.png"),
                file: "payload/screenshots/shot.png".into(),
                width: Some(1170),
                height: Some(2532),
            }],
        },
        files,
        totals,
    }
}

fn write_valid_pack(source: &Path, out: &Path) -> (PackManifest, Vec<u8>) {
    build_source_tree(source);
    let manifest = full_manifest(source);
    let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest");
    let signature = signing_key(PUBLISHER_SEED).sign(&manifest_bytes).to_bytes();
    let entries: Vec<PackEntry> = SOURCE_TREE
        .iter()
        .map(|(relative, _)| PackEntry {
            archive_path: format!("payload/{relative}"),
            source: source.join(relative),
        })
        .collect();
    write_pack(
        out,
        &manifest_bytes,
        &signature,
        &entries,
        |_, _| {},
        &|| false,
    )
    .expect("write_pack");
    (manifest, manifest_bytes)
}

#[test]
fn round_trip_write_inspect_stage() {
    let source = TempDir::new("rt-src");
    let out = TempDir::new("rt-out");
    let workspace = Workspace::new("rt");
    let archive = out.path().join("acme.kbpack");
    let (_, manifest_bytes) = write_valid_pack(source.path(), &archive);

    let inspection = inspect(&archive, APP_VERSION).expect("inspect");
    assert_eq!(inspection.manifest_bytes, manifest_bytes);
    assert_eq!(inspection.manifest.files.len(), SOURCE_TREE.len());
    assert_eq!(
        inspection.archive_bytes,
        std::fs::metadata(&archive).unwrap().len()
    );
    let signature = inspection.signature.clone().expect("signature entry");
    assert!(verify_signature(
        &inspection.manifest,
        &inspection.manifest_bytes,
        &signature
    ));

    let mut progress: Vec<(u64, u64)> = Vec::new();
    let staged = stage(
        &archive,
        workspace.root(),
        &inspection.manifest,
        |written, total| progress.push((written, total)),
        &|| false,
    )
    .expect("stage");

    assert!(staged.root.starts_with(workspace.root().join(STATE_DIR_NAME).join(STAGING_DIR)));
    assert_eq!(progress.len(), SOURCE_TREE.len());
    assert_eq!(
        progress.last().copied(),
        Some((inspection.manifest.totals.bytes, inspection.manifest.totals.bytes))
    );

    // Byte-identical, and nothing the manifest did not list.
    for (relative, _) in SOURCE_TREE {
        let original = std::fs::read(source.path().join(relative)).expect("source");
        let extracted = std::fs::read(staged.root.join("payload").join(relative)).expect("staged");
        assert_eq!(extracted, original, "{relative} differs");
    }
    for file in &inspection.manifest.files {
        assert_eq!(
            sha256_file(&staged.root.join(&file.path)).expect("hash"),
            file.sha256,
            "{} hash",
            file.path
        );
    }
    assert_eq!(snapshot(&staged.root).len(), SOURCE_TREE.len());

    // The workspace itself is untouched: staging is the only thing `stage` may write.
    let mut outside = workspace.snapshot();
    outside.retain(|(path, _)| !path.starts_with(STATE_DIR_NAME));
    assert_eq!(outside, Workspace::new("rt-reference").snapshot());
}

#[test]
fn manifest_bytes_survive_a_serde_round_trip() {
    let source = TempDir::new("mrt-src");
    build_source_tree(source.path());
    let original = serde_json::to_vec(&full_manifest(source.path())).expect("manifest");

    let parsed: PackManifest = serde_json::from_slice(&original).expect("parse");
    let reserialised = serde_json::to_vec(&parsed).expect("reserialise");

    assert_eq!(
        String::from_utf8_lossy(&reserialised),
        String::from_utf8_lossy(&original),
        "re-serialising a parsed manifest must be byte-identical or signatures become fragile"
    );
}

#[test]
fn staged_pack_drop_removes_the_tree() {
    let source = TempDir::new("drop-src");
    let out = TempDir::new("drop-out");
    let workspace = Workspace::new("drop");
    let archive = out.path().join("acme.kbpack");
    let (manifest, _) = write_valid_pack(source.path(), &archive);

    let staged = stage(&archive, workspace.root(), &manifest, |_, _| {}, &|| false).expect("stage");
    let root = staged.root.clone();
    assert!(root.is_dir());
    drop(staged);
    assert!(!root.exists(), "Drop must remove the staging tree");
    assert!(workspace.staging_is_empty());

    // `into_kept_root` is the one escape hatch, for an apply that succeeded.
    let staged = stage(&archive, workspace.root(), &manifest, |_, _| {}, &|| false).expect("stage");
    let kept = staged.into_kept_root();
    assert!(kept.is_dir(), "into_kept_root must not delete the tree");
    let _ = std::fs::remove_dir_all(&kept);
}

#[test]
fn stage_removes_its_tree_when_hashing_fails() {
    let tag = "drop-on-error";
    let source = TempDir::new(tag);
    let workspace = Workspace::new(tag);
    let archive = Fixture::valid()
        .entry(
            Entry::new("payload/projects/acme/scenes/01.tsx", b"actual bytes")
                .tampered(b"signed bytes"),
        )
        .build(source.path());

    assert!(import(&archive, workspace.root(), APP_VERSION).is_err());
    assert!(
        workspace.staging_is_empty(),
        "a failed stage must not leave its tree behind"
    );
}

#[cfg(unix)]
fn set_mtime_secs_ago(path: &Path, secs: i64) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64;
    let stamp = libc::timeval {
        tv_sec: now - secs,
        tv_usec: 0,
    };
    let times = [stamp, stamp];
    let raw = CString::new(path.as_os_str().as_bytes()).expect("path");
    assert_eq!(unsafe { libc::utimes(raw.as_ptr(), times.as_ptr()) }, 0);
}

#[cfg(unix)]
#[test]
fn sweep_stale_removes_aged_staging_only() {
    let workspace = Workspace::new("sweep");
    let base = workspace.root().join(STATE_DIR_NAME).join(STAGING_DIR);
    let aged = base.join("aged");
    let fresh = base.join("fresh");
    write_file(&aged.join("payload/x.json"), b"{}");
    write_file(&fresh.join("payload/x.json"), b"{}");
    set_mtime_secs_ago(&aged, 48 * 60 * 60);

    sweep_stale(workspace.root());

    assert!(!aged.exists(), "a day-old staging dir must be swept");
    assert!(fresh.is_dir(), "a fresh staging dir must survive");
}

// Hostile fixtures, one per extraction-checklist item.

#[test]
fn refuses_traversal() {
    assert_refused(
        "traversal",
        Fixture::valid().entry(Entry::new("payload/../../../.zshrc", b"pwned")),
        "pathTraversal",
    );
}

#[test]
fn refuses_absolute_paths() {
    assert_refused(
        "absolute",
        Fixture::valid().entry(Entry::new("/etc/hosts", b"127.0.0.1 evil")),
        "pathAbsolute",
    );
}

/// CVE-2025-29787: entry A is a symlink out of the tree, entry B writes through it.
#[test]
fn refuses_symlink_escape() {
    let tag = "symlink";
    let source = TempDir::new(tag);
    let target = TempDir::new("symlink-target");
    let workspace = Workspace::new(tag);

    let archive = Fixture::valid()
        .entry(Entry::symlink("payload/projects/acme/assets.json", target.path()))
        .entry(Entry::new(
            "payload/projects/acme/assets.json/evil.tsx",
            b"pwned",
        ))
        .build(source.path());

    let before = workspace.snapshot();
    let error = import(&archive, workspace.root(), APP_VERSION).expect_err("symlink");
    assert_eq!(error.variant(), "symlinkRejected");
    assert_eq!(workspace.snapshot(), before);
    assert!(workspace.staging_is_empty());
    assert!(
        snapshot(target.path()).is_empty(),
        "nothing may be written through a symlink"
    );
}

/// Declared sizes are summed from the central directory before a byte is inflated.
#[test]
fn refuses_declared_total_over_the_limit() {
    assert_refused(
        "bomb-total",
        Fixture::valid()
            .entry(Entry::new("payload/projects/acme/scenes/a.tsx", b"a"))
            .entry(Entry::new("payload/projects/acme/scenes/b.tsx", b"b"))
            .declared_sizes(u32::MAX - 1),
        "tooLarge",
    );
}

#[test]
fn refuses_ratio_bomb() {
    let payload = vec![0u8; 1024 * 1024];
    assert_refused(
        "bomb-ratio",
        Fixture::valid().entry(Entry::new(
            "payload/projects/acme/assets/big.txt",
            &payload,
        )),
        "ratioExceeded",
    );
}

#[test]
fn refuses_entry_flood() {
    let mut fixture = Fixture::valid();
    // manifest.json + manifest.sig + project.json are already three of them.
    for index in 0..(MAX_ENTRIES - 2) {
        fixture = fixture.entry(
            Entry::new(&format!("payload/projects/acme/scenes/{index}.tsx"), b"")
                .unlisted()
                .stored(),
        );
    }
    assert_refused("entry-flood", fixture, "tooManyEntries");
}

/// `inspect` reads the signature but never verifies it: that is the import command's call, so the pack
/// still opens and the test does the verifying an importer would do.
#[test]
fn forged_signature_fails_verification() {
    let source = TempDir::new("forged");
    let archive = Fixture::valid()
        .signature(SigMode::Forged)
        .build(source.path());

    let inspection = inspect(&archive, APP_VERSION).expect("inspect still opens the pack");
    let signature = inspection.signature.clone().expect("signature entry present");
    assert_eq!(signature.len(), 64);
    assert!(
        !verify_signature(&inspection.manifest, &inspection.manifest_bytes, &signature),
        "a signature from another key must not verify against the declared publisher"
    );
}

/// Same seam: an unsigned pack inspects cleanly and the caller refuses it on `signature == None`.
#[test]
fn unsigned_pack_has_no_signature() {
    let source = TempDir::new("unsigned");
    let archive = Fixture::valid()
        .signature(SigMode::Absent)
        .build(source.path());

    let inspection = inspect(&archive, APP_VERSION).expect("inspect");
    assert!(
        inspection.signature.is_none(),
        "an unsigned pack must report no signature, not an empty one"
    );
}

#[test]
fn refuses_tampered_payload() {
    let tag = "tampered";
    let source = TempDir::new(tag);
    let workspace = Workspace::new(tag);
    let archive = Fixture::valid()
        .entry(
            Entry::new("payload/projects/acme/scenes/01.tsx", b"export default 1;")
                .tampered(b"export default 0;"),
        )
        .build(source.path());

    // The signature is genuine: only the payload was touched, which is what the staged hashes are for.
    let inspection = inspect(&archive, APP_VERSION).expect("inspect");
    let signature = inspection.signature.clone().expect("signature");
    assert!(verify_signature(
        &inspection.manifest,
        &inspection.manifest_bytes,
        &signature
    ));

    let before = workspace.snapshot();
    let error = import(&archive, workspace.root(), APP_VERSION).expect_err("tampered");
    assert_eq!(error.variant(), "hashMismatch");
    assert_eq!(
        error.path(),
        Some("payload/projects/acme/scenes/01.tsx"),
        "the refusal must name the file"
    );
    assert_eq!(workspace.snapshot(), before);
    assert!(workspace.staging_is_empty());
}

#[test]
fn refuses_ghost_entry() {
    assert_refused(
        "ghost-entry",
        Fixture::valid().entry(
            Entry::new("payload/projects/acme/scenes/ghost.tsx", b"surprise").unlisted(),
        ),
        "entryNotInManifest",
    );
}

#[test]
fn refuses_missing_entry() {
    assert_refused(
        "missing-entry",
        Fixture::valid().ghost("payload/projects/acme/scenes/gone.tsx"),
        "manifestEntryMissing",
    );
}

#[test]
fn refuses_bad_extension() {
    assert_refused(
        "bad-extension",
        Fixture::valid().entry(Entry::new(
            "payload/projects/acme/scenes/evil.sh",
            b"#!/bin/sh\nrm -rf ~\n",
        )),
        "extensionNotAllowed",
    );
}

#[test]
fn refuses_git_directory() {
    assert_refused(
        "git-dir",
        Fixture::valid().entry(Entry::new(
            "payload/projects/acme/.git/config",
            b"[core]\n",
        )),
        "extensionNotAllowed",
    );
}

#[test]
fn refuses_future_format_version() {
    assert_refused(
        "future-format",
        Fixture::valid().format_version(PACK_FORMAT_VERSION + 1),
        "formatTooNew",
    );
}

#[test]
fn refuses_future_min_app_version() {
    assert_refused(
        "future-app",
        Fixture::valid().min_app_version("99.0.0"),
        "appTooOld",
    );
}

#[test]
fn refuses_deep_paths() {
    let nesting = vec!["a"; 20].join("/");
    assert_refused(
        "deep-path",
        Fixture::valid().entry(Entry::new(
            &format!("payload/projects/acme/{nesting}/x.tsx"),
            b"deep",
        )),
        "pathTooDeep",
    );
}

#[test]
fn refuses_long_names() {
    let name = "n".repeat(MAX_PATH_BYTES + 1);
    assert_refused(
        "long-name",
        Fixture::valid().entry(Entry::new(
            &format!("payload/projects/acme/scenes/{name}.tsx"),
            b"long",
        )),
        "pathTooLong",
    );
}

/// A right-to-left override renders `evil.txt.tsx` as `evil.sxt.txt` in every file list.
#[test]
fn refuses_unicode_direction_tricks() {
    assert_refused(
        "unicode-trick",
        Fixture::valid().entry(Entry::new(
            "payload/projects/acme/scenes/evil\u{202E}xst.txt",
            b"trick",
        )),
        "pathSuspicious",
    );
}

#[test]
fn refuses_huge_manifest() {
    let description = "a".repeat((MAX_MANIFEST_BYTES + 1024) as usize);
    assert_refused(
        "huge-manifest",
        Fixture::valid().description(description),
        "manifestTooLarge",
    );
}

/// Not a refusal: an executable bit is stripped rather than rejected, because the file itself is fine.
#[cfg(unix)]
#[test]
fn strips_the_executable_bit() {
    use std::os::unix::fs::PermissionsExt;

    let tag = "exec-bit";
    let source = TempDir::new(tag);
    let workspace = Workspace::new(tag);
    let archive = Fixture::valid()
        .entry(Entry::new("payload/projects/acme/scenes/01.tsx", b"code").mode(0o755))
        .build(source.path());

    let inspection = inspect(&archive, APP_VERSION).expect("inspect");
    let staged = stage(
        &archive,
        workspace.root(),
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )
    .expect("stage");

    let file = staged.root.join("payload/projects/acme/scenes/01.tsx");
    let mode = std::fs::metadata(&file).expect("meta").permissions().mode();
    assert_eq!(mode & 0o777, 0o644, "extracted files are always 0644");
    let parent = std::fs::metadata(file.parent().unwrap())
        .expect("meta")
        .permissions()
        .mode();
    assert_eq!(parent & 0o777, 0o755, "extracted directories are always 0755");
}

/// A dotted directory other than `.claude` never lands, whatever the file inside it is called.
#[test]
fn refuses_other_dotted_directories() {
    assert_refused(
        "dot-dir",
        Fixture::valid().entry(Entry::new(
            "payload/projects/acme/.ssh/config.json",
            b"{}",
        )),
        "extensionNotAllowed",
    );
}

/// Nothing may live outside `payload/`, however innocent it looks.
#[test]
fn refuses_entries_outside_payload() {
    assert_refused(
        "outside-payload",
        Fixture::valid().entry(Entry::new("README.md", b"# hello")),
        "pathOutsidePayload",
    );
}

/// `StagedPack` never sees them: macOS archiver litter is skipped rather than refused.
#[test]
fn ignores_macos_archive_litter() {
    let tag = "litter";
    let source = TempDir::new(tag);
    let workspace = Workspace::new(tag);
    let archive = Fixture::valid()
        .entry(Entry::new("__MACOSX/payload/projects/acme/._project.json", b"x").unlisted())
        .entry(Entry::new("payload/projects/acme/.DS_Store", b"x").unlisted())
        .entry(Entry::new("payload/projects/acme/._project.json", b"x").unlisted())
        .build(source.path());

    let inspection = inspect(&archive, APP_VERSION).expect("inspect");
    let staged = stage(
        &archive,
        workspace.root(),
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )
    .expect("litter is skipped, not refused");
    assert_eq!(snapshot(&staged.root).len(), 1);
}

/// FAILING, and deliberately not fixed here: nothing validates the paths carried in `contents`.
///
/// Regression test for the contents-path hole: `PackFont.file`, `PackObject.glb`, `PackObject.thumbnail`,
/// `PackScreenshot.file` and `PackProject.root` are manifest-controlled strings that apply joins onto the staging
/// root, and `Path::join` with an absolute path DISCARDS the base. `read::validate_contents_paths` now runs
/// `validate_archive_path` over every one and requires it to appear in `files`.
#[test]
fn refuses_hostile_paths_in_contents() {
    let source = TempDir::new("contents-path");
    let mut contents = PackContents::default();
    contents.fonts.push(PackFont {
        base: PackItemBase::default(),
        family: "Escape".into(),
        weight: 400,
        postscript: "Escape-Regular".into(),
        file: Some("/etc/passwd".into()),
        sha256: None,
        instanced: None,
        embedding: FontEmbedding::Installable,
        reference_only: None,
    });
    contents.objects.push(PackObject {
        glb: "../../../../../../.zshrc".into(),
        ..Default::default()
    });
    let archive = Fixture::valid().contents(contents).build(source.path());

    let error = inspect(&archive, APP_VERSION)
        .err()
        .expect("a contents path outside payload/ must be refused");
    assert!(
        error.variant().starts_with("path"),
        "expected a path refusal, got {}",
        error.variant()
    );
}

/// Cancellation is checked per entry and unwinds through the same Drop as a refusal.
#[test]
fn cancellation_leaves_nothing_behind() {
    let source = TempDir::new("cancel");
    let out = TempDir::new("cancel-out");
    let workspace = Workspace::new("cancel");
    let archive = out.path().join("acme.kbpack");
    let (manifest, _) = write_valid_pack(source.path(), &archive);

    // `StagedPack` is deliberately not `Debug`, so unwrap the error by hand.
    let error = match stage(&archive, workspace.root(), &manifest, |_, _| {}, &|| true) {
        Ok(_) => panic!("cancellation must refuse"),
        Err(error) => error,
    };
    assert_eq!(error.variant(), "cancelled");
    assert!(workspace.staging_is_empty());
}
