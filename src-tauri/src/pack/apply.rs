//! The only thing in the app that writes an import into the workspace.
//!
//! Three rules hold it together. Fonts, gradients, objects, themes, presets and screenshots land before projects, so a
//! project arrives into a workspace that already has what it references. A replace moves the incumbent into a dated
//! backup first and never deletes inline. A failure part way through stops and reports, because rolling back a
//! half-applied import is more dangerous than leaving it named and inspectable.

use super::conflicts::{keep_both_slug, local_name, workspace_target};
use super::deps::item_key;
use super::error::PackError;
use super::fonts::apply_font_merge;
use super::hash::sha256_bytes;
use super::limits::{BACKUP_DIR, PAYLOAD_PREFIX};
use super::model::{ItemKind, PackFont, PackManifest, Resolution};
use super::read::StagedPack;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemOutcome {
    Added,
    Replaced,
    Skipped,
    KeptBoth,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub kind: ItemKind,
    /// The slug the item actually landed under, which is the suffixed one after a keep-both.
    pub slug: String,
    pub name: String,
    pub outcome: ItemOutcome,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub results: Vec<ItemResult>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub backup_dir: Option<String>,
    /// Set when a partial apply stopped early: names what did and did not land.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stopped_at: Option<String>,
    pub notes: Vec<String>,
}

struct Work {
    kind: ItemKind,
    slug: String,
    name: String,
    resolution: Resolution,
    /// The slug to write under: the same one, unless keep-both suffixed it.
    target_slug: String,
}

/// Slugs a keep-both moved aside, so references inside this import follow them.
#[derive(Default)]
struct Renames {
    themes: HashMap<String, String>,
    objects: HashMap<String, String>,
    gradients: HashMap<String, String>,
}

impl Renames {
    fn is_empty(&self) -> bool {
        self.themes.is_empty() && self.objects.is_empty() && self.gradients.is_empty()
    }
}

