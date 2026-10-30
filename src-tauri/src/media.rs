//! Media library backend: imports files into a project's `assets/` and maintains a content-hash-keyed thumbnail/metadata cache (probe JSON via the ffprobe sidecar, a poster and ~10 hover-scrub frames via the ffmpeg sidecar), stored APP-GLOBALLY in `$APPDATA/cache/media/<sha>/` (beside `cache/clips`) so identical files dedupe across projects and Settings can clear it in one shot; entries are guarded by a `.done` marker plus a `POSTER_VERSION` stamp (image posters regenerate when the pipeline changes), and a by-path stamp (size+mtime → sha) keeps warm views hash-free and regenerates automatically when a file changes.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandEvent;

use crate::workspace::{self, SettingsState, MANIFEST_FILENAME};

const SCRUB_FRAMES: u32 = 10;
const POSTER_WIDTH: u32 = 640;
const SCRUB_WIDTH: u32 = 320;
/// Bumped whenever the IMAGE poster pipeline changes in a way that invalidates cached posters; entries stamped below it regenerate on next sight. 1: the JPG to PNG switch. 2: the alpha-preserving rgba encode.
const POSTER_VERSION: u32 = 2;
/// Bumped when `probe_media` changes what it reports; stale VIDEO entries re-probe in place and keep their poster and scrub frames. 1: display dimensions honour rotation metadata.
const PROBE_VERSION: u32 = 1;
/// Chart data files, the modal's picker accept list; deliberately absent from `MEDIA_EXTENSIONS`.
const CHART_DATA_EXTENSIONS: &[&str] = &["csv", "tsv", "txt"];

/// Everything the media library needs to draw one card and its hover-scrub.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub rel: String,
    pub kind: String, // "video" | "image"
    pub width: u32,
    pub height: u32,
    pub fps: f64,         // 0 for images
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
    /// Absent in entries written before the marker existed, which read as 0 and so count as stale.
    #[serde(default)]
    poster_version: u32,
    /// Absent before rotation-aware probing, which reads as 0 and so re-probes.
    #[serde(default)]
    probe_version: u32,
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

/// The content sha a file resolved to the last time the library saw it, from its by-path stamp and only while the file's size and mtime still match; no bytes are read.
fn stamped_sha(cache_root: &Path, abs: &Path) -> Option<String> {
    let (size, mtime_ms) = file_stamp(abs).ok()?;
    let stamp_path = cache_root
        .join("by-path")
        .join(format!("{}.json", hashed_path_key(abs)));
    let stamp: PathStamp = serde_json::from_str(&std::fs::read_to_string(stamp_path).ok()?).ok()?;
    (stamp.size == size && stamp.mtime_ms == mtime_ms).then_some(stamp.sha)
}

/// Every video and image under a project's `assets/`, `.originals` included (it holds footage too); the render staging and emoji rasters are never cached by content, so they are skipped.
fn media_files_in(project: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pending = vec![project.join("assets")];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let name = entry.file_name();
                if name == ".kc-render" || name == ".emoji-cache" {
                    continue;
                }
                pending.push(path);
            } else {
                let ext = extension_of(&path);
                if is_video(&ext) || workspace::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// One media file with the content sha the caches know it by.
pub(crate) struct MediaSource {
    pub path: PathBuf,
    pub sha: String,
}

/// A project's media with each file's content sha: from the by-path stamp where the library has seen the file, else hashed now. Called before the folder moves, since the caches are keyed by content and the Trash is another path.
pub(crate) fn project_media_sources(app: &AppHandle, project: &Path) -> Vec<MediaSource> {
    let Ok(cache_root) = media_cache_root(app) else {
        return Vec::new();
    };
    media_files_in(project)
        .into_iter()
        .filter_map(|path| {
            let sha = stamped_sha(&cache_root, &path).or_else(|| sha256_file(&path).ok())?;
            Some(MediaSource { path, sha })
        })
        .collect()
}

/// The shas the projects, templates and presets under `root` are known to use, from their stamps alone (never hashed): the cheap check that keeps a clip shared between two items. A file already in the Trash has no stamp that still matches, so the deleted item drops out on its own.
fn shas_in_use(cache_root: &Path, root: &Path) -> HashSet<String> {
    let mut used = HashSet::new();
    let folders = std::iter::once(root.to_path_buf()).chain([
        workspace::templates_dir(root),
        workspace::presets_dir(root),
    ]);
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.join(MANIFEST_FILENAME).is_file() {
                continue;
            }
            for file in media_files_in(&dir) {
                if let Some(sha) = stamped_sha(cache_root, &file) {
                    used.insert(sha);
                }
            }
        }
    }
    used
}

/// Drop what the caches hold for media that left the workspace: the media cache entries, conform verdicts and by-path stamps, and the clip cache entries, except content another item under `root` still maps to. Runs off the caller's thread; a cache miss later only costs a re-decode.
pub(crate) fn forget_media(app: &AppHandle, root: &Path, gone_from: &Path, sources: Vec<MediaSource>) {
    if sources.is_empty() {
        return;
    }
    let app = app.clone();
    let root = root.to_path_buf();
    let gone_from = gone_from.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(cache_root) = media_cache_root(&app) else {
            return;
        };
        let keep = shas_in_use(&cache_root, &root);
        let mut shas: Vec<String> = Vec::new();
        for source in &sources {
            let _ = std::fs::remove_file(
                cache_root
                    .join("by-path")
                    .join(format!("{}.json", hashed_path_key(&source.path))),
            );
            if !keep.contains(&source.sha) && !shas.contains(&source.sha) {
                shas.push(source.sha.clone());
            }
        }
        for sha in &shas {
            let _ = std::fs::remove_dir_all(cache_root.join(sha));
            let _ = std::fs::remove_file(cache_root.join("verdicts").join(format!("{sha}.json")));
        }
        let clips = crate::clip_cache::evict_entries(&app, &shas);
        log::info!(
            "[media] forgot {} media entries and {} clip entries for {}",
            shas.len(),
            clips.len(),
            gone_from.display()
        );
    });
}

/// Resolve an asset under the already resolved project folder, including scoped library items; refused when a link along the way leaves the project.
pub(crate) fn resolve_asset_in(project: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = rel.trim_start_matches("./");
    if !clean.starts_with("assets/") || clean.split('/').any(|part| part == "..") {
        return Err(format!("not a project asset path: {rel}"));
    }
    confine_to_project(project, clean)?;
    Ok(project.join(clean))
}

/// Where `project/rel` really leads, with every link followed: the deepest existing ancestor is what a link could redirect, so that is what is canonicalised, and whatever is missing below it is kept as written so a file about to be checked with `is_file` still resolves.
fn confine_to_project(project: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = project
        .canonicalize()
        .map_err(|e| format!("project folder {}: {e}", project.display()))?;
    let full = root.join(rel);
    let mut existing = full.as_path();
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    while std::fs::symlink_metadata(existing).is_err() {
        let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
            break;
        };
        missing.push(name);
        existing = parent;
    }
    let real = existing
        .canonicalize()
        .map_err(|_| format!("\"{rel}\" is a link that leads nowhere"))?;
    if !real.starts_with(&root) {
        return Err(format!(
            "\"{rel}\" links outside the project folder; links out of a project are not followed"
        ));
    }
    Ok(missing
        .into_iter()
        .rev()
        .fold(real, |path, name| path.join(name)))
}

/// The project soundtrack an export or a loudness pass may open: an absolute file inside the workspace-readable roots with an audio extension, so a planted playlist (an `.m3u8` named in `project.json`, say) never reaches ffmpeg.
pub(crate) fn confine_soundtrack(
    app: &AppHandle,
    state: &State<'_, workspace::SettingsState>,
    file: &str,
) -> Result<PathBuf, String> {
    check_soundtrack_file(Path::new(file))?;
    workspace::confine_readable(app, state, file)
}

/// The shape every soundtrack must have before its path is even confined: absolute, a file, an audio extension.
pub(crate) fn check_soundtrack_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() {
        return Err(format!("audio file not found: {}", path.display()));
    }
    let ext = extension_of(path);
    if !workspace::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "the soundtrack must be an audio file ({}), not .{ext}",
            workspace::AUDIO_EXTENSIONS.join(", ")
        ));
    }
    Ok(())
}

/// Whether a sidecar run competes for the background-ffmpeg cap or runs unthrottled.
pub(crate) enum SidecarPriority {
    Foreground,
    Background,
}

/// One raw RGBA frame (bottom-up, hence vflip) to a PNG on disk via the ffmpeg sidecar; shared by the autorun and bridge screenshot commands.
pub(crate) async fn write_rgba_png(
    app: &AppHandle,
    bytes: &[u8],
    width: u32,
    height: u32,
    out: &std::path::Path,
) -> Result<(), String> {
    let raw = out.with_extension("rgba");
    std::fs::write(&raw, bytes).map_err(|e| e.to_string())?;
    let result = run_sidecar(
        app,
        "ffmpeg",
        vec![
            "-y".into(),
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgba".into(),
            "-s".into(),
            format!("{width}x{height}"),
            "-i".into(),
            raw.to_string_lossy().into_owned(),
            "-vf".into(),
            "vflip".into(),
            "-frames:v".into(),
            "1".into(),
            out.to_string_lossy().into_owned(),
        ],
        SidecarPriority::Foreground,
    )
    .await;
    let _ = std::fs::remove_file(&raw);
    result.map(|_| ())
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
    let (mut rx, child) = crate::tools::sidecar(app, name)?
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
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeInfo {
    pub kind: String, // "video" | "image"
    pub width: u32,
    pub height: u32,
    pub fps: f64,         // 0 for images
    pub duration_ms: u64, // 0 for images
    /// Frames timestamped as they came rather than on a fixed cadence; false for images.
    pub vfr: bool,
    /// ffprobe's `r_frame_rate` and `avg_frame_rate`; 0 for images.
    pub r_fps: f64,
    pub avg_fps: f64,
    /// Display rotation in degrees (display matrix, else the legacy `rotate` tag); 0 when none.
    pub rotation: i64,
    /// The frame count the container declares (mp4/mov headers); None when it declares none.
    pub nb_frames: Option<u64>,
}

/// Variable frame rate: ffprobe's `r_frame_rate` (the finest cadence that indexes every timestamp) and `avg_frame_rate` agree on a constant-rate file and diverge when frames were stamped as they came (a Simulator recording reports 600 against ~15).
fn is_vfr(r_rate: f64, avg_rate: f64) -> bool {
    r_rate > 0.0 && avg_rate > 0.0 && (r_rate - avg_rate).abs() > 0.5
}

/// Copy an audio file into the project's `assets/` for use as the project soundtrack; deliberately NOT the media-import pipeline, audio has no poster/scrub cache to build. Returns the assets-relative path for `project.json.audio.file`.
#[tauri::command]
pub fn import_audio(
    app: AppHandle,
    state: State<'_, workspace::SettingsState>,
    slug: String,
    source_path: String,
) -> Result<String, String> {
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    let src = std::path::PathBuf::from(&source_path);
    let ext = extension_of(&src);
    if !workspace::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported audio type .{ext}"));
    }
    if !src.is_absolute() || !src.is_file() {
        return Err(format!("audio file not found: {source_path}"));
    }
    let assets = project.join("assets");
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
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    let src = std::path::PathBuf::from(&source_path);
    let ext = extension_of(&src);
    // gif rides along since the media grid lists it as an image; ffmpeg takes frame one.
    if !workspace::IMAGE_EXTENSIONS.contains(&ext.as_str()) && ext != "gif" {
        return Err(format!("unsupported image type .{ext}"));
    }
    if !src.is_absolute() || !src.is_file() {
        return Err(format!("image not found: {source_path}"));
    }
    let assets = project.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let dest = assets.join("app-icon.png");
    let tmp = assets.join("app-icon.tmp.png");
    if ext == "png" {
        std::fs::copy(&src, &tmp).map_err(|e| format!("copying icon: {e}"))?;
    } else {
        let args: Vec<String> = vec![
            "-y".into(),
            "-nostdin".into(),
            "-loglevel".into(),
            "error".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
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
    // A replaced icon is a user action, so it surfaces like any fresh import.
    workspace::touch_now(&dest);
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

/// The head of every poster and scrub lane: no terminal, no protocol but a local file.
fn media_lane_head() -> Vec<String> {
    vec![
        "-y".into(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
    ]
}

/// The ffprobe arguments every media probe runs.
pub(crate) fn probe_args(abs: &Path) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-print_format".into(),
        "json".into(),
        "-show_streams".into(),
        "-show_format".into(),
        abs.to_string_lossy().into_owned(),
    ]
}

/// Read a probe's JSON; images flow through it too (one code path, image2 reports a single video stream), and `kind` is decided by extension so a still is never given a bogus fps/duration.
pub(crate) fn parse_probe(stdout: &str, abs: &Path) -> Result<ProbeInfo, String> {
    let probe: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("ffprobe json: {e}"))?;
    let stream = probe["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s["codec_type"].as_str() == Some("video"))
        })
        .ok_or("no video/image stream found")?;
    let (width, height) = display_dimensions(stream);
    let video = is_video(&extension_of(abs));
    let duration_s: f64 = if video {
        probe["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let rate = |key: &str| {
        if video {
            parse_rate(stream[key].as_str().unwrap_or("0"))
        } else {
            0.0
        }
    };
    let (r_fps, fps) = (rate("r_frame_rate"), rate("avg_frame_rate"));
    let vfr = video && is_vfr(r_fps, fps);
    let nb_frames = if video {
        stream["nb_frames"]
            .as_str()
            .and_then(|n| n.parse::<u64>().ok())
            .filter(|n| *n > 0)
    } else {
        None
    };
    Ok(ProbeInfo {
        kind: if video {
            "video".into()
        } else {
            "image".into()
        },
        width,
        height,
        fps,
        duration_ms: (duration_s * 1000.0).round().max(0.0) as u64,
        vfr,
        r_fps,
        avg_fps: fps,
        rotation: stream_rotation(stream).round() as i64,
        nb_frames,
    })
}

/// Probe one media file with the given ffprobe, blocking; stdin is closed so the tool can never wait on a terminal.
pub(crate) fn probe_media_at(ffprobe: &Path, abs: &Path) -> Result<ProbeInfo, String> {
    let out = crate::tools::sidecar_command(ffprobe)
        .args(probe_args(abs))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("failed to start ffprobe: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr.trim();
        return Err(if tail.is_empty() {
            format!("ffprobe exited with {:?}", out.status.code())
        } else {
            format!("ffprobe could not read {}: {tail}", abs.display())
        });
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout), abs)
}

