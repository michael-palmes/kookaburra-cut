//! Fonts in a pack. Two rules: the pinned bytes are the determinism contract, so they travel verbatim rather than by
//! family name, and OS/2 `fsType` decides whether they may travel at all.
//!
//! On import the incumbent always wins a byte mismatch. Replacing a pinned face changes what the recipient's
//! already-authored projects render, which is a decision only they can make.

use super::error::PackError;
use super::hash::{sha256_bytes, sha256_file};
use super::limits::PAYLOAD_PREFIX;
use super::model::{
    ConflictState, FontEmbedding, FontInstanced, ItemKind, PackFont, PackItemBase, Resolution,
};
use crate::fonts::{font_embedding, FontRef, InstancedFrom, PinnedFont};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Bundled OFL faces ship with the app, so a pack carrying them would add only bloat and version drift. Mirrors `BUNDLED_FONTS` (`src/theme/fonts.ts`).
const BUNDLED_FAMILIES: [&str; 6] = [
    "Inter",
    "Space Grotesk",
    "Open Sans",
    "JetBrains Mono",
    "Playfair Display",
    "Lora",
];

pub fn is_bundled_family(family: &str) -> bool {
    BUNDLED_FAMILIES
        .iter()
        .any(|f| f.eq_ignore_ascii_case(family))
}

fn key_of(family: &str, weight: u32) -> String {
    format!("{family}@{weight}")
}

fn archive_path(file: &str) -> String {
    format!("{PAYLOAD_PREFIX}{}/{file}", ItemKind::Font.payload_dir())
}

/// Postscript names become file names the same way pinning does; the name is incidental, `fonts.json` carries the mapping.
fn safe_file_stem(postscript: &str) -> String {
    postscript
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

// - Timestamps ------------------------------------------------------------------
// One implementation, in `pack::scan`: export and import must stamp the same way.
use super::scan::rfc3339;

fn modified_at(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(rfc3339)
        .unwrap_or_default()
}

fn is_stamp(value: &str) -> bool {
    value.len() == 20 && value.ends_with('Z') && value.as_bytes()[4] == b'-'
}

// - Export ----------------------------------------------------------------------

/// The `PackFont` entries for a set of (family, weight) refs, resolved through the workspace's `fonts.json`.
///
/// Bundled families are recorded nowhere: they ship with the app. A ref with no pin, or a pin whose file has gone, is
/// skipped rather than refused, since the caller pins on demand first and a missing face must not fail a whole pack.
pub fn collect_pack_fonts(fonts_dir: &Path, refs: &[FontRef]) -> Result<Vec<PackFont>, PackError> {
    let manifest = crate::fonts::load_manifest(fonts_dir);
    let mut out: Vec<PackFont> = Vec::new();
    for r in refs {
        if is_bundled_family(&r.family) {
            continue;
        }
        let key = key_of(&r.family, r.weight);
        if out.iter().any(|f| f.key() == key) {
            continue;
        }
        let Some(pin) = manifest
            .fonts
            .iter()
            .find(|f| f.family == r.family && f.weight == r.weight)
        else {
            continue;
        };
        let path = fonts_dir.join(&pin.file);
        if !path.is_file() {
            continue;
        }
        out.push(pack_font(&path, pin)?);
    }
    out.sort_by_key(|a| a.key());
    Ok(out)
}

fn pack_font(path: &Path, pin: &PinnedFont) -> Result<PackFont, PackError> {
    let embedding = font_embedding(path, Some(&pin.postscript));
    let key = key_of(&pin.family, pin.weight);
    let mut base = PackItemBase {
        slug: key.clone(),
        name: pin.family.clone(),
        bytes: 0,
        modified_at: modified_at(path),
        content_hash: String::new(),
    };
    let instanced = pin.instanced.as_ref().map(|i| FontInstanced {
        axes: i
            .axes
            .iter()
            .map(|(tag, v)| (tag.clone(), *v as f32))
            .collect(),
        instancer: i.instancer.clone(),
    });

    let (file, sha256, reference_only) = if embedding.may_bundle() {
        let sha = sha256_file(path)?;
        base.bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        base.content_hash = sha.clone();
        (Some(archive_path(&pin.file)), Some(sha), None)
    } else {
        // The bytes stay behind, so the key itself is the conflict key.
        base.content_hash = sha256_bytes(key.as_bytes());
        (None, None, Some(true))
    };

    Ok(PackFont {
        base,
        family: pin.family.clone(),
        weight: pin.weight,
        postscript: pin.postscript.clone(),
        file,
        sha256,
        instanced,
        embedding,
        reference_only,
    })
}

// - Import ----------------------------------------------------------------------

/// What one incoming font would do to the recipient's `fonts.json`. Keyed by (family, weight), never by file name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontConflict {
    /// `"<family>@<weight>"`
    pub key: String,
    pub family: String,
    pub weight: u32,
    pub state: ConflictState,
    /// The default only, and never `keep-both`: two files cannot both own a key in `fonts.json`.
    pub resolution: Resolution,
    pub embedding: FontEmbedding,
    pub reference_only: bool,
    /// The incumbent pin's file name, when there is one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub existing_file: Option<String>,
}

