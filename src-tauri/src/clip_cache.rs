//! The clip extraction cache: every embedded video is decoded by the ffmpeg sidecar into a constant 60 fps PNG sequence under `$APPDATA/cache/clips/<sha>-60fps[-hw]/frame-%05d.png`, the export's only clip input. Entries fill in 120-frame chunks, each extracted with no seek and trimmed by frame number, so a chunk's PNGs are byte-identical to whole-clip extraction (the `#[ignore]` barcode test below proves it on both decode lanes) and today's whole-clip entries stay valid hits. A decode-only pass writes `count.json` (the exact frame count and size) before any frame exists; `.chunk-<first frame>` marks a finished chunk and `.done` a whole entry. Total size is capped (Settings, default 20 GB) by evicting whole chunks least recently used first, never the ones a window has pinned (its open project, a running export).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use crate::workspace;

/// Canonical extraction rate: clips are normalised to this CFR so one export frame index maps 1:1 to one source frame; must match the frontend `FPS`.
pub(crate) const CLIP_FPS: u32 = 60;
/// Frames per cache chunk; the frontend's `CHUNK_FRAMES` mirrors it.
pub(crate) const CHUNK_FRAMES: u32 = 120;
/// The cap when Settings has never set one.
pub(crate) const DEFAULT_CAP_GB: u32 = 20;
/// Eviction stops once the cache is back under this share of the cap, so the next extraction doesn't evict again at once.
const LOW_WATER: f64 = 0.9;
/// A chunk's last-use stamp moves at most this often, never per frame read.
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);
/// A chunk used this recently is never evicted: another app instance may be reading it (its pins live in that process), and readers touch a chunk at most every `TOUCH_INTERVAL`.
const RECENT_USE: Duration = Duration::from_secs(15 * 60);
/// How often deferred maintenance (a clear or an eviction another run blocked) re-checks.
const MAINTENANCE_POLL: Duration = Duration::from_secs(5);
/// Deferred maintenance gives up after this long (a stale queue ticket must not keep a task alive forever).
const MAINTENANCE_LIMIT: Duration = Duration::from_secs(6 * 60 * 60);
/// What an extraction must leave free on the volume, the two-pass mezzanine's margin: a full disk mid-extraction fails the chunk and starves everything else.
const DISK_FLOOR: u64 = 2 * 1024 * 1024 * 1024;
const COUNT_FILE: &str = "count.json";
const DONE: &str = ".done";
const PREVIEW_DIR: &str = "preview";

/// One clip entry as the frontend sees it: where its frames live, their geometry, and which chunks are on disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipInfo {
    cache_dir: String,
    frame_count: u32,
    width: u32,
    height: u32,
    fps: u32,
    chunk_frames: u32,
    /// The source's content hash, the entry's key (the registry's invalidation sweep compares against it).
    sha: String,
    /// Chunks whose PNGs are all on disk.
    chunks: Vec<u32>,
    /// Chunks whose preview JPEGs are all on disk.
    preview_chunks: Vec<u32>,
}

/// `count.json`: the decode-only pass's exact frame count and frame size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CountRecord {
    pub frames: u32,
    pub width: u32,
    pub height: u32,
}

/// Extraction progress for the "Preparing video…" chip (frames written vs the run's length); observability only.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractProgress {
    frame: u32,
    total: u32,
}

/// This session's extraction totals, for the perf probe's cold-extraction metric.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionStats {
    bytes_written: u64,
    chunks_extracted: u64,
    count_passes: u64,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Job {
    Count(PathBuf),
    Chunk(PathBuf, u32),
    Preview(PathBuf, u32),
}

impl Job {
    fn dir(&self) -> &Path {
        match self {
            Job::Count(dir) | Job::Chunk(dir, _) | Job::Preview(dir, _) => dir,
        }
    }
}

/// A source `clip_info` has hashed, so chunk requests skip the re-hash while its size and modified time hold.
#[derive(Clone, PartialEq, Eq)]
struct SourceStamp {
    dir: PathBuf,
    size: u64,
    mtime_ns: i128,
}

#[derive(Default)]
struct Inner {
    /// Entry dir names each window has pinned (its open project, a running export).
    pins: HashMap<String, HashSet<String>>,
    jobs: HashSet<Job>,
    /// Bumped whenever a job in that entry finishes, so waiters re-check the disk.
    finished: HashMap<PathBuf, watch::Sender<u64>>,
    sources: HashMap<PathBuf, SourceStamp>,
    touched: HashMap<PathBuf, Instant>,
    /// The cache's size as of the last scan plus what this process wrote since; None until the first scan.
    size_estimate: Option<u64>,
    evicting: bool,
    maintenance: bool,
    clear_pending: bool,
    stats: SessionStats,
}

#[derive(Default)]
pub(crate) struct ClipCacheState(Mutex<Inner>);

impl ClipCacheState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Removes its jobs and wakes the entry's waiters however the work ends, errors and panics included.
struct JobGuard<'a> {
    state: &'a ClipCacheState,
    jobs: Vec<Job>,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.state.lock();
        let mut dirs = HashSet::new();
        for job in &self.jobs {
            inner.jobs.remove(job);
            dirs.insert(job.dir().to_path_buf());
        }
        for dir in dirs {
            if let Some(finished) = inner.finished.get(&dir) {
                finished.send_modify(|n| *n += 1);
            }
        }
    }
}

pub(crate) fn clips_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("clips"))
}

/// An entry path the frontend handed back: inside the clip cache, no traversal, symlinks resolved.
fn confine_entry(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw);
    let has_traversal = requested
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    if has_traversal || !requested.starts_with(root) {
        return Err(format!("refusing to touch outside the clip cache: {raw}"));
    }
    // F-011: canonicalise both sides so a symlink planted inside the cache can't resolve outside it.
    let canon_requested = requested
        .canonicalize()
        .map_err(|e| format!("cannot access {raw}: {e}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("cannot access the clip cache: {e}"))?;
    if !canon_requested.starts_with(&canon_root) {
        return Err(format!("refusing to touch outside the clip cache: {raw}"));
    }
    Ok(canon_requested)
}

fn entry_name(sha: &str, hardware: bool) -> String {
    format!("{sha}-{CLIP_FPS}fps{}", if hardware { "-hw" } else { "" })
}

fn is_hardware_entry(dir: &Path) -> bool {
    dir.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with("-hw"))
}

pub(crate) fn chunk_count(frames: u32) -> u32 {
    frames.div_ceil(CHUNK_FRAMES)
}

/// A chunk's frames, `[start, end)`, clamped to the clip.
pub(crate) fn chunk_range(chunk: u32, frames: u32) -> (u32, u32) {
    let start = chunk.saturating_mul(CHUNK_FRAMES).min(frames);
    (start, start.saturating_add(CHUNK_FRAMES).min(frames))
}

fn frame_name(index: u32, ext: &str) -> String {
    format!("frame-{index:05}.{ext}")
}

fn chunk_marker(dir: &Path, chunk: u32) -> PathBuf {
    dir.join(format!(".chunk-{}", chunk * CHUNK_FRAMES))
}

fn is_whole(dir: &Path) -> bool {
    dir.join(DONE).is_file()
}

fn chunk_present(dir: &Path, chunk: u32) -> bool {
    is_whole(dir) || chunk_marker(dir, chunk).is_file()
}

fn read_count(dir: &Path) -> Option<CountRecord> {
    serde_json::from_slice(&std::fs::read(dir.join(COUNT_FILE)).ok()?).ok()
}

/// Reads width/height from a PNG's IHDR header (big-endian u32s at byte offsets 16 and 20), avoiding an image-decoding dependency; every frame of a clip shares one geometry.
fn png_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut head = [0u8; 24];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    Ok((width, height))
}