/// Probe one media file with the bundled ffprobe sidecar, off the async runtime.
pub(crate) async fn probe_media(_app: &AppHandle, abs: &Path) -> Result<ProbeInfo, String> {
    let ffprobe = crate::tools::sidecar_path("ffprobe")?;
    let abs = abs.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || probe_media_at(&ffprobe, &abs))
        .await
        .map_err(|e| format!("probe task failed: {e}"))?
}

/// The display rotation in degrees: the display matrix side data, else the legacy `rotate` tag.
fn stream_rotation(stream: &serde_json::Value) -> f64 {
    let side_data = stream["side_data_list"].as_array().and_then(|list| {
        list.iter().find_map(|entry| {
            let rotation = &entry["rotation"];
            rotation
                .as_f64()
                .or_else(|| rotation.as_str().and_then(|r| r.parse().ok()))
        })
    });
    let tagged = stream["tags"]["rotate"]
        .as_str()
        .and_then(|r| r.parse::<f64>().ok());
    side_data.or(tagged).unwrap_or(0.0)
}

/// A stream's DISPLAY size: ffmpeg autorotates every frame it extracts, so a quarter-turn display matrix (or the legacy `rotate` tag) swaps the coded width and height.
fn display_dimensions(stream: &serde_json::Value) -> (u32, u32) {
    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;
    let turns = (stream_rotation(stream) / 90.0).round() as i64;
    if turns.rem_euclid(2) == 1 {
        (height, width)
    } else {
        (width, height)
    }
}

/// One project file read once: the display name the in-use guard reports, and the text it searches.
pub(crate) struct ProjectText {
    display: String,
    text: String,
}

/// Every project file a media reference can live in, read once: the manifest, scene sidecars and modules (nested folders too), edit documents, and the workspace themes the project or a scene names (`ws:<slug>`, from any `themeId`), which can reference `background.src`, `backdrop.src`, `lut.url` and environment maps. Unreadable files are skipped, and order does not matter because `references` sorts its hits.
pub(crate) fn project_texts(project: &Path) -> Vec<ProjectText> {
    let mut texts = Vec::new();
    let read = |texts: &mut Vec<ProjectText>, path: &Path, display: String| {
        if let Ok(text) = std::fs::read_to_string(path) {
            texts.push(ProjectText { display, text });
        }
    };
    read(
        &mut texts,
        &project.join(MANIFEST_FILENAME),
        MANIFEST_FILENAME.to_owned(),
    );
    let scenes = project.join("scenes");
    let mut folders = vec![scenes.clone()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                folders.push(path);
                continue;
            }
            let ext = path.extension().and_then(|s| s.to_str());
            if path.is_file() && matches!(ext, Some("json") | Some("tsx")) {
                if let Ok(rel) = path.strip_prefix(&scenes) {
                    read(&mut texts, &path, rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    // Edit documents point at their raw source videos; trashing one would break the edit.
    if let Ok(entries) = std::fs::read_dir(project.join("edits")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    let display = format!("edits/{name}");
                    read(&mut texts, &path, display);
                }
            }
        }
    }
    if let Some(themes) = workspace_themes_dir(project) {
        for slug in workspace_theme_slugs(&texts) {
            let display = format!("{}/{slug}/theme.json", crate::theme::THEMES_DIR_NAME);
            read(&mut texts, &themes.join(&slug).join("theme.json"), display);
        }
    }
    texts
}

/// The workspace's themes folder beside a project (`<root>/<slug>`) or a library item (`<root>/templates/<slug>`); None for the bundled trees, whose themes ship with the app.
fn workspace_themes_dir(project: &Path) -> Option<PathBuf> {
    let parent = project.parent()?;
    let library = matches!(
        parent.file_name().and_then(|n| n.to_str()),
        Some(crate::library::TEMPLATES_DIR_NAME | crate::library::PRESETS_DIR_NAME)
    );
    let root = if library { parent.parent()? } else { parent };
    let themes = root.join(crate::theme::THEMES_DIR_NAME);
    themes.is_dir().then_some(themes)
}

/// The workspace theme slugs any manifest or sidecar names through a `themeId` (project theme, scene themes, comparison side B), sorted.
fn workspace_theme_slugs(texts: &[ProjectText]) -> Vec<String> {
    fn collect(value: &serde_json::Value, out: &mut std::collections::BTreeSet<String>) {
        match value {
            serde_json::Value::Object(fields) => {
                let id = fields.get("themeId").and_then(serde_json::Value::as_str);
                if let Some(slug) = id.and_then(|id| id.strip_prefix("ws:")) {
                    if workspace::validate_slug(slug).is_ok() {
                        out.insert(slug.to_owned());
                    }
                }
                fields.values().for_each(|child| collect(child, out));
            }
            serde_json::Value::Array(items) => items.iter().for_each(|child| collect(child, out)),
            _ => {}
        }
    }
    let mut slugs = std::collections::BTreeSet::new();
    for file in texts {
        if !file.display.ends_with(".json") || file.display.starts_with("edits/") {
            continue;
        }
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&file.text) {
            collect(&doc, &mut slugs);
        }
    }
    slugs.into_iter().collect()
}

/// A conform's timing record beside its mezzanine (`assets/<stem>.timing.json`).
const TIMING_SUFFIX: &str = ".timing.json";

/// One glob a template literal or concatenation stands for (`assets/glyph-*.png`), and the file it came from.
struct RefPattern {
    glob: String,
    display: String,
}

/// The shared in-use rule over a project's text files (conformance cases in the kit's `asset-ref-vectors.json`): a file is referenced when its rel appears anywhere in a project file (substring, so a false positive only ever refuses a destructive action), or when it matches a glob a string literal stands for. A literal opening on `assets/` (or `./assets/`) is a glob when it carries a template substitution (`${…}` becomes `*`), is concatenated (`"assets/glyph-" + id` becomes `assets/glyph-*`) or ends in a folder (`"assets/shots/"` becomes `assets/shots/*`); `*` matches across `/`.
pub(crate) struct AssetRefs {
    texts: Vec<ProjectText>,
    patterns: Vec<RefPattern>,
}

impl AssetRefs {
    pub(crate) fn from_texts(texts: Vec<ProjectText>) -> Self {
        let patterns = texts
            .iter()
            .flat_map(|file| {
                literal_patterns(&file.text)
                    .into_iter()
                    .map(|glob| RefPattern {
                        glob,
                        display: file.display.clone(),
                    })
            })
            .collect();
        Self { texts, patterns }
    }

    /// The files that reference `rel`, sorted, each once.
    pub(crate) fn references(&self, rel: &str) -> Vec<String> {
        let mut hits: std::collections::BTreeSet<String> = self
            .texts
            .iter()
            .filter(|file| file.text.contains(rel))
            .map(|file| file.display.clone())
            .collect();
        hits.extend(
            self.patterns
                .iter()
                .filter(|p| glob_matches(&p.glob, rel))
                .map(|p| p.display.clone()),
        );
        hits.into_iter().collect()
    }

    /// Whether `rel` is in use, given every file in `assets/`: the provenance record always is, and a conform's timing record is exactly when its mezzanine is.
    pub(crate) fn in_use(&self, rel: &str, files: &[String]) -> bool {
        if rel == crate::asset_meta::META_REL {
            return true;
        }
        if let Some(stem) = rel.strip_suffix(TIMING_SUFFIX) {
            let prefix = format!("{stem}.");
            return files.iter().any(|file| {
                file.strip_prefix(&prefix)
                    .is_some_and(|ext| !ext.is_empty() && !ext.contains('.'))
                    && !self.references(file).is_empty()
            });
        }
        !self.references(rel).is_empty()
    }

    /// The globs the corpus's literals stand for, sorted, each once.
    #[cfg(test)]
    pub(crate) fn patterns(&self) -> Vec<String> {
        let globs: std::collections::BTreeSet<&str> =
            self.patterns.iter().map(|p| p.glob.as_str()).collect();
        globs.into_iter().map(str::to_owned).collect()
    }

    /// The entries of `rels` not in use and not a restored sample (`pool` names sit flat under `assets/`), input order kept.
    pub(crate) fn unused<'a>(&self, rels: &'a [String], pool: &[String]) -> Vec<&'a str> {
        rels.iter()
            .filter(|rel| !self.in_use(rel, rels))
            .filter(|rel| {
                !rel.strip_prefix("assets/")
                    .is_some_and(|name| pool.iter().any(|p| p == name))
            })
            .map(String::as_str)
            .collect()
    }
}

