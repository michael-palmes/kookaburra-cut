//! Media library backend: imports files into a project's `assets/` and maintains a content-hash-keyed thumbnail/metadata cache (probe JSON via the ffprobe sidecar, a poster and ~10 hover-scrub frames via the ffmpeg sidecar), stored APP-GLOBALLY in `$APPDATA/cache/media/<sha>/` (beside `cache/clips`) so identical files dedupe across projects and Settings can clear it in one shot; entries are guarded by a `.done` marker, and a by-path stamp (size+mtime → sha) keeps warm views hash-free and regenerates automatically when a file changes.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::workspace::{self, SettingsState, MANIFEST_FILENAME};

const SCRUB_FRAMES: u32 = 10;
const POSTER_WIDTH: u32 = 640;
const SCRUB_WIDTH: u32 = 320;

/// Everything the media library needs to draw one card and its hover-scrub.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub rel: String,
    pub kind: String, // "video" | "image"
    pub width: u32,
    pub height: u32,
    pub fps: f64,        // 0 for images
    pub duration_ms: u64, // 0 for images
    /// Absolute paths (the webview loads them via /@fs in dev).
    pub poster_path: String,
    pub scrub_paths: Vec<String>,
    pub sha: String,
}

/// The cached, path-independent part of the metadata (poster/scrub paths are derived from the cache dir on read, so a moved workspace stays valid).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedMeta {
    kind: String,
    width: u32,
    height: u32,
    fps: f64,
    duration_ms: u64,
    scrub_count: u32,
}

/// App-global media-preview cache root (`$APPDATA/cache/media`).
pub(crate) fn media_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("media"))
}

/// The by-path fast-path stamp: proves which content sha a path resolved to last time, valid while size+mtime are unchanged, so warm views never re-hash the whole file.
#[derive(Serialize, Deserialize)]
struct PathStamp {
    size: u64,
    mtime_ms: u64,
    sha: String,
}

fn file_stamp(abs: &Path) -> Result<(u64, u64), String> {
    let md = std::fs::metadata(abs).map_err(|e| e.to_string())?;
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((md.len(), mtime_ms))
}

fn hashed_path_key(abs: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    crate::hex_digest(hasher.finalize().as_slice())
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

fn is_video(ext: &str) -> bool {
    workspace::VIDEO_EXTENSIONS.contains(&ext)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let read = file.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(crate::hex_digest(hasher.finalize().as_slice()))
}

/// A project-relative asset path, hardened against traversal (`assets/...` only).
pub(crate) fn resolve_asset(root: &Path, slug: &str, rel: &str) -> Result<PathBuf, String> {
    workspace::validate_slug(slug)?;
    let clean = rel.trim_start_matches("./");
    if !clean.starts_with("assets/") || clean.split('/').any(|part| part == "..") {
        return Err(format!("not a project asset path: {rel}"));
    }
    Ok(root.join(slug).join(clean))
}

/// Whether a sidecar run competes for the background-ffmpeg cap or runs unthrottled.
pub(crate) enum SidecarPriority {
    Foreground,
    Background,
}

/// Run a sidecar to completion, returning its stdout (stderr is drained and discarded; the event channel has a 1-item buffer and MUST be drained or the child blocks). Background runs queue on the shared limiter and drop scheduling priority.
pub(crate) async fn run_sidecar(
    app: &AppHandle,
    name: &str,
    args: Vec<String>,
    priority: SidecarPriority,
) -> Result<String, String> {
    let _permit = match priority {
        SidecarPriority::Background => Some(
            app.state::<crate::concurrency::BackgroundLimiter>()
                .acquire()
                .await?,
        ),
        SidecarPriority::Foreground => None,
    };
    let (mut rx, child) = app
        .shell()
        .sidecar(name)
        .map_err(|e| format!("{name} sidecar not found: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start {name}: {e}"))?;
    if matches!(priority, SidecarPriority::Background) {
        crate::concurrency::lower_priority(child.pid());
    }
    let mut stdout = String::new();
    let mut code: Option<i32> = None;
    let mut last_error: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Error(e) => last_error = Some(e),
            CommandEvent::Terminated(p) => {
                code = p.code;
                break;
            }
            _ => {}
        }
    }
    if code != Some(0) {
        return Err(last_error.unwrap_or_else(|| format!("{name} exited with {code:?}")));
    }
    Ok(stdout)
}