/// A whole-clip entry from before chunking: its PNGs counted, one header read. None when it holds no frames (a broken `.done`).
fn legacy_count(dir: &Path) -> Result<Option<CountRecord>, String> {
    let mut frames = 0u32;
    let mut sample: Option<PathBuf> = None;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("png") {
            frames += 1;
            sample.get_or_insert(path);
        }
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let (width, height) = png_dimensions(&sample)?;
    Ok(Some(CountRecord {
        frames,
        width,
        height,
    }))
}

/// Gives a pre-chunking whole entry its `count.json` and chunk markers, so eviction can take it a chunk at a time; bytes and `.done` are untouched.
fn adopt_whole_entry(dir: &Path) -> Result<Option<CountRecord>, String> {
    if let Some(count) = read_count(dir) {
        return Ok(Some(count));
    }
    let Some(count) = legacy_count(dir)? else {
        return Ok(None);
    };
    // The markers inherit the entry's own age, so least-recently-used order survives adoption.
    let extracted = std::fs::metadata(dir.join(DONE))
        .and_then(|m| m.modified())
        .ok();
    for chunk in 0..chunk_count(count.frames) {
        let marker = chunk_marker(dir, chunk);
        if !marker.exists() {
            let file = std::fs::File::create(&marker).map_err(|e| e.to_string())?;
            if let Some(at) = extracted {
                let _ = file.set_modified(at);
            }
        }
    }
    let json = serde_json::to_vec(&count).map_err(|e| e.to_string())?;
    crate::write_atomic(&dir.join(COUNT_FILE), &json)?;
    Ok(Some(count))
}

fn present_chunks(dir: &Path, frames: u32) -> Vec<u32> {
    let whole = is_whole(dir);
    (0..chunk_count(frames))
        .filter(|&c| whole || chunk_marker(dir, c).is_file())
        .collect()
}

fn present_previews(dir: &Path, frames: u32) -> Vec<u32> {
    let preview = dir.join(PREVIEW_DIR);
    let whole = preview.join(DONE).is_file();
    (0..chunk_count(frames))
        .filter(|&c| whole || chunk_marker(&preview, c).is_file())
        .collect()
}

fn info_for(dir: &Path, count: CountRecord, sha: &str) -> ClipInfo {
    ClipInfo {
        cache_dir: dir.to_string_lossy().into_owned(),
        frame_count: count.frames,
        width: count.width,
        height: count.height,
        fps: CLIP_FPS,
        chunk_frames: CHUNK_FRAMES,
        sha: sha.to_owned(),
        chunks: present_chunks(dir, count.frames),
        preview_chunks: present_previews(dir, count.frames),
    }
}

// ── ffmpeg argv: the only inputs to the cached bytes ───────────────────────────

fn lane_args(hardware: bool) -> Vec<String> {
    if hardware {
        vec!["-hwaccel".into(), "videotoolbox".into()]
    } else {
        Vec::new()
    }
}

/// The decode-only pass: the frame count of `fps=60` + cfr (the whole-clip extraction's own filter and sync) through the null muxer, plus one frame as a PNG for the size. Audio and subtitles never decode.
pub(crate) fn count_args(src: &str, hardware: bool, probe_png: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    args.extend(lane_args(hardware));
    args.extend(["-protocol_whitelist".into(), "file,pipe".into()]);
    args.extend(["-i".into(), src.to_owned()]);
    args.extend(
        [
            "-an",
            "-sn",
            "-dn",
            "-vf",
            "fps=60",
            "-fps_mode",
            "cfr",
            "-f",
            "null",
            "-",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            "fps=60",
            "-frames:v",
            "1",
            "-update",
            "1",
        ]
        .map(String::from),
    );
    args.push(probe_png.to_string_lossy().into_owned());
    args
}

/// Frames `[start, end)` of the clip with no seek: the fps filter pads from t=0 exactly as the whole extraction's cfr sync does (without `start_time=0` a late first frame shifts every index), and trim counts its output frames, so each PNG is byte-identical to the whole-clip one at the same global index.
pub(crate) fn chunk_args(
    src: &str,
    hardware: bool,
    start: u32,
    end: u32,
    pattern: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    args.extend(lane_args(hardware));
    args.extend([
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-i".into(),
        src.to_owned(),
        "-vf".into(),
        format!(
            "fps={CLIP_FPS}:start_time=0,trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS"
        ),
        "-fps_mode".into(),
        "passthrough".into(),
        // Cheap deflate + no predictor: identical pixels, ~2x faster writes, ~2x file size.
        "-compression_level".into(),
        "1".into(),
        "-pred".into(),
        "0".into(),
        "-start_number".into(),
        start.to_string(),
        pattern.to_string_lossy().into_owned(),
    ]);
    args
}

/// A chunk's preview JPEGs (long edge capped at 960) from its already-extracted PNGs, never the source.
fn preview_args(dir: &Path, start: u32, count: u32, out_pattern: &Path) -> Vec<String> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
        "-f".into(),
        "image2".into(),
        "-start_number".into(),
        start.to_string(),
        "-i".into(),
        dir.join("frame-%05d.png").to_string_lossy().into_owned(),
        "-frames:v".into(),
        count.to_string(),
        "-vf".into(),
        "scale=w=min(960\\,iw):h=min(960\\,ih):force_original_aspect_ratio=decrease".into(),
        "-q:v".into(),
        "4".into(),
        "-start_number".into(),
        start.to_string(),
        out_pattern.to_string_lossy().into_owned(),
    ]
}

/// `frame=N` from ffmpeg's `-progress` stream.
pub(crate) fn progress_frame(line: &str) -> Option<u32> {
    line.trim().strip_prefix("frame=")?.trim().parse().ok()
}

/// Runs one ffmpeg to completion, reporting each progress `frame=`; returns the last one. stderr (errors only) becomes the failure message.
pub(crate) fn run_ffmpeg(
    ffmpeg: &Path,
    args: &[String],
    background: bool,
    mut on_frame: impl FnMut(u32),
) -> Result<Option<u32>, String> {
    let mut child = crate::tools::sidecar_command(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    if background {
        crate::concurrency::lower_priority(child.id());
    }
    let stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let mut last = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(frame) = progress_frame(&line) {
                last = Some(frame);
                on_frame(frame);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        let detail = errors.lines().rev().find(|l| !l.trim().is_empty());
        return Err(detail.map_or_else(
            || format!("ffmpeg exited with {status}"),
            |l| l.trim().to_owned(),
        ));
    }
    Ok(last)
}

fn staging_dir(dir: &Path, tag: &str) -> PathBuf {
    dir.join(format!(".stage-{tag}-{}", std::process::id()))
}

/// What one decode reads: the ffmpeg binary, the source, its lane, and whether it runs at background priority.
#[derive(Clone, Copy)]
pub(crate) struct Decode<'a> {
    pub ffmpeg: &'a Path,
    pub src: &'a str,
    pub hardware: bool,
    pub background: bool,
}

/// The decode-only count pass into `count.json`.
pub(crate) fn run_count(decode: Decode<'_>, dir: &Path) -> Result<CountRecord, String> {
    crate::privacy::private_dir(dir).map_err(|e| e.to_string())?;
    let staging = staging_dir(dir, "count");
    let _ = std::fs::remove_dir_all(&staging);
    crate::privacy::private_dir(&staging).map_err(|e| e.to_string())?;
    let probe = staging.join("probe.png");
    let args = count_args(decode.src, decode.hardware, &probe);
    let outcome = run_ffmpeg(decode.ffmpeg, &args, decode.background, |_| {}).and_then(|frames| {
        let frames = frames.filter(|&f| f > 0).ok_or("the video has no frames")?;
        let (width, height) = png_dimensions(&probe)?;
        Ok(CountRecord {
            frames,
            width,
            height,
        })
    });
    let _ = std::fs::remove_dir_all(&staging);
    let count = outcome?;
    let json = serde_json::to_vec(&count).map_err(|e| e.to_string())?;
    crate::write_atomic(&dir.join(COUNT_FILE), &json)?;
    Ok(count)
}

