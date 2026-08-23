//! What an import would do to the workspace, decided before a single byte moves.
//!
//! Hash first, date only as a tiebreak: an item that changed machines but not content still reads identical. The local
//! side is scanned through `scan.rs` so both sides of the comparison build their content hash the same way.

use super::deps::PackSelection;
use super::error::PackError;
use super::fonts::plan_font_merge;
use super::model::{ConflictState, ItemKind, PackFont, PackItemBase, Resolution};
use super::read::StagedPack;
use super::scan::{rfc3339, scan_dir, scan_file, ScannedItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Folder names the workspace root already owns; a pack project claiming one would shadow a whole library.
const RESERVED_PROJECT_SLUGS: [&str; 8] = [
    "themes",
    "fonts",
    "gradients",
    "export-presets",
    "objects",
    "screenshots",
    crate::library::TEMPLATES_DIR_NAME,
    crate::library::PRESETS_DIR_NAME,
];

/// How far the `-2`, `-3`, … walk goes before giving up.
const MAX_KEEP_BOTH: u32 = 999;

/// The recipient's copy, shown beside the incoming one so the default is auditable rather than magic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalItem {
    pub name: String,
    /// RFC3339, or empty when nothing readable dated it.
    pub modified_at: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPlan {
    pub kind: ItemKind,
    pub slug: String,
    pub name: String,
    pub state: ConflictState,
    pub default_resolution: Resolution,
    /// Starts equal to the default; the conflict screen is the only thing that changes it.
    pub resolution: Resolution,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub local: Option<LocalItem>,
    /// Precomputed server side so the UI never invents a slug.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub keep_both_slug: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub items: Vec<ItemPlan>,
}

/// Where one pack item would land, and what proves the recipient already has it.
pub(crate) struct Target {
    pub path: PathBuf,
    /// The file whose presence means a real item rather than a stray folder.
    pub marker: Option<&'static str>,
}

impl Target {
    pub fn exists(&self) -> bool {
        match self.marker {
            Some(file) => self.path.join(file).is_file(),
            None => self.path.is_file(),
        }
    }

    pub fn is_dir_item(&self) -> bool {
        self.marker.is_some()
    }
}

/// Resolve a pack slug to a workspace path, refusing anything that could aim outside its own library.
pub(crate) fn workspace_target(
    root: &Path,
    kind: ItemKind,
    slug: &str,
) -> Result<Target, PackError> {
    let library = || root.join(kind.workspace_dir().unwrap_or_default());
    match kind {
        ItemKind::Font => Err(PackError::DestinationInvalid(
            "fonts are merged through fonts.json, not placed by slug".into(),
        )),
        ItemKind::Screenshot => {
            validate_file_name(slug)?;
            Ok(Target {
                path: library().join(slug),
                marker: None,
            })
        }
        ItemKind::Project => {
            validate_pack_slug(slug)?;
            if RESERVED_PROJECT_SLUGS.contains(&slug) {
                return Err(PackError::DestinationInvalid(format!(
                    "\"{slug}\" is a reserved folder name"
                )));
            }
            Ok(Target {
                path: root.join(slug),
                marker: Some("project.json"),
            })
        }
        ItemKind::Theme => {
            validate_pack_slug(slug)?;
            Ok(Target {
                path: library().join(slug),
                marker: Some("theme.json"),
            })
        }
        ItemKind::Object => {
            validate_pack_slug(slug)?;
            Ok(Target {
                path: library().join(slug),
                marker: Some("object.json"),
            })
        }
        ItemKind::Gradient | ItemKind::ExportPreset => {
            validate_pack_slug(slug)?;
            Ok(Target {
                path: library().join(format!("{slug}.json")),
                marker: None,
            })
        }
    }
}

fn validate_pack_slug(slug: &str) -> Result<(), PackError> {
    crate::workspace::validate_slug(slug).map_err(PackError::DestinationInvalid)
}

fn validate_file_name(name: &str) -> Result<(), PackError> {
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(PackError::DestinationInvalid(format!(
            "invalid file name: {name:?}"
        )))
    }
}

