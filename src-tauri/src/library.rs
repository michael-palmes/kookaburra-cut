//! The template and preset libraries: a template is a whole project folder carrying `template.json`, a preset is a single-scene project folder carrying `preset.json`, and both live either in the checkout (`projects/`, `presets/`) or in the user's workspace (`templates/`, `presets/`). These commands only move folders and text: every manifest schema is owned by the frontend (`src/engine/templates.ts`, `src/engine/presets.ts`), exactly as themes and export presets are. Writes into the CHECKOUT are dev-only (`#[cfg(debug_assertions)]`, registered conditionally in `lib.rs`), so a release binary carries no repo-write surface at all.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::workspace::{
    self, manifest_summary, presets_dir, presets_root, require_root, slugify, templates_dir,
    templates_root, validate_slug, SettingsState, MANIFEST_FILENAME,
};

/// The user-template folder inside the workspace root; reserved as a project slug (a project named "templates" would shadow it).
pub const TEMPLATES_DIR_NAME: &str = "templates";
/// The user-preset folder inside the workspace root; reserved for the same reason.
pub const PRESETS_DIR_NAME: &str = "presets";

/// The file that marks a folder as a template; packs use it the way they use `theme.json`.
pub const TEMPLATE_MANIFEST: &str = "template.json";
/// The file that marks a folder as a scene preset.
pub const PRESET_MANIFEST: &str = "preset.json";

/// Card art beside an item's manifest, in the order the listing looks for it (converted templates carry the project snapshot, which is a PNG).
const POSTER_NAMES: [&str; 2] = ["poster.png", "poster.jpg"];

/// Where the bundled theme documents live in the checkout, relative to the repo root.
const BUILTIN_THEMES_REL: &str = "src/theme/builtin";

/// Scene length a preset falls back to when the source project's manifest entry carries none (mirrors `scene_doc`'s default).
const DEFAULT_SCENE_DURATION_MS: u64 = 4000;

/// The aspect set a preset declares when its source project names none.
const DEFAULT_FORMATS: [&str; 4] = ["16:9", "9:16", "1:1", "4:5"];

/// One library item as listed to the frontend: the two documents verbatim plus the facts only native can cheaply derive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemInfo {
    pub slug: String,
    pub path: String,
    /// The raw `template.json` / `preset.json` text, parsed and validated frontend-side.
    pub manifest_json: String,
    /// The sibling `project.json` text, the same one the project loader reads.
    pub project_json: String,
    pub duration_ms: u64,
    pub scene_count: usize,
    pub poster_path: Option<String>,
    pub poster_modified_at: Option<u64>,
}

/// One `{ slug, order }` pair of a drag-reorder batch.
#[derive(Debug, Clone, Deserialize)]
pub struct OrderEntry {
    pub slug: String,
    pub order: i64,
}

/// The theme flavour of `OrderEntry`: themes are addressed by id, not by folder slug. Only the dev-only builtin reorder takes one, so release builds never see it.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct ThemeOrderEntry {
    pub id: String,
    pub order: i64,
}

// Which library a command is working in; everything below is written once and shared by both.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Template,
    Preset,
}

impl Kind {
    fn manifest(self) -> &'static str {
        match self {
            Kind::Template => TEMPLATE_MANIFEST,
            Kind::Preset => PRESET_MANIFEST,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Template => "template",
            Kind::Preset => "preset",
        }
    }

    /// The checkout/resource tree the bundled items of this kind live in.
    fn bundled_root(self, app: &AppHandle) -> PathBuf {
        match self {
            Kind::Template => templates_root(app),
            Kind::Preset => presets_root(app),
        }
    }

    fn workspace_dir(self, root: &Path) -> PathBuf {
        match self {
            Kind::Template => templates_dir(root),
            Kind::Preset => presets_dir(root),
        }
    }
}

/// Atomic JSON write (the `write_theme` contract): tmp + rename, so a crash mid-save can never leave half a manifest.
fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} isn't valid JSON: {e}", path.display()))
}

/// Read one library item's folder into its listing shape; `None` when either document is missing or unreadable, which is how a half-written folder stays out of the library instead of failing the whole listing.
fn read_item(dir: &Path, slug: &str, kind: Kind) -> Option<LibraryItemInfo> {
    let manifest_json = std::fs::read_to_string(dir.join(kind.manifest())).ok()?;
    let project_json = std::fs::read_to_string(dir.join(MANIFEST_FILENAME)).ok()?;
    let scene_count = serde_json::from_str::<Value>(&project_json)
        .ok()
        .and_then(|doc| {
            doc.get("scenes")
                .and_then(Value::as_array)
                .map(|scenes| scenes.len())
        })
        .unwrap_or(0);
    let poster = POSTER_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file());
    let poster_modified_at = poster.as_ref().and_then(|path| {
        std::fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis() as u64)
    });
    Some(LibraryItemInfo {
        slug: slug.to_owned(),
        path: dir.to_string_lossy().into_owned(),
        manifest_json,
        project_json,
        duration_ms: manifest_summary(dir).map(|(_, ms, _)| ms).unwrap_or(0),
        scene_count,
        poster_path: poster.map(|path| path.to_string_lossy().into_owned()),
        poster_modified_at,
    })
}

fn require_item(dir: &Path, slug: &str, kind: Kind) -> Result<LibraryItemInfo, String> {
    read_item(dir, slug, kind).ok_or_else(|| format!("no {} named \"{slug}\"", kind.label()))
}

fn list_library(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    kind: Kind,
) -> Result<Vec<LibraryItemInfo>, String> {
    let dir = kind.workspace_dir(&require_root(app, state)?);
    let mut items = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(items); // no folder yet; an empty library, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !path.is_dir() || slug.starts_with('.') {
            continue;
        }
        if let Some(item) = read_item(&path, &slug, kind) {
            items.push(item);
        }
    }
    items.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(items)
}

/// First free folder name for `name` under `dir`: the slug itself, then `-2`, `-3`, … (the `import_object` rule).
fn free_slug(dir: &Path, name: &str, fallback: &str) -> Result<String, String> {
    let mut base = slugify(name);
    if base.is_empty() {
        base = fallback.to_owned();
    }
    validate_slug(&base)?;
    let mut slug = base.clone();
    let mut n = 1u32;
    while dir.join(&slug).exists() {
        n += 1;
        slug = format!("{base}-{n}");
    }
    Ok(slug)
}

