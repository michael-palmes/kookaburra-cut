//! Non-destructive mini video editor: an edit is a JSON document under a project's `edits/` folder describing trim/reorder/retime of clips cut from `assets/` source videos (never modified), edited in a second Tauri window (label `editor`); the flatten render defaults to VideoToolbox decode + `h264_videotoolbox` at a generous bitrate (retrying once with the old `libx264 -crf 18 -preset veryfast` lane on failure) and is NOT part of the byte-identical export path, but re-entering as a `VideoClip` source deterministically re-extracts to a CFR-60 PNG sequence, so a rendered edit still passes `Verify ×2`.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::media;
use crate::workspace::{self, SettingsState};

/// A source video referenced by an edit (read-only; identified by `id`, located by `rel`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSource {
    pub id: String,
    pub rel: String,
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
    /// Tap style preset id; absent = the default (first) preset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_style: Option<String>,
    /// Tap size multiplier on the default dot size; absent = 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_size: Option<f64>,
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

fn edits_dir(root: &Path, slug: &str) -> std::path::PathBuf {
    root.join(slug).join("edits")
}

fn edit_path(root: &Path, slug: &str, name: &str) -> std::path::PathBuf {
    edits_dir(root, slug).join(format!("{name}.json"))
}

/// Atomic write (tmp + rename) so a crash mid-save can never corrupt `edit.json`; the "no interaction corrupts the document" half of the robustness contract.
fn write_doc(path: &Path, doc: &EditDoc) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_doc(path: &Path) -> Result<EditDoc, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("reading edit at {}: {e}", path.display()))?;
    let doc: EditDoc =
        serde_json::from_str(&text).map_err(|e| format!("edit is corrupt: {e}"))?;
    if doc.version > EDIT_VERSION {
        return Err(format!(
            "this edit uses document version {} — it needs a newer Kookaburra Cut",
            doc.version
        ));
    }
    Ok(doc)
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
) -> Result<String, String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    let source_abs = media::resolve_asset(&root, &slug, &source_rel)?;
    if !source_abs.is_file() {
        return Err(format!("source not found: {source_rel}"));
    }

    let stem = source_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("edit");
    let mut name = workspace::slugify(stem);
    if name.is_empty() {
        name = "edit".into();
    }

    let path = edit_path(&root, &slug, &name);
    if !path.is_file() {
        let doc = create_default_doc(&app, &root, &slug, &name, &source_rel).await?;
        write_doc(&path, &doc)?;
    }

    let target = EditTarget {
        slug: slug.clone(),
        name: name.clone(),
        path: root.join(&slug).to_string_lossy().into_owned(),
        source_rel: source_rel.clone(),
    };
    *editor.0.lock().map_err(|_| "editor state poisoned")? = Some(target.clone());
    open_editor_window(&app, &target)?;
    Ok(name)
}

/// The fresh single-clip document `open_edit` seeds (and `reset_edit` recreates).
async fn create_default_doc(
    app: &AppHandle,
    root: &Path,
    slug: &str,
    name: &str,
    source_rel: &str,
) -> Result<EditDoc, String> {
    let source_abs = media::resolve_asset(root, slug, source_rel)?;
    if !source_abs.is_file() {
        return Err(format!("source not found: {source_rel}"));
    }
    let probe = media::probe_media(app, &source_abs).await?;
    if probe.kind != "video" {
        return Err("only videos can be edited".into());
    }
    let fps = if probe.fps > 0.0 { probe.fps } else { 60.0 };
    Ok(EditDoc {
        version: EDIT_VERSION,
        name: name.to_owned(),
        sources: vec![EditSource {
            id: "s1".into(),
            rel: source_rel.to_owned(),
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            duration_ms: probe.duration_ms,
            abs: String::new(),
        }],
        settings: EditSettings {
            width: probe.width,
            height: probe.height,
            fps,
        },
        clips: vec![EditClip {
            id: "c1".into(),
            source_id: "s1".into(),
            in_ms: 0,
            out_ms: probe.duration_ms,
            speed: 1.0,
            start_ms: 0,
            hold_ms: None,
        }],
        taps: Vec::new(),
        tap_style: None,
        tap_size: None,
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
) -> Result<String, String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&name)?;
    let doc = read_doc(&edit_path(&root, &slug, &name))?;
    let source_rel = doc
        .sources
        .first()
        .map(|s| s.rel.clone())
        .unwrap_or_default();
    let target = EditTarget {
        slug: slug.clone(),
        name: name.clone(),
        path: root.join(&slug).to_string_lossy().into_owned(),
        source_rel,
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
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&name)?;
    let path = edit_path(&root, &slug, &name);
    if path.is_file() {
        let _ = std::fs::rename(&path, path.with_extension("json.bak"));
    }
    let doc = create_default_doc(&app, &root, &slug, &name, &source_rel).await?;
    write_doc(&path, &doc)?;
    Ok(doc)
}

