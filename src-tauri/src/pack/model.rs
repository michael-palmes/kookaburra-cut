//! The `.kbpack` manifest. Serde shapes are the on-disk format: adding a field is a `formatVersion` decision.

use serde::{Deserialize, Serialize};

pub const PACK_FORMAT: &str = "kookaburra-pack";
/// v2 added `contents.templates` and `contents.presets`. A v1 reader would parse a v2 manifest and silently drop both,
/// so the bump exists to make it refuse the pack whole (`read::inspect`); v1 packs still read here, the new lists
/// defaulting to empty.
pub const PACK_FORMAT_VERSION: u32 = 2;
/// Oldest app that can read a v1 pack, stamped into every pack we write. Must never exceed the shipping version, or the
/// app refuses its own packs (the round-trip gate caught exactly that), so it rises only with a release; the
/// `formatVersion` gate is what turns a newer pack away in the meantime.
pub const PACK_MIN_APP_VERSION: &str = "0.6.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub min_app_version: String,
    pub pack: PackMeta,
    pub publisher: PackPublisher,
    pub contents: PackContents,
    /// Every payload entry, sorted by path. The security spine: nothing is written that is not here.
    pub files: Vec<PackFile>,
    pub totals: PackTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMeta {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPublisher {
    /// Self-declared. Never rendered as verified.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub organisation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub website: Option<String>,
    pub device: String,
    /// `ed25519:<base64 32 bytes>`
    pub public_key: String,
    /// hex of sha256(raw pubkey)[0..8]
    pub key_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackTotals {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackContents {
    #[serde(default)]
    pub projects: Vec<PackProject>,
    #[serde(default)]
    pub templates: Vec<PackTemplate>,
    #[serde(default)]
    pub presets: Vec<PackPreset>,
    #[serde(default)]
    pub themes: Vec<PackTheme>,
    #[serde(default)]
    pub fonts: Vec<PackFont>,
    #[serde(default)]
    pub objects: Vec<PackObject>,
    #[serde(default)]
    pub gradients: Vec<PackSimpleItem>,
    #[serde(default)]
    pub export_presets: Vec<PackSimpleItem>,
    #[serde(default)]
    pub screenshots: Vec<PackScreenshot>,
}

/// What every pack item carries. `contentHash` is the conflict key and is over content, never mtime.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackItemBase {
    pub slug: String,
    pub name: String,
    pub bytes: u64,
    pub modified_at: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRequires {
    #[serde(default)]
    pub themes: Vec<String>,
    /// `"<family>@<weight>"`
    #[serde(default)]
    pub fonts: Vec<String>,
    #[serde(default)]
    pub objects: Vec<String>,
    #[serde(default)]
    pub gradients: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProject {
    #[serde(flatten)]
    pub base: PackItemBase,
    pub root: String,
    pub manifest_version: u32,
    pub scene_count: usize,
    pub scene_files: Vec<String>,
    pub duration_ms: u64,
    pub formats: Vec<String>,
    pub theme_id: String,
    pub requires: PackRequires,
    /// Always true. Kept explicit so the trust screen reads off the manifest, not an assumption.
    pub has_scene_code: bool,
}

/// A template is a project folder plus `template.json`, and a preset a single-scene one plus `preset.json`, so both
/// record exactly what a project records.
pub type PackTemplate = PackProject;
pub type PackPreset = PackProject;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackTheme {
    #[serde(flatten)]
    pub base: PackItemBase,
    pub mode: String,
    pub doc_version: u32,
    /// Swatches for the contents screen, read from the theme's `colors` block.
    #[serde(default)]
    pub swatches: Vec<String>,
    pub requires: PackRequires,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FontEmbedding {
    Installable,
    Editable,
    PreviewPrint,
    Restricted,
    Unknown,
}

impl FontEmbedding {
    /// Restricted fonts travel as a name only. Unknown reads as PreviewPrint: a missing OS/2 table is usually an old free face, and blocking it would be a false positive with no recourse.
    pub fn may_bundle(self) -> bool {
        !matches!(self, Self::Restricted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInstanced {
    pub axes: std::collections::BTreeMap<String, f32>,
    /// The instancer that produced these bytes, so a recipient can tell why they differ.
    pub instancer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFont {
    #[serde(flatten)]
    pub base: PackItemBase,
    pub family: String,
    pub weight: u32,
    pub postscript: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub instanced: Option<FontInstanced>,
    pub embedding: FontEmbedding,
    /// Blocked by fsType: the name travels, the bytes do not.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reference_only: Option<bool>,
}

impl PackFont {
    pub fn key(&self) -> String {
        format!("{}@{}", self.family, self.weight)
    }

    pub fn is_reference_only(&self) -> bool {
        self.reference_only.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackObject {
    #[serde(flatten)]
    pub base: PackItemBase,
    pub glb: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub licence: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSimpleItem {
    #[serde(flatten)]
    pub base: PackItemBase,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackScreenshot {
    #[serde(flatten)]
    pub base: PackItemBase,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub height: Option<u32>,
}

/// The nine stores a pack can carry, in apply order: projects reference everything else, so they land last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Font,
    Gradient,
    Object,
    Theme,
    Preset,
    Template,
    ExportPreset,
    Screenshot,
    Project,
}

impl ItemKind {
    /// Presets and templates land after themes, because their `project.json` may name a theme a keep-both just renamed.
    pub const APPLY_ORDER: [ItemKind; 9] = [
        ItemKind::Font,
        ItemKind::Gradient,
        ItemKind::Object,
        ItemKind::Theme,
        ItemKind::Preset,
        ItemKind::Template,
        ItemKind::ExportPreset,
        ItemKind::Screenshot,
        ItemKind::Project,
    ];

    /// The `payload/` subtree this kind lives under.
    pub fn payload_dir(self) -> &'static str {
        match self {
            Self::Project => "projects",
            Self::Theme => "themes",
            Self::Font => "fonts",
            Self::Object => "objects",
            Self::Gradient => "gradients",
            Self::Template => crate::library::TEMPLATES_DIR_NAME,
            Self::Preset => crate::library::PRESETS_DIR_NAME,
            Self::ExportPreset => "export-presets",
            Self::Screenshot => "screenshots",
        }
    }

    /// The workspace-root folder this kind installs into.
    pub fn workspace_dir(self) -> Option<&'static str> {
        match self {
            Self::Project => None,
            Self::Theme => Some("themes"),
            Self::Font => Some("fonts"),
            Self::Object => Some("objects"),
            Self::Gradient => Some("gradients"),
            Self::Template => Some(crate::library::TEMPLATES_DIR_NAME),
            Self::Preset => Some(crate::library::PRESETS_DIR_NAME),
            Self::ExportPreset => Some("export-presets"),
            Self::Screenshot => Some("screenshots"),
        }
    }

    /// The file whose presence marks a real item of this kind rather than a stray folder.
    pub fn marker_file(self) -> Option<&'static str> {
        match self {
            Self::Project => Some("project.json"),
            Self::Theme => Some("theme.json"),
            Self::Object => Some("object.json"),
            Self::Template => Some(crate::library::TEMPLATE_MANIFEST),
            Self::Preset => Some(crate::library::PRESET_MANIFEST),
            Self::Font | Self::Gradient | Self::ExportPreset | Self::Screenshot => None,
        }
    }
}

/// What the conflict screen shows per item. Decided by hash first, date only as a tiebreak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictState {
    New,
    Identical,
    TheirsNewer,
    YoursNewer,
    UnknownAge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    Skip,
    Replace,
    KeepBoth,
}

impl ConflictState {
    /// Michael's rule: identical never replaces, theirs-newer does, yours-newer keeps mine. Unknown age is conservative: never destroy on a guess.
    pub fn default_resolution(self, kind: ItemKind) -> Resolution {
        match (self, kind) {
            (Self::New, _) => Resolution::Replace,
            // Screenshots are a bag, not a namespace, so a clash costs nothing to keep.
            (_, ItemKind::Screenshot) => Resolution::KeepBoth,
            (Self::Identical, _) => Resolution::Skip,
            // The incumbent font bytes are the recipient's determinism contract.
            (_, ItemKind::Font) => Resolution::Skip,
            (Self::TheirsNewer, _) => Resolution::Replace,
            (Self::YoursNewer, _) | (Self::UnknownAge, _) => Resolution::Skip,
        }
    }
}