/// Apply an import. `resolutions` is keyed `"<kind>:<slug>"`; an item with no entry was never selected and is not
/// touched or reported. The staging tree is removed on every exit path.
pub fn apply_import(
    root: &Path,
    staged: StagedPack,
    resolutions: &HashMap<String, Resolution>,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<ImportOutcome, PackError> {
    let manifest = staged.manifest.clone();
    let staging = staged.root.clone();
    let backup_root = root
        .join(crate::workspace::STATE_DIR_NAME)
        .join(BACKUP_DIR)
        .join(run_id());

    let fonts: Vec<PackFont> = manifest
        .contents
        .fonts
        .iter()
        .filter(|f| {
            resolutions.contains_key(&item_key(ItemKind::Font, &f.key()))
                || resolutions.contains_key(&item_key(ItemKind::Font, &f.base.slug))
        })
        .cloned()
        .collect();

    let mut work: Vec<Work> = Vec::new();
    for (kind, slug, name) in flatten(&manifest) {
        let Some(&resolution) = resolutions.get(&item_key(kind, &slug)) else {
            continue;
        };
        let target_slug = if resolution == Resolution::KeepBoth {
            keep_both_slug(root, kind, &slug).unwrap_or_else(|| slug.clone())
        } else {
            slug.clone()
        };
        work.push(Work {
            kind,
            slug,
            name,
            resolution,
            target_slug,
        });
    }

    let mut outcome = ImportOutcome::default();

    // Every rewrite happens in staging, before anything moves, and only ever inside this import.
    let renames = renames_from(&work);
    if !renames.is_empty() {
        rewrite_references(&staging, &work, &renames)?;
    }
    outcome
        .notes
        .extend(theme_fallback_notes(root, &manifest, &work));

    let total = fonts.len() + work.len();
    let mut done = 0usize;
    let mut backed_up = false;
    let mut stopped: Option<String> = None;

    if !fonts.is_empty() {
        let (font_results, font_notes, font_backup, font_stop) = apply_fonts(
            root,
            &staging,
            &backup_root,
            &fonts,
            resolutions,
            &mut |name| {
                done += 1;
                on_progress(done, total, name);
            },
        );
        outcome.results.extend(font_results);
        outcome.notes.extend(font_notes);
        backed_up |= font_backup;
        stopped = font_stop;
    }

    for item in &work {
        if stopped.is_some() {
            outcome.results.push(ItemResult {
                kind: item.kind,
                slug: item.target_slug.clone(),
                name: item.name.clone(),
                outcome: ItemOutcome::Skipped,
                detail: Some("Not attempted".into()),
            });
            continue;
        }
        done += 1;
        on_progress(done, total, &item.name);

        match apply_one(root, &staging, &backup_root, item) {
            Ok((item_outcome, made_backup)) => {
                backed_up |= made_backup;
                outcome.results.push(ItemResult {
                    kind: item.kind,
                    slug: item.target_slug.clone(),
                    name: item.name.clone(),
                    outcome: item_outcome,
                    detail: None,
                });
            }
            Err(error) => {
                outcome.results.push(ItemResult {
                    kind: item.kind,
                    slug: item.target_slug.clone(),
                    name: item.name.clone(),
                    outcome: ItemOutcome::Failed,
                    detail: Some(error.user_message()),
                });
                stopped = Some(format!("{} ({})", item.name, label(item.kind)));
            }
        }
    }

    outcome.stopped_at = stopped;
    if backed_up {
        outcome.backup_dir = Some(backup_root.to_string_lossy().into_owned());
    }
    Ok(outcome)
}

/// Every slug-keyed item the pack carries, in apply order. Fonts are absent: they merge as one phase.
fn flatten(manifest: &PackManifest) -> Vec<(ItemKind, String, String)> {
    let contents = &manifest.contents;
    let mut out = Vec::new();
    for kind in ItemKind::APPLY_ORDER {
        match kind {
            ItemKind::Font => {}
            ItemKind::Gradient => out.extend(
                contents
                    .gradients
                    .iter()
                    .map(|g| (kind, g.base.slug.clone(), g.base.name.clone())),
            ),
            ItemKind::Object => out.extend(
                contents
                    .objects
                    .iter()
                    .map(|o| (kind, o.base.slug.clone(), o.base.name.clone())),
            ),
            ItemKind::Theme => out.extend(
                contents
                    .themes
                    .iter()
                    .map(|t| (kind, t.base.slug.clone(), t.base.name.clone())),
            ),
            ItemKind::ExportPreset => out.extend(
                contents
                    .export_presets
                    .iter()
                    .map(|e| (kind, e.base.slug.clone(), e.base.name.clone())),
            ),
            ItemKind::Screenshot => out.extend(
                contents
                    .screenshots
                    .iter()
                    .map(|s| (kind, s.base.slug.clone(), s.base.name.clone())),
            ),
            ItemKind::Project => out.extend(
                contents
                    .projects
                    .iter()
                    .map(|p| (kind, p.base.slug.clone(), p.base.name.clone())),
            ),
        }
    }
    out
}

fn label(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Project => "project",
        ItemKind::Theme => "theme",
        ItemKind::Font => "font",
        ItemKind::Object => "3D object",
        ItemKind::Gradient => "gradient",
        ItemKind::ExportPreset => "export preset",
        ItemKind::Screenshot => "screenshot",
    }
}

fn renames_from(work: &[Work]) -> Renames {
    let mut renames = Renames::default();
    for item in work.iter().filter(|w| w.target_slug != w.slug) {
        let map = match item.kind {
            ItemKind::Theme => &mut renames.themes,
            ItemKind::Object => &mut renames.objects,
            ItemKind::Gradient => &mut renames.gradients,
            _ => continue,
        };
        map.insert(item.slug.clone(), item.target_slug.clone());
    }
    renames
}

fn staged_source(staging: &Path, kind: ItemKind, slug: &str) -> PathBuf {
    let dir = staging
        .join(PAYLOAD_PREFIX.trim_end_matches('/'))
        .join(kind.payload_dir());
    match kind {
        ItemKind::Gradient | ItemKind::ExportPreset => dir.join(format!("{slug}.json")),
        _ => dir.join(slug),
    }
}