/// Extracts chunks `[first, last]` in one pass, staged inside the entry and renamed in frame by frame, then marked; returns the bytes written. A short pass fails loudly rather than leaving a chunk with missing frames.
pub(crate) fn run_chunks(
    decode: Decode<'_>,
    dir: &Path,
    count: CountRecord,
    (first, last): (u32, u32),
    on_frame: impl FnMut(u32),
) -> Result<u64, String> {
    let (start, _) = chunk_range(first, count.frames);
    let (_, end) = chunk_range(last, count.frames);
    if end <= start {
        return Err(format!(
            "chunk {first} is past the clip's {} frames",
            count.frames
        ));
    }
    let staging = staging_dir(dir, &start.to_string());
    let _ = std::fs::remove_dir_all(&staging);
    crate::privacy::private_dir(&staging).map_err(|e| e.to_string())?;
    let outcome = (|| {
        let pattern = staging.join("frame-%05d.png");
        let args = chunk_args(decode.src, decode.hardware, start, end, &pattern);
        run_ffmpeg(decode.ffmpeg, &args, decode.background, on_frame)?;
        let written = std::fs::read_dir(&staging)
            .map_err(|e| e.to_string())?
            .filter(|e| e.as_ref().is_ok_and(|e| e.path().is_file()))
            .count() as u32;
        if written != end - start {
            return Err(format!(
                "extracting frames {start}-{end} wrote {written} frames, expected {}",
                end - start
            ));
        }
        let mut bytes = 0u64;
        for index in start..end {
            let name = frame_name(index, "png");
            let from = staging.join(&name);
            bytes += std::fs::metadata(&from).map_err(|e| e.to_string())?.len();
            crate::privacy::private_file(&from).map_err(|e| e.to_string())?;
            std::fs::rename(&from, dir.join(&name)).map_err(|e| e.to_string())?;
        }
        for chunk in first..=last {
            std::fs::write(chunk_marker(dir, chunk), []).map_err(|e| e.to_string())?;
        }
        if !is_whole(dir)
            && present_chunks(dir, count.frames).len() as u32 == chunk_count(count.frames)
        {
            std::fs::write(dir.join(DONE), []).map_err(|e| e.to_string())?;
        }
        Ok(bytes)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

/// One chunk's preview JPEGs, renamed into `preview/` and marked.
fn run_preview(ffmpeg: &Path, dir: &Path, count: CountRecord, chunk: u32) -> Result<(), String> {
    let (start, end) = chunk_range(chunk, count.frames);
    let preview = dir.join(PREVIEW_DIR);
    crate::privacy::private_dir(&preview).map_err(|e| e.to_string())?;
    let staging = staging_dir(&preview, &start.to_string());
    let _ = std::fs::remove_dir_all(&staging);
    crate::privacy::private_dir(&staging).map_err(|e| e.to_string())?;
    let outcome = (|| {
        let pattern = staging.join("frame-%05d.jpg");
        run_ffmpeg(
            ffmpeg,
            &preview_args(dir, start, end - start, &pattern),
            true,
            |_| {},
        )?;
        for index in start..end {
            let name = frame_name(index, "jpg");
            let _ = crate::privacy::private_file(&staging.join(&name));
            std::fs::rename(staging.join(&name), preview.join(&name))
                .map_err(|e| format!("preview frame {index}: {e}"))?;
        }
        std::fs::write(chunk_marker(&preview, chunk), []).map_err(|e| e.to_string())?;
        if present_previews(dir, count.frames).len() as u32 == chunk_count(count.frames) {
            std::fs::write(preview.join(DONE), []).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

/// The most `frames` PNGs can take: three bytes a pixel, the raw RGB ceiling the deflate never exceeds.
pub(crate) fn extraction_ceiling(frames: u32, width: u32, height: u32) -> u64 {
    u64::from(frames) * u64::from(width) * u64::from(height) * 3
}

/// Refuses an extraction whose ceiling would take the volume under the floor, naming the space it needs.
pub(crate) fn check_extraction_space(
    free: u64,
    frames: u32,
    count: CountRecord,
) -> Result<(), String> {
    let need = extraction_ceiling(frames, count.width, count.height) + DISK_FLOOR;
    if free >= need {
        return Ok(());
    }
    let gb = |bytes: u64| bytes as f64 / 1e9;
    Err(format!(
        "extracting {frames} frames needs up to {:.1} GB free and {:.1} GB is available: free {:.1} GB, or lower the clip cache cap in Settings so older frames make room",
        gb(need),
        gb(free),
        gb(need - free),
    ))
}

/// Groups sorted chunk indices into consecutive runs, each one ffmpeg pass.
pub(crate) fn chunk_runs(chunks: &[u32]) -> Vec<(u32, u32)> {
    let mut sorted = chunks.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for c in sorted {
        match runs.last_mut() {
            Some((_, last)) if *last + 1 == c => *last = c,
            _ => runs.push((c, c)),
        }
    }
    runs
}

// ── commands ────────────────────────────────────────────────────────────────────

fn file_stamp(path: &Path) -> Result<(u64, i128), String> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    Ok((
        md.len(),
        i128::from(md.mtime()) * 1_000_000_000 + i128::from(md.mtime_nsec()),
    ))
}

/// The jobs one caller now owns, whether any other wanted job is someone else's, and a subscription to the entry's finishes.
struct Claim<'a> {
    guard: JobGuard<'a>,
    waiting: bool,
    finished: watch::Receiver<u64>,
}

impl Claim<'_> {
    /// Hands the owned jobs back, then waits for another caller's job to finish (any finish after the claim counts, so none slips past).
    async fn release_and_wait(self) {
        let Claim {
            guard,
            waiting,
            mut finished,
        } = self;
        drop(guard);
        if waiting {
            let _ = finished.changed().await;
        }
    }
}

/// Under one lock: drops the wanted jobs already `done` on disk, claims the rest nobody holds, and subscribes to the entry's finishes before unlocking.
fn claim<'a>(
    state: &'a ClipCacheState,
    dir: &Path,
    wanted: Vec<Job>,
    done: impl Fn(&Job) -> bool,
) -> Claim<'a> {
    let mut inner = state.lock();
    let finished = inner
        .finished
        .entry(dir.to_path_buf())
        .or_insert_with(|| watch::channel(0).0)
        .subscribe();
    let mut mine = Vec::new();
    let mut waiting = false;
    for job in wanted {
        if done(&job) {
            continue;
        }
        if inner.jobs.contains(&job) {
            waiting = true;
        } else {
            inner.jobs.insert(job.clone());
            mine.push(job);
        }
    }
    Claim {
        guard: JobGuard { state, jobs: mine },
        waiting,
        finished,
    }
}

async fn background_permit(app: &AppHandle) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    app.state::<crate::concurrency::BackgroundLimiter>()
        .acquire()
        .await
}

/// The count an entry already has: a whole entry's (adopted on first sight) or its `count.json`.
fn known_count(dir: &Path) -> Result<Option<CountRecord>, String> {
    if is_whole(dir) {
        if let Some(count) = adopt_whole_entry(dir)? {
            return Ok(Some(count));
        }
        // A `.done` entry with no readable frames: drop the marker and fill it again.
        let _ = std::fs::remove_file(dir.join(DONE));
    }
    Ok(read_count(dir))
}

/// The entry's `count.json`, running the decode-only pass when it is missing (a second caller awaits the first).
async fn ensure_count(
    app: &AppHandle,
    state: &ClipCacheState,
    src: &str,
    dir: &Path,
) -> Result<CountRecord, String> {
    loop {
        if let Some(count) = known_count(dir)? {
            return Ok(count);
        }
        let claim = claim(state, dir, vec![Job::Count(dir.to_path_buf())], |_| {
            read_count(dir).is_some()
        });
        if claim.guard.jobs.is_empty() {
            claim.release_and_wait().await;
            continue;
        }
        let guard = claim.guard;
        let permit = background_permit(app).await?;
        let ffmpeg = crate::tools::sidecar_path("ffmpeg")?;
        let (src, hardware, entry) = (src.to_owned(), is_hardware_entry(dir), dir.to_path_buf());
        let count = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let decode = Decode {
                ffmpeg: &ffmpeg,
                src: &src,
                hardware,
                background: true,
            };
            run_count(decode, &entry)
        })
        .await
        .map_err(|e| format!("count pass failed: {e}"))??;
        state.lock().stats.count_passes += 1;
        drop(guard);
        return Ok(count);
    }
}