/// Compare every incoming font against the workspace's pins. Hash decides first; dates are only a label, since a byte mismatch defaults to skip either way.
pub fn plan_font_merge(
    fonts_dir: &Path,
    staged_root: &Path,
    staged: &[PackFont],
) -> Result<Vec<FontConflict>, PackError> {
    let manifest = crate::fonts::load_manifest(fonts_dir);
    let mut out = Vec::with_capacity(staged.len());

    for font in staged {
        let key = font.key();
        let incumbent = manifest
            .fonts
            .iter()
            .find(|f| f.family == font.family && f.weight == font.weight)
            .filter(|f| fonts_dir.join(&f.file).is_file());

        let (state, resolution) = if font.is_reference_only() {
            // Nothing travels, so there is nothing to write whatever the state says.
            let state = if incumbent.is_some() {
                ConflictState::Identical
            } else {
                ConflictState::New
            };
            (state, Resolution::Skip)
        } else {
            match incumbent {
                None => (
                    ConflictState::New,
                    ConflictState::New.default_resolution(ItemKind::Font),
                ),
                Some(pin) => {
                    let local = fonts_dir.join(&pin.file);
                    let incoming = incoming_sha(staged_root, font)?;
                    let state = if sha256_file(&local)? == incoming {
                        ConflictState::Identical
                    } else {
                        age_state(&font.base.modified_at, &local)
                    };
                    (state, state.default_resolution(ItemKind::Font))
                }
            }
        };

        out.push(FontConflict {
            key,
            family: font.family.clone(),
            weight: font.weight,
            state,
            resolution,
            embedding: font.embedding,
            reference_only: font.is_reference_only(),
            existing_file: incumbent.map(|f| f.file.clone()),
        });
    }
    Ok(out)
}

/// The manifest hash, already verified against the staged bytes on extraction; hashed here only when the manifest omits it.
fn incoming_sha(staged_root: &Path, font: &PackFont) -> Result<String, PackError> {
    if let Some(sha) = &font.sha256 {
        return Ok(sha.clone());
    }
    let Some(file) = &font.file else {
        return Ok(String::new());
    };
    sha256_file(&staged_root.join(file))
}