/// "30000/1001" → 29.97; plain numbers pass through.
fn parse_rate(s: &str) -> f64 {
    match s.split_once('/') {
        Some((n, d)) => {
            let n: f64 = n.parse().unwrap_or(0.0);
            let d: f64 = d.parse().unwrap_or(0.0);
            if d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

/// The geometry the media library and the video editor both need from a source file.
pub(crate) struct ProbeInfo {
    pub kind: String, // "video" | "image"
    pub width: u32,
    pub height: u32,
    pub fps: f64,        // 0 for images
    pub duration_ms: u64, // 0 for images
}

/// Copy an audio file into the project's `assets/` for use as the project soundtrack; deliberately NOT the media-import pipeline, audio has no poster/scrub cache to build. Returns the assets-relative path for `project.json.audio.file`.
#[tauri::command]
pub fn import_audio(
    app: AppHandle,
    state: State<'_, workspace::SettingsState>,
    slug: String,
    source_path: String,
) -> Result<String, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let src = std::path::PathBuf::from(&source_path);
    let ext = extension_of(&src);
    if !workspace::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported audio type .{ext}"));
    }
    if !src.is_absolute() || !src.is_file() {
        return Err(format!("audio file not found: {source_path}"));
    }
    let assets = root.join(&slug).join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let mut name = format!("{stem}.{ext}");
    let mut n = 2;
    while assets.join(&name).exists() {
        name = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    std::fs::copy(&src, assets.join(&name)).map_err(|e| format!("copying audio: {e}"))?;
    Ok(format!("assets/{name}"))
}

/// Set the project's app icon: the picked image lands as `assets/app-icon.png`, the canonical path every icon reference uses (BrandLockup's default, hand-authored ImageCards). PNG sources byte-copy; other image types convert via the ffmpeg sidecar. Both write a temp file then rename, so a failed convert never truncates the icon.
#[tauri::command]
pub async fn import_app_icon(
    app: AppHandle,
    state: State<'_, workspace::SettingsState>,
    slug: String,
    source_path: String,
) -> Result<String, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let src = std::path::PathBuf::from(&source_path);
    let ext = extension_of(&src);
    // gif rides along since the media grid lists it as an image; ffmpeg takes frame one.
    if !workspace::IMAGE_EXTENSIONS.contains(&ext.as_str()) && ext != "gif" {
        return Err(format!("unsupported image type .{ext}"));
    }
    if !src.is_absolute() || !src.is_file() {
        return Err(format!("image not found: {source_path}"));
    }
    let assets = root.join(&slug).join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let dest = assets.join("app-icon.png");
    let tmp = assets.join("app-icon.tmp.png");
    if ext == "png" {
        std::fs::copy(&src, &tmp).map_err(|e| format!("copying icon: {e}"))?;
    } else {
        let args: Vec<String> = vec![
            "-y".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            src.to_string_lossy().into_owned(),
            "-frames:v".into(),
            "1".into(),
            tmp.to_string_lossy().into_owned(),
        ];
        run_sidecar(&app, "ffmpeg", args, SidecarPriority::Foreground).await?;
    }
    // The old icon rides to the Trash (best-effort), so a replacement is recoverable.
    if dest.is_file() {
        let _ = workspace::trash_path(&dest);
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("replacing icon: {e}"))?;
    Ok("assets/app-icon.png".into())
}

/// Probe an audio file for the project-soundtrack loader: duration + stream facts only; a file with no audio stream is an error, the loader degrades to a silent project with a warning, never a crash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u32,
}