/// The pending editor target (read once by the editor window on boot).
#[tauri::command]
pub fn get_editor_target(editor: State<'_, EditorState>) -> Result<Option<EditTarget>, String> {
    Ok(editor.0.lock().map_err(|_| "editor state poisoned")?.clone())
}

/// Load an edit document (schema-validated by serde; a corrupt file returns a readable error).
#[tauri::command]
pub fn load_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
) -> Result<EditDoc, String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&name)?;
    read_doc(&edit_path(&root, &slug, &name))
}

/// Persist an edit document (autosave); the name is fixed at creation, the doc's own `name` must match, so a rename can't write outside its file.
#[tauri::command]
pub fn save_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
    doc: EditDoc,
) -> Result<(), String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&name)?;
    write_doc(&edit_path(&root, &slug, &name), &doc)
}

/// Names of a project's saved edits.
#[tauri::command]
pub fn list_edits(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<String>, String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    let mut names = Vec::new();
    if let Ok(read) = std::fs::read_dir(edits_dir(&root, &slug)) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_owned());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Frames an output clip contributes: its retimed duration at the output fps (a freeze contributes its hold).
fn clip_output_frames(clip: &EditClip, fps: f64) -> u32 {
    let span_ms = match clip.hold_ms {
        Some(hold) => hold as f64,
        None => {
            let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
            clip.out_ms.saturating_sub(clip.in_ms) as f64 / speed
        }
    };
    ((span_ms / 1000.0) * fps).round().max(0.0) as u32
}

/// Tap-highlight constants, hand-mirrored from src/editor/tapAnimation.ts and scripts/generate-tap-dot.mjs.
const TAP_ANIMATION_DURATION_MS: f64 = 550.0;
const TAP_DOT_SIZE_FRACTION: f64 = 0.07;
/// The baked frames leave pulse headroom around the scale-1 dot; the overlay scales up by the same factor so the dot lands at exactly TAP_DOT_SIZE_FRACTION of min(w, h).
const TAP_DOT_CANVAS_HEADROOM: f64 = 1.15;
/// Bump when the baked frames change to invalidate the materialised cache.
const TAP_DOT_FRAMES_VERSION: u32 = 2;

/// The doc's tap style, falling back to the default (first) preset when absent or unknown.
fn tap_style_id(doc: &EditDoc) -> &str {
    let presets = crate::tap_dot_frames::TAP_DOT_PRESETS;
    match doc.tap_style.as_deref() {
        Some(id) if presets.iter().any(|(k, _)| *k == id) => id,
        _ => presets[0].0,
    }
}