/// Point the projects in this import at the slugs a keep-both moved them to. Projects outside the import are never read.
fn rewrite_references(staging: &Path, work: &[Work], renames: &Renames) -> Result<(), PackError> {
    for project in work
        .iter()
        .filter(|w| w.kind == ItemKind::Project && w.resolution != Resolution::Skip)
    {
        let dir = staged_source(staging, ItemKind::Project, &project.slug);
        let own_slug = (project.target_slug != project.slug).then(|| project.target_slug.clone());
        rewrite_doc(&dir.join("project.json"), renames, own_slug.as_deref())?;

        let Ok(entries) = std::fs::read_dir(dir.join("scenes")) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                rewrite_doc(&path, renames, None)?;
            }
        }
    }
    Ok(())
}

/// Rewrite one staged document, leaving it byte-untouched when nothing pointed at a renamed item.
fn rewrite_doc(path: &Path, renames: &Renames, own_slug: Option<&str>) -> Result<(), PackError> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(mut doc) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    let mut changed = rewrite_value(&mut doc, None, renames);
    if let (Some(slug), Some(map)) = (own_slug, doc.as_object_mut()) {
        map.insert("id".into(), Value::String(slug.to_owned()));
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| PackError::Io(e.to_string()))?;
    std::fs::write(path, pretty + "\n")?;
    Ok(())
}

/// Keys carry the meaning, values carry the target: the `deps.rs` scanning grammar, applied in reverse.
fn rewrite_value(value: &mut Value, key: Option<&str>, renames: &Renames) -> bool {
    match value {
        Value::String(s) => {
            if key == Some("themeId") {
                if let Some(to) = s.strip_prefix("ws:").and_then(|k| renames.themes.get(k)) {
                    *s = format!("ws:{to}");
                    return true;
                }
                return false;
            }
            if key == Some("gradient") {
                if let Some(to) = renames.gradients.get(s.as_str()) {
                    *s = to.clone();
                    return true;
                }
                return false;
            }
            if let Some(to) = s.strip_prefix("ws:").and_then(|k| renames.objects.get(k)) {
                *s = format!("ws:{to}");
                return true;
            }
            false
        }
        // Explicit loops, not `any`: every child must be rewritten, and `any` would stop at the first hit.
        Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= rewrite_value(item, key, renames);
            }
            changed
        }
        Value::Object(map) => {
            let mut changed = false;
            for (k, v) in map.iter_mut() {
                changed |= rewrite_value(v, Some(k.as_str()), renames);
            }
            changed
        }
        _ => false,
    }
}

/// A skipped theme is a real behavioural difference: the incoming project binds to the recipient's theme instead.
fn theme_fallback_notes(root: &Path, manifest: &PackManifest, work: &[Work]) -> Vec<String> {
    let mut notes = Vec::new();
    for theme in work
        .iter()
        .filter(|w| w.kind == ItemKind::Theme && w.resolution == Resolution::Skip)
    {
        let Ok(target) = workspace_target(root, ItemKind::Theme, &theme.slug) else {
            continue;
        };
        if !target.exists() {
            continue;
        }
        let mine = local_name(ItemKind::Theme, &target.path, &theme.slug);
        let reference = format!("ws:{}", theme.slug);
        for project in &manifest.contents.projects {
            if project.theme_id != reference {
                continue;
            }
            let imported = work.iter().any(|w| {
                w.kind == ItemKind::Project
                    && w.slug == project.base.slug
                    && w.resolution != Resolution::Skip
            });
            if imported {
                notes.push(format!(
                    "{} will use your existing {mine} theme.",
                    project.base.name
                ));
            }
        }
    }
    notes
}

type FontPhase = (Vec<ItemResult>, Vec<String>, bool, Option<String>);