#[tauri::command]
pub async fn probe_audio(
    app: AppHandle,
    state: State<'_, SettingsState>,
    path: String,
) -> Result<AudioProbe, String> {
    // Confine before probing (TAU-01), a project's audio.file arrives as an absolute path.
    let abs = workspace::confine_readable(&app, &state, &path)?;
    if !abs.is_file() {
        return Err(format!("audio file not found: {path}"));
    }
    let probe = run_sidecar(
        &app,
        "ffprobe",
        vec![
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_streams".into(),
            "-show_format".into(),
            abs.to_string_lossy().into_owned(),
        ],
        SidecarPriority::Foreground,
    )
    .await?;
    let probe: serde_json::Value =
        serde_json::from_str(&probe).map_err(|e| format!("ffprobe json: {e}"))?;
    let stream = probe["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s["codec_type"].as_str() == Some("audio"))
        })
        .ok_or("no audio stream found")?;
    let duration_s: f64 = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);
    Ok(AudioProbe {
        duration_ms: (duration_s * 1000.0).round().max(0.0) as u64,
        sample_rate: stream["sample_rate"]
            .as_str()
            .and_then(|r| r.parse().ok())
            .unwrap_or(0),
        channels: stream["channels"].as_u64().unwrap_or(0) as u32,
    })
}

/// Probe one media file with the ffprobe sidecar; images flow through it too (one code path, image2 reports a single video stream), and `kind` is decided by extension so a still is never given a bogus fps/duration.
pub(crate) async fn probe_media(app: &AppHandle, abs: &Path) -> Result<ProbeInfo, String> {
    let abs_str = abs.to_string_lossy().into_owned();
    let probe = run_sidecar(
        app,
        "ffprobe",
        vec![
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_streams".into(),
            "-show_format".into(),
            abs_str,
        ],
        SidecarPriority::Foreground,
    )
    .await?;
    let probe: serde_json::Value =
        serde_json::from_str(&probe).map_err(|e| format!("ffprobe json: {e}"))?;
    let stream = probe["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s["codec_type"].as_str() == Some("video"))
        })
        .ok_or("no video/image stream found")?;
    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;
    let video = is_video(&extension_of(abs));
    let duration_s: f64 = if video {
        probe["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let fps = if video {
        parse_rate(stream["avg_frame_rate"].as_str().unwrap_or("0"))
    } else {
        0.0
    };
    Ok(ProbeInfo {
        kind: if video { "video".into() } else { "image".into() },
        width,
        height,
        fps,
        duration_ms: (duration_s * 1000.0).round().max(0.0) as u64,
    })
}

/// Every project file that mentions `rel` (the in-use guard): scene sidecars, scene TSX modules and project.json (audio); substring match, so a false positive only ever REFUSES a destructive action, never allows one.
fn media_references(project: &std::path::Path, rel: &str) -> Vec<String> {
    let mut hits = Vec::new();
    let mut check = |path: &std::path::Path| {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.contains(rel) {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    hits.push(name.to_owned());
                }
            }
        }
    };
    check(&project.join(MANIFEST_FILENAME));
    if let Ok(entries) = std::fs::read_dir(project.join("scenes")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|s| s.to_str());
            if path.is_file() && matches!(ext, Some("json") | Some("tsx")) {
                check(&path);
            }
        }
    }
    hits.sort();
    hits
}

/// A project-relative asset path that stays inside `assets/` (no traversal, no nesting tricks), the shared validation for delete/rename.
fn validate_asset_rel(rel: &str) -> Result<(), String> {
    let ok = rel.starts_with("assets/")
        && !rel.contains("..")
        && !rel.contains('\\')
        && rel.len() > "assets/".len();
    if ok { Ok(()) } else { Err(format!("not a project asset path: {rel}")) }
}

/// Move an asset to the TRASH, refused while any scene/manifest still references it (re-point first; a broken reference would fail the next load loudly).
#[tauri::command]
pub fn delete_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<(), String> {
    workspace::validate_slug(&slug)?;
    validate_asset_rel(&rel)?;
    let project = workspace::require_root(&app, &state)?.join(&slug);
    let path = project.join(&rel);
    if !path.is_file() {
        return Err(format!("no asset at {rel}"));
    }
    let used = media_references(&project, &rel);
    if !used.is_empty() {
        return Err(format!("{rel} is still used by: {}", used.join(", ")));
    }
    workspace::trash_path(&path).map_err(|e| format!("couldn't move the file to the Trash: {e}"))
}