/// The globs the string literals in `text` stand for (see `AssetRefs`); plain literals are left to the substring match.
fn literal_patterns(text: &str) -> Vec<String> {
    const PREFIX: &str = "assets/";
    let mut out: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find(PREFIX) {
        let start = from + found;
        from = start + PREFIX.len();
        let before = &text[..start];
        let before = before.strip_suffix("./").unwrap_or(before);
        let Some(quote) = before
            .chars()
            .next_back()
            .filter(|c| matches!(c, '"' | '\'' | '`'))
        else {
            continue;
        };
        let body = &text[start + PREFIX.len()..];
        let mut glob = String::from(PREFIX);
        let mut chars = body.char_indices().peekable();
        let mut end = None;
        while let Some((i, c)) = chars.next() {
            if c == quote {
                end = Some(i);
                break;
            }
            if c == '\n' || c == '\\' {
                break;
            }
            if quote == '`' && c == '$' && chars.peek().is_some_and(|&(_, n)| n == '{') {
                let mut depth = 0u32;
                let mut closed = false;
                for (_, n) in chars.by_ref() {
                    match n {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                closed = true;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if !closed {
                    break;
                }
                if !glob.ends_with('*') {
                    glob.push('*');
                }
                continue;
            }
            glob.push(c);
        }
        let Some(end) = end else {
            continue;
        };
        let rest = &body[end + quote.len_utf8()..];
        if (rest.trim_start().starts_with('+') || glob.ends_with('/')) && !glob.ends_with('*') {
            glob.push('*');
        }
        if glob.contains('*') && !out.contains(&glob) {
            out.push(glob);
        }
    }
    out
}

/// `*` matches any run of characters, `/` included.
fn glob_matches(glob: &str, rel: &str) -> bool {
    let mut parts = glob.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = rel.strip_prefix(first) else {
        return false;
    };
    let tail: Vec<&str> = parts.collect();
    let Some((last, middle)) = tail.split_last() else {
        return rest.is_empty();
    };
    for part in middle {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// The in-use rule over a project's files, read once.
pub(crate) fn project_asset_refs(project: &Path) -> AssetRefs {
    AssetRefs::from_texts(project_texts(project))
}

/// Every project file that references `rel` (the in-use guard behind delete, rename and conform): project.json, scene sidecars and modules, edit documents and the workspace themes in use, by the shared rule (`AssetRefs`).
pub(crate) fn media_references(project: &Path, rel: &str) -> Vec<String> {
    project_asset_refs(project).references(rel)
}

/// A project-relative asset path that stays inside `assets/` (no traversal, no nesting tricks), the shared validation for delete/rename.
fn validate_asset_rel(rel: &str) -> Result<(), String> {
    let ok = rel.starts_with("assets/")
        && !rel.contains("..")
        && !rel.contains('\\')
        && rel.len() > "assets/".len();
    if ok {
        Ok(())
    } else {
        Err(format!("not a project asset path: {rel}"))
    }
}

/// Move an asset to the TRASH, refused while any scene, edit or the manifest still references it (re-point first; a broken reference would fail the next load loudly). Its cache entries go with it.
#[tauri::command]
pub async fn delete_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<(), String> {
    validate_asset_rel(&rel)?;
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    let path = project.join(&rel);
    if !path.is_file() {
        return Err(format!("no asset at {rel}"));
    }
    let used = media_references(&project, &rel);
    if !used.is_empty() {
        return Err(format!("{rel} is still used by: {}", used.join(", ")));
    }
    let timing = timing_record_for(&project, &rel);
    let sources = {
        let cache_root = media_cache_root(&app)?;
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let sha = stamped_sha(&cache_root, &path).or_else(|| sha256_file(&path).ok())?;
            Some(MediaSource { path, sha })
        })
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect::<Vec<_>>()
    };
    workspace::trash_path(&path).map_err(|e| format!("couldn't move the file to the Trash: {e}"))?;
    if let Ok(root) = workspace::require_root(&app, &state) {
        forget_media(&app, &root, &project, sources);
    }
    // A conformed video's records go with it; its original stays in `assets/.originals/`.
    if let Some(timing) = timing {
        if let Err(e) = workspace::trash_path(&project.join(&timing)) {
            log::warn!("[media] couldn't trash {timing}: {e}");
        }
    }
    if let Err(e) = crate::asset_meta::forget_asset(&project, &rel) {
        log::warn!("[media] couldn't drop {rel} from the provenance record: {e}");
    }
    Ok(())
}

/// A conformed video's timing record (`assets/<stem>.timing.json`), only when it names `rel` as its mezzanine.
fn timing_record_for(project: &Path, rel: &str) -> Option<String> {
    let (dir, name) = rel.rsplit_once('/')?;
    let (stem, _) = name.rsplit_once('.')?;
    let timing = format!("{dir}/{stem}{TIMING_SUFFIX}");
    let text = std::fs::read_to_string(project.join(&timing)).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
    (doc.pointer("/mezzanine/path")?.as_str()? == rel).then_some(timing)
}

/// One project asset nothing points at: a row in the "Delete unused" sheet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedAsset {
    pub rel: String,
    pub bytes: u64,
    pub kind: String, // "video" | "image"
}

/// Every media file in a project's `assets/` that nothing references (the shared rule, `AssetRefs`), newest added first (the grid's order). One pass over the project's text files answers every asset, and the answer comes from the same guard `delete_media` enforces, so the list can never drift from what a delete will allow. Media extensions only: fonts, HDRIs, 3D objects and chart data can be referenced from files this guard never reads, so sweeping them would risk trashing something in use. The samples `ensure_sample_assets` restores at every project load are left out, since deleting one only brings it back.
#[tauri::command]
pub fn unused_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<UnusedAsset>, String> {
    let project = workspace::project_dir(&app, &state, &slug)?;
    let rels = workspace::project_media_rels(&project)?;
    let pool = workspace::backfilled_sample_names(&app);
    Ok(project_asset_refs(&project)
        .unused(&rels, &pool)
        .into_iter()
        .map(|rel| UnusedAsset {
            bytes: std::fs::metadata(project.join(rel))
                .map(|m| m.len())
                .unwrap_or(0),
            kind: if is_video(&extension_of(Path::new(rel))) {
                "video".to_owned()
            } else {
                "image".to_owned()
            },
            rel: rel.to_owned(),
        })
        .collect())
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
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
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

/// Slugged stem + lowercased extension for an incoming file; None when the extension is not a media type.
fn media_stem_and_ext(path: &Path) -> Option<(String, String)> {
    let ext = extension_of(path);
    if !workspace::MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("media");
    let mut base = workspace::slugify(stem);
    if base.is_empty() {
        base = "media".into();
    }
    Some((base, ext))
}

/// First free name in `assets`: base.ext, base-2.ext, base-3.ext, …
fn free_asset_name(assets: &Path, base: &str, ext: &str) -> String {
    let mut candidate = format!("{base}.{ext}");
    let mut n = 1u32;
    while assets.join(&candidate).exists() {
        n += 1;
        candidate = format!("{base}-{n}.{ext}");
    }
    candidate
}

/// Copy files into the project's `assets/` (slugged filenames, `-2`-style collision suffixes); non-media files are skipped with a warning. A video the conform probe flags (Settings: Conform new videos) lands as its original in `assets/.originals/` while a background job writes the mezzanine, so its returned rel names a file that appears when the job finishes. Returns the imported project-relative paths.
#[tauri::command]
pub async fn import_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    std::fs::create_dir_all(project.join("assets")).map_err(|e| e.to_string())?;
    let conform_on = conform_new_videos(&app);
    let _serial = IMPORTS.lock().await;
    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        let Some((base, ext)) = media_stem_and_ext(&source) else {
            log::warn!("skipping non-media import: {}", source.display());
            continue;
        };
        let incoming = Incoming::Path(source);
        imported.push(import_one(&app, &slug, &project, incoming, &base, &ext, conform_on).await?);
    }
    Ok(imported)
}

/// Imports pick free names and then write them across an await (the probe), so they take turns, as they did when imports were synchronous.
static IMPORTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// An import parked in `assets/.originals/` while it is probed; removed unless it moved on.
struct Landing(PathBuf);

impl Drop for Landing {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Where an import's bytes come from.
enum Incoming {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

impl Incoming {
    fn write_to(&self, dest: &Path) -> Result<(), String> {
        match self {
            Incoming::Path(source) => std::fs::copy(source, dest)
                .map(|_| ())
                .map_err(|e| format!("copying {}: {e}", source.display())),
            Incoming::Bytes(bytes) => std::fs::write(dest, bytes).map_err(|e| e.to_string()),
        }
    }
}

/// One file into `assets/`: today's copy, or (a flagged video with conform on) the original into `assets/.originals/` and a queued conform job.
async fn import_one(
    app: &AppHandle,
    slug: &str,
    project: &Path,
    incoming: Incoming,
    base: &str,
    ext: &str,
    conform_on: bool,
) -> Result<String, String> {
    let assets = project.join("assets");
    if !(conform_on && is_video(ext)) {
        let candidate = free_asset_name(&assets, base, ext);
        let dest = assets.join(&candidate);
        incoming.write_to(&dest)?;
        workspace::touch_now(&dest);
        return Ok(format!("assets/{candidate}"));
    }
    let originals = assets.join(crate::conform::ORIGINALS_DIR);
    std::fs::create_dir_all(&originals).map_err(|e| e.to_string())?;
    // Probed where it lands if it conforms, so a clean file costs one rename, never a second copy.
    let landing = Landing(originals.join(format!(
        ".incoming-{}-{}.{ext}",
        std::process::id(),
        next_seq()
    )));
    incoming.write_to(&landing.0)?;
    let probe_path = landing.0.clone();
    let recommended = tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = crate::tools::sidecar_path("ffprobe")?;
        let (ff, av) = crate::conform::probe_static(&ffprobe, &probe_path)?;
        Ok::<bool, String>(crate::conform::evaluate(&ff, av.as_ref(), None).recommended)
    })
    .await
    .map_err(|e| format!("probe task failed: {e}"))?
    .unwrap_or_else(|e| {
        log::warn!("[conform] probe failed, importing as is: {e}");
        false
    });
    if !recommended {
        let candidate = free_asset_name(&assets, base, ext);
        let dest = assets.join(&candidate);
        std::fs::rename(&landing.0, &dest).map_err(|e| e.to_string())?;
        workspace::touch_now(&dest);
        return Ok(format!("assets/{candidate}"));
    }
    let stem = free_conform_stem(&assets, base, ext, &reserved_rels(app, slug));
    let original_rel = format!("assets/{}/{stem}.{ext}", crate::conform::ORIGINALS_DIR);
    std::fs::rename(&landing.0, project.join(&original_rel)).map_err(|e| e.to_string())?;
    let plan = crate::conform::plan(
        &original_rel,
        Some(&stem),
        crate::conform::KeepOriginal::Move,
        false,
    )
    .map_err(String::from)?;
    let rel = plan.target_rel.clone();
    start_conform_job(app, slug, project, plan, true);
    Ok(rel)
}

fn next_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The first stem whose mezzanine, timing record and original are all free and no pending job has claimed: base, base-2, base-3, …
fn free_conform_stem(assets: &Path, base: &str, ext: &str, reserved: &[String]) -> String {
    let taken = |stem: &str| {
        assets.join(format!("{stem}.mp4")).exists()
            || assets.join(format!("{stem}.timing.json")).exists()
            || assets
                .join(crate::conform::ORIGINALS_DIR)
                .join(format!("{stem}.{ext}"))
                .exists()
            || reserved.contains(&format!("assets/{stem}.mp4"))
    };
    let mut stem = base.to_owned();
    let mut n = 1u32;
    while taken(&stem) {
        n += 1;
        stem = format!("{base}-{n}");
    }
    stem
}

/// One conform the app is running, for the library's "Conforming…" card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformJob {
    pub slug: String,
    /// The mezzanine's rel: where the file appears when the job lands.
    pub rel: String,
    pub original: String,
    pub frame: u64,
    pub total: u64,
    #[serde(skip)]
    pub(crate) cancel: std::sync::Arc<ConformCancel>,
}

/// A job's stop request: the flag the conform loops poll, and a wake-up for a job still waiting for a background slot.
#[derive(Debug, Default)]
pub(crate) struct ConformCancel {
    flag: std::sync::atomic::AtomicBool,
    wake: tokio::sync::Notify,
}

impl ConformCancel {
    fn cancel(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        self.wake.notify_one();
    }

    fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        while !self.is_cancelled() {
            self.wake.notified().await;
        }
    }
}

/// The error a cancelled conform fails with, so the library can tell a stop from a failure.
const CONFORM_CANCELLED: &str = "cancelled";

/// Conform jobs in flight, app-wide.
#[derive(Default)]
pub(crate) struct ConformJobs(std::sync::Mutex<Vec<ConformJob>>);

const CONFORM_EVENT: &str = "kookaburra://conform-progress";

/// A job's progress for the library: `queued`, `conforming`, `done` or `failed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConformProgress<'a> {
    slug: &'a str,
    rel: &'a str,
    stage: &'static str,
    frame: u64,
    total: u64,
    error: Option<String>,
}

fn with_jobs<T>(app: &AppHandle, edit: impl FnOnce(&mut Vec<ConformJob>) -> T) -> Option<T> {
    app.state::<ConformJobs>()
        .0
        .lock()
        .ok()
        .map(|mut jobs| edit(&mut jobs))
}

fn reserved_rels(app: &AppHandle, slug: &str) -> Vec<String> {
    with_jobs(app, |jobs| {
        jobs.iter()
            .filter(|j| j.slug == slug)
            .map(|j| j.rel.clone())
            .collect()
    })
    .unwrap_or_default()
}

