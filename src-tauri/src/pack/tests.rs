//! Container tests: the write/inspect/stage round trip, and one refusal per extraction-checklist item.
//!
//! Hostile packs are built at test time rather than committed, because a committed malicious zip upsets scanners.

use super::error::PackError;
use super::hash::{sha256_bytes, sha256_file};
use super::limits::{
    MANIFEST_ENTRY, MAX_ENTRIES, MAX_MANIFEST_BYTES, MAX_PATH_BYTES, MAX_TOTAL_UNCOMPRESSED,
    SIGNATURE_ENTRY, STAGING_DIR,
};
use super::model::{
    FontEmbedding, ItemKind, PackBrand, PackContents, PackFile, PackFont, PackItemBase,
    PackManifest, PackMeta, PackObject, PackProject, PackPublisher, PackScreenshot,
    PackSimpleItem, PackTheme, PackTotals, PACK_FORMAT, PACK_FORMAT_VERSION,
};
use super::read::{check_staging_space, inspect, stage, sweep_stale};
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
        write_file(
            &dir.path().join("projects/keep/project.json"),
            b"{\"id\":\"keep\"}",
        );
        write_file(
            &dir.path().join("themes/keep/theme.json"),
            b"{\"id\":\"keep\"}",
        );
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
    /// A valid signature followed by padding: not 64 bytes, so not a signature.
    Oversized,
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
    /// Entry names swapped for raw bytes of the same length after writing.
    raw_names: Vec<(String, Vec<u8>)>,
    /// A `keyId` other than the one the public key derives.
    key_id: Option<String>,
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
            raw_names: Vec::new(),
            key_id: None,
        }
    }

    fn key_id(mut self, key_id: &str) -> Self {
        self.key_id = Some(key_id.to_string());
        self
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

    fn raw_name(mut self, name: &str, raw: &[u8]) -> Self {
        self.raw_names.push((name.to_string(), raw.to_vec()));
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
            publisher: PackPublisher {
                key_id: self
                    .key_id
                    .clone()
                    .unwrap_or_else(|| publisher(PUBLISHER_SEED).key_id),
                ..publisher(PUBLISHER_SEED)
            },
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
                if self.signature == SigMode::Oversized {
                    zip.write_all(&vec![0u8; 4096]).unwrap();
                }
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
        for (name, raw) in &self.raw_names {
            overwrite_raw_name(&mut buffer, name, raw);
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

/// Each central directory header's offset and its entry's name length.
fn central_headers(buffer: &[u8]) -> Vec<(usize, usize)> {
    let eocd = buffer
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .expect("end of central directory");
    let offset = u32::from_le_bytes(buffer[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(buffer[eocd + 10..eocd + 12].try_into().unwrap()) as usize;

    let mut headers = Vec::with_capacity(count);
    let mut at = offset;
    for _ in 0..count {
        assert_eq!(
            &buffer[at..at + 4],
            b"PK\x01\x02",
            "central directory header"
        );
        let name_len = u16::from_le_bytes(buffer[at + 28..at + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(buffer[at + 30..at + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(buffer[at + 32..at + 34].try_into().unwrap()) as usize;
        headers.push((at, name_len));
        at += 46 + name_len + extra_len + comment_len;
    }
    headers
}

/// Make every `payload/` entry claim `bytes` uncompressed, so the pre-inflation total guard has something to catch.
/// The central directory is what `inspect` reads, so only it needs rewriting.
fn overwrite_declared_sizes(buffer: &mut [u8], bytes: u32) {
    for (at, name_len) in central_headers(buffer) {
        if buffer[at + 46..at + 46 + name_len].starts_with(b"payload/") {
            buffer[at + 24..at + 28].copy_from_slice(&bytes.to_le_bytes());
        }
    }
}

/// The writer only takes `&str` names, so non-UTF-8 ones are patched into both headers afterwards.
fn overwrite_raw_name(buffer: &mut [u8], name: &str, raw: &[u8]) {
    assert_eq!(name.len(), raw.len(), "a raw name must keep its length");
    for (at, name_len) in central_headers(buffer) {
        if &buffer[at + 46..at + 46 + name_len] != name.as_bytes() {
            continue;
        }
        let local = u32::from_le_bytes(buffer[at + 42..at + 46].try_into().unwrap()) as usize;
        assert_eq!(
            &buffer[local..local + 4],
            b"PK\x03\x04",
            "local file header"
        );
        buffer[at + 46..at + 46 + name_len].copy_from_slice(raw);
        buffer[local + 30..local + 30 + name_len].copy_from_slice(raw);
    }
}

// The import seam under test.

/// What an importer does before it is allowed to touch the workspace: inspect, then stage and hash-verify.
fn import(archive: &Path, workspace: &Path, app_version: &str) -> Result<(), PackError> {
    let _ = app_version;
    let inspection = inspect(archive)?;
    let staged = stage(archive, workspace, &inspection.manifest, |_, _| {}, &|| {
        false
    })?;
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

// Per-kind ceilings and the publisher name check.

/// A font whose header claims more than a font may be is refused before consent, by kind, with the font named.
#[test]
fn refuses_a_font_over_its_kind_cap() {
    let over = (super::limits::MAX_FONT_BYTES + 1) as u32;
    let fixture = Fixture {
        entries: vec![Entry::new("payload/fonts/Acme-Bold.ttf", b"not really a font")],
        ..Fixture::valid()
    }
    .declared_sizes(over);
    let source = TempDir::new("font-cap");
    let archive = fixture.build(source.path());
    let error = match inspect(&archive) {
        Ok(_) => panic!("an oversized font should be refused"),
        Err(error) => error,
    };
    assert_eq!(error.variant(), "kindTooLarge");
    assert_eq!(error.path(), Some("payload/fonts/Acme-Bold.ttf"));
    assert!(error.user_message().contains("font"), "{}", error.user_message());
}

/// A pack from a known name under a key this Mac has never seen is the changed-key verdict, never first time.
#[test]
fn a_known_name_under_a_new_key_reads_as_changed() {
    use crate::workspace::KnownPublisher;
    use std::collections::HashMap;
    let theirs = publisher(PUBLISHER_SEED);
    let mut known: HashMap<String, KnownPublisher> = HashMap::new();
    super::publisher::record_import(
        &mut known,
        &publisher(IMPOSTER_SEED),
        "Starter Kit",
        "2026-07-01T00:00:00Z",
    );
    assert_eq!(known.len(), 1);
    match super::publisher::publisher_verdict(&known, &theirs) {
        super::publisher::PublisherVerdict::KeyChanged {
            known_as,
            previous_key_id,
            last_pack,
        } => {
            assert_eq!(known_as, "Test Publisher");
            assert_eq!(previous_key_id, publisher(IMPOSTER_SEED).key_id);
            assert_eq!(last_pack, "Starter Kit");
        }
        other => panic!("expected a changed key, got {other:?}"),
    }
}

// The manifest's own claims about itself.

fn project_item(root: &str, scene_files: &[&str]) -> PackProject {
    PackProject {
        base: PackItemBase {
            slug: root.rsplit('/').next().unwrap_or(root).into(),
            name: "Acme".into(),
            ..Default::default()
        },
        root: root.into(),
        scene_count: scene_files.len(),
        scene_files: scene_files.iter().map(|s| (*s).to_string()).collect(),
        has_scene_code: true,
        ..Default::default()
    }
}

/// `sceneFiles` is checked against the `scenes/**/*.tsx` the pack would stage, for a project, a template and a preset
/// alike: a file it leaves out, a file it invents and a duplicate are each refused before consent.
#[test]
fn refuses_a_scene_file_list_that_is_not_the_staged_set() {
    let roots = [
        ("payload/projects/acme", "projects"),
        ("payload/templates/acme", "templates"),
        ("payload/presets/acme", "presets"),
    ];
    for (root, kind) in roots {
        let with = |contents: fn(&mut PackContents, PackProject), listed: &[&str], tag: &str| {
            let mut fixture = Fixture::valid()
                .entry(Entry::new(
                    &format!("{root}/scenes/01-hero.tsx"),
                    b"export default defineScene({});\n",
                ))
                .entry(Entry::new(
                    &format!("{root}/scenes/02-extra.tsx"),
                    b"export default defineScene({});\n",
                ));
            let mut pack = PackContents::default();
            contents(&mut pack, project_item(root, listed));
            fixture = fixture.contents(pack);
            assert_refused(&format!("{kind}-{tag}"), fixture, "sceneFilesMismatch");
        };
        let push: fn(&mut PackContents, PackProject) = match kind {
            "projects" => |c, p| c.projects.push(p),
            "templates" => |c, p| c.templates.push(p),
            _ => |c, p| c.presets.push(p),
        };
        with(push, &["scenes/01-hero.tsx"], "left-out");
        with(
            push,
            &["scenes/01-hero.tsx", "scenes/02-extra.tsx", "scenes/03-ghost.tsx"],
            "invented",
        );
        with(
            push,
            &["scenes/01-hero.tsx", "scenes/02-extra.tsx", "scenes/02-extra.tsx"],
            "duplicate",
        );
    }
}

/// The honest list: the reader hands back exactly the staged scene code, per item, in the manifest's order.
#[test]
fn inspect_lists_the_staged_scene_code() {
    let source = TempDir::new("scene-list");
    let mut contents = PackContents::default();
    contents.projects.push(project_item(
        "payload/projects/acme",
        &["scenes/02-outro.tsx", "scenes/01-hero.tsx"],
    ));
    contents.presets.push(project_item(
        "payload/presets/stat",
        &["scenes/01-stat.tsx"],
    ));
    let fixture = Fixture::valid()
        .entry(Entry::new("payload/projects/acme/scenes/01-hero.tsx", b"a"))
        .entry(Entry::new("payload/projects/acme/scenes/02-outro.tsx", b"b"))
        .entry(Entry::new("payload/projects/acme/scenes/01-hero.json", b"{}"))
        .entry(Entry::new("payload/presets/stat/project.json", b"{}"))
        .entry(Entry::new("payload/presets/stat/scenes/01-stat.tsx", b"c"))
        .contents(contents);
    let archive = fixture.build(source.path());
    let inspection = inspect(&archive).expect("a matching list is accepted");
    let listed: Vec<(ItemKind, &str, &str)> = inspection
        .scene_sources
        .iter()
        .map(|s| (s.kind, s.slug.as_str(), s.file.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![
            (ItemKind::Project, "acme", "scenes/02-outro.tsx"),
            (ItemKind::Project, "acme", "scenes/01-hero.tsx"),
            (ItemKind::Preset, "stat", "scenes/01-stat.tsx"),
        ]
    );
}

/// A declared `keyId` that is not the hash of the public key beside it is refused, however good the signature is.
#[test]
fn refuses_a_key_id_the_public_key_does_not_derive() {
    let borrowed = publisher(IMPOSTER_SEED).key_id;
    assert_refused(
        "key-id",
        Fixture::valid().key_id(&borrowed),
        "keyIdMismatch",
    );
    assert_refused(
        "key-id-garbage",
        Fixture::valid().key_id("not-hex-at-all"),
        "keyIdMismatch",
    );
}

/// `manifest.sig` is read to a small bound, never to its end: a padded entry is not a signature.
#[test]
fn refuses_an_oversized_signature() {
    assert_refused(
        "sig-oversized",
        Fixture::valid().signature(SigMode::Oversized),
        "signatureInvalid",
    );
}

/// A pre-staging read (the code viewer, the sidecar review) hands back only bytes that match the signed hash.
#[test]
fn a_pre_staging_read_refuses_tampered_bytes() {
    let source = TempDir::new("verified-read");
    let mut contents = PackContents::default();
    contents
        .projects
        .push(project_item("payload/projects/acme", &["scenes/01-hero.tsx"]));
    let fixture = Fixture::valid()
        .entry(
            Entry::new("payload/projects/acme/scenes/01-hero.tsx", b"fetch('https://evil')")
                .tampered(b"export default defineScene({});\n"),
        )
        .entry(Entry::new("payload/projects/acme/scenes/01-hero.json", b"{}"))
        .contents(contents);
    let archive = fixture.build(source.path());
    let inspection = inspect(&archive).expect("hashes are checked on read, not at inspect");
    let error = super::read::read_entry(
        &archive,
        &inspection.manifest,
        "payload/projects/acme/scenes/01-hero.tsx",
        1024,
    )
    .expect_err("tampered bytes must not be shown as the signed code");
    assert_eq!(error.variant(), "hashMismatch");
    let clean = super::read::read_verified_entry(
        &archive,
        &inspection.manifest,
        "payload/projects/acme/scenes/01-hero.json",
        1024,
    )
    .expect("matching bytes read");
    assert_eq!(clean, b"{}");
    assert_eq!(
        inspection.scene_sources[0].sidecar_path().as_deref(),
        Some("payload/projects/acme/scenes/01-hero.json")
    );
    assert_eq!(
        inspection.scene_sources[0].archive_path(),
        "payload/projects/acme/scenes/01-hero.tsx"
    );
}

/// An item's root must be the folder apply lands for its kind and slug, and no two items may claim one root: otherwise
/// the trust and code screens describe one folder while apply moves another.
#[test]
fn refuses_an_item_root_that_is_not_its_slug() {
    let mut contents = PackContents::default();
    let mut other = project_item("payload/projects/other", &["scenes/01-hero.tsx"]);
    other.base.slug = "acme".into();
    contents.projects.push(other);
    assert_refused(
        "root-slug",
        Fixture::valid()
            .entry(Entry::new("payload/projects/other/scenes/01-hero.tsx", b"a"))
            .contents(contents),
        "itemRootMismatch",
    );

    let mut twice = PackContents::default();
    twice.projects.push(project_item("payload/projects/acme", &[]));
    twice.projects.push(project_item("payload/projects/acme", &[]));
    assert_refused(
        "root-twice",
        Fixture::valid().contents(twice),
        "itemRootMismatch",
    );

    let mut wrong_kind = PackContents::default();
    wrong_kind.templates.push(project_item("payload/projects/acme", &[]));
    assert_refused(
        "root-kind",
        Fixture::valid().contents(wrong_kind),
        "itemRootMismatch",
    );
}

// Happy path.

/// One file per payload subtree, so the round trip covers every kind a pack can carry.
const SOURCE_TREE: &[(&str, &[u8])] = &[
    (
        "projects/acme/project.json",
        b"{\"id\":\"acme\",\"version\":9}",
    ),
    (
        "projects/acme/scenes/01-hero.tsx",
        b"export default defineScene({});\n",
    ),
    (
        "projects/acme/scenes/01-hero.json",
        b"{\"text\":{\"title\":\"Hi\"}}",
    ),
    (
        "projects/acme/assets/logo.png",
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3],
    ),
    ("projects/acme/CLAUDE.md", b"# Acme\n"),
    (
        "projects/acme/.claude/settings.json",
        b"{\"permissions\":{}}",
    ),
    (
        "templates/acme-promo/template.json",
        b"{\"version\":1,\"name\":\"Acme Promo\"}",
    ),
    (
        "templates/acme-promo/project.json",
        b"{\"id\":\"acme-promo\",\"version\":9}",
    ),
    (
        "templates/acme-promo/scenes/01-hero.tsx",
        b"export default defineScene({});\n",
    ),
    ("templates/acme-promo/poster.jpg", b"\xff\xd8\xff poster"),
    (
        "presets/stat-hero/preset.json",
        b"{\"version\":1,\"name\":\"Stat hero\"}",
    ),
    (
        "presets/stat-hero/project.json",
        b"{\"id\":\"stat-hero\",\"version\":9}",
    ),
    (
        "presets/stat-hero/scenes/01-stat.tsx",
        b"export default defineScene({});\n",
    ),
    (
        "themes/acme-dark/theme.json",
        b"{\"id\":\"acme-dark\",\"version\":9}",
    ),
    (
        "brands/acme/brand.json",
        b"{\"version\":1,\"name\":\"Acme\"}",
    ),
    ("brands/acme/guidelines.md", b"# Acme\n"),
    (
        "brands/acme/images/logos/mark.svg",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    ),
    (
        "fonts/AcmeSans-Bold.ttf",
        b"\x00\x01\x00\x00 not really a font",
    ),
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
            bytes: std::fs::metadata(source.join(relative))
                .expect("meta")
                .len(),
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
                scene_files: vec!["scenes/01-hero.tsx".into()],
                duration_ms: 4000,
                formats: vec!["16:9".into()],
                theme_id: "ws:acme-dark".into(),
                requires: Default::default(),
                has_scene_code: true,
            }],
            templates: vec![PackProject {
                base: base("acme-promo"),
                root: "payload/templates/acme-promo".into(),
                manifest_version: 9,
                scene_count: 1,
                scene_files: vec!["scenes/01-hero.tsx".into()],
                duration_ms: 4000,
                formats: vec!["16:9".into()],
                theme_id: "ws:acme-dark".into(),
                requires: Default::default(),
                has_scene_code: true,
            }],
            presets: vec![PackProject {
                base: base("stat-hero"),
                root: "payload/presets/stat-hero".into(),
                manifest_version: 9,
                scene_count: 1,
                scene_files: vec!["scenes/01-stat.tsx".into()],
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
            brands: vec![PackBrand {
                base: base("acme"),
                description: Some("House style.".into()),
                swatches: vec!["#151E29".into()],
                color_count: 1,
                image_count: 1,
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

    let inspection = inspect(&archive).expect("inspect");
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

    assert!(staged
        .root
        .starts_with(workspace.root().join(STATE_DIR_NAME).join(STAGING_DIR)));
    // The fixture's `.claude/settings.json` (an older pack's agent config) is dropped at staging and named, never written.
    assert_eq!(
        staged.dropped,
        vec!["payload/projects/acme/.claude/settings.json".to_owned()]
    );
    let staged_count = SOURCE_TREE.len() - 1;
    assert_eq!(progress.len(), staged_count);
    let dropped_bytes: u64 = inspection
        .manifest
        .files
        .iter()
        .filter(|f| staged.dropped.contains(&f.path))
        .map(|f| f.bytes)
        .sum();
    assert!(dropped_bytes > 0);
    // Dropped entries leave the total too, so the bar reaches full.
    let staged_bytes = inspection.manifest.totals.bytes - dropped_bytes;
    assert_eq!(progress.last().copied(), Some((staged_bytes, staged_bytes)));

    // Byte-identical, and nothing the manifest did not list.
    for (relative, _) in SOURCE_TREE {
        if relative.contains("/.claude/") {
            assert!(!staged.root.join("payload").join(relative).exists());
            continue;
        }
        let original = std::fs::read(source.path().join(relative)).expect("source");
        let extracted = std::fs::read(staged.root.join("payload").join(relative)).expect("staged");
        assert_eq!(extracted, original, "{relative} differs");
    }
    for file in &inspection.manifest.files {
        if staged.dropped.contains(&file.path) {
            continue;
        }
        assert_eq!(
            sha256_file(&staged.root.join(&file.path)).expect("hash"),
            file.sha256,
            "{} hash",
            file.path
        );
    }
    assert_eq!(snapshot(&staged.root).len(), staged_count);

    // The workspace itself is untouched: staging is the only thing `stage` may write.
    let mut outside = workspace.snapshot();
    outside.retain(|(path, _)| !path.starts_with(STATE_DIR_NAME));
    assert_eq!(outside, Workspace::new("rt-reference").snapshot());
}

// Templates and presets, end to end.

/// One author workspace: a template and a preset, both bound to the same workspace theme.
fn build_library_workspace(root: &Path) {
    let project = |id: &str, scene: &str| {
        format!(
            r#"{{"id":"{id}","name":"{id}","version":2,"themeId":"ws:acme-dark","formats":["16:9"],
                "scenes":[{{"file":"scenes/{scene}.tsx","durationMs":2000}}]}}"#
        )
    };
    write_file(
        &root.join("templates/acme-promo/template.json"),
        br#"{"version":1,"name":"Acme Promo","tagline":"","order":10,"status":"stable","source":"user"}"#,
    );
    write_file(
        &root.join("templates/acme-promo/project.json"),
        project("acme-promo", "01-hero").as_bytes(),
    );
    write_file(
        &root.join("templates/acme-promo/scenes/01-hero.tsx"),
        b"export default defineScene({});\n",
    );
    write_file(
        &root.join("templates/acme-promo/scenes/01-hero.json"),
        br#"{"version":1,"themeId":"ws:acme-dark","text":{"title":"Hi"}}"#,
    );
    write_file(
        &root.join("presets/stat-hero/preset.json"),
        br#"{"version":1,"name":"Stat hero","tagline":"","tags":[],"order":10,"status":"stable","source":"user"}"#,
    );
    write_file(
        &root.join("presets/stat-hero/project.json"),
        project("stat-hero", "01-stat").as_bytes(),
    );
    write_file(
        &root.join("presets/stat-hero/scenes/01-stat.tsx"),
        b"export default defineScene({});\n",
    );
    write_file(
        &root.join("themes/acme-dark/theme.json"),
        br#"{"version":2,"name":"Acme Dark","mode":"dark"}"#,
    );
}

/// The manifest half of `build_pack`, without the `AppHandle` a command needs.
fn write_pack_from(closure: &super::deps::Closure, out: &Path) {
    let files: Vec<PackFile> = closure
        .files
        .iter()
        .map(|f| PackFile {
            path: f.archive_path.clone(),
            sha256: f.sha256.clone(),
            bytes: f.bytes,
        })
        .collect();
    let manifest = PackManifest {
        format: PACK_FORMAT.into(),
        format_version: super::model::format_version_for(&closure.contents),
        app_version: APP_VERSION.into(),
        min_app_version: "0.1.0".into(),
        pack: PackMeta {
            name: "Acme Library".into(),
            description: None,
            created_at: "2026-08-23T00:00:00Z".into(),
        },
        publisher: publisher(PUBLISHER_SEED),
        contents: closure.contents.clone(),
        totals: PackTotals {
            files: files.len(),
            bytes: files.iter().map(|f| f.bytes).sum(),
        },
        files,
    };
    let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest");
    let signature = signing_key(PUBLISHER_SEED).sign(&manifest_bytes).to_bytes();
    let entries: Vec<PackEntry> = closure
        .files
        .iter()
        .map(|f| PackEntry {
            archive_path: f.archive_path.clone(),
            source: f.source.clone(),
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
}

fn json_at(path: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("json")
}

fn field(path: &Path, key: &str) -> String {
    json_at(path)
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The whole carriage: a template and a preset are packed with the theme they name, imported into a workspace that
/// already owns both slugs, and land renamed, re-pointed at the renamed theme, and stamped as coming from a pack.
#[test]
fn templates_and_presets_round_trip_into_another_workspace() {
    use super::apply::{apply_import, ItemOutcome};
    use super::conflicts::plan_conflicts;
    use super::deps::{item_key, resolve_closure, PackSelection};
    use super::model::{ItemKind, Resolution};
    use std::collections::HashMap;

    let author = TempDir::new("lib-author");
    let out = TempDir::new("lib-out");
    let recipient = TempDir::new("lib-recipient");
    build_library_workspace(author.path());

    let capture =
        serde_json::json!({"scene":0,"sceneFile":"scenes/01-hero.tsx","atMs":600,"aspect":"9:16"});
    let template_path = author.path().join("templates/acme-promo/template.json");
    let mut template: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&template_path).unwrap()).unwrap();
    template["preview"] = serde_json::json!({"poster":2,"frames":[capture.clone(),capture.clone(),capture.clone(),capture.clone()]});
    write_file(&template_path, &serde_json::to_vec(&template).unwrap());
    for slot in 1..=4 {
        write_file(
            &author
                .path()
                .join(format!("templates/acme-promo/previews/{slot}.png")),
            format!("preview {slot}").as_bytes(),
        );
    }
    write_file(
        &author.path().join("presets/stat-hero/poster.png"),
        b"preset preview",
    );

    let selection = PackSelection {
        templates: vec!["acme-promo".into()],
        presets: vec!["stat-hero".into()],
        ..Default::default()
    };
    let closure = resolve_closure(author.path(), &selection).expect("closure");

    // The theme rides along because both library items name it, exactly as it would for a project.
    assert_eq!(closure.contents.templates.len(), 1);
    assert_eq!(closure.contents.presets.len(), 1);
    assert_eq!(closure.contents.themes.len(), 1);
    // The name comes from the item's own manifest, which is the only place a rename lands.
    assert_eq!(closure.contents.templates[0].base.name, "Acme Promo");
    assert_eq!(closure.contents.presets[0].base.name, "Stat hero");
    assert_eq!(
        closure.required_by.get("theme:acme-dark"),
        Some(&vec![
            "preset:stat-hero".to_owned(),
            "template:acme-promo".to_owned()
        ])
    );
    let paths: Vec<&str> = closure
        .files
        .iter()
        .map(|f| f.archive_path.as_str())
        .collect();
    assert!(paths.contains(&"payload/templates/acme-promo/template.json"));
    assert!(paths.contains(&"payload/presets/stat-hero/preset.json"));

    let archive = out.path().join("acme-library.kbpack");
    write_pack_from(&closure, &archive);

    // The recipient already owns both slugs, so each keeps both.
    write_file(
        &recipient.path().join("templates/acme-promo/template.json"),
        br#"{"version":1,"name":"Mine","source":"user"}"#,
    );
    write_file(
        &recipient.path().join("templates/acme-promo/project.json"),
        br#"{"id":"acme-promo","name":"Mine"}"#,
    );
    write_file(
        &recipient.path().join("themes/acme-dark/theme.json"),
        br#"{"version":2,"name":"My Acme Dark"}"#,
    );

    let inspection = inspect(&archive).expect("inspect");
    let staged = stage(
        &archive,
        recipient.path(),
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )
    .expect("stage");

    let plan = plan_conflicts(recipient.path(), &staged, &selection_with_theme()).expect("plan");
    let template = plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Template)
        .expect("template planned");
    assert_eq!(template.keep_both_slug.as_deref(), Some("acme-promo-2"));
    assert!(plan.items.iter().any(|i| i.kind == ItemKind::Preset));

    let resolutions: HashMap<String, Resolution> = [
        (item_key(ItemKind::Theme, "acme-dark"), Resolution::KeepBoth),
        (
            item_key(ItemKind::Template, "acme-promo"),
            Resolution::KeepBoth,
        ),
        (item_key(ItemKind::Preset, "stat-hero"), Resolution::Replace),
    ]
    .into_iter()
    .collect();

    let outcome =
        apply_import(recipient.path(), staged, &resolutions, |_, _, _| {}).expect("apply");
    assert_eq!(outcome.stopped_at, None, "{:?}", outcome.results);

    let landed = |kind: ItemKind| {
        outcome
            .results
            .iter()
            .find(|r| r.kind == kind)
            .unwrap_or_else(|| panic!("no result for {kind:?}"))
            .clone()
    };
    assert_eq!(landed(ItemKind::Template).outcome, ItemOutcome::KeptBoth);
    assert_eq!(landed(ItemKind::Template).slug, "acme-promo-2");
    assert_eq!(landed(ItemKind::Preset).outcome, ItemOutcome::Added);

    let root = recipient.path();
    for slot in 1..=4 {
        assert_eq!(
            std::fs::read(root.join(format!("templates/acme-promo-2/previews/{slot}.png")))
                .unwrap(),
            format!("preview {slot}").as_bytes()
        );
    }
    assert_eq!(
        std::fs::read(root.join("presets/stat-hero/poster.png")).unwrap(),
        b"preset preview"
    );
    let imported: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("templates/acme-promo-2/template.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(imported["preview"]["poster"], 2);
    assert_eq!(imported["preview"]["frames"][2], capture);

    // The incumbent template is untouched, the incoming one landed beside it.
    assert_eq!(
        field(&root.join("templates/acme-promo/template.json"), "name"),
        "Mine"
    );
    let manifest = root.join("templates/acme-promo-2/template.json");
    assert_eq!(field(&manifest, "name"), "Acme Promo");
    assert_eq!(field(&manifest, "source"), "pack");
    assert_eq!(
        field(&root.join("presets/stat-hero/preset.json"), "source"),
        "pack"
    );

    // Both library items follow the theme the keep-both moved, in the manifest and in the sidecar.
    assert_eq!(
        field(&root.join("templates/acme-promo-2/project.json"), "themeId"),
        "ws:acme-dark-2"
    );
    assert_eq!(
        field(&root.join("templates/acme-promo-2/project.json"), "id"),
        "acme-promo-2"
    );
    assert_eq!(
        field(
            &root.join("templates/acme-promo-2/scenes/01-hero.json"),
            "themeId"
        ),
        "ws:acme-dark-2"
    );
    assert_eq!(
        field(&root.join("presets/stat-hero/project.json"), "themeId"),
        "ws:acme-dark-2"
    );
    assert!(root
        .join("templates/acme-promo-2/scenes/01-hero.tsx")
        .is_file());
    assert!(root.join("presets/stat-hero/scenes/01-stat.tsx").is_file());
    assert_eq!(
        field(&root.join("themes/acme-dark/theme.json"), "name"),
        "My Acme Dark"
    );
    assert!(root.join("themes/acme-dark-2/theme.json").is_file());
}

/// Export leaves a project's acceptances in place and out of the pack, and the project still reads identical to that pack.
#[test]
fn accepted_flash_warnings_never_travel_and_stay_home() {
    use super::conflicts::plan_conflicts;
    use super::deps::{resolve_closure, PackSelection};
    use super::model::{ConflictState, ItemKind};
    use super::scan::ACCEPTED_FLASHES_FILE;

    let author = TempDir::new("accepted-author");
    let out = TempDir::new("accepted-out");
    let project = author.path().join("acme-promo");
    write_file(
        &project.join("project.json"),
        br#"{"id":"acme-promo","name":"Acme Promo","version":2,"formats":["16:9"],"scenes":[{"file":"scenes/01-hero.tsx","durationMs":2000}]}"#,
    );
    write_file(
        &project.join("scenes/01-hero.tsx"),
        b"export default defineScene({});\n",
    );
    let mine = br#"{"version":1,"accepted":[{"id":"5e6f7a8b","why":"a slow glint, checked by eye"}]}"#;
    write_file(&project.join(ACCEPTED_FLASHES_FILE), mine);

    let selection = PackSelection {
        projects: vec!["acme-promo".into()],
        ..Default::default()
    };
    let closure = resolve_closure(author.path(), &selection).expect("closure");
    assert!(closure
        .files
        .iter()
        .all(|f| !f.archive_path.ends_with(ACCEPTED_FLASHES_FILE)));
    let archive = out.path().join("acme-promo.kbpack");
    write_pack_from(&closure, &archive);
    assert_eq!(std::fs::read(project.join(ACCEPTED_FLASHES_FILE)).unwrap(), mine);

    let inspection = inspect(&archive).expect("inspect");
    assert!(inspection
        .manifest
        .files
        .iter()
        .all(|f| !f.path.ends_with(ACCEPTED_FLASHES_FILE)));
    let staged = stage(
        &archive,
        author.path(),
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )
    .expect("stage");
    let plan = plan_conflicts(author.path(), &staged, &selection).expect("plan");
    let item = plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Project)
        .expect("project planned");
    assert_eq!(item.state, ConflictState::Identical);
}

/// A signed, hand-built pack gets the file past the reader, under any name the volume folds onto it; apply leaves nothing for `kb`.
#[test]
fn a_hand_built_pack_cannot_land_accepted_flash_warnings() {
    use super::apply::apply_import;
    use super::deps::item_key;
    use super::model::{ItemKind, Resolution};
    use super::scan::ACCEPTED_FLASHES_FILE;
    use std::collections::HashMap;

    for (at, name) in [
        ACCEPTED_FLASHES_FILE,
        "FLASHES.ACCEPTED.JSON",
        "fla\u{17F}hes.accepted.json",
        "\u{FB02}ashes.accepted.json",
    ]
    .into_iter()
    .enumerate()
    {
        let source = TempDir::new(&format!("accepted-hostile-{at}"));
        let workspace = Workspace::new(&format!("accepted-hostile-{at}"));
        let contents = PackContents {
            projects: vec![project_item("payload/projects/acme", &[])],
            ..Default::default()
        };
        let archive = Fixture::valid()
            .entry(Entry::new(
                &format!("payload/projects/acme/{name}"),
                br#"{"version":1,"accepted":[{"id":"1a2b3c4d","why":"theirs"}]}"#,
            ))
            .contents(contents)
            .build(source.path());

        let inspection = inspect(&archive).expect("the reader takes it");
        let staged = stage(
            &archive,
            workspace.root(),
            &inspection.manifest,
            |_, _| {},
            &|| false,
        )
        .expect("the file is signed, so it stages");
        let resolutions: HashMap<String, Resolution> =
            [(item_key(ItemKind::Project, "acme"), Resolution::Replace)]
                .into_iter()
                .collect();
        let outcome =
            apply_import(workspace.root(), staged, &resolutions, |_, _, _| {}).expect("apply");

        assert_eq!(outcome.stopped_at, None, "{name}: {:?}", outcome.results);
        let landed = workspace.root().join("acme");
        assert!(landed.join("project.json").is_file(), "{name}");
        assert!(!landed.join(ACCEPTED_FLASHES_FILE).exists(), "{name} landed");
    }
}

/// The import-side selection: the same three items, with the theme the closure pulled in.
fn selection_with_theme() -> super::deps::PackSelection {
    super::deps::PackSelection {
        templates: vec!["acme-promo".into()],
        presets: vec!["stat-hero".into()],
        themes: vec!["acme-dark".into()],
        ..Default::default()
    }
}

// Brands, end to end.

/// One author workspace: a brand naming a workspace theme and a saved gradient, and a project that opts into it.
fn build_brand_workspace(root: &Path) {
    write_file(
        &root.join("brands/acme/brand.json"),
        br##"{"version":1,"name":"Acme","themes":["ws:acme-dark"],"defaultTheme":"ws:acme-dark",
            "colors":[{"name":"Ink","hex":"#151E29","role":"primary"}],"gradients":["acme-glow"]}"##,
    );
    write_file(&root.join("brands/acme/guidelines.md"), b"# Acme\n");
    write_file(&root.join("brands/acme/images/logos/mark.png"), b"png mark");
    write_file(
        &root.join("brands/acme/images/photography/team/office.webp"),
        b"webp office",
    );
    write_file(
        &root.join("themes/acme-dark/theme.json"),
        br#"{"version":2,"name":"Acme Dark","mode":"dark"}"#,
    );
    write_file(
        &root.join("gradients/acme-glow.json"),
        br##"{"type":"linear","stops":[["#000",0],["#fff",1]]}"##,
    );
    write_file(
        &root.join("acme-promo/project.json"),
        br#"{"id":"acme-promo","name":"Acme Promo","version":2,"themeId":"ws:acme-dark","brand":"ws:acme",
            "formats":["16:9"],"scenes":[{"file":"scenes/01-hero.tsx","durationMs":2000}]}"#,
    );
    write_file(
        &root.join("acme-promo/scenes/01-hero.tsx"),
        b"export default defineScene({});\n",
    );
}

/// A project packs its brand, and the brand its theme and gradient; a recipient that owns the brand slug keeps both
/// and the imported project follows the rename.
#[test]
fn a_brand_round_trips_with_the_project_that_names_it() {
    use super::apply::{apply_import, ItemOutcome};
    use super::conflicts::plan_conflicts;
    use super::deps::{item_key, resolve_closure, PackSelection};
    use super::model::{ItemKind, Resolution};
    use std::collections::HashMap;

    let author = TempDir::new("brand-author");
    let out = TempDir::new("brand-out");
    let recipient = TempDir::new("brand-recipient");
    build_brand_workspace(author.path());

    let closure = resolve_closure(
        author.path(),
        &PackSelection {
            projects: vec!["acme-promo".into()],
            ..Default::default()
        },
    )
    .expect("closure");
    assert_eq!(closure.contents.brands.len(), 1);
    assert_eq!(closure.contents.brands[0].image_count, 2);
    assert_eq!(closure.contents.themes.len(), 1);
    assert_eq!(closure.contents.gradients.len(), 1);
    let paths: Vec<&str> = closure
        .files
        .iter()
        .map(|f| f.archive_path.as_str())
        .collect();
    assert!(paths.contains(&"payload/brands/acme/images/photography/team/office.webp"));

    let archive = out.path().join("acme-brand.kbpack");
    write_pack_from(&closure, &archive);
    write_file(
        &recipient.path().join("brands/acme/brand.json"),
        br#"{"version":1,"name":"Mine"}"#,
    );

    let inspection = inspect(&archive).expect("inspect");
    assert_eq!(inspection.manifest.format_version, PACK_FORMAT_VERSION);
    let staged = stage(
        &archive,
        recipient.path(),
        &inspection.manifest,
        |_, _| {},
        &|| false,
    )
    .expect("stage");
    let selection = PackSelection {
        projects: vec!["acme-promo".into()],
        brands: vec!["acme".into()],
        themes: vec!["acme-dark".into()],
        gradients: vec!["acme-glow".into()],
        ..Default::default()
    };
    let plan = plan_conflicts(recipient.path(), &staged, &selection).expect("plan");
    let brand = plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Brand)
        .expect("brand planned");
    assert_eq!(brand.local.as_ref().map(|l| l.name.as_str()), Some("Mine"));
    assert_eq!(brand.keep_both_slug.as_deref(), Some("acme-2"));

    let resolutions: HashMap<String, Resolution> = plan
        .items
        .iter()
        .map(|i| {
            let resolution = if i.kind == ItemKind::Brand {
                Resolution::KeepBoth
            } else {
                i.resolution
            };
            (item_key(i.kind, &i.slug), resolution)
        })
        .collect();
    let outcome =
        apply_import(recipient.path(), staged, &resolutions, |_, _, _| {}).expect("apply");
    assert_eq!(outcome.stopped_at, None, "{:?}", outcome.results);
    let brand = outcome
        .results
        .iter()
        .find(|r| r.kind == ItemKind::Brand)
        .expect("brand result");
    assert_eq!(brand.outcome, ItemOutcome::KeptBoth);

    let root = recipient.path();
    assert_eq!(field(&root.join("brands/acme/brand.json"), "name"), "Mine");
    assert_eq!(
        field(&root.join("brands/acme-2/brand.json"), "name"),
        "Acme"
    );
    assert_eq!(
        std::fs::read(root.join("brands/acme-2/images/photography/team/office.webp")).unwrap(),
        b"webp office"
    );
    assert!(root.join("brands/acme-2/guidelines.md").is_file());
    assert!(root.join("themes/acme-dark/theme.json").is_file());
    assert!(root.join("gradients/acme-glow.json").is_file());
    assert_eq!(
        field(&root.join("acme-promo/project.json"), "brand"),
        "ws:acme-2"
    );
}

/// An older pack has no `brands` list at all; it still reads, with the list empty.
#[test]
fn a_manifest_without_brands_still_reads() {
    let source = TempDir::new("no-brands");
    build_source_tree(source.path());
    let mut value = serde_json::to_value(full_manifest(source.path())).expect("manifest");
    value["formatVersion"] = serde_json::json!(2);
    value["contents"]
        .as_object_mut()
        .expect("contents")
        .remove("brands");
    for list in ["projects", "templates", "presets", "themes"] {
        for item in value["contents"][list].as_array_mut().expect(list) {
            item["requires"]
                .as_object_mut()
                .expect("requires")
                .remove("brands");
        }
    }
    let parsed: PackManifest = serde_json::from_value(value).expect("an older manifest parses");
    assert!(parsed.contents.brands.is_empty());
    assert!(parsed.contents.projects[0].requires.brands.is_empty());
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
        .entry(Entry::symlink(
            "payload/projects/acme/assets.json",
            target.path(),
        ))
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

/// The signed total bounds what staging writes, so it is checked against the pack limit and the free disk before the staging folder exists.
#[test]
fn staging_refuses_a_total_the_disk_cannot_hold() {
    let total = 300 * 1024 * 1024;
    let need = total + crate::DISK_FLOOR;
    assert!(check_staging_space(total, need).is_ok());
    let short = check_staging_space(total, need - 1).unwrap_err();
    assert_eq!(short.variant(), "notEnoughSpace");
    assert!(
        short
            .user_message()
            .contains("which has 2.3 GB. Free up at least 1 MB and try again"),
        "{}",
        short.user_message()
    );
    let over = check_staging_space(MAX_TOTAL_UNCOMPRESSED + 1, u64::MAX).unwrap_err();
    assert_eq!(over.variant(), "tooLarge");
}

#[test]
fn refuses_ratio_bomb() {
    let payload = vec![0u8; 1024 * 1024];
    assert_refused(
        "bomb-ratio",
        Fixture::valid().entry(Entry::new("payload/projects/acme/assets/big.txt", &payload)),
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

    let inspection = inspect(&archive).expect("inspect still opens the pack");
    let signature = inspection
        .signature
        .clone()
        .expect("signature entry present");
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

    let inspection = inspect(&archive).expect("inspect");
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
    let inspection = inspect(&archive).expect("inspect");
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
        Fixture::valid()
            .entry(Entry::new("payload/projects/acme/scenes/ghost.tsx", b"surprise").unlisted()),
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
        Fixture::valid().entry(Entry::new("payload/projects/acme/.git/config", b"[core]\n")),
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
fn a_future_min_app_version_is_a_verdict_not_a_parse_failure() {
    // A too-new FORMAT is a parse refusal (the shape cannot be trusted); a too-new APP version is not, since the
    // manifest reads perfectly. `inspect` accepts it and the caller turns it into the "needs a newer Kookaburra Cut"
    // screen, while `stage_pack` still refuses outright.
    let tag = "future-app";
    let source = TempDir::new(tag);
    let archive = Fixture::valid()
        .min_app_version("99.0.0")
        .build(source.path());
    let inspection = inspect(&archive).expect("inspect must accept a readable manifest");
    assert_eq!(inspection.manifest.min_app_version, "99.0.0");
    assert!(super::read::version_lt(APP_VERSION, "99.0.0"));
    assert!(!super::read::version_lt("99.0.0", APP_VERSION));
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

/// zip would decode these bytes as CP437 (`café.json`); a pack name is UTF-8 or it is refused.
#[test]
fn refuses_names_that_are_not_utf8() {
    assert_refused(
        "not-utf8",
        Fixture::valid()
            .entry(Entry::new("payload/projects/acme/cafe.json", b"{}"))
            .raw_name(
                "payload/projects/acme/cafe.json",
                b"payload/projects/acme/caf\x82.json",
            ),
        "pathNotUtf8",
    );
}

/// Pins the container bytes, so a zip upgrade that changes the layout fails here rather than in the field.
#[test]
fn pack_container_bytes_are_pinned() {
    let dir = TempDir::new("pinned");
    let json = dir.path().join("project.json");
    let png = dir.path().join("logo.png");
    write_file(
        &json,
        b"{\"id\":\"acme\",\"scenes\":[\"one\",\"two\",\"three\"]}",
    );
    write_file(
        &png,
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3],
    );
    let entries = [
        PackEntry {
            archive_path: "payload/projects/acme/project.json".into(),
            source: json,
        },
        PackEntry {
            archive_path: "payload/projects/acme/assets/logo.png".into(),
            source: png,
        },
    ];
    let out = dir.path().join("pinned.kbpack");
    write_pack(
        &out,
        b"{\"format\":\"kbpack\"}",
        &[1u8; 64],
        &entries,
        |_, _| {},
        &|| false,
    )
    .expect("write_pack");
    assert_eq!(
        sha256_file(&out).unwrap(),
        "086dd8d5185eed7f0af31c550b4dc779e639a0c1bd561953a36d216889e20a4c"
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

    let inspection = inspect(&archive).expect("inspect");
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
    assert_eq!(
        parent & 0o777,
        0o755,
        "extracted directories are always 0755"
    );
}

/// A dotted directory other than `.claude` never lands, whatever the file inside it is called.
#[test]
fn refuses_other_dotted_directories() {
    assert_refused(
        "dot-dir",
        Fixture::valid().entry(Entry::new("payload/projects/acme/.ssh/config.json", b"{}")),
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

    let inspection = inspect(&archive).expect("inspect");
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

    let error = inspect(&archive)
        .err()
        .expect("a contents path outside payload/ must be refused");
    assert!(
        error.variant().starts_with("path"),
        "expected a path refusal, got {}",
        error.variant()
    );
}

/// A template and a preset root reach `apply` exactly as a project root does, so they take the same check.
#[test]
fn refuses_hostile_library_roots_in_contents() {
    for tag in ["template-root", "preset-root"] {
        let source = TempDir::new(tag);
        let escaping = PackProject {
            root: "/etc".into(),
            ..Default::default()
        };
        let mut contents = PackContents::default();
        if tag == "template-root" {
            contents.templates.push(escaping);
        } else {
            contents.presets.push(escaping);
        }
        let archive = Fixture::valid().contents(contents).build(source.path());
        let error = inspect(&archive)
            .err()
            .unwrap_or_else(|| panic!("{tag} must be refused"));
        assert!(
            error.variant().starts_with("path"),
            "{tag}: expected a path refusal, got {}",
            error.variant()
        );
    }
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