/// Rename an asset within `assets/`; same in-use refusal as delete, and the extension must stay (the kind, and any probe cache semantics, ride on it).
#[tauri::command]
pub fn rename_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
    new_name: String,
) -> Result<String, String> {
    workspace::validate_slug(&slug)?;
    validate_asset_rel(&rel)?;
    let name = new_name.trim();
    if name.is_empty() || name.contains('/') || name.contains("..") || name.starts_with('.') {
        return Err("the new name must be a plain file name".into());
    }
    let old_ext = std::path::Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let new_ext = std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !old_ext.eq_ignore_ascii_case(new_ext) {
        return Err(format!("keep the .{old_ext} extension"));
    }
    let project = workspace::require_root(&app, &state)?.join(&slug);
    let from = project.join(&rel);
    if !from.is_file() {
        return Err(format!("no asset at {rel}"));
    }
    let used = media_references(&project, &rel);
    if !used.is_empty() {
        return Err(format!("{rel} is still used by: {}", used.join(", ")));
    }
    let new_rel = format!("assets/{name}");
    let to = project.join(&new_rel);
    if to.exists() {
        return Err(format!("{new_rel} already exists"));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(new_rel)
}

/// Copy files into the project's `assets/` (slugged filenames, `-2`-style collision suffixes); non-media files are skipped with a warning. Returns the imported project-relative paths.
#[tauri::command]
pub fn import_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = workspace::require_root(&app, &state)?;
    workspace::validate_slug(&slug)?;
    let assets = root.join(&slug).join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        let ext = extension_of(&source);
        if !workspace::MEDIA_EXTENSIONS.contains(&ext.as_str()) {
            log::warn!("skipping non-media import: {}", source.display());
            continue;
        }
        let stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("media");
        let mut base = workspace::slugify(stem);
        if base.is_empty() {
            base = "media".into();
        }
        // First free name: base.ext, base-2.ext, base-3.ext, …
        let mut candidate = format!("{base}.{ext}");
        let mut n = 1u32;
        while assets.join(&candidate).exists() {
            n += 1;
            candidate = format!("{base}-{n}.{ext}");
        }
        let dest = assets.join(&candidate);
        std::fs::copy(&source, &dest)
            .map_err(|e| format!("copying {}: {e}", source.display()))?;
        imported.push(format!("assets/{candidate}"));
    }
    Ok(imported)
}

