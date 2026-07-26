//! The export dependency closure: what a selection actually needs, walked transitively from the workspace on disk.
//!
//! Read-only by construction (never `require_root`, which asserts layout): a plan is safe to recompute on every
//! checkbox change. Unresolvable references are warnings, never errors, so a project that lost an object still
//! exports with the gap named rather than becoming unexportable.

use super::error::PackError;
use super::fonts::{collect_pack_fonts, is_bundled_family};
use super::hash::{content_hash, sha256_file};
use super::model::{
    ItemKind, PackContents, PackFile, PackFont, PackItemBase, PackObject, PackProject,
    PackRequires, PackScreenshot, PackSimpleItem, PackTheme, PackTotals,
};
use super::paths::validate_archive_path;
use super::scan::rfc3339;
use super::write::PackEntry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Flattened edit renders: large, regenerable from the edit document, so they get their own review group.
const FLATTENED_SUFFIX: &str = "-edited.mp4";

const MANIFEST_FILENAME: &str = "project.json";

// - Selection ------------------------------------------------------------------

fn yes() -> bool {
    true
}

/// What the export window ticked. Slugs only: the closure re-resolves every path server side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSelection {
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub themes: Vec<String>,
    /// `"<family>@<weight>"`, the pack font key.
    #[serde(default)]
    pub fonts: Vec<String>,
    #[serde(default)]
    pub objects: Vec<String>,
    #[serde(default)]
    pub gradients: Vec<String>,
    #[serde(default)]
    pub export_presets: Vec<String>,
    /// File names inside `<root>/screenshots/`.
    #[serde(default)]
    pub screenshots: Vec<String>,
    /// Pulled-in dependencies the user unticked, as `<kind>:<key>`; an explicit pick always wins.
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default = "yes")]
    pub include_flattened_renders: bool,
    #[serde(default = "yes")]
    pub include_unreferenced_assets: bool,
}

impl Default for PackSelection {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            themes: Vec::new(),
            fonts: Vec::new(),
            objects: Vec::new(),
            gradients: Vec::new(),
            export_presets: Vec::new(),
            screenshots: Vec::new(),
            exclude: Vec::new(),
            include_flattened_renders: true,
            include_unreferenced_assets: true,
        }
    }
}

impl PackSelection {
    fn picked(&self, kind: ItemKind, key: &str) -> bool {
        let list = match kind {
            ItemKind::Project => &self.projects,
            ItemKind::Theme => &self.themes,
            ItemKind::Font => &self.fonts,
            ItemKind::Object => &self.objects,
            ItemKind::Gradient => &self.gradients,
            ItemKind::ExportPreset => &self.export_presets,
            ItemKind::Screenshot => &self.screenshots,
        };
        list.iter().any(|k| k == key)
    }
}

/// The `<kind>` half of an item key; also what `exclude` entries are built from.
pub fn kind_tag(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Project => "project",
        ItemKind::Theme => "theme",
        ItemKind::Font => "font",
        ItemKind::Object => "object",
        ItemKind::Gradient => "gradient",
        ItemKind::ExportPreset => "exportPreset",
        ItemKind::Screenshot => "screenshot",
    }
}

pub fn item_key(kind: ItemKind, key: &str) -> String {
    format!("{}:{}", kind_tag(kind), key)
}

// - Results --------------------------------------------------------------------

/// One payload entry: where it lands in the archive, where it comes from, and what it already hashed to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureFile {
    pub archive_path: String,
    #[serde(skip)]
    pub source: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

/// Which review group an asset falls into. Both are reported and both default to travelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetGroup {
    /// `media_references()` found nothing pointing at it.
    Unreferenced,
    /// An `assets/*-edited.mp4` flattened render, listed even when referenced.
    FlattenedRender,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedAsset {
    pub project: String,
    /// Project-relative, e.g. `assets/old-take.mp4`.
    pub rel: String,
    pub bytes: u64,
    pub group: AssetGroup,
    pub included: bool,
}

/// Every gap the closure found. None of these stop an export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum ClosureWarning {
    MissingProject { slug: String },
    MissingTheme { slug: String, required_by: String },
    MissingObject { slug: String, required_by: String },
    MissingGradient { slug: String, required_by: String },
    MissingScreenshot { name: String },
    MissingExportPreset { slug: String },
    /// A referenced family/weight is not pinned in `<root>/fonts/`, so its bytes cannot travel.
    UnpinnedFont { key: String, required_by: String },
    /// fsType says the face may not be redistributed: the name travels, the bytes do not.
    FontReferenceOnly { key: String },
    /// A theme wants an environment map no selected project carries.
    MissingEnvironment { path: String, required_by: String },
    /// A `ws:` id that matches no theme and no object.
    UnknownReference { id: String, required_by: String },
    UnreadableDocument { path: String, detail: String },
    /// Dropped because the user unticked it; names what needed it.
    ExcludedDependency { key: String, required_by: Vec<String> },
    /// Present on disk but not packable (wrong extension, a symlink, an unreadable file).
    FileSkipped { path: String, reason: String },
}

impl ClosureWarning {
    /// The one-line the review list shows.
    pub fn message(&self) -> String {
        match self {
            Self::MissingProject { slug } => format!("No project named \"{slug}\"."),
            Self::MissingTheme { slug, required_by } => {
                format!("{required_by} uses the theme \"{slug}\", which is not in your workspace.")
            }
            Self::MissingObject { slug, required_by } => {
                format!("{required_by} uses the object \"{slug}\", which is not in your workspace.")
            }
            Self::MissingGradient { slug, required_by } => {
                format!("{required_by} uses the gradient \"{slug}\", which is not saved.")
            }
            Self::MissingScreenshot { name } => format!("No screenshot named \"{name}\"."),
            Self::MissingExportPreset { slug } => format!("No export preset named \"{slug}\"."),
            Self::UnpinnedFont { key, required_by } => {
                format!("{required_by} uses {key}, which is not pinned, so it cannot travel.")
            }
            Self::FontReferenceOnly { key } => {
                format!("{key} does not allow redistribution: its name travels, its file does not.")
            }
            Self::MissingEnvironment { path, required_by } => {
                format!("{required_by} lights with \"{path}\", which no selected project carries.")
            }
            Self::UnknownReference { id, required_by } => {
                format!("{required_by} references \"ws:{id}\", which is nothing in your workspace.")
            }
            Self::UnreadableDocument { path, detail } => format!("{path} could not be read: {detail}"),
            Self::ExcludedDependency { key, required_by } => {
                format!("{key} is left out, so {} may not render as authored.", required_by.join(", "))
            }
            Self::FileSkipped { path, reason } => format!("{path} was left out: {reason}"),
        }
    }
}

