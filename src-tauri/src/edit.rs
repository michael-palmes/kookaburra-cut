//! Non-destructive mini video editor: an edit is a JSON document under a project's `edits/` folder describing trim/reorder/retime of clips cut from `assets/` source videos and still images (never modified), edited in a second Tauri window (label `editor`); the flatten render defaults to VideoToolbox decode + `h264_videotoolbox` at a generous bitrate (retrying once with the old `libx264 -crf 18 -preset veryfast` lane on failure) and is NOT part of the byte-identical export path, but re-entering as a `VideoClip` source deterministically re-extracts to a CFR-60 PNG sequence, so a rendered edit still passes `Verify ×2`. The same app-free cores (`write_doc_checked`, `render_doc`, `validate_doc`) back the headless `edit` CLI (cli.rs), so an agent's edit saves and renders exactly like the editor's.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::edit_masks;
use crate::live_edits;
use crate::media;
use crate::tools;
use crate::workspace::{self, SettingsState};

/// What a source is: a video with a span, or a still image whose clips are all holds. Absent in documents written before images were editable, so it defaults to video.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditSourceKind {
    #[default]
    Video,
    Image,
}

/// A source video or still image referenced by an edit (read-only; identified by `id`, located by `rel`). Images probe as 0 fps / 0 ms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSource {
    pub id: String,
    pub rel: String,
    #[serde(default)]
    pub kind: EditSourceKind,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_ms: u64,
    /// Resolved absolute path, filled in server-side before a render. Never persisted.
    #[serde(skip)]
    pub abs: String,
}

/// One clip on the single video track: a `[inMs, outMs)` slice of `sourceId`, retimed by `speed`, positioned at `startMs` on the timeline. A freeze frame carries `holdMs`: the source frame at `inMs` (== `outMs`) held for that long.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditClip {
    pub id: String,
    pub source_id: String,
    pub in_ms: u64,
    pub out_ms: u64,
    pub speed: f64,
    pub start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_ms: Option<u64>,
}

/// Output geometry, taken from the first source when the edit is created, editable later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// A tap highlight: a glow-dot animation composited over the render at a source moment. Anchored in SOURCE time so it survives re-slicing; a duplicated segment shows it in each copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTap {
    pub id: String,
    pub source_id: String,
    pub source_ms: u64,
    /// Normalised 0..1 across the SOURCE video frame.
    pub pos: [f64; 2],
}

/// How a mask covers its box: an opaque fill, a gaussian blur or a mosaic.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditMaskStyle {
    #[default]
    Solid,
    Blur,
    Pixelate,
}

/// One mask keyframe: the box at a source moment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMaskKey {
    pub source_ms: u64,
    /// `[x, y, w, h]` normalised 0..1 across the SOURCE frame.
    pub rect: [f64; 4],
}

/// A privacy mask: a box that hides part of a source over a source span `[startMs, endMs)`, gliding linearly between keys (held before the first and after the last). Applied to the source before it is cut into clips, so every clip, speed and freeze of that span inherits it. A still image's mask ignores the span and uses its first key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMask {
    pub id: String,
    pub source_id: String,
    #[serde(default)]
    pub style: EditMaskStyle,
    /// 0..1 across the blur/pixelate range above its safe floor; absent = the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strength: Option<f64>,
    /// Solid fill as `#rrggbb`; absent = black.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    pub keys: Vec<EditMaskKey>,
}

/// The full edit document (`<project>/edits/<name>.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDoc {
    pub version: u32,
    pub name: String,
    pub sources: Vec<EditSource>,
    pub settings: EditSettings,
    pub clips: Vec<EditClip>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub taps: Vec<EditTap>,
    /// Tap style (shape) id; absent = the default (first) style.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_style: Option<String>,
    /// Tap colour id; absent = the default (first) colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_color: Option<String>,
    /// Tap size multiplier on the default dot size; absent = 1.25.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masks: Vec<EditMask>,
    /// The side-by-side reference pairing (scene matching); editor convenience, never read by renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<EditReference>,
}

/// A remembered reference video for side-by-side matching: another scene video shown in a read-only pane, its playhead offset in output ms (negative = the reference runs early).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditReference {
    pub rel: String,
    #[serde(default)]
    pub offset_ms: i64,
}

/// Which edit the editor window should open; stored in managed state and read by the editor on boot (`get_editor_target`) rather than smuggled through a URL query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    pub slug: String,
    pub name: String,
    /// Absolute project folder, the editor builds `/@fs` source URLs from it (dev).
    pub path: String,
    /// The originating source video (project-relative); lets the editor recreate the document from scratch when `edit.json` is corrupt (`reset_edit`).
    pub source_rel: String,
    /// The scene the edit was opened from; feeds the reference dropdown's media inventory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_index: Option<usize>,
}

/// The pending editor target (set just before the window opens / is refocused).
#[derive(Default)]
pub struct EditorState(pub Mutex<Option<EditTarget>>);

/// Determinate render progress, streamed to the editor over an ipc `Channel`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    frame: u32,
    total: u32,
}

const EDIT_VERSION: u32 = 1;
/// A masked edit saves as this version, so an older app (which drops unknown fields on autosave) refuses it instead of silently unmasking the next render.
pub(crate) const EDIT_VERSION_MASKS: u32 = 2;
pub(crate) const EDIT_VERSION_READ_MAX: u32 = 2;

/// A core failure carrying the CLI's machine code (`invalid`, `missing`, `ffmpeg`, ...); the Tauri commands surface only the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CoreError {
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<CoreError> for String {
    fn from(error: CoreError) -> String {
        error.message
    }
}

/// The version a document is written as: the lowest one that still carries everything in it.
pub(crate) fn doc_version(doc: &EditDoc) -> u32 {
    if doc.masks.is_empty() {
        EDIT_VERSION
    } else {
        EDIT_VERSION_MASKS
    }
}

fn edits_dir(project: &Path) -> std::path::PathBuf {
    project.join("edits")
}

pub(crate) fn edit_path(project: &Path, name: &str) -> std::path::PathBuf {
    edits_dir(project).join(format!("{name}.json"))
}

pub(crate) fn edit_rel(name: &str) -> String {
    format!("edits/{name}.json")
}

/// The exact bytes an edit is written as: stamped with the lowest version that carries everything in it, pretty JSON and one trailing newline.
pub(crate) fn doc_bytes(doc: &EditDoc) -> Result<Vec<u8>, String> {
    let mut stamped = doc.clone();
    stamped.version = doc_version(doc);
    let text = serde_json::to_string_pretty(&stamped).map_err(|e| e.to_string())?;
    Ok((text + "\n").into_bytes())
}

/// The one writer of `edits/<name>.json` (editor and CLI): atomic, so a crash mid-save can never corrupt the document, and refused when `base` (a content hash, or `absent`) no longer describes the file; no base writes unconditionally.
pub(crate) fn write_doc_checked(
    project: &Path,
    name: &str,
    doc: &EditDoc,
    base: Option<&str>,
) -> Result<live_edits::LandedWrite, String> {
    let rel = edit_rel(name);
    let bytes = doc_bytes(doc)?;
    live_edits::write_bytes_checked(&edit_path(project, name), &rel, &bytes, base).map_err(|e| {
        if e.starts_with(live_edits::CONFLICT_PREFIX) {
            format!(
                "{} {rel} changed outside the editor",
                live_edits::CONFLICT_PREFIX
            )
        } else {
            e
        }
    })
}

/// Editor tap preferences remembered per project (`<slug>/edits/_tap_prefs.json`): the last saved style/colour/size seeds the next new edit. Editor convenience only, never part of the deterministic project schema.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TapPrefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_size: Option<f64>,
}

fn tap_prefs_path(project: &Path) -> std::path::PathBuf {
    edits_dir(project).join("_tap_prefs.json")
}

/// Missing or corrupt prefs read as empty; they are a convenience, never an error.
fn read_tap_prefs(project: &Path) -> TapPrefs {
    std::fs::read_to_string(tap_prefs_path(project))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Best-effort atomic write on every save carrying tap fields; a prefs failure never fails the save. Merges per field: a doc that never touched a field must not wipe another edit's saved preference.
pub(crate) fn write_tap_prefs(project: &Path, doc: &EditDoc) {
    if doc.tap_style.is_none() && doc.tap_color.is_none() && doc.tap_size.is_none() {
        return;
    }
    let mut prefs = read_tap_prefs(project);
    if doc.tap_style.is_some() {
        prefs.tap_style = doc.tap_style.clone();
    }
    if doc.tap_color.is_some() {
        prefs.tap_color = doc.tap_color.clone();
    }
    if doc.tap_size.is_some() {
        prefs.tap_size = doc.tap_size;
    }
    let path = tap_prefs_path(project);
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(&prefs) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text + "\n").is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn read_doc(path: &Path) -> Result<EditDoc, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("reading edit at {}: {e}", path.display()))?;
    parse_doc(&text)
}

fn parse_doc(text: &str) -> Result<EditDoc, String> {
    parse_doc_coded(text).map_err(String::from)
}

/// Parse with serde's strictness (a fractional or negative ms is corrupt), refusing versions this build cannot read.
pub(crate) fn parse_doc_coded(text: &str) -> Result<EditDoc, CoreError> {
    let doc: EditDoc = serde_json::from_str(text)
        .map_err(|e| CoreError::new("corrupt", format!("edit is corrupt: {e}")))?;
    if doc.version > EDIT_VERSION_READ_MAX {
        return Err(CoreError::new(
            "version",
            format!(
                "this edit uses document version {} and needs a newer Kookaburra Cut",
                doc.version
            ),
        ));
    }
    Ok(doc)
}

/// An edit's on-disk bytes, parsed, with their content hash: what a render or a checked save is based on.
pub(crate) fn load_doc_bytes(
    project: &Path,
    name: &str,
) -> Result<(EditDoc, Vec<u8>, String), CoreError> {
    let path = edit_path(project, name);
    let bytes = std::fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CoreError::new(
                "missing",
                format!("no edit named {name}: {} does not exist", edit_rel(name)),
            )
        } else {
            CoreError::new("corrupt", format!("reading {}: {e}", path.display()))
        }
    })?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| CoreError::new("corrupt", "edit is corrupt: not UTF-8 text"))?;
    let doc = parse_doc_coded(text)?;
    let hash = live_edits::content_hash(&bytes);
    Ok((doc, bytes, hash))
}

/// Open the editor window for `(slug, name)`, retargeting and focusing it if it already exists, otherwise creating it; the `editor` label picks up `capabilities/editor.json` at runtime, so Rust-side creation needs no create-window capability on the main window.
fn open_editor_window(app: &AppHandle, target: &EditTarget) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.set_title(&format!("Kookaburra Cut — {}", target.name));
        let _ = win.emit("kookaburra://editor-target", target.clone());
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("editor.html".into()))
        .title(format!("Kookaburra Cut — {}", target.name))
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .theme(Some(tauri::Theme::Dark))
        // --surface-window; the NSWindow layer of the anti-flash work.
        .background_color(tauri::window::Color(0x0E, 0x11, 0x13, 0xFF))
        // HTML5 drag-and-drop (media panel → timeline) only works with Tauri's native drag-drop interception OFF; editor window only, the MAIN window keeps native drag-anywhere file import (tauri://drag-drop).
        .disable_drag_drop_handler();
    // Overlay titlebar chrome, matching the main window's config (tauri.conf.json: titleBarStyle Overlay, hiddenTitle, trafficLightPosition 12,20).
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 20.0));
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::deflash_webview(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

/// Create (or re-open) an edit for `source_rel` and open the editor window on it; the edit name is the slugified source stem, so re-editing the same clip reopens the same document.
#[tauri::command]
pub async fn open_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    editor: State<'_, EditorState>,
    slug: String,
    source_rel: String,
    scene_index: Option<usize>,
) -> Result<String, String> {
    let project = workspace::project_dir_mut(&app, &settings, &slug)?;
    let source_abs = media::resolve_asset_in(&project, &source_rel)?;
    if !source_abs.is_file() {
        return Err(format!("source not found: {source_rel}"));
    }

    let name = default_edit_name(&source_abs);
    if !edit_path(&project, &name).is_file() {
        let doc = create_default_doc(&project, &name, &source_rel).await?;
        // Someone else (the CLI) creating it meanwhile is fine: open theirs.
        match write_doc_checked(&project, &name, &doc, Some(live_edits::ABSENT_BASE)) {
            Ok(_) => {}
            Err(e) if e.starts_with(live_edits::CONFLICT_PREFIX) => {}
            Err(e) => return Err(e),
        }
    }

    let target = EditTarget {
        slug: slug.clone(),
        name: name.clone(),
        path: project.to_string_lossy().into_owned(),
        source_rel: source_rel.clone(),
        scene_index,
    };
    *editor.0.lock().map_err(|_| "editor state poisoned")? = Some(target.clone());
    open_editor_window(&app, &target)?;
    Ok(name)
}

/// Default hold for a still image clip, mirroring editMath.ts `DEFAULT_HOLD_MS`.
pub(crate) const DEFAULT_IMAGE_HOLD_MS: u64 = 2000;
/// editMath.ts floors: the shortest source span a trim or split leaves, and the shortest hold.
pub(crate) const MIN_CLIP_SOURCE_MS: u64 = 100;
pub(crate) const MIN_HOLD_MS: u64 = 100;

/// The edit name a source seeds: its slugified file stem, so re-editing the same clip reopens the same document.
pub(crate) fn default_edit_name(source_abs: &Path) -> String {
    let stem = source_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("edit");
    let name = workspace::slugify(stem);
    if name.is_empty() {
        "edit".into()
    } else {
        name
    }
}

/// The output rate a fresh edit adopts: the probed rate, except a variable-frame-rate source (a Simulator recording writes a frame per screen change and averages ~15 fps against 60 fps bursts) renders at 60.
pub(crate) fn edit_fps(probe: &media::ProbeInfo) -> f64 {
    if probe.vfr || probe.fps <= 0.0 {
        60.0
    } else {
        probe.fps
    }
}

/// yuv420p needs even output dimensions; a screenshot can be odd, a recording never is.
pub(crate) fn even(w: u32, h: u32) -> (u32, u32) {
    (w - w % 2, h - h % 2)
}

/// The fresh single-clip document `open_edit` seeds (and `reset_edit` and `edit create` recreate), probing with the given ffprobe; an image seeds one default-length freeze instead of a full-span clip.
pub(crate) fn create_default_doc_at(
    ffprobe: &Path,
    project: &Path,
    name: &str,
    source_rel: &str,
) -> Result<EditDoc, CoreError> {
    let source_abs =
        media::resolve_asset_in(project, source_rel).map_err(|e| CoreError::new("usage", e))?;
    if !source_abs.is_file() {
        return Err(CoreError::new(
            "missing",
            format!("source not found: {source_rel}"),
        ));
    }
    let probe =
        media::probe_media_at(ffprobe, &source_abs).map_err(|e| CoreError::new("invalid", e))?;
    default_doc(&probe, project, name, source_rel)
}