fn emit_progress(app: &AppHandle, progress: ConformProgress<'_>) {
    use tauri::Emitter;
    let _ = app.emit(CONFORM_EVENT, progress);
}

/// Whether imports conform flagged videos (Settings: Conform new videos, on unless switched off).
fn conform_new_videos(app: &AppHandle) -> bool {
    let state = app.state::<SettingsState>();
    workspace::load_settings(app, &state).map_or(true, |s| !s.disable_conform_new_videos)
}

/// Run one conform on a blocking thread, publishing its progress to the job list and the library.
fn run_conform_job(
    app: &AppHandle,
    slug: &str,
    project: &Path,
    plan: &crate::conform::ConformPlan,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<crate::conform::ConformOutcome, String> {
    let tools = crate::conform::ConformTools {
        ffmpeg: crate::tools::sidecar_path("ffmpeg")?,
        ffprobe: crate::tools::sidecar_path("ffprobe")?,
        background: true,
    };
    let rel = plan.target_rel.as_str();
    let mut on = |event: crate::conform::ConformEvent| {
        let (frame, total) = match event {
            crate::conform::ConformEvent::Start { total, .. } => (0, total),
            crate::conform::ConformEvent::Progress { frame, total } => (frame, total),
        };
        with_jobs(app, |jobs| {
            if let Some(job) = jobs.iter_mut().find(|j| j.slug == slug && j.rel == rel) {
                job.frame = frame;
                job.total = total;
            }
        });
        emit_progress(
            app,
            ConformProgress {
                slug,
                rel,
                stage: "conforming",
                frame,
                total,
                error: None,
            },
        );
    };
    crate::conform::conform(project, plan, &tools, &mut on, cancel).map_err(String::from)
}

/// A conform that didn't land: the error it reports (a stop reads as `CONFORM_CANCELLED`) and the paths that changed, an import's original coming back as a plain file. An import a scene already placed comes back under the name it was placed with, so the scene keeps its video (flagged Needs conform again).
fn unwind_conform(
    project: &Path,
    plan: &crate::conform::ConformPlan,
    imported: bool,
    error: String,
    cancelled: bool,
) -> (String, Vec<String>) {
    let error = if cancelled {
        CONFORM_CANCELLED.to_owned()
    } else {
        error
    };
    let restored = imported
        .then(|| {
            let placed = !media_references(project, &plan.target_rel).is_empty();
            placed
                .then(|| restore_import_as(project, &plan.original_rel, &plan.target_rel))
                .flatten()
                .or_else(|| restore_import(project, &plan.original_rel))
        })
        .flatten();
    (error, vec![restored.unwrap_or_else(|| plan.target_rel.clone())])
}

/// Queue a conform under the background ffmpeg cap; it reports through `CONFORM_EVENT` and lands with a `media-changed` broadcast. An import whose conform fails or is cancelled falls back to its original, imported as is.
fn start_conform_job(
    app: &AppHandle,
    slug: &str,
    project: &Path,
    plan: crate::conform::ConformPlan,
    imported: bool,
) {
    let cancel = std::sync::Arc::new(ConformCancel::default());
    let job = ConformJob {
        slug: slug.to_owned(),
        rel: plan.target_rel.clone(),
        original: plan.original_rel.clone(),
        frame: 0,
        total: 0,
        cancel: cancel.clone(),
    };
    with_jobs(app, |jobs| jobs.push(job));
    emit_progress(
        app,
        ConformProgress {
            slug,
            rel: &plan.target_rel,
            stage: "queued",
            frame: 0,
            total: 0,
            error: None,
        },
    );
    let (app, slug, project) = (app.clone(), slug.to_owned(), project.to_path_buf());
    tauri::async_runtime::spawn(async move {
        // A job cancelled while it waits for a slot never takes one.
        let permit = {
            let limiter = app.state::<crate::concurrency::BackgroundLimiter>();
            tokio::select! {
                permit = limiter.acquire() => permit,
                () = cancel.cancelled() => Err(CONFORM_CANCELLED.to_owned()),
            }
        };
        let result = match permit {
            Err(e) => Err(e),
            Ok(permit) => {
                let (app, slug, project, plan, cancel) = (
                    app.clone(),
                    slug.clone(),
                    project.clone(),
                    plan.clone(),
                    cancel.clone(),
                );
                tauri::async_runtime::spawn_blocking(move || {
                    let _permit = permit;
                    let outcome = run_conform_job(&app, &slug, &project, &plan, &cancel.flag)?;
                    record_conform_origin(&project, &outcome, imported);
                    Ok(outcome)
                })
                .await
                .map_err(|e| format!("conform task failed: {e}"))
                .and_then(|r| r)
            }
        };
        let rel = plan.target_rel.as_str();
        with_jobs(&app, |jobs| {
            jobs.retain(|j| !(j.slug == slug && j.rel == rel))
        });
        let mut paths = vec![rel.to_owned()];
        let (stage, frames, error) = match result {
            Ok(outcome) => {
                workspace::touch_now(&project.join(&outcome.target_rel));
                ("done", outcome.frames, None)
            }
            Err(error) => {
                let cancelled = cancel.is_cancelled();
                if cancelled {
                    log::info!("[conform] {rel} cancelled");
                } else {
                    log::warn!("[conform] {rel} failed: {error}");
                }
                let (error, changed) = unwind_conform(&project, &plan, imported, error, cancelled);
                paths = changed;
                ("failed", 0, Some(error))
            }
        };
        emit_progress(
            &app,
            ConformProgress {
                slug: &slug,
                rel,
                stage,
                frame: frames,
                total: frames,
                error,
            },
        );
        use tauri::Emitter;
        let _ = app.emit(
            "kookaburra://media-changed",
            serde_json::json!({ "slug": slug, "paths": paths, "origin": "conform" }),
        );
    });
}

/// The mezzanine's provenance in `assets/_meta.json`: the original it came from and the conform that made it. A failed write only warns; the conform itself stands.
fn record_conform_origin(
    project: &Path,
    outcome: &crate::conform::ConformOutcome,
    imported: bool,
) {
    let source_name = outcome.original_rel.rsplit('/').next().unwrap_or_default();
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let origin = serde_json::json!({
        "kind": if imported { "import" } else { "derived" },
        "from": outcome.original_rel,
        "sourceName": source_name,
        "tool": if imported { "app import" } else { "app conform" },
        "atMs": at_ms,
    });
    let transforms = vec![serde_json::json!({
        "op": "conform",
        "fps": crate::conform::CONFORM_FPS,
        "colour": "bt709",
    })];
    if let Err(e) =
        crate::asset_meta::record_asset_origin(project, &outcome.target_rel, origin, transforms)
    {
        log::warn!("[conform] provenance for {} not recorded: {e}", outcome.target_rel);
    }
}

/// A failed import conform hands the user their file back: the original moves out of `.originals/` to a free name in `assets/`.
fn restore_import(project: &Path, original_rel: &str) -> Option<String> {
    let original = project.join(original_rel);
    let (base, ext) = media_stem_and_ext(&original)?;
    let assets = project.join("assets");
    let candidate = free_asset_name(&assets, &base, &ext);
    std::fs::rename(&original, assets.join(&candidate)).ok()?;
    workspace::touch_now(&assets.join(&candidate));
    Some(format!("assets/{candidate}"))
}

fn restore_import_as(project: &Path, original_rel: &str, target_rel: &str) -> Option<String> {
    let target = project.join(target_rel);
    if target.exists() {
        return None;
    }
    std::fs::rename(project.join(original_rel), &target).ok()?;
    workspace::touch_now(&target);
    Some(target_rel.to_owned())
}

/// The project files that reference an asset by the shared in-use rule, so the library can say what stopping its conform would affect.
#[tauri::command]
pub fn media_users(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<Vec<String>, String> {
    validate_asset_rel(&rel)?;
    let project = workspace::project_dir(&app, &state, &slug)?;
    Ok(media_references(&project, &rel))
}

/// The conform jobs running for one project, so a freshly opened library shows their cards.
#[tauri::command]
pub fn list_conform_jobs(app: AppHandle, slug: String) -> Vec<ConformJob> {
    with_jobs(&app, |jobs| {
        jobs.iter().filter(|j| j.slug == slug).cloned().collect()
    })
    .unwrap_or_default()
}

/// Conform an existing project video in place (the library's Conform action): the original moves to `assets/.originals/` and the mezzanine takes the same name and container, so every reference stays valid. Returns the rel once the job is queued.
#[tauri::command]
pub fn conform_media(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<String, String> {
    validate_asset_rel(&rel)?;
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    if !project.join(&rel).is_file() {
        return Err(format!("no asset at {rel}"));
    }
    if reserved_rels(&app, &slug).contains(&rel) {
        return Err(format!("{rel} is already conforming"));
    }
    let plan = crate::conform::plan(&rel, None, crate::conform::KeepOriginal::Move, false)
        .map_err(String::from)?;
    start_conform_job(&app, &slug, &project, plan, false);
    Ok(rel)
}

/// Ask `rel`'s job to stop; false when no such job is running or queued.
fn request_cancel(jobs: &[ConformJob], slug: &str, rel: &str) -> bool {
    let job = jobs.iter().find(|j| j.slug == slug && j.rel == rel);
    if let Some(job) = job {
        job.cancel.cancel();
    }
    job.is_some()
}

/// Stop a running or queued conform (the library's queue). It unwinds through the failure path with the error `cancelled`: an import gets its original back as a plain file, an in-place conform leaves the file as it was, and `media-changed` follows. A job whose encode already finished lands anyway.
#[tauri::command]
pub fn cancel_conform(app: AppHandle, slug: String, rel: String) -> Result<(), String> {
    if with_jobs(&app, |jobs| request_cancel(jobs, &slug, &rel)).unwrap_or(false) {
        Ok(())
    } else {
        Err(format!("{rel} isn't conforming"))
    }
}

/// One kept original in `assets/.originals/`, for the library's Remove original actions.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OriginalFile {
    /// `assets/.originals/<file>`.
    pub rel: String,
    pub bytes: u64,
    /// The conformed clip whose timing record names this original, while that clip exists.
    pub clip: Option<String>,
    /// Why it can't be removed now (a conform reads it, or a project file points at it), else None.
    pub busy: Option<String>,
}

/// What a Remove original(s) moved to the Trash.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedOriginals {
    pub count: u64,
    pub bytes: u64,
}

/// Every conform timing record under `assets/` (dot folders skipped), as (mezzanine, original) pairs.
fn timing_links(project: &Path) -> Vec<(String, String)> {
    let mut links = Vec::new();
    let mut folders = vec![project.join("assets")];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                folders.push(path);
                continue;
            }
            if !name.ends_with(TIMING_SUFFIX) {
                continue;
            }
            let doc = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            let field = |pointer: &str| {
                doc.as_ref()
                    .and_then(|d| d.pointer(pointer))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            };
            if let (Some(clip), Some(original)) = (field("/mezzanine/path"), field("/source/original")) {
                links.push((clip, original));
            }
        }
    }
    links.sort();
    links
}

/// The kept originals in `assets/.originals/`, by name; `running` lists the originals conform jobs are reading. Dot names (an import still landing) are skipped.
fn originals_in(project: &Path, running: &[String]) -> Vec<OriginalFile> {
    let dir = project.join("assets").join(crate::conform::ORIGINALS_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let links = timing_links(project);
    let refs = project_asset_refs(project);
    let mut originals: Vec<OriginalFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let meta = entry.metadata().ok()?;
            (!name.starts_with('.') && meta.is_file()).then_some((name, meta.len()))
        })
        .map(|(name, bytes)| {
            let rel = format!("assets/{}/{name}", crate::conform::ORIGINALS_DIR);
            let clip = links
                .iter()
                .find(|(clip, original)| *original == rel && project.join(clip).is_file())
                .map(|(clip, _)| clip.clone());
            let used = refs.references(&rel);
            let busy = if running.contains(&rel) {
                Some(format!("{name} is still conforming"))
            } else if !used.is_empty() {
                Some(format!("{rel} is still used by: {}", used.join(", ")))
            } else {
                None
            };
            OriginalFile {
                rel,
                bytes,
                clip,
                busy,
            }
        })
        .collect();
    originals.sort_by(|a, b| a.rel.cmp(&b.rel));
    originals
}

