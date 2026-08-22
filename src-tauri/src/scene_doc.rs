//! Per-scene sidecar documents and the native scene scaffolder; a scene document is scenes/<stem>.json beside its TSX (the composition), holding the machine-editable half of a scene (name, text map, devices, camera track, duration mode) owned jointly by the app UI and Claude, with both writers sharing one atomic tmp+rename path and version guard so the frontend never touches files directly (see docs/decisions.md, "Project format & authoring").

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::media;
use crate::workspace::{self, SettingsState, MANIFEST_FILENAME};

/// Newest sidecar schema this binary understands (`read`/`write` reject anything newer).
const SCENE_DOC_VERSION: u64 = 1;

/// Wizard/scaffold default when the scene has no video media to follow.
const DEFAULT_SCENE_DURATION_MS: u64 = 4000;

/// Title and title-icon scenes are compact openers by default.
const TITLE_SCENE_DURATION_MS: u64 = 2600;

/// Chart scenes start longer than the default: the build-in and its counters need room to land.
const CHART_SCENE_DURATION_MS: u64 = 5000;

fn default_scene_duration_ms(kind: &str) -> u64 {
    match kind {
        "title" | "titleicon" => TITLE_SCENE_DURATION_MS,
        "chart" => CHART_SCENE_DURATION_MS,
        _ => DEFAULT_SCENE_DURATION_MS,
    }
}

fn device_model_and_colour<'a>(
    model: Option<&'a str>,
    colour: Option<&'a str>,
) -> (&'a str, &'a str) {
    let model = model.unwrap_or("android");
    let default_colour = match model {
        "iphone-15-pro" => "natural-titanium",
        "iphone-17-pro" | "macbook-pro-16" => "silver",
        _ => "graphite",
    };
    (model, colour.unwrap_or(default_colour))
}

fn transition_is_valid(spec: &Value) -> bool {
    spec.as_object()
        .and_then(|object| object.get("type"))
        .map(Value::is_string)
        .unwrap_or(false)
}

fn catalogue_default_transition() -> Value {
    json!({ "type": "crossfade", "durationMs": 600 })
}

fn project_default_transition(manifest: &Value) -> Option<Value> {
    match manifest.get("defaultTransition") {
        Some(Value::Null) => None,
        Some(spec) if transition_is_valid(spec) => Some(spec.clone()),
        _ => Some(catalogue_default_transition()),
    }
}

fn seed_inserted_scene_transitions(
    scenes: &mut [Value],
    at: usize,
    default_transition: Option<&Value>,
) {
    let Some(default_transition) = default_transition else {
        return;
    };
    let appended = at + 1 == scenes.len();
    if appended && at > 0 && scenes[at - 1].get("transition").is_none() {
        scenes[at - 1]["transition"] = default_transition.clone();
    }
    if !appended && scenes[at].get("transition").is_none() {
        scenes[at]["transition"] = default_transition.clone();
    }
}

/// Validate and resolve a `scenes/<stem>.json` path under the project, traversal-hardened: reject anything that isn't exactly one flat path segment under `scenes/` (the `resolve_asset` lesson).
fn scene_doc_path(root: &Path, slug: &str, file: &str) -> Result<PathBuf, String> {
    let rest = file
        .strip_prefix("scenes/")
        .ok_or_else(|| format!("scene doc path must live under scenes/: {file:?}"))?;
    let ok = rest.ends_with(".json")
        && !rest.contains('/')
        && !rest.contains("..")
        && !rest.starts_with('.');
    if !ok {
        return Err(format!("invalid scene doc path: {file:?}"));
    }
    Ok(root.join(slug).join(file))
}

/// Atomic JSON write: tmp + rename so a crash mid-save can never corrupt a document (the `edit.rs::write_doc` pattern; `project.json` writes here go through this too).
fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Atomic text write, the `atomic_write_json` guarantee for scene TSX: the bytes land whole or not at all.
fn atomic_write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Read a scene's sidecar text; `None` when the scene has no document, the normal case for older scenes without one (the frontend renders them with no editing affordances).
#[tauri::command]
pub fn read_scene_doc(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    file: String,
) -> Result<Option<String>, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = scene_doc_path(&root, &slug, &file)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {slug}/{file}: {e}")),
    }
}

/// Write a scene document (atomic); the text must parse as JSON with a supported `version`, a doc from a newer Kookaburra Cut is refused rather than rewritten blind.
#[tauri::command]
pub fn write_scene_doc(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    file: String,
    text: String,
) -> Result<(), String> {
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("scene doc isn't valid JSON: {e}"))?;
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version == 0 {
        return Err("scene doc needs a numeric \"version\"".into());
    }
    if version > SCENE_DOC_VERSION {
        return Err(format!(
            "this scene doc uses version {version} — it needs a newer Kookaburra Cut"
        ));
    }
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = scene_doc_path(&root, &slug, &file)?;
    atomic_write_json(&path, &doc)
}

/// Manifest v2: transitions live on the OUTGOING scene. Legacy files stored each one on the incoming scene; shifting every transition one scene earlier reproduces the same boundaries, so migration never changes rendered output. Runs before any scenes-array edit so a file can never mix the two models; history snapshots stay verbatim (undo of a legacy file restores the legacy file).
fn migrate_manifest_transitions(manifest: &mut Value) {
    let version = manifest.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version >= 2 {
        return;
    }
    if let Some(scenes) = manifest.get_mut("scenes").and_then(Value::as_array_mut) {
        for i in 0..scenes.len() {
            let next = scenes.get(i + 1).and_then(|s| s.get("transition")).cloned();
            if let Some(obj) = scenes[i].as_object_mut() {
                match next {
                    Some(spec) => {
                        obj.insert("transition".into(), spec);
                    }
                    None => {
                        obj.remove("transition");
                    }
                }
            }
        }
    }
    manifest["version"] = json!(2);
}

/// Patch one scene's `durationMs` in `project.json` (atomic); project.json stays the sequencing source of truth, the sidecar's `duration.mode` only tells the app whether to keep it synced (duration-follow).
#[tauri::command]
pub fn update_project_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    index: usize,
    duration_ms: u64,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    let scene = scenes
        .get_mut(index)
        .ok_or_else(|| format!("project.json has no scene at index {index}"))?;
    scene["durationMs"] = json!(duration_ms);
    atomic_write_json(&path, &manifest)
}

/// Set or remove one scene's outgoing `transition` in `project.json` (atomic, manifest v2), the transition picker's write surface; `None` removes the key (a hard cut, which also restores the overlap to the timeline), the last scene is rejected since it has nothing to exit into, and the spec is schema-light on shape (the `set_project_theme` precedent: the loader normalises and degrades unknown types) but must be an object carrying a string `type` so a garbage write can't land.
#[tauri::command]
pub fn update_project_scene_transition(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    index: usize,
    transition: Option<Value>,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    if let Some(spec) = &transition {
        if !transition_is_valid(spec) {
            return Err("transition must be an object with a string `type`".into());
        }
    }
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    if index + 1 >= scenes.len() {
        return Err("the last scene has no outgoing transition".into());
    }
    let scene = scenes
        .get_mut(index)
        .ok_or_else(|| format!("project.json has no scene at index {index}"))?;
    match transition {
        Some(spec) => {
            scene["transition"] = spec;
        }
        None => {
            if let Some(obj) = scene.as_object_mut() {
                obj.remove("transition");
            }
        }
    }
    atomic_write_json(&path, &manifest)
}

fn apply_transition_to_manifest(
    manifest: &mut Value,
    transition: Option<&Value>,
) -> Result<(), String> {
    if let Some(spec) = &transition {
        if !transition_is_valid(spec) {
            return Err("transition must be an object with a string `type`".into());
        }
    }
    migrate_manifest_transitions(manifest);
    {
        let scenes = manifest
            .get_mut("scenes")
            .and_then(Value::as_array_mut)
            .ok_or("project.json has no scenes array")?;
        let boundary_count = scenes.len().saturating_sub(1);
        for scene in scenes.iter_mut().take(boundary_count) {
            match transition {
                Some(spec) => scene["transition"] = spec.clone(),
                None => {
                    if let Some(object) = scene.as_object_mut() {
                        object.remove("transition");
                    }
                }
            }
        }
    }
    manifest["defaultTransition"] = transition.cloned().unwrap_or(Value::Null);
    Ok(())
}

/// Apply one transition to every boundary and store it as the default for new boundaries. A null transition is an explicit hard-cut default, distinct from an older manifest with no default key.
#[tauri::command]
pub fn apply_project_transition_to_all(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    transition: Option<Value>,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    apply_transition_to_manifest(&mut manifest, transition.as_ref())?;
    atomic_write_json(&path, &manifest)
}

/// The raw project.json text; undo/redo snapshots the whole manifest around an edit so any manifest op restores generically, named distinctly from `workspace::read_project_manifest` (the plain load-path read) to avoid registering two commands under the same name, this one is the undo/redo snapshot surface only.
#[tauri::command]
pub fn read_project_manifest_snapshot(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<String, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    std::fs::read_to_string(root.join(&slug).join(MANIFEST_FILENAME)).map_err(|e| e.to_string())
}

/// Restore a whole project.json snapshot, the undo/redo write surface only (feature edits keep their narrow commands); validated as JSON with a scenes array so a corrupt snapshot can never land, atomic tmp+rename.
#[tauri::command]
pub fn write_project_manifest_snapshot(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    text: String,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("manifest isn't valid JSON: {e}"))?;
    if !manifest.get("scenes").map(Value::is_array).unwrap_or(false) {
        return Err("manifest needs a scenes array".into());
    }
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    atomic_write_json(&path, &manifest)
}

/// Remove a scene from the project: the manifest entry goes, and the TSX + sidecar files move to the Trash (recoverable); the last scene is protected since a project needs at least one, the playhead clamp and module reload are the frontend's job.
#[tauri::command]
pub fn remove_project_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    index: usize,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let project = root.join(&slug);
    let path = project.join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    if scenes.len() <= 1 {
        return Err("a project needs at least one scene".into());
    }
    if index >= scenes.len() {
        return Err(format!("project.json has no scene at index {index}"));
    }
    let removed = scenes.remove(index);
    atomic_write_json(&path, &manifest)?;
    // Files ride to the Trash after the manifest write lands, a failed manifest write must never leave the project pointing at trashed files.
    if let Some(file) = removed.get("file").and_then(Value::as_str) {
        if file.starts_with("scenes/") && !file.contains("..") {
            let tsx = project.join(file);
            if tsx.is_file() {
                let _ = workspace::trash_path(&tsx);
            }
            let sidecar = project.join(file.replace(".tsx", ".json"));
            if sidecar.is_file() {
                let _ = workspace::trash_path(&sidecar);
            }
        }
    }
    Ok(())
}

/// Move a scene within the project; each scene's outgoing `transition` travels with it, predictable and reversible by moving back.
#[tauri::command]
pub fn move_project_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    from: usize,
    to: usize,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    if from >= scenes.len() || to >= scenes.len() {
        return Err("scene index out of range".into());
    }
    if from == to {
        return Ok(());
    }
    let entry = scenes.remove(from);
    scenes.insert(to, entry);
    atomic_write_json(&path, &manifest)
}

// ── Copied-document id re-minting ─────────────────────────────────────────────

/// The `<textKey><Suffix>` override keys a sidecar's `textStyle` carries (`sceneDocSchema.ts`).
const TEXT_STYLE_SUFFIXES: [&str; 7] = [
    "Color",
    "Font",
    "Size",
    "OffsetX",
    "OffsetY",
    "LineHeight",
    "RotationDeg",
];

/// Give one entry a fresh `<prefix><n>` id, recording old -> new; an entry with no string id is left alone and takes no number. Repeated ids map to their FIRST sighting, the normalisers' own duplicate rule.
fn mint_id(entry: &mut Value, prefix: &str, n: &mut usize, map: &mut HashMap<String, String>) {
    let Some(old) = entry.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    *n += 1;
    let new = format!("{prefix}{n}");
    entry["id"] = json!(&new);
    map.entry(old).or_insert(new);
}

/// Renumber every entry of an array from 1 (`<prefix>1`, `<prefix>2`, …), returning the old -> new map its references follow.
fn renumber_ids(array: Option<&mut Value>, prefix: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut n = 0usize;
    if let Some(entries) = array.and_then(Value::as_array_mut) {
        for entry in entries {
            mint_id(entry, prefix, &mut n, &mut map);
        }
    }
    map
}

/// Rewrite one string field through a map; an absent or unmapped value is left exactly as it is.
fn remap_field(value: Option<&mut Value>, field: &str, map: &HashMap<String, String>) {
    let Some(object) = value.and_then(Value::as_object_mut) else {
        return;
    };
    let new = object
        .get(field)
        .and_then(Value::as_str)
        .and_then(|id| map.get(id))
        .cloned();
    if let Some(new) = new {
        object.insert(field.into(), json!(new));
    }
}

/// Rewrite an id-keyed record's KEYS through a map (`deviceLayout.devices`, comparison device records, the `ls-` text keys); every mapped entry lifts out before any lands back, so a swap can't clobber.
fn remap_keys(value: Option<&mut Value>, map: &HashMap<String, String>) {
    let Some(object) = value.and_then(Value::as_object_mut) else {
        return;
    };
    let moved: Vec<String> = object
        .keys()
        .filter(|key| map.contains_key(*key))
        .cloned()
        .collect();
    let mut taken: Vec<(String, Value)> = Vec::with_capacity(moved.len());
    for key in moved {
        if let Some(entry) = object.remove(&key) {
            taken.push((map[&key].clone(), entry));
        }
    }
    for (new, entry) in taken {
        object.insert(new, entry);
    }
}

/// Renumber a keyed track's `keys` from `k1` and point its `segments` at them (the shared KeyedTrack model: camera, rig, lighting, compare, chart, screenshot animation).
fn renumber_track(track: Option<&mut Value>) {
    let Some(track) = track else {
        return;
    };
    let keys = renumber_ids(track.get_mut("keys"), "k");
    let Some(segments) = track.get_mut("segments").and_then(Value::as_array_mut) else {
        return;
    };
    for segment in segments {
        remap_field(Some(segment), "from", &keys);
        remap_field(Some(segment), "to", &keys);
    }
}