impl std::fmt::Display for ClosureWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// Everything the build command needs, and everything the review screen shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closure {
    pub contents: PackContents,
    /// Sorted by archive path, which is also the order `write_pack` writes them in.
    pub files: Vec<ClosureFile>,
    /// Why each item is here, keyed `<kind>:<key>`; an empty list means the user picked it directly.
    pub required_by: BTreeMap<String, Vec<String>>,
    pub warnings: Vec<ClosureWarning>,
    pub reviewed_assets: Vec<ReviewedAsset>,
    pub totals: PackTotals,
}

impl Closure {
    /// The write-path view: archive path plus source, nothing else.
    pub fn entries(&self) -> Vec<PackEntry> {
        self.files
            .iter()
            .map(|f| PackEntry {
                archive_path: f.archive_path.clone(),
                source: f.source.clone(),
            })
            .collect()
    }

    /// The manifest's `files` block, already hashed.
    pub fn pack_files(&self) -> Vec<PackFile> {
        self.files
            .iter()
            .map(|f| PackFile {
                path: f.archive_path.clone(),
                sha256: f.sha256.clone(),
                bytes: f.bytes,
            })
            .collect()
    }
}

// - Font keys ------------------------------------------------------------------

/// The sidecar/theme grammar (mirrors `parseFontString` in `src/theme/fontRef.ts`): `Family` or `Family@weight`, splitting on the LAST `@`, a bad weight keeping the whole string as the family at 400.
pub fn parse_font_string(value: &str) -> (String, u32) {
    if let Some(at) = value.rfind('@') {
        if at > 0 {
            if let Ok(weight) = value[at + 1..].parse::<f64>() {
                if weight.is_finite() && (1.0..=1000.0).contains(&weight) {
                    return (value[..at].to_owned(), weight as u32);
                }
            }
        }
    }
    (value.to_owned(), 400)
}

/// The pack's font key, which always carries the weight (unlike the sidecar grammar, where 400 is implied).
pub fn font_key(family: &str, weight: u32) -> String {
    format!("{family}@{weight}")
}

fn split_font_key(key: &str) -> Option<(String, u32)> {
    let (family, weight) = key.rsplit_once('@')?;
    Some((family.to_owned(), weight.parse().ok()?))
}

// - Scanning -------------------------------------------------------------------

#[derive(Default)]
struct DocRefs {
    themes: BTreeSet<String>,
    /// Bare slugs from `ws:` ids, classified against the workspace later.
    workspace_ids: BTreeSet<String>,
    /// Raw sidecar font strings, parsed with the `Family@weight` grammar.
    fonts: BTreeSet<String>,
    /// Theme gradient names, resolved against the theme's own `gradients` map first.
    gradients: BTreeSet<String>,
    /// Project-relative `.hdr`/`.exr` sources.
    environments: BTreeSet<String>,
}

fn strip_ws(id: &str) -> Option<&str> {
    id.strip_prefix("ws:").filter(|s| !s.is_empty())
}

/// Walk a parsed document for every reference kind at once: keys carry the meaning, values carry the target.
fn scan_value(value: &Value, key: Option<&str>, out: &mut DocRefs) {
    match value {
        Value::String(s) => {
            match key {
                Some("themeId") => {
                    if let Some(slug) = strip_ws(s) {
                        out.themes.insert(slug.to_owned());
                    }
                }
                // `backdrop`/`background` name a theme gradient; a name the theme does not define is a workspace preset.
                Some("gradient") => {
                    out.gradients.insert(s.clone());
                }
                _ => {
                    if let Some(slug) = strip_ws(s) {
                        out.workspace_ids.insert(slug.to_owned());
                    }
                }
            }
            let lower = s.to_ascii_lowercase();
            if !s.contains(':') && (lower.ends_with(".hdr") || lower.ends_with(".exr")) {
                out.environments.insert(s.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                scan_value(item, key, out);
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                if k == "textStyle" {
                    scan_text_style(v, out);
                    continue;
                }
                scan_value(v, Some(k), out);
            }
        }
        _ => {}
    }
}

/// `textStyle.<key>Font` overrides are the second font source, after theme typography.
fn scan_text_style(value: &Value, out: &mut DocRefs) {
    let Some(map) = value.as_object() else { return };
    for (k, v) in map {
        if let (true, Some(s)) = (k.ends_with("Font"), v.as_str()) {
            if !s.is_empty() {
                out.fonts.insert(s.to_owned());
            }
        }
    }
}

/// `ws:<slug>` tokens in TSX source. Deliberately blunt: a false hit resolves to nothing and warns, it never packs the wrong thing.
fn scan_source(text: &str, out: &mut DocRefs) {
    let bytes = text.as_bytes();
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("ws:") {
        let start = cursor + offset;
        let preceded = start > 0 && {
            let b = bytes[start - 1];
            b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
        };
        let mut end = start + 3;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-' || bytes[end] == b'_')
        {
            end += 1;
        }
        if !preceded && end > start + 3 {
            out.workspace_ids.insert(text[start + 3..end].to_owned());
        }
        cursor = end.max(start + 3);
    }
}

// - Files ----------------------------------------------------------------------

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn str_field(doc: &Value, key: &str) -> Option<String> {
    doc.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// One file staged for the archive, carrying the item-relative path the content hash is built from.
struct StagedFile {
    item_rel: String,
    archive_path: String,
    source: PathBuf,
    bytes: u64,
    sha256: String,
    modified: Option<SystemTime>,
}

fn stage_file(item_rel: &str, archive_path: &str, source: &Path) -> Result<StagedFile, PackError> {
    let meta = std::fs::metadata(source)?;
    Ok(StagedFile {
        item_rel: item_rel.to_owned(),
        archive_path: archive_path.to_owned(),
        source: source.to_path_buf(),
        bytes: meta.len(),
        sha256: sha256_file(source)?,
        modified: meta.modified().ok(),
    })
}

fn base_from(slug: &str, name: &str, files: &[StagedFile]) -> PackItemBase {
    let pairs: Vec<(String, String)> = files
        .iter()
        .map(|f| (f.item_rel.clone(), f.sha256.clone()))
        .collect();
    let newest = files
        .iter()
        .filter_map(|f| f.modified)
        .max()
        .unwrap_or(UNIX_EPOCH);
    PackItemBase {
        slug: slug.to_owned(),
        name: name.to_owned(),
        bytes: files.iter().map(|f| f.bytes).sum(),
        modified_at: rfc3339(newest),
        content_hash: content_hash(&pairs),
    }
}

/// Every file under `dir`, item-relative with forward slashes, sorted. Dot-prefixed names are skipped: they are caches, VCS or editor state, never payload.
fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<_> = entries.flatten().collect();
    names.sort_by_key(std::fs::DirEntry::file_name);
    for entry in names {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            walk(&path, &rel, out);
        } else {
            out.push((rel, path));
        }
    }
}

