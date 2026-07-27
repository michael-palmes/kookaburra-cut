//! The IPC surface for packs. Every command re-resolves server side: a frontend-supplied file list is never trusted, and
//! the Save dialog's path is re-validated here before a single byte is written.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::deps::{self, AssetGroup, ClosureFile, HashMode, PackSelection};
use super::error::PackError;
use super::limits::{MAX_SOURCE_VIEW_BYTES, PACK_EXTENSION};
use super::model::*;
use super::read::{self, StagedPack};
use super::write::{self, PackEntry};
use super::{key, publisher};

use crate::workspace::{self, SettingsState};

// ---------------------------------------------------------------- shared state

#[derive(Default)]
pub struct PackState {
    cancel: Arc<AtomicBool>,
    staged: Mutex<Option<StagedPack>>,
    /// The full picker catalogue, scanned once. Without it, ticking one project would hide every other project, since a
    /// closure only ever contains what the selection reaches.
    catalogue: Mutex<Option<Vec<SelectableItem>>>,
    /// The last pack this app wrote. `reveal_in_finder` confines paths to the workspace, and the Save dialog can point
    /// anywhere, so revealing a pack means revealing a path WE chose rather than one the frontend supplies.
    last_built: Mutex<Option<PathBuf>>,
}

impl PackState {
    fn reset_cancel(&self) -> Arc<AtomicBool> {
        self.cancel.store(false, Ordering::SeqCst);
        self.cancel.clone()
    }
}