/// Renumber the screenshot stack's layers (`l1`, …) and its items (`i1`, …, numbered across every layer since one scene shares the item space), rewriting each item's `attach.to`; returns the item map the `ls-<id>` text keys follow.
fn renumber_layered_screenshot(block: Option<&mut Value>) -> HashMap<String, String> {
    let mut items = HashMap::new();
    let Some(block) = block else {
        return items;
    };
    renumber_ids(block.get_mut("layers"), "l");
    let Some(layers) = block.get_mut("layers").and_then(Value::as_array_mut) else {
        return items;
    };
    let mut n = 0usize;
    for layer in layers.iter_mut() {
        if let Some(list) = layer.get_mut("items").and_then(Value::as_array_mut) {
            for item in list {
                mint_id(item, "i", &mut n, &mut items);
            }
        }
    }
    for layer in layers {
        if let Some(list) = layer.get_mut("items").and_then(Value::as_array_mut) {
            for item in list {
                remap_field(item.get_mut("attach"), "to", &items);
            }
        }
    }
    items
}

/// Point the `ls-<itemId>` text and `textStyle` keys at the re-minted items (`LayeredScreenshot.tsx`'s textKey contract).
fn remap_layered_text_keys(doc: &mut Value, items: &HashMap<String, String>) {
    if items.is_empty() {
        return;
    }
    let mut text: HashMap<String, String> = HashMap::new();
    let mut style: HashMap<String, String> = HashMap::new();
    for (old, new) in items {
        let (old, new) = (format!("ls-{old}"), format!("ls-{new}"));
        for suffix in TEXT_STYLE_SUFFIXES {
            style.insert(format!("{old}{suffix}"), format!("{new}{suffix}"));
        }
        text.insert(old, new);
    }
    remap_keys(doc.get_mut("text"), &text);
    remap_keys(doc.get_mut("textStyle"), &style);
}

/// Re-mint every scene-local id in a COPIED sidecar so a duplicate is a genuinely new scene rather than a second document wearing the source's ids: each namespace renumbers from 1 in document order (stable and diffable, these files are committed) and every cross-reference follows its target in the same pass, so a rig aim still finds its device and a segment still finds its keys. Two things deliberately do NOT move: `assets/…` paths (references to files, not ids), and lighting light/fixture ids, which `resolveLighting` merges whole-field across theme, project and scene, so a scene's lighting keys may name ids this document doesn't own.
fn remint_scene_doc_ids(doc: &mut Value) {
    let devices = renumber_ids(doc.get_mut("devices"), "d");
    renumber_ids(doc.get_mut("images"), "img");
    // Nothing in the document references a staged object, so its map is dropped.
    renumber_ids(doc.get_mut("objects"), "o");
    remap_field(doc.get_mut("duration"), "sourceDeviceId", &devices);
    remap_keys(
        doc.get_mut("deviceLayout")
            .and_then(|l| l.get_mut("devices")),
        &devices,
    );
    remap_keys(
        doc.get_mut("compare")
            .and_then(|c| c.get_mut("b"))
            .and_then(|b| b.get_mut("media")),
        &devices,
    );
    remap_keys(
        doc.get_mut("compare")
            .and_then(|c| c.get_mut("b"))
            .and_then(|b| b.get_mut("deviceAppearance")),
        &devices,
    );

    // Only DEVICE ids move here, so only device-bound aims are remapped; media entries keep their own ids (nothing renumbers them, so a `duration.sourceMediaId` or a media aim still finds its entry), and the videoWindow and layeredScreenshot sentinels aren't in the map and stay verbatim, as does an id that resolves to nothing.
    if let Some(keys) = doc
        .get_mut("cameraRig")
        .and_then(|rig| rig.get_mut("keys"))
        .and_then(Value::as_array_mut)
    {
        for key in keys {
            let Some(aim) = key
                .get_mut("pose")
                .and_then(|pose| pose.get_mut("aim"))
                .filter(|aim| aim.get("mode").and_then(Value::as_str) == Some("object"))
            else {
                continue;
            };
            let new = aim
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| devices.get(id))
                .cloned();
            if let Some(new) = new {
                aim["id"] = json!(new);
            }
        }
    }

    renumber_track(doc.get_mut("camera"));
    renumber_track(doc.get_mut("cameraRig"));
    renumber_track(doc.get_mut("lighting"));
    renumber_track(doc.get_mut("compare").and_then(|c| c.get_mut("track")));
    renumber_track(doc.get_mut("chart").and_then(|c| c.get_mut("track")));
    renumber_track(
        doc.get_mut("layeredScreenshot")
            .and_then(|ls| ls.get_mut("animation")),
    );
    renumber_ids(
        doc.get_mut("chart")
            .and_then(|c| c.get_mut("data"))
            .and_then(|d| d.get_mut("series")),
        "s",
    );
    renumber_ids(
        doc.get_mut("frame").and_then(|f| f.get_mut("decorations")),
        "dec",
    );

    let items = renumber_layered_screenshot(doc.get_mut("layeredScreenshot"));
    remap_layered_text_keys(doc, &items);
}

/// Duplicate a scene: the TSX + sidecar copy to a freshly numbered stem (files stay the identity, but the copy mints a fresh unique scene id so React keys and id-keyed UI stay one-to-one, and `remint_scene_doc_ids` renumbers every id INSIDE the sidecar), the manifest entry lands at `position` (omitted/out-of-range = append) with `durationMs` and `transition` riding along; files write before the manifest so a failed manifest write can never point at missing files.
#[tauri::command]
pub fn duplicate_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    index: usize,
    position: Option<usize>,
) -> Result<ScaffoldResult, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let project = root.join(&slug);
    let manifest_path = project.join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    let source = manifest
        .get("scenes")
        .and_then(Value::as_array)
        .ok_or("project.json has no scenes array")?
        .get(index)
        .cloned()
        .ok_or_else(|| format!("project.json has no scene at index {index}"))?;
    let file = source
        .get("file")
        .and_then(Value::as_str)
        .ok_or("scene entry has no file")?
        .to_string();
    if !file.starts_with("scenes/") || file.contains("..") {
        return Err(format!("invalid scene path: {file:?}"));
    }
    let tsx =
        std::fs::read_to_string(project.join(&file)).map_err(|e| format!("reading {file}: {e}"))?;
    let doc_file_src = file.replace(".tsx", ".json");
    let doc = match std::fs::read_to_string(project.join(&doc_file_src)) {
        Ok(text) => Some(
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("scene doc isn't valid JSON: {e}"))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("reading {doc_file_src}: {e}")),
    };

    let scenes_dir = project.join("scenes");
    let stem_src = file.trim_start_matches("scenes/").trim_end_matches(".tsx");
    let source_name = doc
        .as_ref()
        .and_then(|d| d.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // Display-name fallback mirrors the frontend: sidecar name, else the stem minus its numeric prefix.
    let base_name = source_name.clone().unwrap_or_else(|| {
        stem_src
            .split_once('-')
            .map_or(stem_src, |(_, rest)| rest)
            .replace('-', " ")
    });
    let base = slugify(&format!("{base_name} copy"));
    let stem = format!("{:02}-{base}", next_prefix(&scenes_dir));
    let new_file = format!("scenes/{stem}.tsx");
    let new_doc_file = format!("scenes/{stem}.json");

    let scene_id = free_scene_id(&base, &collect_scene_ids(&scenes_dir));
    let tsx = match rewrite_define_scene_id(&tsx, &scene_id) {
        Some(minted) => minted,
        None => {
            log::warn!("{file} has no readable defineScene id, the copy keeps the source's");
            tsx
        }
    };
    atomic_write_text(&scenes_dir.join(format!("{stem}.tsx")), &tsx)?;

    if let Some(mut doc) = doc {
        if let Some(name) = &source_name {
            doc["name"] = json!(format!("{name} copy"));
        }
        remint_scene_doc_ids(&mut doc);
        atomic_write_json(&scene_doc_path(&root, &slug, &new_doc_file)?, &doc)?;
    }

    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    let duration_ms = source
        .get("durationMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SCENE_DURATION_MS);
    let mut entry = json!({ "file": new_file, "durationMs": duration_ms });
    // The source's outgoing transition always rides along (the move_project_scene convention): a copy that lands last carries it inert, and it comes alive if a later copy lands behind it, which is what duplicating a block of scenes needs.
    if let Some(transition) = source.get("transition") {
        entry["transition"] = transition.clone();
    }
    match position {
        Some(i) if i < scenes.len() => scenes.insert(i, entry),
        _ => scenes.push(entry),
    }
    atomic_write_json(&manifest_path, &manifest)?;

    Ok(ScaffoldResult {
        file: new_file,
        doc_file: new_doc_file,
        scene_id,
        duration_ms,
    })
}

fn is_project_asset_ref(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("assets/") else {
        return false;
    };
    !rest.is_empty()
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Every `assets/...` path a scene's TSX mentions; over-capture is harmless because callers gate on the file existing in the source project.
fn scan_asset_refs(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(pos) = text[from..].find("assets/") {
        let start = from + pos;
        let prev = if start == 0 {
            None
        } else {
            Some(bytes[start - 1])
        };
        let standalone = !matches!(prev, Some(p) if p.is_ascii_alphanumeric()
            || matches!(p, b'-' | b'_' | b'.' | b'/'));
        let mut end = start + "assets/".len();
        while end < bytes.len() {
            let c = bytes[end];
            if c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'/' | b' ') {
                end += 1;
            } else {
                break;
            }
        }
        let rel = text[start..end].trim_end_matches([' ', '.']);
        if standalone && is_project_asset_ref(rel) && !found.iter().any(|f| f == rel) {
            found.push(rel.to_string());
        }
        from = end.max(start + 1);
    }
    found
}

fn collect_json_asset_refs(value: &Value) -> Vec<String> {
    fn walk(value: &Value, found: &mut Vec<String>, seen: &mut HashSet<String>) {
        match value {
            Value::String(path) if is_project_asset_ref(path) => {
                if seen.insert(path.clone()) {
                    found.push(path.clone());
                }
            }
            Value::Array(values) => {
                for value in values {
                    walk(value, found, seen);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    walk(value, found, seen);
                }
            }
            _ => {}
        }
    }

    let mut found = Vec::new();
    let mut seen = HashSet::new();
    walk(value, &mut found, &mut seen);
    found
}

fn rewrite_json_asset_refs(value: &mut Value, replacements: &[(String, String)]) {
    match value {
        Value::String(path) => {
            if let Some((_, replacement)) = replacements.iter().find(|(source, _)| source == path) {
                *path = replacement.clone();
            }
        }
        Value::Array(values) => {
            for value in values {
                rewrite_json_asset_refs(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                rewrite_json_asset_refs(value, replacements);
            }
        }
        _ => {}
    }
}

fn rewrite_text_asset_refs(text: &str, replacements: &[(String, String)]) -> String {
    fn path_byte(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b' ')
    }

    fn find_standalone(text: &str, from: usize, source: &str) -> Option<usize> {
        let bytes = text.as_bytes();
        let mut search_from = from;
        while let Some(offset) = text[search_from..].find(source) {
            let start = search_from + offset;
            let end = start + source.len();
            let starts_clean = start == 0 || !path_byte(bytes[start - 1]);
            let ends_clean = end == bytes.len() || !path_byte(bytes[end]);
            if starts_clean && ends_clean {
                return Some(start);
            }
            search_from = end;
        }
        None
    }

    let mut rewritten = String::with_capacity(text.len());
    let mut from = 0;
    while from < text.len() {
        let next = replacements
            .iter()
            .filter_map(|(source, replacement)| {
                find_standalone(text, from, source).map(|start| (start, source, replacement))
            })
            .min_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.len().cmp(&a.1.len())));
        let Some((start, source, replacement)) = next else {
            rewritten.push_str(&text[from..]);
            break;
        };
        rewritten.push_str(&text[from..start]);
        rewritten.push_str(replacement);
        from = start + source.len();
    }
    rewritten
}

/// First free sibling name for `name` in `dir`: stem-2.ext, stem-3.ext, …
fn free_sibling_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_owned(), Some(e.to_owned())),
        _ => (name.to_owned(), None),
    };
    let mut n = 1u32;
    loop {
        n += 1;
        let candidate = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
}

fn copy_scene_assets(
    project: &Path,
    dest: &Path,
    tsx: &mut String,
    doc: &mut Option<Value>,
) -> Result<(), String> {
    let mut refs = scan_asset_refs(tsx);
    if let Some(doc) = doc.as_ref() {
        for rel in collect_json_asset_refs(doc) {
            if !refs.iter().any(|existing| existing == &rel) {
                refs.push(rel);
            }
        }
    }

    let mut replacements = Vec::new();
    for rel in refs {
        let src_path = project.join(&rel);
        if !src_path.is_file() {
            continue;
        }
        let (dir_rel, name) = rel.rsplit_once('/').unwrap_or(("assets", rel.as_str()));
        let dest_dir = dest.join(dir_rel);
        let mut dest_path = dest_dir.join(name);
        if dest_path.is_file() {
            let same = std::fs::read(&src_path)
                .and_then(|a| std::fs::read(&dest_path).map(|b| a == b))
                .unwrap_or(false);
            if same {
                continue;
            }
            let free = free_sibling_name(&dest_dir, name);
            let new_rel = format!("{dir_rel}/{free}");
            dest_path = dest_dir.join(&free);
            replacements.push((rel.clone(), new_rel));
        }
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        std::fs::copy(&src_path, &dest_path).map_err(|e| format!("copying {rel}: {e}"))?;
        workspace::touch_now(&dest_path);
    }

    if !replacements.is_empty() {
        *tsx = rewrite_text_asset_refs(tsx, &replacements);
        if let Some(doc) = doc.as_mut() {
            rewrite_json_asset_refs(doc, &replacements);
        }
    }
    Ok(())
}