/// Move one original out (`dispose` is the Trash in the app) and drop the provenance links to it.
fn dispose_original(
    project: &Path,
    original: &OriginalFile,
    dispose: &dyn Fn(&Path) -> Result<(), String>,
    at_ms: u64,
) -> Result<(), String> {
    dispose(&project.join(&original.rel))?;
    if let Err(e) = crate::asset_meta::detach_original(project, &original.rel, at_ms) {
        log::warn!("[media] provenance for {} not updated: {e}", original.rel);
    }
    Ok(())
}

/// Remove the original of `rel`: a conformed clip (found through its timing record) or an `assets/.originals/` path itself. Refused while a conform reads it or a project file points at it.
fn remove_original_in(
    project: &Path,
    rel: &str,
    running: &[String],
    dispose: &dyn Fn(&Path) -> Result<(), String>,
    at_ms: u64,
) -> Result<RemovedOriginals, String> {
    validate_asset_rel(rel)?;
    let originals = originals_in(project, running);
    let found = originals
        .iter()
        .find(|o| o.rel == rel || o.clip.as_deref() == Some(rel))
        .ok_or_else(|| format!("{rel} has no kept original"))?;
    if let Some(reason) = &found.busy {
        return Err(reason.clone());
    }
    dispose_original(project, found, dispose, at_ms)?;
    Ok(RemovedOriginals {
        count: 1,
        bytes: found.bytes,
    })
}

/// Remove every original nothing needs; ones a conform reads or a project file names stay. Fails only when something was removable and nothing could be moved.
fn remove_originals_in(
    project: &Path,
    running: &[String],
    dispose: &dyn Fn(&Path) -> Result<(), String>,
    at_ms: u64,
) -> Result<RemovedOriginals, String> {
    let mut removed = RemovedOriginals::default();
    let mut errors = Vec::new();
    for original in originals_in(project, running) {
        if original.busy.is_some() {
            continue;
        }
        match dispose_original(project, &original, dispose, at_ms) {
            Ok(()) => {
                removed.count += 1;
                removed.bytes += original.bytes;
            }
            Err(e) => errors.push(e),
        }
    }
    if removed.count == 0 && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    for e in errors {
        log::warn!("[media] {e}");
    }
    Ok(removed)
}

/// The originals this project's conform jobs are reading.
fn running_originals(app: &AppHandle, slug: &str) -> Vec<String> {
    with_jobs(app, |jobs| {
        jobs.iter()
            .filter(|j| j.slug == slug)
            .map(|j| j.original.clone())
            .collect()
    })
    .unwrap_or_default()
}

fn trash_original(path: &Path) -> Result<(), String> {
    workspace::trash_path(path).map_err(|e| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        format!("couldn't move {name} to the Trash: {e}")
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The project's kept originals with their sizes and clips, for the Remove original items and the bulk label.
#[tauri::command]
pub fn list_originals(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<OriginalFile>, String> {
    let project = workspace::project_dir(&app, &state, &slug)?;
    Ok(originals_in(&project, &running_originals(&app, &slug)))
}

/// Move one clip's original to the Trash (the clip's ⋯ Remove original); the conformed clip stays and its provenance loses the link.
#[tauri::command]
pub fn remove_original(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<RemovedOriginals, String> {
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    let running = running_originals(&app, &slug);
    remove_original_in(&project, &rel, &running, &trash_original, now_ms())
}

/// Move every original nothing needs to the Trash (the library's ⋯ Remove originals).
#[tauri::command]
pub fn remove_originals(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<RemovedOriginals, String> {
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    let running = running_originals(&app, &slug);
    remove_originals_in(&project, &running, &trash_original, now_ms())
}

/// A library card's conform flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformStatus {
    pub needs_conform: bool,
    /// `ok | suspect | ffmpeg-misdecodes`.
    pub verdict: String,
    pub reasons: Vec<String>,
    pub why: Vec<String>,
    /// Why the file can't be conformed, when it can't.
    pub refused: Option<String>,
}

/// Bumped when the probe's verdict changes for the same bytes; older cached verdicts re-probe. 2: B-frames alone no longer flag. 3: the container's edit start (kb's rule).
const VERDICT_VERSION: u32 = 3;

#[derive(Serialize, Deserialize)]
struct CachedVerdict {
    version: u32,
    status: ConformStatus,
}

fn status_of(verdict: &crate::conform::Verdict) -> ConformStatus {
    ConformStatus {
        needs_conform: verdict.recommended,
        verdict: verdict.verdict.to_owned(),
        reasons: verdict.reasons.iter().map(|r| r.to_string()).collect(),
        why: verdict.why.iter().map(|r| r.to_string()).collect(),
        refused: verdict.refused.as_ref().map(|r| r.hint.to_owned()),
    }
}

/// Files the library never flags: editor renders, mezzanines this app wrote, and the samples every load restores.
fn conform_exempt(app: &AppHandle, project: &Path, rel: &str) -> bool {
    let name = rel.strip_prefix("assets/").unwrap_or(rel);
    name.ends_with("-edited.mp4")
        || crate::conform::source_is_mezzanine(project, rel)
        || workspace::backfilled_sample_names(app)
            .iter()
            .any(|s| s == name)
}

/// Whether a project video needs a conform, from a probe verdict cached by content sha (`sha` from `media_meta`); clean, exempt and non-video files never do.
#[tauri::command]
pub async fn conform_status(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
    sha: String,
) -> Result<ConformStatus, String> {
    let project = workspace::project_dir(&app, &state, &slug)?;
    let abs = resolve_asset_in(&project, &rel)?;
    if !is_video(&extension_of(&abs)) || conform_exempt(&app, &project, &rel) {
        return Ok(ConformStatus {
            needs_conform: false,
            verdict: "ok".into(),
            reasons: Vec::new(),
            why: Vec::new(),
            refused: None,
        });
    }
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("not a content sha".into());
    }
    let cache = media_cache_root(&app)?
        .join("verdicts")
        .join(format!("{sha}.json"));
    let cached = std::fs::read_to_string(&cache)
        .ok()
        .and_then(|text| serde_json::from_str::<CachedVerdict>(&text).ok())
        .filter(|c| c.version == VERDICT_VERSION);
    if let Some(cached) = cached {
        return Ok(cached.status);
    }
    let status = tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = crate::tools::sidecar_path("ffprobe")?;
        let (ff, av) = crate::conform::probe_static(&ffprobe, &abs)?;
        Ok::<ConformStatus, String>(status_of(&crate::conform::evaluate(&ff, av.as_ref(), None)))
    })
    .await
    .map_err(|e| format!("probe task failed: {e}"))??;
    if let Some(dir) = cache.parent() {
        crate::privacy::private_dir(dir).map_err(|e| e.to_string())?;
    }
    let record = CachedVerdict {
        version: VERDICT_VERSION,
        status: status.clone(),
    };
    let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    crate::write_atomic(&cache, text.as_bytes())?;
    let _ = crate::privacy::private_file(&cache);
    Ok(status)
}

/// Settings: Conform new videos.
#[tauri::command]
pub fn set_conform_new_videos(
    app: AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    workspace::update_settings(&app, &state, |settings| {
        settings.disable_conform_new_videos = !enabled
    })
}

/// One string header off a byte-import request (the slug and file name the raw-body imports carry).
fn request_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or(format!("missing {name} header"))
}

/// The final component of an incoming file name; anything path-shaped is reduced to it (the `rename_media` rule).
fn plain_file_name(name: &str) -> Result<String, String> {
    Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "the file name must be a plain name".into())
}

/// One file's bytes into the project's `assets/`: the editor window's HTML5 drops, where WKWebView exposes content but no real paths. Headers carry the slug and the dropped file's name, the body is the raw content (`write_snapshot` pattern). A flagged video conforms as in `import_media`. Returns the project-relative path, or None for a non-media extension (mirrors `import_media`'s skip).
#[tauri::command]
pub async fn import_media_bytes(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>, String> {
    let slug = request_header(&request, "x-kookaburra-slug")?;
    let name = plain_file_name(&request_header(&request, "x-kookaburra-name")?)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("import_media_bytes expects a raw binary body".into());
    };
    let Some((base, ext)) = media_stem_and_ext(Path::new(&name)) else {
        return Ok(None);
    };
    let project = workspace::project_dir_mut(&app, &state, &slug)?;
    std::fs::create_dir_all(project.join("assets")).map_err(|e| e.to_string())?;
    let incoming = Incoming::Bytes(bytes.clone());
    let conform_on = conform_new_videos(&app);
    let _serial = IMPORTS.lock().await;
    import_one(&app, &slug, &project, incoming, &base, &ext, conform_on)
        .await
        .map(Some)
}

/// One scene's terminal snapshot PNG into the project's `assets/`, OVERWRITING the canonical `terminal-<stem>.png` (the app-icon rule: an app-owned asset with one home, so recaptures never litter collision suffixes; `assetVersionStore` cache-busts readers). Headers carry the slug and the scene stem, the body is the raw PNG; temp-then-rename so a failed write never truncates the previous bake. Returns the project-relative path.
#[tauri::command]
pub fn write_terminal_snapshot(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<String, String> {
    let slug = request_header(&request, "x-kookaburra-slug")?;
    let stem = request_header(&request, "x-kookaburra-stem")?;
    if stem.is_empty()
        || !stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("the scene stem must be a plain name".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_terminal_snapshot expects a raw binary body".into());
    };
    let assets = workspace::project_dir_mut(&app, &state, &slug)?.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let name = format!("terminal-{stem}.png");
    let tmp = assets.join(format!("terminal-{stem}.tmp.png"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let dest = assets.join(&name);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    workspace::touch_now(&dest);
    Ok(format!("assets/{name}"))
}

/// One picked CSV's bytes into the project's `assets/`, for the chart data modal: the copy beside the project is what lets Re-import re-read the numbers silently. Same headers, raw body, slugged stem and collision suffixes as `import_media_bytes`, but the delimited types stay out of `MEDIA_EXTENSIONS` so the file never surfaces in a media browser. Returns the project-relative path.
#[tauri::command]
pub fn import_chart_data(
    app: AppHandle,
    state: State<'_, SettingsState>,
    request: tauri::ipc::Request,
) -> Result<String, String> {
    let slug = request_header(&request, "x-kookaburra-slug")?;
    let name = plain_file_name(&request_header(&request, "x-kookaburra-name")?)?;
    let name = Path::new(&name);
    let ext = extension_of(name);
    if !CHART_DATA_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "chart data must be one of: {}",
            CHART_DATA_EXTENSIONS.join(", ")
        ));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("import_chart_data expects a raw binary body".into());
    };
    let stem = name.file_stem().and_then(|s| s.to_str()).unwrap_or("data");
    let mut base = workspace::slugify(stem);
    if base.is_empty() {
        base = "data".into();
    }
    let assets = workspace::project_dir_mut(&app, &state, &slug)?.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let candidate = free_asset_name(&assets, &base, &ext);
    std::fs::write(assets.join(&candidate), bytes).map_err(|e| e.to_string())?;
    Ok(format!("assets/{candidate}"))
}