/// The pack build exclusions (`02-data-model.md`), extending `duplicate_project`'s skip list. Shares `scan::is_excluded` with the import side, so an item exported and re-scanned hashes equal. `CLAUDE.md` and `.claude/settings.json` ride along: both are only written when missing, and users edit them.
fn project_file_excluded(rel: &str) -> bool {
    super::scan::is_excluded(rel)
}

/// The dot-named entries a project carries that are still payload; `walk` skips dotted names, so these are re-added by hand.
fn project_dot_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let settings = dir.join(".claude").join("settings.json");
    if settings.is_file() {
        vec![(".claude/settings.json".to_owned(), settings)]
    } else {
        Vec::new()
    }
}

// - The resolver ---------------------------------------------------------------

struct Resolver<'a> {
    root: &'a Path,
    selection: &'a PackSelection,
    queue: Vec<(ItemKind, String, Option<String>)>,
    seen: BTreeSet<String>,
    required_by: BTreeMap<String, Vec<String>>,
    warnings: Vec<ClosureWarning>,
    projects: BTreeSet<String>,
    themes: BTreeSet<String>,
    fonts: BTreeSet<String>,
    objects: BTreeSet<String>,
    gradients: BTreeSet<String>,
    export_presets: BTreeSet<String>,
    screenshots: BTreeSet<String>,
    project_requires: BTreeMap<String, PackRequires>,
    theme_requires: BTreeMap<String, PackRequires>,
    environments: Vec<(String, String)>,
}

impl<'a> Resolver<'a> {
    fn new(root: &'a Path, selection: &'a PackSelection) -> Self {
        Self {
            root,
            selection,
            queue: Vec::new(),
            seen: BTreeSet::new(),
            required_by: BTreeMap::new(),
            warnings: Vec::new(),
            projects: BTreeSet::new(),
            themes: BTreeSet::new(),
            fonts: BTreeSet::new(),
            objects: BTreeSet::new(),
            gradients: BTreeSet::new(),
            export_presets: BTreeSet::new(),
            screenshots: BTreeSet::new(),
            project_requires: BTreeMap::new(),
            theme_requires: BTreeMap::new(),
            environments: Vec::new(),
        }
    }

    fn dir(&self, kind: ItemKind) -> PathBuf {
        match kind.workspace_dir() {
            Some(name) => self.root.join(name),
            None => self.root.to_path_buf(),
        }
    }

    fn require(&mut self, kind: ItemKind, key: &str, by: Option<&str>) {
        let key = key.trim();
        if key.is_empty() {
            return;
        }
        let id = item_key(kind, key);
        if self.selection.exclude.iter().any(|e| e == &id) && !self.selection.picked(kind, key) {
            if let Some(by) = by {
                self.note_exclusion(&id, by);
            }
            return;
        }
        let entry = self.required_by.entry(id.clone()).or_default();
        if let Some(by) = by {
            entry.push(by.to_owned());
        }
        if self.seen.insert(id) {
            self.queue.push((kind, key.to_owned(), by.map(str::to_owned)));
        }
    }

    fn note_exclusion(&mut self, id: &str, by: &str) {
        for warning in &mut self.warnings {
            if let ClosureWarning::ExcludedDependency { key, required_by } = warning {
                if key == id {
                    required_by.push(by.to_owned());
                    return;
                }
            }
        }
        self.warnings.push(ClosureWarning::ExcludedDependency {
            key: id.to_owned(),
            required_by: vec![by.to_owned()],
        });
    }

    fn run(&mut self) {
        for slug in &self.selection.projects.clone() {
            self.require(ItemKind::Project, slug, None);
        }
        for slug in &self.selection.themes.clone() {
            self.require(ItemKind::Theme, slug, None);
        }
        for key in &self.selection.fonts.clone() {
            self.require(ItemKind::Font, key, None);
        }
        for slug in &self.selection.objects.clone() {
            self.require(ItemKind::Object, slug, None);
        }
        for slug in &self.selection.gradients.clone() {
            self.require(ItemKind::Gradient, slug, None);
        }
        for slug in &self.selection.export_presets.clone() {
            self.require(ItemKind::ExportPreset, slug, None);
        }
        for name in &self.selection.screenshots.clone() {
            self.require(ItemKind::Screenshot, name, None);
        }

        while let Some((kind, key, _)) = self.queue.pop() {
            match kind {
                ItemKind::Project => self.visit_project(&key),
                ItemKind::Theme => self.visit_theme(&key),
                ItemKind::Font => self.visit_font(&key),
                ItemKind::Object => self.visit_object(&key),
                ItemKind::Gradient => self.visit_gradient(&key),
                ItemKind::ExportPreset => self.visit_export_preset(&key),
                ItemKind::Screenshot => self.visit_screenshot(&key),
            }
        }
        self.check_environments();
    }