/// Copy a scene into ANOTHER workspace project: the TSX + sidecar land under a freshly numbered stem carrying an id unique in the destination (and a sidecar re-minted by `remint_scene_doc_ids`), every referenced `assets/` file copies along (identical bytes reuse the destination's file; a clash with different bytes free-names the copy and the scene text re-points), and the manifest entry appends with `durationMs` and `effects` (no outgoing transition: the scene lands last). Files write before the manifest, the duplicate_scene ordering.
#[tauri::command]
pub fn copy_scene_to_project(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    index: usize,
    dest_slug: String,
) -> Result<ScaffoldResult, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&dest_slug)?;
    if slug == dest_slug {
        return Err("pick a different project to copy into".into());
    }
    let project = root.join(&slug);
    let dest = root.join(&dest_slug);
    let dest_manifest_path = dest.join(MANIFEST_FILENAME);
    if !dest_manifest_path.is_file() {
        return Err(format!("no project named {dest_slug} in the workspace"));
    }

    let text = std::fs::read_to_string(project.join(MANIFEST_FILENAME))
        .map_err(|e| format!("reading project.json: {e}"))?;
    let source_manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    let source = source_manifest
        .get("scenes")
        .and_then(Value::as_array)
        .ok_or("project.json has no scenes array")?
        .get(index)
        .cloned()
        .ok_or_else(|| format!("project.json has no scene at index {index}"))?;
    let file = source
        .get("file")
        .and_then(Value::as_str)
        .ok_or("scene entry has no file")?
        .to_string();
    if !file.starts_with("scenes/") || file.contains("..") {
        return Err(format!("invalid scene path: {file:?}"));
    }
    let mut tsx =
        std::fs::read_to_string(project.join(&file)).map_err(|e| format!("reading {file}: {e}"))?;
    let doc_file_src = file.replace(".tsx", ".json");
    let mut doc = match std::fs::read_to_string(project.join(&doc_file_src)) {
        Ok(text) => Some(
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("scene doc isn't valid JSON: {e}"))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("reading {doc_file_src}: {e}")),
    };

    copy_scene_assets(&project, &dest, &mut tsx, &mut doc)?;

    // Fresh stem in the destination, keeping the source's display name.
    let scenes_dir = dest.join("scenes");
    std::fs::create_dir_all(&scenes_dir).map_err(|e| e.to_string())?;
    let stem_src = file.trim_start_matches("scenes/").trim_end_matches(".tsx");
    let base_name = doc
        .as_ref()
        .and_then(|d| d.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            stem_src
                .split_once('-')
                .map_or(stem_src, |(_, rest)| rest)
                .replace('-', " ")
        });
    let base = slugify(&base_name);
    let stem = format!("{:02}-{base}", next_prefix(&scenes_dir));
    let new_file = format!("scenes/{stem}.tsx");
    let new_doc_file = format!("scenes/{stem}.json");

    // Minted against the DESTINATION's ids, and after the asset re-point so the splice is the last edit.
    let scene_id = free_scene_id(&base, &collect_scene_ids(&scenes_dir));
    match rewrite_define_scene_id(&tsx, &scene_id) {
        Some(minted) => tsx = minted,
        None => log::warn!("{file} has no readable defineScene id, the copy keeps the source's"),
    }
    atomic_write_text(&scenes_dir.join(format!("{stem}.tsx")), &tsx)?;
    if let Some(doc) = &mut doc {
        remint_scene_doc_ids(doc);
        atomic_write_json(&scene_doc_path(&root, &dest_slug, &new_doc_file)?, doc)?;
    }

    let dest_text = std::fs::read_to_string(&dest_manifest_path)
        .map_err(|e| format!("reading {dest_slug}/project.json: {e}"))?;
    let mut dest_manifest: Value = serde_json::from_str(&dest_text)
        .map_err(|e| format!("{dest_slug}/project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut dest_manifest);
    let scenes = dest_manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or(format!("{dest_slug}/project.json has no scenes array"))?;
    let duration_ms = source
        .get("durationMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SCENE_DURATION_MS);
    let mut entry = json!({ "file": new_file, "durationMs": duration_ms });
    if let Some(effects) = source.get("effects") {
        entry["effects"] = effects.clone();
    }
    scenes.push(entry);
    atomic_write_json(&dest_manifest_path, &dest_manifest)?;

    Ok(ScaffoldResult {
        file: new_file,
        doc_file: new_doc_file,
        scene_id,
        duration_ms,
    })
}

/// Set a project's project-level theme (`project.json.themeId`, atomic), the New-project theme step and the main-window theme mode; the id is either a bundled `kookaburra-*` or a workspace `ws:<slug>`, the frontend resolves (and degrades) it on load.
#[tauri::command]
pub fn set_project_theme(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    theme_id: String,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    manifest["themeId"] = json!(theme_id);
    atomic_write_json(&path, &manifest)
}

/// Set or remove the project soundtrack (`project.json.audio`, atomic), the media library's "Use as soundtrack" write surface; schema-light (the `set_project_theme` precedent): must be an object with a string `file` when present, the loader probes and degrades.
#[tauri::command]
pub fn set_project_audio(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    audio: Option<Value>,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    if let Some(spec) = &audio {
        let ok = spec
            .as_object()
            .and_then(|o| o.get("file"))
            .map(Value::is_string)
            .unwrap_or(false);
        if !ok {
            return Err("audio must be an object with a string `file`".into());
        }
    }
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    match audio {
        Some(spec) => manifest["audio"] = spec,
        None => {
            if let Some(obj) = manifest.as_object_mut() {
                obj.remove("audio");
            }
        }
    }
    atomic_write_json(&path, &manifest)
}

// ── Scene identity ────────────────────────────────────────────────────────────

/// How far past `defineScene({` the id scan reads; the id is the first key in every template, so a scene that buries it deeper simply keeps whatever id it has.
const SCENE_ID_SCAN_BUDGET: usize = 4096;

/// Bigger than any scene TSX (a few KiB): the id scan and the healer skip anything above it rather than read it into memory.
const SCENE_TSX_MAX_BYTES: u64 = 512 * 1024;

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$')
}

/// Index of the next non-whitespace byte at or after `i`.
fn skip_ws(bytes: &[u8], mut i: usize) -> Option<usize> {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() {
        Some(i)
    } else {
        None
    }
}

/// Content span of the string literal opening at `q`; a template literal carrying `${` is refused because an interpolated id isn't a stable identity.
fn string_content(bytes: &[u8], q: usize) -> Option<(usize, usize)> {
    let quote = *bytes.get(q)?;
    if !matches!(quote, b'"' | b'\'' | b'`') {
        return None;
    }
    let mut i = q + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'$' if quote == b'`' && bytes.get(i + 1) == Some(&b'{') => return None,
            c if c == quote => return Some((q + 1, i)),
            _ => i += 1,
        }
    }
    None
}

/// Index just past the string literal opening at `q`.
fn skip_string(bytes: &[u8], q: usize, end: usize) -> Option<usize> {
    let quote = bytes[q];
    let mut i = q + 1;
    while i < end {
        match bytes[i] {
            b'\\' => i += 2,
            c if c == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Walk the object literal opening at `open` and return the span of its top-level `id` string; comments and strings are opaque, and the key must sit in key position at depth 1 so `key={d.id}` and a nested device's `id` can never match.
fn scan_scene_id(bytes: &[u8], open: usize) -> Option<(usize, usize)> {
    let end = bytes.len().min(open.saturating_add(SCENE_ID_SCAN_BUDGET));
    let mut i = open + 1;
    let mut depth = 1usize;
    let mut prev = b'{';
    while i < end {
        let c = bytes[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            i += 2;
            while i < end && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < end && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = end.min(i + 2);
            continue;
        }
        if matches!(c, b'"' | b'\'' | b'`') {
            i = skip_string(bytes, i, end)?;
            prev = c;
            continue;
        }
        if depth == 1 && matches!(prev, b'{' | b',') && bytes[i..].starts_with(b"id") {
            if let Some(colon) = skip_ws(bytes, i + 2).filter(|&j| bytes[j] == b':') {
                return string_content(bytes, skip_ws(bytes, colon + 1)?);
            }
        }
        match c {
            b'{' | b'[' | b'(' => depth += 1,
            b'}' | b']' | b')' => {
                depth -= 1;
                if depth == 0 {
                    return None;
                }
            }
            _ => {}
        }
        prev = c;
        i += 1;
    }
    None
}

/// Byte span of a scene's `defineScene({ id: "…" })` literal CONTENT (quotes excluded); hand-rolled scanning in the `scan_asset_refs` style, since the shell carries no regex crate. The call is the token followed by `(` then `{`, which leaves the import line and a doc-comment mention behind.
fn find_define_scene_id(src: &str) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let mut from = 0usize;
    while from < src.len() {
        let token = from + src[from..].find("defineScene")?;
        from = token + "defineScene".len();
        if token > 0 && is_ident_byte(bytes[token - 1]) {
            continue;
        }
        let Some(paren) = skip_ws(bytes, from).filter(|&i| bytes[i] == b'(') else {
            continue;
        };
        let Some(brace) = skip_ws(bytes, paren + 1).filter(|&i| bytes[i] == b'{') else {
            continue;
        };
        if let Some(span) = scan_scene_id(bytes, brace) {
            return Some(span);
        }
    }
    None
}

/// Mint a new id into a scene's `defineScene` call: a pure byte splice, so every other byte of the file survives verbatim.
fn rewrite_define_scene_id(src: &str, new_id: &str) -> Option<String> {
    let (start, end) = find_define_scene_id(src)?;
    let mut out = String::with_capacity(src.len() + new_id.len());
    out.push_str(&src[..start]);
    out.push_str(new_id);
    out.push_str(&src[end..]);
    Some(out)
}

/// First free scene id for `base`: base, base-2, base-3, … (the `free_sibling_name` shape).
fn free_scene_id(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 1u32;
    loop {
        n += 1;
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
}

/// A scene's minted id and its text; `None` for a file that is missing, oversized, not UTF-8, or carries no `defineScene` id (persistent morph modules share `scenes/`).
fn read_scene_id(path: &Path) -> Option<(String, String)> {
    if std::fs::metadata(path).ok()?.len() > SCENE_TSX_MAX_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let (start, end) = find_define_scene_id(&text)?;
    Some((text[start..end].to_string(), text))
}

/// Every scene id currently minted under `scenes/`.
fn collect_scene_ids(scenes_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(entries) = std::fs::read_dir(scenes_dir) else {
        return ids;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tsx") {
            continue;
        }
        if let Some((id, _)) = read_scene_id(&path) {
            ids.insert(id);
        }
    }
    ids
}

/// A scene file's stem minus its numeric prefix, slugified: "09-panel-6-copy" gives "panel-6-copy".
fn stem_base_id(stem: &str) -> String {
    let base = match stem.split_once('-') {
        Some((prefix, rest))
            if !prefix.is_empty()
                && !rest.is_empty()
                && prefix.bytes().all(|b| b.is_ascii_digit()) =>
        {
            rest
        }
        _ => stem,
    };
    slugify(base)
}

/// One healed scene: the file, the id it shared and the id it now owns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneIdRename {
    pub file: String,
    pub from: String,
    pub to: String,
}

/// What a heal pass did: the scenes it re-minted, and the ones it could not read or parse (left untouched).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneIdHeal {
    pub renamed: Vec<SceneIdRename>,
    pub unparsed: Vec<String>,
}

/// Heal a project's duplicate scene ids in place: first sighting keeps its id, every repeat gets a fresh one spliced into its own TSX, visiting the manifest's scenes in order and then any stray `scenes/*.tsx` by filename. Idempotent, writes only the files it changes, and never fails: a project.json it cannot read and a scene it cannot parse are both reported, not rewritten.
pub(crate) fn heal_scene_ids(project_dir: &Path) -> SceneIdHeal {
    let mut heal = SceneIdHeal::default();
    let Some(manifest) = std::fs::read_to_string(project_dir.join(MANIFEST_FILENAME))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return heal;
    };

    let mut order: Vec<String> = Vec::new();
    if let Some(scenes) = manifest.get("scenes").and_then(Value::as_array) {
        for entry in scenes {
            let Some(file) = entry.get("file").and_then(Value::as_str) else {
                continue;
            };
            if !file.starts_with("scenes/") || file.contains("..") {
                continue;
            }
            if !order.iter().any(|f| f == file) {
                order.push(file.to_string());
            }
        }
    }
    let mut strays: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(project_dir.join("scenes")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".tsx") {
                continue;
            }
            let file = format!("scenes/{name}");
            if !order.iter().any(|f| f == &file) {
                strays.push(file);
            }
        }
    }
    strays.sort();
    order.extend(strays);

    let mut taken: HashSet<String> = HashSet::new();
    let mut scanned: Vec<(String, Option<(String, String)>)> = Vec::new();
    for file in order {
        let found = read_scene_id(&project_dir.join(&file));
        match &found {
            Some((id, _)) => {
                taken.insert(id.clone());
            }
            None => log::warn!("no readable scene id in {file}, leaving it alone"),
        }
        scanned.push((file, found));
    }

    let mut seen: HashSet<String> = HashSet::new();
    for (file, found) in scanned {
        let Some((id, text)) = found else {
            heal.unparsed.push(file);
            continue;
        };
        if seen.insert(id.clone()) {
            continue;
        }
        let stem = file
            .rsplit_once('/')
            .map_or(file.as_str(), |(_, name)| name)
            .trim_end_matches(".tsx");
        let to = free_scene_id(&stem_base_id(stem), &taken);
        let Some(next) = rewrite_define_scene_id(&text, &to) else {
            continue;
        };
        if next == text {
            continue;
        }
        if let Err(e) = atomic_write_text(&project_dir.join(&file), &next) {
            log::warn!("healing {file}: {e}");
            continue;
        }
        seen.insert(to.clone());
        taken.insert(to.clone());
        heal.renamed.push(SceneIdRename { file, from: id, to });
    }
    heal
}

/// Give every scene in a project its own id, healing the collisions older duplicate/copy actions left behind (they copied the TSX verbatim); safe to call on load, it rewrites nothing when the ids are already unique.
#[tauri::command]
pub fn ensure_unique_scene_ids(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<SceneIdHeal, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    Ok(heal_scene_ids(&root.join(&slug)))
}

// ── Scaffolder ────────────────────────────────────────────────────────────────