/// `create_default_doc_at` with the bundled ffprobe, off the async runtime.
async fn create_default_doc(
    project: &Path,
    name: &str,
    source_rel: &str,
) -> Result<EditDoc, String> {
    let ffprobe = tools::sidecar_path("ffprobe")?;
    let (project, name, source_rel) = (
        project.to_path_buf(),
        name.to_owned(),
        source_rel.to_owned(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        create_default_doc_at(&ffprobe, &project, &name, &source_rel)
    })
    .await
    .map_err(|e| format!("edit setup failed: {e}"))?
    .map_err(String::from)
}

fn default_doc(
    probe: &media::ProbeInfo,
    project: &Path,
    name: &str,
    source_rel: &str,
) -> Result<EditDoc, CoreError> {
    let kind = match probe.kind.as_str() {
        "video" => EditSourceKind::Video,
        "image" => EditSourceKind::Image,
        other => {
            return Err(CoreError::new(
                "invalid",
                format!("{other} files can't be edited"),
            ))
        }
    };
    let image = kind == EditSourceKind::Image;
    let (width, height) = if image {
        even(probe.width, probe.height)
    } else {
        (probe.width, probe.height)
    };
    let fps = edit_fps(probe);
    let prefs = read_tap_prefs(project);
    Ok(EditDoc {
        version: EDIT_VERSION,
        name: name.to_owned(),
        sources: vec![EditSource {
            id: "s1".into(),
            rel: source_rel.to_owned(),
            kind,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            duration_ms: probe.duration_ms,
            abs: String::new(),
        }],
        settings: EditSettings { width, height, fps },
        clips: vec![EditClip {
            id: "c1".into(),
            source_id: "s1".into(),
            in_ms: 0,
            out_ms: probe.duration_ms,
            speed: 1.0,
            start_ms: 0,
            hold_ms: image.then_some(DEFAULT_IMAGE_HOLD_MS),
        }],
        taps: Vec::new(),
        tap_style: prefs.tap_style,
        tap_color: prefs.tap_color,
        tap_size: prefs.tap_size,
        masks: Vec::new(),
        reference: None,
    })
}

/// Open the editor on an EXISTING edit by name; the media library's "Open in editor" action on a rendered `assets/<name>-edited.mp4` maps back to its document.
#[tauri::command]
pub fn open_edit_named(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    editor: State<'_, EditorState>,
    slug: String,
    name: String,
    scene_index: Option<usize>,
) -> Result<String, String> {
    let project = workspace::project_dir_mut(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    let doc = read_doc(&edit_path(&project, &name))?;
    let source_rel = doc
        .sources
        .first()
        .map(|s| s.rel.clone())
        .unwrap_or_default();
    let target = EditTarget {
        slug: slug.clone(),
        name: name.clone(),
        path: project.to_string_lossy().into_owned(),
        source_rel,
        scene_index,
    };
    *editor.0.lock().map_err(|_| "editor state poisoned")? = Some(target.clone());
    open_editor_window(&app, &target)?;
    Ok(name)
}

/// Recovery for a corrupt/incompatible `edit.json`: keep the broken file beside it as `<name>.json.bak`, recreate the default document from the source, return it.
#[tauri::command]
pub async fn reset_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
    source_rel: String,
) -> Result<EditDoc, String> {
    let project = workspace::project_dir_mut(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    backup_doc(&project, &name);
    let doc = create_default_doc(&project, &name, &source_rel).await?;
    write_doc_checked(&project, &name, &doc, None)?;
    Ok(doc)
}

/// Move the current document aside as `<name>.json.bak` (best effort), as a reset or a forced create does.
pub(crate) fn backup_doc(project: &Path, name: &str) {
    let path = edit_path(project, name);
    if path.is_file() {
        let _ = std::fs::rename(&path, path.with_extension("json.bak"));
    }
}

/// The pending editor target (read once by the editor window on boot).
#[tauri::command]
pub fn get_editor_target(editor: State<'_, EditorState>) -> Result<Option<EditTarget>, String> {
    Ok(editor
        .0
        .lock()
        .map_err(|_| "editor state poisoned")?
        .clone())
}

/// Load an edit document (schema-validated by serde; a corrupt file returns a readable error).
#[tauri::command]
pub fn load_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<EditDoc, String> {
    let project = workspace::project_dir(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    read_doc(&edit_path(&project, &name))
}

/// One landed document write: its content hash and file stamp, plus the stamp it replaced, so the editor's poll adopts only its own change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditWrite {
    pub hash: String,
    pub stamp: String,
    pub before: Option<String>,
}

/// A save is refused when the document's own `name` differs from the file it targets (a rename can never write outside its file).
pub(crate) fn check_doc_name(doc: &EditDoc, name: &str) -> Result<(), String> {
    if doc.name == name {
        Ok(())
    } else {
        Err(format!(
            "this edit is named {:?} but would be saved as {}: names must match",
            doc.name,
            edit_rel(name)
        ))
    }
}

/// Persist an edit document (autosave); the name is fixed at creation and the doc's own `name` must match. `base_hash` is the content hash the editor last read (`absent` for a new file): a stale base is refused as a conflict, and none writes unconditionally (legacy callers).
#[tauri::command]
pub fn save_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
    doc: EditDoc,
    base_hash: Option<String>,
) -> Result<EditWrite, String> {
    let project = workspace::project_dir_mut(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    check_doc_name(&doc, &name)?;
    let landed = write_doc_checked(&project, &name, &doc, base_hash.as_deref())?;
    write_tap_prefs(&project, &doc);
    Ok(EditWrite {
        hash: landed.hash,
        stamp: landed.stamp,
        before: landed.before,
    })
}

/// The last render as the editor needs it: which document bytes it rendered, when, and how long it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSummary {
    pub doc_hash: String,
    pub at_ms: u64,
    pub frames: u32,
}

/// A document with the hash and stamp of the exact bytes it was parsed from, and its last canonical render.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditEntry {
    pub doc: EditDoc,
    pub hash: String,
    pub stamp: String,
    pub render: Option<RenderSummary>,
}

/// Read a document so its stamp describes the bytes parsed: a write landing mid-read is retried.
pub(crate) fn read_edit_entry(project: &Path, name: &str) -> Result<EditEntry, String> {
    let path = edit_path(project, name);
    let mut attempt = 0;
    loop {
        let before = live_edits::file_stamp(&path);
        let (doc, _, hash) = load_doc_bytes(project, name)?;
        let after = live_edits::file_stamp(&path);
        attempt += 1;
        if before == after || attempt >= 3 {
            let render = read_render_record(project, name).map(|r| RenderSummary {
                doc_hash: r.doc_hash,
                at_ms: r.at_ms,
                frames: r.frames,
            });
            return Ok(EditEntry {
                doc,
                hash,
                stamp: after.unwrap_or_default(),
                render,
            });
        }
    }
}