/// A library item's own folder inside the workspace, hardened the way every workspace command is: the slug is validated, so the join can only land one level under the library dir.
fn workspace_item_dir(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    kind: Kind,
    slug: &str,
) -> Result<PathBuf, String> {
    validate_slug(slug)?;
    Ok(kind.workspace_dir(&require_root(app, state)?).join(slug))
}

/// The manifest `name`, falling back to the folder slug.
fn manifest_name(dir: &Path, kind: Kind, slug: &str) -> String {
    std::fs::read_to_string(dir.join(kind.manifest()))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|doc| {
            doc.get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| slug.to_owned())
}

// ── Listing ────────────────────────────────────────────────────────────────

/// The user's own templates (`<workspaceRoot>/templates/*/`), merged with the bundled catalogue frontend-side.
#[tauri::command]
pub fn list_user_templates(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<LibraryItemInfo>, String> {
    list_library(&app, &state, Kind::Template)
}

/// The user's own scene presets (`<workspaceRoot>/presets/*/`).
#[tauri::command]
pub fn list_user_presets(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<LibraryItemInfo>, String> {
    list_library(&app, &state, Kind::Preset)
}

// ── Creating user items ────────────────────────────────────────────────────

/// Snapshot a workspace project into `<workspaceRoot>/templates/<slug>/`: `project.json`, `scenes/` and `assets/` copy verbatim (a template is a project folder plus a manifest), the project's welcome-screen snapshot becomes the card poster when it has one, and a minimal manifest lands for the details modal to fill in.
#[tauri::command]
pub fn convert_project_to_template(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<LibraryItemInfo, String> {
    validate_slug(&slug)?;
    let root = require_root(&app, &state)?;
    convert_project(
        &root.join(&slug),
        &templates_dir(&root),
        &workspace::snapshot_file(&root, &slug),
    )
}

fn convert_project(
    source: &Path,
    library: &Path,
    snapshot: &Path,
) -> Result<LibraryItemInfo, String> {
    if !source.join(MANIFEST_FILENAME).is_file() {
        return Err("that folder is not a project".to_owned());
    }
    let fallback = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("template")
        .to_owned();
    let (name, _, _) = manifest_summary(source).unwrap_or((fallback, 0, None));

    std::fs::create_dir_all(library).map_err(|e| e.to_string())?;
    let slug = free_slug(library, &name, "template")?;
    let dir = library.join(&slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    std::fs::copy(source.join(MANIFEST_FILENAME), dir.join(MANIFEST_FILENAME))
        .map_err(|e| format!("copying project.json: {e}"))?;
    for sub in ["scenes", "assets", "edits"] {
        let from = source.join(sub);
        if from.is_dir() {
            workspace::copy_dir_recursive(&from, &dir.join(sub))?;
        }
    }
    if snapshot.is_file() {
        let _ = std::fs::copy(snapshot, dir.join("poster.png"));
    }

    atomic_write_json(
        &dir.join(TEMPLATE_MANIFEST),
        &starter_template_manifest(&name),
    )?;
    require_item(&dir, &slug, Kind::Template)
}

/// The manifest a converted template starts from: everything the schema demands, nothing the user has not told us yet (the details modal writes the rest).
fn starter_template_manifest(name: &str) -> Value {
    serde_json::json!({
        "version": 1,
        "name": name,
        "tagline": "",
        "tags": [],
        "personas": [],
        "level": "standard",
        "tier": "safe",
        "uses": [],
        "preview": { "poster": 1, "frames": [0, 0, 0, 0] },
        "order": 10,
        "status": "stable",
        "source": "user",
    })
}

fn starter_preset_manifest(name: &str) -> Value {
    serde_json::json!({
        "version": 1,
        "name": name,
        "tagline": "",
        "tags": [],
        "order": 10,
        "status": "stable",
        "preview": { "scene": 0, "atMs": 1500 },
        "source": "user",
    })
}

/// Save one scene as a reusable preset: the TSX and its sidecar copy verbatim into a fresh single-scene project folder, only the `assets/` files those two texts actually name travel with them, and the project manifest inherits the source project's theme so the preset opens looking like it did.
#[tauri::command]
pub fn save_scene_as_preset(
    app: AppHandle,
    state: State<'_, SettingsState>,
    project_slug: String,
    scene_stem: String,
) -> Result<LibraryItemInfo, String> {
    let root = require_root(&app, &state)?;
    let source = workspace::project_dir(&app, &state, &project_slug)?;
    let item = save_preset(&source, &presets_dir(&root), &scene_stem)?;
    if matches!(
        workspace::parse_project_id(&project_slug)?.0,
        workspace::ProjectScope::BundledPreset | workspace::ProjectScope::BundledTemplate
    ) {
        workspace::copy_missing_sample_assets(
            &workspace::samples_root(&app),
            &Path::new(&item.path).join("assets"),
        )?;
    }
    Ok(item)
}

fn save_preset(source: &Path, library: &Path, scene_stem: &str) -> Result<LibraryItemInfo, String> {
    validate_slug(scene_stem)?;
    let file = format!("scenes/{scene_stem}.tsx");
    let tsx =
        std::fs::read_to_string(source.join(&file)).map_err(|e| format!("reading {file}: {e}"))?;
    let doc_file = format!("scenes/{scene_stem}.json");
    let doc_text = match std::fs::read_to_string(source.join(&doc_file)) {
        Ok(text) => {
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("{doc_file} isn't valid JSON: {e}"))?;
            Some(text)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("reading {doc_file}: {error}")),
    };

    let source_manifest = read_json(&source.join(MANIFEST_FILENAME))?;
    let scene = source_manifest
        .get("scenes")
        .and_then(Value::as_array)
        .and_then(|scenes| {
            scenes
                .iter()
                .find(|scene| scene.get("file") == Some(&Value::String(file.clone())))
        })
        .ok_or_else(|| format!("project.json does not contain {file}"))?;
    let name = doc_text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|doc| {
            doc.get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            // The frontend's own fallback: the stem minus its numeric prefix.
            scene_stem
                .split_once('-')
                .map_or(scene_stem, |(_, rest)| rest)
                .replace('-', " ")
        });

    std::fs::create_dir_all(library).map_err(|e| e.to_string())?;
    let slug = free_slug(library, &name, "preset")?;
    let dir = library.join(&slug);
    std::fs::create_dir_all(dir.join("scenes")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;

    std::fs::write(dir.join(&file), &tsx).map_err(|e| e.to_string())?;
    if let Some(text) = &doc_text {
        std::fs::write(dir.join(&doc_file), text).map_err(|e| e.to_string())?;
    }
    copy_referenced_assets(source, &dir, &tsx, doc_text.as_deref())?;

    let duration_ms = scene_duration_ms(&source_manifest, &file);
    let mut project = serde_json::json!({
        "id": slug,
        "name": name,
        "version": 2,
        "themeId": source_manifest
            .get("themeId")
            .and_then(Value::as_str)
            .unwrap_or("kookaburra-default"),
        "formats": source_manifest
            .get("formats")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(DEFAULT_FORMATS)),
        "scenes": [{ "file": file, "durationMs": duration_ms }],
    });
    for field in ["typography", "lighting", "render", "frame"] {
        if let Some(value) = source_manifest.get(field) {
            project[field] = value.clone();
        }
    }
    if let Some(effects) = scene.get("effects") {
        project["scenes"][0]["effects"] = effects.clone();
    }
    copy_referenced_assets(source, &dir, "", Some(&project.to_string()))?;
    atomic_write_json(&dir.join(MANIFEST_FILENAME), &project)?;
    atomic_write_json(&dir.join(PRESET_MANIFEST), &starter_preset_manifest(&name))?;
    require_item(&dir, &slug, Kind::Preset)
}

/// The manifest's `durationMs` for one scene file.
fn scene_duration_ms(manifest: &Value, file: &str) -> u64 {
    manifest
        .get("scenes")
        .and_then(Value::as_array)
        .and_then(|scenes| {
            scenes
                .iter()
                .find(|scene| scene.get("file").and_then(Value::as_str) == Some(file))
        })
        .and_then(|scene| scene.get("durationMs").and_then(Value::as_u64))
        .unwrap_or(DEFAULT_SCENE_DURATION_MS)
}

/// Copy just the `assets/` files the scene's two texts name; a reference to something the source project no longer has is skipped, exactly as `copy_scene_assets` skips it.
fn copy_referenced_assets(
    source: &Path,
    dest: &Path,
    tsx: &str,
    doc_text: Option<&str>,
) -> Result<(), String> {
    let mut refs = crate::scene_doc::scan_asset_refs(tsx);
    let doc_refs = doc_text
        .map(|text| {
            serde_json::from_str::<Value>(text)
                .map_err(|e| format!("asset document isn't valid JSON: {e}"))
        })
        .transpose()?
        .as_ref()
        .map(crate::scene_doc::collect_json_asset_refs)
        .unwrap_or_default();
    for rel in doc_refs {
        if !refs.iter().any(|existing| existing == &rel) {
            refs.push(rel);
        }
    }
    for rel in refs {
        let from = source.join(&rel);
        if !from.is_file() {
            continue;
        }
        let to = dest.join(&rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("copying {rel}: {e}"))?;
    }
    Ok(())
}

/// Copy a bundled (or another user) item into the user's library so it can be edited: the whole folder travels, the slug de-duplicates, and the manifest is re-stamped `source: "user"` so the card can never claim to be the shipped one.
fn duplicate_to_workspace(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    kind: Kind,
    id: &str,
) -> Result<LibraryItemInfo, String> {
    let root = require_root(app, state)?;
    let library = kind.workspace_dir(&root);
    let source = match id.strip_prefix("ws:") {
        Some(slug) => {
            validate_slug(slug)?;
            library.join(slug)
        }
        None => {
            validate_slug(id)?;
            kind.bundled_root(app).join(id)
        }
    };
    let item = duplicate_item(&source, &library, kind)?;
    if !id.starts_with("ws:") {
        workspace::copy_missing_sample_assets(
            &workspace::samples_root(app),
            &Path::new(&item.path).join("assets"),
        )?;
    }
    Ok(item)
}

fn duplicate_item(source: &Path, library: &Path, kind: Kind) -> Result<LibraryItemInfo, String> {
    let source_slug = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(kind.label());
    if !source.join(kind.manifest()).is_file() {
        return Err(format!("no {} named \"{source_slug}\"", kind.label()));
    }
    let name = manifest_name(source, kind, source_slug);

    std::fs::create_dir_all(library).map_err(|e| e.to_string())?;
    let slug = free_slug(library, &name, kind.label())?;
    let dir = library.join(&slug);
    workspace::copy_dir_recursive(source, &dir)?;

    let manifest_path = dir.join(kind.manifest());
    let mut manifest = read_json(&manifest_path)?;
    manifest["source"] = Value::String("user".into());
    atomic_write_json(&manifest_path, &manifest)?;
    require_item(&dir, &slug, kind)
}

#[tauri::command]
pub fn duplicate_template_to_workspace(
    app: AppHandle,
    state: State<'_, SettingsState>,
    template_id: String,
) -> Result<LibraryItemInfo, String> {
    duplicate_to_workspace(&app, &state, Kind::Template, &template_id)
}

#[tauri::command]
pub fn duplicate_preset_to_workspace(
    app: AppHandle,
    state: State<'_, SettingsState>,
    preset_id: String,
) -> Result<LibraryItemInfo, String> {
    duplicate_to_workspace(&app, &state, Kind::Preset, &preset_id)
}

// ── User writes, deletes and ordering ──────────────────────────────────────

fn write_user_manifest(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    kind: Kind,
    slug: &str,
    text: &str,
) -> Result<(), String> {
    let doc: Value = serde_json::from_str(text)
        .map_err(|e| format!("{} manifest isn't valid JSON: {e}", kind.label()))?;
    let dir = workspace_item_dir(app, state, kind, slug)?;
    atomic_write_json(&dir.join(kind.manifest()), &doc)
}

#[tauri::command]
pub fn write_user_template_manifest(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    write_user_manifest(&app, &state, Kind::Template, &slug, &text)
}

#[tauri::command]
pub fn write_user_preset_manifest(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    write_user_manifest(&app, &state, Kind::Preset, &slug, &text)
}

fn delete_user_item(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    kind: Kind,
    slug: &str,
) -> Result<(), String> {
    let dir = workspace_item_dir(app, state, kind, slug)?;
    if !dir.join(kind.manifest()).is_file() {
        return Err(format!(
            "no {} named \"{slug}\" in your library",
            kind.label()
        ));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user_template(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    delete_user_item(&app, &state, Kind::Template, &slug)
}

#[tauri::command]
pub fn delete_user_preset(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<(), String> {
    delete_user_item(&app, &state, Kind::Preset, &slug)
}

/// Rewrite the `order` field of every manifest in a drag-reorder batch; an item that vanished between the listing and the drop is skipped rather than failing the whole batch.
fn set_orders_in(library: &Path, manifest: &str, entries: &[OrderEntry]) -> Result<(), String> {
    for entry in entries {
        validate_slug(&entry.slug)?;
        let path = library.join(&entry.slug).join(manifest);
        if !path.is_file() {
            log::warn!("reorder skipped missing {}", path.display());
            continue;
        }
        let mut doc = read_json(&path)?;
        doc["order"] = Value::from(entry.order);
        atomic_write_json(&path, &doc)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_user_template_orders(
    app: AppHandle,
    state: State<'_, SettingsState>,
    entries: Vec<OrderEntry>,
) -> Result<(), String> {
    let library = templates_dir(&require_root(&app, &state)?);
    set_orders_in(&library, TEMPLATE_MANIFEST, &entries)
}

#[tauri::command]
pub fn set_user_preset_orders(
    app: AppHandle,
    state: State<'_, SettingsState>,
    entries: Vec<OrderEntry>,
) -> Result<(), String> {
    let library = presets_dir(&require_root(&app, &state)?);
    set_orders_in(&library, PRESET_MANIFEST, &entries)
}

/// Set `catalogue.order` inside a theme document, creating the block when the doc has none (older workspace themes predate it).
fn set_catalogue_order(path: &Path, order: i64) -> Result<(), String> {
    let mut doc = read_json(path)?;
    let catalogue = doc
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a theme document", path.display()))?
        .entry("catalogue")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !catalogue.is_object() {
        *catalogue = Value::Object(serde_json::Map::new());
    }
    catalogue["order"] = Value::from(order);
    atomic_write_json(path, &doc)
}

/// Reorder the user's own themes within My themes (`<workspaceRoot>/themes/<slug>/theme.json`).
#[tauri::command]
pub fn set_workspace_theme_orders(
    app: AppHandle,
    state: State<'_, SettingsState>,
    entries: Vec<OrderEntry>,
) -> Result<(), String> {
    let themes = require_root(&app, &state)?.join(crate::theme::THEMES_DIR_NAME);
    for entry in &entries {
        validate_slug(&entry.slug)?;
        let path = themes.join(&entry.slug).join("theme.json");
        if !path.is_file() {
            log::warn!("reorder skipped missing {}", path.display());
            continue;
        }
        set_catalogue_order(&path, entry.order)?;
    }
    Ok(())
}

// ── The checkout (dev only) ────────────────────────────────────────────────

/// A path inside the repo checkout, confined: the containing folder is canonicalised and must still sit under the canonical checkout root, so no symlinked library folder can be written through. `name` is always a validated slug plus a fixed extension, so it cannot traverse.
fn checkout_path(rel_dir: &str, name: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .map_err(|e| format!("cannot resolve the checkout: {e}"))?;
    let dir = root
        .join(rel_dir)
        .canonicalize()
        .map_err(|e| format!("cannot resolve {rel_dir} in the checkout: {e}"))?;
    if !dir.starts_with(&root) {
        return Err(format!("{rel_dir} resolves outside the checkout"));
    }
    Ok(dir.join(name))
}

/// One bundled theme document's text. Debug builds read the checkout so the theme editor can round-trip a shipped theme; release builds have the frontend's own eager glob and never call this.
#[tauri::command]
pub fn read_builtin_theme(id: String) -> Result<String, String> {
    validate_slug(&id)?;
    if !cfg!(debug_assertions) {
        return Err("bundled themes ship inside the app, not the checkout".into());
    }
    let path = checkout_path(BUILTIN_THEMES_REL, &format!("{id}.json"))?;
    std::fs::read_to_string(&path).map_err(|e| format!("reading bundled theme \"{id}\": {e}"))
}

#[cfg(debug_assertions)]
mod dev {
    use super::*;

    /// The checkout tree each bundled kind lives in, relative to the repo root.
    fn bundled_rel(kind: Kind) -> &'static str {
        match kind {
            Kind::Template => "projects",
            Kind::Preset => "presets",
        }
    }

    fn bundled_manifest_path(kind: Kind, slug: &str) -> Result<PathBuf, String> {
        validate_slug(slug)?;
        let dir = checkout_path(bundled_rel(kind), slug)?;
        if !dir.join(MANIFEST_FILENAME).is_file() {
            return Err(format!("no bundled {} named \"{slug}\"", kind.label()));
        }
        Ok(dir.join(kind.manifest()))
    }

    fn write_bundled_manifest(kind: Kind, slug: &str, text: &str) -> Result<(), String> {
        let doc: Value = serde_json::from_str(text)
            .map_err(|e| format!("{} manifest isn't valid JSON: {e}", kind.label()))?;
        atomic_write_json(&bundled_manifest_path(kind, slug)?, &doc)
    }

    fn delete_bundled(kind: Kind, slug: &str) -> Result<(), String> {
        validate_slug(slug)?;
        let dir = checkout_path(bundled_rel(kind), slug)?;
        if !dir.join(kind.manifest()).is_file() {
            return Err(format!("no bundled {} named \"{slug}\"", kind.label()));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    }

    fn set_bundled_orders(kind: Kind, entries: &[OrderEntry]) -> Result<(), String> {
        for entry in entries {
            let path = match bundled_manifest_path(kind, &entry.slug) {
                Ok(path) if path.is_file() => path,
                Ok(path) => {
                    log::warn!("reorder skipped missing {}", path.display());
                    continue;
                }
                Err(e) => return Err(e),
            };
            let mut doc = read_json(&path)?;
            doc["order"] = Value::from(entry.order);
            atomic_write_json(&path, &doc)?;
        }
        Ok(())
    }

    fn builtin_theme_path(id: &str) -> Result<PathBuf, String> {
        validate_slug(id)?;
        checkout_path(BUILTIN_THEMES_REL, &format!("{id}.json"))
    }

    /// Write a bundled theme document in the checkout, so the theme editor's dev mode edits the shipped file itself and git shows the change.
    #[tauri::command]
    pub fn dev_write_builtin_theme(id: String, text: String) -> Result<(), String> {
        let doc: Value =
            serde_json::from_str(&text).map_err(|e| format!("theme doc isn't valid JSON: {e}"))?;
        atomic_write_json(&builtin_theme_path(&id)?, &doc)
    }

    #[tauri::command]
    pub fn dev_delete_builtin_theme(id: String) -> Result<(), String> {
        let path = builtin_theme_path(&id)?;
        if !path.is_file() {
            return Err(format!("no bundled theme named \"{id}\""));
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn dev_set_builtin_theme_orders(entries: Vec<ThemeOrderEntry>) -> Result<(), String> {
        for entry in &entries {
            let path = builtin_theme_path(&entry.id)?;
            if !path.is_file() {
                log::warn!("reorder skipped missing {}", path.display());
                continue;
            }
            set_catalogue_order(&path, entry.order)?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn dev_write_template_manifest(slug: String, text: String) -> Result<(), String> {
        write_bundled_manifest(Kind::Template, &slug, &text)
    }

    #[tauri::command]
    pub fn dev_delete_bundled_template(slug: String) -> Result<(), String> {
        delete_bundled(Kind::Template, &slug)
    }

    #[tauri::command]
    pub fn dev_write_preset_manifest(slug: String, text: String) -> Result<(), String> {
        write_bundled_manifest(Kind::Preset, &slug, &text)
    }

    #[tauri::command]
    pub fn dev_delete_bundled_preset(slug: String) -> Result<(), String> {
        delete_bundled(Kind::Preset, &slug)
    }

    #[tauri::command]
    pub fn dev_set_template_orders(entries: Vec<OrderEntry>) -> Result<(), String> {
        set_bundled_orders(Kind::Template, &entries)
    }

    #[tauri::command]
    pub fn dev_set_preset_orders(entries: Vec<OrderEntry>) -> Result<(), String> {
        set_bundled_orders(Kind::Preset, &entries)
    }
}

#[cfg(debug_assertions)]
pub use dev::*;

#[cfg(test)]
mod tests {
    use super::*;

    // A unique scratch dir under the OS temp root (the workspace.rs pattern; avoids a tempfile dev-dependency).
    fn scratch_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-library-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A workspace project with one referenced asset, one unreferenced asset and a snapshot.
    fn sample_project(dir: &Path) {
        write(
            &dir.join(MANIFEST_FILENAME),
            r#"{"id":"launch","name":"Launch 2026","version":2,"themeId":"kookaburra-midnight","formats":["16:9"],"scenes":[{"file":"scenes/01-open.tsx","durationMs":2600},{"file":"scenes/02-stat.tsx","durationMs":5000}]}"#,
        );
        write(
            &dir.join("scenes/01-open.tsx"),
            r#"export default defineScene({ id: "open" });"#,
        );
        write(&dir.join("scenes/01-open.json"), r#"{"version":1}"#);
        write(
            &dir.join("scenes/02-stat.tsx"),
            r#"<ImageCard src="assets/hero.png" />"#,
        );
        write(
            &dir.join("scenes/02-stat.json"),
            r#"{"version":1,"name":"Stat hero","devices":[{"media":"assets/clip.mp4"}]}"#,
        );
        write(&dir.join("assets/hero.png"), "hero");
        write(&dir.join("assets/clip.mp4"), "clip");
        write(&dir.join("assets/unused.png"), "unused");
    }

    #[test]
    fn converting_a_project_snapshots_it_into_a_fresh_template_folder() {
        let base = scratch_dir();
        let source = base.join("launch");
        let library = base.join("templates");
        sample_project(&source);
        write(
            &source.join("edits/demo.json"),
            r#"{"name":"demo","sources":[]}"#,
        );
        let snapshot = base.join("launch.png");
        write(&snapshot, "png");

        let item = convert_project(&source, &library, &snapshot).unwrap();

        assert_eq!(item.slug, "launch-2026");
        assert_eq!(item.scene_count, 2);
        assert_eq!(item.duration_ms, 7600);
        assert!(item.poster_path.unwrap().ends_with("poster.png"));
        let dir = library.join("launch-2026");
        // Everything a project needs travels, including assets no scene references.
        assert!(dir.join("scenes/01-open.tsx").is_file());
        assert!(dir.join("scenes/02-stat.json").is_file());
        assert!(dir.join("assets/unused.png").is_file());
        assert!(dir.join("edits/demo.json").is_file());
        let manifest = read_json(&dir.join(TEMPLATE_MANIFEST)).unwrap();
        assert_eq!(manifest["name"], "Launch 2026");
        assert_eq!(manifest["source"], "user");
        // The project manifest rides along verbatim; `create_project` re-stamps the identity.
        assert_eq!(
            read_json(&dir.join(MANIFEST_FILENAME)).unwrap()["id"],
            "launch"
        );

        // A second conversion of the same project takes the next free slug.
        let again = convert_project(&source, &library, &snapshot).unwrap();
        assert_eq!(again.slug, "launch-2026-2");
        assert!(library
            .join("launch-2026-2")
            .join(TEMPLATE_MANIFEST)
            .is_file());

        // A folder with no project manifest is refused before anything is written.
        assert!(convert_project(&base.join("nothing"), &library, &snapshot).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn saving_a_scene_as_a_preset_takes_only_the_assets_it_names() {
        let base = scratch_dir();
        let source = base.join("launch");
        let library = base.join("presets");
        sample_project(&source);

        let item = save_preset(&source, &library, "02-stat").unwrap();

        // The sidecar name becomes the slug, the display name and the manifest name.
        assert_eq!(item.slug, "stat-hero");
        assert_eq!(item.scene_count, 1);
        assert_eq!(item.duration_ms, 5000);
        let dir = library.join("stat-hero");
        assert!(dir.join("scenes/02-stat.tsx").is_file());
        assert!(dir.join("scenes/02-stat.json").is_file());
        // The TSX names one asset and the sidecar the other; the third stays behind.
        assert!(dir.join("assets/hero.png").is_file());
        assert!(dir.join("assets/clip.mp4").is_file());
        assert!(!dir.join("assets/unused.png").exists());

        let project = read_json(&dir.join(MANIFEST_FILENAME)).unwrap();
        assert_eq!(project["themeId"], "kookaburra-midnight");
        assert_eq!(project["formats"][0], "16:9");
        assert_eq!(project["scenes"].as_array().unwrap().len(), 1);
        assert_eq!(project["scenes"][0]["file"], "scenes/02-stat.tsx");
        assert_eq!(
            read_json(&dir.join(PRESET_MANIFEST)).unwrap()["name"],
            "Stat hero"
        );

        // A scene with no sidecar name falls back to its stem, and the slug de-duplicates.
        let plain = save_preset(&source, &library, "01-open").unwrap();
        assert_eq!(plain.slug, "open");
        let twice = save_preset(&source, &library, "01-open").unwrap();
        assert_eq!(twice.slug, "open-2");

        // A stem that is not a scene, and one that tries to escape, both refuse.
        assert!(save_preset(&source, &library, "99-missing").is_err());
        assert!(save_preset(&source, &library, "../../etc/passwd").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn saved_presets_keep_render_context_effects_and_exact_asset_names() {
        let base = scratch_dir();
        let source = base.join("launch");
        let library = base.join("presets");
        sample_project(&source);
        let mut manifest = read_json(&source.join(MANIFEST_FILENAME)).unwrap();
        manifest["lighting"] =
            serde_json::json!({ "environment": { "source": "assets/studio.hdr" } });
        manifest["render"] = serde_json::json!({ "toneMapping": "neutral", "exposure": 1.4 });
        manifest["frame"] = serde_json::json!({ "type": "browser" });
        manifest["typography"] = serde_json::json!({ "headline": "Inter@700" });
        manifest["scenes"][1]["effects"] = serde_json::json!({ "vignette": { "enabled": true } });
        atomic_write_json(&source.join(MANIFEST_FILENAME), &manifest).unwrap();
        let doc = serde_json::json!({
            "version": 1,
            "name": "Stat hero",
            "image": { "src": "assets/café (final).png" },
            "website": {
                "url": "https://example.com/",
                "capture": { "src": "assets/website/capture.png", "contentHash": "hash" }
            }
        });
        atomic_write_json(&source.join("scenes/02-stat.json"), &doc).unwrap();
        for asset in ["studio.hdr", "café (final).png", "website/capture.png"] {
            write(&source.join("assets").join(asset), asset);
        }

        let item = save_preset(&source, &library, "02-stat").unwrap();
        let saved = library.join(item.slug);
        let project = read_json(&saved.join(MANIFEST_FILENAME)).unwrap();
        for field in ["lighting", "render", "frame", "typography"] {
            assert_eq!(project[field], manifest[field]);
        }
        assert_eq!(
            project["scenes"][0]["effects"],
            manifest["scenes"][1]["effects"]
        );
        assert_eq!(read_json(&saved.join("scenes/02-stat.json")).unwrap(), doc);
        for asset in ["studio.hdr", "café (final).png", "website/capture.png"] {
            assert_eq!(
                std::fs::read(saved.join("assets").join(asset)).unwrap(),
                asset.as_bytes()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn saving_a_preset_refuses_corrupt_or_unregistered_scenes_before_copying() {
        let base = scratch_dir();
        let source = base.join("launch");
        let library = base.join("presets");
        sample_project(&source);
        write(&source.join("scenes/02-stat.json"), "{ broken");
        assert!(save_preset(&source, &library, "02-stat").is_err());
        write(&source.join("scenes/orphan.tsx"), "orphan");
        assert!(save_preset(&source, &library, "orphan").is_err());
        assert!(!library.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_saved_preset_inserts_at_its_final_position_with_scene_content_and_assets() {
        let base = scratch_dir();
        let source = base.join("source");
        let library = base.join("presets");
        let dest = base.join("dest");
        sample_project(&source);
        sample_project(&dest);
        let source_doc = serde_json::json!({
            "version": 1,
            "name": "Stat hero",
            "camera": { "position": [1, 2, 3] },
            "lighting": { "environment": { "source": "assets/scene.hdr" } },
            "frame": { "type": "browser" },
            "website": { "url": "https://example.com", "capture": { "src": "assets/website/site.png" } }
        });
        atomic_write_json(&source.join("scenes/02-stat.json"), &source_doc).unwrap();
        for asset in ["scene.hdr", "website/site.png", "grade.cube"] {
            write(&source.join("assets").join(asset), "source asset");
            write(&dest.join("assets").join(asset), "existing asset");
        }
        let mut manifest = read_json(&source.join(MANIFEST_FILENAME)).unwrap();
        manifest["scenes"][1]["effects"] = serde_json::json!({
            "vignette": { "enabled": true },
            "lut": { "url": "assets/grade.cube", "intensity": 0.5 }
        });
        atomic_write_json(&source.join(MANIFEST_FILENAME), &manifest).unwrap();
        let item = save_preset(&source, &library, "02-stat").unwrap();
        let copied = crate::scene_doc::copy_scene_between(
            &library.join(&item.slug),
            &dest,
            0,
            &format!("ws-preset:{}", item.slug),
            "dest",
            Some(1),
            None,
        )
        .unwrap();
        assert_eq!(copied.index, 1);
        let landed = read_json(&dest.join(MANIFEST_FILENAME)).unwrap();
        assert_eq!(landed["scenes"].as_array().unwrap().len(), 3);
        assert_eq!(landed["scenes"][1]["file"], copied.scene.file);
        assert_eq!(
            landed["scenes"][1]["effects"]["vignette"],
            manifest["scenes"][1]["effects"]["vignette"]
        );
        assert_eq!(landed["scenes"][2]["file"], "scenes/02-stat.tsx");
        let doc = read_json(&dest.join(copied.scene.doc_file)).unwrap();
        assert_eq!(doc["camera"], source_doc["camera"]);
        assert_eq!(doc["frame"], source_doc["frame"]);
        assert_eq!(doc["website"]["url"], source_doc["website"]["url"]);
        for rel in [
            doc["lighting"]["environment"]["source"].as_str().unwrap(),
            doc["website"]["capture"]["src"].as_str().unwrap(),
            landed["scenes"][1]["effects"]["lut"]["url"]
                .as_str()
                .unwrap(),
        ] {
            assert_eq!(
                std::fs::read_to_string(dest.join(rel)).unwrap(),
                "source asset"
            );
        }
        for asset in ["scene.hdr", "website/site.png", "grade.cube"] {
            assert_eq!(
                std::fs::read_to_string(dest.join("assets").join(asset)).unwrap(),
                "existing asset"
            );
        }
        let before = std::fs::read(dest.join(MANIFEST_FILENAME)).unwrap();
        assert!(crate::scene_doc::copy_scene_between(
            &source,
            &dest,
            0,
            "ws-preset:malformed",
            "dest",
            None,
            None
        )
        .is_err());
        assert!(crate::scene_doc::copy_scene_between(
            &source,
            &dest,
            0,
            "source",
            "ws-preset:dest",
            None,
            None
        )
        .is_err());
        assert_eq!(std::fs::read(dest.join(MANIFEST_FILENAME)).unwrap(), before);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_saved_canonical_starter_reuses_the_latest_edits_without_changing_existing_scenes() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("presets/title");
        let originals = [
            "project.json",
            "scenes/01-title.tsx",
            "scenes/01-title.json",
        ]
        .map(|file| (file, std::fs::read(source.join(file)).unwrap()));
        let root = scratch_dir();
        let project = root.join("project");
        let library = root.join("presets");
        std::fs::create_dir_all(project.join("scenes")).unwrap();
        atomic_write_json(
            &project.join(MANIFEST_FILENAME),
            &serde_json::json!({
                "version": 2, "defaultTransition": null, "themeId": "kookaburra-studio-white",
                "formats": ["16:9"], "scenes": []
            }),
        )
        .unwrap();
        let first = crate::scene_doc::copy_scene_between(
            &source,
            &project,
            0,
            "preset:title",
            "project",
            None,
            None,
        )
        .unwrap();
        let stem = first
            .scene
            .file
            .strip_prefix("scenes/")
            .unwrap()
            .trim_end_matches(".tsx");
        let saved = save_preset(&project, &library, stem).unwrap();
        let saved_dir = library.join(&saved.slug);
        let mut doc = read_json(&saved_dir.join(&first.scene.doc_file)).unwrap();
        doc["text"]["title"] = serde_json::json!("An improved reusable title");
        let updated_title = doc["text"]["title"].clone();
        for item in doc["managedText"]["items"].as_array_mut().unwrap() {
            if item["key"] == "title" {
                item["text"] = updated_title.clone();
            }
        }
        doc["background"] = serde_json::json!({ "type": "image", "src": "assets/improved.png" });
        doc["duration"] = serde_json::json!({ "mode": "manual" });
        atomic_write_json(&saved_dir.join(&first.scene.doc_file), &doc).unwrap();
        write(
            &saved_dir.join("assets/improved.png"),
            "improved preset image",
        );
        let mut manifest = read_json(&saved_dir.join(MANIFEST_FILENAME)).unwrap();
        manifest["scenes"][0]["durationMs"] = serde_json::json!(1234);
        atomic_write_json(&saved_dir.join(MANIFEST_FILENAME), &manifest).unwrap();
        let tsx_path = saved_dir.join(&first.scene.file);
        let tsx = std::fs::read_to_string(&tsx_path).unwrap().replace(
            &format!("durationMs: {}", first.scene.duration_ms),
            "durationMs: 1234",
        );
        std::fs::write(&tsx_path, &tsx).unwrap();

        let again = crate::scene_doc::copy_scene_between(
            &saved_dir,
            &project,
            0,
            &format!("ws-preset:{}", saved.slug),
            "project",
            None,
            None,
        )
        .unwrap();
        assert_eq!(again.index, 1);
        assert_eq!(again.scene.duration_ms, 1234);
        assert_ne!(again.scene.scene_id, first.scene.scene_id);
        assert_eq!(
            read_json(&project.join(&again.scene.doc_file)).unwrap(),
            doc
        );
        assert!(std::fs::read_to_string(project.join(&again.scene.file))
            .unwrap()
            .contains("durationMs: 1234"));
        assert_eq!(
            std::fs::read(project.join("assets/improved.png")).unwrap(),
            b"improved preset image"
        );
        assert_eq!(
            read_json(&project.join(&first.scene.doc_file)).unwrap()["text"]["title"],
            "Ship faster"
        );
        assert_eq!(
            read_json(&project.join(MANIFEST_FILENAME)).unwrap()["scenes"][0]["durationMs"],
            first.scene.duration_ms
        );
        for (file, bytes) in originals {
            assert_eq!(std::fs::read(source.join(file)).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_preset_insertion_copies_shared_samples_without_overwriting_the_destination() {
        let base = scratch_dir();
        let source = base.join("bundled");
        let dest = base.join("dest");
        let pool = base.join("pool");
        sample_project(&source);
        sample_project(&dest);
        let mut manifest = read_json(&source.join(MANIFEST_FILENAME)).unwrap();
        manifest["scenes"].as_array_mut().unwrap().remove(0);
        atomic_write_json(&source.join(MANIFEST_FILENAME), &manifest).unwrap();
        write(
            &source.join("scenes/02-stat.json"),
            r#"{"name":"Hero","media":{"src":"assets/shared.mp4"}}"#,
        );
        write(&pool.join("shared.mp4"), "bundled clip");
        write(&dest.join("assets/shared.mp4"), "user clip");
        let copied = crate::scene_doc::copy_scene_between(
            &source,
            &dest,
            0,
            "preset:hero",
            "dest",
            None,
            Some(&pool),
        )
        .unwrap();
        let doc = read_json(&dest.join(copied.scene.doc_file)).unwrap();
        let rel = doc["media"]["src"].as_str().unwrap();
        assert_ne!(rel, "assets/shared.mp4");
        assert_eq!(
            std::fs::read_to_string(dest.join(rel)).unwrap(),
            "bundled clip"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("assets/shared.mp4")).unwrap(),
            "user clip"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn duplicating_an_item_restamps_it_as_the_user_s_own() {
        let base = scratch_dir();
        let bundled = base.join("presets/stat-hero");
        let library = base.join("my-presets");
        write(
            &bundled.join(MANIFEST_FILENAME),
            r#"{"scenes":[{"durationMs":4000}]}"#,
        );
        write(
            &bundled.join(PRESET_MANIFEST),
            r#"{"version":1,"name":"Stat hero","order":20,"source":"bundled"}"#,
        );
        write(&bundled.join("scenes/01-stat.tsx"), "scene");

        let item = duplicate_item(&bundled, &library, Kind::Preset).unwrap();

        assert_eq!(item.slug, "stat-hero");
        assert!(library.join("stat-hero/scenes/01-stat.tsx").is_file());
        let manifest = read_json(&library.join("stat-hero").join(PRESET_MANIFEST)).unwrap();
        assert_eq!(manifest["source"], "user");
        // Everything else the manifest carried survives the re-stamp.
        assert_eq!(manifest["order"], 20);
        assert_eq!(manifest["name"], "Stat hero");

        // Duplicating again lands beside it rather than over it.
        assert_eq!(
            duplicate_item(&bundled, &library, Kind::Preset)
                .unwrap()
                .slug,
            "stat-hero-2"
        );
        // A folder carrying no manifest of this kind is not duplicable.
        assert!(duplicate_item(&bundled, &library, Kind::Template).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn free_slug_walks_past_the_names_already_taken() {
        let dir = scratch_dir();
        assert_eq!(free_slug(&dir, "Stat hero", "preset").unwrap(), "stat-hero");
        std::fs::create_dir_all(dir.join("stat-hero")).unwrap();
        assert_eq!(
            free_slug(&dir, "Stat hero", "preset").unwrap(),
            "stat-hero-2"
        );
        std::fs::create_dir_all(dir.join("stat-hero-2")).unwrap();
        assert_eq!(
            free_slug(&dir, "Stat hero", "preset").unwrap(),
            "stat-hero-3"
        );
        // A name that slugifies to nothing falls back rather than failing.
        assert_eq!(free_slug(&dir, "···", "preset").unwrap(), "preset");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_item_derives_the_facts_the_catalogue_cannot() {
        let dir = scratch_dir();
        write(
            &dir.join(MANIFEST_FILENAME),
            r#"{"name":"Stat hero","scenes":[{"durationMs":4000},{"durationMs":3000,"transition":{"durationMs":600}}]}"#,
        );
        write(&dir.join(TEMPLATE_MANIFEST), r#"{"version":1}"#);
        let item = read_item(&dir, "stat-hero", Kind::Template).unwrap();
        assert_eq!(item.scene_count, 2);
        // The overlap model: 4000 + 3000 − 600.
        assert_eq!(item.duration_ms, 6400);
        assert!(item.poster_path.is_none());

        write(&dir.join("poster.png"), "png");
        write(&dir.join("poster.jpg"), "old poster");
        let with_poster = read_item(&dir, "stat-hero", Kind::Template).unwrap();
        assert!(with_poster.poster_path.unwrap().ends_with("poster.png"));
        assert!(with_poster.poster_modified_at.is_some());

        // A folder with no manifest is not a library item.
        assert!(read_item(&dir, "stat-hero", Kind::Preset).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_referenced_assets_takes_only_what_the_scene_names() {
        let source = scratch_dir();
        let dest = scratch_dir();
        write(&source.join("assets/hero.png"), "hero");
        write(&source.join("assets/nested/clip.mp4"), "clip");
        write(&source.join("assets/unused.png"), "unused");
        let tsx = r#"<ImageCard src="assets/hero.png" />"#;
        let doc = r#"{"devices":[{"media":"assets/nested/clip.mp4"}],"missing":"assets/gone.png"}"#;

        copy_referenced_assets(&source, &dest, tsx, Some(doc)).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("assets/hero.png")).unwrap(),
            "hero"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("assets/nested/clip.mp4")).unwrap(),
            "clip"
        );
        assert!(!dest.join("assets/unused.png").exists());
        // A reference the source project no longer has is skipped, never an error.
        assert!(!dest.join("assets/gone.png").exists());

        let _ = std::fs::remove_dir_all(&source);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn set_orders_in_rewrites_order_and_skips_the_missing() {
        let library = scratch_dir();
        write(
            &library.join("one").join(TEMPLATE_MANIFEST),
            r#"{"version":1,"name":"One","order":0}"#,
        );
        write(
            &library.join("two").join(TEMPLATE_MANIFEST),
            r#"{"version":1,"name":"Two"}"#,
        );
        let entries = vec![
            OrderEntry {
                slug: "one".into(),
                order: 20,
            },
            OrderEntry {
                slug: "two".into(),
                order: 10,
            },
            OrderEntry {
                slug: "gone".into(),
                order: 30,
            },
        ];
        set_orders_in(&library, TEMPLATE_MANIFEST, &entries).unwrap();

        let one = read_json(&library.join("one").join(TEMPLATE_MANIFEST)).unwrap();
        assert_eq!(one["order"], 20);
        assert_eq!(one["name"], "One");
        // A manifest with no order gains one.
        let two = read_json(&library.join("two").join(TEMPLATE_MANIFEST)).unwrap();
        assert_eq!(two["order"], 10);

        // An escaping slug is refused before any file is touched.
        let escape = vec![OrderEntry {
            slug: "../elsewhere".into(),
            order: 0,
        }];
        assert!(set_orders_in(&library, TEMPLATE_MANIFEST, &escape).is_err());

        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn set_catalogue_order_creates_the_block_when_a_theme_has_none() {
        let dir = scratch_dir();
        let path = dir.join("theme.json");
        write(&path, r#"{"version":2,"id":"mine","name":"Mine"}"#);
        set_catalogue_order(&path, 30).unwrap();
        let doc = read_json(&path).unwrap();
        assert_eq!(doc["catalogue"]["order"], 30);
        assert_eq!(doc["name"], "Mine");

        // An existing block keeps its other fields.
        write(
            &path,
            r#"{"version":2,"catalogue":{"category":"dark","order":0}}"#,
        );
        set_catalogue_order(&path, 40).unwrap();
        let doc = read_json(&path).unwrap();
        assert_eq!(doc["catalogue"]["order"], 40);
        assert_eq!(doc["catalogue"]["category"], "dark");

        // A non-object catalogue is replaced rather than indexed into.
        write(&path, r#"{"version":2,"catalogue":7}"#);
        set_catalogue_order(&path, 50).unwrap();
        assert_eq!(read_json(&path).unwrap()["catalogue"]["order"], 50);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_starter_manifests_carry_the_user_source() {
        let template = starter_template_manifest("My launch");
        assert_eq!(template["source"], "user");
        assert_eq!(template["name"], "My launch");
        assert_eq!(template["order"], 10);
        assert_eq!(template["preview"]["frames"].as_array().unwrap().len(), 4);

        let preset = starter_preset_manifest("Stat hero");
        assert_eq!(preset["source"], "user");
        assert_eq!(preset["preview"]["atMs"], 1500);
    }

    #[test]
    fn scene_duration_comes_from_the_matching_manifest_entry() {
        let manifest = serde_json::json!({
            "scenes": [
                { "file": "scenes/01-intro.tsx", "durationMs": 2600 },
                { "file": "scenes/02-stat.tsx", "durationMs": 5000 }
            ]
        });
        assert_eq!(scene_duration_ms(&manifest, "scenes/02-stat.tsx"), 5000);
        // A scene the manifest never registered still gets a sane length.
        assert_eq!(
            scene_duration_ms(&manifest, "scenes/03-gone.tsx"),
            DEFAULT_SCENE_DURATION_MS
        );
    }

    #[test]
    fn a_checkout_path_stays_inside_the_checkout() {
        // The two trees the dev commands write live in the repo this test compiles from.
        let themes = checkout_path(BUILTIN_THEMES_REL, "kookaburra-default.json").unwrap();
        assert!(themes.ends_with("src/theme/builtin/kookaburra-default.json"));
        assert!(themes.is_file());
        assert!(checkout_path("projects", "blank").unwrap().is_dir());
        // A directory that does not exist cannot be written through.
        assert!(checkout_path("../../etc", "passwd").is_err());
    }
}