// Scene TSX templates (compile-time baked, packaged-build safe); the same files are the single source for the `/new-scene` command, which reads them from the repo tree.
const TSX_DEVICE: &str = include_str!("../templates/scenes/device.tsx.tmpl");
const TSX_TITLE: &str = include_str!("../templates/scenes/title.tsx.tmpl");
const TSX_OVERLAY: &str = include_str!("../templates/scenes/overlay.tsx.tmpl");
const TSX_BLANK: &str = include_str!("../templates/scenes/blank.tsx.tmpl");
const TSX_APP_VERSION: &str = include_str!("../templates/scenes/appversion.tsx.tmpl");
const TSX_LAYERED_SCREENSHOT: &str = include_str!("../templates/scenes/layeredscreenshot.tsx.tmpl");
const TSX_CHART: &str = include_str!("../templates/scenes/chart.tsx.tmpl");
const TSX_VIDEO: &str = include_str!("../templates/scenes/video.tsx.tmpl");
const TSX_IMAGE: &str = include_str!("../templates/scenes/image.tsx.tmpl");
const TSX_VIDEO_WINDOW: &str = include_str!("../templates/scenes/videowindow.tsx.tmpl");
const TSX_COMPARISON: &str = include_str!("../templates/scenes/comparison.tsx.tmpl");

/// The video kind's default background, shipped in every project (`ensure_sample_assets`).
const SAMPLE_LAPTOP_VIDEO: &str = "assets/sample-laptop-recording.mp4";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldOptions {
    /// "device" | "deviceonly" | "comparison" | "title" | "titleicon" | "appversion" | "layeredscreenshot" | "chart" | "video" | "image" | "videowindow" | "overlaystart" | "overlayend" | "overlaypanel" | "blank".
    pub kind: String,
    /// Human scene name, e.g. "Hero demo" (sidecar `name`; slugified for the file stem).
    pub name: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    /// Cutout scenes: newline-delimited bullet lines for the panel body (sidecar `text.bullets`).
    #[serde(default)]
    pub bullets: Option<String>,
    pub device_model: Option<String>,
    pub colour: Option<String>,
    /// Project-relative media path (e.g. "assets/demo.mp4").
    pub media_rel: Option<String>,
    /// "video" | "image".
    pub media_kind: Option<String>,
    /// Comparison scenes: the second (after) device's media, same shapes as the first.
    #[serde(default)]
    pub media_rel_b: Option<String>,
    #[serde(default)]
    pub media_kind_b: Option<String>,
    /// Comparison scenes: total device count (2-4, default 2).
    #[serde(default)]
    pub device_count: Option<usize>,
    /// Comparison scenes: per-device media aligned to d1..dn; supersedes the rel/relB pair when present.
    #[serde(default)]
    pub media_slots: Option<Vec<ScaffoldMediaSlot>>,
    #[serde(default)]
    pub motion_preset: Option<String>,
    #[serde(default)]
    pub shadow: Option<String>,
    /// Title-icon scenes: the sidecar `headerIcon` (emoji or asset path).
    #[serde(default)]
    pub header_icon: Option<String>,
    /// Chart scenes: the wizard's type ("column", "bar", "pie"…), "2d"|"3d" and the starter dataset; each absent field keeps the chart arm's own default.
    #[serde(default)]
    pub chart_type: Option<String>,
    #[serde(default)]
    pub chart_dimension: Option<String>,
    #[serde(default)]
    pub chart_data: Option<ScaffoldChartData>,
    /// Video-window scenes: the picked clip looked like a raw macOS window recording (the wizard's poster detection; Rust can't see pixels).
    #[serde(default)]
    pub recording: Option<bool>,
    /// Insertion index in `project.json`'s scenes array (0 = start; omitted/out-of-range = append).
    pub position: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldMediaSlot {
    pub rel: Option<String>,
    /// "video" | "image".
    pub kind: Option<String>,
}

/// One starter dataset for a chart scene: the block's `data`, rows aligned to `categories`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldChartData {
    pub categories: Vec<String>,
    pub series: Vec<ScaffoldChartSeries>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldChartSeries {
    pub id: String,
    pub name: Option<String>,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldResult {
    pub file: String,
    pub doc_file: String,
    pub scene_id: String,
    pub duration_ms: u64,
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == ' ' || c == '-' || c == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "scene".into()
    } else {
        trimmed
    }
}

/// Next zero-padded numeric prefix in `scenes/` (the `/new-scene` convention).
fn next_prefix(scenes_dir: &Path) -> u32 {
    let mut max = 0u32;
    if let Ok(read) = std::fs::read_dir(scenes_dir) {
        for entry in read.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(n) = name.split('-').next().and_then(|p| p.parse::<u32>().ok()) {
                max = max.max(n);
            }
        }
    }
    max + 1
}

/// Copy the project's `appliedBackground` stamp (what "Apply everywhere" last wrote) onto a fresh sidecar, so a new scene matches the deck: skipped whole when the kind staged its own background (video, and image with a pick), and never over an explicit backdrop (the video window keeps its cleared stage).
fn inherit_applied_background(doc: &mut Value, stamp: Option<&Value>) {
    let Some(stamp) = stamp.filter(|_| doc.get("background").is_none()) else {
        return;
    };
    if let Some(background) = stamp.get("background") {
        doc["background"] = background.clone();
    }
    if let Some(backdrop) = stamp.get("backdrop") {
        if doc.get("backdrop").is_none() {
            doc["backdrop"] = backdrop.clone();
        }
    }
}