    fn visit_project(&mut self, slug: &str) {
        let dir = self.root.join(slug);
        if !dir.join(MANIFEST_FILENAME).is_file() {
            self.warnings.push(ClosureWarning::MissingProject {
                slug: slug.to_owned(),
            });
            return;
        }
        self.projects.insert(slug.to_owned());
        let label = item_key(ItemKind::Project, slug);
        let mut refs = DocRefs::default();

        match read_json(&dir.join(MANIFEST_FILENAME)) {
            Ok(doc) => scan_value(&doc, None, &mut refs),
            Err(detail) => self.warnings.push(ClosureWarning::UnreadableDocument {
                path: format!("{slug}/{MANIFEST_FILENAME}"),
                detail,
            }),
        }

        let mut scene_files: Vec<(String, PathBuf)> = Vec::new();
        walk(&dir.join("scenes"), "", &mut scene_files);
        for (name, path) in scene_files {
            if name.ends_with(".json") {
                match read_json(&path) {
                    Ok(doc) => scan_value(&doc, None, &mut refs),
                    Err(detail) => self.warnings.push(ClosureWarning::UnreadableDocument {
                        path: format!("{slug}/scenes/{name}"),
                        detail,
                    }),
                }
            } else if name.ends_with(".tsx") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    scan_source(&text, &mut refs);
                }
            }
        }

        let mut requires = PackRequires::default();
        for theme in refs.themes.clone() {
            requires.themes.push(theme.clone());
            self.require(ItemKind::Theme, &theme, Some(&label));
        }
        for id in refs.workspace_ids.clone() {
            if refs.themes.contains(&id) {
                continue;
            }
            if self.dir(ItemKind::Object).join(&id).join("object.json").is_file() {
                requires.objects.push(id.clone());
                self.require(ItemKind::Object, &id, Some(&label));
            } else if self.dir(ItemKind::Theme).join(&id).join("theme.json").is_file() {
                requires.themes.push(id.clone());
                self.require(ItemKind::Theme, &id, Some(&label));
            } else {
                self.warnings.push(ClosureWarning::UnknownReference {
                    id: id.clone(),
                    required_by: label.clone(),
                });
            }
        }
        for raw in refs.fonts.clone() {
            let (family, weight) = parse_font_string(&raw);
            if is_bundled_family(&family) {
                continue;
            }
            let key = font_key(&family, weight);
            requires.fonts.push(key.clone());
            self.require(ItemKind::Font, &key, Some(&label));
        }
        requires.themes.sort();
        requires.themes.dedup();
        requires.objects.sort();
        requires.fonts.sort();
        requires.fonts.dedup();
        self.project_requires.insert(slug.to_owned(), requires);
    }

    fn visit_theme(&mut self, slug: &str) {
        let file = self.dir(ItemKind::Theme).join(slug).join("theme.json");
        let doc = match read_json(&file) {
            Ok(doc) => doc,
            Err(detail) => {
                if file.exists() {
                    self.warnings.push(ClosureWarning::UnreadableDocument {
                        path: format!("themes/{slug}/theme.json"),
                        detail,
                    });
                } else {
                    let required_by = self
                        .required_by
                        .get(&item_key(ItemKind::Theme, slug))
                        .and_then(|by| by.first().cloned())
                        .unwrap_or_else(|| "This pack".to_owned());
                    self.warnings.push(ClosureWarning::MissingTheme {
                        slug: slug.to_owned(),
                        required_by,
                    });
                }
                return;
            }
        };
        self.themes.insert(slug.to_owned());
        let label = item_key(ItemKind::Theme, slug);
        let mut requires = PackRequires::default();

        for role in ["headline", "body"] {
            let Some(value) = doc.get("typography").and_then(|t| t.get(role)) else {
                continue;
            };
            let (family, weight) = match value {
                Value::String(s) => parse_font_string(s),
                other => (
                    str_field(other, "family").unwrap_or_default(),
                    other
                        .get("weight")
                        .and_then(Value::as_u64)
                        .unwrap_or(400) as u32,
                ),
            };
            if family.is_empty() || is_bundled_family(&family) {
                continue;
            }
            let key = font_key(&family, weight);
            requires.fonts.push(key.clone());
            self.require(ItemKind::Font, &key, Some(&label));
        }

        let mut refs = DocRefs::default();
        scan_value(&doc, None, &mut refs);
        let own: BTreeSet<String> = doc
            .get("gradients")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        for name in refs.gradients {
            let slug_ref = strip_ws(&name).unwrap_or(&name).to_owned();
            if own.contains(&name) || slug_ref.is_empty() {
                continue;
            }
            if self
                .dir(ItemKind::Gradient)
                .join(format!("{slug_ref}.json"))
                .is_file()
            {
                requires.gradients.push(slug_ref.clone());
                self.require(ItemKind::Gradient, &slug_ref, Some(&label));
            } else {
                self.warnings.push(ClosureWarning::MissingGradient {
                    slug: slug_ref,
                    required_by: label.clone(),
                });
            }
        }
        for source in refs.environments {
            self.environments.push((label.clone(), source));
        }
        for raw in refs.fonts.clone() {
            let (family, weight) = parse_font_string(&raw);
            if is_bundled_family(&family) {
                continue;
            }
            let key = font_key(&family, weight);
            requires.fonts.push(key.clone());
            self.require(ItemKind::Font, &key, Some(&label));
        }
        requires.fonts.sort();
        requires.fonts.dedup();
        requires.gradients.sort();
        requires.gradients.dedup();
        self.theme_requires.insert(slug.to_owned(), requires);
    }

    fn visit_font(&mut self, key: &str) {
        self.fonts.insert(key.to_owned());
    }

    fn visit_object(&mut self, slug: &str) {
        if self
            .dir(ItemKind::Object)
            .join(slug)
            .join("object.json")
            .is_file()
        {
            self.objects.insert(slug.to_owned());
            return;
        }
        let required_by = self
            .required_by
            .get(&item_key(ItemKind::Object, slug))
            .and_then(|by| by.first().cloned())
            .unwrap_or_else(|| "This pack".to_owned());
        self.warnings.push(ClosureWarning::MissingObject {
            slug: slug.to_owned(),
            required_by,
        });
    }

    fn visit_gradient(&mut self, slug: &str) {
        if self
            .dir(ItemKind::Gradient)
            .join(format!("{slug}.json"))
            .is_file()
        {
            self.gradients.insert(slug.to_owned());
            return;
        }
        let required_by = self
            .required_by
            .get(&item_key(ItemKind::Gradient, slug))
            .and_then(|by| by.first().cloned())
            .unwrap_or_else(|| "This pack".to_owned());
        self.warnings.push(ClosureWarning::MissingGradient {
            slug: slug.to_owned(),
            required_by,
        });
    }

    fn visit_export_preset(&mut self, slug: &str) {
        if self
            .dir(ItemKind::ExportPreset)
            .join(format!("{slug}.json"))
            .is_file()
        {
            self.export_presets.insert(slug.to_owned());
        } else {
            self.warnings.push(ClosureWarning::MissingExportPreset {
                slug: slug.to_owned(),
            });
        }
    }

    fn visit_screenshot(&mut self, name: &str) {
        if self.dir(ItemKind::Screenshot).join(name).is_file() {
            self.screenshots.insert(name.to_owned());
        } else {
            self.warnings.push(ClosureWarning::MissingScreenshot {
                name: name.to_owned(),
            });
        }
    }

    /// A theme's environment map lives in a PROJECT's assets, so it only travels when a selected project carries it.
    fn check_environments(&mut self) {
        let environments = std::mem::take(&mut self.environments);
        for (label, source) in environments {
            let carried = self
                .projects
                .iter()
                .any(|slug| self.root.join(slug).join(&source).is_file());
            if !carried {
                self.warnings.push(ClosureWarning::MissingEnvironment {
                    path: source,
                    required_by: label,
                });
            }
        }
    }
}

// - Building -------------------------------------------------------------------

fn archive_path(kind: ItemKind, tail: &str) -> String {
    format!("payload/{}/{}", kind.payload_dir(), tail)
}

/// The last gate before a file becomes payload: anything the reader would refuse never goes in.
fn accept(path: &str, warnings: &mut Vec<ClosureWarning>) -> bool {
    match validate_archive_path(path) {
        Ok(_) => true,
        Err(e) => {
            warnings.push(ClosureWarning::FileSkipped {
                path: path.to_owned(),
                reason: e.variant().to_owned(),
            });
            false
        }
    }
}

fn stage_all(
    files: Vec<(String, String, PathBuf)>,
    warnings: &mut Vec<ClosureWarning>,
) -> Vec<StagedFile> {
    let mut staged = Vec::new();
    for (item_rel, archive, source) in files {
        if !accept(&archive, warnings) {
            continue;
        }
        if std::fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_symlink()) {
            warnings.push(ClosureWarning::FileSkipped {
                path: archive,
                reason: "symlink".to_owned(),
            });
            continue;
        }
        match stage_file(&item_rel, &archive, &source) {
            Ok(file) => staged.push(file),
            Err(e) => warnings.push(ClosureWarning::FileSkipped {
                path: archive,
                reason: e.variant().to_owned(),
            }),
        }
    }
    staged
}