/// Hashes and confines the source, finds its entry for the lane, and makes sure its frame count is known (no frame is extracted here).
#[tauri::command]
pub(crate) async fn clip_info(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, ClipCacheState>,
    src_abs: String,
    // F-005: a client-supplied hash is untrusted and ignored in favour of the native recompute below.
    _sha: Option<String>,
    // VideoToolbox decode is NOT pixel-identical to software, so each lane owns its own entry; the software one is what the standing baselines were recorded from.
    hardware: bool,
) -> Result<ClipInfo, String> {
    let hardware = hardware && workspace::hardware_video_enabled(&app);
    let src_path = workspace::confine_readable(&app, &settings, &src_abs)?;
    let (size, mtime_ns) = file_stamp(&src_path)?;
    let sha = crate::sha256_file(&src_path)?;
    let dir = clips_root(&app)?.join(entry_name(&sha, hardware));
    state.lock().sources.insert(
        src_path.clone(),
        SourceStamp {
            dir: dir.clone(),
            size,
            mtime_ns,
        },
    );
    let src = src_path.to_string_lossy().into_owned();
    let count = ensure_count(&app, &state, &src, &dir).await?;
    Ok(info_for(&dir, count, &sha))
}

/// The source `ensure_clip_chunks` extracts from, proved to still hash to `dir`'s key: the stamp `clip_info` recorded, else a re-hash.
fn validated_source(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
    state: &ClipCacheState,
    src_abs: &str,
    dir: &Path,
) -> Result<PathBuf, String> {
    let src = workspace::confine_readable(app, settings, src_abs)?;
    let (size, mtime_ns) = file_stamp(&src)?;
    let known = state.lock().sources.get(&src).cloned();
    if known.is_some_and(|k| k.dir == dir && k.size == size && k.mtime_ns == mtime_ns) {
        return Ok(src);
    }
    let sha = crate::sha256_file(&src)?;
    let expected = entry_name(&sha, is_hardware_entry(dir));
    if dir.file_name().and_then(|n| n.to_str()) != Some(expected.as_str()) {
        return Err(format!(
            "{src_abs} changed since its frames were prepared; it will prepare again"
        ));
    }
    state.lock().sources.insert(
        src.clone(),
        SourceStamp {
            dir: dir.to_path_buf(),
            size,
            mtime_ns,
        },
    );
    Ok(src)
}

/// Extracts every requested chunk not yet on disk (consecutive ones in one pass), waiting on any another request is already extracting; resolves once all of them are present.
#[tauri::command]
pub(crate) async fn ensure_clip_chunks(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, ClipCacheState>,
    src_abs: String,
    cache_dir: String,
    chunks: Vec<u32>,
    on_progress: Channel<ExtractProgress>,
) -> Result<(), String> {
    let root = clips_root(&app)?;
    let dir = confine_entry(&root, &cache_dir)?;
    let src = validated_source(&app, &settings, &state, &src_abs, &dir)?;
    let src = src.to_string_lossy().into_owned();
    let count = ensure_count(&app, &state, &src, &dir).await?;
    let total = chunk_count(count.frames);
    if let Some(bad) = chunks.iter().find(|&&c| c >= total) {
        return Err(format!("chunk {bad} is past the clip's {total} chunks"));
    }
    let hardware = is_hardware_entry(&dir);
    let mut wrote = false;
    loop {
        let jobs = chunks.iter().map(|&c| Job::Chunk(dir.clone(), c)).collect();
        let claim = claim(&state, &dir, jobs, |job| match job {
            Job::Chunk(dir, c) => chunk_present(dir, *c),
            _ => false,
        });
        if claim.guard.jobs.is_empty() && !claim.waiting {
            break;
        }
        let mine: Vec<u32> = claim
            .guard
            .jobs
            .iter()
            .filter_map(|job| match job {
                Job::Chunk(_, c) => Some(*c),
                _ => None,
            })
            .collect();
        let frames: u32 = mine
            .iter()
            .map(|&c| {
                let (start, end) = chunk_range(c, count.frames);
                end - start
            })
            .sum();
        if frames > 0 {
            check_extraction_space(crate::free_disk_bytes(&root)?, frames, count)?;
        }
        for (first, last) in chunk_runs(&mine) {
            let permit = background_permit(&app).await?;
            let ffmpeg = crate::tools::sidecar_path("ffmpeg")?;
            let (start, _) = chunk_range(first, count.frames);
            let (_, end) = chunk_range(last, count.frames);
            let progress = on_progress.clone();
            let (src, entry) = (src.clone(), dir.clone());
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                let decode = Decode {
                    ffmpeg: &ffmpeg,
                    src: &src,
                    hardware,
                    background: true,
                };
                run_chunks(decode, &entry, count, (first, last), |frame| {
                    let _ = progress.send(ExtractProgress {
                        frame: frame.min(end - start),
                        total: end - start,
                    });
                })
            })
            .await
            .map_err(|e| format!("chunk extraction failed: {e}"))??;
            let mut inner = state.lock();
            inner.stats.bytes_written += bytes;
            inner.stats.chunks_extracted += u64::from(last - first + 1);
            inner.size_estimate = inner.size_estimate.map(|e| e + bytes);
            wrote = true;
        }
        claim.release_and_wait().await;
    }
    if wrote {
        schedule_eviction(&app);
    }
    Ok(())
}

/// Reads one extracted frame (PNG, or a preview JPEG) for the webview to decode into a texture, confined to the clip cache; stamps its chunk's last use at most once a minute.
#[tauri::command]
pub(crate) fn read_clip_frame(
    app: AppHandle,
    state: State<'_, ClipCacheState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root = clips_root(&app)?;
    let file = confine_entry(&root, &path)?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    touch_chunk(&state, &file);
    Ok(tauri::ipc::Response::new(bytes))
}

/// The frame index a cache file name carries (`frame-00123.png` → 123).
fn frame_index(file: &Path) -> Option<u32> {
    file.file_stem()?
        .to_str()?
        .strip_prefix("frame-")?
        .parse()
        .ok()
}