/// Materialise the embedded glow-dot frames into `$APPDATA/cache/tapdot/<preset>` once (versioned marker, the media-cache pattern) so ffmpeg's image2 reader can consume them; both encode lanes reference the same stable files.
fn ensure_tap_dot_frames(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("tapdot");
    let done = dir.join(format!(".done-v{TAP_DOT_FRAMES_VERSION}"));
    if !done.is_file() {
        for (preset, frames) in crate::tap_dot_frames::TAP_DOT_PRESETS {
            let preset_dir = dir.join(preset);
            std::fs::create_dir_all(&preset_dir).map_err(|e| e.to_string())?;
            for (i, bytes) in frames.iter().enumerate() {
                std::fs::write(preset_dir.join(format!("tapdot_{i:02}.png")), bytes)
                    .map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(&done, []).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Mirror of editMath.ts `tapWindows`: one `(tap, clip, start_ms, end_ms)` per clip containing the tap's source point, so a duplicated segment shows it in each copy. Duration is fixed in output ms, clamped at the clip's end (a tap near a cut truncates); freezes are skipped (zero-length source span).
fn tap_windows<'a>(
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
            windows.push((tap, *clip, start, (start + TAP_ANIMATION_DURATION_MS).min(clip_end)));
        }
    }
    windows
}

/// Build the ffmpeg args that flatten an edit into a single file: one filter chain per clip (trim → retime → normalise fps → scale+pad to the output size) then `concat`, rendered in timeline (`startMs`) order; gaps are not yet materialised as black. Tap highlights overlay the concat output (one baked-frame input per visible window). The hardware lane decodes and encodes on the media engine; the output is an intermediate re-encoded at final export, so 0.25 bits/pixel is generous headroom (the old crf-18 lane measures ~0.09).
fn build_render_args(
    doc: &EditDoc,
    output: &str,
    hardware: bool,
    tap_dot_dir: Option<&Path>,
) -> Result<(Vec<String>, u32), String> {
    if doc.clips.is_empty() {
        return Err("this edit has no clips to render".into());
    }
    let (w, h) = (doc.settings.width, doc.settings.height);
    let fps = if doc.settings.fps > 0.0 {
        doc.settings.fps
    } else {
        60.0
    };

    // Each source used by a clip becomes ONE `-i` in stable order; ffmpeg auto-splits a reused *input stream specifier* like `[idx:v]` so we decode each source once, but reusing a *filter output* label (e.g. `[v0]`) would error, don't "fix" this into one `-i` per clip.
    let mut input_order: Vec<&EditSource> = Vec::new();
    let mut input_index = std::collections::HashMap::new();
    let clips_sorted = {
        let mut c: Vec<&EditClip> = doc.clips.iter().collect();
        c.sort_by_key(|clip| clip.start_ms);
        c
    };
    for clip in &clips_sorted {
        if !input_index.contains_key(&clip.source_id) {
            let source = doc
                .sources
                .iter()
                .find(|s| s.id == clip.source_id)
                .ok_or_else(|| format!("clip references unknown source {}", clip.source_id))?;
            input_index.insert(clip.source_id.clone(), input_order.len());
            input_order.push(source);
        }
    }

    let mut filter = String::new();
    let mut labels = Vec::new();
    let mut total_frames = 0u32;
    for (i, clip) in clips_sorted.iter().enumerate() {
        let idx = input_index[&clip.source_id];
        let in_s = clip.in_ms as f64 / 1000.0;
        let out_s = clip.out_ms as f64 / 1000.0;
        let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
        let label = format!("v{i}");
        if let Some(hold_ms) = clip.hold_ms {
            // Freeze frame: select exactly the frame at inMs, clone it for the hold, then trim to the exact length after fps normalisation.
            let hold_s = hold_ms as f64 / 1000.0;
            filter.push_str(&format!(
                "[{idx}:v]trim=start={in_s:.6}:duration=0.5,select=eq(n\\,0),setpts=PTS-STARTPTS,\
                 tpad=stop_mode=clone:stop_duration={hold_s:.6},fps={fps},trim=duration={hold_s:.6},\
                 setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{label}];"
            ));
        } else {
            filter.push_str(&format!(
                "[{idx}:v]trim=start={in_s:.6}:end={out_s:.6},setpts=(PTS-STARTPTS)/{speed},\
                 fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{label}];"
            ));
        }
        labels.push(label);
        total_frames += clip_output_frames(clip, fps);
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
        let tap_size = doc.tap_size.unwrap_or(1.0).clamp(0.25, 4.0);
        let dot_px = ((w.min(h) as f64) * TAP_DOT_SIZE_FRACTION * TAP_DOT_CANVAS_HEADROOM
            * tap_size)
            .round() as u32;
        for (i, (tap, clip, start_ms, end_ms)) in windows.iter().enumerate() {
            let source = doc
                .sources
                .iter()
                .find(|s| s.id == clip.source_id)
                .ok_or_else(|| format!("tap references unknown source {}", clip.source_id))?;
            let scale = (f64::from(w) / f64::from(source.width))
                .min(f64::from(h) / f64::from(source.height));
            let scaled_w = f64::from(source.width) * scale;
            let scaled_h = f64::from(source.height) * scale;
            let px = (f64::from(w) - scaled_w) / 2.0 + tap.pos[0].clamp(0.0, 1.0) * scaled_w;
            let py = (f64::from(h) - scaled_h) / 2.0 + tap.pos[1].clamp(0.0, 1.0) * scaled_h;
            let idx = input_order.len() + i;
            let start_s = start_ms / 1000.0;
            let end_s = end_ms / 1000.0;
            let next = format!("tapv{i}");
            filter.push_str(&format!(
                ";[{idx}:v]format=rgba,scale={dot_px}:{dot_px}:flags=lanczos[dot{i}];\
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
    for source in &input_order {
        if hardware {
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

/// Render an edit to `assets/<name>-edited.mp4` and return the project-relative path.
/// Progress is streamed over `on_progress` (parsed from ffmpeg `-progress`).
#[tauri::command]
pub async fn render_edit(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
    name: String,
    on_progress: Channel<RenderProgress>,
) -> Result<String, String> {
    let root = workspace::require_root(&app, &settings)?;
    workspace::validate_slug(&slug)?;
    workspace::validate_slug(&name)?;
    let mut doc = read_doc(&edit_path(&root, &slug, &name))?;

    // Resolve every referenced source to an absolute path up front (traversal-hardened), stashing it on a throwaway field the arg builder reads.
    for source in &mut doc.sources {
        source.abs = media::resolve_asset(&root, &slug, &source.rel)?
            .to_string_lossy()
            .into_owned();
    }

    let assets = root.join(&slug).join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let rel = format!("assets/{name}-edited.mp4");
    let output = assets.join(format!("{name}-edited.mp4"));
    let output_str = output.to_string_lossy().into_owned();

    // Resolved once, BEFORE the lane loop: both encode lanes must reference identical frame files.
    let tap_dot_dir = if doc.taps.is_empty() {
        None
    } else {
        Some(ensure_tap_dot_frames(&app)?)
    };

    // Hardware first; one software retry so an exotic input can never fail worse than the old lane. The Settings toggle drops the hardware attempt entirely.
    let lanes: &[bool] = if workspace::hardware_video_enabled(&app) {
        &[true, false]
    } else {
        &[false]
    };
    let mut rendered = false;
    let mut render_err = String::new();
    for &hardware in lanes {
        let (args, total) = build_render_args(&doc, &output_str, hardware, tap_dot_dir.as_deref())?;

        let (mut rx, _child) = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?
            .args(args)
            .spawn()
            .map_err(|e| format!("failed to start ffmpeg sidecar: {e}"))?;

        let mut code: Option<i32> = None;
        let mut last_error: Option<String> = None;
        let mut stderr_tail = String::new();
        let mut buffer = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // ffmpeg `-progress pipe:1` emits `key=value` lines; pull `frame=N`.
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(nl) = buffer.find('\n') {
                        let line: String = buffer.drain(..=nl).collect();
                        if let Some(v) = line.trim().strip_prefix("frame=") {
                            if let Ok(frame) = v.trim().parse::<u32>() {
                                let _ = on_progress.send(RenderProgress {
                                    frame: frame.min(total),
                                    total,
                                });
                            }
                        }
                    }
                }
                // `-loglevel error` keeps this to genuine failure text.
                CommandEvent::Stderr(bytes) => {
                    stderr_tail.push_str(&String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    code = payload.code;
                    break;
                }
                CommandEvent::Error(e) => last_error = Some(e),
                _ => {}
            }
        }

        if code == Some(0) {
            let _ = on_progress.send(RenderProgress { frame: total, total });
            rendered = true;
            break;
        }
        let _ = std::fs::remove_file(&output);
        render_err = last_error
            .or_else(|| {
                let tail = stderr_tail.trim();
                (!tail.is_empty()).then(|| tail.to_owned())
            })
            .unwrap_or_else(|| format!("ffmpeg render exited with {code:?}"));
        if hardware {
            eprintln!("[edit] hardware render failed, retrying with software: {render_err}");
        }
    }
    if !rendered {
        return Err(render_err);
    }
    // Warm the media-preview cache for the output now: by the time the editor closes and the library refreshes, poster/scrub frames already exist, no stale card, no pop-in; failure is non-fatal (the library regenerates on view).
    if let Err(e) = media::ensure_media_cache(&app, &output, &rel).await {
        eprintln!("[edit] preview warm-up failed for {rel}: {e}");
    }
    Ok(rel)
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
            tap_size: None,
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
    fn software_lane_is_the_original_argv() {
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
            "[0:v]trim=start=0.000000:end=1.000000,setpts=(PTS-STARTPTS)/1,fps=60,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];[v0]concat=n=1:v=1:a=0[outv]",
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
        assert!(filter.contains("select=eq(n\\,0)"));
        assert!(filter.contains("tpad=stop_mode=clone:stop_duration=2.000000"));
        assert!(filter.contains("trim=duration=2.000000"));
        assert!(filter.contains("concat=n=2"));
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
                "/cache/tapdot/glow-light/tapdot_%02d.png"
            ]
            .map(String::from)
        );
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        // 87 = round(1080 * 0.07 * 1.15); the window clamps at the 1s clip end.
        assert!(filter.contains(";[1:v]format=rgba,scale=87:87:flags=lanczos[dot0];"));
        assert!(filter.contains("[outv][dot0]overlay=x=480.000-overlay_w/2:y=810.000-overlay_h/2:"));
        assert!(filter.contains("eof_action=pass:enable='between(t\\,0.500000\\,1.000000)'[tapv0]"));
        assert!(args.windows(2).any(|w| w == ["-map", "[tapv0]"]));
    }

    #[test]
    fn tap_style_picks_its_preset_dir_and_unknown_falls_back() {
        let mut d = doc();
        d.taps.push(EditTap {
            id: "t1".into(),
            source_id: "s1".into(),
            source_ms: 500,
            pos: [0.5, 0.5],
        });
        d.tap_style = Some("ring-dark".into());
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        assert!(args.contains(&"/cache/tapdot/ring-dark/tapdot_%02d.png".to_string()));
        d.tap_style = Some("not-a-preset".into());
        let (args, _) =
            build_render_args(&d, "/out/x.mp4", false, Some(Path::new("/cache/tapdot"))).unwrap();
        assert!(args.contains(&"/cache/tapdot/glow-light/tapdot_%02d.png".to_string()));
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
}