/// Resolve a selection into everything a pack needs: contents, the flat file list, and every gap found on the way.
pub fn resolve_closure(root: &Path, selection: &PackSelection) -> Result<Closure, PackError> {
    if !root.is_dir() {
        return Err(PackError::NoWorkspace);
    }
    let mut resolver = Resolver::new(root, selection);
    resolver.run();

    let mut contents = PackContents::default();
    let mut files: Vec<ClosureFile> = Vec::new();
    let mut reviewed: Vec<ReviewedAsset> = Vec::new();
    let mut warnings = std::mem::take(&mut resolver.warnings);

    for slug in resolver.projects.clone() {
        let (project, staged, mut assets) =
            build_project(root, &slug, &resolver, selection, &mut warnings);
        contents.projects.push(project);
        push_files(&mut files, staged);
        reviewed.append(&mut assets);
    }
    for slug in resolver.themes.clone() {
        let (theme, staged) = build_theme(root, &slug, &resolver, &mut warnings);
        contents.themes.push(theme);
        push_files(&mut files, staged);
    }
    let (fonts, staged) = build_fonts(
        root,
        &resolver.fonts.clone(),
        &resolver.required_by,
        &mut warnings,
    )?;
    contents.fonts = fonts;
    push_files(&mut files, staged);
    for slug in resolver.objects.clone() {
        let (object, staged) = build_object(root, &slug, &mut warnings);
        contents.objects.push(object);
        push_files(&mut files, staged);
    }
    for slug in resolver.gradients.clone() {
        let (item, staged) = build_flat(root, ItemKind::Gradient, &slug, &mut warnings);
        contents.gradients.push(item);
        push_files(&mut files, staged);
    }
    for slug in resolver.export_presets.clone() {
        let (item, staged) = build_flat(root, ItemKind::ExportPreset, &slug, &mut warnings);
        contents.export_presets.push(item);
        push_files(&mut files, staged);
    }
    for name in resolver.screenshots.clone() {
        if let Some((shot, staged)) = build_screenshot(root, &name, &mut warnings) {
            contents.screenshots.push(shot);
            push_files(&mut files, staged);
        }
    }

    files.sort_by(|a, b| a.archive_path.cmp(&b.archive_path));
    let mut required_by = std::mem::take(&mut resolver.required_by);
    for list in required_by.values_mut() {
        list.sort();
        list.dedup();
    }
    let totals = PackTotals {
        files: files.len(),
        bytes: files.iter().map(|f| f.bytes).sum(),
    };
    Ok(Closure {
        contents,
        files,
        required_by,
        warnings,
        reviewed_assets: reviewed,
        totals,
    })
}

fn push_files(out: &mut Vec<ClosureFile>, staged: Vec<StagedFile>) {
    out.extend(staged.into_iter().map(|f| ClosureFile {
        archive_path: f.archive_path,
        source: f.source,
        bytes: f.bytes,
        sha256: f.sha256,
    }));
}