/// The first free `<slug>-2`, `<slug>-3`, … matching the media suffix convention.
pub(crate) fn keep_both_slug(root: &Path, kind: ItemKind, slug: &str) -> Option<String> {
    if kind == ItemKind::Font {
        return None;
    }
    let (stem, ext) = split_name(kind, slug);
    for n in 2..=MAX_KEEP_BOTH {
        let candidate = match &ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        let free = workspace_target(root, kind, &candidate)
            .map(|t| !t.path.exists())
            .unwrap_or(false);
        if free {
            return Some(candidate);
        }
    }
    None
}

/// Only screenshots carry their extension in the slug, so only they suffix before the dot.
fn split_name(kind: ItemKind, slug: &str) -> (String, Option<String>) {
    if kind == ItemKind::Screenshot {
        if let Some((stem, ext)) = slug.rsplit_once('.') {
            if !stem.is_empty() && !ext.is_empty() {
                return (stem.to_owned(), Some(ext.to_owned()));
            }
        }
    }
    (slug.to_owned(), None)
}

/// The recipient's display name for an item, falling back to its slug.
pub(crate) fn local_name(kind: ItemKind, path: &Path, slug: &str) -> String {
    let doc = match kind {
        ItemKind::Project => Some(path.join("project.json")),
        ItemKind::Theme => Some(path.join("theme.json")),
        ItemKind::Object => Some(path.join("object.json")),
        ItemKind::Gradient | ItemKind::ExportPreset => Some(path.to_path_buf()),
        ItemKind::Font | ItemKind::Screenshot => None,
    };
    doc.and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|doc| {
            doc.get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .filter(|n| !n.is_empty())
        })
        .unwrap_or_else(|| slug.to_owned())
}

fn is_stamp(value: &str) -> bool {
    value.len() == 20 && value.ends_with('Z') && value.as_bytes()[4] == b'-'
}

/// An unreadable mtime reads as no date at all, never as 1970.
fn stamp_or_empty(time: SystemTime) -> String {
    if time == SystemTime::UNIX_EPOCH {
        String::new()
    } else {
        rfc3339(time)
    }
}

/// Hash decides; the date is consulted only once the bytes already disagree.
fn compare(pack_hash: &str, pack_modified: &str, local: &ScannedItem) -> ConflictState {
    if !pack_hash.is_empty() && pack_hash == local.content_hash {
        return ConflictState::Identical;
    }
    let ours = stamp_or_empty(local.modified_at);
    if !is_stamp(pack_modified) || ours.is_empty() {
        return ConflictState::UnknownAge;
    }
    match pack_modified.cmp(ours.as_str()) {
        std::cmp::Ordering::Greater => ConflictState::TheirsNewer,
        std::cmp::Ordering::Less => ConflictState::YoursNewer,
        std::cmp::Ordering::Equal => ConflictState::UnknownAge,
    }
}

/// One `ItemPlan` per selected item. Nothing is written and nothing in the staging tree is read except fonts, whose
/// conflict key is their bytes.
pub fn plan_conflicts(
    root: &Path,
    staged: &StagedPack,
    selection: &PackSelection,
) -> Result<ImportPlan, PackError> {
    let contents = &staged.manifest.contents;
    let mut items = Vec::new();

    for project in &contents.projects {
        if picked(&selection.projects, &project.base.slug) {
            items.push(plan_item(root, ItemKind::Project, &project.base)?);
        }
    }
    for theme in &contents.themes {
        if picked(&selection.themes, &theme.base.slug) {
            items.push(plan_item(root, ItemKind::Theme, &theme.base)?);
        }
    }

    let fonts: Vec<PackFont> = contents
        .fonts
        .iter()
        .filter(|f| picked(&selection.fonts, &f.key()) || picked(&selection.fonts, &f.base.slug))
        .cloned()
        .collect();
    items.extend(plan_fonts(root, staged, &fonts)?);

    for object in &contents.objects {
        if picked(&selection.objects, &object.base.slug) {
            items.push(plan_item(root, ItemKind::Object, &object.base)?);
        }
    }
    for gradient in &contents.gradients {
        if picked(&selection.gradients, &gradient.base.slug) {
            items.push(plan_item(root, ItemKind::Gradient, &gradient.base)?);
        }
    }
    for preset in &contents.export_presets {
        if picked(&selection.export_presets, &preset.base.slug) {
            items.push(plan_item(root, ItemKind::ExportPreset, &preset.base)?);
        }
    }
    for shot in &contents.screenshots {
        if picked(&selection.screenshots, &shot.base.slug) {
            items.push(plan_item(root, ItemKind::Screenshot, &shot.base)?);
        }
    }

    Ok(ImportPlan { items })
}