/// Metadata + thumbnails for one project asset, generated on first sight and cached by content hash; videos get a poster (25% in) and ~10 evenly-spaced scrub frames, images get a poster only.
#[tauri::command]
pub async fn media_meta(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<MediaMeta, String> {
    let abs = resolve_asset_in(&workspace::project_dir(&app, &state, &slug)?, &rel)?;
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
            crate::privacy::private_dir(&stamp_dir).map_err(|e| e.to_string())?;
            let stamp = PathStamp {
                size,
                mtime_ms,
                sha: sha.clone(),
            };
            crate::write_atomic(
                &stamp_path,
                serde_json::to_string(&stamp)
                    .map_err(|e| e.to_string())?
                    .as_bytes(),
            )?;
            let _ = crate::privacy::private_file(&stamp_path);
            sha
        }
    };

    let cache = cache_root.join(&sha);
    let done = cache.join(".done");
    let meta_path = cache.join("meta.json");

    if done.exists() {
        if let Ok(text) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut cached) = serde_json::from_str::<CachedMeta>(&text) {
                if !poster_is_stale(&cached) && cache.join(poster_name(&cached.kind)).is_file() {
                    if probe_is_stale(&cached) {
                        let probe = probe_media(app, abs).await?;
                        cached.width = probe.width;
                        cached.height = probe.height;
                        cached.probe_version = PROBE_VERSION;
                        crate::write_atomic(
                            &meta_path,
                            serde_json::to_string_pretty(&cached)
                                .map_err(|e| e.to_string())?
                                .as_bytes(),
                        )?;
                    }
                    return Ok(hydrate(cached, &cache, rel, &sha));
                }
            }
        }
    }

    // A `.done` entry that got here is stale (a POSTER_VERSION bump, or a missing poster): ours must replace it rather than defer to it at commit time.
    let regenerating_stale = done.exists();

    // (Re)generate from scratch into a staging sibling, renamed onto `cache` once complete, so a second app instance never reads a half-built entry.
    let staging = crate::staging_sibling(&cache)?;
    let _ = std::fs::remove_dir_all(&staging);
    crate::privacy::private_dir(&staging).map_err(|e| e.to_string())?;
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
    let poster = staging.join(poster_name(if video { "video" } else { "image" }));
    let mut poster_args: Vec<String> = media_lane_head();
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
    ]);
    if !video {
        // Left to negotiate, a pal8 source encodes a pal8 poster: swscale requantises into a fixed palette and drops tRNS, baking an opaque green matte over everything transparent. rgba also normalises ya8/rgba64 sources to one PNG colour type, and costs ~8% file size on opaque ones.
        poster_args.extend(["-pix_fmt".into(), "rgba".into()]);
    }
    poster_args.push(poster.to_string_lossy().into_owned());
    run_sidecar(app, "ffmpeg", poster_args, SidecarPriority::Background).await?;

    // Hover-scrub frames, evenly across the clip (videos only).
    let mut scrub_count = 0u32;
    if video && duration_s > 0.0 {
        let rate = f64::from(SCRUB_FRAMES) / duration_s;
        let mut scrub_args: Vec<String> = media_lane_head();
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
            staging
                .join("scrub_%02d.jpg")
                .to_string_lossy()
                .into_owned(),
        ]);
        run_sidecar(app, "ffmpeg", scrub_args, SidecarPriority::Background).await?;
        scrub_count = std::fs::read_dir(&staging)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("scrub_"))
            .count() as u32;
    }

    let cached = CachedMeta {
        kind: if video {
            "video".into()
        } else {
            "image".into()
        },
        width,
        height,
        fps,
        duration_ms: (duration_s * 1000.0).round().max(0.0) as u64,
        scrub_count,
        poster_version: POSTER_VERSION,
        probe_version: PROBE_VERSION,
    };
    std::fs::write(
        staging.join("meta.json"),
        serde_json::to_string_pretty(&cached).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(staging.join(".done"), []).map_err(|e| e.to_string())?;
    crate::privacy::seal_tree(&staging);
    if regenerating_stale {
        let _ = std::fs::remove_dir_all(&cache);
    }
    crate::commit_staged_dir(&staging, &cache)?;

    Ok(hydrate(cached, &cache, rel, &sha))
}

/// Reads a cached media thumbnail's bytes for the webview to inspect pixel data (the video window's recording detection): the asset-protocol URL taints a canvas, a same-origin blob does not. Confined to the media cache exactly like `read_clip_frame` is to the clip cache.
#[tauri::command]
pub fn read_media_thumb(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let cache_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("media");
    let requested = PathBuf::from(&path);
    let has_traversal = requested
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    if has_traversal || !requested.starts_with(&cache_root) {
        return Err(format!("refusing to read outside the media cache: {path}"));
    }
    // Canonicalise both sides so a symlink planted inside the cache can't resolve outside it (the read_clip_frame rule).
    let canon_requested = requested
        .canonicalize()
        .map_err(|e| format!("read_media_thumb: {e}"))?;
    let canon_root = cache_root
        .canonicalize()
        .map_err(|e| format!("read_media_thumb: {e}"))?;
    if !canon_requested.starts_with(&canon_root) {
        return Err(format!("refusing to read outside the media cache: {path}"));
    }
    let bytes = std::fs::read(&canon_requested).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Images keep alpha in a PNG poster (the picker draws a checkerboard behind them); videos stay JPG.
fn poster_name(kind: &str) -> &'static str {
    if kind == "image" {
        "poster.png"
    } else {
        "poster.jpg"
    }
}

/// Whether a warm entry predates the current image-poster pipeline. Only IMAGE posters ever changed, so video entries (a poster plus ~10 scrub frames, the expensive ones) stay warm across a bump.
fn poster_is_stale(cached: &CachedMeta) -> bool {
    cached.kind == "image" && cached.poster_version < POSTER_VERSION
}

/// Whether a warm VIDEO entry predates the current probe; images carry no rotation metadata this probe reads, so they never re-probe.
fn probe_is_stale(cached: &CachedMeta) -> bool {
    cached.kind == "video" && cached.probe_version < PROBE_VERSION
}