/// The font phase. `fonts.json` is rewritten whole by `fonts.rs`; the incumbent bytes are copied aside first, since a
/// replace overwrites them under the same name.
fn apply_fonts(
    root: &Path,
    staging: &Path,
    backup_root: &Path,
    fonts: &[PackFont],
    resolutions: &HashMap<String, Resolution>,
    tick: &mut dyn FnMut(&str),
) -> FontPhase {
    let fonts_dir = root.join(ItemKind::Font.workspace_dir().unwrap_or("fonts"));
    let before = crate::fonts::load_manifest(&fonts_dir);
    let choices: HashMap<String, Resolution> = resolutions
        .iter()
        .filter_map(|(key, value)| {
            key.strip_prefix("font:")
                .map(|key| (key.to_owned(), *value))
        })
        .collect();

    let mut backed_up = false;
    for font in fonts {
        if choices.get(&font.key()) != Some(&Resolution::Replace) {
            continue;
        }
        let Some(pin) = before
            .fonts
            .iter()
            .find(|p| p.family == font.family && p.weight == font.weight)
        else {
            continue;
        };
        let source = fonts_dir.join(&pin.file);
        if source.is_file() && copy_into_backup(backup_root, ItemKind::Font, &source).is_ok() {
            backed_up = true;
        }
    }
    if backed_up {
        let index = fonts_dir.join("fonts.json");
        if index.is_file() {
            let _ = copy_into_backup(backup_root, ItemKind::Font, &index);
        }
    }

    let summary = match apply_font_merge(&fonts_dir, staging, fonts, &choices) {
        Ok(summary) => summary,
        Err(error) => {
            let message = error.user_message();
            let results = fonts
                .iter()
                .map(|font| ItemResult {
                    kind: ItemKind::Font,
                    slug: font.key(),
                    name: font_name(font),
                    outcome: ItemOutcome::Failed,
                    detail: Some(message.clone()),
                })
                .collect();
            return (results, Vec::new(), backed_up, Some("the fonts".into()));
        }
    };

    let mut results = Vec::with_capacity(fonts.len());
    let mut notes = Vec::new();
    for font in fonts {
        let key = font.key();
        tick(&font.family);
        let (outcome, detail) = if summary.written.contains(&key) {
            let existed = before
                .fonts
                .iter()
                .any(|p| p.family == font.family && p.weight == font.weight);
            (
                if existed {
                    ItemOutcome::Replaced
                } else {
                    ItemOutcome::Added
                },
                None,
            )
        } else if summary.referenced.contains(&key) {
            notes.push(format!(
                "{} was not included. Install it to see this project as intended.",
                font.family
            ));
            (ItemOutcome::Skipped, Some("name only".into()))
        } else {
            (ItemOutcome::Skipped, None)
        };
        results.push(ItemResult {
            kind: ItemKind::Font,
            slug: key,
            name: font_name(font),
            outcome,
            detail,
        });
    }
    (results, notes, backed_up, None)
}

fn font_name(font: &PackFont) -> String {
    format!("{} {}", font.family, font.weight)
}

fn apply_one(
    root: &Path,
    staging: &Path,
    backup_root: &Path,
    item: &Work,
) -> Result<(ItemOutcome, bool), PackError> {
    if item.resolution == Resolution::Skip {
        return Ok((ItemOutcome::Skipped, false));
    }
    // The destination is resolved before the source is read, so a hostile slug never reaches the filesystem at all.
    let target = workspace_target(root, item.kind, &item.target_slug)?;
    let source = staged_source(staging, item.kind, &item.slug);
    if !source.exists() {
        return Err(PackError::ManifestEntryMissing(
            source.to_string_lossy().into_owned(),
        ));
    }
    let existed = target.path.exists();
    if existed {
        move_into_backup(backup_root, item.kind, &target.path)?;
    }
    place(&source, &target.path)?;
    if item.kind == ItemKind::Project {
        let _ = std::fs::create_dir_all(target.path.join("exports"));
    }

    let outcome = if item.target_slug != item.slug {
        ItemOutcome::KeptBoth
    } else if existed {
        ItemOutcome::Replaced
    } else {
        ItemOutcome::Added
    };
    Ok((outcome, existed))
}