fn picked(list: &[String], key: &str) -> bool {
    list.iter().any(|entry| entry == key)
}

fn plan_item(root: &Path, kind: ItemKind, base: &PackItemBase) -> Result<ItemPlan, PackError> {
    let target = workspace_target(root, kind, &base.slug)?;
    let (state, local, keep_both) = if target.exists() {
        let scanned = if target.is_dir_item() {
            scan_dir(&target.path)?
        } else {
            scan_file(&target.path)?
        };
        let state = compare(&base.content_hash, &base.modified_at, &scanned);
        let local = LocalItem {
            name: local_name(kind, &target.path, &base.slug),
            modified_at: stamp_or_empty(scanned.modified_at),
            bytes: scanned.bytes,
        };
        (state, Some(local), keep_both_slug(root, kind, &base.slug))
    } else {
        (ConflictState::New, None, None)
    };

    let default_resolution = state.default_resolution(kind);
    Ok(ItemPlan {
        kind,
        slug: base.slug.clone(),
        name: base.name.clone(),
        state,
        default_resolution,
        resolution: default_resolution,
        local,
        keep_both_slug: keep_both,
    })
}

/// Fonts are keyed by (family, weight) and merged into `fonts.json`, so `fonts.rs` owns their comparison outright.
fn plan_fonts(
    root: &Path,
    staged: &StagedPack,
    fonts: &[PackFont],
) -> Result<Vec<ItemPlan>, PackError> {
    if fonts.is_empty() {
        return Ok(Vec::new());
    }
    let fonts_dir = root.join(ItemKind::Font.workspace_dir().unwrap_or("fonts"));
    let conflicts = plan_font_merge(&fonts_dir, &staged.root, fonts)?;

    Ok(conflicts
        .into_iter()
        .map(|conflict| {
            let name = format!("{} {}", conflict.family, conflict.weight);
            let local = conflict.existing_file.as_ref().map(|file| {
                let meta = std::fs::metadata(fonts_dir.join(file)).ok();
                LocalItem {
                    name: name.clone(),
                    modified_at: meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .map(stamp_or_empty)
                        .unwrap_or_default(),
                    bytes: meta.map(|m| m.len()).unwrap_or(0),
                }
            });
            ItemPlan {
                kind: ItemKind::Font,
                slug: conflict.key,
                name,
                state: conflict.state,
                default_resolution: conflict.resolution,
                resolution: conflict.resolution,
                local,
                keep_both_slug: None,
            }
        })
        .collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pack::model::{
        PackContents, PackManifest, PackMeta, PackObject, PackProject, PackPublisher,
        PackScreenshot, PackSimpleItem, PackTheme, PackTotals,
    };
    use std::sync::atomic::{AtomicU32, Ordering};

    pub(crate) const FUTURE: &str = "2099-01-01T00:00:00Z";
    pub(crate) const PAST: &str = "2000-01-01T00:00:00Z";

    pub(crate) fn scratch(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-pack-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    pub(crate) fn manifest(contents: PackContents) -> PackManifest {
        PackManifest {
            format: super::super::model::PACK_FORMAT.into(),
            format_version: 1,
            app_version: "0.7.0".into(),
            min_app_version: "0.7.0".into(),
            pack: PackMeta {
                name: "Acme Brand Kit".into(),
                description: None,
                created_at: FUTURE.into(),
            },
            publisher: PackPublisher {
                name: "Acme".into(),
                organisation: None,
                website: None,
                device: "Test".into(),
                public_key: "ed25519:AAAA".into(),
                key_id: "0011223344556677".into(),
            },
            contents,
            files: Vec::new(),
            totals: PackTotals { files: 0, bytes: 0 },
        }
    }

    pub(crate) fn staged_pack(root: PathBuf, contents: PackContents) -> StagedPack {
        StagedPack {
            root,
            manifest: manifest(contents),
        }
    }

    pub(crate) fn payload(staging: &Path, kind: ItemKind) -> PathBuf {
        staging.join("payload").join(kind.payload_dir())
    }

    /// A staged directory item plus the manifest entry describing it, hashed the way the recipient will hash its own.
    pub(crate) fn stage_dir_item(
        staging: &Path,
        kind: ItemKind,
        slug: &str,
        files: &[(&str, &str)],
        modified_at: &str,
    ) -> PackItemBase {
        let dir = payload(staging, kind).join(slug);
        for (rel, body) in files {
            write(&dir.join(rel), body);
        }
        let scanned = scan_dir(&dir).unwrap();
        PackItemBase {
            slug: slug.into(),
            name: format!("{slug} (theirs)"),
            bytes: scanned.bytes,
            modified_at: modified_at.into(),
            content_hash: scanned.content_hash,
        }
    }

    pub(crate) fn stage_file_item(
        staging: &Path,
        kind: ItemKind,
        slug: &str,
        body: &str,
        modified_at: &str,
    ) -> PackItemBase {
        let name = if kind == ItemKind::Screenshot {
            slug.to_owned()
        } else {
            format!("{slug}.json")
        };
        let file = payload(staging, kind).join(&name);
        write(&file, body);
        let scanned = scan_file(&file).unwrap();
        PackItemBase {
            slug: slug.into(),
            name: format!("{slug} (theirs)"),
            bytes: scanned.bytes,
            modified_at: modified_at.into(),
            content_hash: scanned.content_hash,
        }
    }

    pub(crate) fn put_local(root: &Path, kind: ItemKind, slug: &str, body: &str) {
        let target = workspace_target(root, kind, slug).unwrap();
        match kind {
            ItemKind::Project => write(&target.path.join("project.json"), body),
            ItemKind::Theme => write(&target.path.join("theme.json"), body),
            ItemKind::Object => write(&target.path.join("object.json"), body),
            _ => write(&target.path, body),
        }
    }

    fn marker_file(kind: ItemKind) -> &'static str {
        match kind {
            ItemKind::Project => "project.json",
            ItemKind::Theme => "theme.json",
            _ => "object.json",
        }
    }

    fn selection_of(kind: ItemKind, slugs: &[&str]) -> PackSelection {
        let list: Vec<String> = slugs.iter().map(|s| (*s).to_owned()).collect();
        let mut selection = PackSelection::default();
        match kind {
            ItemKind::Project => selection.projects = list,
            ItemKind::Theme => selection.themes = list,
            ItemKind::Font => selection.fonts = list,
            ItemKind::Object => selection.objects = list,
            ItemKind::Gradient => selection.gradients = list,
            ItemKind::ExportPreset => selection.export_presets = list,
            ItemKind::Screenshot => selection.screenshots = list,
        }
        selection
    }

    fn contents_for(kind: ItemKind, bases: Vec<PackItemBase>) -> PackContents {
        let mut contents = PackContents::default();
        match kind {
            ItemKind::Project => {
                contents.projects = bases
                    .into_iter()
                    .map(|base| PackProject {
                        root: format!("payload/projects/{}", base.slug),
                        base,
                        manifest_version: 2,
                        scene_count: 1,
                        scene_files: vec!["scenes/01-hero.tsx".into()],
                        duration_ms: 2000,
                        formats: vec!["16:9".into()],
                        theme_id: "ws:acme-dark".into(),
                        requires: Default::default(),
                        has_scene_code: true,
                    })
                    .collect()
            }
            ItemKind::Theme => {
                contents.themes = bases
                    .into_iter()
                    .map(|base| PackTheme {
                        base,
                        mode: "dark".into(),
                        doc_version: 2,
                        swatches: Vec::new(),
                        requires: Default::default(),
                    })
                    .collect()
            }
            ItemKind::Object => {
                contents.objects = bases
                    .into_iter()
                    .map(|base| PackObject {
                        base,
                        glb: String::new(),
                        thumbnail: None,
                        licence: None,
                        tags: Vec::new(),
                    })
                    .collect()
            }
            ItemKind::Gradient => {
                contents.gradients = bases
                    .into_iter()
                    .map(|base| PackSimpleItem { base })
                    .collect()
            }
            ItemKind::ExportPreset => {
                contents.export_presets = bases
                    .into_iter()
                    .map(|base| PackSimpleItem { base })
                    .collect()
            }
            ItemKind::Screenshot => {
                contents.screenshots = bases
                    .into_iter()
                    .map(|base| PackScreenshot {
                        file: format!("payload/screenshots/{}", base.slug),
                        base,
                        width: None,
                        height: None,
                    })
                    .collect()
            }
            ItemKind::Font => {}
        }
        contents
    }

    /// Every state for every slug-keyed kind, against the table in `model.rs`.
    #[test]
    fn every_state_takes_its_documented_default() {
        for kind in [
            ItemKind::Project,
            ItemKind::Theme,
            ItemKind::Object,
            ItemKind::Gradient,
            ItemKind::ExportPreset,
            ItemKind::Screenshot,
        ] {
            let root = scratch("plan-root");
            let staging = scratch("plan-staging");
            let dir_shaped = matches!(kind, ItemKind::Project | ItemKind::Theme | ItemKind::Object);
            let ext = if kind == ItemKind::Screenshot {
                ".png"
            } else {
                ""
            };

            let cases = [
                ("fresh", ConflictState::New, "", ""),
                ("same", ConflictState::Identical, "same bytes", "same bytes"),
                ("theirs", ConflictState::TheirsNewer, "theirs", "yours"),
                ("yours", ConflictState::YoursNewer, "theirs", "yours"),
                ("aged", ConflictState::UnknownAge, "theirs", "yours"),
            ];

            let mut bases = Vec::new();
            let mut slugs = Vec::new();
            for (stem, state, theirs, ours) in cases {
                let slug = format!("{stem}{ext}");
                let stamp = match state {
                    ConflictState::TheirsNewer => FUTURE,
                    ConflictState::YoursNewer => PAST,
                    ConflictState::UnknownAge => "",
                    _ => FUTURE,
                };
                let base = if dir_shaped {
                    stage_dir_item(&staging, kind, &slug, &[(marker_file(kind), theirs)], stamp)
                } else {
                    stage_file_item(&staging, kind, &slug, theirs, stamp)
                };
                if state != ConflictState::New {
                    put_local(&root, kind, &slug, ours);
                }
                bases.push(base);
                slugs.push(slug);
            }

            let picks: Vec<&str> = slugs.iter().map(String::as_str).collect();
            let staged = staged_pack(staging.clone(), contents_for(kind, bases));
            let plan = plan_conflicts(&root, &staged, &selection_of(kind, &picks)).unwrap();

            assert_eq!(plan.items.len(), 5, "{kind:?}");
            for (item, (_, expected, _, _)) in plan.items.iter().zip(cases) {
                assert_eq!(item.state, expected, "{kind:?} {}", item.slug);
                assert_eq!(
                    item.default_resolution,
                    expected.default_resolution(kind),
                    "{kind:?} {}",
                    item.slug
                );
                assert_eq!(item.resolution, item.default_resolution);
            }

            // The first override: a screenshots folder is a bag, not a namespace, so a clash costs nothing to keep.
            if kind == ItemKind::Screenshot {
                assert_eq!(plan.items[0].resolution, Resolution::Replace);
                for item in &plan.items[1..] {
                    assert_eq!(item.resolution, Resolution::KeepBoth, "{}", item.slug);
                }
            } else {
                assert_eq!(plan.items[0].resolution, Resolution::Replace);
                assert_eq!(plan.items[1].resolution, Resolution::Skip);
                assert_eq!(plan.items[2].resolution, Resolution::Replace);
                assert_eq!(plan.items[3].resolution, Resolution::Skip);
                assert_eq!(plan.items[4].resolution, Resolution::Skip);
            }

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// The incumbent bytes are the recipient's determinism contract, so a font mismatch never replaces by default.
    #[test]
    fn a_font_byte_mismatch_defaults_to_skip() {
        let root = scratch("font-root");
        let staging = scratch("font-staging");
        let fonts_dir = root.join("fonts");
        std::fs::create_dir_all(&fonts_dir).unwrap();
        std::fs::write(fonts_dir.join("AcmeSans-700.ttf"), "incumbent bytes").unwrap();
        crate::fonts::save_manifest(
            &fonts_dir,
            &crate::fonts::FontsManifest {
                version: 1,
                fonts: vec![crate::fonts::PinnedFont {
                    family: "Acme Sans".into(),
                    weight: 700,
                    postscript: "AcmeSans-Bold".into(),
                    file: "AcmeSans-700.ttf".into(),
                    instanced: None,
                    path: String::new(),
                }],
            },
        )
        .unwrap();

        let rel = "payload/fonts/AcmeSans-700.ttf";
        write(&staging.join(rel), "quite different bytes");
        let contents = PackContents {
            fonts: vec![PackFont {
                base: PackItemBase {
                    slug: "Acme Sans@700".into(),
                    name: "Acme Sans".into(),
                    bytes: 21,
                    // Newer than the incumbent, which would replace for any other kind.
                    modified_at: FUTURE.into(),
                    content_hash: super::super::hash::sha256_bytes(b"quite different bytes"),
                },
                family: "Acme Sans".into(),
                weight: 700,
                postscript: "AcmeSans-Bold".into(),
                file: Some(rel.into()),
                sha256: Some(super::super::hash::sha256_bytes(b"quite different bytes")),
                instanced: None,
                embedding: super::super::model::FontEmbedding::Installable,
                reference_only: None,
            }],
            ..Default::default()
        };

        let staged = staged_pack(staging.clone(), contents);
        let plan = plan_conflicts(
            &root,
            &staged,
            &selection_of(ItemKind::Font, &["Acme Sans@700"]),
        )
        .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].slug, "Acme Sans@700");
        assert_eq!(plan.items[0].state, ConflictState::TheirsNewer);
        assert_eq!(plan.items[0].default_resolution, Resolution::Skip);
        assert!(plan.items[0].keep_both_slug.is_none());
        assert!(plan.items[0].local.is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keep_both_walks_past_existing_suffixes() {
        let root = scratch("keep-both");
        for slug in ["acme-dark", "acme-dark-2", "acme-dark-3"] {
            put_local(&root, ItemKind::Theme, slug, "{}");
        }
        assert_eq!(
            keep_both_slug(&root, ItemKind::Theme, "acme-dark").as_deref(),
            Some("acme-dark-4")
        );

        for name in ["hero.png", "hero-2.png"] {
            put_local(&root, ItemKind::Screenshot, name, "png");
        }
        assert_eq!(
            keep_both_slug(&root, ItemKind::Screenshot, "hero.png").as_deref(),
            Some("hero-3.png")
        );
        assert!(keep_both_slug(&root, ItemKind::Font, "Acme Sans@700").is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hostile_slug_never_resolves_to_a_path() {
        let root = scratch("hostile");
        for slug in ["../evil", "..", "", ".hidden", "a/b"] {
            assert!(
                workspace_target(&root, ItemKind::Theme, slug).is_err(),
                "{slug}"
            );
        }
        assert!(workspace_target(&root, ItemKind::Project, "themes").is_err());
        assert!(workspace_target(&root, ItemKind::Screenshot, "../evil.png").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unselected_item_never_reaches_the_plan() {
        let root = scratch("selection");
        let staging = scratch("selection-staging");
        let wanted = stage_file_item(&staging, ItemKind::Gradient, "dawn", "{}", FUTURE);
        let ignored = stage_file_item(&staging, ItemKind::Gradient, "dusk", "{}", FUTURE);
        let staged = staged_pack(
            staging.clone(),
            contents_for(ItemKind::Gradient, vec![wanted, ignored]),
        );
        let plan =
            plan_conflicts(&root, &staged, &selection_of(ItemKind::Gradient, &["dawn"])).unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].slug, "dawn");
        let _ = std::fs::remove_dir_all(&root);
    }
}