fn touch_chunk(state: &ClipCacheState, file: &Path) {
    let Some(index) = frame_index(file) else {
        return;
    };
    let Some(mut dir) = file.parent().map(Path::to_path_buf) else {
        return;
    };
    if dir.file_name().is_some_and(|n| n == PREVIEW_DIR) {
        dir.pop();
    }
    let marker = chunk_marker(&dir, index / CHUNK_FRAMES);
    let now = Instant::now();
    {
        let mut inner = state.lock();
        if inner
            .touched
            .get(&marker)
            .is_some_and(|at| now.duration_since(*at) < TOUCH_INTERVAL)
        {
            return;
        }
        inner.touched.insert(marker.clone(), now);
    }
    let target = if marker.is_file() {
        marker
    } else {
        dir.join(DONE)
    };
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&target) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// Generates one chunk's preview JPEGs (lazy, once; a second caller awaits the first). Preview playback decodes these instead of the full PNGs; exports always read the PNGs, so determinism is untouched.
#[tauri::command]
pub(crate) async fn ensure_clip_previews(
    app: AppHandle,
    state: State<'_, ClipCacheState>,
    cache_dir: String,
    chunk: u32,
) -> Result<(), String> {
    let root = clips_root(&app)?;
    let dir = confine_entry(&root, &cache_dir)?;
    let count = read_count(&dir)
        .or_else(|| {
            is_whole(&dir)
                .then(|| adopt_whole_entry(&dir).ok().flatten())
                .flatten()
        })
        .ok_or("ensure_clip_previews: the clip's frame count is unknown")?;
    if chunk >= chunk_count(count.frames) {
        return Err(format!("chunk {chunk} is past the clip"));
    }
    loop {
        if !chunk_present(&dir, chunk) {
            return Err("ensure_clip_previews: the chunk is not extracted".into());
        }
        if present_previews(&dir, count.frames).contains(&chunk) {
            return Ok(());
        }
        let claim = claim(&state, &dir, vec![Job::Preview(dir.clone(), chunk)], |_| {
            present_previews(&dir, count.frames).contains(&chunk)
        });
        if claim.guard.jobs.is_empty() {
            claim.release_and_wait().await;
            continue;
        }
        let guard = claim.guard;
        let permit = background_permit(&app).await?;
        let ffmpeg = crate::tools::sidecar_path("ffmpeg")?;
        let entry = dir.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            run_preview(&ffmpeg, &entry, count, chunk)
        })
        .await
        .map_err(|e| format!("preview generation failed: {e}"))?;
        drop(guard);
        return result;
    }
}

/// Replaces the calling window's pinned entries (its open project's clips plus whatever a running export holds); eviction never takes a pinned chunk.
#[tauri::command]
pub(crate) fn set_clip_cache_pins(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, ClipCacheState>,
    dirs: Vec<String>,
) -> Result<(), String> {
    let root = clips_root(&app)?;
    let names: HashSet<String> = dirs
        .iter()
        .filter_map(|d| {
            let path = Path::new(d);
            (path.parent() == Some(root.as_path()))
                .then(|| path.file_name()?.to_str().map(str::to_owned))
                .flatten()
        })
        .collect();
    state.lock().pins.insert(webview.label().to_owned(), names);
    Ok(())
}

#[tauri::command]
pub(crate) fn clip_cache_session_stats(state: State<'_, ClipCacheState>) -> SessionStats {
    state.lock().stats
}

/// A conform job naming `src_abs` as a mezzanine that hasn't landed yet: the registry holds such a clip pending (no extraction, no error) until its `media-changed` arrives.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingConform {
    slug: String,
    rel: String,
    frame: u64,
    total: u64,
}

#[tauri::command]
pub(crate) fn clip_conform_pending(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    src_abs: String,
) -> Option<PendingConform> {
    let src = PathBuf::from(&src_abs);
    if src.exists() {
        return None;
    }
    let root = workspace::require_root(&app, &settings).ok()?;
    let rest = src.strip_prefix(&root).ok()?;
    let mut parts = rest.components();
    let slug = parts.next()?.as_os_str().to_str()?.to_owned();
    let rel = parts.as_path().to_str()?.to_owned();
    crate::media::list_conform_jobs(app, slug.clone())
        .into_iter()
        .find(|job| job.rel == rel)
        .map(|job| PendingConform {
            slug,
            rel,
            frame: job.frame,
            total: job.total,
        })
}

// ── the cap, eviction and deferred maintenance ─────────────────────────────────

pub(crate) fn cap_bytes(app: &AppHandle) -> u64 {
    let state = app.state::<workspace::SettingsState>();
    let gb = workspace::load_settings(app, &state)
        .ok()
        .and_then(|s| s.clip_cache_cap_gb)
        .unwrap_or(DEFAULT_CAP_GB);
    u64::from(gb.max(1)) * 1024 * 1024 * 1024
}

/// Signal 0 probes a pid without touching it; EPERM still means it runs (under another user).
fn process_alive(pid: i32) -> bool {
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Live queue tickets (`<epoch>-<pid>.json`, pid still running) in an autorun queue dir.
pub(crate) fn live_tickets(queue: &Path) -> usize {
    let Ok(read) = std::fs::read_dir(queue) else {
        return 0;
    };
    read.flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter(|e| {
            let pid = std::fs::read(e.path())
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v.get("pid").and_then(serde_json::Value::as_i64));
            match pid.and_then(|p| i32::try_from(p).ok()) {
                Some(pid) if pid > 0 => process_alive(pid),
                _ => false,
            }
        })
        .count()
}

/// Whether another terminal run is queued or running: other sessions' gates read this cache, so clears and evictions wait. An autorun's own ticket doesn't count.
pub(crate) fn other_autorun_queued(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    let queue = home
        .join(workspace::WORKSPACE_DIR_NAME)
        .join("_autorun")
        .join("queue");
    let own = usize::from(crate::is_autorun());
    live_tickets(&queue) > own
}

fn maintenance_blocked(app: &AppHandle) -> bool {
    other_autorun_queued(app) || app.state::<crate::ExportState>().busy()
}

/// One evictable chunk.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidate {
    pub dir: PathBuf,
    pub chunk: u32,
    pub last_use: SystemTime,
    pub bytes: u64,
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub(crate) fn dir_bytes(dir: &Path) -> u64 {
    let mut bytes = 0u64;
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                bytes += dir_bytes(&path);
            } else if let Ok(md) = entry.metadata() {
                bytes += md.len();
            }
        }
    }
    bytes
}

/// Every marked chunk outside `skip`, with its last use and size. Staging trees, other builds' partial entries and unmarked frames are never candidates.
pub(crate) fn scan_candidates(root: &Path, skip: &HashSet<String>) -> Vec<Candidate> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in read.flatten() {
        let dir = entry.path();
        let Some(name) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') || !dir.is_dir() || skip.contains(&name) {
            continue;
        }
        let count = if is_whole(&dir) {
            adopt_whole_entry(&dir).ok().flatten()
        } else {
            read_count(&dir)
        };
        let Some(count) = count else {
            continue;
        };
        let preview = dir.join(PREVIEW_DIR);
        for chunk in 0..chunk_count(count.frames) {
            let marker = chunk_marker(&dir, chunk);
            let Ok(md) = std::fs::metadata(&marker) else {
                continue;
            };
            let (start, end) = chunk_range(chunk, count.frames);
            let bytes = (start..end)
                .map(|i| {
                    file_len(&dir.join(frame_name(i, "png")))
                        + file_len(&preview.join(frame_name(i, "jpg")))
                })
                .sum();
            out.push(Candidate {
                dir: dir.clone(),
                chunk,
                last_use: md.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                bytes,
            });
        }
    }
    out
}