/// Load an edit with its content hash, file stamp and render record, the base for checked saves and live reloads.
#[tauri::command]
pub fn load_edit_entry(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<EditEntry, String> {
    let project = workspace::project_dir(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    read_edit_entry(&project, &name)
}

/// File stamps of a document and its render record (None = missing), the editor's cheap change poll.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditStamps {
    pub doc: Option<String>,
    pub render: Option<String>,
}

pub(crate) fn stamps_of(project: &Path, name: &str) -> EditStamps {
    EditStamps {
        doc: live_edits::file_stamp(&edit_path(project, name)),
        render: live_edits::file_stamp(&render_record_path(project, name)),
    }
}

#[tauri::command]
pub fn edit_stamps(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<EditStamps, String> {
    let project = workspace::project_dir(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    Ok(stamps_of(&project, &name))
}

/// Names of a project's saved edits.
#[tauri::command]
pub fn list_edits(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    let project = workspace::project_dir(&app, &settings, &slug)?;
    let mut names = Vec::new();
    if let Ok(read) = std::fs::read_dir(edits_dir(&project)) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    // Leading underscore = editor sidecar (_tap_prefs), not an edit.
                    if !stem.starts_with('_') {
                        names.push(stem.to_owned());
                    }
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// How long an image clip sits on the timeline: its hold, falling back to the default beat for a document that somehow carries none (an image has no span to fall back on).
fn image_hold_ms(clip: &EditClip) -> u64 {
    clip.hold_ms.unwrap_or(DEFAULT_IMAGE_HOLD_MS)
}

/// A clip's span on the timeline in ms, mirroring editMath.ts `clipTimelineMs`: the retimed source span, or the hold of a freeze or image clip.
fn clip_timeline_ms(clip: &EditClip, image: bool) -> f64 {
    if image {
        return image_hold_ms(clip) as f64;
    }
    match clip.hold_ms {
        Some(hold) => hold as f64,
        None => {
            let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
            clip.out_ms.saturating_sub(clip.in_ms) as f64 / speed
        }
    }
}

/// The output frame at timeline `ms`: the ms timeline snapped to the frame grid.
fn frame_at(ms: f64, fps: f64) -> u32 {
    ((ms / 1000.0) * fps).round().max(0.0) as u32
}

/// Tap-highlight constants, hand-mirrored from src/editor/tapAnimation.ts and scripts/generate-tap-dot.mjs.
pub(crate) const TAP_ANIMATION_DURATION_MS: f64 = 550.0;
const TAP_DOT_SIZE_FRACTION: f64 = 0.07;
/// The baked frames leave pulse headroom around the scale-1 dot; the overlay scales up by the same factor so the dot lands at exactly TAP_DOT_SIZE_FRACTION of min(w, h).
const TAP_DOT_CANVAS_HEADROOM: f64 = 1.15;
/// Bump when the baked frames change to invalidate the materialised cache.
const TAP_DOT_FRAMES_VERSION: u32 = 3;

/// The doc's tap style (shape), falling back to the default (first) style when absent or unknown.
fn tap_style_id(doc: &EditDoc) -> &str {
    let styles = crate::tap_dot_frames::TAP_DOT_STYLES;
    match doc.tap_style.as_deref() {
        Some(id) if styles.iter().any(|(k, _)| *k == id) => id,
        _ => styles[0].0,
    }
}

/// The doc's tap colour as channel multipliers over the white frames, defaulting to the first colour.
fn tap_color_mult(doc: &EditDoc) -> [f64; 3] {
    let colors = crate::tap_dot_frames::TAP_DOT_COLORS;
    colors
        .iter()
        .find(|(k, _)| Some(*k) == doc.tap_color.as_deref())
        .unwrap_or(&colors[0])
        .1
}

/// Materialise the embedded glow-dot frames into `<app data>/cache/tapdot/<style>` once (versioned marker, the media-cache pattern) so ffmpeg's image2 reader can consume them; both encode lanes reference the same stable files. The app and the CLI can race here, so the tree is staged and published with one rename.
pub(crate) fn ensure_tap_dot_frames_in(app_data: &Path) -> Result<PathBuf, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = app_data.join("cache").join("tapdot");
    let done = dir.join(format!(".done-v{TAP_DOT_FRAMES_VERSION}"));
    if done.is_file() {
        return Ok(dir);
    }
    let parent = dir.parent().ok_or("tap frame cache has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = parent.join(format!(
        ".staging-tapdot-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&staging);
    let written = (|| -> Result<(), String> {
        for (style, frames) in crate::tap_dot_frames::TAP_DOT_STYLES {
            let style_dir = staging.join(style);
            std::fs::create_dir_all(&style_dir).map_err(|e| e.to_string())?;
            for (i, bytes) in frames.iter().enumerate() {
                std::fs::write(style_dir.join(format!("tapdot_{i:02}.png")), bytes)
                    .map_err(|e| e.to_string())?;
            }
        }
        let marker = format!(".done-v{TAP_DOT_FRAMES_VERSION}");
        std::fs::write(staging.join(marker), []).map_err(|e| e.to_string())?;
        // `commit_staged_dir` keeps a racing writer's tree when it carries `.done`.
        std::fs::write(staging.join(".done"), []).map_err(|e| e.to_string())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    // An older version's tree lacks this marker; clear it so the commit cannot keep it as complete.
    if dir.exists() && !done.is_file() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    crate::commit_staged_dir(&staging, &dir)?;
    if done.is_file() {
        Ok(dir)
    } else {
        Err("the tap highlight frames could not be prepared".into())
    }
}

/// Mirror of editMath.ts `tapWindows`: one `(tap, clip, start_ms, end_ms)` per clip containing the tap's source point, so a duplicated segment shows it in each copy. Duration is fixed in output ms, clamped at the clip's end (a tap near a cut truncates); freezes are skipped (zero-length source span).
pub(crate) fn tap_windows<'a>(
    clips_sorted: &[&'a EditClip],
    taps: &'a [EditTap],
) -> Vec<(&'a EditTap, &'a EditClip, f64, f64)> {
    let mut windows = Vec::new();
    for tap in taps {
        for clip in clips_sorted {
            if clip.hold_ms.is_some()
                || clip.source_id != tap.source_id
                || tap.source_ms < clip.in_ms
                || tap.source_ms >= clip.out_ms
            {
                continue;
            }
            let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
            let start = clip.start_ms as f64 + (tap.source_ms - clip.in_ms) as f64 / speed;
            let clip_end = clip.start_ms as f64 + (clip.out_ms - clip.in_ms) as f64 / speed;
            windows.push((
                tap,
                *clip,
                start,
                (start + TAP_ANIMATION_DURATION_MS).min(clip_end),
            ));
        }
    }
    windows
}

/// Build the ffmpeg args that flatten an edit into a single file: each source video is normalised to the output rate once and split per use, then one filter chain per clip (trim → retime → pad and cut to the clip's exact frame count → scale+pad to the output size; an image input loops for its hold instead of trimming) then `concat`, rendered in timeline (`startMs`) order; gaps are not yet materialised as black. Privacy masks bake into each normalised source before its split (edit_masks.rs); tap highlights overlay the concat output (one baked-frame input per visible window). The hardware lane decodes and encodes on the media engine; the output is an intermediate re-encoded at final export, so 0.25 bits/pixel is generous headroom (the old crf-18 lane measures ~0.09).
pub(crate) fn build_render_args(
    doc: &EditDoc,
    output: &str,
    hardware: bool,
    tap_dot_dir: Option<&Path>,
) -> Result<(Vec<String>, u32), String> {
    build_render_args_for(doc, output, hardware, tap_dot_dir, EncodeProfile::Canonical)
}

/// How the flattened stream is encoded: the editor's canonical lanes, or a quick software draft for review frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EncodeProfile {
    Canonical,
    /// Software libx264 `ultrafast`, crf 26, a keyframe every 30 frames; never hardware.
    Draft,
}

/// The render's output rate: the settings rate, 60 when unset.
pub(crate) fn render_fps(doc: &EditDoc) -> f64 {
    if doc.settings.fps > 0.0 {
        doc.settings.fps
    } else {
        60.0
    }
}

/// One clip's place on the render's output frame grid.
#[derive(Debug, Clone)]
pub(crate) struct ClipFrames<'a> {
    pub clip: &'a EditClip,
    pub image: bool,
    /// Timeline ms where the render places the clip (the cumulative span, not the stored `startMs`).
    pub start_ms: f64,
    pub end_ms: f64,
    pub start_frame: u32,
    pub frames: u32,
}

/// The clips in render order (stable by `startMs`), each cut to its frame count on the cumulative timeline grid, so no boundary sits more than half a frame from the editor's timeline and rounding cannot accumulate across cuts.
pub(crate) fn clip_frame_plan(doc: &EditDoc) -> Result<Vec<ClipFrames<'_>>, String> {
    let fps = render_fps(doc);
    let mut clips: Vec<&EditClip> = doc.clips.iter().collect();
    clips.sort_by_key(|clip| clip.start_ms);
    let mut cursor_ms = 0.0;
    clips
        .into_iter()
        .map(|clip| {
            let source = doc
                .sources
                .iter()
                .find(|s| s.id == clip.source_id)
                .ok_or_else(|| format!("clip references unknown source {}", clip.source_id))?;
            let image = source.kind == EditSourceKind::Image;
            let start_ms = cursor_ms;
            let start_frame = frame_at(cursor_ms, fps);
            cursor_ms += clip_timeline_ms(clip, image);
            let frames = frame_at(cursor_ms, fps).saturating_sub(start_frame).max(1);
            Ok(ClipFrames {
                clip,
                image,
                start_ms,
                end_ms: cursor_ms,
                start_frame,
                frames,
            })
        })
        .collect()
}

pub(crate) fn build_render_args_for(
    doc: &EditDoc,
    output: &str,
    hardware: bool,
    tap_dot_dir: Option<&Path>,
    profile: EncodeProfile,
) -> Result<(Vec<String>, u32), String> {
    if doc.clips.is_empty() {
        return Err("this edit has no clips to render".into());
    }
    edit_masks::validate_masks(doc)?;
    let hardware = hardware && profile == EncodeProfile::Canonical;
    let (w, h) = (doc.settings.width, doc.settings.height);
    let fps = render_fps(doc);
    let plan = clip_frame_plan(doc)?;

    // Each source VIDEO used by a clip becomes ONE `-i` in stable order, decoded once and split per use below. A still is the exception: it takes one looped input PER clip, each with its own `-t`, so a reused image never leaves a split queueing thousands of duplicated frames.
    let mut input_order: Vec<&EditSource> = Vec::new();
    let mut input_hold_ms: Vec<u64> = Vec::new();
    let mut video_index = std::collections::HashMap::new();
    let clips_sorted: Vec<&EditClip> = plan.iter().map(|p| p.clip).collect();
    let mut clip_input = Vec::with_capacity(clips_sorted.len());
    for clip in &clips_sorted {
        let source = doc
            .sources
            .iter()
            .find(|s| s.id == clip.source_id)
            .ok_or_else(|| format!("clip references unknown source {}", clip.source_id))?;
        let image = source.kind == EditSourceKind::Image;
        let idx = match video_index.get(&clip.source_id) {
            Some(&idx) if !image => idx,
            _ => {
                input_order.push(source);
                input_hold_ms.push(if image { image_hold_ms(clip) } else { 0 });
                if !image {
                    video_index.insert(clip.source_id.clone(), input_order.len() - 1);
                }
                input_order.len() - 1
            }
        };
        clip_input.push(idx);
    }

    // Trimming a variable-frame-rate recording directly (the Simulator writes a frame per screen change, with holds of many seconds) drops the frame on screen at the in-point and passes the last kept frame with its whole hold; on a stream normalised to the output rate every slot carries the held frame for one slot.
    let mut uses = vec![0usize; input_order.len()];
    let clip_label: Vec<String> = clip_input
        .iter()
        .map(|&idx| {
            let label = format!("src{idx}_{}", uses[idx]);
            uses[idx] += 1;
            label
        })
        .collect();
    let mut filter = String::new();
    for (idx, source) in input_order.iter().enumerate() {
        if source.kind == EditSourceKind::Image {
            continue;
        }
        let outs: String = (0..uses[idx]).map(|j| format!("[src{idx}_{j}]")).collect();
        let split = if uses[idx] > 1 {
            format!(",split={}", uses[idx])
        } else {
            String::new()
        };
        let masks = edit_masks::masks_for(doc, source);
        if masks.is_empty() {
            filter.push_str(&format!("[{idx}:v]fps={fps}:start_time=0{split}{outs};"));
            continue;
        }
        // Masks bake into the normalised source before the split, so every clip cut from it is covered.
        let masked = if uses[idx] > 1 {
            format!("m{idx}")
        } else {
            format!("src{idx}_0")
        };
        filter.push_str(&format!("[{idx}:v]fps={fps}:start_time=0[n{idx}];"));
        filter.push_str(&edit_masks::video_chain(
            &masks,
            source,
            fps,
            &format!("n{idx}"),
            &masked,
            &format!("k{idx}"),
        )?);
        if uses[idx] > 1 {
            filter.push_str(&format!("[{masked}]split={}{outs};", uses[idx]));
        }
    }
    let mut labels = Vec::new();
    let mut total_frames = 0u32;
    for (i, clip) in clips_sorted.iter().enumerate() {
        let idx = clip_input[i];
        let (image, frames) = (plan[i].image, plan[i].frames);
        let in_s = clip.in_ms as f64 / 1000.0;
        let out_s = clip.out_ms as f64 / 1000.0;
        let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
        let label = format!("v{i}");
        let still_masks = if image {
            edit_masks::masks_for(doc, input_order[idx])
        } else {
            Vec::new()
        };
        let head = if image && !still_masks.is_empty() {
            filter.push_str(&edit_masks::image_chain(
                &still_masks,
                input_order[idx],
                &format!("{idx}:v"),
                &format!("im{i}"),
                &format!("i{i}"),
            )?);
            format!("[im{i}]")
        } else if image {
            format!("[{idx}:v]")
        } else if clip.hold_ms.is_some() {
            // Freeze frame: the one slot at inMs, cloned for the hold.
            format!(
                "[{}]trim=start={in_s:.6}:duration=0.5,select=eq(n\\,0),setpts=PTS-STARTPTS,",
                clip_label[i]
            )
        } else {
            format!(
                "[{}]trim=start={in_s:.6}:end={out_s:.6},setpts=(PTS-STARTPTS)/{speed},",
                clip_label[i]
            )
        };
        // `tpad` clones the last frame past a short cut, `fps` regrids the clones onto contiguous slots and `trim` drops any overrun, so the count is exact either way.
        filter.push_str(&format!(
            "{head}tpad=stop_mode=clone:stop={frames},fps={fps},trim=end_frame={frames},\
             setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{label}];"
        ));
        labels.push(label);
        total_frames += frames;
    }
    for label in &labels {
        filter.push_str(&format!("[{label}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=0[outv]", labels.len()));

    // Tap highlights: one baked glow-dot input per visible window, overlaid AFTER concat on the output-resolution stream (windows are output-time; positions map through each clip's own scale+pad letterbox, multi-source safe).
    let windows = match tap_dot_dir {
        Some(_) => tap_windows(&clips_sorted, &doc.taps),
        None => Vec::new(),
    };
    let mut out_label = "outv".to_string();
    if !windows.is_empty() {
        let tap_size = doc.tap_size.unwrap_or(1.25).clamp(0.25, 4.0);
        let dot_px = ((w.min(h) as f64)
            * TAP_DOT_SIZE_FRACTION
            * TAP_DOT_CANVAS_HEADROOM
            * tap_size)
            .round() as u32;
        let [cr, cg, cb] = tap_color_mult(doc);
        for (i, (tap, clip, start_ms, end_ms)) in windows.iter().enumerate() {
            let source = doc
                .sources
                .iter()
                .find(|s| s.id == clip.source_id)
                .ok_or_else(|| format!("tap references unknown source {}", clip.source_id))?;
            // Mirror ffmpeg's integer geometry exactly: `scale=…:force_original_aspect_ratio=decrease` rounds the free dimension to the nearest integer (av_rescale) and `pad`'s (ow-iw)/2 truncates, so the overlay centre must come from those integer results, not raw floats.
            let scaled_w = (f64::from(h) * f64::from(source.width) / f64::from(source.height))
                .round()
                .min(f64::from(w));
            let scaled_h = (f64::from(w) * f64::from(source.height) / f64::from(source.width))
                .round()
                .min(f64::from(h));
            let px =
                ((f64::from(w) - scaled_w) / 2.0).floor() + tap.pos[0].clamp(0.0, 1.0) * scaled_w;
            let py =
                ((f64::from(h) - scaled_h) / 2.0).floor() + tap.pos[1].clamp(0.0, 1.0) * scaled_h;
            let idx = input_order.len() + i;
            let start_s = start_ms / 1000.0;
            let end_s = end_ms / 1000.0;
            let next = format!("tapv{i}");
            filter.push_str(&format!(
                ";[{idx}:v]format=rgba,colorchannelmixer=rr={cr:.6}:gg={cg:.6}:bb={cb:.6},\
                 scale={dot_px}:{dot_px}:flags=lanczos[dot{i}];\
                 [{out_label}][dot{i}]overlay=x={px:.3}-overlay_w/2:y={py:.3}-overlay_h/2:\
                 eof_action=pass:enable='between(t\\,{start_s:.6}\\,{end_s:.6})'[{next}]"
            ));
            out_label = next;
        }
    }

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    for (i, source) in input_order.iter().enumerate() {
        if source.kind == EditSourceKind::Image {
            // Loop the still at the output rate for exactly its clip's hold; there is no codec here to hardware-decode.
            let duration_s = input_hold_ms[i] as f64 / 1000.0;
            args.extend([
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                format!("{fps}"),
                "-t".into(),
                format!("{duration_s:.6}"),
            ]);
        } else if hardware {
            args.push("-hwaccel".into());
            args.push("videotoolbox".into());
        }
        args.push("-i".into());
        args.push(source.abs.clone());
    }
    if let Some(dir) = tap_dot_dir {
        let seq = dir
            .join(tap_style_id(doc))
            .join("tapdot_%02d.png")
            .to_string_lossy()
            .into_owned();
        for (_, _, start_ms, _) in &windows {
            args.push("-itsoffset".into());
            args.push(format!("{:.6}", start_ms / 1000.0));
            args.push("-framerate".into());
            args.push("60".into());
            args.push("-i".into());
            args.push(seq.clone());
        }
    }
    args.extend([
        "-filter_complex".into(),
        filter,
        "-map".into(),
        format!("[{out_label}]"),
    ]);
    if hardware {
        let target_kbps = ((f64::from(w) * f64::from(h) * fps * 0.25) / 1000.0)
            .round()
            .max(8_000.0) as u32;
        args.extend([
            "-c:v".into(),
            "h264_videotoolbox".into(),
            "-b:v".into(),
            format!("{target_kbps}k"),
        ]);
    } else if profile == EncodeProfile::Draft {
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "26".into(),
            "-g".into(),
            "30".into(),
        ]);
    } else {
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "18".into(),
        ]);
    }
    args.extend([
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-an".into(),
        output.into(),
    ]);
    Ok((args, total_frames.max(1)))
}

/// Where a render lands: the project's canonical `assets/<name>-edited.mp4` (which also writes the render record), or any other file (a review render).
#[derive(Debug, Clone)]
pub(crate) enum RenderTarget {
    Canonical(String),
    File(PathBuf),
}

/// The encode lane that produced (or is producing) a render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Lane {
    Hardware,
    Software,
}

impl Lane {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Lane::Hardware => "hardware",
            Lane::Software => "software",
        }
    }
}