/// Which side is newer, when the bytes already disagree. Equal or unusable stamps read as unknown age.
fn age_state(theirs: &str, local: &Path) -> ConflictState {
    let ours = modified_at(local);
    if !is_stamp(theirs) || !is_stamp(&ours) {
        return ConflictState::UnknownAge;
    }
    match theirs.cmp(ours.as_str()) {
        std::cmp::Ordering::Greater => ConflictState::TheirsNewer,
        std::cmp::Ordering::Less => ConflictState::YoursNewer,
        std::cmp::Ordering::Equal => ConflictState::UnknownAge,
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontApplySummary {
    /// Keys whose bytes were written into the workspace.
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    /// Keys that travelled as a name only; the recipient needs the face installed.
    pub referenced: Vec<String>,
    /// The one font whose bytes would not land, and why. Everything queued behind it is `not_attempted`.
    pub failed: Option<(String, String)>,
    /// Never tried, because `failed` stopped the phase. Reported as skipped, never as broken.
    pub not_attempted: Vec<String>,
    /// `fonts.json` would not rewrite, so nothing in `written` is reachable and the phase is a failure whole.
    pub index_error: Option<String>,
}

/// Write the accepted fonts into the workspace and rewrite `fonts.json` whole. Anything not explicitly resolved is skipped.
///
/// Never `Err`: one font refusing to land says nothing about the others, and the caller reports each on its own terms.
pub fn apply_font_merge(
    fonts_dir: &Path,
    staged_root: &Path,
    staged: &[PackFont],
    resolutions: &HashMap<String, Resolution>,
) -> FontApplySummary {
    let mut manifest = crate::fonts::load_manifest(fonts_dir);
    let mut summary = FontApplySummary::default();

    for font in staged {
        let key = font.key();
        if summary.failed.is_some() {
            summary.not_attempted.push(key);
            continue;
        }
        if font.is_reference_only() {
            summary.referenced.push(key);
            continue;
        }
        // KeepBoth is never offered for fonts, so an unknown or absent choice is a skip.
        let accepted = matches!(resolutions.get(&key), Some(Resolution::Replace));
        let Some(source) = font.file.as_ref().map(|f| staged_root.join(f)) else {
            summary.skipped.push(key);
            continue;
        };
        if !accepted || !source.is_file() {
            summary.skipped.push(key);
            continue;
        }

        let name = target_file_name(fonts_dir, &manifest, font);
        if let Err(error) = write_font_file(&source, &fonts_dir.join(&name)) {
            summary.failed = Some((key, error.user_message()));
            continue;
        }
        manifest
            .fonts
            .retain(|f| !(f.family == font.family && f.weight == font.weight));
        manifest.fonts.push(PinnedFont {
            family: font.family.clone(),
            weight: font.weight,
            postscript: font.postscript.clone(),
            file: name,
            instanced: font.instanced.as_ref().map(|i| InstancedFrom {
                axes: i
                    .axes
                    .iter()
                    .map(|(tag, v)| (tag.clone(), f64::from(*v)))
                    .collect(),
                instancer: i.instancer.clone(),
            }),
            path: String::new(),
        });
        summary.written.push(key);
    }

    // An all-skip import must not rewrite the recipient's index at all. Whatever DID land is still recorded, even
    // when a later font failed: bytes on disk that `fonts.json` does not list are unreachable and invisible.
    if !summary.written.is_empty() {
        if let Err(error) = crate::fonts::save_manifest(fonts_dir, &manifest) {
            summary.index_error = Some(PackError::Write(error).user_message());
        }
    }
    summary
}

/// The incumbent file name for this key, else the postscript name, suffixed while another key already owns it.
fn target_file_name(
    fonts_dir: &Path,
    manifest: &crate::fonts::FontsManifest,
    font: &PackFont,
) -> String {
    if let Some(pin) = manifest
        .fonts
        .iter()
        .find(|f| f.family == font.family && f.weight == font.weight)
    {
        return pin.file.clone();
    }
    let ext = font
        .file
        .as_deref()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| e == "ttf" || e == "otf")
        .unwrap_or_else(|| "ttf".to_string());
    let stem = safe_file_stem(&font.postscript);

    let mut candidate = format!("{stem}.{ext}");
    let mut suffix = 2;
    while fonts_dir.join(&candidate).exists() || manifest.fonts.iter().any(|f| f.file == candidate)
    {
        candidate = format!("{stem}-{suffix}.{ext}");
        suffix += 1;
    }
    candidate
}

/// Tmp plus rename, so a font file is never half written under a name `fonts.json` already points at.
///
/// The folder is created here rather than up front: only a workspace that has pinned a font has one, and an all-skip
/// import must leave a workspace that has not exactly as it found it.
fn write_font_file(source: &Path, target: &Path) -> Result<(), PackError> {
    let write_err = |e: std::io::Error| PackError::Write(e.to_string());
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(write_err)?;
    }
    let tmp = target.with_extension("part");
    std::fs::copy(source, &tmp).map_err(write_err)?;
    std::fs::rename(&tmp, target).map_err(write_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-pack-fonts-{}-{}-{:?}",
            label,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pin(family: &str, weight: u32, file: &str) -> PinnedFont {
        PinnedFont {
            family: family.into(),
            weight,
            postscript: format!("{}-{weight}", family.replace(' ', "")),
            file: file.into(),
            instanced: None,
            path: String::new(),
        }
    }

    fn write_pins(dir: &Path, pins: Vec<PinnedFont>) {
        for p in &pins {
            std::fs::write(dir.join(&p.file), format!("bytes-of-{}", p.file)).unwrap();
        }
        crate::fonts::save_manifest(
            dir,
            &crate::fonts::FontsManifest {
                version: 1,
                fonts: pins,
            },
        )
        .unwrap();
    }

    /// A staged pack font plus its file, laid out exactly as extraction leaves it.
    fn stage_font(root: &Path, family: &str, weight: u32, bytes: &str) -> PackFont {
        let file = format!("{}-{weight}.ttf", family.replace(' ', ""));
        let rel = archive_path(&file);
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        PackFont {
            base: PackItemBase {
                slug: key_of(family, weight),
                name: family.into(),
                bytes: bytes.len() as u64,
                modified_at: "2026-07-26T00:00:00Z".into(),
                content_hash: sha256_bytes(bytes.as_bytes()),
            },
            family: family.into(),
            weight,
            postscript: format!("{}-{weight}", family.replace(' ', "")),
            file: Some(rel),
            sha256: Some(sha256_bytes(bytes.as_bytes())),
            instanced: None,
            embedding: FontEmbedding::Installable,
            reference_only: None,
        }
    }

    #[test]
    fn bundled_families_are_never_collected() {
        let dir = temp_dir("bundled");
        write_pins(
            &dir,
            vec![
                pin("Inter", 400, "Inter-Regular.ttf"),
                pin("space grotesk", 600, "SpaceGrotesk-Semibold.ttf"),
                pin("Acme Sans", 700, "AcmeSans-Bold.ttf"),
            ],
        );
        let refs = vec![
            FontRef {
                family: "Inter".into(),
                weight: 400,
            },
            FontRef {
                family: "space grotesk".into(),
                weight: 600,
            },
            FontRef {
                family: "Acme Sans".into(),
                weight: 700,
            },
        ];
        let fonts = collect_pack_fonts(&dir, &refs).unwrap();
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].key(), "Acme Sans@700");
        assert_eq!(
            fonts[0].file.as_deref(),
            Some("payload/fonts/AcmeSans-Bold.ttf")
        );
        // contentHash is the file's own sha for a font whose bytes travel.
        assert_eq!(fonts[0].base.content_hash, fonts[0].sha256.clone().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpinned_and_missing_refs_are_skipped() {
        let dir = temp_dir("missing");
        write_pins(&dir, vec![pin("Acme Sans", 400, "AcmeSans-Regular.ttf")]);
        std::fs::remove_file(dir.join("AcmeSans-Regular.ttf")).unwrap();
        let refs = vec![
            FontRef {
                family: "Acme Sans".into(),
                weight: 400,
            },
            FontRef {
                family: "Never Pinned".into(),
                weight: 400,
            },
        ];
        assert!(collect_pack_fonts(&dir, &refs).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn instanced_provenance_travels_verbatim() {
        let dir = temp_dir("instanced");
        let mut pinned = pin("Acme Var", 600, "AcmeVar-Semibold.ttf");
        pinned.instanced = Some(InstancedFrom {
            axes: BTreeMap::from([("wght".to_string(), 590.0), ("opsz".to_string(), 28.0)]),
            instancer: "allsorts 0.17.0".into(),
        });
        write_pins(&dir, vec![pinned]);
        let fonts = collect_pack_fonts(
            &dir,
            &[FontRef {
                family: "Acme Var".into(),
                weight: 600,
            }],
        )
        .unwrap();
        let instanced = fonts[0].instanced.as_ref().unwrap();
        assert_eq!(instanced.instancer, "allsorts 0.17.0");
        assert_eq!(instanced.axes.get("wght"), Some(&590.0));
        assert_eq!(instanced.axes.get("opsz"), Some(&28.0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file with no OS/2 table reads Unknown, which bundles; only a Restricted fsType degrades to a name.
    #[test]
    fn restricted_fonts_travel_as_a_name_only() {
        let dir = temp_dir("restricted");
        let restricted = crate::fonts::stub_sfnt(Some(0x0002));
        std::fs::write(dir.join("AcmeSans-Bold.ttf"), restricted).unwrap();
        let installable = crate::fonts::stub_sfnt(Some(0x0000));
        std::fs::write(dir.join("AcmeSans-Regular.ttf"), installable).unwrap();
        crate::fonts::save_manifest(
            &dir,
            &crate::fonts::FontsManifest {
                version: 1,
                fonts: vec![
                    pin("Acme Sans", 700, "AcmeSans-Bold.ttf"),
                    pin("Acme Sans", 400, "AcmeSans-Regular.ttf"),
                ],
            },
        )
        .unwrap();

        let fonts = collect_pack_fonts(
            &dir,
            &[
                FontRef {
                    family: "Acme Sans".into(),
                    weight: 700,
                },
                FontRef {
                    family: "Acme Sans".into(),
                    weight: 400,
                },
            ],
        )
        .unwrap();

        let blocked = fonts.iter().find(|f| f.weight == 700).unwrap();
        assert_eq!(blocked.embedding, FontEmbedding::Restricted);
        assert!(blocked.is_reference_only());
        assert!(blocked.file.is_none());
        assert!(blocked.sha256.is_none());
        assert_eq!(blocked.base.bytes, 0);
        assert_eq!(blocked.base.content_hash, sha256_bytes(b"Acme Sans@700"));

        let allowed = fonts.iter().find(|f| f.weight == 400).unwrap();
        assert_eq!(allowed.embedding, FontEmbedding::Installable);
        assert!(!allowed.is_reference_only());
        assert!(allowed.file.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_plan_reads_identical_new_and_conflict() {
        let workspace = temp_dir("plan-ws");
        let staged = temp_dir("plan-staged");
        write_pins(
            &workspace,
            vec![
                pin("Acme Sans", 400, "AcmeSans-400.ttf"),
                pin("Acme Sans", 700, "AcmeSans-700.ttf"),
            ],
        );

        let same = stage_font(&staged, "Acme Sans", 400, "bytes-of-AcmeSans-400.ttf");
        let differs = stage_font(&staged, "Acme Sans", 700, "quite different bytes");
        let fresh = stage_font(&staged, "Acme Display", 500, "new face");

        let plan = plan_font_merge(&workspace, &staged, &[same, differs, fresh]).unwrap();

        assert_eq!(plan[0].state, ConflictState::Identical);
        assert_eq!(plan[0].resolution, Resolution::Skip);
        assert_eq!(plan[0].existing_file.as_deref(), Some("AcmeSans-400.ttf"));

        // The incumbent bytes are the recipient's determinism contract, so a mismatch never replaces by default.
        assert_ne!(plan[1].state, ConflictState::Identical);
        assert_eq!(plan[1].resolution, Resolution::Skip);

        assert_eq!(plan[2].state, ConflictState::New);
        assert_eq!(plan[2].resolution, Resolution::Replace);
        assert!(plan[2].existing_file.is_none());

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    #[test]
    fn reference_only_fonts_are_never_written() {
        let workspace = temp_dir("ref-ws");
        let staged = temp_dir("ref-staged");
        write_pins(&workspace, vec![]);
        let mut font = stage_font(&staged, "Acme Sans", 700, "irrelevant");
        font.file = None;
        font.sha256 = None;
        font.reference_only = Some(true);
        font.embedding = FontEmbedding::Restricted;

        let plan = plan_font_merge(&workspace, &staged, std::slice::from_ref(&font)).unwrap();
        assert_eq!(plan[0].resolution, Resolution::Skip);
        assert!(plan[0].reference_only);

        let all_in = HashMap::from([(font.key(), Resolution::Replace)]);
        let summary = apply_font_merge(&workspace, &staged, &[font], &all_in);
        assert_eq!(summary.referenced, vec!["Acme Sans@700"]);
        assert!(summary.written.is_empty());
        assert!(crate::fonts::load_manifest(&workspace).fonts.is_empty());

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    #[test]
    fn apply_writes_accepted_fonts_and_skips_the_rest() {
        let workspace = temp_dir("apply-ws");
        let staged = temp_dir("apply-staged");
        write_pins(&workspace, vec![pin("Acme Sans", 400, "AcmeSans-400.ttf")]);

        let replaced = stage_font(&staged, "Acme Sans", 400, "replacement bytes");
        let fresh = stage_font(&staged, "Acme Display", 500, "brand new bytes");
        let refused = stage_font(&staged, "Acme Mono", 400, "unwanted bytes");

        let choices = HashMap::from([
            (replaced.key(), Resolution::Replace),
            (fresh.key(), Resolution::Replace),
            (refused.key(), Resolution::Skip),
        ]);
        let summary = apply_font_merge(&workspace, &staged, &[replaced, fresh, refused], &choices);
        assert_eq!(summary.written, vec!["Acme Sans@400", "Acme Display@500"]);
        assert_eq!(summary.skipped, vec!["Acme Mono@400"]);

        let after = crate::fonts::load_manifest(&workspace);
        assert_eq!(after.fonts.len(), 2);
        // An existing key keeps its file name; the bytes behind it are the ones that changed.
        let acme = after.fonts.iter().find(|f| f.weight == 400).unwrap();
        assert_eq!(acme.file, "AcmeSans-400.ttf");
        assert_eq!(
            std::fs::read_to_string(workspace.join("AcmeSans-400.ttf")).unwrap(),
            "replacement bytes"
        );
        assert!(!workspace.join("AcmeMono-400.ttf").exists());

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    /// A workspace that has never pinned a font has no `fonts/` folder; the first thing to create it must be the import.
    #[test]
    fn apply_creates_the_fonts_folder_when_the_workspace_has_none() {
        let root = temp_dir("virgin-ws");
        let workspace = root.join("fonts");
        let staged = temp_dir("virgin-staged");
        assert!(!workspace.exists());

        let incoming = stage_font(&staged, "Messina Modern", 400, "the pinned bytes");
        let choices = HashMap::from([(incoming.key(), Resolution::Replace)]);
        let summary = apply_font_merge(&workspace, &staged, &[incoming], &choices);

        assert_eq!(summary.written, vec!["Messina Modern@400"]);
        assert_eq!(
            std::fs::read_to_string(workspace.join("MessinaModern-400.ttf")).unwrap(),
            "the pinned bytes"
        );
        assert_eq!(crate::fonts::load_manifest(&workspace).fonts.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&staged);
    }

    /// The file name is incidental; a clash with another key's file gets suffixed rather than overwriting it.
    #[test]
    fn a_file_name_clash_on_a_different_key_is_suffixed() {
        let workspace = temp_dir("clash-ws");
        let staged = temp_dir("clash-staged");
        write_pins(&workspace, vec![pin("Acme Sans", 400, "AcmeSans-700.ttf")]);

        let incoming = stage_font(&staged, "Acme Sans", 700, "the real bold");
        let choices = HashMap::from([(incoming.key(), Resolution::Replace)]);
        apply_font_merge(&workspace, &staged, &[incoming], &choices);

        let after = crate::fonts::load_manifest(&workspace);
        let bold = after.fonts.iter().find(|f| f.weight == 700).unwrap();
        assert_eq!(bold.file, "AcmeSans-700-2.ttf");
        // The incumbent's file is untouched.
        assert_eq!(
            std::fs::read_to_string(workspace.join("AcmeSans-700.ttf")).unwrap(),
            "bytes-of-AcmeSans-700.ttf"
        );

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    /// One font refusing to land says nothing about the others: they are queued, not broken.
    #[test]
    fn a_font_that_cannot_be_written_does_not_condemn_the_rest() {
        let workspace = temp_dir("one-bad-ws");
        let staged = temp_dir("one-bad-staged");

        let good = stage_font(&staged, "Acme Alpha", 400, "first bytes");
        let bad = stage_font(&staged, "Acme Bravo", 400, "second bytes");
        let queued = stage_font(&staged, "Acme Delta", 400, "third bytes");
        // A directory where the write wants its temp file, so this one font cannot land.
        std::fs::create_dir_all(workspace.join("AcmeBravo-400.part")).unwrap();

        let choices = HashMap::from([
            (good.key(), Resolution::Replace),
            (bad.key(), Resolution::Replace),
            (queued.key(), Resolution::Replace),
        ]);
        let summary = apply_font_merge(&workspace, &staged, &[good, bad, queued], &choices);

        assert_eq!(summary.written, vec!["Acme Alpha@400"]);
        let (key, message) = summary.failed.expect("the blocked font");
        assert_eq!(key, "Acme Bravo@400");
        assert!(
            message.starts_with("Could not write into your workspace"),
            "{message}"
        );
        assert_eq!(summary.not_attempted, vec!["Acme Delta@400"]);

        // What did land is still indexed: bytes fonts.json does not list are unreachable.
        let after = crate::fonts::load_manifest(&workspace);
        assert_eq!(after.fonts.len(), 1);
        assert_eq!(after.fonts[0].family, "Acme Alpha");
        assert_eq!(
            std::fs::read_to_string(workspace.join("AcmeAlpha-400.ttf")).unwrap(),
            "first bytes"
        );

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    /// A failed index write must leave the previous `fonts.json` exactly as it was.
    #[test]
    fn a_failed_index_write_leaves_the_old_index_intact() {
        let workspace = temp_dir("atomic-ws");
        let staged = temp_dir("atomic-staged");
        write_pins(&workspace, vec![pin("Acme Sans", 400, "AcmeSans-400.ttf")]);
        let before = std::fs::read_to_string(workspace.join("fonts.json")).unwrap();

        // Occupy the temp name the whole-file write renames from.
        std::fs::create_dir_all(workspace.join("fonts.json.tmp")).unwrap();

        let incoming = stage_font(&staged, "Acme Display", 500, "brand new bytes");
        let choices = HashMap::from([(incoming.key(), Resolution::Replace)]);
        let summary = apply_font_merge(&workspace, &staged, &[incoming], &choices);

        assert!(summary.index_error.is_some());
        assert_eq!(
            std::fs::read_to_string(workspace.join("fonts.json")).unwrap(),
            before
        );
        assert_eq!(crate::fonts::load_manifest(&workspace).fonts.len(), 1);

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&staged);
    }

    #[test]
    fn timestamps_round_trip_as_sortable_rfc3339() {
        let epoch = std::time::UNIX_EPOCH;
        assert_eq!(rfc3339(epoch), "1970-01-01T00:00:00Z");
        let stamp = rfc3339(epoch + std::time::Duration::from_secs(1_784_000_000));
        assert!(is_stamp(&stamp), "{stamp}");
        assert!(stamp.starts_with("2026-07-"), "{stamp}");
        assert!(!is_stamp(""));
        assert!(!is_stamp("2026-07-26"));
    }
}