/// Least recently used first, until `total` falls to `target`.
pub(crate) fn pick_evictions(
    mut candidates: Vec<Candidate>,
    total: u64,
    target: u64,
) -> Vec<Candidate> {
    let fresh = SystemTime::now()
        .checked_sub(RECENT_USE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    candidates.retain(|c| c.last_use < fresh);
    candidates.sort_by(|a, b| {
        a.last_use
            .cmp(&b.last_use)
            .then(a.dir.cmp(&b.dir))
            .then(a.chunk.cmp(&b.chunk))
    });
    let mut left = total;
    candidates
        .into_iter()
        .take_while(|c| {
            if left <= target {
                return false;
            }
            left = left.saturating_sub(c.bytes);
            true
        })
        .collect()
}

/// Removes one whole chunk: the whole-entry markers first (writing markers for the chunks that stay), then its marker, then its frames, so no reader trusts a half-removed chunk.
pub(crate) fn evict_chunk(dir: &Path, chunk: u32) -> Result<(), String> {
    let count = read_count(dir).ok_or("no count.json")?;
    let preview = dir.join(PREVIEW_DIR);
    if preview.join(DONE).is_file() {
        for c in 0..chunk_count(count.frames) {
            let _ = std::fs::write(chunk_marker(&preview, c), []);
        }
        let _ = std::fs::remove_file(preview.join(DONE));
    }
    let _ = std::fs::remove_file(dir.join(DONE));
    let _ = std::fs::remove_file(chunk_marker(&preview, chunk));
    std::fs::remove_file(chunk_marker(dir, chunk)).map_err(|e| e.to_string())?;
    let (start, end) = chunk_range(chunk, count.frames);
    for index in start..end {
        let _ = std::fs::remove_file(dir.join(frame_name(index, "png")));
        let _ = std::fs::remove_file(preview.join(frame_name(index, "jpg")));
    }
    Ok(())
}

fn pinned_and_busy(state: &ClipCacheState) -> HashSet<String> {
    let inner = state.lock();
    let mut skip: HashSet<String> = inner.pins.values().flatten().cloned().collect();
    for job in &inner.jobs {
        if let Some(name) = job.dir().file_name().and_then(|n| n.to_str()) {
            skip.insert(name.to_owned());
        }
    }
    skip
}

/// Scans the cache and evicts down to the low-water mark when it is over the cap; deferred while another run or an export could be reading.
fn evict_if_over(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ClipCacheState>();
    let root = clips_root(app)?;
    let cap = cap_bytes(app);
    let total = dir_bytes(&root);
    state.lock().size_estimate = Some(total);
    if total <= cap {
        return Ok(());
    }
    if maintenance_blocked(app) {
        schedule_maintenance(app);
        return Ok(());
    }
    let target = (cap as f64 * LOW_WATER) as u64;
    let picked = pick_evictions(
        scan_candidates(&root, &pinned_and_busy(&state)),
        total,
        target,
    );
    let mut freed = 0u64;
    for candidate in &picked {
        match evict_chunk(&candidate.dir, candidate.chunk) {
            Ok(()) => freed += candidate.bytes,
            Err(e) => log::warn!(
                "[clips] evicting {:?} chunk {}: {e}",
                candidate.dir,
                candidate.chunk
            ),
        }
    }
    if total.saturating_sub(freed) > cap {
        log::warn!(
            "[clips] cache is {} bytes over its cap; the rest is pinned or in use",
            total.saturating_sub(freed) - cap
        );
    }
    state.lock().size_estimate = Some(total.saturating_sub(freed));
    Ok(())
}

/// Runs an eviction check in the background when the cache may be over its cap (one at a time).
pub(crate) fn schedule_eviction(app: &AppHandle) {
    let state = app.state::<ClipCacheState>();
    {
        let mut inner = state.lock();
        let under = inner.size_estimate.is_some_and(|e| e <= cap_bytes(app));
        if under || inner.evicting {
            return;
        }
        inner.evicting = true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = evict_if_over(&app) {
            log::warn!("[clips] eviction check failed: {e}");
        }
        app.state::<ClipCacheState>().lock().evicting = false;
    });
}

/// The cap changed: rescan and evict down to it.
pub(crate) fn recheck_cap(app: &AppHandle) {
    app.state::<ClipCacheState>().lock().size_estimate = None;
    schedule_eviction(app);
}

/// Polls until no other run is queued and no export runs, then performs the deferred clear and the eviction check.
fn schedule_maintenance(app: &AppHandle) {
    let state = app.state::<ClipCacheState>();
    {
        let mut inner = state.lock();
        if inner.maintenance {
            return;
        }
        inner.maintenance = true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        while maintenance_blocked(&app) && started.elapsed() < MAINTENANCE_LIMIT {
            tokio::time::sleep(MAINTENANCE_POLL).await;
        }
        let blocked = maintenance_blocked(&app);
        let clear = {
            let state = app.state::<ClipCacheState>();
            let mut inner = state.lock();
            inner.maintenance = false;
            std::mem::take(&mut inner.clear_pending)
        };
        if blocked {
            log::warn!(
                "[clips] gave up waiting to tidy the clip cache; another run still holds it"
            );
            return;
        }
        if clear {
            if let Err(e) = clear_now(&app) {
                log::warn!("[clips] deferred clear failed: {e}");
            }
        }
        app.state::<ClipCacheState>().lock().size_estimate = None;
        schedule_eviction(&app);
    });
}

/// Removes every entry of `shas` on both decode lanes, except ones a window has pinned or a job is filling; the footage is gone with its project, so its frames go too. Returns what was removed.
pub(crate) fn evict_entries(app: &AppHandle, shas: &[String]) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(root) = clips_root(app) else {
        return removed;
    };
    let state = app.state::<ClipCacheState>();
    let skip = pinned_and_busy(&state);
    for sha in shas {
        for hardware in [false, true] {
            let name = entry_name(sha, hardware);
            let dir = root.join(&name);
            if skip.contains(&name) || !dir.is_dir() {
                continue;
            }
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => removed.push(name),
                Err(e) => log::warn!("[clips] could not remove {}: {e}", dir.display()),
            }
            let mut inner = state.lock();
            inner.sources.retain(|_, stamp| stamp.dir != dir);
            inner.touched.remove(&dir);
            inner.size_estimate = None;
        }
    }
    if !removed.is_empty() {
        let _ = app.emit("kookaburra://clips-cache-cleared", ());
    }
    removed
}

/// Removes the whole clip cache and tells every window to drop its in-memory extractions.
fn clear_now(app: &AppHandle) -> Result<(), String> {
    let dir = clips_root(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    {
        let state = app.state::<ClipCacheState>();
        let mut inner = state.lock();
        inner.size_estimate = Some(0);
        inner.touched.clear();
    }
    // Mounted videos hold in-memory extractions keyed to this cache; tell the windows to drop them.
    let _ = app.emit("kookaburra://clips-cache-cleared", ());
    Ok(())
}

/// How a Clear request went: done now, or deferred until another terminal run lets go of the cache.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearOutcome {
    deferred: bool,
}