/// Everything one render needs, resolved by the caller: the Tauri command and the CLI build the same job.
#[derive(Debug, Clone)]
pub(crate) struct RenderJob {
    pub project: PathBuf,
    pub doc: EditDoc,
    /// SHA-256 hex of the document bytes being rendered.
    pub doc_hash: String,
    pub target: RenderTarget,
    pub ffmpeg: PathBuf,
    /// Holds the materialised tap frames (`cache/tapdot`).
    pub app_data: PathBuf,
    /// Try the VideoToolbox lane first; drafts always run software.
    pub hardware: bool,
    /// Output size factor in 0.1..=1, applied with even dimensions.
    pub scale: Option<f64>,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RenderEvent {
    Start {
        lane: Lane,
        total: u32,
        out: PathBuf,
    },
    Progress {
        frame: u32,
        total: u32,
    },
    Retry {
        lane: Lane,
        error: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct RenderOutcome {
    /// Project-relative output for a canonical render, None for a review render.
    pub rel: Option<String>,
    pub path: PathBuf,
    pub lane: Lane,
    pub frames: u32,
    pub duration_ms: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub doc_hash: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// The last canonical render of an edit (`edits/.renders/<name>.json`): which document bytes it rendered, so a stale output is detectable without decoding it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderRecord {
    pub doc_hash: String,
    pub output: String,
    pub lane: Lane,
    pub frames: u32,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub at_ms: u64,
}

pub(crate) fn render_record_path(project: &Path, name: &str) -> PathBuf {
    edits_dir(project)
        .join(".renders")
        .join(format!("{name}.json"))
}

/// The render record, or None when missing or unreadable (a record is a hint, never a requirement).
pub(crate) fn read_render_record(project: &Path, name: &str) -> Option<RenderRecord> {
    let text = std::fs::read_to_string(render_record_path(project, name)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_render_record(project: &Path, name: &str, record: &RenderRecord) -> Result<(), String> {
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    let rel = format!("edits/.renders/{name}.json");
    live_edits::write_bytes_checked(
        &render_record_path(project, name),
        &rel,
        (text + "\n").as_bytes(),
        None,
    )
    .map(|_| ())
}

/// The output geometry at `scale`: each side rounded, then floored to even (yuv420p) and at least 2.
pub(crate) fn scaled_settings(settings: &EditSettings, scale: f64) -> EditSettings {
    let side = |v: u32| {
        let px = (f64::from(v) * scale).round().max(0.0) as u32;
        (px - px % 2).max(2)
    };
    EditSettings {
        width: side(settings.width),
        height: side(settings.height),
        fps: settings.fps,
    }
}

/// The frame number in one ffmpeg `-progress` line (`frame=N`).
pub(crate) fn parse_progress_frame(line: &str) -> Option<u32> {
    line.trim().strip_prefix("frame=")?.trim().parse().ok()
}

/// Staged renders older than this are leftovers of a killed render.
const STALE_STAGING: Duration = Duration::from_secs(60 * 60);
const STAGING_DIR: &str = ".kc-render";

/// A render's output while ffmpeg writes it: `<output dir>/.kc-render/<pid>-<seq>-<file>`, a hidden FOLDER because hidden files would still list in the media library. Dropping it removes the file (and the folder once empty), so a failed or interrupted render never touches the previous good output.
struct Staging {
    dir: PathBuf,
    file: PathBuf,
}

impl Staging {
    fn create(out_dir: &Path, file_name: &str) -> Result<Self, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = out_dir.join(STAGING_DIR);
        sweep_stale_stagings(&dir);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let file = dir.join(format!("{}-{seq}-{file_name}", std::process::id()));
        // A concurrent render may remove the empty folder between our mkdir and create; retry.
        let mut last = String::new();
        for _ in 0..3 {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            match std::fs::File::create(&file) {
                Ok(_) => return Ok(Self { dir, file }),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => last = e.to_string(),
                Err(e) => return Err(format!("staging {}: {e}", file.display())),
            }
        }
        Err(format!("staging {}: {last}", file.display()))
    }

    fn publish(&self, target: &Path) -> Result<(), String> {
        std::fs::rename(&self.file, target)
            .map_err(|e| format!("moving the render into place: {e}"))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

fn sweep_stale_stagings(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE_STAGING);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

enum LaneFailure {
    Cancelled,
    Failed(String),
}

/// Run one ffmpeg lane to completion, streaming `-progress` frames; stderr drains on its own thread so a chatty failure can never block the pipe, and `cancel` is checked on every progress line (ffmpeg emits one at least every half second).
fn run_lane(
    ffmpeg: &Path,
    args: &[String],
    total: u32,
    on: &mut dyn FnMut(RenderEvent),
    cancel: &AtomicBool,
) -> Result<(), LaneFailure> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LaneFailure::Failed(format!("failed to start ffmpeg: {e}")))?;
    let stderr = child.stderr.take();
    let drain = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let mut cancelled = false;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let Ok(line) = line else { break };
            if let Some(frame) = parse_progress_frame(&line) {
                on(RenderEvent::Progress {
                    frame: frame.min(total),
                    total,
                });
            }
        }
    }
    cancelled |= cancel.load(Ordering::SeqCst);
    if cancelled {
        let _ = child.kill();
    }
    let status = child.wait();
    let stderr_text = drain.join().unwrap_or_default();
    if cancelled {
        return Err(LaneFailure::Cancelled);
    }
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => {
            let tail = stderr_tail(&stderr_text);
            Err(LaneFailure::Failed(if tail.is_empty() {
                format!("ffmpeg render exited with {:?}", status.code())
            } else {
                tail
            }))
        }
        Err(e) => Err(LaneFailure::Failed(format!("waiting for ffmpeg: {e}"))),
    }
}

/// The last few lines of ffmpeg's error output (`-loglevel error` keeps it to genuine failure text).
fn stderr_tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Flatten an edit: the one render path behind the editor's Render button and `edit render`. Sources resolve inside the project (a missing one fails up front); the hardware lane retries once in software; output is staged and renamed over the target only on success, so the previous good render survives any failure; a canonical render then writes its render record.
pub(crate) fn render_doc(
    job: RenderJob,
    on: &mut dyn FnMut(RenderEvent),
    cancel: &AtomicBool,
) -> Result<RenderOutcome, CoreError> {
    let started = Instant::now();
    let RenderJob {
        project,
        mut doc,
        doc_hash,
        target,
        ffmpeg,
        app_data,
        hardware,
        scale,
        draft,
    } = job;
    if matches!(target, RenderTarget::Canonical(_)) && (draft || scale.is_some()) {
        return Err(CoreError::new(
            "usage",
            "a draft or scaled render cannot replace the edit's output: render it to its own file",
        ));
    }
    let used: std::collections::HashSet<String> =
        doc.clips.iter().map(|c| c.source_id.clone()).collect();
    for source in &mut doc.sources {
        let abs = media::resolve_asset_in(&project, &source.rel)
            .map_err(|e| CoreError::new("invalid", e))?;
        if used.contains(&source.id) && !abs.is_file() {
            return Err(CoreError::new(
                "missing",
                format!("source not found: {}", source.rel),
            ));
        }
        source.abs = abs.to_string_lossy().into_owned();
    }
    if let Some(factor) = scale {
        doc.settings = scaled_settings(&doc.settings, factor);
    }
    let profile = if draft {
        EncodeProfile::Draft
    } else {
        EncodeProfile::Canonical
    };
    let lanes: &[Lane] = if draft || !hardware {
        &[Lane::Software]
    } else {
        &[Lane::Hardware, Lane::Software]
    };
    // Fail on a bad document before anything touches the disk.
    build_render_args_for(&doc, "", false, None, profile)
        .map_err(|e| CoreError::new("invalid", e))?;

    let (final_path, rel) = match &target {
        RenderTarget::Canonical(name) => (
            project.join("assets").join(format!("{name}-edited.mp4")),
            Some(format!("assets/{name}-edited.mp4")),
        ),
        RenderTarget::File(path) => (path.clone(), None),
    };
    let out_dir = final_path
        .parent()
        .ok_or_else(|| CoreError::new("usage", "the output has no folder"))?;
    let file_name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::new("usage", "the output has no file name"))?;
    std::fs::create_dir_all(out_dir)
        .map_err(|e| CoreError::new("invalid", format!("creating {}: {e}", out_dir.display())))?;
    // Resolved once, BEFORE the lane loop: both encode lanes must reference identical frame files.
    let tap_dot_dir = if doc.taps.is_empty() {
        None
    } else {
        Some(ensure_tap_dot_frames_in(&app_data).map_err(|e| CoreError::new("env", e))?)
    };
    let staging = Staging::create(out_dir, file_name).map_err(|e| CoreError::new("invalid", e))?;
    let staged = staging.file.to_string_lossy().into_owned();

    let mut rendered: Option<(Lane, u32)> = None;
    let mut last_error = String::new();
    for (i, &lane) in lanes.iter().enumerate() {
        let (args, total) = build_render_args_for(
            &doc,
            &staged,
            lane == Lane::Hardware,
            tap_dot_dir.as_deref(),
            profile,
        )
        .map_err(|e| CoreError::new("invalid", e))?;
        if i == 0 {
            on(RenderEvent::Start {
                lane,
                total,
                out: final_path.clone(),
            });
        }
        match run_lane(&ffmpeg, &args, total, on, cancel) {
            Ok(()) => {
                on(RenderEvent::Progress {
                    frame: total,
                    total,
                });
                rendered = Some((lane, total));
                break;
            }
            Err(LaneFailure::Cancelled) => {
                return Err(CoreError::new("interrupted", "the render was interrupted"))
            }
            Err(LaneFailure::Failed(error)) => {
                last_error = error;
                if let Some(&next) = lanes.get(i + 1) {
                    on(RenderEvent::Retry {
                        lane: next,
                        error: last_error.clone(),
                    });
                }
            }
        }
    }
    let Some((lane, frames)) = rendered else {
        return Err(CoreError::new("ffmpeg", last_error));
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(CoreError::new("interrupted", "the render was interrupted"));
    }
    staging
        .publish(&final_path)
        .map_err(|e| CoreError::new("ffmpeg", e))?;
    drop(staging);
    // A render is a user action; a re-render replaces the file, so stamp it or the output never resurfaces in the listings.
    workspace::touch_now(&final_path);
    let fps = render_fps(&doc);
    let duration_ms = (f64::from(frames) * 1000.0 / fps).round() as u64;
    let (width, height) = (doc.settings.width, doc.settings.height);
    if let (RenderTarget::Canonical(name), Some(output)) = (&target, &rel) {
        let record = RenderRecord {
            doc_hash: doc_hash.clone(),
            output: output.clone(),
            lane,
            frames,
            duration_ms,
            width,
            height,
            fps,
            at_ms: unix_ms(),
        };
        if let Err(e) = write_render_record(&project, name, &record) {
            eprintln!("[edit] render record for {name} not written: {e}");
        }
    }
    Ok(RenderOutcome {
        rel,
        bytes: std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
        path: final_path,
        lane,
        frames,
        duration_ms,
        elapsed_ms: started.elapsed().as_millis() as u64,
        doc_hash,
        width,
        height,
        fps,
    })
}

/// The edit the editor window is rendering right now, as `(slug, name)`.
#[derive(Default)]
pub struct EditRenderState(Mutex<Option<(String, String)>>);

/// `(slug, name)` of the edit the editor is rendering, if any; the bridge's `openEdit` busy rule reads it.
pub(crate) fn rendering_edit(app: &AppHandle) -> Option<(String, String)> {
    app.try_state::<EditRenderState>()?.0.lock().ok()?.clone()
}

/// Clears the rendering mark however the render ends.
struct RenderingMark(AppHandle);

impl RenderingMark {
    fn set(app: &AppHandle, slug: &str, name: &str) -> Self {
        if let Some(state) = app.try_state::<EditRenderState>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some((slug.to_owned(), name.to_owned()));
            }
        }
        Self(app.clone())
    }
}

impl Drop for RenderingMark {
    fn drop(&mut self) {
        if let Some(state) = self.0.try_state::<EditRenderState>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = None;
            }
        }
    }
}

/// What the editor's Render button gets back: the output and the hash of the document bytes it rendered (unequal to the editor's base = the doc changed during the render).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedEdit {
    pub rel: String,
    pub doc_hash: String,
}

/// Render an edit to `assets/<name>-edited.mp4`. Progress is streamed over `on_progress` (parsed from ffmpeg `-progress`).
#[tauri::command]
pub async fn render_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
    on_progress: Channel<RenderProgress>,
) -> Result<RenderedEdit, String> {
    let project = workspace::project_dir_mut(&app, &settings, &slug)?;
    workspace::validate_slug(&name)?;
    let (doc, _, doc_hash) = load_doc_bytes(&project, &name)?;
    let job = RenderJob {
        project,
        doc,
        doc_hash,
        target: RenderTarget::Canonical(name.clone()),
        ffmpeg: tools::sidecar_path("ffmpeg")?,
        app_data: app.path().app_data_dir().map_err(|e| e.to_string())?,
        // The Settings toggle drops the hardware attempt entirely.
        hardware: workspace::hardware_video_enabled(&app),
        scale: None,
        draft: false,
    };
    let _mark = RenderingMark::set(&app, &slug, &name);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        let mut on = |event: RenderEvent| match event {
            RenderEvent::Progress { frame, total } => {
                let _ = on_progress.send(RenderProgress { frame, total });
            }
            RenderEvent::Retry { error, .. } => {
                eprintln!("[edit] hardware render failed, retrying with software: {error}");
            }
            RenderEvent::Start { .. } => {}
        };
        render_doc(job, &mut on, &cancel)
    })
    .await
    .map_err(|e| format!("render task failed: {e}"))?
    .map_err(String::from)?;
    let rel = outcome.rel.clone().unwrap_or_default();
    // Warm the media-preview cache for the output now: by the time the editor closes and the library refreshes, poster/scrub frames already exist, no stale card, no pop-in; failure is non-fatal (the library regenerates on view).
    if let Err(e) = media::ensure_media_cache(&app, &outcome.path, &rel).await {
        eprintln!("[edit] preview warm-up failed for {rel}: {e}");
    }
    Ok(RenderedEdit {
        rel,
        doc_hash: outcome.doc_hash,
    })
}

/// One validation finding, tied to the clip, tap or mask it is about.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Issue {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
}