fn backup_target(backup_root: &Path, kind: ItemKind, source: &Path) -> PathBuf {
    let leaf = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".to_owned());
    backup_root.join(kind.payload_dir()).join(leaf)
}

fn move_into_backup(backup_root: &Path, kind: ItemKind, source: &Path) -> Result<(), PackError> {
    let target = backup_target(backup_root, kind, source);
    place(source, &target)
}

fn copy_into_backup(backup_root: &Path, kind: ItemKind, source: &Path) -> Result<(), PackError> {
    let target = backup_target(backup_root, kind, source);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    copy_tree(source, &target)
}

/// Rename where the volume allows, copy then swap where it does not.
fn place(from: &Path, to: &Path) -> Result<(), PackError> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let leaf = to
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".to_owned());
    let incoming = to.with_file_name(format!(".{leaf}.incoming"));
    remove_any(&incoming);
    copy_tree(from, &incoming)?;
    if let Err(error) = std::fs::rename(&incoming, to) {
        remove_any(&incoming);
        return Err(error.into());
    }
    remove_any(from);
    Ok(())
}

/// Files and directories only: extraction never creates a symlink, so nothing here needs to follow one.
fn copy_tree(from: &Path, to: &Path) -> Result<(), PackError> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)?.flatten() {
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

fn remove_any(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// A name no caller supplies, so one run's backups can never land on another's.
fn run_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    sha256_bytes(&nanos.to_le_bytes())[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack::conflicts::tests::{
        manifest, put_local, scratch, stage_dir_item, stage_file_item, staged_pack, write, FUTURE,
    };
    use crate::pack::model::{PackContents, PackItemBase, PackProject, PackSimpleItem, PackTheme};

    fn resolutions(pairs: &[(ItemKind, &str, Resolution)]) -> HashMap<String, Resolution> {
        pairs
            .iter()
            .map(|(kind, slug, resolution)| (item_key(*kind, slug), *resolution))
            .collect()
    }

    fn project_of(base: PackItemBase, theme_id: &str) -> PackProject {
        PackProject {
            root: format!("payload/projects/{}", base.slug),
            base,
            manifest_version: 2,
            scene_count: 1,
            scene_files: vec!["scenes/01-hero.tsx".into()],
            duration_ms: 2000,
            formats: vec!["16:9".into()],
            theme_id: theme_id.into(),
            requires: Default::default(),
            has_scene_code: true,
        }
    }

    fn theme_of(base: PackItemBase) -> PackTheme {
        PackTheme {
            base,
            mode: "dark".into(),
            doc_version: 2,
            swatches: Vec::new(),
            requires: Default::default(),
        }
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn theme_id_of(path: &Path) -> String {
        serde_json::from_str::<Value>(&read(path))
            .ok()
            .and_then(|doc| {
                doc.get("themeId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default()
    }

    /// A keep-both theme takes the projects that came with it, and nothing else.
    #[test]
    fn keep_both_rewrites_only_the_imported_projects() {
        let root = scratch("kb-root");
        let staging = scratch("kb-staging");

        put_local(
            &root,
            ItemKind::Theme,
            "acme-dark",
            r#"{"version":2,"name":"Acme Dark"}"#,
        );
        put_local(
            &root,
            ItemKind::Project,
            "other-promo",
            r#"{"id":"other-promo","name":"Other","themeId":"ws:acme-dark"}"#,
        );

        let theme = stage_dir_item(
            &staging,
            ItemKind::Theme,
            "acme-dark",
            &[("theme.json", r#"{"version":2,"name":"Acme Dark (theirs)"}"#)],
            FUTURE,
        );
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[
                (
                    "project.json",
                    r#"{"id":"acme-promo","name":"Acme Promo","themeId":"ws:acme-dark"}"#,
                ),
                ("scenes/01-hero.tsx", "export default 1;\n"),
                (
                    "scenes/01-hero.json",
                    r#"{"version":1,"themeId":"ws:acme-dark","text":{"title":"Hi"}}"#,
                ),
            ],
            FUTURE,
        );

        let contents = PackContents {
            themes: vec![theme_of(theme)],
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);

        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[
                (ItemKind::Theme, "acme-dark", Resolution::KeepBoth),
                (ItemKind::Project, "acme-promo", Resolution::Replace),
            ]),
            |_, _, _| {},
        )
        .unwrap();

        assert!(outcome.stopped_at.is_none(), "{:?}", outcome.results);
        assert_eq!(
            read(&root.join("themes/acme-dark/theme.json")),
            r#"{"version":2,"name":"Acme Dark"}"#
        );
        assert!(root.join("themes/acme-dark-2/theme.json").is_file());

        assert_eq!(
            theme_id_of(&root.join("acme-promo/project.json")),
            "ws:acme-dark-2"
        );
        assert_eq!(
            theme_id_of(&root.join("acme-promo/scenes/01-hero.json")),
            "ws:acme-dark-2"
        );
        // A project that was not in this import keeps its own binding.
        assert_eq!(
            theme_id_of(&root.join("other-promo/project.json")),
            "ws:acme-dark"
        );

        let kept = outcome
            .results
            .iter()
            .find(|r| r.kind == ItemKind::Theme)
            .unwrap();
        assert_eq!(kept.outcome, ItemOutcome::KeptBoth);
        assert_eq!(kept.slug, "acme-dark-2");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The recipient's theme wins, so the incoming project silently rebinds unless the summary says so.
    #[test]
    fn a_skipped_theme_names_the_project_that_rebinds() {
        let root = scratch("note-root");
        let staging = scratch("note-staging");
        put_local(
            &root,
            ItemKind::Theme,
            "acme-dark",
            r#"{"version":2,"name":"Acme Dark"}"#,
        );

        let theme = stage_dir_item(
            &staging,
            ItemKind::Theme,
            "acme-dark",
            &[("theme.json", r#"{"version":2,"name":"Theirs"}"#)],
            FUTURE,
        );
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[(
                "project.json",
                r#"{"id":"acme-promo","name":"Acme Promo","themeId":"ws:acme-dark"}"#,
            )],
            FUTURE,
        );
        let mut contents = PackContents {
            themes: vec![theme_of(theme)],
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        contents.projects[0].base.name = "Acme Promo".into();
        let staged = staged_pack(staging.clone(), contents);

        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[
                (ItemKind::Theme, "acme-dark", Resolution::Skip),
                (ItemKind::Project, "acme-promo", Resolution::Replace),
            ]),
            |_, _, _| {},
        )
        .unwrap();

        assert!(outcome
            .notes
            .contains(&"Acme Promo will use your existing Acme Dark theme.".to_owned()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fonts_land_before_projects() {
        let root = scratch("order-root");
        let staging = scratch("order-staging");
        let fonts_dir = root.join("fonts");
        std::fs::create_dir_all(&fonts_dir).unwrap();

        let rel = "payload/fonts/AcmeSans-700.ttf";
        write(&staging.join(rel), "the real bold");
        let font = PackFont {
            base: PackItemBase {
                slug: "Acme Sans@700".into(),
                name: "Acme Sans".into(),
                bytes: 13,
                modified_at: FUTURE.into(),
                content_hash: sha256_bytes(b"the real bold"),
            },
            family: "Acme Sans".into(),
            weight: 700,
            postscript: "AcmeSans-Bold".into(),
            file: Some(rel.into()),
            sha256: Some(sha256_bytes(b"the real bold")),
            instanced: None,
            embedding: crate::pack::model::FontEmbedding::Installable,
            reference_only: None,
        };
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[("project.json", r#"{"id":"acme-promo","name":"Acme Promo"}"#)],
            FUTURE,
        );

        let contents = PackContents {
            fonts: vec![font],
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);

        let mut labels: Vec<String> = Vec::new();
        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[
                (ItemKind::Project, "acme-promo", Resolution::Replace),
                (ItemKind::Font, "Acme Sans@700", Resolution::Replace),
            ]),
            |_, _, label| labels.push(label.to_owned()),
        )
        .unwrap();

        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0], "Acme Sans");
        assert!(labels[1].starts_with("acme-promo"));
        let font_at = outcome
            .results
            .iter()
            .position(|r| r.kind == ItemKind::Font)
            .unwrap();
        let project_at = outcome
            .results
            .iter()
            .position(|r| r.kind == ItemKind::Project)
            .unwrap();
        assert!(font_at < project_at);
        assert_eq!(read(&fonts_dir.join("AcmeSans-Bold.ttf")), "the real bold");
        assert!(root.join("acme-promo/project.json").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The first-time recipient: a workspace that has never pinned a font, so `fonts/` does not exist yet. The font
    /// phase runs first, so anything it refuses stops the whole import before a single project lands.
    #[test]
    fn a_workspace_with_no_fonts_folder_imports_everything() {
        let root = scratch("virgin-root");
        let staging = scratch("virgin-staging");
        assert!(!root.join("fonts").exists());

        let rel = "payload/fonts/MessinaModern-Regular.otf";
        write(&staging.join(rel), "the pinned bytes");
        let font = PackFont {
            base: PackItemBase {
                slug: "Messina Modern@400".into(),
                name: "Messina Modern".into(),
                bytes: 16,
                modified_at: FUTURE.into(),
                content_hash: sha256_bytes(b"the pinned bytes"),
            },
            family: "Messina Modern".into(),
            weight: 400,
            postscript: "MessinaModern-Regular".into(),
            file: Some(rel.into()),
            sha256: Some(sha256_bytes(b"the pinned bytes")),
            instanced: None,
            embedding: crate::pack::model::FontEmbedding::Installable,
            reference_only: None,
        };
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[("project.json", r#"{"id":"acme-promo","name":"Acme Promo"}"#)],
            FUTURE,
        );

        let contents = PackContents {
            fonts: vec![font],
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        let outcome = apply_import(
            &root,
            staged_pack(staging.clone(), contents),
            &resolutions(&[
                (ItemKind::Project, "acme-promo", Resolution::Replace),
                (ItemKind::Font, "Messina Modern@400", Resolution::Replace),
            ]),
            |_, _, _| {},
        )
        .unwrap();

        assert_eq!(outcome.stopped_at, None);
        assert!(outcome
            .results
            .iter()
            .all(|r| r.outcome != ItemOutcome::Failed));
        assert_eq!(
            read(&root.join("fonts/MessinaModern-Regular.otf")),
            "the pinned bytes"
        );
        assert!(root.join("fonts/fonts.json").is_file());
        assert!(root.join("acme-promo/project.json").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_replace_backs_the_incumbent_up_byte_for_byte() {
        let root = scratch("backup-root");
        let staging = scratch("backup-staging");
        let previous = r##"{"version":2,"name":"Acme Dark","colors":{"bg":"#000"}}"##;
        put_local(&root, ItemKind::Theme, "acme-dark", previous);

        let theme = stage_dir_item(
            &staging,
            ItemKind::Theme,
            "acme-dark",
            &[("theme.json", r#"{"version":2,"name":"Acme Dark v2"}"#)],
            FUTURE,
        );
        let contents = PackContents {
            themes: vec![theme_of(theme)],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);

        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[(ItemKind::Theme, "acme-dark", Resolution::Replace)]),
            |_, _, _| {},
        )
        .unwrap();

        assert_eq!(outcome.results[0].outcome, ItemOutcome::Replaced);
        let backup = PathBuf::from(outcome.backup_dir.clone().unwrap());
        assert_eq!(read(&backup.join("themes/acme-dark/theme.json")), previous);
        assert_eq!(
            read(&root.join("themes/acme-dark/theme.json")),
            r#"{"version":2,"name":"Acme Dark v2"}"#
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Stopping is the design: a half-applied import is named, not unwound.
    #[test]
    fn a_failure_part_way_through_reports_both_halves() {
        let root = scratch("fail-root");
        let staging = scratch("fail-staging");
        // A file where the gradients library belongs: the first write of the run cannot land.
        std::fs::write(root.join("gradients"), "not a folder").unwrap();

        let gradient = stage_file_item(&staging, ItemKind::Gradient, "dawn", "{}", FUTURE);
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[("project.json", r#"{"id":"acme-promo","name":"Acme Promo"}"#)],
            FUTURE,
        );
        let contents = PackContents {
            gradients: vec![PackSimpleItem { base: gradient }],
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);
        let staging_root = staging.clone();

        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[
                (ItemKind::Gradient, "dawn", Resolution::Replace),
                (ItemKind::Project, "acme-promo", Resolution::Replace),
            ]),
            |_, _, _| {},
        )
        .unwrap();

        assert!(outcome.stopped_at.unwrap().contains("gradient"));
        assert_eq!(outcome.results[0].kind, ItemKind::Gradient);
        assert_eq!(outcome.results[0].outcome, ItemOutcome::Failed);
        assert_eq!(outcome.results[1].kind, ItemKind::Project);
        assert_eq!(outcome.results[1].outcome, ItemOutcome::Skipped);
        assert_eq!(outcome.results[1].detail.as_deref(), Some("Not attempted"));
        assert!(!root.join("acme-promo").exists());
        assert!(!staging_root.exists(), "the staging tree must not survive");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// F-001: an imported project is untrusted, so the existing gate fires on first open. Nothing here may grant trust.
    #[test]
    fn imported_project_is_not_trusted() {
        let root = scratch("trust-root");
        let staging = scratch("trust-staging");
        let project = stage_dir_item(
            &staging,
            ItemKind::Project,
            "acme-promo",
            &[
                ("project.json", r#"{"id":"acme-promo","name":"Acme Promo"}"#),
                ("scenes/01-hero.tsx", "export default 1;\n"),
            ],
            FUTURE,
        );
        let contents = PackContents {
            projects: vec![project_of(project, "ws:acme-dark")],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);

        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[(ItemKind::Project, "acme-promo", Resolution::Replace)]),
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(outcome.results[0].outcome, ItemOutcome::Added);
        assert!(root.join("acme-promo/project.json").is_file());

        // `is_project_trusted` reads `trusted_projects`, which only a grant writes to and nothing here can reach.
        let settings = crate::workspace::AppSettings::default();
        assert!(!settings.trusted_projects.contains_key("acme-promo"));

        let granted = concat!("trust_", "project");
        assert!(!include_str!("apply.rs").contains(granted));
        assert!(!include_str!("conflicts.rs").contains(granted));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unselected_item_is_never_written_or_reported() {
        let root = scratch("unselected-root");
        let staging = scratch("unselected-staging");
        let gradient = stage_file_item(&staging, ItemKind::Gradient, "dusk", "{}", FUTURE);
        let contents = PackContents {
            gradients: vec![PackSimpleItem { base: gradient }],
            ..Default::default()
        };
        let staged = staged_pack(staging.clone(), contents);

        let outcome = apply_import(&root, staged, &HashMap::new(), |_, _, _| {}).unwrap();
        assert!(outcome.results.is_empty());
        assert!(outcome.backup_dir.is_none());
        assert!(!root.join("gradients/dusk.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_manifest_is_only_read_not_trusted_for_paths() {
        let contents = PackContents {
            themes: vec![theme_of(PackItemBase {
                slug: "../evil".into(),
                name: "Evil".into(),
                bytes: 0,
                modified_at: FUTURE.into(),
                content_hash: String::new(),
            })],
            ..Default::default()
        };
        let root = scratch("escape-root");
        let staging = scratch("escape-staging");
        write(&staging.join("payload/themes/x"), "{}");
        let staged = StagedPack {
            root: staging,
            manifest: manifest(contents),
        };
        let outcome = apply_import(
            &root,
            staged,
            &resolutions(&[(ItemKind::Theme, "../evil", Resolution::Replace)]),
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(outcome.results[0].outcome, ItemOutcome::Failed);
        assert!(outcome.stopped_at.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
}