fn build_project(
    root: &Path,
    slug: &str,
    resolver: &Resolver<'_>,
    selection: &PackSelection,
    warnings: &mut Vec<ClosureWarning>,
) -> (PackProject, Vec<StagedFile>, Vec<ReviewedAsset>) {
    let dir = root.join(slug);
    let doc = read_json(&dir.join(MANIFEST_FILENAME)).unwrap_or(Value::Null);
    let summary = crate::workspace::manifest_summary(&dir);
    let name = summary
        .as_ref()
        .map(|(n, _)| n.clone())
        .unwrap_or_else(|| slug.to_owned());

    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    walk(&dir, "", &mut candidates);
    candidates.extend(project_dot_files(&dir));
    candidates.retain(|(rel, _)| !project_file_excluded(rel));

    let mut reviewed = Vec::new();
    let mut dropped: BTreeSet<String> = BTreeSet::new();
    for (rel, path) in &candidates {
        if !rel.starts_with("assets/") {
            continue;
        }
        let flattened = rel.ends_with(FLATTENED_SUFFIX);
        let referenced = !crate::media::media_references(&dir, rel).is_empty();
        if !flattened && referenced {
            continue;
        }
        let group = if flattened {
            AssetGroup::FlattenedRender
        } else {
            AssetGroup::Unreferenced
        };
        let included = if flattened {
            selection.include_flattened_renders
        } else {
            selection.include_unreferenced_assets
        };
        if !included {
            dropped.insert(rel.clone());
        }
        reviewed.push(ReviewedAsset {
            project: slug.to_owned(),
            rel: rel.clone(),
            bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            group,
            included,
        });
    }
    candidates.retain(|(rel, _)| !dropped.contains(rel));

    let staged = stage_all(
        candidates
            .into_iter()
            .map(|(rel, path)| {
                let archive = archive_path(ItemKind::Project, &format!("{slug}/{rel}"));
                (rel, archive, path)
            })
            .collect(),
        warnings,
    );

    let scene_files: Vec<String> = doc
        .get("scenes")
        .and_then(Value::as_array)
        .map(|scenes| {
            scenes
                .iter()
                .filter_map(|s| str_field(s, "file"))
                .collect()
        })
        .unwrap_or_default();
    let formats: Vec<String> = doc
        .get("formats")
        .and_then(Value::as_array)
        .map(|f| f.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();

    let project = PackProject {
        base: base_from(slug, &name, &staged),
        root: format!("payload/{}/{slug}", ItemKind::Project.payload_dir()),
        manifest_version: doc.get("version").and_then(Value::as_u64).unwrap_or(1) as u32,
        scene_count: scene_files.len(),
        scene_files,
        duration_ms: summary.map(|(_, d)| d).unwrap_or(0),
        formats,
        theme_id: str_field(&doc, "themeId").unwrap_or_default(),
        requires: resolver
            .project_requires
            .get(slug)
            .cloned()
            .unwrap_or_default(),
        has_scene_code: true,
    };
    (project, staged, reviewed)
}

fn build_theme(
    root: &Path,
    slug: &str,
    resolver: &Resolver<'_>,
    warnings: &mut Vec<ClosureWarning>,
) -> (PackTheme, Vec<StagedFile>) {
    let file = root.join(ItemKind::Theme.workspace_dir().unwrap_or("themes")).join(slug).join("theme.json");
    let doc = read_json(&file).unwrap_or(Value::Null);
    let staged = stage_all(
        vec![(
            "theme.json".to_owned(),
            archive_path(ItemKind::Theme, &format!("{slug}/theme.json")),
            file,
        )],
        warnings,
    );
    let swatches = doc
        .get("colors")
        .map(|c| {
            ["background", "text", "accent", "muted"]
                .iter()
                .filter_map(|k| str_field(c, k))
                .collect()
        })
        .unwrap_or_default();
    let theme = PackTheme {
        base: base_from(
            slug,
            &str_field(&doc, "name").unwrap_or_else(|| slug.to_owned()),
            &staged,
        ),
        mode: str_field(&doc, "mode").unwrap_or_else(|| "dark".to_owned()),
        doc_version: doc.get("version").and_then(Value::as_u64).unwrap_or(1) as u32,
        swatches,
        requires: resolver.theme_requires.get(slug).cloned().unwrap_or_default(),
    };
    (theme, staged)
}

/// Pinned faces for the required keys, through the one font resolver (`pack::fonts`). A key with no pin warns: its bytes are the recipient's determinism contract and cannot be invented.
fn build_fonts(
    root: &Path,
    keys: &BTreeSet<String>,
    required_by: &BTreeMap<String, Vec<String>>,
    warnings: &mut Vec<ClosureWarning>,
) -> Result<(Vec<PackFont>, Vec<StagedFile>), PackError> {
    let dir = root.join(ItemKind::Font.workspace_dir().unwrap_or("fonts"));
    let refs: Vec<crate::fonts::FontRef> = keys
        .iter()
        .filter_map(|key| split_font_key(key))
        .map(|(family, weight)| crate::fonts::FontRef { family, weight })
        .collect();
    let fonts = collect_pack_fonts(&dir, &refs)?;

    let mut staged = Vec::new();
    for font in &fonts {
        if font.is_reference_only() {
            warnings.push(ClosureWarning::FontReferenceOnly { key: font.key() });
            continue;
        }
        let Some(archive) = font.file.clone() else {
            continue;
        };
        let file_name = archive.rsplit('/').next().unwrap_or_default().to_owned();
        let source = dir.join(&file_name);
        staged.append(&mut stage_all(
            vec![(file_name, archive, source)],
            warnings,
        ));
    }
    for key in keys {
        if fonts.iter().any(|f| &f.key() == key) {
            continue;
        }
        warnings.push(ClosureWarning::UnpinnedFont {
            key: key.clone(),
            required_by: required_by
                .get(&item_key(ItemKind::Font, key))
                .and_then(|by| by.first().cloned())
                .unwrap_or_else(|| "This pack".to_owned()),
        });
    }
    Ok((fonts, staged))
}

fn build_object(
    root: &Path,
    slug: &str,
    warnings: &mut Vec<ClosureWarning>,
) -> (PackObject, Vec<StagedFile>) {
    let dir = root
        .join(ItemKind::Object.workspace_dir().unwrap_or("objects"))
        .join(slug);
    let doc = read_json(&dir.join("object.json")).unwrap_or(Value::Null);
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    walk(&dir, "", &mut candidates);
    let staged = stage_all(
        candidates
            .into_iter()
            .map(|(rel, path)| {
                let archive = archive_path(ItemKind::Object, &format!("{slug}/{rel}"));
                (rel, archive, path)
            })
            .collect(),
        warnings,
    );
    let in_archive = |rel: Option<String>| {
        rel.map(|r| archive_path(ItemKind::Object, &format!("{slug}/{r}")))
    };
    let object = PackObject {
        base: base_from(
            slug,
            &str_field(&doc, "name").unwrap_or_else(|| slug.to_owned()),
            &staged,
        ),
        glb: in_archive(str_field(&doc, "glb")).unwrap_or_default(),
        thumbnail: in_archive(str_field(&doc, "thumbnail")),
        licence: doc.get("licence").and_then(|l| str_field(l, "name")),
        tags: doc
            .get("tags")
            .and_then(Value::as_array)
            .map(|t| t.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
    };
    (object, staged)
}

fn build_flat(
    root: &Path,
    kind: ItemKind,
    slug: &str,
    warnings: &mut Vec<ClosureWarning>,
) -> (PackSimpleItem, Vec<StagedFile>) {
    let file = root
        .join(kind.workspace_dir().unwrap_or(""))
        .join(format!("{slug}.json"));
    let doc = read_json(&file).unwrap_or(Value::Null);
    let rel = format!("{slug}.json");
    let staged = stage_all(
        vec![(rel.clone(), archive_path(kind, &rel), file)],
        warnings,
    );
    let item = PackSimpleItem {
        base: base_from(
            slug,
            &str_field(&doc, "name").unwrap_or_else(|| slug.to_owned()),
            &staged,
        ),
    };
    (item, staged)
}

fn build_screenshot(
    root: &Path,
    name: &str,
    warnings: &mut Vec<ClosureWarning>,
) -> Option<(PackScreenshot, Vec<StagedFile>)> {
    let file = root
        .join(ItemKind::Screenshot.workspace_dir().unwrap_or("screenshots"))
        .join(name);
    let staged = stage_all(
        vec![(
            name.to_owned(),
            archive_path(ItemKind::Screenshot, name),
            file,
        )],
        warnings,
    );
    let first = staged.first()?;
    let shot = PackScreenshot {
        base: base_from(name, name, &staged),
        file: first.archive_path.clone(),
        width: None,
        height: None,
    };
    Some((shot, staged))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-deps-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A workspace with one project on a workspace theme, that theme on a pinned font and a saved gradient, plus an object referenced from a sidecar.
    fn fixture(tag: &str) -> PathBuf {
        let root = scratch(tag);
        write(
            &root,
            "acme/project.json",
            r#"{"id":"acme","name":"Acme","version":2,"themeId":"ws:acme-dark","formats":["16:9"],
                "scenes":[{"file":"scenes/01-hero.tsx","durationMs":2000},
                          {"file":"scenes/02-kit.tsx","durationMs":1000,"transition":{"type":"crossfade","durationMs":400}}]}"#,
        );
        write(&root, "acme/scenes/01-hero.tsx", "export default 1;\n");
        write(
            &root,
            "acme/scenes/01-hero.json",
            r##"{"version":1,"text":{"title":"Hi"},"textStyle":{"titleFont":"Avenir Next@600","titleColor":"#fff"}}"##,
        );
        write(&root, "acme/scenes/02-kit.tsx", "export default 2;\n");
        write(
            &root,
            "acme/scenes/02-kit.json",
            r#"{"version":1,"themeId":"ws:acme-light","backdrop":{"type":"object","object":"ws:widget"}}"#,
        );
        write(&root, "acme/assets/hero.png", "png-hero");
        write(&root, "acme/CLAUDE.md", "# Acme\n");
        write(&root, "acme/.claude/settings.json", "{}\n");
        write(&root, "acme/.claude/skills/x/SKILL.md", "skill\n");
        write(&root, "acme/.git/config", "[core]\n");
        write(&root, "acme/exports/render.mp4", "mp4");
        write(&root, "acme/assets/.emoji-cache/1f600.png", "cache");
        write(&root, "acme/edits/_tap_prefs.json", "{}");
        write(&root, "acme/edits/cut.json", r#"{"source":"assets/hero.png"}"#);

        write(
            &root,
            "themes/acme-dark/theme.json",
            r##"{"version":2,"id":"ws:acme-dark","name":"Acme Dark","mode":"dark",
                "colors":{"background":"#000","text":"#fff","accent":"#f50","muted":"#888"},
                "typography":{"headline":{"family":"Avenir Next","weight":600},"body":"Inter","scale":1.25},
                "background":{"type":"gradient","gradient":"acme-glow"}}"##,
        );
        write(
            &root,
            "themes/acme-light/theme.json",
            r##"{"version":2,"id":"ws:acme-light","name":"Acme Light","mode":"light",
                "colors":{"background":"#fff","text":"#000","accent":"#f50","muted":"#888"},
                "typography":{"headline":"Inter","body":"Inter","scale":1.2}}"##,
        );
        write(&root, "gradients/acme-glow.json", r##"{"type":"linear","angleDeg":90,"stops":[["#000",0],["#fff",1]]}"##);
        write(&root, "objects/widget/object.json", r#"{"version":1,"id":"ws:widget","name":"Widget","glb":"widget.glb"}"#);
        write(&root, "objects/widget/widget.glb", "glb-bytes");
        root
    }

    fn selection(projects: &[&str]) -> PackSelection {
        PackSelection {
            projects: projects.iter().map(|s| (*s).to_owned()).collect(),
            ..Default::default()
        }
    }

    fn archive_paths(closure: &Closure) -> Vec<String> {
        closure.files.iter().map(|f| f.archive_path.clone()).collect()
    }

    #[test]
    fn walks_project_to_theme_to_font() {
        let root = fixture("closure");
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();

        assert_eq!(closure.contents.projects.len(), 1);
        let project = &closure.contents.projects[0];
        assert_eq!(project.base.slug, "acme");
        assert_eq!(project.base.name, "Acme");
        assert_eq!(project.scene_count, 2);
        assert_eq!(project.duration_ms, 2600);
        assert_eq!(project.theme_id, "ws:acme-dark");
        assert!(project.has_scene_code);
        assert_eq!(project.root, "payload/projects/acme");

        assert!(closure.contents.themes.iter().any(|t| t.base.slug == "acme-dark"));
        // Avenir Next is not bundled and not pinned in this fixture: the reference is walked, the bytes warn.
        assert!(closure
            .contents
            .themes
            .iter()
            .find(|t| t.base.slug == "acme-dark")
            .unwrap()
            .requires
            .fonts
            .contains(&"Avenir Next@600".to_owned()));
        assert!(closure.required_by.contains_key("font:Avenir Next@600"));
        assert!(closure
            .warnings
            .iter()
            .any(|w| matches!(w, ClosureWarning::UnpinnedFont { key, .. } if key == "Avenir Next@600")));
        // Inter is bundled, so it never becomes a dependency.
        assert!(!closure.required_by.contains_key("font:Inter@400"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scene_theme_override_pulls_a_second_theme() {
        let root = fixture("second-theme");
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        let slugs: Vec<&str> = closure
            .contents
            .themes
            .iter()
            .map(|t| t.base.slug.as_str())
            .collect();
        assert_eq!(slugs, vec!["acme-dark", "acme-light"]);
        assert_eq!(
            closure.required_by.get("theme:acme-light").unwrap(),
            &vec!["project:acme".to_owned()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sidecar_object_reference_travels() {
        let root = fixture("object");
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert_eq!(closure.contents.objects.len(), 1);
        let object = &closure.contents.objects[0];
        assert_eq!(object.base.slug, "widget");
        assert_eq!(object.base.name, "Widget");
        assert_eq!(object.glb, "payload/objects/widget/widget.glb");
        assert!(archive_paths(&closure).contains(&"payload/objects/widget/widget.glb".to_owned()));
        assert_eq!(
            closure.required_by.get("object:widget").unwrap(),
            &vec!["project:acme".to_owned()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn theme_gradient_reference_travels() {
        let root = fixture("gradient");
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert_eq!(closure.contents.gradients.len(), 1);
        assert_eq!(closure.contents.gradients[0].base.slug, "acme-glow");
        assert!(archive_paths(&closure).contains(&"payload/gradients/acme-glow.json".to_owned()));
        assert_eq!(
            closure.required_by.get("gradient:acme-glow").unwrap(),
            &vec!["theme:acme-dark".to_owned()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dangling_references_warn_rather_than_fail() {
        let root = fixture("dangling");
        std::fs::remove_dir_all(root.join("objects/widget")).unwrap();
        std::fs::remove_dir_all(root.join("themes/acme-light")).unwrap();
        std::fs::remove_file(root.join("gradients/acme-glow.json")).unwrap();

        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert_eq!(closure.contents.projects.len(), 1);
        assert!(closure.contents.objects.is_empty());
        assert!(closure.contents.gradients.is_empty());
        assert!(closure
            .warnings
            .iter()
            .any(|w| matches!(w, ClosureWarning::UnknownReference { id, .. } if id == "widget")));
        assert!(closure
            .warnings
            .iter()
            .any(|w| matches!(w, ClosureWarning::MissingTheme { slug, .. } if slug == "acme-light")));
        assert!(closure
            .warnings
            .iter()
            .any(|w| matches!(w, ClosureWarning::MissingGradient { slug, .. } if slug == "acme-glow")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unticking_a_dependency_names_what_breaks() {
        let root = fixture("exclude");
        let mut sel = selection(&["acme"]);
        sel.exclude = vec!["theme:acme-dark".to_owned()];
        let closure = resolve_closure(&root, &sel).unwrap();
        assert!(!closure.contents.themes.iter().any(|t| t.base.slug == "acme-dark"));
        assert!(closure.warnings.iter().any(|w| matches!(
            w,
            ClosureWarning::ExcludedDependency { key, required_by }
                if key == "theme:acme-dark" && required_by == &vec!["project:acme".to_owned()]
        )));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn exclusion_table_is_applied() {
        let root = fixture("exclusions");
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        let paths = archive_paths(&closure);
        let has = |p: &str| paths.iter().any(|x| x == p);

        assert!(!has("payload/projects/acme/exports/render.mp4"), "exports/**");
        assert!(
            !has("payload/projects/acme/assets/.emoji-cache/1f600.png"),
            "assets/.emoji-cache/**"
        );
        assert!(!has("payload/projects/acme/.git/config"), ".git/**");
        assert!(
            !has("payload/projects/acme/.claude/skills/x/SKILL.md"),
            ".claude/skills/**"
        );
        assert!(
            !has("payload/projects/acme/edits/_tap_prefs.json"),
            "edits/_tap_prefs.json"
        );

        assert!(has("payload/projects/acme/CLAUDE.md"), "CLAUDE.md travels");
        assert!(
            has("payload/projects/acme/.claude/settings.json"),
            ".claude/settings.json travels"
        );
        assert!(has("payload/projects/acme/project.json"));
        assert!(has("payload/projects/acme/scenes/01-hero.tsx"));
        assert!(has("payload/projects/acme/assets/hero.png"));
        assert!(has("payload/projects/acme/edits/cut.json"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreferenced_and_flattened_assets_are_reported() {
        let root = fixture("review");
        write(&root, "acme/assets/orphan.png", "nobody-points-here");
        write(&root, "acme/assets/cut-edited.mp4", "flattened");
        write(
            &root,
            "acme/scenes/01-hero.json",
            r#"{"version":1,"text":{"title":"Hi"},"videoWindow":{"media":{"src":"assets/cut-edited.mp4"}}}"#,
        );

        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        let orphan = closure
            .reviewed_assets
            .iter()
            .find(|a| a.rel == "assets/orphan.png")
            .expect("orphan listed");
        assert_eq!(orphan.group, AssetGroup::Unreferenced);
        assert!(orphan.included);
        let flattened = closure
            .reviewed_assets
            .iter()
            .find(|a| a.rel == "assets/cut-edited.mp4")
            .expect("flattened render listed in its own group even though a scene points at it");
        assert_eq!(flattened.group, AssetGroup::FlattenedRender);
        // hero.png is referenced by edits/cut.json, so it is not up for review.
        assert!(!closure.reviewed_assets.iter().any(|a| a.rel == "assets/hero.png"));

        let mut sel = selection(&["acme"]);
        sel.include_flattened_renders = false;
        sel.include_unreferenced_assets = false;
        let trimmed = resolve_closure(&root, &sel).unwrap();
        let paths = archive_paths(&trimmed);
        assert!(!paths.iter().any(|p| p.ends_with("orphan.png")));
        assert!(!paths.iter().any(|p| p.ends_with("cut-edited.mp4")));
        assert!(paths.iter().any(|p| p.ends_with("hero.png")));
        assert!(trimmed.reviewed_assets.iter().all(|a| !a.included));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn item_bases_hash_content_and_stamp_the_newest_file() {
        let root = fixture("bases");
        let first = resolve_closure(&root, &selection(&["acme"])).unwrap();
        let theme = first
            .contents
            .themes
            .iter()
            .find(|t| t.base.slug == "acme-dark")
            .unwrap();
        assert_eq!(theme.base.content_hash.len(), 64);
        assert_eq!(theme.mode, "dark");
        assert_eq!(theme.doc_version, 2);
        assert_eq!(theme.swatches, vec!["#000", "#fff", "#f50", "#888"]);
        assert!(theme.base.modified_at.ends_with('Z'));
        assert_eq!(theme.base.modified_at.len(), 20);
        assert_eq!(
            theme.base.bytes,
            std::fs::metadata(root.join("themes/acme-dark/theme.json")).unwrap().len()
        );

        // The hash is over content, so a re-resolve with no edits is identical.
        let again = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert_eq!(
            again.contents.projects[0].base.content_hash,
            first.contents.projects[0].base.content_hash
        );
        assert_eq!(again.totals.files, first.totals.files);
        assert_eq!(
            first.totals.bytes,
            first.files.iter().map(|f| f.bytes).sum::<u64>()
        );

        write(&root, "acme/assets/hero.png", "png-hero-CHANGED");
        let changed = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert_ne!(
            changed.contents.projects[0].base.content_hash,
            first.contents.projects[0].base.content_hash
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn snapshot(dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut sorted: Vec<_> = entries.flatten().collect();
        sorted.sort_by_key(std::fs::DirEntry::file_name);
        for entry in sorted {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            out.push(format!(
                "{} {} {:?}",
                path.display(),
                meta.len(),
                meta.modified().ok()
            ));
            if meta.is_dir() {
                snapshot(&path, out);
            }
        }
    }

    #[test]
    fn resolving_writes_nothing() {
        let root = fixture("pure");
        let mut before = Vec::new();
        snapshot(&root, &mut before);
        let closure = resolve_closure(&root, &selection(&["acme"])).unwrap();
        assert!(!closure.files.is_empty());
        let mut after = Vec::new();
        snapshot(&root, &mut after);
        assert_eq!(before, after);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_workspace_is_the_one_hard_error() {
        let root = scratch("no-root").join("gone");
        assert_eq!(
            resolve_closure(&root, &selection(&["acme"])).unwrap_err().variant(),
            "noWorkspace"
        );
        let closure = resolve_closure(&scratch("empty"), &selection(&["acme"])).unwrap();
        assert!(closure
            .warnings
            .iter()
            .any(|w| matches!(w, ClosureWarning::MissingProject { slug } if slug == "acme")));
    }

    #[test]
    fn font_strings_parse_like_the_frontend() {
        assert_eq!(parse_font_string("Georgia"), ("Georgia".into(), 400));
        assert_eq!(parse_font_string("Avenir Next@600"), ("Avenir Next".into(), 600));
        assert_eq!(parse_font_string("Weird@name"), ("Weird@name".into(), 400));
        assert_eq!(parse_font_string("X@0"), ("X@0".into(), 400));
        assert_eq!(parse_font_string("We@ird@600"), ("We@ird".into(), 600));
        assert_eq!(font_key("Avenir Next", 400), "Avenir Next@400");
        assert!(is_bundled_family("Space Grotesk"));
        assert!(!is_bundled_family("Avenir Next"));
    }

    #[test]
    fn ws_tokens_are_found_in_source_but_not_inside_words() {
        let mut refs = DocRefs::default();
        scan_source(
            "const a = \"ws:widget\";\nconst rows: number[] = [];\nuse(\"ws:sky-box\");\n",
            &mut refs,
        );
        assert_eq!(
            refs.workspace_ids.iter().cloned().collect::<Vec<_>>(),
            vec!["sky-box".to_owned(), "widget".to_owned()]
        );
    }

    /// The manifest stamp every item base carries. One implementation (`pack::scan`), asserted here because the closure is what writes it.
    #[test]
    fn rfc3339_matches_known_epochs() {
        let at = |secs: u64| rfc3339(UNIX_EPOCH + std::time::Duration::from_secs(secs));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(1), "1970-01-01T00:00:01Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z", "leap day");
        assert_eq!(at(1_709_164_800), "2024-02-29T00:00:00Z", "leap day");
        assert_eq!(at(1_735_689_599), "2024-12-31T23:59:59Z", "year boundary");
        assert_eq!(at(1_735_689_600), "2025-01-01T00:00:00Z", "year boundary");
        assert_eq!(at(4_102_444_800), "2100-01-01T00:00:00Z", "non-leap century");
        assert_eq!(at(1_753_500_000), "2025-07-26T03:20:00Z");
        // Pre-epoch stamps clamp rather than format negative: a file older than 1970 is a broken clock, not a date.
        assert_eq!(
            rfc3339(UNIX_EPOCH - std::time::Duration::from_secs(1)),
            "1970-01-01T00:00:00Z"
        );
    }
}
