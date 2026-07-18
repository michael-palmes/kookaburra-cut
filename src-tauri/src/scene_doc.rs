//! Per-scene sidecar documents and the native scene scaffolder; a scene document is scenes/<stem>.json beside its TSX (the composition), holding the machine-editable half of a scene (name, text map, devices, camera track, duration mode) owned jointly by the app UI and Claude, with both writers sharing one atomic tmp+rename path and version guard so the frontend never touches files directly (see docs/decisions.md, "Project format & authoring").

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

/// Set or remove one scene's incoming `transition` in `project.json` (atomic), the transition picker's write surface; `None` removes the key (a hard cut, which also restores the overlap to the timeline), index 0 is rejected since the first scene has no incoming transition, and the spec is schema-light on shape (the `set_project_theme` precedent: the loader normalises and degrades unknown types) but must be an object carrying a string `type` so a garbage write can't land.
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
    if index == 0 {
        return Err("the first scene has no incoming transition".into());
    }
    if let Some(spec) = &transition {
        let ok = spec
            .as_object()
            .and_then(|o| o.get("type"))
            .map(Value::is_string)
            .unwrap_or(false);
        if !ok {
            return Err("transition must be an object with a string `type`".into());
        }
    }
    let path = root.join(&slug).join(MANIFEST_FILENAME);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
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

/// Move a scene within the project; each scene's incoming `transition` travels with it, predictable and reversible by moving back.
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