impl Issue {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            clip: None,
            tap: None,
            mask: None,
        }
    }
    fn clip(mut self, id: &str) -> Self {
        self.clip = Some(id.to_owned());
        self
    }
    fn tap(mut self, id: &str) -> Self {
        self.tap = Some(id.to_owned());
        self
    }
    fn mask(mut self, id: &str) -> Self {
        self.mask = Some(id.to_owned());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipReport {
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub start_frame: u32,
    pub frames: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TapWindow {
    pub start_ms: f64,
    pub end_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TapReport {
    pub id: String,
    pub windows: Vec<TapWindow>,
}

/// What `edit validate` reports: the render's frame plan plus every reason the render would fail (errors) or surprise (warnings).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Validation {
    pub ok: bool,
    pub version: u32,
    pub total_frames: u32,
    pub duration_ms: f64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub clips: Vec<ClipReport>,
    pub taps: Vec<TapReport>,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

/// `Math.round` (half up), as editMath.ts lays clips out.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Check a document against everything the render and the editor rely on, without running ffmpeg: names, sources on disk, spans, speeds, masks, then a dry run of the real argument builder.
pub(crate) fn validate_doc(project: &Path, doc: &EditDoc, expect_name: Option<&str>) -> Validation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let fps = render_fps(doc);
    if let Some(name) = expect_name {
        if doc.name != name {
            errors.push(Issue::new(
                "name",
                format!(
                    "the document is named {:?} but lives at {}",
                    doc.name,
                    edit_rel(name)
                ),
            ));
        }
    }
    if doc.clips.is_empty() {
        errors.push(Issue::new("no-clips", "this edit has no clips to render"));
    }
    let used: std::collections::HashSet<&str> =
        doc.clips.iter().map(|c| c.source_id.as_str()).collect();
    for source in &doc.sources {
        match media::resolve_asset_in(project, &source.rel) {
            Err(e) => errors.push(Issue::new(
                "bad-source",
                format!("source {}: {e}", source.id),
            )),
            Ok(abs) if !abs.is_file() => {
                let issue = Issue::new(
                    "source-missing",
                    format!("source {} is missing: {}", source.id, source.rel),
                );
                if used.contains(source.id.as_str()) {
                    errors.push(issue);
                } else {
                    warnings.push(issue);
                }
            }
            Ok(_) => {}
        }
    }
    let mut cursor = 0.0;
    for clip in &doc.clips {
        let Some(source) = doc.sources.iter().find(|s| s.id == clip.source_id) else {
            errors.push(
                Issue::new(
                    "unknown-source",
                    format!("clip {} uses unknown source {}", clip.id, clip.source_id),
                )
                .clip(&clip.id),
            );
            continue;
        };
        let image = source.kind == EditSourceKind::Image;
        if !clip.speed.is_finite() || clip.speed <= 0.0 {
            errors.push(
                Issue::new(
                    "bad-speed",
                    format!(
                        "clip {} has speed {}: use a positive speed",
                        clip.id, clip.speed
                    ),
                )
                .clip(&clip.id),
            );
        }
        if clip.in_ms > clip.out_ms {
            errors.push(
                Issue::new(
                    "bad-span",
                    format!("clip {} starts after it ends (inMs > outMs)", clip.id),
                )
                .clip(&clip.id),
            );
        }
        if !image {
            let source_fps = if source.fps > 0.0 { source.fps } else { fps };
            let limit = source.duration_ms as f64 + 1000.0 / source_fps;
            if clip.out_ms as f64 > limit || clip.in_ms as f64 > limit {
                errors.push(
                    Issue::new(
                        "past-source",
                        format!(
                            "clip {} reaches {} ms of a {} ms source",
                            clip.id,
                            clip.out_ms.max(clip.in_ms),
                            source.duration_ms
                        ),
                    )
                    .clip(&clip.id),
                );
            }
        }
        match clip.hold_ms {
            Some(hold) if hold < MIN_HOLD_MS => warnings.push(
                Issue::new(
                    "short-hold",
                    format!("clip {} holds for only {hold} ms", clip.id),
                )
                .clip(&clip.id),
            ),
            None if !image && clip.out_ms.saturating_sub(clip.in_ms) < MIN_CLIP_SOURCE_MS => {
                warnings.push(
                    Issue::new(
                        "short-clip",
                        format!(
                            "clip {} spans only {} ms of source",
                            clip.id,
                            clip.out_ms.saturating_sub(clip.in_ms)
                        ),
                    )
                    .clip(&clip.id),
                )
            }
            _ => {}
        }
        if clip.start_ms as f64 != js_round(cursor) {
            warnings.push(
                Issue::new(
                    "not-laid-out",
                    format!(
                        "clip {} has startMs {} but the timeline places it at {}",
                        clip.id,
                        clip.start_ms,
                        js_round(cursor)
                    ),
                )
                .clip(&clip.id),
            );
        }
        cursor += clip_timeline_ms(clip, image);
    }

    let plan = clip_frame_plan(doc).unwrap_or_default();
    let clips: Vec<ClipReport> = plan
        .iter()
        .map(|p| ClipReport {
            id: p.clip.id.clone(),
            start_ms: p.start_ms,
            end_ms: p.end_ms,
            start_frame: p.start_frame,
            frames: p.frames,
        })
        .collect();
    let total_frames = plan.iter().map(|p| p.frames).sum();
    let duration_ms = plan.last().map_or(0.0, |p| p.end_ms);

    let styles = crate::tap_dot_frames::TAP_DOT_STYLES;
    let colors = crate::tap_dot_frames::TAP_DOT_COLORS;
    if let Some(style) = doc.tap_style.as_deref() {
        if !styles.iter().any(|(id, _)| *id == style) {
            warnings.push(Issue::new(
                "tap-style",
                format!("unknown tap style {style:?}: renders as {}", styles[0].0),
            ));
        }
    }
    if let Some(color) = doc.tap_color.as_deref() {
        if !colors.iter().any(|(id, _)| *id == color) {
            warnings.push(Issue::new(
                "tap-color",
                format!("unknown tap colour {color:?}: renders as {}", colors[0].0),
            ));
        }
    }
    if let Some(size) = doc.tap_size {
        if !(0.25..=4.0).contains(&size) {
            warnings.push(Issue::new(
                "tap-size",
                format!("tapSize {size} is clamped to 0.25..4"),
            ));
        }
    }
    let sorted: Vec<&EditClip> = plan.iter().map(|p| p.clip).collect();
    let mut taps = Vec::new();
    for tap in &doc.taps {
        let windows: Vec<TapWindow> = tap_windows(&sorted, std::slice::from_ref(tap))
            .into_iter()
            .map(|(_, _, start_ms, end_ms)| TapWindow { start_ms, end_ms })
            .collect();
        if windows.is_empty() {
            warnings.push(
                Issue::new(
                    "tap-hidden",
                    format!(
                        "tap {} at {} {} ms is in no clip, so it never shows",
                        tap.id, tap.source_id, tap.source_ms
                    ),
                )
                .tap(&tap.id),
            );
        }
        if !tap.pos.iter().all(|v| (0.0..=1.0).contains(v)) {
            warnings.push(
                Issue::new(
                    "tap-pos",
                    format!("tap {} sits outside the frame and is clamped", tap.id),
                )
                .tap(&tap.id),
            );
        }
        taps.push(TapReport {
            id: tap.id.clone(),
            windows,
        });
    }
    for mask in &doc.masks {
        if let Err(e) = edit_masks::validate_mask(doc, mask) {
            errors.push(Issue::new("bad-mask", e).mask(&mask.id));
        }
        if !used.contains(mask.source_id.as_str()) {
            warnings.push(
                Issue::new(
                    "mask-unused-source",
                    format!(
                        "mask {} covers source {}, which no clip uses",
                        mask.id, mask.source_id
                    ),
                )
                .mask(&mask.id),
            );
        }
    }
    if errors.is_empty() {
        let placeholder = Path::new("/kc-validate/tapdot");
        if let Err(e) = build_render_args(doc, "/kc-validate/out.mp4", false, Some(placeholder)) {
            errors.push(Issue::new("render", e));
        }
    }
    Validation {
        ok: errors.is_empty(),
        version: doc_version(doc),
        total_frames,
        duration_ms,
        fps,
        width: doc.settings.width,
        height: doc.settings.height,
        clips,
        taps,
        errors,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> EditDoc {
        EditDoc {
            version: 1,
            name: "cut".into(),
            sources: vec![EditSource {
                id: "s1".into(),
                rel: "assets/a.mp4".into(),
                kind: EditSourceKind::Video,
                width: 1920,
                height: 1080,
                fps: 60.0,
                duration_ms: 10_000,
                abs: "/abs/a.mp4".into(),
            }],
            settings: EditSettings {
                width: 1920,
                height: 1080,
                fps: 60.0,
            },
            clips: vec![EditClip {
                id: "c1".into(),
                source_id: "s1".into(),
                in_ms: 0,
                out_ms: 1000,
                speed: 1.0,
                start_ms: 0,
                hold_ms: None,
            }],
            taps: Vec::new(),
            tap_style: None,
            tap_color: None,
            tap_size: None,
            masks: Vec::new(),
            reference: None,
        }
    }

    #[test]
    fn hardware_lane_hwaccels_each_input_and_encodes_by_bitrate() {
        let (args, _) = build_render_args(&doc(), "/out/x.mp4", true, None).unwrap();
        for (i, a) in args.iter().enumerate() {
            if a == "-i" {
                assert_eq!(args[i - 2], "-hwaccel");
                assert_eq!(args[i - 1], "videotoolbox");
            }
        }
        assert!(args.windows(2).any(|w| w == ["-c:v", "h264_videotoolbox"]));
        assert!(args.windows(2).any(|w| w == ["-b:v", "31104k"]));
        assert!(!args.contains(&"-crf".to_string()));
        assert!(!args.contains(&"-preset".to_string()));
    }

    #[test]
    fn software_lane_normalises_the_source_and_cuts_exact_frames() {
        let (args, total) = build_render_args(&doc(), "/out/x.mp4", false, None).unwrap();
        assert_eq!(total, 60);
        let expected: Vec<String> = [
            "-y",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-i",
            "/abs/a.mp4",
            "-filter_complex",
            "[0:v]fps=60:start_time=0[src0_0];[src0_0]trim=start=0.000000:end=1.000000,setpts=(PTS-STARTPTS)/1,tpad=stop_mode=clone:stop=60,fps=60,trim=end_frame=60,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];[v0]concat=n=1:v=1:a=0[outv]",
            "-map",
            "[outv]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            "/out/x.mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn freeze_clips_clone_one_frame_and_count_hold_frames() {
        let mut d = doc();
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 500,
            out_ms: 500,
            speed: 1.0,
            start_ms: 1000,
            hold_ms: Some(2000),
        });
        let (args, total) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        assert_eq!(total, 60 + 120); // 1s of source + 2s hold at 60fps
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("[0:v]fps=60:start_time=0,split=2[src0_0][src0_1];"));
        assert!(filter.contains(
            "[src0_1]trim=start=0.500000:duration=0.5,select=eq(n\\,0),setpts=PTS-STARTPTS,\
             tpad=stop_mode=clone:stop=120,fps=60,trim=end_frame=120,setpts=PTS-STARTPTS,"
        ));
        assert!(filter.contains("concat=n=2"));
    }

    #[test]
    fn clips_are_cut_on_the_cumulative_frame_grid() {
        // Two 508.5 ms halves round to 31 frames each on their own but to 61 together: the grid hands out 31 + 30, so the cut lands on the timeline instead of half a frame past it.
        let mut d = doc();
        d.clips[0].out_ms = 1017;
        d.clips[0].speed = 2.0;
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 2000,
            out_ms: 3017,
            speed: 2.0,
            start_ms: 509,
            hold_ms: None,
        });
        let (args, total) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        assert_eq!(total, 61);
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("[0:v]fps=60:start_time=0,split=2[src0_0][src0_1];"));
        assert!(filter.contains(
            "[src0_0]trim=start=0.000000:end=1.017000,setpts=(PTS-STARTPTS)/2,\
             tpad=stop_mode=clone:stop=31,fps=60,trim=end_frame=31,"
        ));
        assert!(filter.contains(
            "[src0_1]trim=start=2.000000:end=3.017000,setpts=(PTS-STARTPTS)/2,\
             tpad=stop_mode=clone:stop=30,fps=60,trim=end_frame=30,"
        ));
    }

    #[test]
    fn a_variable_frame_rate_source_seeds_a_sixty_fps_edit() {
        let probe = |fps: f64, vfr: bool| media::ProbeInfo {
            kind: "video".into(),
            width: 1206,
            height: 2622,
            fps,
            duration_ms: 264_472,
            vfr,
            ..Default::default()
        };
        assert_eq!(edit_fps(&probe(15.196, true)), 60.0);
        assert_eq!(edit_fps(&probe(30.0, false)), 30.0);
        assert_eq!(edit_fps(&probe(0.0, false)), 60.0);
    }

    /// An image source added to `doc()`, plus a clip holding it for `hold_ms`.
    fn with_image(hold_ms: u64) -> EditDoc {
        let mut d = doc();
        d.sources.push(EditSource {
            id: "s2".into(),
            rel: "assets/shot.png".into(),
            kind: EditSourceKind::Image,
            width: 1080,
            height: 1920,
            fps: 0.0,
            duration_ms: 0,
            abs: "/abs/shot.png".into(),
        });
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s2".into(),
            in_ms: 0,
            out_ms: 0,
            speed: 1.0,
            start_ms: 1000,
            hold_ms: Some(hold_ms),
        });
        d
    }

    #[test]
    fn image_clips_loop_the_still_for_their_hold_and_concat_with_video() {
        let (args, total) =
            build_render_args(&with_image(2000), "/out/x.mp4", false, None).unwrap();
        assert_eq!(total, 60 + 120); // 1s of source + a 2s still at 60fps
        let i = args.iter().position(|a| a == "-loop").unwrap();
        assert_eq!(
            args[i..i + 8],
            [
                "-loop",
                "1",
                "-framerate",
                "60",
                "-t",
                "2.000000",
                "-i",
                "/abs/shot.png"
            ]
            .map(String::from)
        );
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains(
            "[1:v]tpad=stop_mode=clone:stop=120,fps=60,trim=end_frame=120,setpts=PTS-STARTPTS,"
        ));
        // A still has no span, so nothing picks a frame out of it.
        assert!(!filter.contains("select=eq(n\\,0)"));
        assert!(filter.contains("concat=n=2"));
    }

    #[test]
    fn a_reused_still_takes_one_looped_input_per_clip_and_never_hardware_decodes() {
        let mut d = with_image(2000);
        d.clips.push(EditClip {
            id: "c3".into(),
            source_id: "s2".into(),
            in_ms: 0,
            out_ms: 0,
            speed: 1.0,
            start_ms: 3000,
            hold_ms: Some(5000),
        });
        let (args, total) = build_render_args(&d, "/out/x.mp4", true, None).unwrap();
        assert_eq!(total, 60 + 120 + 300);
        // One looped input per still clip, each cut to its own hold: no split queues duplicated frames.
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 3);
        let holds: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "-t")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(holds, ["2.000000", "5.000000"]);
        // Hardware decode rides the video input only.
        assert_eq!(args.iter().filter(|a| *a == "-hwaccel").count(), 1);
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("[1:v]tpad=stop_mode=clone:stop=120,fps=60,trim=end_frame=120"));
        assert!(filter.contains("[2:v]tpad=stop_mode=clone:stop=300,fps=60,trim=end_frame=300"));
        assert!(filter.contains("concat=n=3"));
    }

    #[test]
    fn an_image_source_without_a_kind_loads_as_a_video() {
        let doc: EditDoc = serde_json::from_str(
            r#"{"version":1,"name":"cut","sources":[{"id":"s1","rel":"assets/a.mp4","width":1920,
             "height":1080,"fps":60,"durationMs":1000}],"settings":{"width":1920,"height":1080,
             "fps":60},"clips":[{"id":"c1","sourceId":"s1","inMs":0,"outMs":1000,"speed":1,
             "startMs":0}]}"#,
        )
        .unwrap();
        assert_eq!(doc.sources[0].kind, EditSourceKind::Video);
    }

    #[test]
    fn tap_overlay_adds_one_input_and_enable_window_per_visible_tap() {
        let mut d = doc();
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 500,
            pos: [0.25, 0.75],
        });
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        let its = args.iter().position(|a| a == "-itsoffset").unwrap();
        assert_eq!(
            args[its..its + 6],
            [
                "-itsoffset",
                "0.500000",
                "-framerate",
                "60",
                "-i",
                "/cache/tapdot/target/tapdot_%02d.png"
            ]
            .map(String::from)
        );
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        // 109 = round(1080 * 0.07 * 1.15 * 1.25); the window clamps at the 1s clip end.
        assert!(filter.contains(
            ";[1:v]format=rgba,colorchannelmixer=rr=0.250980:gg=0.611765:bb=1.000000,\
             scale=109:109:flags=lanczos[dot0];"
        ));
        assert!(filter.contains("[outv][dot0]overlay=x=480.000-overlay_w/2:y=810.000-overlay_h/2:"));
        assert!(filter.contains("eof_action=pass:enable='between(t\\,0.500000\\,1.000000)'[tapv0]"));
        assert!(args.windows(2).any(|w| w == ["-map", "[tapv0]"]));
    }

    #[test]
    fn tap_overlay_on_a_padded_clip_uses_ffmpeg_rounded_geometry() {
        // A portrait source in the landscape canvas: ffmpeg scales it to 608x1080 (av_rescale
        // rounds 607.5 up) with a 656px pad offset; the overlay centre must match that geometry.
        let mut d = doc();
        d.sources.push(EditSource {
            id: "s2".into(),
            rel: "assets/b.mp4".into(),
            kind: EditSourceKind::Video,
            width: 1080,
            height: 1920,
            fps: 60.0,
            duration_ms: 10_000,
            abs: "/abs/b.mp4".into(),
        });
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s2".into(),
            in_ms: 0,
            out_ms: 1000,
            speed: 1.0,
            start_ms: 1000,
            hold_ms: None,
        });
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s2".into(),
            source_ms: 500,
            pos: [0.25, 0.75],
        });
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        // x = 656 + 0.25 * 608, y = 0 + 0.75 * 1080.
        assert!(filter.contains("[outv][dot0]overlay=x=808.000-overlay_w/2:y=810.000-overlay_h/2:"));
    }

    #[test]
    fn tap_style_picks_its_dir_and_colour_tints_the_frames() {
        let mut d = doc();
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 500,
            pos: [0.5, 0.5],
        });
        d.tap_style = Some("target".into());
        d.tap_color = Some("terracotta".into());
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        assert!(args.contains(&"/cache/tapdot/target/tapdot_%02d.png".to_string()));
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("colorchannelmixer=rr=0.886275:gg=0.447059:bb=0.356863"));
        // Unknown ids fall back to the defaults (target, blue).
        d.tap_style = Some("not-a-style".into());
        d.tap_color = Some("not-a-colour".into());
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        assert!(args.contains(&"/cache/tapdot/target/tapdot_%02d.png".to_string()));
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("colorchannelmixer=rr=0.250980:gg=0.611765:bb=1.000000"));
    }

    #[test]
    fn tap_size_scales_the_overlay() {
        let mut d = doc();
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 500,
            pos: [0.5, 0.5],
        });
        d.tap_size = Some(2.0);
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        // 174 = round(1080 * 0.07 * 1.15 * 2)
        assert!(filter.contains("scale=174:174"));
    }

    #[test]
    fn taps_off_every_clip_or_without_a_dot_dir_change_nothing() {
        let mut d = doc();
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 5000, // outside the clip's [0, 1000) span
            pos: [0.5, 0.5],
        });
        let (with_dir, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        let (baseline, _) = build_render_args(&doc(), "/out/x.mp4", false, None).unwrap();
        assert_eq!(with_dir, baseline);
    }

    fn solid_mask() -> EditMask {
        EditMask {
            id: "m1".into(),
            source_id: "s1".into(),
            style: EditMaskStyle::Solid,
            strength: None,
            color: None,
            start_ms: 0,
            end_ms: 1000,
            keys: vec![EditMaskKey {
                source_ms: 0,
                rect: [0.1, 0.2, 0.3, 0.4],
            }],
        }
    }

    #[test]
    fn an_unmasked_doc_stays_version_one_and_writes_no_masks_key() {
        let text = serde_json::to_string(&doc()).unwrap();
        assert!(!text.contains("masks"));
        assert_eq!(doc_version(&doc()), 1);
        assert_eq!(parse_doc(&text).unwrap().version, 1);
    }

    #[test]
    fn a_masked_doc_is_written_as_version_two_and_drops_back_without_masks() {
        let dir = std::env::temp_dir().join(format!("kc-edit-version-{}", std::process::id()));
        let path = dir.join("edits/cut.json");
        let mut d = doc();
        d.masks.push(solid_mask());
        write_doc_checked(&dir, "cut", &d, None).unwrap();
        let read = read_doc(&path).unwrap();
        assert_eq!(read.version, 2);
        assert_eq!(read.masks.len(), 1);
        assert_eq!(read.masks[0].style, EditMaskStyle::Solid);
        d.masks.clear();
        write_doc_checked(&dir, "cut", &d, None).unwrap();
        assert_eq!(read_doc(&path).unwrap().version, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_doc_accepts_version_two_and_refuses_three() {
        let mut d = doc();
        d.masks.push(solid_mask());
        d.version = 2;
        assert!(parse_doc(&serde_json::to_string(&d).unwrap()).is_ok());
        d.version = 3;
        let err = parse_doc(&serde_json::to_string(&d).unwrap()).unwrap_err();
        assert!(err.contains("needs a newer Kookaburra Cut"));
    }

    fn filter_of(args: &[String]) -> &str {
        &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1]
    }

    #[test]
    fn a_masked_source_is_covered_before_the_split_so_freezes_inherit_it() {
        let mut d = doc();
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 500,
            out_ms: 500,
            speed: 1.0,
            start_ms: 1000,
            hold_ms: Some(2000),
        });
        d.masks.push(solid_mask());
        let (args, _) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        let filter = filter_of(&args);
        assert!(filter.starts_with("[0:v]fps=60:start_time=0[n0];[n0]drawbox="));
        assert!(filter.contains("[m0];[m0]split=2[src0_0][src0_1];"));
        assert!(filter.contains("[src0_1]trim=start=0.500000:duration=0.5,select=eq(n\\,0)"));
    }

    #[test]
    fn a_single_use_masked_source_ends_its_chain_on_the_clip_label() {
        let mut d = doc();
        d.masks.push(solid_mask());
        let (args, _) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        let filter = filter_of(&args);
        assert!(filter.contains(":t=fill:enable='gte(t\\,-0.016667)*lt(t\\,1.016667)'[src0_0];"));
        assert!(!filter.contains("split"));
    }

    #[test]
    fn every_clip_of_a_masked_still_is_chained() {
        let mut d = with_image(2000);
        d.clips.push(EditClip {
            id: "c3".into(),
            source_id: "s2".into(),
            in_ms: 0,
            out_ms: 0,
            speed: 1.0,
            start_ms: 3000,
            hold_ms: Some(1000),
        });
        let mut m = solid_mask();
        m.source_id = "s2".into();
        d.masks.push(m);
        let (args, _) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        let filter = filter_of(&args);
        assert!(filter.contains("[1:v]format=yuv444p[i1444];[i1444]drawbox="));
        assert!(filter.contains("[im1]tpad=stop_mode=clone:stop=120,"));
        assert!(filter.contains("[2:v]format=yuv444p[i2444];[i2444]drawbox="));
        assert!(filter.contains("[im2]tpad=stop_mode=clone:stop=60,"));
        // The video source carries no mask and keeps its plain normalisation.
        assert!(filter.starts_with("[0:v]fps=60:start_time=0[src0_0];"));
    }

    #[test]
    fn a_mask_on_a_source_no_clip_uses_changes_nothing() {
        let mut d = doc();
        d.sources.push(EditSource {
            id: "s2".into(),
            rel: "assets/b.mp4".into(),
            kind: EditSourceKind::Video,
            width: 1920,
            height: 1080,
            fps: 60.0,
            duration_ms: 10_000,
            abs: "/abs/b.mp4".into(),
        });
        let mut m = solid_mask();
        m.source_id = "s2".into();
        d.masks.push(m);
        let (masked, _) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        let (baseline, _) = build_render_args(&doc(), "/out/x.mp4", false, None).unwrap();
        assert_eq!(masked, baseline);
    }

    #[test]
    fn both_encode_lanes_bake_the_same_masks() {
        let mut d = doc();
        d.masks.push(solid_mask());
        let (hw, _) = build_render_args(&d, "/out/x.mp4", true, None).unwrap();
        let (sw, _) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        assert_eq!(filter_of(&hw), filter_of(&sw));
    }

    #[test]
    fn a_mask_that_cannot_render_exactly_fails_the_render() {
        let mut d = doc();
        let mut m = solid_mask();
        m.color = Some("#00000g".into());
        d.masks.push(m);
        assert!(build_render_args(&d, "/out/x.mp4", false, None).is_err());
        d.masks[0].color = None;
        d.masks[0].keys.clear();
        assert!(build_render_args(&d, "/out/x.mp4", false, None).is_err());
    }

    fn temp_project(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-edit-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn doc_bytes_are_the_old_write_doc_bytes_with_the_version_stamped() {
        let legacy = |doc: &EditDoc| {
            let mut stamped = doc.clone();
            stamped.version = doc_version(doc);
            serde_json::to_string_pretty(&stamped).unwrap() + "\n"
        };
        let mut d = doc();
        d.version = 7;
        let bytes = doc_bytes(&d).unwrap();
        assert_eq!(bytes, legacy(&d).into_bytes());
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            text.starts_with("{\n  \"version\": 1,\n  \"name\": \"cut\",\n"),
            "{text}"
        );
        assert!(text.ends_with("}\n") && !text.ends_with("\n\n"));
        d.masks.push(solid_mask());
        assert_eq!(doc_bytes(&d).unwrap(), legacy(&d).into_bytes());
        assert!(String::from_utf8(doc_bytes(&d).unwrap())
            .unwrap()
            .contains("\"version\": 2"));
        let dir = temp_project("bytes");
        let landed = write_doc_checked(&dir, "cut", &d, None).unwrap();
        let on_disk = std::fs::read(dir.join("edits/cut.json")).unwrap();
        assert_eq!(on_disk, doc_bytes(&d).unwrap());
        assert_eq!(landed.hash, live_edits::content_hash(&on_disk));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_writes_refuse_a_stale_base_and_create_only_when_absent() {
        let dir = temp_project("base");
        let d = doc();
        let first = write_doc_checked(&dir, "cut", &d, Some(live_edits::ABSENT_BASE)).unwrap();
        assert_eq!(first.before, None);
        let again = write_doc_checked(&dir, "cut", &d, Some(live_edits::ABSENT_BASE))
            .err()
            .unwrap();
        assert_eq!(again, "conflict: edits/cut.json changed outside the editor");
        let mut changed = d.clone();
        changed.clips[0].out_ms = 900;
        let second = write_doc_checked(&dir, "cut", &changed, Some(&first.hash)).unwrap();
        assert_eq!(second.before, Some(first.stamp.clone()));
        let stale = write_doc_checked(&dir, "cut", &d, Some(&first.hash))
            .err()
            .unwrap();
        assert!(stale.starts_with(live_edits::CONFLICT_PREFIX), "{stale}");
        assert_eq!(
            read_doc(&edit_path(&dir, "cut")).unwrap().clips[0].out_ms,
            900
        );
        // No base is the legacy unconditional autosave.
        write_doc_checked(&dir, "cut", &d, None).unwrap();
        assert_eq!(
            read_doc(&edit_path(&dir, "cut")).unwrap().clips[0].out_ms,
            1000
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_whose_doc_names_another_edit_is_refused() {
        assert!(check_doc_name(&doc(), "cut").is_ok());
        let err = check_doc_name(&doc(), "other").unwrap_err();
        assert!(err.contains("edits/other.json"), "{err}");
    }

    #[test]
    fn strict_parsing_codes_corrupt_and_newer_documents() {
        let mut d = doc();
        let text = serde_json::to_string(&d).unwrap();
        assert!(parse_doc_coded(&text).is_ok());
        let fractional = text.replace("\"outMs\":1000", "\"outMs\":1000.5");
        assert_eq!(parse_doc_coded(&fractional).unwrap_err().code, "corrupt");
        let negative = text.replace("\"inMs\":0", "\"inMs\":-1");
        assert_eq!(parse_doc_coded(&negative).unwrap_err().code, "corrupt");
        d.version = 3;
        let newer = serde_json::to_string(&d).unwrap();
        assert_eq!(parse_doc_coded(&newer).unwrap_err().code, "version");
    }

    #[test]
    fn entries_and_stamps_describe_the_bytes_on_disk() {
        let dir = temp_project("entry");
        let landed = write_doc_checked(&dir, "cut", &doc(), None).unwrap();
        let entry = read_edit_entry(&dir, "cut").unwrap();
        assert_eq!(entry.hash, landed.hash);
        assert_eq!(entry.stamp, landed.stamp);
        assert!(entry.render.is_none());
        let stamps = stamps_of(&dir, "cut");
        assert_eq!(stamps.doc, Some(landed.stamp));
        assert_eq!(stamps.render, None);
        assert_eq!(
            stamps_of(&dir, "nope"),
            EditStamps {
                doc: None,
                render: None
            }
        );
        assert!(read_edit_entry(&dir, "nope").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_edit_names_slugify_the_source_stem() {
        let name = |p: &str| default_edit_name(Path::new(p));
        assert_eq!(
            name("/p/assets/Screen Recording 2026-10-16 at 9.41.mov"),
            "screen-recording-2026-10-16-at-9-41"
        );
        assert_eq!(name("/p/assets/Demo.MP4"), "demo");
        assert_eq!(name("/p/assets/___.mp4"), "edit");
    }

    #[test]
    fn the_frame_plan_is_the_cumulative_grid_the_render_cuts() {
        let mut d = doc();
        d.clips[0].out_ms = 1017;
        d.clips[0].speed = 2.0;
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 2000,
            out_ms: 3017,
            speed: 2.0,
            start_ms: 509,
            hold_ms: None,
        });
        let plan = clip_frame_plan(&d).unwrap();
        let slots: Vec<(u32, u32)> = plan.iter().map(|p| (p.start_frame, p.frames)).collect();
        assert_eq!(slots, [(0, 31), (31, 30)]);
        assert_eq!((plan[1].start_ms, plan[1].end_ms), (508.5, 1017.0));
        // Render order follows startMs, not array order.
        d.clips.swap(0, 1);
        assert_eq!(clip_frame_plan(&d).unwrap()[0].clip.id, "c1");
        d.clips[0].source_id = "s9".into();
        assert!(clip_frame_plan(&d).is_err());
    }

    #[test]
    fn a_scaled_draft_keeps_the_frame_count_on_even_dimensions() {
        let mut d = doc();
        d.settings.width = 1179;
        d.settings.height = 2556;
        let scaled = scaled_settings(&d.settings, 0.5);
        assert_eq!((scaled.width, scaled.height, scaled.fps), (590, 1278, 60.0));
        let third = scaled_settings(&d.settings, 0.33);
        assert_eq!((third.width % 2, third.height % 2), (0, 0));
        let tiny = scaled_settings(
            &EditSettings {
                width: 3,
                height: 3,
                fps: 30.0,
            },
            0.1,
        );
        assert_eq!((tiny.width, tiny.height), (2, 2));
        let (canonical, total) = build_render_args(&d, "/out/x.mp4", false, None).unwrap();
        let mut small = d.clone();
        small.settings = scaled;
        let (draft, draft_total) =
            build_render_args_for(&small, "/out/x.mp4", true, None, EncodeProfile::Draft).unwrap();
        assert_eq!(draft_total, total);
        assert!(draft.windows(8).any(|w| w
            == [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "26",
                "-g",
                "30"
            ]));
        assert!(!draft.contains(&"-hwaccel".to_string()));
        assert!(filter_of(&draft).contains("scale=590:1278:force_original_aspect_ratio=decrease"));
        assert!(canonical.windows(2).any(|w| w == ["-preset", "veryfast"]));
    }

    #[test]
    fn progress_lines_yield_their_frame() {
        assert_eq!(parse_progress_frame("frame=42"), Some(42));
        assert_eq!(parse_progress_frame("  frame= 7 \n"), Some(7));
        assert_eq!(parse_progress_frame("fps=60.00"), None);
        assert_eq!(parse_progress_frame("frame=N/A"), None);
        assert_eq!(parse_progress_frame("progress=end"), None);
    }

    #[test]
    fn tap_frames_materialise_once_and_replace_an_older_version() {
        let dir = temp_project("tapdot");
        let app_data = dir.join("appdata");
        let tapdot = app_data.join("cache/tapdot");
        std::fs::create_dir_all(tapdot.join("target")).unwrap();
        std::fs::write(tapdot.join("target/tapdot_00.png"), b"old").unwrap();
        std::fs::write(tapdot.join(".done-v2"), b"").unwrap();
        assert_eq!(ensure_tap_dot_frames_in(&app_data).unwrap(), tapdot);
        let (style, frames) = crate::tap_dot_frames::TAP_DOT_STYLES[0];
        assert_eq!(
            std::fs::read(tapdot.join(style).join("tapdot_00.png")).unwrap(),
            frames[0]
        );
        assert!(tapdot.join(".done-v3").is_file());
        assert!(!tapdot.join(".done-v2").exists());
        assert_eq!(ensure_tap_dot_frames_in(&app_data).unwrap(), tapdot);
        let fresh = dir.join("fresh");
        let racers: Vec<_> = (0..4)
            .map(|_| {
                let fresh = fresh.clone();
                std::thread::spawn(move || ensure_tap_dot_frames_in(&fresh))
            })
            .collect();
        for racer in racers {
            racer.join().unwrap().unwrap();
        }
        for cache in [app_data.join("cache"), fresh.join("cache")] {
            let staged = std::fs::read_dir(cache)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(".staging"))
                .count();
            assert_eq!(staged, 0);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn fake_ffmpeg(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-ffmpeg");
        std::fs::write(&path, format!("#!/bin/sh\nfor out; do :; done\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A project holding `edits/cut.json` (the 60-frame `doc()`), a placeholder source and an old good render.
    fn render_project(tag: &str) -> PathBuf {
        let dir = temp_project(tag);
        std::fs::write(dir.join("assets/a.mp4"), b"source").unwrap();
        std::fs::write(dir.join("assets/cut-edited.mp4"), b"OLD").unwrap();
        write_doc_checked(&dir, "cut", &doc(), None).unwrap();
        dir
    }

    fn canonical_job(dir: &Path, ffmpeg: PathBuf, hardware: bool) -> RenderJob {
        let (doc, _, doc_hash) = load_doc_bytes(dir, "cut").unwrap();
        RenderJob {
            project: dir.to_path_buf(),
            doc,
            doc_hash,
            target: RenderTarget::Canonical("cut".into()),
            ffmpeg,
            app_data: dir.join("appdata"),
            hardware,
            scale: None,
            draft: false,
        }
    }

    #[test]
    fn a_failed_hardware_lane_retries_in_software_and_lands_with_a_record() {
        let dir = render_project("retry");
        let ffmpeg = fake_ffmpeg(
            &dir,
            "case \"$*\" in *h264_videotoolbox*) echo 'VideoToolbox said no' >&2; exit 1;; esac\n\
             echo frame=12\necho progress=continue\nprintf NEW > \"$out\"",
        );
        let mut events = Vec::new();
        let outcome = render_doc(
            canonical_job(&dir, ffmpeg, true),
            &mut |e| events.push(e),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(outcome.lane, Lane::Software);
        assert_eq!(outcome.rel.as_deref(), Some("assets/cut-edited.mp4"));
        assert_eq!(outcome.path, dir.join("assets/cut-edited.mp4"));
        assert_eq!(
            (outcome.frames, outcome.duration_ms, outcome.bytes),
            (60, 1000, 3)
        );
        assert_eq!(std::fs::read(&outcome.path).unwrap(), b"NEW");
        assert!(matches!(
            &events[0],
            RenderEvent::Start { lane: Lane::Hardware, total: 60, out } if out == &outcome.path
        ));
        assert!(events.iter().any(|e| matches!(
            e,
            RenderEvent::Retry { lane: Lane::Software, error } if error.contains("VideoToolbox said no")
        )));
        assert!(events.contains(&RenderEvent::Progress {
            frame: 12,
            total: 60
        }));
        assert_eq!(
            events.last(),
            Some(&RenderEvent::Progress {
                frame: 60,
                total: 60
            })
        );
        let record = read_render_record(&dir, "cut").unwrap();
        assert_eq!(record.doc_hash, outcome.doc_hash);
        assert_eq!(
            (record.lane, record.frames, record.output.as_str()),
            (Lane::Software, 60, "assets/cut-edited.mp4")
        );
        assert_eq!(
            read_edit_entry(&dir, "cut")
                .unwrap()
                .render
                .unwrap()
                .doc_hash,
            outcome.doc_hash
        );
        assert!(!dir.join("assets/.kc-render").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_render_keeps_the_previous_output_and_leaves_no_staging() {
        let dir = render_project("fail");
        let ffmpeg = fake_ffmpeg(
            &dir,
            "printf PARTIAL > \"$out\"\necho 'Conversion failed!' >&2\nexit 1",
        );
        let err = render_doc(
            canonical_job(&dir, ffmpeg, true),
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, "ffmpeg");
        assert!(
            err.message.contains("Conversion failed!"),
            "{}",
            err.message
        );
        assert_eq!(
            std::fs::read(dir.join("assets/cut-edited.mp4")).unwrap(),
            b"OLD"
        );
        assert!(!dir.join("assets/.kc-render").exists());
        assert!(read_render_record(&dir, "cut").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_document_or_missing_source_fails_before_staging() {
        let dir = render_project("bad");
        let ffmpeg = fake_ffmpeg(&dir, "printf NEW > \"$out\"");
        let mut job = canonical_job(&dir, ffmpeg.clone(), false);
        job.doc.clips.clear();
        let err = render_doc(job, &mut |_| {}, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "invalid");
        std::fs::remove_file(dir.join("assets/a.mp4")).unwrap();
        let err = render_doc(
            canonical_job(&dir, ffmpeg.clone(), false),
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, "missing");
        let mut job = canonical_job(&dir, ffmpeg, false);
        job.draft = true;
        assert_eq!(
            render_doc(job, &mut |_| {}, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "usage"
        );
        assert_eq!(
            std::fs::read(dir.join("assets/cut-edited.mp4")).unwrap(),
            b"OLD"
        );
        assert!(!dir.join("assets/.kc-render").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_kills_ffmpeg_and_keeps_the_previous_output() {
        let dir = render_project("cancel");
        let pid_file = dir.join("ffmpeg.pid");
        let ffmpeg = fake_ffmpeg(
            &dir,
            &format!(
                "echo $$ > '{}'\nprintf PARTIAL > \"$out\"\nwhile true; do echo frame=1; sleep 0.05; done",
                pid_file.display()
            ),
        );
        let cancel = AtomicBool::new(false);
        let err = render_doc(
            canonical_job(&dir, ffmpeg, false),
            &mut |e| {
                if matches!(e, RenderEvent::Progress { .. }) {
                    cancel.store(true, Ordering::SeqCst);
                }
            },
            &cancel,
        )
        .unwrap_err();
        assert_eq!(err.code, "interrupted");
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "ffmpeg {pid} still runs");
        assert_eq!(
            std::fs::read(dir.join("assets/cut-edited.mp4")).unwrap(),
            b"OLD"
        );
        assert!(!dir.join("assets/.kc-render").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_stagings_are_swept_while_live_ones_survive() {
        let dir = render_project("sweep");
        let stage = dir.join("assets/.kc-render");
        std::fs::create_dir_all(&stage).unwrap();
        let stale = stage.join("1-0-cut-edited.mp4");
        let live = stage.join("2-0-other-edited.mp4");
        std::fs::write(&stale, b"x").unwrap();
        std::fs::write(&live, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(2 * 60 * 60))
            .unwrap();
        let ffmpeg = fake_ffmpeg(&dir, "printf NEW > \"$out\"");
        render_doc(
            canonical_job(&dir, ffmpeg, false),
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(!stale.exists());
        assert!(live.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_review_render_lands_where_asked_without_a_record() {
        let dir = render_project("review");
        let ffmpeg = fake_ffmpeg(
            &dir,
            "case \"$*\" in *scale=960:540*ultrafast*) printf DRAFT > \"$out\";; *) exit 1;; esac",
        );
        let mut job = canonical_job(&dir, ffmpeg, true);
        let out = dir.join("review/drafts/cut.mp4");
        job.target = RenderTarget::File(out.clone());
        job.draft = true;
        job.scale = Some(0.5);
        let outcome = render_doc(job, &mut |_| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcome.rel, None);
        assert_eq!(
            (outcome.lane, outcome.width, outcome.height),
            (Lane::Software, 960, 540)
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"DRAFT");
        assert!(read_render_record(&dir, "cut").is_none());
        assert_eq!(
            std::fs::read(dir.join("assets/cut-edited.mp4")).unwrap(),
            b"OLD"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_reports_render_blockers_as_errors_and_surprises_as_warnings() {
        let dir = temp_project("validate");
        std::fs::write(dir.join("assets/a.mp4"), b"x").unwrap();
        let mut d = doc();
        let clean = validate_doc(&dir, &d, Some("cut"));
        assert!(clean.ok && clean.warnings.is_empty(), "{clean:?}");
        assert_eq!(
            (clean.total_frames, clean.duration_ms, clean.version),
            (60, 1000.0, 1)
        );
        assert_eq!(clean.clips[0].frames, 60);

        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 500,
            out_ms: 500,
            speed: 1.0,
            start_ms: 999,
            hold_ms: Some(50),
        });
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 5000,
            pos: [0.5, 0.5],
        });
        d.tap_style = Some("sparkle".into());
        d.tap_size = Some(9.0);
        let mut m = solid_mask();
        m.source_id = "s9".into();
        d.masks.push(m);
        let warned = validate_doc(&dir, &d, Some("cut"));
        assert!(warned.ok, "{:?}", warned.errors);
        let codes: Vec<&str> = warned.warnings.iter().map(|w| w.code).collect();
        assert_eq!(
            codes,
            [
                "short-hold",
                "not-laid-out",
                "tap-style",
                "tap-size",
                "tap-hidden",
                "mask-unused-source"
            ]
        );
        assert_eq!(warned.warnings[0].clip.as_deref(), Some("c2"));
        assert_eq!(warned.warnings[4].tap.as_deref(), Some("t1"));
        assert!(warned.taps[0].windows.is_empty());
        assert_eq!(warned.total_frames, 60 + 3);

        d.clips[0].speed = 0.0;
        d.clips[0].out_ms = 20_000;
        d.clips.push(EditClip {
            id: "c3".into(),
            source_id: "s7".into(),
            in_ms: 0,
            out_ms: 500,
            speed: 1.0,
            start_ms: 0,
            hold_ms: None,
        });
        d.sources.push(EditSource {
            id: "s2".into(),
            rel: "assets/gone.mp4".into(),
            kind: EditSourceKind::Video,
            width: 1920,
            height: 1080,
            fps: 60.0,
            duration_ms: 1000,
            abs: String::new(),
        });
        d.masks[0].source_id = "s1".into();
        d.masks[0].color = Some("red".into());
        let failed = validate_doc(&dir, &d, Some("other"));
        assert!(!failed.ok);
        let codes: Vec<&str> = failed.errors.iter().map(|e| e.code).collect();
        assert_eq!(
            codes,
            [
                "name",
                "bad-speed",
                "past-source",
                "unknown-source",
                "bad-mask"
            ]
        );
        assert_eq!(failed.errors[3].clip.as_deref(), Some("c3"));
        assert_eq!(failed.errors[4].mask.as_deref(), Some("m1"));
        // An unused missing source only warns; the render never reads it.
        assert!(failed.warnings.iter().any(|w| w.code == "source-missing"));
        assert_eq!(failed.version, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_surfaces_what_only_the_argument_builder_refuses() {
        let dir = temp_project("validate-dry");
        std::fs::write(dir.join("assets/a.mp4"), b"x").unwrap();
        let mut d = doc();
        d.clips.clear();
        let empty = validate_doc(&dir, &d, None);
        let codes: Vec<&str> = empty.errors.iter().map(|e| e.code).collect();
        assert_eq!(codes, ["no-clips"]);
        assert_eq!(empty.total_frames, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    const DEV_FFMPEG: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/bin/ffmpeg-aarch64-apple-darwin"
    );
    const DEV_FFPROBE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/bin/ffprobe-aarch64-apple-darwin"
    );

    fn ffmpeg_ok(args: &[&str]) {
        let out = std::process::Command::new(DEV_FFMPEG)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn file_hash(path: &Path) -> String {
        live_edits::content_hash(&std::fs::read(path).unwrap())
    }

    #[test]
    #[ignore = "runs the dev ffmpeg sidecar and the app binary that `cargo test` builds"]
    fn edit_core_and_cli_software_renders_are_byte_identical() {
        let bin = tools::sidecar_path("kookaburra-cut").unwrap();
        assert!(
            bin.is_file(),
            "{} is missing: run `cargo test`, which builds the app binary",
            bin.display()
        );
        let dir = temp_project("identical");
        let rec = dir.join("assets/rec.mp4");
        ffmpeg_ok(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x240:r=30:d=3",
            "-pix_fmt",
            "yuv420p",
            rec.to_str().unwrap(),
        ]);
        let mut d =
            create_default_doc_at(Path::new(DEV_FFPROBE), &dir, "rec", "assets/rec.mp4").unwrap();
        d.clips[0].out_ms = 1200;
        d.clips[0].speed = 1.5;
        d.clips.push(EditClip {
            id: "c2".into(),
            source_id: "s1".into(),
            in_ms: 1500,
            out_ms: 1500,
            speed: 1.0,
            start_ms: 800,
            hold_ms: Some(700),
        });
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 300,
            pos: [0.4, 0.4],
        });
        write_doc_checked(&dir, "rec", &d, None).unwrap();
        let output = dir.join("assets/rec-edited.mp4");

        let (doc, _, doc_hash) = load_doc_bytes(&dir, "rec").unwrap();
        let job = RenderJob {
            project: dir.clone(),
            doc,
            doc_hash,
            target: RenderTarget::Canonical("rec".into()),
            ffmpeg: tools::sidecar_path("ffmpeg").unwrap(),
            app_data: dir.join("appdata"),
            hardware: false,
            scale: None,
            draft: false,
        };
        let core = render_doc(job, &mut |_| {}, &AtomicBool::new(false)).unwrap();
        let core_hash = file_hash(&output);
        std::fs::remove_file(&output).unwrap();

        let run = std::process::Command::new(&bin)
            .args(["edit", "render", "--project", dir.to_str().unwrap()])
            .args(["--name", "rec", "--software"])
            .env("HOME", dir.join("home"))
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&run.stdout);
        assert!(run.status.success(), "{stdout}");
        let done: serde_json::Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
        assert_eq!(done["frames"], core.frames);
        assert_eq!(done["docHash"], core.doc_hash);
        assert_eq!(file_hash(&output), core_hash);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One barcode-painted source: frame index `N` (or `value`) as 16 bits across the top 32 rows.
    fn barcode_source(out: &Path, fps: u32, seconds: u32, value: &str) {
        let graph = format!(
            "color=c=gray:s=320x240:r={fps}:d={seconds},format=yuv420p,\
             geq=lum='if(lt(Y,32),if(mod(floor(({value})/pow(2,floor(X/(W/16)))),2),235,16),lum(X,Y))':cb=128:cr=128"
        );
        ffmpeg_ok(&[
            "-f",
            "lavfi",
            "-i",
            &graph,
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-pix_fmt",
            "yuv420p",
            out.to_str().unwrap(),
        ]);
    }

    /// The barcode value of every stored frame, in order (passthrough: a variable-rate file is not regridded).
    fn decode_barcodes(path: &Path) -> Vec<u32> {
        let out = std::process::Command::new(DEV_FFMPEG)
            .args(["-v", "error", "-i", path.to_str().unwrap()])
            .args(["-vf", "crop=iw:32:0:0,scale=16:1:flags=area,format=gray"])
            .args(["-fps_mode", "passthrough", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
            .chunks(16)
            .map(|blocks| {
                blocks
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| **b > 128)
                    .map(|(bit, _)| 1u32 << bit)
                    .sum()
            })
            .collect()
    }

    /// Image barcodes carry bit 15, so a decoded frame names its own source.
    const IMAGE_MARK: u32 = 1 << 15;

    struct BarcodeSource {
        id: &'static str,
        file: &'static str,
        kind: EditSourceKind,
        /// The rate `sourceFrame` indexes source time at (`sourceFrame / indexFps` = the frame's pts in seconds).
        index_fps: u32,
    }

    fn clip(
        id: &str,
        source: &str,
        in_ms: u64,
        out_ms: u64,
        speed: f64,
        hold: Option<u64>,
    ) -> EditClip {
        EditClip {
            id: id.into(),
            source_id: source.into(),
            in_ms,
            out_ms,
            speed,
            start_ms: 0,
            hold_ms: hold,
        }
    }

    /// Lay clips out like editMath.ts `relayout`.
    fn laid_out(mut clips: Vec<EditClip>, images: &[&str]) -> Vec<EditClip> {
        let mut t = 0.0;
        for c in &mut clips {
            c.start_ms = js_round(t) as u64;
            t += clip_timeline_ms(c, images.contains(&c.source_id.as_str()));
        }
        clips
    }

    /// One JSON value on one line, spaced like Biome formats it.
    fn inline_json(value: &serde_json::Value) -> String {
        use serde_json::Value;
        match value {
            Value::Array(items) if items.is_empty() => "[]".into(),
            Value::Array(items) => format!(
                "[{}]",
                items.iter().map(inline_json).collect::<Vec<_>>().join(", ")
            ),
            Value::Object(map) if map.is_empty() => "{}".into(),
            Value::Object(map) => format!(
                "{{ {} }}",
                map.iter()
                    .map(|(k, v)| format!("{}: {}", Value::String(k.clone()), inline_json(v)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            other => other.to_string(),
        }
    }

    /// A case file: top-level keys one per line, arrays one element per line.
    fn fixture_text(value: &serde_json::Value) -> String {
        let map = value.as_object().unwrap();
        let mut lines = Vec::new();
        for (key, v) in map {
            let key = serde_json::Value::String(key.clone());
            match v {
                serde_json::Value::Array(items) if !items.is_empty() => {
                    let body: Vec<String> = items
                        .iter()
                        .map(|i| format!("    {}", inline_json(i)))
                        .collect();
                    lines.push(format!("  {key}: [\n{}\n  ]", body.join(",\n")));
                }
                other => lines.push(format!("  {key}: {}", inline_json(other))),
            }
        }
        format!("{{\n{}\n}}\n", lines.join(",\n"))
    }

    /// Render conformance vectors: barcode-painted sources rendered through the real argument builder, every output frame decoded back to the source frame it shows. `KB_WRITE_CONFORMANCE=1` rewrites the fixtures; otherwise they must match.
    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
    fn edit_barcode_conformance() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/video-conformance",
        );
        let write = std::env::var("KB_WRITE_CONFORMANCE").as_deref() == Ok("1");
        let dir = temp_project("barcode");
        let assets = dir.join("assets");
        barcode_source(&assets.join("cfr60.mp4"), 60, 8, "N");
        barcode_source(&assets.join("cfr30.mp4"), 30, 4, "N");
        // Held stretches (60..179 hold for 10 frames) that mpdecimate drops into a variable-rate file.
        barcode_source(
            &assets.join("held60.mp4"),
            60,
            4,
            "if(lt(N,60),N,if(lt(N,180),floor(N/10)*10,N))",
        );
        ffmpeg_ok(&[
            "-i",
            assets.join("held60.mp4").to_str().unwrap(),
            "-vf",
            "mpdecimate=hi=1:lo=1:frac=0:max=0",
            "-fps_mode",
            "vfr",
            "-video_track_timescale",
            "600",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-pix_fmt",
            "yuv420p",
            assets.join("vfr60.mp4").to_str().unwrap(),
        ]);
        let still = format!(
            "color=c=gray:s=320x240:r=1:d=1,format=yuv420p,\
             geq=lum='if(lt(Y,32),if(mod(floor({}/pow(2,floor(X/(W/16)))),2),235,16),lum(X,Y))':cb=128:cr=128",
            IMAGE_MARK + 7
        );
        ffmpeg_ok(&[
            "-f",
            "lavfi",
            "-i",
            &still,
            "-frames:v",
            "1",
            assets.join("still.png").to_str().unwrap(),
        ]);

        let sources = [
            BarcodeSource {
                id: "cfr60",
                file: "cfr60.mp4",
                kind: EditSourceKind::Video,
                index_fps: 60,
            },
            BarcodeSource {
                id: "cfr30",
                file: "cfr30.mp4",
                kind: EditSourceKind::Video,
                index_fps: 30,
            },
            BarcodeSource {
                id: "vfr60",
                file: "vfr60.mp4",
                kind: EditSourceKind::Video,
                index_fps: 60,
            },
            BarcodeSource {
                id: "still",
                file: "still.png",
                kind: EditSourceKind::Image,
                index_fps: 0,
            },
        ];
        let probed: Vec<(EditSource, serde_json::Value)> = sources
            .iter()
            .map(|s| {
                let rel = format!("assets/{}", s.file);
                let abs = assets.join(s.file);
                let probe = media::probe_media_at(Path::new(DEV_FFPROBE), &abs).unwrap();
                let source = EditSource {
                    id: s.id.into(),
                    rel: rel.clone(),
                    kind: s.kind,
                    width: probe.width,
                    height: probe.height,
                    fps: probe.fps,
                    duration_ms: probe.duration_ms,
                    abs: abs.to_string_lossy().into_owned(),
                };
                let mut meta = serde_json::json!({
                    "id": s.id, "rel": rel, "kind": s.kind, "fps": probe.fps,
                    "durationMs": probe.duration_ms, "vfr": probe.vfr,
                });
                if s.kind == EditSourceKind::Video {
                    let frames = decode_barcodes(&abs);
                    meta["indexFps"] = s.index_fps.into();
                    meta["frames"] = frames.len().into();
                    if probe.vfr {
                        meta["kept"] = frames.into();
                    }
                }
                (source, meta)
            })
            .collect();

        let mut cases: Vec<(String, Vec<&str>, Vec<EditClip>)> = Vec::new();
        for speed in [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0, 6.0] {
            let span = (speed * 1000.0) as u64 + 7;
            cases.push((
                format!("speed-{speed}"),
                vec!["cfr60"],
                vec![clip("c1", "cfr60", 1017, 1017 + span, speed, None)],
            ));
        }
        cases.push((
            "freeze".into(),
            vec!["cfr60"],
            vec![
                clip("c1", "cfr60", 0, 500, 1.0, None),
                clip("c2", "cfr60", 500, 500, 1.0, Some(1000)),
                clip("c3", "cfr60", 500, 1000, 1.0, None),
            ],
        ));
        cases.push((
            "two-halves-2x".into(),
            vec!["cfr60"],
            vec![
                clip("c1", "cfr60", 0, 1017, 2.0, None),
                clip("c2", "cfr60", 2000, 3017, 2.0, None),
            ],
        ));
        cases.push((
            "vfr".into(),
            vec!["vfr60"],
            vec![
                clip("c1", "vfr60", 517, 2017, 1.0, None),
                clip("c2", "vfr60", 2017, 3517, 2.0, None),
            ],
        ));
        cases.push((
            "image".into(),
            vec!["cfr60", "still"],
            vec![
                clip("c1", "cfr60", 0, 500, 1.0, None),
                clip("c2", "still", 0, 0, 1.0, Some(1000)),
                clip("c3", "cfr60", 500, 1000, 1.5, None),
            ],
        ));
        cases.push((
            "rate-30-in-60".into(),
            vec!["cfr30"],
            vec![
                clip("c1", "cfr30", 0, 1000, 1.0, None),
                clip("c2", "cfr30", 1000, 2500, 1.5, None),
            ],
        ));

        if write {
            std::fs::create_dir_all(&fixtures).unwrap();
        }
        let mut stale = Vec::new();
        for (case, ids, clips) in cases {
            let doc_sources: Vec<EditSource> = probed
                .iter()
                .filter(|(s, _)| ids.contains(&s.id.as_str()))
                .map(|(s, _)| s.clone())
                .collect();
            let images: Vec<&str> = doc_sources
                .iter()
                .filter(|s| s.kind == EditSourceKind::Image)
                .map(|s| s.id.as_str())
                .collect();
            let doc = EditDoc {
                version: 1,
                name: case.clone(),
                sources: doc_sources.clone(),
                settings: EditSettings {
                    width: 320,
                    height: 240,
                    fps: 60.0,
                },
                clips: laid_out(clips, &images),
                taps: Vec::new(),
                tap_style: None,
                tap_color: None,
                tap_size: None,
                masks: Vec::new(),
                reference: None,
            };
            let out = dir.join(format!("{case}.mp4"));
            let (args, total) =
                build_render_args(&doc, out.to_str().unwrap(), false, None).unwrap();
            let run = std::process::Command::new(DEV_FFMPEG)
                .args(&args)
                .output()
                .unwrap();
            assert!(
                run.status.success(),
                "{case}: {}",
                String::from_utf8_lossy(&run.stderr)
            );
            let shown = decode_barcodes(&out);
            assert_eq!(shown.len() as u32, total, "{case}: decoded frames vs plan");
            let multi = ids.len() > 1;
            let frames: Vec<serde_json::Value> = shown
                .iter()
                .enumerate()
                .map(|(k, &value)| {
                    let image = value & IMAGE_MARK != 0;
                    let mut entry = serde_json::json!({ "k": k });
                    if multi {
                        let id = if image { "still" } else { ids[0] };
                        entry["sourceId"] = id.into();
                    }
                    entry["sourceFrame"] = (if image { 0 } else { value }).into();
                    entry
                })
                .collect();
            let source_meta: Vec<serde_json::Value> = probed
                .iter()
                .filter(|(s, _)| ids.contains(&s.id.as_str()))
                .map(|(_, m)| m.clone())
                .collect();
            let vector = serde_json::json!({
                "case": case,
                "fps": 60,
                "width": 320,
                "height": 240,
                "sources": source_meta,
                "clips": doc.clips,
                "totalFrames": total,
                "outputFrames": frames,
            });
            let path = fixtures.join(format!("{case}.json"));
            if write {
                std::fs::write(&path, fixture_text(&vector)).unwrap();
            } else {
                let saved: Option<serde_json::Value> = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok());
                if saved.as_ref() != Some(&vector) {
                    stale.push(case);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            stale.is_empty(),
            "stale conformance fixtures {stale:?}: rerun with KB_WRITE_CONFORMANCE=1 and review the diff"
        );
    }

    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
    fn a_masked_edit_renders_end_to_end_through_the_sidecar() {
        let ffmpeg = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/bin/ffmpeg-aarch64-apple-darwin"
        );
        let dir = std::env::temp_dir().join(format!("kc-edit-masks-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("a.mp4");
        let still = dir.join("b.png");
        let make = |args: &[&str]| {
            let out = std::process::Command::new(ffmpeg)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        make(
            &[
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x240:r=30:d=3",
            ]
            .iter()
            .copied()
            .chain(["-pix_fmt", "yuv420p", clip.to_str().unwrap()])
            .collect::<Vec<_>>(),
        );
        make(
            &[
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=200x300:r=1:d=1",
            ]
            .iter()
            .copied()
            .chain(["-frames:v", "1", still.to_str().unwrap()])
            .collect::<Vec<_>>(),
        );
        let mut d = doc();
        d.sources[0].width = 320;
        d.sources[0].height = 240;
        d.sources[0].duration_ms = 3000;
        d.sources[0].abs = clip.to_string_lossy().into_owned();
        d.sources.push(EditSource {
            id: "s2".into(),
            rel: "assets/b.png".into(),
            kind: EditSourceKind::Image,
            width: 200,
            height: 300,
            fps: 0.0,
            duration_ms: 0,
            abs: still.to_string_lossy().into_owned(),
        });
        d.settings = EditSettings {
            width: 320,
            height: 240,
            fps: 30.0,
        };
        let clip_at = |id: &str, source: &str, in_ms, out_ms, start_ms, hold_ms| EditClip {
            id: id.into(),
            source_id: source.into(),
            in_ms,
            out_ms,
            speed: 1.0,
            start_ms,
            hold_ms,
        };
        d.clips = vec![
            clip_at("c1", "s1", 0, 1500, 0, None),
            clip_at("c2", "s1", 800, 800, 1500, Some(500)),
            clip_at("c3", "s2", 0, 0, 2000, Some(500)),
            clip_at("c4", "s1", 1500, 3000, 2500, None),
        ];
        let key = |source_ms, rect| EditMaskKey { source_ms, rect };
        let mask = |id: &str, source: &str, style, keys| EditMask {
            id: id.into(),
            source_id: source.into(),
            style,
            strength: None,
            color: Some("#ff8800".into()),
            start_ms: 200,
            end_ms: 2600,
            keys,
        };
        d.masks = vec![
            mask(
                "m1",
                "s1",
                EditMaskStyle::Blur,
                vec![
                    key(300, [0.1, 0.1, 0.3, 0.2]),
                    key(2400, [0.5, 0.6, 0.2, 0.3]),
                ],
            ),
            mask(
                "m2",
                "s1",
                EditMaskStyle::Solid,
                vec![key(0, [0.6, 0.05, 0.3, 0.1])],
            ),
            mask(
                "m3",
                "s2",
                EditMaskStyle::Pixelate,
                vec![key(0, [0.2, 0.2, 0.5, 0.3])],
            ),
        ];
        let out = dir.join("out.mp4");
        let (args, total) = build_render_args(&d, out.to_str().unwrap(), false, None).unwrap();
        let run = std::process::Command::new(ffmpeg)
            .args(&args)
            .output()
            .unwrap();
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let probe = std::process::Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-i",
                out.to_str().unwrap(),
                "-map",
                "0:v",
                "-f",
                "null",
                "-",
            ])
            .args(["-progress", "pipe:1"])
            .output()
            .unwrap();
        let frames = String::from_utf8_lossy(&probe.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("frame="))
            .next_back()
            .and_then(|v| v.trim().parse::<u32>().ok());
        assert_eq!(frames, Some(total));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