/// The Settings Clear: refused mid-export (the loop reads these frames), deferred while another run is queued.
pub(crate) fn clear(app: &AppHandle) -> Result<ClearOutcome, String> {
    if app.state::<crate::ExportState>().busy() {
        return Err("an export is running, so clear the clip cache after it finishes".into());
    }
    if other_autorun_queued(app) {
        app.state::<ClipCacheState>().lock().clear_pending = true;
        schedule_maintenance(app);
        return Ok(ClearOutcome { deferred: true });
    }
    clear_now(app)?;
    Ok(ClearOutcome { deferred: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-clips-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_extraction_guard_adds_the_floor_to_the_raw_ceiling_and_names_the_shortfall() {
        let count = CountRecord {
            frames: 600,
            width: 1920,
            height: 1080,
        };
        let one_chunk = extraction_ceiling(CHUNK_FRAMES, 1920, 1080);
        assert_eq!(one_chunk, 120 * 1920 * 1080 * 3);
        let need = one_chunk + DISK_FLOOR;
        assert!(check_extraction_space(need, CHUNK_FRAMES, count).is_ok());
        assert!(check_extraction_space(u64::MAX, 0, count).is_ok());
        let short = check_extraction_space(need - 1, CHUNK_FRAMES, count).unwrap_err();
        assert!(
            short.starts_with("extracting 120 frames needs up to 2.9 GB free"),
            "{short}"
        );
        assert!(short.contains("free 0.0 GB"), "{short}");
        let empty = check_extraction_space(0, 600, count).unwrap_err();
        assert!(
            empty.contains("needs up to 5.9 GB free and 0.0 GB is available: free 5.9 GB"),
            "{empty}"
        );
    }

    #[test]
    fn chunks_tile_the_clip_and_clamp_the_last() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(120), 1);
        assert_eq!(chunk_count(121), 2);
        assert_eq!(chunk_range(0, 301), (0, 120));
        assert_eq!(chunk_range(2, 301), (240, 301));
        assert_eq!(chunk_range(3, 301), (301, 301));
    }

    #[test]
    fn consecutive_chunks_share_one_pass() {
        assert_eq!(
            chunk_runs(&[4, 0, 1, 2, 2, 7, 5]),
            vec![(0, 2), (4, 5), (7, 7)]
        );
        assert!(chunk_runs(&[]).is_empty());
    }

    #[test]
    fn the_chunk_argv_trims_by_frame_with_no_seek() {
        let args = chunk_args(
            "/src/a.mp4",
            false,
            120,
            240,
            Path::new("/d/frame-%05d.png"),
        );
        assert!(!args.iter().any(|a| a == "-ss"));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(
            vf,
            "fps=60:start_time=0,trim=start_frame=120:end_frame=240,setpts=PTS-STARTPTS"
        );
        let tail: Vec<&str> = args[args.len() - 9..].iter().map(String::as_str).collect();
        assert_eq!(
            tail,
            [
                "-fps_mode",
                "passthrough",
                "-compression_level",
                "1",
                "-pred",
                "0",
                "-start_number",
                "120",
                "/d/frame-%05d.png"
            ]
        );
        let hw = chunk_args("/src/a.mp4", true, 0, 120, Path::new("/d/frame-%05d.png"));
        let at = hw.iter().position(|a| a == "-hwaccel").unwrap();
        assert_eq!(hw[at + 1], "videotoolbox");
        assert!(at < hw.iter().position(|a| a == "-i").unwrap());
    }

    #[test]
    fn the_count_pass_keeps_the_whole_extraction_filter_and_sync() {
        let args = count_args("/src/a.mp4", false, Path::new("/d/probe.png"));
        let joined = args.join(" ");
        assert!(joined.contains("-vf fps=60 -fps_mode cfr -f null -"));
        assert!(joined.ends_with("-frames:v 1 -update 1 /d/probe.png"));
        assert!(!joined.contains("hwaccel"));
        assert!(count_args("/s", true, Path::new("/p.png"))
            .join(" ")
            .contains("-hwaccel videotoolbox -protocol_whitelist file,pipe -i /s"));
    }

    #[test]
    fn progress_lines_carry_the_frame_count() {
        assert_eq!(progress_frame("frame=301"), Some(301));
        assert_eq!(progress_frame("  frame= 12 "), Some(12));
        assert_eq!(progress_frame("fps=60.0"), None);
    }

    #[test]
    fn frame_names_map_back_to_their_chunk() {
        assert_eq!(
            frame_index(Path::new("/c/x-60fps/frame-00239.png")),
            Some(239)
        );
        assert_eq!(
            frame_index(Path::new("/c/x/preview/frame-00240.jpg")),
            Some(240)
        );
        assert_eq!(frame_index(Path::new("/c/x/.chunk-0")), None);
        assert_eq!(
            chunk_marker(Path::new("/c/x"), 2),
            PathBuf::from("/c/x/.chunk-240")
        );
    }

    fn fake_entry(root: &Path, name: &str, frames: u32, marked: &[u32], whole: bool) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join(PREVIEW_DIR)).unwrap();
        for i in 0..frames {
            if whole || marked.contains(&(i / CHUNK_FRAMES)) {
                std::fs::write(dir.join(frame_name(i, "png")), [0u8; 10]).unwrap();
            }
        }
        for &c in marked {
            std::fs::write(chunk_marker(&dir, c), []).unwrap();
        }
        let count = CountRecord {
            frames,
            width: 8,
            height: 8,
        };
        std::fs::write(dir.join(COUNT_FILE), serde_json::to_vec(&count).unwrap()).unwrap();
        if whole {
            std::fs::write(dir.join(DONE), []).unwrap();
        }
        dir
    }

    #[test]
    fn a_pre_chunking_entry_is_adopted_without_touching_its_frames() {
        let root = temp_dir("adopt");
        let dir = root.join("abc-60fps");
        std::fs::create_dir_all(&dir).unwrap();
        // A real IHDR so the size reads back.
        let mut png = vec![0u8; 24];
        png[16..20].copy_from_slice(&64u32.to_be_bytes());
        png[20..24].copy_from_slice(&48u32.to_be_bytes());
        for i in 0..250 {
            std::fs::write(dir.join(frame_name(i, "png")), &png).unwrap();
        }
        let extracted = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        std::fs::File::create(dir.join(DONE))
            .unwrap()
            .set_modified(extracted)
            .unwrap();
        let count = adopt_whole_entry(&dir).unwrap().unwrap();
        let marker_age = std::fs::metadata(chunk_marker(&dir, 1))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(marker_age, extracted, "markers keep the entry's last use");
        assert_eq!(
            count,
            CountRecord {
                frames: 250,
                width: 64,
                height: 48
            }
        );
        assert_eq!(present_chunks(&dir, 250), vec![0, 1, 2]);
        assert!((0..3).all(|c| chunk_marker(&dir, c).is_file()));
        assert!(is_whole(&dir));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn eviction_never_takes_a_chunk_used_recently() {
        let now = SystemTime::now();
        let candidate = |chunk: u32, ago: u64| Candidate {
            dir: PathBuf::from("/x/clip-60fps"),
            chunk,
            last_use: now - Duration::from_secs(ago),
            bytes: 100,
        };
        let picked = pick_evictions(vec![candidate(0, 60), candidate(1, 3600)], 1000, 0);
        assert_eq!(picked.iter().map(|c| c.chunk).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn eviction_takes_the_oldest_whole_chunks_and_skips_pins() {
        let root = temp_dir("evict");
        let old = fake_entry(&root, "old-60fps", 300, &[0, 1, 2], true);
        let pinned = fake_entry(&root, "pin-60fps", 240, &[0, 1], false);
        let fresh = fake_entry(&root, "new-60fps", 240, &[1], false);
        let past = SystemTime::now() - Duration::from_secs(3600);
        for c in 0..3 {
            let f = std::fs::OpenOptions::new()
                .write(true)
                .open(chunk_marker(&old, c))
                .unwrap();
            f.set_modified(past + Duration::from_secs(u64::from(c)))
                .unwrap();
        }
        let skip: HashSet<String> = ["pin-60fps".to_owned()].into();
        let candidates = scan_candidates(&root, &skip);
        assert!(candidates.iter().all(|c| c.dir != pinned));
        assert_eq!(candidates.len(), 4);
        // 300 frames of 10 bytes in the old entry; stop once two chunks free enough.
        let picked = pick_evictions(candidates, 5400, 3000);
        let names: Vec<(String, u32)> = picked
            .iter()
            .map(|c| {
                (
                    c.dir.file_name().unwrap().to_string_lossy().into_owned(),
                    c.chunk,
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![("old-60fps".into(), 0), ("old-60fps".into(), 1)]
        );
        for c in &picked {
            evict_chunk(&c.dir, c.chunk).unwrap();
        }
        assert!(!is_whole(&old));
        assert_eq!(present_chunks(&old, 300), vec![2]);
        assert!(!old.join(frame_name(0, "png")).exists());
        assert!(old.join(frame_name(240, "png")).exists());
        assert_eq!(present_chunks(&fresh, 240), vec![1]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn evicting_from_a_whole_preview_tier_keeps_the_other_chunks_marked() {
        let root = temp_dir("preview");
        let dir = fake_entry(&root, "a-60fps", 240, &[0, 1], true);
        std::fs::write(dir.join(PREVIEW_DIR).join(DONE), []).unwrap();
        evict_chunk(&dir, 0).unwrap();
        assert_eq!(present_previews(&dir, 240), vec![1]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_and_unmarked_entries_are_never_candidates() {
        let root = temp_dir("orphans");
        std::fs::create_dir_all(root.join(".staging-x-60fps-1")).unwrap();
        let partial = root.join("p-60fps");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(partial.join(frame_name(0, "png")), [0u8; 4]).unwrap();
        assert!(scan_candidates(&root, &HashSet::new()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_live_queue_tickets_count() {
        let queue = temp_dir("queue");
        let me = std::process::id();
        std::fs::write(
            queue.join("000000000001-1.json"),
            format!("{{\"pid\":{me}}}"),
        )
        .unwrap();
        // A pid that cannot be running.
        std::fs::write(queue.join("000000000002-2.json"), "{\"pid\":2147480000}").unwrap();
        std::fs::write(queue.join("notes.txt"), "{\"pid\":1}").unwrap();
        assert_eq!(live_tickets(&queue), 1);
        assert_eq!(live_tickets(&queue.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&queue);
    }

    // ── the proof: chunks are byte-identical to whole-clip extraction ─────────

    const DEV_FFMPEG: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/bin/ffmpeg-aarch64-apple-darwin"
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

    /// Lossless barcode frames: the top band encodes `value` (an ffmpeg expression of N) in 16 bits.
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

    /// The whole-clip extraction exactly as it ran before chunking: the reference every chunk must match.
    fn whole_args(src: &str, hardware: bool, pattern: &Path) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
        ];
        args.extend(lane_args(hardware));
        args.extend(
            [
                "-i",
                src,
                "-vf",
                "fps=60",
                "-fps_mode",
                "cfr",
                "-compression_level",
                "1",
                "-pred",
                "0",
                "-start_number",
                "0",
            ]
            .map(String::from),
        );
        args.push(pattern.to_string_lossy().into_owned());
        args
    }

    fn decoded_pixels(path: &Path) -> Vec<u8> {
        let decoder =
            png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        buf
    }

    /// Chunked extraction against whole-clip extraction on both decode lanes: every PNG's file bytes and decoded pixels, the count pass against the PNG count, and chunk boundaries at 0, 120 and the last partial chunk, extracted one chunk per pass and as one multi-chunk run.
    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
    fn chunk_barcode_conformance() {
        let dir = temp_dir("barcode");
        let src = |name: &str| dir.join(name);
        barcode_source(&src("cfr60.mp4"), 60, 5, "N");
        barcode_source(&src("cfr30.mp4"), 30, 5, "N");
        // One frame held for four seconds, then decimated into a variable-rate file.
        barcode_source(
            &src("held60.mp4"),
            60,
            6,
            "if(lt(N,60),N,if(lt(N,300),60,N))",
        );
        ffmpeg_ok(&[
            "-i",
            src("held60.mp4").to_str().unwrap(),
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
            src("vfr60.mp4").to_str().unwrap(),
        ]);
        // A first frame 11 ms after the audio: the whole extraction pads it, so chunks must too.
        ffmpeg_ok(&[
            "-itsoffset",
            "0.011",
            "-i",
            src("cfr30.mp4").to_str().unwrap(),
            "-f",
            "lavfi",
            "-i",
            "sine=d=5.5",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            src("late30.mp4").to_str().unwrap(),
        ]);
        // H.264 decodes the same on both lanes; VideoToolbox HEVC at this size does not, so this one proves the hardware lane is its own.
        ffmpeg_ok(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=60:d=5,format=yuv420p",
            "-c:v",
            "libx265",
            "-tag:v",
            "hvc1",
            "-x265-params",
            "log-level=error",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            src("hevc60.mp4").to_str().unwrap(),
        ]);
        let ffmpeg = Path::new(DEV_FFMPEG);
        for name in [
            "cfr60.mp4",
            "cfr30.mp4",
            "vfr60.mp4",
            "late30.mp4",
            "hevc60.mp4",
        ] {
            for hardware in [false, true] {
                let source = src(name);
                let source = source.to_str().unwrap();
                let lane = if hardware { "hw" } else { "sw" };
                let whole = dir.join(format!("{name}-{lane}-whole"));
                std::fs::create_dir_all(&whole).unwrap();
                let run = std::process::Command::new(ffmpeg)
                    .args(whole_args(source, hardware, &whole.join("frame-%05d.png")))
                    .output()
                    .unwrap();
                assert!(
                    run.status.success(),
                    "{name} {lane}: whole extraction failed"
                );
                let frames = std::fs::read_dir(&whole).unwrap().count() as u32;
                assert!(
                    frames > 240,
                    "{name}: {frames} frames is too short to cover a partial chunk"
                );

                let decode = Decode {
                    ffmpeg,
                    src: source,
                    hardware,
                    background: false,
                };
                // Single chunks run last first, so each one is extracted cold of its neighbours.
                for (tag, runs) in [
                    (
                        "single",
                        (0..chunk_count(frames))
                            .rev()
                            .map(|c| (c, c))
                            .collect::<Vec<_>>(),
                    ),
                    ("run", vec![(0, chunk_count(frames) - 1)]),
                ] {
                    let entry = dir.join(format!("{name}-{lane}-{tag}"));
                    let count = run_count(decode, &entry).unwrap();
                    assert_eq!(
                        count.frames, frames,
                        "{name} {lane}: the count pass disagrees"
                    );
                    assert_eq!(
                        (count.width, count.height),
                        png_dimensions(&whole.join(frame_name(0, "png"))).unwrap()
                    );
                    for run in runs {
                        run_chunks(decode, &entry, count, run, |_| {}).unwrap();
                    }
                    assert!(
                        is_whole(&entry),
                        "{name} {lane} {tag}: every chunk marks the entry whole"
                    );
                    for index in 0..frames {
                        let file = frame_name(index, "png");
                        let a = std::fs::read(whole.join(&file)).unwrap();
                        let b = std::fs::read(entry.join(&file))
                            .unwrap_or_else(|_| panic!("{name} {lane} {tag}: {file} missing"));
                        assert!(a == b, "{name} {lane} {tag}: {file} bytes differ");
                        assert!(
                            decoded_pixels(&whole.join(&file))
                                == decoded_pixels(&entry.join(&file)),
                            "{name} {lane} {tag}: {file} pixels differ"
                        );
                    }
                    assert!(!entry.join(frame_name(frames, "png")).exists());
                }
            }
        }
        let lanes_differ = (0..300).any(|index| {
            let file = frame_name(index, "png");
            std::fs::read(dir.join("hevc60.mp4-sw-whole").join(&file)).unwrap()
                != std::fs::read(dir.join("hevc60.mp4-hw-whole").join(&file)).unwrap()
        });
        assert!(
            lanes_differ,
            "the hardware lane decoded HEVC exactly like software"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