/// Rebuild the absolute-path view of a cache entry (ffmpeg's %02d numbering is 1-based).
fn hydrate(cached: CachedMeta, cache: &Path, rel: &str, sha: &str) -> MediaMeta {
    MediaMeta {
        rel: rel.to_owned(),
        poster_path: cache
            .join(poster_name(&cached.kind))
            .to_string_lossy()
            .into_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-media-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A link out of the project is refused by name, a link within it is allowed, and a missing file still resolves so callers can say it is missing.
    #[test]
    fn assets_resolve_inside_the_project_only() {
        let dir = scratch("confine");
        let project = dir.join("project");
        let outside = dir.join("outside");
        std::fs::create_dir_all(project.join("assets/sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("assets/real.png"), b"x").unwrap();
        std::fs::write(outside.join("secret.png"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.png"), project.join("assets/theirs.png")).unwrap();
        std::os::unix::fs::symlink(&outside, project.join("assets/out")).unwrap();
        std::os::unix::fs::symlink(project.join("assets/real.png"), project.join("assets/alias.png")).unwrap();
        std::os::unix::fs::symlink(dir.join("nothing"), project.join("assets/dangling.png")).unwrap();

        assert_eq!(
            resolve_asset_in(&project, "assets/real.png").unwrap(),
            project.join("assets/real.png")
        );
        assert_eq!(
            resolve_asset_in(&project, "./assets/alias.png").unwrap(),
            project.join("assets/alias.png")
        );
        assert_eq!(
            resolve_asset_in(&project, "assets/sub/missing.png").unwrap(),
            project.join("assets/sub/missing.png")
        );
        for rel in ["assets/theirs.png", "assets/out/secret.png", "assets/out/missing.png"] {
            let err = resolve_asset_in(&project, rel).unwrap_err();
            assert!(err.contains(rel) && err.contains("outside the project"), "{rel}: {err}");
        }
        let err = resolve_asset_in(&project, "assets/dangling.png").unwrap_err();
        assert!(err.contains("dangling.png"), "{err}");
        assert!(resolve_asset_in(&project, "assets/../project.json").is_err());
        assert!(resolve_asset_in(&project, "scenes/a.tsx").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A playlist named as the soundtrack never reaches ffmpeg, whatever it is called in `project.json`.
    #[test]
    fn a_planted_playlist_is_not_a_soundtrack() {
        let dir = scratch("soundtrack");
        let playlist = dir.join("bed.m3u8");
        std::fs::write(&playlist, "#EXTM3U\nhttp://example.test/leak.ts\n").unwrap();
        let err = check_soundtrack_file(&playlist).unwrap_err();
        assert!(err.contains("audio file"), "{err}");
        let track = dir.join("bed.mp3");
        std::fs::write(&track, b"ID3").unwrap();
        assert!(check_soundtrack_file(&track).is_ok());
        assert!(check_soundtrack_file(Path::new("assets/bed.mp3")).is_err());
        assert!(check_soundtrack_file(&dir.join("missing.mp3")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A deleted project's media resolves to shas from the library's stamps without reading the file, and a stamp another project holds keeps its entry alive.
    #[test]
    fn stamps_name_the_shas_a_project_leaves_behind() {
        let root = scratch("forget");
        let cache = root.join("cache");
        let gone = root.join("gone");
        let other = root.join("other");
        for project in [&gone, &other] {
            std::fs::create_dir_all(project.join("assets/.originals")).unwrap();
            std::fs::write(project.join(MANIFEST_FILENAME), "{}").unwrap();
        }
        let shared = gone.join("assets/take.mp4");
        std::fs::write(&shared, b"video bytes").unwrap();
        let only = gone.join("assets/.originals/raw.mov");
        std::fs::write(&only, b"original bytes").unwrap();
        std::fs::write(gone.join("assets/notes.txt"), b"not media").unwrap();
        let theirs = other.join("assets/take.mp4");
        std::fs::write(&theirs, b"video bytes").unwrap();

        let stamp = |abs: &Path, sha: &str| {
            let (size, mtime_ms) = file_stamp(abs).unwrap();
            let dir = cache.join("by-path");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join(format!("{}.json", hashed_path_key(abs))),
                serde_json::to_string(&PathStamp {
                    size,
                    mtime_ms,
                    sha: sha.to_owned(),
                })
                .unwrap(),
            )
            .unwrap();
        };
        stamp(&shared, "aaaa");
        stamp(&theirs, "aaaa");

        let mut files = media_files_in(&gone);
        files.sort();
        assert_eq!(files, vec![only.clone(), shared.clone()]);
        assert_eq!(stamped_sha(&cache, &shared).as_deref(), Some("aaaa"));
        assert_eq!(stamped_sha(&cache, &only), None, "never stamped, so it is hashed");
        assert_eq!(sha256_file(&only).unwrap().len(), 64);

        std::fs::create_dir_all(gone.join("assets/.kc-render")).unwrap();
        std::fs::write(gone.join("assets/.kc-render/frame.png"), b"staging").unwrap();
        assert_eq!(media_files_in(&gone).len(), 2, "render staging is never cached by content");
        let keep = shas_in_use(&cache, &root);
        assert!(keep.contains("aaaa"), "the other project still maps to it");
        assert_eq!(keep.len(), 1);
        std::fs::remove_file(&theirs).unwrap();
        std::fs::remove_file(&shared).unwrap();
        assert!(shas_in_use(&cache, &root).is_empty(), "a gone file's stamp no longer matches");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_shaped_name_is_reduced_to_its_final_component() {
        assert_eq!(plain_file_name("q3.csv").unwrap(), "q3.csv");
        assert_eq!(
            plain_file_name("../../etc/passwd.csv").unwrap(),
            "passwd.csv"
        );
        assert!(plain_file_name("..").is_err());
        assert!(plain_file_name("").is_err());
    }

    fn cached(kind: &str, poster_version: u32) -> CachedMeta {
        CachedMeta {
            kind: kind.into(),
            width: 512,
            height: 512,
            fps: 0.0,
            duration_ms: 0,
            scrub_count: 0,
            poster_version,
            probe_version: PROBE_VERSION,
        }
    }

    #[test]
    fn a_source_is_variable_frame_rate_when_the_probe_rates_disagree() {
        assert!(is_vfr(600.0, 15.196));
        assert!(!is_vfr(60.0, 60.0));
        assert!(!is_vfr(30.0, 29.99));
        assert!(!is_vfr(0.0, 30.0));
    }

    #[test]
    fn display_dimensions_swap_on_a_quarter_turn_only() {
        let stream = |extra: serde_json::Value| {
            let mut s = serde_json::json!({ "width": 2006, "height": 2852 });
            for (k, v) in extra.as_object().unwrap() {
                s[k] = v.clone();
            }
            s
        };
        assert_eq!(
            display_dimensions(&stream(serde_json::json!({}))),
            (2006, 2852)
        );
        for rotation in [-90, 90, 270, -270] {
            let s = stream(serde_json::json!({ "side_data_list": [{ "rotation": rotation }] }));
            assert_eq!(display_dimensions(&s), (2852, 2006), "rotation {rotation}");
        }
        for rotation in [0, 180, -180] {
            let s = stream(serde_json::json!({ "side_data_list": [{ "rotation": rotation }] }));
            assert_eq!(display_dimensions(&s), (2006, 2852), "rotation {rotation}");
        }
        // Older ffprobe builds report the legacy tag instead of the display matrix.
        let tagged = stream(serde_json::json!({ "tags": { "rotate": "90" } }));
        assert_eq!(display_dimensions(&tagged), (2852, 2006));
        // Side data without a rotation entry (e.g. content light level) is ignored.
        let other = stream(serde_json::json!({ "side_data_list": [{ "side_data_type": "x" }] }));
        assert_eq!(display_dimensions(&other), (2006, 2852));
    }

    #[test]
    fn parse_probe_reports_vfr_rates_rotation_and_the_declared_frame_count() {
        let out = r#"{"streams":[{"codec_type":"audio"},{"codec_type":"video","width":2622,
            "height":1206,"r_frame_rate":"600/1","avg_frame_rate":"15196/1000","nb_frames":"4019",
            "side_data_list":[{"rotation":-90}]}],"format":{"duration":"264.472000"}}"#;
        let info = parse_probe(out, Path::new("/x/rec.mov")).unwrap();
        assert_eq!(info.kind, "video");
        assert_eq!((info.width, info.height), (1206, 2622));
        assert_eq!(info.rotation, -90);
        assert!(info.vfr);
        assert_eq!(
            (info.r_fps, info.avg_fps, info.fps),
            (600.0, 15.196, 15.196)
        );
        assert_eq!(info.duration_ms, 264_472);
        assert_eq!(info.nb_frames, Some(4019));
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["rFps"], 600.0);
        assert_eq!(json["nbFrames"], 4019);
    }

    #[test]
    fn parse_probe_gives_a_still_no_rate_duration_or_frame_count() {
        let out = r#"{"streams":[{"codec_type":"video","width":1081,"height":1921,
            "r_frame_rate":"25/1","avg_frame_rate":"25/1","nb_frames":"1"}],
            "format":{"duration":"0.040000"}}"#;
        let info = parse_probe(out, Path::new("/x/shot.PNG")).unwrap();
        assert_eq!(info.kind, "image");
        assert_eq!((info.fps, info.r_fps, info.duration_ms), (0.0, 0.0, 0));
        assert!(!info.vfr);
        assert_eq!(info.nb_frames, None);
        assert!(parse_probe(r#"{"streams":[]}"#, Path::new("/x/a.mp4")).is_err());
        assert!(parse_probe("ffprobe said no", Path::new("/x/a.mp4")).is_err());
    }

    #[test]
    fn only_video_entries_from_before_rotation_aware_probing_re_probe() {
        let legacy = r#"{"kind":"video","width":2006,"height":2852,"fps":30.0,"durationMs":6000,"scrubCount":10,"posterVersion":2}"#;
        let parsed: CachedMeta = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.probe_version, 0);
        assert!(probe_is_stale(&parsed));
        assert!(!probe_is_stale(&cached("video", POSTER_VERSION)));
        let mut image = cached("image", POSTER_VERSION);
        image.probe_version = 0;
        assert!(!probe_is_stale(&image));
    }

    #[test]
    fn pre_alpha_image_posters_are_stale_but_video_entries_are_not() {
        assert!(poster_is_stale(&cached("image", 0)));
        // 1 is the JPG-to-PNG era: a PNG poster, but still the pal8-baking encode.
        assert!(poster_is_stale(&cached("image", 1)));
        assert!(!poster_is_stale(&cached("image", POSTER_VERSION)));
        // Video posters/scrub frames never changed, so a bump must not throw them away.
        assert!(!poster_is_stale(&cached("video", 0)));
    }

    #[test]
    fn an_entry_written_before_the_marker_reads_as_version_zero() {
        let legacy =
            r#"{"kind":"image","width":512,"height":512,"fps":0.0,"durationMs":0,"scrubCount":0}"#;
        let parsed: CachedMeta = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.poster_version, 0);
        assert!(poster_is_stale(&parsed));
    }

    fn file(display: &str, text: &str) -> ProjectText {
        ProjectText {
            display: display.into(),
            text: text.into(),
        }
    }

    fn refs(corpus: Vec<ProjectText>) -> AssetRefs {
        AssetRefs::from_texts(corpus)
    }

    #[test]
    fn a_mention_in_any_project_file_is_reported_once_and_sorted() {
        let corpus = refs(vec![
            file(MANIFEST_FILENAME, r#"{"audio":"assets/theme.mp3"}"#),
            file(
                "02-hero.json",
                r#"{"a":"assets/clip.mp4","b":"assets/clip.mp4"}"#,
            ),
            file("02-hero.tsx", "const src = \"assets/other.mp4\";"),
            file("edits/take.json", r#"{"source":"assets/clip.mp4"}"#),
        ]);

        assert_eq!(
            corpus.references("assets/clip.mp4"),
            vec!["02-hero.json".to_owned(), "edits/take.json".to_owned()]
        );
        assert_eq!(
            corpus.references("assets/theme.mp3"),
            vec![MANIFEST_FILENAME.to_owned()]
        );
    }

    #[test]
    fn a_near_miss_path_is_not_a_reference() {
        let corpus = refs(vec![file("02-hero.json", r#"{"a":"assets/logo-2.png"}"#)]);

        assert!(corpus.references("assets/logo.png").is_empty());
    }

    #[test]
    fn the_substring_match_only_ever_over_reports() {
        let corpus = refs(vec![file("02-hero.json", r#"{"a":"x/assets/clip.mp4"}"#)]);

        assert_eq!(
            corpus.references("assets/clip.mp4"),
            vec!["02-hero.json".to_owned()]
        );
    }

    #[test]
    fn unused_keeps_input_order_and_drops_anything_mentioned_or_pooled() {
        let corpus = refs(vec![file("02-hero.json", r#"{"a":"assets/middle.png"}"#)]);
        let rels = vec![
            "assets/first.mp4".to_owned(),
            "assets/middle.png".to_owned(),
            "assets/app-icon.png".to_owned(),
            "assets/last.png".to_owned(),
        ];

        assert_eq!(
            corpus.unused(&rels, &["app-icon.png".to_owned()]),
            vec!["assets/first.mp4", "assets/last.png"]
        );
    }

    #[test]
    fn an_empty_corpus_references_nothing() {
        assert!(refs(Vec::new()).references("assets/clip.mp4").is_empty());
    }

    #[test]
    fn template_literals_concatenations_and_folders_become_globs() {
        let text = concat!(
            "const a = `assets/glyph-${id}.png`;\n",
            "const b = \"assets/frame-\" + n + \".jpg\";\n",
            "const c = './assets/shots/';\n",
            "const d = `assets/${set}/${name}-${size}.webp`;\n",
            "const e = \"assets/plain.png\";\n",
            "// see assets/ for the files\n",
            "const f = `assets/nested-${a ? `${b}` : c}.png`;\n",
        );
        assert_eq!(
            literal_patterns(text),
            [
                "assets/glyph-*.png",
                "assets/frame-*",
                "assets/shots/*",
                "assets/*/*-*.webp",
                "assets/nested-*.png",
            ]
        );
    }

    #[test]
    fn an_unclosed_literal_or_a_line_break_makes_no_glob() {
        assert!(literal_patterns("const a = `assets/glyph-${id.png").is_empty());
        assert!(literal_patterns("const a = \"assets/glyph-\n\" + b").is_empty());
    }

    #[test]
    fn a_glob_matches_across_folders() {
        assert!(glob_matches("assets/glyph-*.png", "assets/glyph-a.png"));
        assert!(glob_matches("assets/glyph-*.png", "assets/glyph-a/b.png"));
        assert!(!glob_matches("assets/glyph-*.png", "assets/glyph-a.jpg"));
        assert!(glob_matches("assets/*/*-*.webp", "assets/set/name-2.webp"));
        assert!(!glob_matches("assets/*-*.png", "assets/name.png"));
        assert!(glob_matches("assets/shots/*", "assets/shots/a.png"));
        assert!(!glob_matches("assets/shots/*", "assets/shot.png"));
    }

    #[test]
    fn a_timing_record_follows_its_mezzanine_and_the_provenance_record_is_always_kept() {
        let corpus = refs(vec![file("01.json", r#"{"src":"assets/rec.mp4"}"#)]);
        let files = vec![
            "assets/rec.mp4".to_owned(),
            "assets/rec.timing.json".to_owned(),
            "assets/old.timing.json".to_owned(),
            "assets/_meta.json".to_owned(),
        ];
        assert!(corpus.in_use("assets/rec.timing.json", &files));
        assert!(!corpus.in_use("assets/old.timing.json", &files));
        assert!(corpus.in_use("assets/_meta.json", &files));
    }

    /// One case of the shared in-use vectors (`asset-ref-vectors.json`), laid out as a workspace on disk.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GuardCase {
        name: String,
        files: Vec<String>,
        #[serde(default)]
        sample_pool: Vec<String>,
        #[serde(default)]
        project: Option<serde_json::Value>,
        #[serde(default)]
        sidecars: std::collections::BTreeMap<String, serde_json::Value>,
        #[serde(default)]
        tsx: std::collections::BTreeMap<String, String>,
        #[serde(default)]
        edits: std::collections::BTreeMap<String, serde_json::Value>,
        #[serde(default)]
        themes: std::collections::BTreeMap<String, serde_json::Value>,
        #[serde(default)]
        patterns: Vec<String>,
        referenced: Vec<String>,
        unused: Vec<String>,
    }

    fn write_case(root: &Path, case: &GuardCase) -> PathBuf {
        let project = root.join("product-tour");
        let write = |path: PathBuf, text: String| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        for rel in &case.files {
            write(project.join(rel), String::new());
        }
        if let Some(doc) = &case.project {
            write(project.join(MANIFEST_FILENAME), doc.to_string());
        }
        for (name, doc) in &case.sidecars {
            write(project.join("scenes").join(name), doc.to_string());
        }
        for (name, text) in &case.tsx {
            write(project.join("scenes").join(name), text.clone());
        }
        for (name, doc) in &case.edits {
            write(project.join("edits").join(name), doc.to_string());
        }
        std::fs::create_dir_all(root.join(crate::theme::THEMES_DIR_NAME)).unwrap();
        for (slug, doc) in &case.themes {
            write(
                root.join(crate::theme::THEMES_DIR_NAME)
                    .join(slug)
                    .join("theme.json"),
                doc.to_string(),
            );
        }
        project
    }

    #[test]
    fn the_shared_asset_reference_vectors_hold() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/asset-ref-vectors.json",
        );
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(doc["version"], 1);
        let cases: Vec<GuardCase> = serde_json::from_value(doc["cases"].clone()).unwrap();
        assert!(cases.len() >= 8);
        for (i, case) in cases.iter().enumerate() {
            let root =
                std::env::temp_dir().join(format!("kc-guard-{}-{i}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let project = write_case(&root, case);
            let corpus = project_asset_refs(&project);
            let mut files = case.files.clone();
            files.sort();
            let referenced: Vec<String> = files
                .iter()
                .filter(|rel| corpus.in_use(rel, &files))
                .cloned()
                .collect();
            let unused: Vec<String> = corpus
                .unused(&files, &case.sample_pool)
                .into_iter()
                .map(str::to_owned)
                .collect();
            let mut want_referenced = case.referenced.clone();
            want_referenced.sort();
            let mut want_unused = case.unused.clone();
            want_unused.sort();
            let mut want_patterns = case.patterns.clone();
            want_patterns.sort();
            assert_eq!(referenced, want_referenced, "{}: referenced", case.name);
            assert_eq!(unused, want_unused, "{}: unused", case.name);
            assert_eq!(corpus.patterns(), want_patterns, "{}: patterns", case.name);
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn a_library_item_reads_the_workspace_themes_beside_its_folder() {
        let root = std::env::temp_dir().join(format!("kc-guard-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let item = root.join(crate::library::TEMPLATES_DIR_NAME).join("deck");
        std::fs::create_dir_all(&item).unwrap();
        std::fs::write(item.join(MANIFEST_FILENAME), r#"{"themeId":"ws:brand"}"#).unwrap();
        let theme = root.join(crate::theme::THEMES_DIR_NAME).join("brand");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(
            theme.join("theme.json"),
            r#"{"background":{"type":"image","src":"assets/wall.png"}}"#,
        )
        .unwrap();
        assert_eq!(
            media_references(&item, "assets/wall.png"),
            ["themes/brand/theme.json"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_timing_record_is_found_only_for_its_own_mezzanine() {
        let project = scratch_assets("timing");
        std::fs::write(
            project.join("assets/rec.timing.json"),
            r#"{"mezzanine":{"path":"assets/rec.mp4"}}"#,
        )
        .unwrap();
        assert_eq!(
            timing_record_for(&project, "assets/rec.mp4").as_deref(),
            Some("assets/rec.timing.json")
        );
        assert_eq!(timing_record_for(&project, "assets/rec.mov"), None);
        assert_eq!(timing_record_for(&project, "assets/other.mp4"), None);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn chart_data_stays_out_of_the_media_types() {
        assert!(media_stem_and_ext(Path::new("q3.csv")).is_none());
        for ext in CHART_DATA_EXTENSIONS {
            assert!(!workspace::MEDIA_EXTENSIONS.contains(ext));
        }
    }

    fn scratch_assets(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-media-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets/.originals")).unwrap();
        dir
    }

    #[test]
    fn a_conform_stem_skips_mezzanines_records_originals_and_pending_jobs() {
        let project = scratch_assets("stem");
        let assets = project.join("assets");
        assert_eq!(free_conform_stem(&assets, "rec", "mov", &[]), "rec");
        // A plain import of another container never blocks the mezzanine name.
        std::fs::write(assets.join("rec.mov"), b"x").unwrap();
        assert_eq!(free_conform_stem(&assets, "rec", "mov", &[]), "rec");
        std::fs::write(assets.join("rec.mp4"), b"x").unwrap();
        assert_eq!(free_conform_stem(&assets, "rec", "mov", &[]), "rec-2");
        std::fs::write(assets.join("rec-2.timing.json"), b"{}").unwrap();
        assert_eq!(free_conform_stem(&assets, "rec", "mov", &[]), "rec-3");
        std::fs::write(assets.join(".originals/rec-3.mov"), b"x").unwrap();
        let pending = vec!["assets/rec-4.mp4".to_owned()];
        assert_eq!(free_conform_stem(&assets, "rec", "mov", &pending), "rec-5");
        let _ = std::fs::remove_dir_all(&project);
    }

    fn job(slug: &str, rel: &str) -> ConformJob {
        ConformJob {
            slug: slug.into(),
            rel: rel.into(),
            original: String::new(),
            frame: 0,
            total: 0,
            cancel: Default::default(),
        }
    }

    #[test]
    fn a_cancel_reaches_only_its_own_job() {
        let jobs = vec![
            job("product-tour", "assets/rec.mp4"),
            job("product-tour", "assets/rec-2.mp4"),
            job("highlights", "assets/rec.mp4"),
        ];
        assert!(request_cancel(&jobs, "product-tour", "assets/rec.mp4"));
        assert!(jobs[0].cancel.is_cancelled());
        assert!(!jobs[1].cancel.is_cancelled());
        assert!(!jobs[2].cancel.is_cancelled());
        assert!(!request_cancel(&jobs, "product-tour", "assets/gone.mp4"));
        // The flag never reaches the library's job list.
        let json = serde_json::to_value(&jobs[0]).unwrap();
        assert!(json.get("cancel").is_none());
    }

    #[tokio::test]
    async fn a_queued_job_wakes_when_it_is_cancelled() {
        let cancel = std::sync::Arc::new(ConformCancel::default());
        let waiting = tokio::spawn({
            let cancel = cancel.clone();
            async move { cancel.cancelled().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
            .await
            .expect("the wait ends")
            .unwrap();
        // Cancelled before anyone waits: the wait returns at once.
        let early = ConformCancel::default();
        early.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), early.cancelled())
            .await
            .expect("an early cancel is kept");
    }

    #[test]
    fn a_cancelled_import_comes_back_as_a_plain_file() {
        let project = scratch_assets("cancel");
        std::fs::write(project.join("assets/.originals/rec.mov"), b"original").unwrap();
        let plan = crate::conform::plan(
            "assets/.originals/rec.mov",
            Some("rec"),
            crate::conform::KeepOriginal::Move,
            false,
        )
        .unwrap();
        let (error, paths) =
            unwind_conform(&project, &plan, true, "the conform was interrupted".into(), true);
        assert_eq!(error, CONFORM_CANCELLED);
        assert_eq!(paths, ["assets/rec.mov"]);
        assert_eq!(std::fs::read(project.join("assets/rec.mov")).unwrap(), b"original");
        assert!(!project.join("assets/.originals/rec.mov").exists());
        assert!(!project.join("assets/rec.mp4").exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_stopped_import_a_scene_placed_keeps_the_placed_name() {
        let project = scratch_assets("placed");
        std::fs::create_dir_all(project.join("scenes")).unwrap();
        std::fs::write(project.join("assets/.originals/rec.mov"), b"original").unwrap();
        std::fs::write(
            project.join("scenes/01-hero.json"),
            br#"{"version":1,"devices":[{"id":"d","model":"m","media":{"src":"assets/rec.mp4","kind":"video"}}]}"#,
        )
        .unwrap();
        let plan = crate::conform::plan(
            "assets/.originals/rec.mov",
            Some("rec"),
            crate::conform::KeepOriginal::Move,
            false,
        )
        .unwrap();
        let (error, paths) = unwind_conform(&project, &plan, true, "stopped".into(), true);
        assert_eq!(error, CONFORM_CANCELLED);
        assert_eq!(paths, ["assets/rec.mp4"]);
        assert_eq!(std::fs::read(project.join("assets/rec.mp4")).unwrap(), b"original");
        assert!(!project.join("assets/rec.mov").exists());
        assert!(!project.join("assets/.originals/rec.mov").exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_failed_or_in_place_conform_reports_its_own_error_and_rel() {
        let project = scratch_assets("unwind");
        std::fs::write(project.join("assets/clip.mov"), b"source").unwrap();
        let plan =
            crate::conform::plan("assets/clip.mov", None, crate::conform::KeepOriginal::Move, false)
                .unwrap();
        let (error, paths) = unwind_conform(&project, &plan, false, "boom".into(), false);
        assert_eq!((error.as_str(), paths), ("boom", vec!["assets/clip.mov".to_owned()]));
        let (error, _) = unwind_conform(&project, &plan, false, "boom".into(), true);
        assert_eq!(error, CONFORM_CANCELLED);
        assert_eq!(std::fs::read(project.join("assets/clip.mov")).unwrap(), b"source");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// A project with two conformed clips, one orphan original and an import still landing.
    fn originals_project(tag: &str) -> PathBuf {
        let project = scratch_assets(tag);
        let write = |rel: &str, bytes: &[u8]| std::fs::write(project.join(rel), bytes).unwrap();
        write("assets/.originals/rec.mov", &[1; 10]);
        write("assets/.originals/demo.mp4", &[2; 20]);
        write("assets/.originals/orphan.mov", &[3; 30]);
        write("assets/.originals/.incoming-1-0.mov", &[4; 40]);
        write("assets/rec.mp4", b"mezzanine");
        write("assets/demo.mp4", b"mezzanine");
        write(
            "assets/rec.timing.json",
            br#"{"source":{"original":"assets/.originals/rec.mov"},"mezzanine":{"path":"assets/rec.mp4"}}"#,
        );
        write(
            "assets/demo.timing.json",
            br#"{"source":{"original":"assets/.originals/demo.mp4"},"mezzanine":{"path":"assets/demo.mp4"}}"#,
        );
        project
    }

    fn remove_file(path: &Path) -> Result<(), String> {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }

    #[test]
    fn originals_list_with_their_clips_sizes_and_what_holds_them() {
        let project = originals_project("list");
        std::fs::create_dir_all(project.join("scenes")).unwrap();
        std::fs::write(
            project.join("scenes/01.json"),
            r#"{"media":[{"src":"assets/.originals/orphan.mov"}]}"#,
        )
        .unwrap();
        let running = vec!["assets/.originals/demo.mp4".to_owned()];
        let list = originals_in(&project, &running);
        let rels: Vec<&str> = list.iter().map(|o| o.rel.as_str()).collect();
        assert_eq!(
            rels,
            [
                "assets/.originals/demo.mp4",
                "assets/.originals/orphan.mov",
                "assets/.originals/rec.mov"
            ]
        );
        assert_eq!(list[2].clip.as_deref(), Some("assets/rec.mp4"));
        assert_eq!(list[2].bytes, 10);
        assert_eq!(list[2].busy, None);
        assert_eq!(list[0].busy.as_deref(), Some("demo.mp4 is still conforming"));
        assert_eq!(list[1].clip, None);
        assert!(list[1].busy.as_deref().unwrap().contains("01.json"));
        // A clip deleted since leaves its original an orphan.
        std::fs::remove_file(project.join("assets/rec.mp4")).unwrap();
        assert_eq!(originals_in(&project, &[])[2].clip, None);
        assert!(originals_in(&scratch_assets("list-empty"), &[]).is_empty());
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(scratch_assets("list-empty"));
    }

    #[test]
    fn remove_original_takes_the_clips_original_and_unlinks_its_provenance() {
        let project = originals_project("remove-one");
        let origin = serde_json::json!({ "kind": "import", "from": "assets/.originals/rec.mov", "sourceName": "rec.mov", "tool": "app import", "atMs": 1 });
        crate::asset_meta::record_asset_origin(&project, "assets/rec.mp4", origin, vec![])
            .unwrap();
        let removed = remove_original_in(&project, "assets/rec.mp4", &[], &remove_file, 7).unwrap();
        assert_eq!(removed, RemovedOriginals { count: 1, bytes: 10 });
        assert!(!project.join("assets/.originals/rec.mov").exists());
        assert!(project.join("assets/rec.mp4").is_file());
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(project.join(crate::asset_meta::META_REL)).unwrap(),
        )
        .unwrap();
        let origin = &meta["assets"]["assets/rec.mp4"]["origin"];
        assert!(origin.get("from").is_none());
        assert_eq!(origin["originalRemovedAtMs"], 7);
        // Named by its own path, an orphan goes too.
        let orphan =
            remove_original_in(&project, "assets/.originals/orphan.mov", &[], &remove_file, 7)
                .unwrap();
        assert_eq!(orphan.bytes, 30);
        let gone = remove_original_in(&project, "assets/rec.mp4", &[], &remove_file, 7);
        assert_eq!(gone.unwrap_err(), "assets/rec.mp4 has no kept original");
        let running = vec!["assets/.originals/demo.mp4".to_owned()];
        assert!(remove_original_in(&project, "assets/demo.mp4", &running, &remove_file, 7)
            .unwrap_err()
            .contains("still conforming"));
        assert!(project.join("assets/.originals/demo.mp4").is_file());
        assert!(remove_original_in(&project, "../x.mov", &[], &remove_file, 7).is_err());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn remove_originals_clears_everything_nothing_needs() {
        let project = originals_project("remove-all");
        let running = vec!["assets/.originals/demo.mp4".to_owned()];
        let removed = remove_originals_in(&project, &running, &remove_file, 7).unwrap();
        assert_eq!(removed, RemovedOriginals { count: 2, bytes: 40 });
        assert!(project.join("assets/.originals/demo.mp4").is_file());
        assert!(project.join("assets/.originals/.incoming-1-0.mov").is_file());
        assert!(!project.join("assets/.originals/rec.mov").exists());
        assert!(!project.join("assets/.originals/orphan.mov").exists());
        assert_eq!(
            remove_originals_in(&project, &running, &remove_file, 7).unwrap(),
            RemovedOriginals::default()
        );
        let refuse = |_: &Path| Err::<(), String>("the Trash said no".into());
        assert_eq!(
            remove_originals_in(&project, &[], &refuse, 7).unwrap_err(),
            "the Trash said no"
        );
        assert!(project.join("assets/.originals/demo.mp4").is_file());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_failed_import_conform_hands_the_original_back() {
        let project = scratch_assets("restore");
        std::fs::write(project.join("assets/rec.mov"), b"taken").unwrap();
        std::fs::write(project.join("assets/.originals/rec.mov"), b"original").unwrap();
        let restored = restore_import(&project, "assets/.originals/rec.mov").unwrap();
        assert_eq!(restored, "assets/rec-2.mov");
        assert_eq!(std::fs::read(project.join(&restored)).unwrap(), b"original");
        assert!(!project.join("assets/.originals/rec.mov").exists());
        assert_eq!(restore_import(&project, "assets/.originals/gone.mov"), None);
        let _ = std::fs::remove_dir_all(&project);
    }
}