fn resolved_claimed_frame_icon(doc: &Value, deck_frame: Option<&Value>) -> Option<String> {
    fn valid_frame(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
        value.and_then(Value::as_object).filter(|frame| {
            frame
                .get("cutout")
                .and_then(Value::as_object)
                .and_then(|cutout| cutout.get("shape"))
                .and_then(Value::as_str)
                .is_some_and(|shape| {
                    matches!(
                        shape,
                        "rect" | "rounded-rect" | "squircle" | "circle" | "capsule" | "none"
                    )
                })
        })
    }

    let deck = valid_frame(deck_frame);
    let scene = doc.get("frame").and_then(Value::as_object);
    if valid_frame(doc.get("frame")).is_none() && deck.is_none() {
        return None;
    }
    let enabled = scene
        .and_then(|frame| frame.get("enabled"))
        .and_then(Value::as_bool)
        .or_else(|| {
            deck.and_then(|frame| frame.get("enabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    if !enabled {
        return None;
    }
    let claims_scene_text = scene
        .and_then(|frame| frame.get("claimsSceneText"))
        .and_then(Value::as_bool)
        .or_else(|| {
            deck.and_then(|frame| frame.get("claimsSceneText"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    if !claims_scene_text {
        return None;
    }
    Some(
        scene
            .and_then(|frame| frame.get("icon"))
            .and_then(Value::as_str)
            .or_else(|| {
                deck.and_then(|frame| frame.get("icon"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("")
            .to_string(),
    )
}

fn scaffold_managed_text(kind: &str, doc: &Value, deck_frame: Option<&Value>) -> Option<Value> {
    fn item(key: &str, item_type: &str, text: &str) -> Value {
        json!({ "key": key, "type": item_type, "text": text })
    }

    let text = doc.get("text").and_then(Value::as_object);
    let title = text
        .and_then(|values| values.get("title"))
        .and_then(Value::as_str);
    let subtitle = text
        .and_then(|values| values.get("subtitle"))
        .and_then(Value::as_str);
    let claimed_frame_icon = resolved_claimed_frame_icon(doc, deck_frame);
    let mut items = match kind {
        "title" | "overlaystart" | "overlayend" | "overlaypanel" | "device" | "comparison"
        | "videowindow" => vec![
            item("title", "title", title.unwrap_or("")),
            item("subtitle", "subtitle", subtitle.unwrap_or("")),
        ],
        "titleicon" => vec![
            json!({
                "key": "icon",
                "type": "icon",
                "icon": doc
                    .get("headerIcon")
                    .and_then(Value::as_str)
                    .unwrap_or("🚀"),
            }),
            item("title", "title", title.unwrap_or("")),
            item("subtitle", "subtitle", subtitle.unwrap_or("")),
        ],
        "appversion" => vec![
            json!({ "key": "icon", "type": "icon", "icon": "assets/app-icon.png" }),
            item("title", "subtitle", title.unwrap_or("Your App")),
            item("subtitle", "title", subtitle.unwrap_or("1.0")),
        ],
        "chart" | "blank" | "layeredscreenshot" => {
            vec![item("title", "title", title.unwrap_or(""))]
        }
        _ => return None,
    };

    if let Some(icon) = claimed_frame_icon {
        items.insert(
            0,
            json!({ "key": "frameIcon", "type": "icon", "icon": icon }),
        );
    }

    if matches!(kind, "overlaystart" | "overlayend" | "overlaypanel") {
        if let Some(bullets) = text
            .and_then(|values| values.get("bullets"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let points = bullets
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .enumerate()
                .map(|(index, line)| {
                    json!({ "key": format!("bullets-point-{}", index + 1), "text": line })
                })
                .collect::<Vec<_>>();
            items.push(json!({
                "key": "bullets",
                "type": "bullets",
                "text": bullets,
                "points": points,
            }));
        }
    }

    Some(json!({ "layout": "template", "items": items }))
}

/// Scaffold a scene natively: TSX from the bundled template + sidecar doc + project.json registration, all writes atomic; video media sets the duration to the media's length (duration-follow), title scenes use 2600ms, charts use 5000ms and other scenes use 4000ms.
#[tauri::command]
pub async fn scaffold_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    mut options: ScaffoldOptions,
) -> Result<ScaffoldResult, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let project = root.join(&slug);
    let manifest_path = project.join(MANIFEST_FILENAME);
    if !manifest_path.is_file() {
        return Err(format!("project \"{slug}\" has no project.json"));
    }
    let scaffold_manifest = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    // The project-wide stamp the inspector's "Apply everywhere" leaves behind; absent, or any non-object, means new scenes follow the theme.
    let applied_background = scaffold_manifest
        .as_ref()
        .and_then(|manifest| manifest.get("appliedBackground"))
        .cloned()
        .filter(Value::is_object);
    let deck_frame = scaffold_manifest
        .as_ref()
        .and_then(|manifest| manifest.get("frame"))
        .cloned()
        .filter(Value::is_object);

    let template = match options.kind.as_str() {
        "device" | "deviceonly" => TSX_DEVICE,
        "comparison" => TSX_COMPARISON,
        // The overlay kinds ride the title base: the panel suppresses TitleBlock and shows the same text itself; the cutout pair's variant lifts the scene clear so the window reads against the flat panel.
        "title" | "titleicon" | "overlaypanel" => TSX_TITLE,
        "overlaystart" | "overlayend" => TSX_OVERLAY,
        "blank" => TSX_BLANK,
        "appversion" => TSX_APP_VERSION,
        "layeredscreenshot" => TSX_LAYERED_SCREENSHOT,
        "chart" => TSX_CHART,
        "video" => TSX_VIDEO,
        "image" => TSX_IMAGE,
        "videowindow" => TSX_VIDEO_WINDOW,
        other => return Err(format!("unknown scene kind {other:?}")),
    };
    let is_device_kind = matches!(options.kind.as_str(), "device" | "deviceonly");
    let is_comparison = options.kind == "comparison";

    // A video or video-window scene without a pick starts on the bundled laptop sample.
    if matches!(options.kind.as_str(), "video" | "videowindow") && options.media_rel.is_none() {
        options.media_rel = Some(SAMPLE_LAPTOP_VIDEO.into());
        options.media_kind = Some("video".into());
    }

    let scenes_dir = project.join("scenes");
    std::fs::create_dir_all(&scenes_dir).map_err(|e| e.to_string())?;
    let base = slugify(&options.name);
    let stem = format!("{:02}-{base}", next_prefix(&scenes_dir));
    let scene_id = free_scene_id(&base, &collect_scene_ids(&scenes_dir));
    let file = format!("scenes/{stem}.tsx");
    let doc_file = format!("scenes/{stem}.json");

    // Duration: follow the video when the scene owns one, else the wizard default.
    let is_video = matches!(
        options.kind.as_str(),
        "device" | "deviceonly" | "video" | "videowindow"
    ) && options.media_kind.as_deref() == Some("video")
        && options.media_rel.is_some();
    let mut duration_ms = default_scene_duration_ms(&options.kind);
    let mut media_aspect: Option<f64> = None;
    if is_video {
        if let Some(rel) = &options.media_rel {
            let abs = project.join(rel);
            let probed = media::probe_media(&app, &abs).await?;
            if probed.duration_ms > 0 {
                duration_ms = probed.duration_ms;
            }
            if probed.width > 0 && probed.height > 0 {
                media_aspect = Some(f64::from(probed.width) / f64::from(probed.height));
            }
        }
    }
    // Comparison: d1..dn from the slots array (falling back to the legacy rel/relB pair), count clamped 2-4.
    let comparison_slots: Vec<(Option<String>, Option<String>)> = if is_comparison {
        let mut slots: Vec<(Option<String>, Option<String>)> = match &options.media_slots {
            Some(list) => list
                .iter()
                .map(|s| (s.rel.clone(), s.kind.clone()))
                .collect(),
            None => vec![
                (options.media_rel.clone(), options.media_kind.clone()),
                (options.media_rel_b.clone(), options.media_kind_b.clone()),
            ],
        };
        let count = options
            .device_count
            .unwrap_or(slots.len().max(2))
            .clamp(2, 4);
        slots.resize(count, (None, None));
        slots.truncate(count);
        slots
    } else {
        Vec::new()
    };
    // Probe every video slot and follow the longest clip so no recording is cut short; the sidecar stays unpinned (the engine's follow-media rule is longest-wins).
    let mut comparison_has_video = false;
    if is_comparison {
        let mut best: u64 = 0;
        for (rel, kind) in &comparison_slots {
            if kind.as_deref() != Some("video") {
                continue;
            }
            if let Some(rel) = rel {
                comparison_has_video = true;
                let probed = media::probe_media(&app, &project.join(rel)).await?;
                if probed.duration_ms > best {
                    best = probed.duration_ms;
                }
            }
        }
        if best > 0 {
            duration_ms = best;
        }
    }

    // The sidecar document (built here, not templated; Rust owns the schema).
    let mut doc = json!({
        "version": SCENE_DOC_VERSION,
        "name": options.name,
        "duration": if comparison_has_video {
            json!({ "mode": "follow-media" })
        } else if is_video && is_device_kind {
            json!({ "mode": "follow-media", "sourceDeviceId": "d1" })
        } else if is_video && options.kind == "videowindow" {
            json!({ "mode": "follow-media", "source": "media", "sourceMediaId": "vid1" })
        } else if is_video {
            // No device: the resync falls back to the video background as the source.
            json!({ "mode": "follow-media" })
        } else {
            json!({ "mode": "manual" })
        },
        "text": {},
    });
    // Text-bearing kinds seed the title/subtitle pair (empty strings keep the panel fields visible); app-version scenes seed the lockup with placeholder copy since an icon beside empty text reads as broken; other kinds write `title` only when copy was given (older scenes keep their legacy `headline` key).
    let seeds_text_pair = matches!(
        options.kind.as_str(),
        "title"
            | "titleicon"
            | "overlaystart"
            | "overlayend"
            | "overlaypanel"
            | "device"
            | "comparison"
            | "videowindow"
    );
    if seeds_text_pair {
        doc["text"]["title"] = json!(options.title.as_deref().unwrap_or(""));
        doc["text"]["subtitle"] = json!(options.subtitle.as_deref().unwrap_or(""));
        if let Some(bullets) = options.bullets.as_deref().filter(|b| !b.trim().is_empty()) {
            doc["text"]["bullets"] = json!(bullets);
        }
        if is_comparison {
            // Neutral scaffold (batch 10): the label chips appear only when copy is typed.
            doc["text"]["beforeLabel"] = json!("");
            doc["text"]["afterLabel"] = json!("");
        }
    } else if options.kind == "appversion" {
        doc["text"]["title"] = json!(options.title.as_deref().unwrap_or("Your App"));
        doc["text"]["subtitle"] = json!(options.subtitle.as_deref().unwrap_or("1.0"));
    } else {
        if let Some(title) = &options.title {
            doc["text"]["title"] = json!(title);
        }
        if let Some(subtitle) = &options.subtitle {
            doc["text"]["subtitle"] = json!(subtitle);
        }
    }
    if options.kind == "titleicon" {
        doc["headerIcon"] = json!(options.header_icon.as_deref().unwrap_or("🚀"));
    }
    // Overlay trio: a sidecar frame stands alone when it carries a cutout; the panel variant uses the real full-panel shape ("none": no cutout, content centred). The cutout pair pins the panel to the flat background token, paired with the template's lifted scene clear.
    let overlay_frame = match options.kind.as_str() {
        "overlaystart" => Some(json!({
            "cutout": { "shape": "rounded-rect", "side": "start" },
            "background": "background",
        })),
        "overlayend" => Some(json!({
            "cutout": { "shape": "rounded-rect", "side": "end" },
            "background": "background",
        })),
        "overlaypanel" => Some(json!({
            "cutout": { "shape": "none" },
        })),
        _ => None,
    };
    if let Some(frame) = overlay_frame {
        // No starter chip: the slide pass paints the panel and its cutout whether or not the panel carries content. The full-panel variant has no cutout to read, so a copy-less one seeds a starter title instead of landing a flat, empty frame.
        if options.kind == "overlaypanel" && doc["text"]["title"].as_str() == Some("") {
            doc["text"]["title"] = json!("Your title");
        }
        doc["frame"] = frame;
    }
    if let Some(managed_text) = scaffold_managed_text(&options.kind, &doc, deck_frame.as_ref()) {
        doc["managedText"] = managed_text;
    }
    if options.kind == "videowindow" {
        if let Some(rel) = &options.media_rel {
            let mut video = json!({});
            if let Some(aspect) = media_aspect {
                video["aspect"] = json!(aspect);
            }
            let mut window = json!({
                "radius": "macos",
                "border": { "enabled": false, "color": "#ffffff", "width": 0.0035, "opacity": 0.12 },
            });
            if options.recording == Some(true) {
                window["recording"] = json!(true);
            }
            // Text sits above the window: one line steps the window down, two also shrink it. The overlay position is half-frame relative, so it doubles the legacy whole-frame offset.
            let title_line = options
                .title
                .as_deref()
                .is_some_and(|t| !t.trim().is_empty());
            let subtitle_line = options
                .subtitle
                .as_deref()
                .is_some_and(|t| !t.trim().is_empty());
            let (size, offset_y) = if title_line && subtitle_line {
                (0.65, -0.16)
            } else if title_line || subtitle_line {
                (0.72, -0.10)
            } else {
                (0.72, 0.0)
            };
            doc["media"] = json!([{
                "id": "vid1",
                "kind": "video",
                "src": rel,
                "host": "overlay",
                "stage": { "position": [0.0, 0.0, 0.0], "size": 5.3, "rotationDeg": [0.0, 0.0, 0.0] },
                "overlay": {
                    "position": [0.0, offset_y],
                    "size": size,
                    "rotationDeg": 0.0,
                    "shape": "none",
                    "layer": "below",
                },
                "window": window,
                "video": video,
            }]);
            // The window floats over the scene's own background; staged scenery would clip its shadow.
            doc["backdrop"] = json!({ "type": "none" });
        }
    }
    if options.kind == "layeredscreenshot" {
        // The optional first screen seeds the centre item; the builder grows the stack from there.
        let mut items = Vec::new();
        if let Some(rel) = &options.media_rel {
            let media_kind = options.media_kind.as_deref().unwrap_or("image");
            items.push(json!({
                "id": "i1", "kind": "screen", "src": rel, "media": media_kind, "attach": null,
            }));
        }
        doc["layeredScreenshot"] = json!({
            "layers": [{ "id": "l1", "visible": true, "z": 0, "items": items }],
            "pose": { "spread": 0, "azimuthDeg": 0, "elevationDeg": 0, "zoom": 1, "pan": [0, 0] },
        });
    }
    if options.kind == "chart" {
        // Starter data only: style, axis, labels and animation stay absent so `resolveChart` owns every default, and series carry no colour so the theme palette drives them.
        let data = match &options.chart_data {
            Some(picked) => json!({
                "categories": picked.categories,
                "series": picked
                    .series
                    .iter()
                    .map(|s| json!({
                        "id": s.id,
                        "name": s.name.as_deref().unwrap_or(&s.id),
                        "values": s.values,
                    }))
                    .collect::<Vec<_>>(),
            }),
            None => json!({
                "categories": ["April", "May", "June", "July"],
                "series": [
                    { "id": "s1", "name": "Region 1", "values": [17, 26, 53, 96] },
                    { "id": "s2", "name": "Region 2", "values": [55, 43, 70, 58] },
                ],
            }),
        };
        doc["chart"] = json!({
            "type": options.chart_type.as_deref().unwrap_or("column"),
            "dimension": options.chart_dimension.as_deref().unwrap_or("3d"),
            "mount": "hero",
            "data": data,
        });
        // The chart floats on the scene's own background; staged scenery boxes it in (toggle the backdrop back on in the inspector).
        doc["backdrop"] = json!({ "type": "none" });
    }
    if options.kind == "video" {
        if let Some(rel) = &options.media_rel {
            doc["background"] = json!({ "type": "video", "src": rel });
        }
    }
    // An image scene without a pick keeps the theme background (no bundled sample image).
    if options.kind == "image" {
        if let Some(rel) = &options.media_rel {
            doc["background"] = json!({ "type": "image", "src": rel });
        }
    }
    if is_device_kind {
        let device_only = options.kind == "deviceonly";
        // With no title to clear, the device-only kind sits centred and dominant, grounded when the theme stages a floor; the titled kind drops 0.3 under the headline.
        let position = if device_only {
            json!([0, 0, 0])
        } else {
            json!([0, -0.3, 0])
        };
        let mut placement = json!({
            "position": position,
            "rotationDeg": [0, 0, 0],
            "scale": if device_only { 1.35 } else { 1.0 },
        });
        if device_only {
            placement["ground"] = json!(true);
        }
        let (model, colour) =
            device_model_and_colour(options.device_model.as_deref(), options.colour.as_deref());
        let mut device = json!({
            "id": "d1",
            "model": model,
            "colour": colour,
            "placement": placement,
            "motion": { "preset": options.motion_preset.as_deref().unwrap_or("none") },
        });
        // Both device kinds omit the field so Device auto-resolves: real map shadows over a staged floor, the soft blob when floating. An explicit option still wins.
        if let Some(shadow) = options.shadow.as_deref() {
            device["shadow"] = json!(shadow);
        }
        if let (Some(rel), Some(kind)) = (&options.media_rel, &options.media_kind) {
            device["media"] = json!({ "src": rel, "kind": kind });
        }
        doc["devices"] = json!([device]);
        // Closer poses than the engine default (target origin, distance 5): the titled phone goes to 75% of frame height, and device-only (1.35 scale) stops at 4.5, the closest clip-safe distance (~94%).
        doc["camera"] = json!({
            "keys": [{
                "id": "k1",
                "tMs": 0,
                "pose": {
                    "target": [0, 0.1, 0],
                    "azimuthDeg": 0,
                    "elevationDeg": 0,
                    "distance": if device_only { 4.5 } else { 4.2 },
                },
            }],
            "segments": [],
        });
    }
    if is_comparison {
        // Devices carry no placement: the deviceLayout block owns positions and the template resolves it per aspect.
        let (model, colour) =
            device_model_and_colour(options.device_model.as_deref(), options.colour.as_deref());
        let mut list = Vec::new();
        for (i, (rel, kind)) in comparison_slots.iter().enumerate() {
            let mut device = json!({
                "id": format!("d{}", i + 1),
                "model": model,
                "colour": colour,
                "motion": { "preset": options.motion_preset.as_deref().unwrap_or("none") },
            });
            // Omitted so Device auto-resolves (the device kinds' contract); an explicit option still wins.
            if let Some(shadow) = options.shadow.as_deref() {
                device["shadow"] = json!(shadow);
            }
            if let (Some(rel), Some(kind)) = (rel, kind) {
                device["media"] = json!({ "src": rel, "kind": kind });
            }
            list.push(device);
        }
        doc["devices"] = json!(list);
        doc["deviceLayout"] = json!({ "preset": "toe-in", "gap": 0.35 });
    }
    inherit_applied_background(&mut doc, applied_background.as_ref());

    // TSX from the template; placeholders are dumb string replaces, keep them in sync with .claude/commands/new-scene.md, which interpolates the same files.
    let tsx = template
        .replace("__SCENE_ID__", &scene_id)
        .replace("__STEM__", &stem)
        .replace("__NAME__", &options.name)
        .replace("__DURATION_MS__", &duration_ms.to_string());
    atomic_write_text(&scenes_dir.join(format!("{stem}.tsx")), &tsx)?;

    atomic_write_json(&scene_doc_path(&root, &slug, &doc_file)?, &doc)?;

    // Register in project.json (atomic), at `position` when given (in range), else appended.
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    migrate_manifest_transitions(&mut manifest);
    // Resolve after every async media probe so an Apply-to-all default saved while the wizard was working cannot be overwritten by a stale value.
    let default_transition = project_default_transition(&manifest);
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    let entry = json!({ "file": file, "durationMs": duration_ms });
    let at = match options.position {
        Some(index) if index < scenes.len() => {
            scenes.insert(index, entry);
            index
        }
        _ => {
            scenes.push(entry);
            scenes.len() - 1
        }
    };
    // Preserve the predecessor's existing boundary, including a hard cut, and seed only the genuinely new boundary.
    seed_inserted_scene_transitions(scenes, at, default_transition.as_ref());
    atomic_write_json(&manifest_path, &manifest)?;

    Ok(ScaffoldResult {
        file,
        doc_file,
        scene_id,
        duration_ms,
    })
}

#[cfg(test)]
mod scaffold_default_tests {
    use super::{
        apply_transition_to_manifest, default_scene_duration_ms, device_model_and_colour,
        project_default_transition, seed_inserted_scene_transitions, transition_is_valid,
    };
    use serde_json::{json, Value};

    #[test]
    fn title_kinds_start_at_two_point_six_seconds() {
        assert_eq!(default_scene_duration_ms("title"), 2600);
        assert_eq!(default_scene_duration_ms("titleicon"), 2600);
        assert_eq!(default_scene_duration_ms("overlaypanel"), 4000);
        assert_eq!(default_scene_duration_ms("chart"), 5000);
    }

    #[test]
    fn device_scaffolds_default_to_the_bundled_android() {
        assert_eq!(device_model_and_colour(None, None), ("android", "graphite"));
        assert_eq!(
            device_model_and_colour(Some("iphone-17-pro"), None),
            ("iphone-17-pro", "silver")
        );
        assert_eq!(
            device_model_and_colour(Some("iphone-15-pro"), None),
            ("iphone-15-pro", "natural-titanium")
        );
        assert_eq!(
            device_model_and_colour(Some("android"), Some("white")),
            ("android", "white")
        );
    }

    #[test]
    fn transition_defaults_require_a_string_type() {
        assert!(transition_is_valid(&json!({ "type": "crossfade" })));
        assert!(!transition_is_valid(&json!({ "type": 2 })));
        assert!(!transition_is_valid(&json!(null)));
    }

    #[test]
    fn a_missing_default_keeps_crossfade_while_null_means_cut() {
        assert_eq!(
            project_default_transition(&json!({})),
            Some(json!({ "type": "crossfade", "durationMs": 600 }))
        );
        assert_eq!(
            project_default_transition(&json!({ "defaultTransition": null })),
            None
        );
    }

    #[test]
    fn apply_all_updates_every_boundary_and_the_object_default() {
        let mut manifest = json!({
            "version": 2,
            "scenes": [
                { "file": "scenes/a.tsx", "transition": { "type": "wipe" } },
                { "file": "scenes/b.tsx" },
                { "file": "scenes/c.tsx", "transition": { "type": "unused" } }
            ]
        });
        let spec = json!({ "type": "dip", "durationMs": 400 });
        apply_transition_to_manifest(&mut manifest, Some(&spec)).unwrap();
        assert_eq!(manifest["scenes"][0]["transition"], spec);
        assert_eq!(manifest["scenes"][1]["transition"], spec);
        assert_eq!(
            manifest["scenes"][2]["transition"],
            json!({ "type": "unused" })
        );
        assert_eq!(manifest["defaultTransition"], spec);
    }

    #[test]
    fn apply_all_hard_cut_removes_boundaries_and_saves_null() {
        let mut manifest = json!({
            "version": 2,
            "scenes": [
                { "file": "scenes/a.tsx", "transition": { "type": "wipe" } },
                { "file": "scenes/b.tsx", "transition": { "type": "dip" } },
                { "file": "scenes/c.tsx" }
            ]
        });
        apply_transition_to_manifest(&mut manifest, None).unwrap();
        assert!(manifest["scenes"][0].get("transition").is_none());
        assert!(manifest["scenes"][1].get("transition").is_none());
        assert_eq!(manifest["defaultTransition"], Value::Null);
    }

    #[test]
    fn inserting_between_scenes_preserves_a_local_cut_and_defaults_the_new_boundary() {
        let mut scenes = vec![
            json!({ "file": "scenes/a.tsx" }),
            json!({ "file": "scenes/new.tsx" }),
            json!({ "file": "scenes/b.tsx" }),
        ];
        let spec = json!({ "type": "dip", "durationMs": 400 });
        seed_inserted_scene_transitions(&mut scenes, 1, Some(&spec));
        assert!(scenes[0].get("transition").is_none());
        assert_eq!(scenes[1]["transition"], spec);
    }

    #[test]
    fn appending_seeds_the_previously_terminal_boundary() {
        let mut scenes = vec![
            json!({ "file": "scenes/a.tsx" }),
            json!({ "file": "scenes/new.tsx" }),
        ];
        let spec = json!({ "type": "crossfade", "durationMs": 600 });
        seed_inserted_scene_transitions(&mut scenes, 1, Some(&spec));
        assert_eq!(scenes[0]["transition"], spec);
        assert!(scenes[1].get("transition").is_none());
    }
}

#[cfg(test)]
mod applied_background_tests {
    use super::inherit_applied_background;
    use serde_json::json;

    fn stamp() -> serde_json::Value {
        json!({
            "background": { "type": "color", "color": "#101820" },
            "backdrop": { "type": "floor", "color": "#101820" },
        })
    }

    #[test]
    fn a_background_less_scene_takes_both_blocks() {
        let mut doc = json!({ "version": 1 });
        inherit_applied_background(&mut doc, Some(&stamp()));
        assert_eq!(doc["background"]["color"], json!("#101820"));
        assert_eq!(doc["backdrop"]["type"], json!("floor"));
    }

    #[test]
    fn a_kind_that_staged_its_own_background_keeps_it_and_takes_nothing() {
        let mut doc = json!({ "background": { "type": "video", "src": "assets/a.mp4" } });
        inherit_applied_background(&mut doc, Some(&stamp()));
        assert_eq!(doc["background"]["type"], json!("video"));
        assert!(doc.get("backdrop").is_none());
    }

    #[test]
    fn an_explicit_backdrop_survives_the_stamp() {
        let mut doc = json!({ "backdrop": { "type": "none" } });
        inherit_applied_background(&mut doc, Some(&stamp()));
        assert_eq!(doc["background"]["type"], json!("color"));
        assert_eq!(doc["backdrop"]["type"], json!("none"));
    }

    #[test]
    fn no_stamp_leaves_the_doc_alone() {
        let mut doc = json!({ "version": 1 });
        inherit_applied_background(&mut doc, None);
        assert_eq!(doc, json!({ "version": 1 }));
    }

    #[test]
    fn a_backdrop_only_stamp_writes_only_the_backdrop() {
        let mut doc = json!({ "version": 1 });
        inherit_applied_background(&mut doc, Some(&json!({ "backdrop": { "type": "none" } })));
        assert!(doc.get("background").is_none());
        assert_eq!(doc["backdrop"]["type"], json!("none"));
    }
}

#[cfg(test)]
mod scaffold_managed_text_tests {
    use super::scaffold_managed_text;
    use serde_json::{json, Value};

    fn template(items: Value) -> Value {
        json!({ "layout": "template", "items": items })
    }

    #[test]
    fn every_text_bearing_kind_gets_its_exact_managed_block() {
        let cases = vec![
            (
                "title",
                json!({ "text": { "title": "", "subtitle": "" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "" },
                    { "key": "subtitle", "type": "subtitle", "text": "" },
                ])),
            ),
            (
                "titleicon",
                json!({
                    "text": { "title": "Launch", "subtitle": "Today" },
                    "headerIcon": "🪄",
                }),
                template(json!([
                    { "key": "icon", "type": "icon", "icon": "🪄" },
                    { "key": "title", "type": "title", "text": "Launch" },
                    { "key": "subtitle", "type": "subtitle", "text": "Today" },
                ])),
            ),
            (
                "overlaystart",
                json!({
                    "text": {
                        "title": "Launch",
                        "subtitle": "Today",
                        "bullets": " First point \n\nSecond point  ",
                    },
                }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Launch" },
                    { "key": "subtitle", "type": "subtitle", "text": "Today" },
                    {
                        "key": "bullets",
                        "type": "bullets",
                        "text": " First point \n\nSecond point  ",
                        "points": [
                            { "key": "bullets-point-1", "text": "First point" },
                            { "key": "bullets-point-2", "text": "Second point" },
                        ],
                    },
                ])),
            ),
            (
                "overlayend",
                json!({ "text": { "title": "End", "subtitle": "Right" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "End" },
                    { "key": "subtitle", "type": "subtitle", "text": "Right" },
                ])),
            ),
            (
                "overlaypanel",
                json!({ "text": { "title": "Your title", "subtitle": "" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Your title" },
                    { "key": "subtitle", "type": "subtitle", "text": "" },
                ])),
            ),
            (
                "device",
                json!({ "text": { "title": "Phone", "subtitle": "Silver" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Phone" },
                    { "key": "subtitle", "type": "subtitle", "text": "Silver" },
                ])),
            ),
            (
                "comparison",
                json!({
                    "text": {
                        "title": "Then and now",
                        "subtitle": "",
                        "beforeLabel": "Before",
                        "afterLabel": "After",
                    },
                }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Then and now" },
                    { "key": "subtitle", "type": "subtitle", "text": "" },
                ])),
            ),
            (
                "appversion",
                json!({ "text": { "title": "Kookaburra", "subtitle": "3.1.5" } }),
                template(json!([
                    { "key": "icon", "type": "icon", "icon": "assets/app-icon.png" },
                    { "key": "title", "type": "subtitle", "text": "Kookaburra" },
                    { "key": "subtitle", "type": "title", "text": "3.1.5" },
                ])),
            ),
            (
                "videowindow",
                json!({ "text": { "title": "", "subtitle": "" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "" },
                    { "key": "subtitle", "type": "subtitle", "text": "" },
                ])),
            ),
            (
                "chart",
                json!({ "text": { "title": "Quarterly revenue" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Quarterly revenue" },
                ])),
            ),
            (
                "blank",
                json!({ "text": { "title": "A blank beginning" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "A blank beginning" },
                ])),
            ),
            (
                "layeredscreenshot",
                json!({ "text": { "title": "Three screens" } }),
                template(json!([
                    { "key": "title", "type": "title", "text": "Three screens" },
                ])),
            ),
        ];

        for (kind, doc, expected) in cases {
            assert_eq!(
                scaffold_managed_text(kind, &doc, None),
                Some(expected),
                "{kind}"
            );
        }
    }

    #[test]
    fn every_text_scaffold_captures_a_claimed_frame_icon_in_its_own_slot() {
        let doc = json!({ "text": { "title": "Launch", "subtitle": "Today" } });
        let claimed = json!({
            "cutout": { "shape": "rounded-rect" },
            "icon": "assets/deck-mark.png",
        });
        let expected_with_icon = template(json!([
            { "key": "frameIcon", "type": "icon", "icon": "assets/deck-mark.png" },
            { "key": "title", "type": "title", "text": "Launch" },
            { "key": "subtitle", "type": "subtitle", "text": "Today" },
        ]));
        for kind in [
            "title",
            "overlaystart",
            "overlayend",
            "overlaypanel",
            "device",
            "comparison",
            "videowindow",
        ] {
            assert_eq!(
                scaffold_managed_text(kind, &doc, Some(&claimed)),
                Some(expected_with_icon.clone()),
                "{kind}",
            );
        }

        let title_icon = json!({
            "text": { "title": "Launch", "subtitle": "Today" },
            "headerIcon": "🪄",
        });
        assert_eq!(
            scaffold_managed_text("titleicon", &title_icon, Some(&claimed)),
            Some(template(json!([
                { "key": "frameIcon", "type": "icon", "icon": "assets/deck-mark.png" },
                { "key": "icon", "type": "icon", "icon": "🪄" },
                { "key": "title", "type": "title", "text": "Launch" },
                { "key": "subtitle", "type": "subtitle", "text": "Today" },
            ]))),
        );
        assert_eq!(
            scaffold_managed_text(
                "appversion",
                &json!({ "text": { "title": "Kookaburra", "subtitle": "3.1.5" } }),
                Some(&claimed),
            ),
            Some(template(json!([
                { "key": "frameIcon", "type": "icon", "icon": "assets/deck-mark.png" },
                { "key": "icon", "type": "icon", "icon": "assets/app-icon.png" },
                { "key": "title", "type": "subtitle", "text": "Kookaburra" },
                { "key": "subtitle", "type": "title", "text": "3.1.5" },
            ]))),
        );
        for kind in ["chart", "blank", "layeredscreenshot"] {
            assert_eq!(
                scaffold_managed_text(
                    kind,
                    &json!({ "text": { "title": "Optional title" } }),
                    Some(&claimed),
                ),
                Some(template(json!([
                    { "key": "frameIcon", "type": "icon", "icon": "assets/deck-mark.png" },
                    { "key": "title", "type": "title", "text": "Optional title" },
                ]))),
                "{kind}",
            );
        }
    }

    #[test]
    fn a_scene_frame_preserves_an_explicit_empty_icon_override() {
        let doc = json!({
            "text": { "title": "Launch", "subtitle": "Today" },
            "frame": {
                "cutout": { "shape": "rounded-rect", "side": "start" },
                "icon": "",
            },
        });
        let deck = json!({
            "cutout": { "shape": "rounded-rect", "side": "end" },
            "icon": "assets/deck-mark.png",
        });
        assert_eq!(
            scaffold_managed_text("overlaystart", &doc, Some(&deck)),
            Some(template(json!([
                { "key": "frameIcon", "type": "icon", "icon": "" },
                { "key": "title", "type": "title", "text": "Launch" },
                { "key": "subtitle", "type": "subtitle", "text": "Today" },
            ]))),
        );
    }

    #[test]
    fn scene_frame_flags_override_deck_opt_outs_field_by_field() {
        let title = |frame: Value| {
            json!({
                "text": { "title": "Launch", "subtitle": "Today" },
                "frame": frame,
            })
        };
        let managed = |icon: &str| {
            template(json!([
                { "key": "frameIcon", "type": "icon", "icon": icon },
                { "key": "title", "type": "title", "text": "Launch" },
                { "key": "subtitle", "type": "subtitle", "text": "Today" },
            ]))
        };
        let disabled = json!({
            "cutout": { "shape": "rounded-rect" },
            "enabled": false,
            "icon": "assets/deck.png",
        });
        assert_eq!(
            scaffold_managed_text(
                "title",
                &title(json!({ "enabled": true, "icon": "assets/scene.png" })),
                Some(&disabled),
            ),
            Some(managed("assets/scene.png")),
        );
        assert_eq!(
            scaffold_managed_text(
                "title",
                &title(json!({ "icon": "assets/scene.png" })),
                Some(&disabled),
            ),
            Some(template(json!([
                { "key": "title", "type": "title", "text": "Launch" },
                { "key": "subtitle", "type": "subtitle", "text": "Today" },
            ]))),
        );

        let unclaimed = json!({
            "cutout": { "shape": "rounded-rect" },
            "claimsSceneText": false,
            "icon": "assets/deck.png",
        });
        assert_eq!(
            scaffold_managed_text(
                "title",
                &title(json!({
                    "claimsSceneText": true,
                    "icon": "assets/scene.png",
                })),
                Some(&unclaimed),
            ),
            Some(managed("assets/scene.png")),
        );

        let deck = json!({
            "cutout": { "shape": "rounded-rect" },
            "icon": "assets/deck.png",
        });
        assert_eq!(
            scaffold_managed_text(
                "title",
                &title(json!({ "icon": "assets/scene.png" })),
                Some(&deck),
            ),
            Some(managed("assets/scene.png")),
        );
    }

    #[test]
    fn unclaimed_or_disabled_frames_add_no_frame_icon_item() {
        let doc = json!({ "text": { "title": "Launch", "subtitle": "Today" } });

        let expected_embedded_icon = template(json!([
            { "key": "title", "type": "title", "text": "Launch" },
            { "key": "subtitle", "type": "subtitle", "text": "Today" },
        ]));
        for frame in [
            json!({
                "cutout": { "shape": "rounded-rect" },
                "icon": "assets/deck-mark.png",
                "claimsSceneText": false,
            }),
            json!({
                "cutout": { "shape": "rounded-rect" },
                "icon": "assets/deck-mark.png",
                "enabled": false,
            }),
            json!({
                "cutout": { "shape": "unknown" },
                "icon": "assets/deck-mark.png",
            }),
        ] {
            assert_eq!(
                scaffold_managed_text("overlaystart", &doc, Some(&frame)),
                Some(expected_embedded_icon.clone())
            );
        }
    }

    #[test]
    fn textless_kinds_stay_unmanaged_and_optional_title_kinds_own_their_slot() {
        for kind in ["deviceonly", "video", "image"] {
            assert_eq!(
                scaffold_managed_text(kind, &json!({}), None),
                None,
                "{kind}"
            );
        }
        for kind in ["chart", "blank", "layeredscreenshot"] {
            assert_eq!(
                scaffold_managed_text(kind, &json!({ "text": { "title": "  " } }), None,),
                Some(template(json!([
                    { "key": "title", "type": "title", "text": "  " },
                ]))),
                "{kind}",
            );
        }
    }
}

#[cfg(test)]
mod asset_scan_tests {
    use super::{collect_json_asset_refs, copy_scene_assets, scan_asset_refs};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "kookaburra-scene-assets-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn keeps_valid_tsx_scanning_unchanged() {
        let tsx = r#"const clip = "assets/feature.mp4"; useTexture(`assets/logo dark.png`)"#;
        assert_eq!(
            scan_asset_refs(tsx),
            vec!["assets/feature.mp4", "assets/logo dark.png"]
        );
    }

    #[test]
    fn skips_traversal_dedupes_and_longer_segments() {
        let text = r#""assets/a.png" and again "assets/a.png"; "my-assets/no.png"; "assets/../x""#;
        assert_eq!(scan_asset_refs(text), vec!["assets/a.png"]);
    }

    #[test]
    fn sidecar_walk_keeps_exact_first_class_image_paths() {
        let doc = json!({
            "images": [
                { "id": "img1", "src": "assets/Kākāpō @2 (final).png" },
                { "id": "img2", "src": "assets/Kākāpō @2 (final).png" },
                { "id": "img3", "src": "assets/nested/画面 @home.webp" },
            ],
            "unsafe": [
                "assets/../outside.png",
                "assets/./same.png",
                "assets//empty.png",
                "prefix assets/not-a-path.png",
            ],
        });
        assert_eq!(
            collect_json_asset_refs(&doc),
            vec![
                "assets/Kākāpō @2 (final).png",
                "assets/nested/画面 @home.webp"
            ]
        );
    }

    #[test]
    fn sidecar_walk_includes_managed_project_image_icons() {
        let doc = json!({
            "managedText": {
                "items": [
                    { "key": "emoji", "type": "icon", "icon": "🪄" },
                    { "key": "mark", "type": "icon", "icon": "assets/managed-mark.png" },
                ],
            },
        });

        assert_eq!(
            collect_json_asset_refs(&doc),
            vec!["assets/managed-mark.png"]
        );
    }

    #[test]
    fn a_sidecar_image_collision_copies_and_rewrites_the_exact_path() {
        let root = temp_dir("collision");
        let project = root.join("source");
        let dest = root.join("destination");
        std::fs::create_dir_all(project.join("assets")).unwrap();
        std::fs::create_dir_all(dest.join("assets")).unwrap();
        let name = "Kākāpō @2 (final).png";
        std::fs::write(project.join("assets").join(name), b"source bytes").unwrap();
        std::fs::write(dest.join("assets").join(name), b"destination bytes").unwrap();
        let mut tsx = "export default defineScene({ id: 'image' })".to_string();
        let mut doc = Some(json!({
            "version": 1,
            "images": [{ "id": "img1", "src": format!("assets/{name}") }],
            "note": format!("Preview assets/{name} here"),
        }));

        copy_scene_assets(&project, &dest, &mut tsx, &mut doc).unwrap();

        let rewritten = "assets/Kākāpō @2 (final)-2.png";
        assert_eq!(doc.as_ref().unwrap()["images"][0]["src"], json!(rewritten));
        assert_eq!(
            doc.as_ref().unwrap()["note"],
            json!(format!("Preview assets/{name} here"))
        );
        assert_eq!(
            std::fs::read(dest.join("assets/Kākāpō @2 (final)-2.png")).unwrap(),
            b"source bytes"
        );
        assert_eq!(
            std::fs::read(dest.join("assets").join(name)).unwrap(),
            b"destination bytes"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_collision_does_not_rewrite_an_embedded_tsx_substring() {
        let root = temp_dir("tsx-boundary");
        let project = root.join("source");
        let dest = root.join("destination");
        std::fs::create_dir_all(project.join("assets")).unwrap();
        std::fs::create_dir_all(dest.join("assets")).unwrap();
        std::fs::write(project.join("assets/foo.png"), b"source bytes").unwrap();
        std::fs::write(dest.join("assets/foo.png"), b"destination bytes").unwrap();
        let mut tsx =
            r#"const image = "assets/foo.png"; const unrelated = "my-assets/foo.png";"#.to_string();
        let mut doc = None;

        copy_scene_assets(&project, &dest, &mut tsx, &mut doc).unwrap();

        assert_eq!(
            tsx,
            r#"const image = "assets/foo-2.png"; const unrelated = "my-assets/foo.png";"#
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod remint_tests {
    use super::remint_scene_doc_ids;
    use serde_json::{json, Value};

    /// One scene carrying every id-bearing block, ids deliberately out of order and gappy so a renumber is visible.
    fn scene() -> Value {
        json!({
            "version": 1,
            "name": "Spike",
            "duration": { "mode": "follow-media", "sourceDeviceId": "d7" },
            "text": { "title": "Hi", "ls-i9": "Label", "ls-i4": "Other" },
            "textStyle": { "titleSize": 1.2, "ls-i9Color": "#ffffff", "ls-i4OffsetY": 0.1 },
            "managedText": {
                "items": [
                    { "key": "mark", "type": "icon", "icon": "assets/managed-mark.png" },
                ],
            },
            "devices": [
                { "id": "d7", "model": "iphone-17-pro", "media": { "src": "assets/a.mp4", "kind": "video" } },
                { "id": "d3", "model": "iphone-17-pro" },
            ],
            "images": [
                { "id": "hero-7", "src": "assets/hero.png", "host": "stage" },
                { "id": "logo-2", "src": "assets/logo-mark.webp", "host": "overlay" },
            ],
            "deviceLayout": {
                "preset": "row",
                "devices": { "d3": { "scale": 1.2 }, "d7": { "scale": 0.9 } },
            },
            "objects": [
                { "id": "o5", "objectId": "lantern" },
                { "id": "o2", "objectId": "plant" },
            ],
            "camera": {
                "keys": [{ "id": "k4", "tMs": 0 }, { "id": "k9", "tMs": 800 }],
                "segments": [{ "from": "k4", "to": "k9", "ease": "linear" }],
            },
            "cameraMode": "rig",
            "cameraRig": {
                "keys": [
                    { "id": "r2", "tMs": 0, "pose": { "aim": { "mode": "object", "id": "d3", "at": [0, 0, 0] } } },
                    { "id": "r5", "tMs": 500, "pose": { "aim": { "mode": "object", "id": "o5", "at": [0, 0, 0] } } },
                    { "id": "r8", "tMs": 900, "pose": { "aim": { "mode": "object", "id": "videoWindow", "at": [0, 0, 0] } } },
                ],
                "segments": [
                    { "from": "r2", "to": "r5", "ease": "linear" },
                    { "from": "r5", "to": "r8", "ease": "linear" },
                ],
            },
            "frame": {
                "decorations": [
                    { "id": "logo", "src": "assets/logo.png", "position": [0, 0], "size": 0.1 },
                    { "id": "text-2", "text": "Beta", "position": [0.2, 0], "size": 0.05 },
                ],
            },
            "layeredScreenshot": {
                "layers": [
                    { "id": "l4", "visible": true, "z": 0, "items": [
                        { "id": "i9", "kind": "text", "attach": null },
                        { "id": "i4", "kind": "screen", "src": "assets/screen.png", "media": "image", "attach": { "to": "i9", "side": "right" } },
                    ] },
                    { "id": "l2", "visible": true, "z": 1, "items": [
                        { "id": "i7", "kind": "screen", "src": "assets/screen.png", "media": "image", "attach": null },
                    ] },
                ],
                "pose": { "spread": 0, "azimuthDeg": 0, "elevationDeg": 0, "zoom": 1, "pan": [0, 0] },
                "animation": {
                    "keys": [{ "id": "a1", "tMs": 0 }, { "id": "a2", "tMs": 600 }],
                    "segments": [{ "from": "a1", "to": "a2", "ease": "linear" }],
                },
            },
            "compare": {
                "b": {
                    "media": { "d3": { "src": "assets/b.png", "kind": "image" } },
                    "deviceAppearance": {
                        "d7": { "colour": "silver", "shadow": "long" },
                        "d3": { "colour": "graphite", "shadow": "soft" },
                        "missing": { "colour": "white" },
                    },
                },
                "track": {
                    "keys": [
                        { "id": "c1", "tMs": 0, "pose": { "value": 0 } },
                        { "id": "c2", "tMs": 900, "pose": { "value": 1 } },
                    ],
                    "segments": [{ "from": "c1", "to": "c2", "ease": "linear" }],
                },
            },
            "chart": {
                "type": "column",
                "palette": "ocean",
                "data": {
                    "categories": ["A"],
                    "series": [{ "id": "s4", "values": [1] }, { "id": "s2", "values": [2] }],
                },
                "track": {
                    "keys": [{ "id": "t1", "tMs": 0, "pose": { "values": [[1], [2]] } }],
                    "segments": [],
                },
            },
            "lighting": {
                "lights": [{ "id": "rim-left", "intensity": 2, "placement": {} }],
                "fixtures": [{ "id": "tubes", "form": "tube", "size": [1, 0.1], "emissive": 2, "lightIntensity": 1, "placement": {} }],
                "keys": [
                    { "id": "lk1", "tMs": 0, "pose": { "lights": { "rim-left": { "intensity": 1 } }, "fixtures": { "tubes": { "emissive": 1 } } } },
                    { "id": "lk2", "tMs": 700, "pose": { "lights": { "rim-left": { "intensity": 3 } } } },
                ],
                "segments": [{ "from": "lk1", "to": "lk2", "ease": "linear" }],
            },
        })
    }

    fn minted(doc: &Value) -> Value {
        let mut doc = doc.clone();
        remint_scene_doc_ids(&mut doc);
        doc
    }

    /// The `id` of every entry in an array, in document order.
    fn ids(array: &Value) -> Vec<String> {
        array
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect()
    }

    /// Every `assets/…` string anywhere in the document, sorted.
    fn asset_paths(value: &Value) -> Vec<String> {
        let mut found = Vec::new();
        fn walk(value: &Value, found: &mut Vec<String>) {
            match value {
                Value::String(s) if s.starts_with("assets/") => found.push(s.clone()),
                Value::Array(list) => list.iter().for_each(|v| walk(v, found)),
                Value::Object(map) => map.values().for_each(|v| walk(v, found)),
                _ => {}
            }
        }
        walk(value, &mut found);
        found.sort();
        found
    }

    #[test]
    fn every_namespace_renumbers_from_one_in_document_order() {
        let doc = minted(&scene());
        assert_eq!(ids(&doc["devices"]), ["d1", "d2"]);
        assert_eq!(ids(&doc["images"]), ["img1", "img2"]);
        assert_eq!(ids(&doc["objects"]), ["o1", "o2"]);
        assert_eq!(ids(&doc["camera"]["keys"]), ["k1", "k2"]);
        assert_eq!(ids(&doc["cameraRig"]["keys"]), ["k1", "k2", "k3"]);
        assert_eq!(ids(&doc["chart"]["data"]["series"]), ["s1", "s2"]);
        assert_eq!(ids(&doc["chart"]["track"]["keys"]), ["k1"]);
        assert_eq!(ids(&doc["compare"]["track"]["keys"]), ["k1", "k2"]);
        assert_eq!(ids(&doc["frame"]["decorations"]), ["dec1", "dec2"]);
        assert_eq!(ids(&doc["layeredScreenshot"]["layers"]), ["l1", "l2"]);
        assert_eq!(
            ids(&doc["layeredScreenshot"]["animation"]["keys"]),
            ["k1", "k2"]
        );
        assert_eq!(ids(&doc["lighting"]["keys"]), ["k1", "k2"]);
        // Items number across every layer, since one scene shares the item space.
        assert_eq!(
            ids(&doc["layeredScreenshot"]["layers"][0]["items"]),
            ["i1", "i2"]
        );
        assert_eq!(ids(&doc["layeredScreenshot"]["layers"][1]["items"]), ["i3"]);
    }

    #[test]
    fn cross_references_follow_their_targets() {
        let doc = minted(&scene());
        assert_eq!(doc["duration"]["sourceDeviceId"], json!("d1"));
        assert_eq!(doc["deviceLayout"]["devices"]["d1"]["scale"], json!(0.9));
        assert_eq!(doc["deviceLayout"]["devices"]["d2"]["scale"], json!(1.2));
        assert_eq!(
            doc["compare"]["b"]["media"]["d2"]["src"],
            json!("assets/b.png")
        );
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"]["d1"]["colour"],
            json!("silver")
        );
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"]["d2"]["shadow"],
            json!("soft")
        );
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"]["missing"]["colour"],
            json!("white")
        );
        assert_eq!(
            doc["cameraRig"]["keys"][0]["pose"]["aim"]["id"],
            json!("d2")
        );
        assert_eq!(
            doc["layeredScreenshot"]["layers"][0]["items"][1]["attach"]["to"],
            json!("i1")
        );
        assert_eq!(doc["text"]["ls-i1"], json!("Label"));
        assert_eq!(doc["text"]["ls-i2"], json!("Other"));
        assert_eq!(doc["textStyle"]["ls-i1Color"], json!("#ffffff"));
        assert_eq!(doc["textStyle"]["ls-i2OffsetY"], json!(0.1));
        assert_eq!(doc["textStyle"]["titleSize"], json!(1.2));
        for (track, count) in [
            (&doc["camera"], 1),
            (&doc["cameraRig"], 2),
            (&doc["compare"]["track"], 1),
            (&doc["layeredScreenshot"]["animation"], 1),
            (&doc["lighting"], 1),
        ] {
            let segments = track["segments"].as_array().unwrap();
            assert_eq!(segments.len(), count);
            let keys = ids(&track["keys"]);
            for segment in segments {
                assert!(keys.iter().any(|k| k == segment["from"].as_str().unwrap()));
                assert!(keys.iter().any(|k| k == segment["to"].as_str().unwrap()));
            }
        }
        assert_eq!(doc["cameraRig"]["segments"][0]["from"], json!("k1"));
        assert_eq!(doc["cameraRig"]["segments"][1]["to"], json!("k3"));
    }

    #[test]
    fn asset_paths_and_library_ids_never_move() {
        let source = scene();
        let doc = minted(&source);
        assert_eq!(asset_paths(&doc), asset_paths(&source));
        assert_eq!(doc["images"][0]["src"], json!("assets/hero.png"));
        assert_eq!(doc["images"][1]["src"], json!("assets/logo-mark.webp"));
        assert_eq!(
            doc["managedText"]["items"][0]["icon"],
            json!("assets/managed-mark.png")
        );
        assert_eq!(doc["objects"][0]["objectId"], json!("lantern"));
        assert_eq!(doc["objects"][1]["objectId"], json!("plant"));
        assert_eq!(doc["chart"]["palette"], json!("ocean"));
        // Only devices are bindable, so the sentinel and the unresolvable object id both stay verbatim.
        assert_eq!(
            doc["cameraRig"]["keys"][1]["pose"]["aim"]["id"],
            json!("o5")
        );
        assert_eq!(
            doc["cameraRig"]["keys"][2]["pose"]["aim"]["id"],
            json!("videoWindow")
        );
    }

    #[test]
    fn lighting_light_and_fixture_ids_stay_put() {
        let doc = minted(&scene());
        assert_eq!(doc["lighting"]["lights"][0]["id"], json!("rim-left"));
        assert_eq!(doc["lighting"]["fixtures"][0]["id"], json!("tubes"));
        assert_eq!(
            doc["lighting"]["keys"][0]["pose"]["lights"]["rim-left"]["intensity"],
            json!(1)
        );
        assert_eq!(
            doc["lighting"]["keys"][0]["pose"]["fixtures"]["tubes"]["emissive"],
            json!(1)
        );
    }

    #[test]
    fn a_swapped_pair_keeps_each_record_with_its_own_device() {
        let mut doc = json!({
            "version": 1,
            "devices": [{ "id": "d2", "model": "a" }, { "id": "d1", "model": "b" }],
            "deviceLayout": { "preset": "row", "devices": { "d1": { "scale": 1.0 }, "d2": { "scale": 2.0 } } },
            "compare": { "b": { "deviceAppearance": { "d1": { "colour": "silver" }, "d2": { "colour": "black" } } } },
        });
        remint_scene_doc_ids(&mut doc);
        assert_eq!(ids(&doc["devices"]), ["d1", "d2"]);
        assert_eq!(doc["devices"][0]["model"], json!("a"));
        assert_eq!(doc["deviceLayout"]["devices"]["d1"]["scale"], json!(2.0));
        assert_eq!(doc["deviceLayout"]["devices"]["d2"]["scale"], json!(1.0));
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"]["d1"]["colour"],
            json!("black")
        );
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"]["d2"]["colour"],
            json!("silver")
        );
    }

    #[test]
    fn malformed_comparison_device_appearance_is_left_untouched() {
        let source = json!({
            "version": 1,
            "devices": [{ "id": "d7", "model": "a" }],
            "compare": { "b": { "deviceAppearance": ["d7", null] } },
        });
        let doc = minted(&source);
        assert_eq!(doc["devices"][0]["id"], json!("d1"));
        assert_eq!(
            doc["compare"]["b"]["deviceAppearance"],
            source["compare"]["b"]["deviceAppearance"]
        );
    }

    #[test]
    fn a_second_pass_changes_nothing() {
        let once = minted(&scene());
        assert_eq!(minted(&once), once);
    }

    #[test]
    fn a_document_with_no_ids_is_untouched() {
        let source = json!({
            "version": 1,
            "name": "Title",
            "text": { "title": "Hi" },
            "background": { "type": "video", "src": "assets/loop.mp4" },
        });
        assert_eq!(minted(&source), source);
    }
}

#[cfg(test)]
mod scene_id_tests {
    use super::{find_define_scene_id, free_scene_id, rewrite_define_scene_id};
    use std::collections::HashSet;

    fn id_of(src: &str) -> Option<String> {
        find_define_scene_id(src).map(|(start, end)| src[start..end].to_string())
    }

    #[test]
    fn reads_every_quote_style() {
        assert_eq!(
            id_of(r#"defineScene({ id: "hero", durationMs: 4000 })"#).as_deref(),
            Some("hero")
        );
        assert_eq!(
            id_of("defineScene({ id: 'hero', durationMs: 4000 })").as_deref(),
            Some("hero")
        );
        assert_eq!(
            id_of("defineScene({ id: `hero`, durationMs: 4000 })").as_deref(),
            Some("hero")
        );
        assert_eq!(
            id_of(r#"defineScene({id:"hero"})"#).as_deref(),
            Some("hero")
        );
    }

    #[test]
    fn only_the_call_s_own_key_position_matches() {
        let src = r#"
const devices = [{ id: "d1" }];
export default defineScene({
  id: "panel-6",
  Scene() {
    return <>{devices.map((d) => <Device key={d.id} id={d.id} />)}</>;
  },
});
"#;
        assert_eq!(id_of(src).as_deref(), Some("panel-6"));
    }

    #[test]
    fn a_member_expression_id_is_never_a_key() {
        let src =
            r#"defineScene({ durationMs: 4000, Scene() { return <A key={d.id} x={d.id} />; } })"#;
        assert_eq!(id_of(src), None);
    }

    #[test]
    fn a_doc_comment_mention_skips_to_the_real_call() {
        let src = r#"
/** Every scene is one defineScene call, see the authoring skill. */
export default defineScene({ id: "hero" });
"#;
        assert_eq!(id_of(src).as_deref(), Some("hero"));
    }

    #[test]
    fn an_import_line_alone_has_no_id() {
        let src = "import { defineScene } from \"@kookaburra/toolkit\";\n";
        assert_eq!(id_of(src), None);
    }

    #[test]
    fn a_const_id_is_not_a_literal() {
        assert_eq!(id_of("defineScene({ id: SCENE_ID, durationMs: 10 })"), None);
    }

    #[test]
    fn an_interpolated_template_is_refused() {
        assert_eq!(id_of("defineScene({ id: `hero-${n}` })"), None);
    }

    #[test]
    fn the_splice_keeps_every_other_byte() {
        let src = "import { defineScene } from \"@kookaburra/toolkit\";\n\nexport default defineScene({\n  id: \"old-id\",\n  durationMs: 4000,\n});\n";
        assert_eq!(
            rewrite_define_scene_id(src, "new-id-2").as_deref(),
            Some("import { defineScene } from \"@kookaburra/toolkit\";\n\nexport default defineScene({\n  id: \"new-id-2\",\n  durationMs: 4000,\n});\n")
        );
    }

    #[test]
    fn rewriting_to_the_same_id_still_returns_some() {
        let src = r#"defineScene({ id: "hero" })"#;
        assert_eq!(rewrite_define_scene_id(src, "hero").as_deref(), Some(src));
    }

    #[test]
    fn free_ids_count_up_from_the_base() {
        let mut taken = HashSet::new();
        assert_eq!(free_scene_id("panel", &taken), "panel");
        taken.insert("panel".to_string());
        assert_eq!(free_scene_id("panel", &taken), "panel-2");
        taken.insert("panel-2".to_string());
        assert_eq!(free_scene_id("panel", &taken), "panel-3");
    }
}

#[cfg(test)]
mod scene_id_heal_tests {
    use super::{find_define_scene_id, heal_scene_ids, SceneIdHeal, MANIFEST_FILENAME};
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    // A unique scratch dir under the OS temp root (avoids a tempfile dev-dependency).
    fn scratch_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-scene-id-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        dir
    }

    fn scene_tsx(id: &str) -> String {
        format!(
            "import {{ defineScene, SceneStage }} from \"@kookaburra/toolkit\";\n\nexport default defineScene({{\n  id: \"{id}\",\n  durationMs: 4000,\n  Scene() {{\n    return <SceneStage />;\n  }},\n}});\n"
        )
    }

    fn write_scene(project: &Path, stem: &str, id: &str) {
        std::fs::write(
            project.join("scenes").join(format!("{stem}.tsx")),
            scene_tsx(id),
        )
        .unwrap();
        std::fs::write(
            project.join("scenes").join(format!("{stem}.json")),
            format!("{{\n  \"version\": 1,\n  \"name\": \"{stem}\"\n}}\n"),
        )
        .unwrap();
    }

    fn write_manifest(project: &Path, stems: &[&str]) {
        let scenes: Vec<Value> = stems
            .iter()
            .map(|stem| json!({ "file": format!("scenes/{stem}.tsx"), "durationMs": 4000 }))
            .collect();
        let manifest = json!({ "version": 2, "name": "Spike", "scenes": scenes });
        std::fs::write(
            project.join(MANIFEST_FILENAME),
            serde_json::to_string_pretty(&manifest).unwrap() + "\n",
        )
        .unwrap();
    }

    fn id_on_disk(project: &Path, stem: &str) -> Option<String> {
        let text =
            std::fs::read_to_string(project.join("scenes").join(format!("{stem}.tsx"))).ok()?;
        find_define_scene_id(&text).map(|(start, end)| text[start..end].to_string())
    }

    fn renames(heal: &SceneIdHeal) -> Vec<(String, String, String)> {
        heal.renamed
            .iter()
            .map(|r| (r.file.clone(), r.from.clone(), r.to.clone()))
            .collect()
    }

    fn stamps(project: &Path, stems: &[&str]) -> Vec<(std::time::SystemTime, u64)> {
        stems
            .iter()
            .map(|stem| {
                let meta =
                    std::fs::metadata(project.join("scenes").join(format!("{stem}.tsx"))).unwrap();
                (meta.modified().unwrap(), meta.len())
            })
            .collect()
    }

    // The duplicate spike: two title scenes and four panel scenes minted from the same two ids, registered out of lexical order.
    const SPIKE_ORDER: [&str; 6] = [
        "08-panel-6",
        "04-title-2",
        "09-panel-6-copy",
        "11-panel-6-copy-3",
        "07-title-2-copy",
        "10-panel-6-copy-2",
    ];

    fn write_spike(project: &Path, creation_order: &[&str]) {
        for stem in creation_order {
            let id = if stem.contains("title") {
                "starter-title-2"
            } else {
                "panel-6"
            };
            write_scene(project, stem, id);
        }
        write_manifest(project, &SPIKE_ORDER);
    }

    #[test]
    fn the_duplicate_spike_heals_first_wins() {
        let project = scratch_dir();
        write_spike(&project, &SPIKE_ORDER);

        let heal = heal_scene_ids(&project);
        assert!(heal.unparsed.is_empty());
        assert_eq!(
            renames(&heal),
            vec![
                (
                    "scenes/09-panel-6-copy.tsx".into(),
                    "panel-6".into(),
                    "panel-6-copy".into()
                ),
                (
                    "scenes/11-panel-6-copy-3.tsx".into(),
                    "panel-6".into(),
                    "panel-6-copy-3".into()
                ),
                (
                    "scenes/07-title-2-copy.tsx".into(),
                    "starter-title-2".into(),
                    "title-2-copy".into()
                ),
                (
                    "scenes/10-panel-6-copy-2.tsx".into(),
                    "panel-6".into(),
                    "panel-6-copy-2".into()
                ),
            ]
        );
        assert_eq!(
            id_on_disk(&project, "08-panel-6").as_deref(),
            Some("panel-6")
        );
        assert_eq!(
            id_on_disk(&project, "04-title-2").as_deref(),
            Some("starter-title-2")
        );
        assert_eq!(
            id_on_disk(&project, "09-panel-6-copy").as_deref(),
            Some("panel-6-copy")
        );
        assert_eq!(
            id_on_disk(&project, "07-title-2-copy").as_deref(),
            Some("title-2-copy")
        );

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn the_heal_is_machine_independent() {
        let a = scratch_dir();
        write_spike(&a, &SPIKE_ORDER);
        let b = scratch_dir();
        let mut reversed = SPIKE_ORDER;
        reversed.reverse();
        write_spike(&b, &reversed);

        assert_eq!(renames(&heal_scene_ids(&a)), renames(&heal_scene_ids(&b)));

        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_second_pass_rewrites_nothing() {
        let project = scratch_dir();
        write_spike(&project, &SPIKE_ORDER);
        assert_eq!(heal_scene_ids(&project).renamed.len(), 4);

        let before = stamps(&project, &SPIKE_ORDER);
        let heal = heal_scene_ids(&project);
        assert!(heal.renamed.is_empty());
        assert_eq!(stamps(&project, &SPIKE_ORDER), before);

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_duplicate_free_project_is_never_written() {
        let project = scratch_dir();
        write_scene(&project, "01-hero", "hero");
        write_scene(&project, "02-panel", "panel");
        write_manifest(&project, &["01-hero", "02-panel"]);

        let before = stamps(&project, &["01-hero", "02-panel"]);
        let heal = heal_scene_ids(&project);
        assert!(heal.renamed.is_empty() && heal.unparsed.is_empty());
        assert_eq!(stamps(&project, &["01-hero", "02-panel"]), before);

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn an_unparseable_scene_is_reported_not_rewritten() {
        let project = scratch_dir();
        write_scene(&project, "01-hero", "hero");
        write_scene(&project, "02-hero-copy", "hero");
        let odd = "export default defineScene({ id: SCENE_ID, durationMs: 4000 });\n";
        std::fs::write(project.join("scenes").join("03-odd.tsx"), odd).unwrap();
        write_manifest(&project, &["01-hero", "02-hero-copy", "03-odd"]);

        let heal = heal_scene_ids(&project);
        assert_eq!(heal.unparsed, vec!["scenes/03-odd.tsx".to_string()]);
        assert_eq!(heal.renamed.len(), 1);
        assert_eq!(
            id_on_disk(&project, "02-hero-copy").as_deref(),
            Some("hero-copy")
        );
        assert_eq!(
            std::fs::read_to_string(project.join("scenes").join("03-odd.tsx")).unwrap(),
            odd
        );

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_stray_scene_never_steals_a_registered_id() {
        let project = scratch_dir();
        write_scene(&project, "01-hero", "hero");
        write_scene(&project, "99-stray", "hero");
        write_manifest(&project, &["01-hero"]);

        let heal = heal_scene_ids(&project);
        assert_eq!(
            renames(&heal),
            vec![("scenes/99-stray.tsx".into(), "hero".into(), "stray".into())]
        );
        assert_eq!(id_on_disk(&project, "01-hero").as_deref(), Some("hero"));

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn only_scene_tsx_bytes_ever_move() {
        let project = scratch_dir();
        write_spike(&project, &SPIKE_ORDER);
        let manifest = std::fs::read(project.join(MANIFEST_FILENAME)).unwrap();
        let sidecar = std::fs::read(project.join("scenes").join("09-panel-6-copy.json")).unwrap();

        assert_eq!(heal_scene_ids(&project).renamed.len(), 4);
        assert_eq!(
            std::fs::read(project.join(MANIFEST_FILENAME)).unwrap(),
            manifest
        );
        assert_eq!(
            std::fs::read(project.join("scenes").join("09-panel-6-copy.json")).unwrap(),
            sidecar
        );

        let _ = std::fs::remove_dir_all(&project);
    }
}