/// Metadata + thumbnails for one project asset, generated on first sight and cached by content hash; videos get a poster (25% in) and ~10 evenly-spaced scrub frames, images get a poster only.
#[tauri::command]
pub async fn media_meta(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<MediaMeta, String> {
    let root = workspace::require_root(&app, &state)?;
    let abs = resolve_asset(&root, &slug, &rel)?;
    if !abs.is_file() {
        return Err(format!("asset not found: {rel}"));
    }
    ensure_media_cache(&app, &abs, &rel).await
}

/// The cache pipeline core, shared by `media_meta` and the editor's post-render warm-up (`render_edit` calls this on its output so the library refreshes into a warm cache).
pub(crate) async fn ensure_media_cache(
    app: &AppHandle,
    abs: &Path,
    rel: &str,
) -> Result<MediaMeta, String> {
    let cache_root = media_cache_root(app)?;

    // Fast path: an unchanged (size, mtime) stamp resolves the content sha without reading the file; a mismatch re-hashes, which is exactly how changed files regenerate on view.
    let (size, mtime_ms) = file_stamp(abs)?;
    let stamp_dir = cache_root.join("by-path");
    let stamp_path = stamp_dir.join(format!("{}.json", hashed_path_key(abs)));
    let mut stamped_sha: Option<String> = None;
    if let Ok(text) = std::fs::read_to_string(&stamp_path) {
        if let Ok(stamp) = serde_json::from_str::<PathStamp>(&text) {
            if stamp.size == size && stamp.mtime_ms == mtime_ms {
                stamped_sha = Some(stamp.sha);
            }
        }
    }
    let sha = match stamped_sha {
        Some(sha) => sha,
        None => {
            let sha = sha256_file(abs)?;
            std::fs::create_dir_all(&stamp_dir).map_err(|e| e.to_string())?;
            let stamp = PathStamp {
                size,
                mtime_ms,
                sha: sha.clone(),
            };
            std::fs::write(
                &stamp_path,
                serde_json::to_string(&stamp).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            sha
        }
    };

    let cache = cache_root.join(&sha);
    let done = cache.join(".done");
    let meta_path = cache.join("meta.json");

    if done.exists() {
        if let Ok(text) = std::fs::read_to_string(&meta_path) {
            if let Ok(cached) = serde_json::from_str::<CachedMeta>(&text) {
                return Ok(hydrate(cached, &cache, rel, &sha));
            }
        }
    }

    // (Re)generate from scratch, clear partial remnants first.
    let _ = std::fs::remove_dir_all(&cache);
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let abs_str = abs.to_string_lossy().into_owned();

    // Probe (shared with the video editor, see `probe_media`).
    let probe = probe_media(app, abs).await?;
    let width = probe.width;
    let height = probe.height;
    let video = probe.kind == "video";
    let duration_s = probe.duration_ms as f64 / 1000.0;
    let fps = probe.fps;

    // UI-only JPGs, so hardware decode is free speed with zero determinism surface.
    let hardware = video && workspace::hardware_video_enabled(app);

    // Poster: 25% in for videos (skips black lead-ins), the image itself otherwise.
    let poster = cache.join("poster.jpg");
    let mut poster_args: Vec<String> = vec!["-y".into(), "-loglevel".into(), "error".into()];
    if hardware {
        poster_args.extend(["-hwaccel".into(), "videotoolbox".into()]);
    }
    if video && duration_s > 0.0 {
        poster_args.extend(["-ss".into(), format!("{:.3}", duration_s * 0.25)]);
    }
    poster_args.extend([
        "-i".into(),
        abs_str.clone(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!("scale={POSTER_WIDTH}:-2"),
        poster.to_string_lossy().into_owned(),
    ]);
    run_sidecar(app, "ffmpeg", poster_args, SidecarPriority::Background).await?;

    // Hover-scrub frames, evenly across the clip (videos only).
    let mut scrub_count = 0u32;
    if video && duration_s > 0.0 {
        let rate = f64::from(SCRUB_FRAMES) / duration_s;
        let mut scrub_args: Vec<String> = vec!["-y".into(), "-loglevel".into(), "error".into()];
        if hardware {
            scrub_args.extend(["-hwaccel".into(), "videotoolbox".into()]);
        }
        scrub_args.extend([
            "-i".into(),
            abs_str,
            "-vf".into(),
            format!("fps={rate:.6},scale={SCRUB_WIDTH}:-2"),
            "-frames:v".into(),
            SCRUB_FRAMES.to_string(),
            cache.join("scrub_%02d.jpg").to_string_lossy().into_owned(),
        ]);
        run_sidecar(app, "ffmpeg", scrub_args, SidecarPriority::Background).await?;
        scrub_count = std::fs::read_dir(&cache)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("scrub_"))
            .count() as u32;
    }

    let cached = CachedMeta {
        kind: if video { "video".into() } else { "image".into() },
        width,
        height,
        fps,
        duration_ms: (duration_s * 1000.0).round().max(0.0) as u64,
        scrub_count,
    };
    std::fs::write(
        &meta_path,
        serde_json::to_string_pretty(&cached).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&done, []).map_err(|e| e.to_string())?;

    Ok(hydrate(cached, &cache, rel, &sha))
}

/// Rebuild the absolute-path view of a cache entry (ffmpeg's %02d numbering is 1-based).
fn hydrate(cached: CachedMeta, cache: &Path, rel: &str, sha: &str) -> MediaMeta {
    MediaMeta {
        rel: rel.to_owned(),
        poster_path: cache.join("poster.jpg").to_string_lossy().into_owned(),
        scrub_paths: (1..=cached.scrub_count)
            .map(|i| {
                cache
                    .join(format!("scrub_{i:02}.jpg"))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect(),
        kind: cached.kind,
        width: cached.width,
        height: cached.height,
        fps: cached.fps,
        duration_ms: cached.duration_ms,
        sha: sha.to_owned(),
    }
}