/// Duplicate a scene: the TSX + sidecar copy verbatim to a freshly numbered stem (scene ids may collide by design, files are the identity), the manifest entry lands at `position` (omitted/out-of-range = append) with `durationMs` and `transition` riding along; files write before the manifest so a failed manifest write can never point at missing files.
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
    let text =
        std::fs::read_to_string(&manifest_path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
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
    let tsx = std::fs::read_to_string(project.join(&file)).map_err(|e| format!("reading {file}: {e}"))?;
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
    let base_name = source_name
        .clone()
        .unwrap_or_else(|| stem_src.split_once('-').map_or(stem_src, |(_, rest)| rest).replace('-', " "));
    let base = slugify(&format!("{base_name} copy"));
    let stem = format!("{:02}-{base}", next_prefix(&scenes_dir));
    let new_file = format!("scenes/{stem}.tsx");
    let new_doc_file = format!("scenes/{stem}.json");

    let tsx_path = scenes_dir.join(format!("{stem}.tsx"));
    let tmp = tsx_path.with_extension("tsx.tmp");
    std::fs::write(&tmp, tsx).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &tsx_path).map_err(|e| e.to_string())?;

    if let Some(mut doc) = doc {
        if let Some(name) = &source_name {
            doc["name"] = json!(format!("{name} copy"));
        }
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
    // The first scene has no incoming transition; anywhere else the source's rides along (the move_project_scene convention).
    if !matches!(position, Some(0)) {
        if let Some(transition) = source.get("transition") {
            entry["transition"] = transition.clone();
        }
    }
    match position {
        Some(i) if i < scenes.len() => scenes.insert(i, entry),
        _ => scenes.push(entry),
    }
    atomic_write_json(&manifest_path, &manifest)?;

    Ok(ScaffoldResult {
        file: new_file,
        doc_file: new_doc_file,
        scene_id: base,
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

// ── Scaffolder ────────────────────────────────────────────────────────────────

// Scene TSX templates (compile-time baked, packaged-build safe); the same files are the single source for the `/new-scene` command, which reads them from the repo tree.
const TSX_DEVICE: &str = include_str!("../templates/scenes/device.tsx.tmpl");
const TSX_TITLE: &str = include_str!("../templates/scenes/title.tsx.tmpl");
const TSX_BLANK: &str = include_str!("../templates/scenes/blank.tsx.tmpl");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldOptions {
    /// "device" | "title" | "blank".
    pub kind: String,
    /// Human scene name, e.g. "Hero demo" (sidecar `name`; slugified for the file stem).
    pub name: String,
    pub title: Option<String>,
    /// Title scenes only; other kinds ignore it.
    pub subtitle: Option<String>,
    pub device_model: Option<String>,
    pub colour: Option<String>,
    /// Project-relative media path (e.g. "assets/demo.mp4").
    pub media_rel: Option<String>,
    /// "video" | "image".
    pub media_kind: Option<String>,
    pub motion_preset: Option<String>,
    pub shadow: Option<String>,
    /// Insertion index in `project.json`'s scenes array (0 = start; omitted/out-of-range = append).
    pub position: Option<usize>,
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
    if trimmed.is_empty() { "scene".into() } else { trimmed }
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

/// Scaffold a scene natively: TSX from the bundled template + sidecar doc + project.json registration, all writes atomic; video media sets the duration to the media's length (duration-follow), everything else gets the 4000ms wizard default.
#[tauri::command]
pub async fn scaffold_scene(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    options: ScaffoldOptions,
) -> Result<ScaffoldResult, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let project = root.join(&slug);
    if !project.join(MANIFEST_FILENAME).is_file() {
        return Err(format!("project \"{slug}\" has no project.json"));
    }

    let template = match options.kind.as_str() {
        "device" => TSX_DEVICE,
        "title" => TSX_TITLE,
        "blank" => TSX_BLANK,
        other => return Err(format!("unknown scene kind {other:?}")),
    };

    let scenes_dir = project.join("scenes");
    std::fs::create_dir_all(&scenes_dir).map_err(|e| e.to_string())?;
    let base = slugify(&options.name);
    let stem = format!("{:02}-{base}", next_prefix(&scenes_dir));
    let file = format!("scenes/{stem}.tsx");
    let doc_file = format!("scenes/{stem}.json");

    // Duration: follow the video when the scene owns one, else the wizard default.
    let is_video = options.kind == "device"
        && options.media_kind.as_deref() == Some("video")
        && options.media_rel.is_some();
    let mut duration_ms = DEFAULT_SCENE_DURATION_MS;
    if is_video {
        if let Some(rel) = &options.media_rel {
            let abs = project.join(rel);
            let probed = media::probe_media(&app, &abs).await?;
            if probed.duration_ms > 0 {
                duration_ms = probed.duration_ms;
            }
        }
    }

    // The sidecar document (built here, not templated; Rust owns the schema).
    let mut doc = json!({
        "version": SCENE_DOC_VERSION,
        "name": options.name,
        "duration": if is_video {
            json!({ "mode": "follow-media", "sourceDeviceId": "d1" })
        } else {
            json!({ "mode": "manual" })
        },
        "text": {},
    });
    // Title scenes seed the TitleBlock pair (empty strings keep the panel fields visible); other kinds write `title` only when copy was given (older scenes keep their legacy `headline` key).
    if options.kind == "title" {
        doc["text"]["title"] = json!(options.title.as_deref().unwrap_or(""));
        doc["text"]["subtitle"] = json!(options.subtitle.as_deref().unwrap_or(""));
    } else if let Some(title) = &options.title {
        doc["text"]["title"] = json!(title);
    }
    if options.kind == "device" {
        let mut device = json!({
            "id": "d1",
            "model": options.device_model.as_deref().unwrap_or("iphone-17-pro"),
            "colour": options.colour.as_deref().unwrap_or("silver"),
            "placement": { "position": [0, -0.3, 0], "rotationDeg": [0, 0, 0], "scale": 1 },
            "motion": { "preset": options.motion_preset.as_deref().unwrap_or("none") },
            "shadow": options.shadow.as_deref().unwrap_or("soft"),
        });
        if let (Some(rel), Some(kind)) = (&options.media_rel, &options.media_kind) {
            device["media"] = json!({ "src": rel, "kind": kind });
        }
        doc["devices"] = json!([device]);
    }

    // TSX from the template; placeholders are dumb string replaces, keep them in sync with .claude/commands/new-scene.md, which interpolates the same files.
    let tsx = template
        .replace("__SCENE_ID__", &base)
        .replace("__STEM__", &stem)
        .replace("__NAME__", &options.name)
        .replace("__DURATION_MS__", &duration_ms.to_string());
    let tsx_path = scenes_dir.join(format!("{stem}.tsx"));
    let tmp = tsx_path.with_extension("tsx.tmp");
    std::fs::write(&tmp, tsx).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &tsx_path).map_err(|e| e.to_string())?;

    atomic_write_json(&scene_doc_path(&root, &slug, &doc_file)?, &doc)?;

    // Register in project.json (atomic), at `position` when given (in range), else appended.
    let manifest_path = project.join(MANIFEST_FILENAME);
    let text =
        std::fs::read_to_string(&manifest_path).map_err(|e| format!("reading project.json: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    let scenes = manifest
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .ok_or("project.json has no scenes array")?;
    let entry = json!({ "file": file, "durationMs": duration_ms });
    match options.position {
        Some(index) if index < scenes.len() => scenes.insert(index, entry),
        _ => scenes.push(entry),
    }
    atomic_write_json(&manifest_path, &manifest)?;

    Ok(ScaffoldResult {
        file,
        doc_file,
        scene_id: base,
        duration_ms,
    })
}