// ------------------------------------------------------------------ wire types

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectableItem {
    kind: ItemKind,
    slug: String,
    name: String,
    bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    required_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embedding: Option<FontEmbedding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_only: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreferencedGroup {
    project_slug: String,
    label: String,
    files: Vec<UnreferencedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreferencedFile {
    rel: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPlanView {
    items: Vec<SelectableItem>,
    unreferenced: Vec<UnreferencedGroup>,
    warnings: Vec<String>,
    total_bytes: u64,
    file_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMetaInput {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PackProgress {
    file: usize,
    total: usize,
    bytes: u64,
    total_bytes: u64,
    stage: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInspectionView {
    manifest: PackManifest,
    signature: &'static str,
    publisher: publisher::PublisherVerdict,
    compatibility: CompatibilityView,
    archive_bytes: u64,
    install_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CompatibilityView {
    Ok,
    NeedsNewerApp { min: String },
}

// ------------------------------------------------------------------- export

fn closure_to_view(closure: &deps::Closure) -> PackPlanView {
    let mut items = Vec::new();
    let required = |kind: ItemKind, key: &str| -> Vec<String> {
        closure
            .required_by
            .get(&deps::item_key(kind, key))
            .cloned()
            .unwrap_or_default()
    };

    for p in &closure.contents.projects {
        items.push(SelectableItem {
            kind: ItemKind::Project,
            slug: p.base.slug.clone(),
            name: p.base.name.clone(),
            bytes: p.base.bytes,
            detail: Some(format!(
                "{} scene{} · {}",
                p.scene_count,
                if p.scene_count == 1 { "" } else { "s" },
                p.formats.join(", ")
            )),
            required_by: required(ItemKind::Project, &p.base.slug),
            embedding: None,
            reference_only: None,
        });
    }
    for t in &closure.contents.themes {
        items.push(SelectableItem {
            kind: ItemKind::Theme,
            slug: t.base.slug.clone(),
            name: t.base.name.clone(),
            bytes: t.base.bytes,
            detail: Some(t.mode.clone()),
            required_by: required(ItemKind::Theme, &t.base.slug),
            embedding: None,
            reference_only: None,
        });
    }
    for f in &closure.contents.fonts {
        let key = f.key();
        items.push(SelectableItem {
            kind: ItemKind::Font,
            slug: key.clone(),
            name: format!("{} {}", f.family, f.weight),
            bytes: f.base.bytes,
            detail: Some(f.postscript.clone()),
            required_by: required(ItemKind::Font, &key),
            embedding: Some(f.embedding),
            reference_only: f.reference_only,
        });
    }
    for o in &closure.contents.objects {
        items.push(SelectableItem {
            kind: ItemKind::Object,
            slug: o.base.slug.clone(),
            name: o.base.name.clone(),
            bytes: o.base.bytes,
            detail: o.licence.clone(),
            required_by: required(ItemKind::Object, &o.base.slug),
            embedding: None,
            reference_only: None,
        });
    }
    for (kind, list) in [
        (ItemKind::Gradient, &closure.contents.gradients),
        (ItemKind::ExportPreset, &closure.contents.export_presets),
    ] {
        for g in list {
            items.push(SelectableItem {
                kind,
                slug: g.base.slug.clone(),
                name: g.base.name.clone(),
                bytes: g.base.bytes,
                detail: None,
                required_by: required(kind, &g.base.slug),
                embedding: None,
                reference_only: None,
            });
        }
    }
    for s in &closure.contents.screenshots {
        items.push(SelectableItem {
            kind: ItemKind::Screenshot,
            slug: s.base.slug.clone(),
            name: s.base.name.clone(),
            bytes: s.base.bytes,
            detail: match (s.width, s.height) {
                (Some(w), Some(h)) => Some(format!("{w} × {h}")),
                _ => None,
            },
            required_by: required(ItemKind::Screenshot, &s.base.slug),
            embedding: None,
            reference_only: None,
        });
    }

    // Reviewed, never silently dropped: the picker shows these with their size.
    let mut groups: Vec<UnreferencedGroup> = Vec::new();
    for asset in &closure.reviewed_assets {
        let label = match asset.group {
            AssetGroup::Unreferenced => "Unused files",
            AssetGroup::FlattenedRender => "Flattened edit renders",
        };
        match groups
            .iter_mut()
            .find(|g| g.project_slug == asset.project && g.label == label)
        {
            Some(group) => group.files.push(UnreferencedFile {
                rel: asset.rel.clone(),
                bytes: asset.bytes,
            }),
            None => groups.push(UnreferencedGroup {
                project_slug: asset.project.clone(),
                label: label.into(),
                files: vec![UnreferencedFile {
                    rel: asset.rel.clone(),
                    bytes: asset.bytes,
                }],
            }),
        }
    }

    PackPlanView {
        items,
        unreferenced: groups,
        warnings: closure.warnings.iter().map(|w| w.message()).collect(),
        total_bytes: closure.totals.bytes,
        file_count: closure.totals.files,
    }
}

/// Every slug in the workspace, so the catalogue scan reaches everything rather than only what a selection touches.
fn enumerate_all(root: &Path) -> PackSelection {
    let dirs_with = |sub: &str, marker: &str| -> Vec<String> {
        let base = if sub.is_empty() {
            root.to_path_buf()
        } else {
            root.join(sub)
        };
        std::fs::read_dir(base)
            .map(|read| {
                read.flatten()
                    .filter(|e| e.path().is_dir() && e.path().join(marker).is_file())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|slug| workspace::validate_slug(slug).is_ok())
                    .collect()
            })
            .unwrap_or_default()
    };
    let files_in = |sub: &str, ext: Option<&str>| -> Vec<String> {
        std::fs::read_dir(root.join(sub))
            .map(|read| {
                read.flatten()
                    .filter(|e| e.path().is_file())
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        match ext {
                            Some(want) => name
                                .strip_suffix(&format!(".{want}"))
                                .map(|stem| stem.to_string()),
                            None => Some(name),
                        }
                    })
                    .filter(|name| !name.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default()
    };

    // Pinned faces only: bundled families ship with the app and are recorded in no pack.
    let fonts = crate::fonts::load_manifest(&root.join("fonts"))
        .fonts
        .iter()
        .filter(|f| !crate::pack::fonts::is_bundled_family(&f.family))
        .map(|f| format!("{}@{}", f.family, f.weight))
        .collect();

    PackSelection {
        projects: dirs_with("", "project.json"),
        themes: dirs_with("themes", "theme.json"),
        fonts,
        objects: dirs_with("objects", "object.json"),
        gradients: files_in("gradients", Some("json")),
        export_presets: files_in("export-presets", Some("json")),
        screenshots: files_in("screenshots", None),
        exclude: Vec::new(),
        include_flattened_renders: true,
        include_unreferenced_assets: true,
    }
}

/// Everything the picker can offer, before anything is selected. Scanned once and cached.
#[tauri::command]
pub async fn list_packables(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    state: State<'_, PackState>,
) -> Result<PackPlanView, String> {
    let root = workspace::require_root(&app, &settings)?;
    let closure = deps::resolve_closure_with(&root, &enumerate_all(&root), HashMode::Names)?;
    let view = closure_to_view(&closure);
    if let Ok(mut cache) = state.catalogue.lock() {
        *cache = Some(view.items.clone());
    }
    Ok(view)
}

/// The catalogue stays whole; only `requiredBy` changes with the selection.
#[tauri::command]
pub async fn plan_pack(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    state: State<'_, PackState>,
    selection: PackSelection,
) -> Result<PackPlanView, String> {
    let root = workspace::require_root(&app, &settings)?;
    let closure = deps::resolve_closure_with(&root, &selection, HashMode::Names)?;
    let mut view = closure_to_view(&closure);

    let cached = state.catalogue.lock().ok().and_then(|c| c.clone());
    if let Some(catalogue) = cached {
        let closure_items = std::mem::take(&mut view.items);
        view.items = catalogue
            .into_iter()
            .map(|mut item| {
                item.required_by = closure_items
                    .iter()
                    .find(|c| c.kind == item.kind && c.slug == item.slug)
                    .map(|c| c.required_by.clone())
                    .unwrap_or_default();
                item
            })
            .collect();
    }
    Ok(view)
}

/// The Save dialog is the app's first, and it breaks the "paths are computed in Rust" rule deliberately, so the path is
/// re-validated here: right extension, absolute, writable parent, and nowhere near the app bundle or a system directory.
fn validate_destination(app: &AppHandle, raw: &str) -> Result<PathBuf, PackError> {
    let mut path = PathBuf::from(raw);
    if path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        != Some(PACK_EXTENSION.into())
    {
        path.set_extension(PACK_EXTENSION);
    }
    if !path.is_absolute() {
        return Err(PackError::DestinationInvalid(
            "the path is not absolute".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| PackError::DestinationInvalid("the path has no folder".into()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| PackError::DestinationInvalid(format!("{} ({e})", parent.display())))?;
    if !canonical_parent.is_dir() {
        return Err(PackError::DestinationInvalid("that is not a folder".into()));
    }
    for forbidden in [
        "/System",
        "/Library",
        "/usr",
        "/bin",
        "/sbin",
        "/private/var/db",
    ] {
        if canonical_parent.starts_with(forbidden) {
            return Err(PackError::DestinationInvalid(format!(
                "{forbidden} is a system folder"
            )));
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        if let Ok(data) = data.canonicalize() {
            if canonical_parent.starts_with(&data) {
                return Err(PackError::DestinationInvalid(
                    "that is inside Kookaburra Cut's own data folder".into(),
                ));
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bundle) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            if let Ok(bundle) = bundle.canonicalize() {
                if bundle.extension().map(|e| e == "app").unwrap_or(false)
                    && canonical_parent.starts_with(&bundle)
                {
                    return Err(PackError::DestinationInvalid(
                        "that is inside the application itself".into(),
                    ));
                }
            }
        }
    }
    let probe = canonical_parent.join(".kookaburra-write-probe");
    std::fs::write(&probe, b"")
        .map_err(|_| PackError::DestinationInvalid("that folder is not writable".into()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(canonical_parent.join(path.file_name().unwrap_or_default()))
}

#[tauri::command]
pub async fn build_pack(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    state: State<'_, PackState>,
    selection: PackSelection,
    destination: String,
    meta: PackMetaInput,
    on_progress: Channel<PackProgress>,
) -> Result<BuildResult, String> {
    let root = workspace::require_root(&app, &settings)?;
    let out = validate_destination(&app, &destination)?;
    let cancel = state.reset_cancel();

    // Re-resolve server side: the frontend's file list is never trusted.
    let closure = deps::resolve_closure(&root, &selection)?;
    if closure.files.is_empty() {
        return Err("There is nothing in this selection to export.".into());
    }

    let total = closure.files.len();
    let mut files = Vec::with_capacity(total);
    let mut total_bytes = 0u64;
    for (index, file) in closure.files.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(PackError::Cancelled.into());
        }
        let ClosureFile {
            archive_path,
            sha256,
            bytes,
            ..
        } = file;
        files.push(PackFile {
            path: archive_path.clone(),
            sha256: sha256.clone(),
            bytes: *bytes,
        });
        total_bytes += bytes;
        let _ = on_progress.send(PackProgress {
            file: index + 1,
            total,
            bytes: total_bytes,
            total_bytes: closure.totals.bytes,
            stage: "hashing",
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let publisher_block = publisher::manifest_publisher(&app, &settings)?;
    let manifest = PackManifest {
        format: PACK_FORMAT.into(),
        format_version: PACK_FORMAT_VERSION,
        app_version: app.package_info().version.to_string(),
        min_app_version: PACK_MIN_APP_VERSION.into(),
        pack: PackMeta {
            name: meta.name.trim().into(),
            description: meta
                .description
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty()),
            created_at: super::scan::rfc3339(std::time::SystemTime::now()),
        },
        publisher: publisher_block,
        contents: closure.contents.clone(),
        totals: PackTotals {
            files: files.len(),
            bytes: total_bytes,
        },
        files,
    };

    // Sign the EXACT bytes we store, so verification never depends on JSON re-serialisation being stable.
    let manifest_json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    let signature = key::sign_manifest(&app, &manifest_json)?;

    let entries: Vec<PackEntry> = closure
        .files
        .iter()
        .map(|f| PackEntry {
            archive_path: f.archive_path.clone(),
            source: f.source.clone(),
        })
        .collect();

    let cancelled = cancel.clone();
    let summary = write::write_pack(
        &out,
        &manifest_json,
        &signature,
        &entries,
        |file, total| {
            let _ = on_progress.send(PackProgress {
                file,
                total,
                bytes: 0,
                total_bytes: 0,
                stage: "writing",
            });
        },
        &move || cancelled.load(Ordering::SeqCst),
    )?;

    if let Ok(mut last) = state.last_built.lock() {
        *last = Some(summary.path.clone());
    }
    Ok(BuildResult {
        path: summary.path.to_string_lossy().into_owned(),
        bytes: summary.bytes,
    })
}

/// Reveal the pack this app just wrote. Takes no path: the Save dialog can point outside the workspace, which
/// `reveal_in_finder` rightly refuses, so the only safe reveal is the one destination we validated and wrote ourselves.
#[tauri::command]
pub fn reveal_pack(state: State<'_, PackState>) -> Result<(), String> {
    let path = state
        .last_built
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .ok_or("There is no pack to show yet.")?;
    if !path.is_file() {
        return Err(format!("{} has moved or been deleted.", path.display()));
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_pack_build(state: State<'_, PackState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

// ------------------------------------------------------------------- import

#[tauri::command]
pub async fn inspect_pack(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    path: String,
) -> Result<PackInspectionView, String> {
    let archive = Path::new(&path);
    crate::packs_win::validate_incoming(archive)?;
    let running = app.package_info().version.to_string();
    let inspection = read::inspect(archive)?;

    let signature = match &inspection.signature {
        None => "missing",
        Some(sig) => {
            if key::verify_manifest(
                &inspection.manifest.publisher.public_key,
                &inspection.manifest_bytes,
                sig,
            ) {
                "valid"
            } else {
                "invalid"
            }
        }
    };

    let settings_now = workspace::load_settings(&app, &settings)?;
    let verdict = publisher::publisher_verdict(
        &settings_now.known_publishers,
        &inspection.manifest.publisher,
    );
    let install_bytes = inspection.manifest.files.iter().map(|f| f.bytes).sum();

    // A pack for a newer app gets its own screen (with Check for Updates) rather than a generic failure.
    let compatibility = if read::version_lt(&running, &inspection.manifest.min_app_version) {
        CompatibilityView::NeedsNewerApp {
            min: inspection.manifest.min_app_version.clone(),
        }
    } else {
        CompatibilityView::Ok
    };

    Ok(PackInspectionView {
        manifest: inspection.manifest,
        signature,
        publisher: verdict,
        compatibility,
        archive_bytes: inspection.archive_bytes,
        install_bytes,
    })
}

#[tauri::command]
pub async fn read_pack_scene_source(
    path: String,
    project_slug: String,
    scene_file: String,
) -> Result<String, String> {
    let archive = Path::new(&path);
    crate::packs_win::validate_incoming(archive)?;
    workspace::validate_slug(&project_slug)?;
    let inspection = read::inspect(archive)?;
    // `sceneFile` is project-relative ("scenes/01-intro.tsx"); validate_archive_path is the gate, not this join.
    let entry = format!("payload/projects/{project_slug}/{scene_file}");
    Ok(read::read_entry(
        archive,
        &inspection.manifest,
        &entry,
        MAX_SOURCE_VIEW_BYTES,
    )?)
}

/// Extract and plan. Deliberately called from the CONTENTS screen, not earlier: nothing is written to disk until the
/// user has seen what is inside.
#[tauri::command]
pub async fn stage_pack(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    state: State<'_, PackState>,
    path: String,
    selection: PackSelection,
    on_progress: Channel<PackProgress>,
) -> Result<super::conflicts::ImportPlan, String> {
    let archive = Path::new(&path);
    crate::packs_win::validate_incoming(archive)?;
    let root = workspace::require_root(&app, &settings)?;
    let running = app.package_info().version.to_string();

    let inspection = read::inspect(archive)?;
    if read::version_lt(&running, &inspection.manifest.min_app_version) {
        return Err(PackError::AppTooOld {
            needs: inspection.manifest.min_app_version.clone(),
            running,
        }
        .into());
    }
    // Never stage a pack whose signature does not hold, whatever the UI thinks it saw earlier.
    let Some(signature) = &inspection.signature else {
        return Err(PackError::SignatureMissing.into());
    };
    if !key::verify_manifest(
        &inspection.manifest.publisher.public_key,
        &inspection.manifest_bytes,
        signature,
    ) {
        return Err(PackError::SignatureInvalid.into());
    }

    let cancel = state.reset_cancel();
    let cancelled = cancel.clone();
    let staged = read::stage(
        archive,
        &root,
        &inspection.manifest,
        |bytes, total_bytes| {
            let _ = on_progress.send(PackProgress {
                file: 0,
                total: 0,
                bytes,
                total_bytes,
                stage: "unpacking",
            });
        },
        &move || cancelled.load(Ordering::SeqCst),
    )?;

    let plan = super::conflicts::plan_conflicts(&root, &staged, &selection)?;
    if let Ok(mut guard) = state.staged.lock() {
        *guard = Some(staged);
    }
    Ok(plan)
}

#[tauri::command]
pub async fn apply_import(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    state: State<'_, PackState>,
    resolutions: std::collections::HashMap<String, Resolution>,
    on_progress: Channel<PackProgress>,
) -> Result<super::apply::ImportOutcome, String> {
    let root = workspace::require_root(&app, &settings)?;
    let staged = state
        .staged
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .ok_or("There is no pack waiting to be imported.")?;

    let publisher_block = staged.manifest.publisher.clone();
    let pack_name = staged.manifest.pack.name.clone();

    let outcome = super::apply::apply_import(&root, staged, &resolutions, |done, total, label| {
        let _ = on_progress.send(PackProgress {
            file: done,
            total,
            bytes: 0,
            total_bytes: 0,
            stage: "applying",
        });
        let _ = label;
    })?;

    // Trust on first use is recorded only after something actually landed.
    if outcome.results.iter().any(|r| {
        matches!(
            r.outcome,
            super::apply::ItemOutcome::Added
                | super::apply::ItemOutcome::Replaced
                | super::apply::ItemOutcome::KeptBoth
        )
    }) {
        if let Err(e) = publisher::remember_publisher(&app, &settings, &publisher_block, &pack_name)
        {
            eprintln!("[packs] recording the publisher failed: {e}");
        }
    }

    // The main window rescans rather than restarting: new projects, themes and fonts appear straight away.
    use tauri::Emitter;
    let _ = app.emit("kookaburra://workspace-changed", ());
    Ok(outcome)
}

#[tauri::command]
pub fn discard_staged_pack(state: State<'_, PackState>) {
    // Dropping the StagedPack removes its tree.
    if let Ok(mut guard) = state.staged.lock() {
        *guard = None;
    }
}

/// The EFFECTIVE workspace root, honouring `KOOKABURRA_WORKSPACE_ROOT`. The round-trip gate needs somewhere inside it to
/// write a pack, and `get_settings` would report the configured root rather than the override.
#[tauri::command]
pub fn workspace_root_path(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<String, String> {
    Ok(workspace::require_root(&app, &settings)?
        .to_string_lossy()
        .into_owned())
}

/// Open an imported project in the main window. It is untrusted by construction, so F-001 fires there, not here.
#[tauri::command]
pub fn open_imported_project(app: AppHandle, slug: String) -> Result<(), String> {
    workspace::validate_slug(&slug)?;
    use tauri::Emitter;
    let _ = app.emit_to("main", "kookaburra://open-project", format!("ws:{slug}"));
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(())
}
