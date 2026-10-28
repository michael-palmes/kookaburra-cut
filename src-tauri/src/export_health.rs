//! Export health (docs/agent-kit.md, "Health"): the editor's page loads and WebKit memory, and each video export's trace (frames, render rate, memory), kept natively so an export whose page dies still leaves the truth: its failure names the frame, the scene and the render-rate trend, `<export>.health.json` records it, and the heartbeat tells kb when only a restart helps.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::ExportState;

const SAMPLE_EVERY: Duration = Duration::from_secs(2);
const MAX_MEMORY_SAMPLES: usize = 1_800;
const MAX_RATE_POINTS: usize = 7_200;
const RATE_POINT_MS: u64 = 1_000;
const RATE_WINDOW_MS: u64 = 10_000;
const MAX_RELOADS: usize = 8;
const HEALTH_VERSION: u32 = 1;
const RESTART_HINT: &str = "quit and reopen Kookaburra Cut, then export again";
/// A WebContent process replaced above this was almost certainly reclaimed for memory.
const MEMORY_KILL_BYTES: u64 = 2_500_000_000;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A process's physical footprint in bytes, the figure WebKit's memory limit and Activity Monitor's Memory column use.
#[cfg(target_os = "macos")]
pub(crate) fn footprint(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok().filter(|p| *p > 0)?;
    // SAFETY: the buffer is a zeroed rusage_info_v4, the flavour asked for.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            (&mut info as *mut libc::rusage_info_v4).cast::<libc::rusage_info_t>(),
        )
    };
    (rc == 0).then_some(info.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn footprint(_pid: u32) -> Option<u64> {
    None
}

/// One reading of every process an export leans on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Sample {
    pub at_ms: u64,
    pub editor: Option<u64>,
    pub render: Option<u64>,
    pub gpu: Option<u64>,
    pub app: Option<u64>,
    pub ffmpeg: Option<u64>,
}

impl Sample {
    fn json(&self) -> Value {
        json!({
            "atMs": self.at_ms,
            "editor": self.editor,
            "render": self.render,
            "gpu": self.gpu,
            "app": self.app,
            "ffmpeg": self.ffmpeg,
        })
    }
}

/// A scene's place on the timeline, from the exporter's slots.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SceneSpan {
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// One video export from its first frame to its end: what a failure report needs once the page that ran it is gone.
#[derive(Debug, Clone)]
pub(crate) struct RunTrace {
    pub started_ms: u64,
    pub fps: u32,
    pub total: u32,
    pub poster: bool,
    pub scenes: Vec<SceneSpan>,
    pub output: PathBuf,
    pub health: PathBuf,
    pub written: u32,
    /// (frames written, at ms), at most one a second.
    pub rate: Vec<(u32, u64)>,
    pub memory: Vec<Sample>,
}

impl RunTrace {
    pub(crate) fn new(
        fps: u32,
        total: u32,
        poster: bool,
        scenes: Vec<SceneSpan>,
        output: PathBuf,
        health: PathBuf,
        now: u64,
    ) -> Self {
        Self {
            started_ms: now,
            fps,
            total,
            poster,
            scenes,
            output,
            health,
            written: 0,
            rate: Vec::new(),
            memory: Vec::new(),
        }
    }

    pub(crate) fn frame(&mut self, written: u32, now: u64) {
        self.written = written;
        let due = self
            .rate
            .last()
            .map_or(true, |(_, at)| now.saturating_sub(*at) >= RATE_POINT_MS);
        if due && self.rate.len() < MAX_RATE_POINTS {
            self.rate.push((written, now));
        }
    }

    fn memory(&mut self, sample: Sample) {
        if self.memory.len() >= MAX_MEMORY_SAMPLES {
            self.memory.remove(0);
        }
        self.memory.push(sample);
    }

    /// The project time of 0-based export frame `frame`; a poster frame leads at the first scene's middle.
    fn frame_ms(&self, frame: u32) -> f64 {
        let fps = f64::from(self.fps.max(1));
        let index = if self.poster {
            frame.saturating_sub(1)
        } else {
            frame
        };
        f64::from(index) * 1000.0 / fps
    }

    /// The scene(s) on screen at the frame being rendered (two inside a transition).
    pub(crate) fn scenes_at(&self, frame: u32) -> Vec<&str> {
        let t = self.frame_ms(frame);
        let mut on: Vec<&str> = self
            .scenes
            .iter()
            .filter(|s| s.start_ms <= t && t < s.end_ms)
            .map(|s| s.id.as_str())
            .collect();
        if on.is_empty() {
            if let Some(last) = self.scenes.last().filter(|s| t >= s.end_ms) {
                on.push(last.id.as_str());
            }
        }
        on
    }

    /// Frames a second over `[from, to]` ms, from the one-a-second points.
    fn rate_between(&self, from: u64, to: u64) -> Option<f64> {
        let a = self.rate.iter().find(|(_, at)| *at >= from)?;
        let b = self.rate.iter().rev().find(|(_, at)| *at <= to)?;
        let ms = b.1.checked_sub(a.1).filter(|ms| *ms > 0)?;
        Some(f64::from(b.0.saturating_sub(a.0)) * 1000.0 / ms as f64)
    }

    /// The render rate at the start, the middle and the end (fewer when the run was short).
    pub(crate) fn trend(&self) -> Vec<f64> {
        let (Some(first), Some(last)) = (self.rate.first(), self.rate.last()) else {
            return Vec::new();
        };
        let span = last.1.saturating_sub(first.1);
        let round = |v: f64| (v * 10.0).round() / 10.0;
        if span < RATE_WINDOW_MS * 3 {
            return self
                .rate_between(first.1, last.1)
                .map(round)
                .into_iter()
                .collect();
        }
        let mid = first.1 + span / 2;
        [
            (first.1, first.1 + RATE_WINDOW_MS),
            (mid - RATE_WINDOW_MS / 2, mid + RATE_WINDOW_MS / 2),
            (last.1 - RATE_WINDOW_MS, last.1),
        ]
        .iter()
        .filter_map(|(a, b)| self.rate_between(*a, *b).map(round))
        .collect()
    }

    fn peak(&self, pick: impl Fn(&Sample) -> Option<u64>) -> Option<u64> {
        self.memory.iter().filter_map(pick).max()
    }

    /// `frame 1235/2900 (42%), scene fold-open, render 8.4 → 2.6 → 1.2 fps`.
    pub(crate) fn summary(&self) -> String {
        let frame = (self.written + 1).min(self.total.max(1));
        let percent = f64::from(self.written) * 100.0 / f64::from(self.total.max(1));
        let mut text = format!("frame {frame}/{} ({percent:.0}%)", self.total);
        let scenes = self.scenes_at(self.written);
        if !scenes.is_empty() {
            text.push_str(&format!(", scene {}", scenes.join(" → ")));
        }
        let trend = self.trend();
        if !trend.is_empty() {
            let rates: Vec<String> = trend.iter().map(|r| format!("{r:.1}")).collect();
            text.push_str(&format!(", render {} fps", rates.join(" → ")));
        }
        text
    }

    pub(crate) fn body(&self, reason: &str, error: &str, now: u64) -> Value {
        let mb = |b: Option<u64>| b.map(|b| (b as f64 / 1e6).round() as u64);
        let points = thin(&self.rate, 120);
        let memory = thin(&self.memory, 120);
        json!({
            "version": HEALTH_VERSION,
            "ok": false,
            "reason": reason,
            "error": error,
            "output": self.output.to_string_lossy(),
            "fps": self.fps,
            "frame": (self.written + 1).min(self.total.max(1)),
            "framesWritten": self.written,
            "total": self.total,
            "posterFrame": self.poster,
            "scenes": self.scenes_at(self.written),
            "renderFps": self.trend(),
            "elapsedMs": now.saturating_sub(self.started_ms),
            "rate": points.iter().map(|(f, at)| json!([f, at.saturating_sub(self.started_ms)])).collect::<Vec<_>>(),
            "peakMb": {
                "editor": mb(self.peak(|s| s.editor)),
                "render": mb(self.peak(|s| s.render)),
                "gpu": mb(self.peak(|s| s.gpu)),
                "app": mb(self.peak(|s| s.app)),
            },
            "memory": memory.iter().map(Sample::json).collect::<Vec<_>>(),
            "hint": RESTART_HINT,
            "writtenAtMs": now,
        })
    }
}

/// At most `n` evenly spaced items, the last always kept.
fn thin<T: Clone>(items: &[T], n: usize) -> Vec<T> {
    if items.len() <= n || n < 2 {
        return items.to_vec();
    }
    let step = (items.len() - 1) as f64 / (n - 1) as f64;
    (0..n)
        .map(|i| items[((i as f64) * step).round() as usize].clone())
        .collect()
}

/// `<project exports>/<name>.health.json` beside where the film would land in the project.
pub(crate) fn health_path(canonical_output: &Path) -> PathBuf {
    let stem = canonical_output
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    canonical_output.with_file_name(format!("{stem}.health.json"))
}

fn write_health(trace: &RunTrace, reason: &str, error: &str) {
    let body = trace.body(reason, error, now_ms());
    let Some(dir) = trace.health.parent() else {
        return;
    };
    let tmp = dir.join(format!(".health.{}.tmp", std::process::id()));
    let written = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&tmp, body.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &trace.health));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("[export] couldn't write {}: {e}", trace.health.display());
    }
}

#[derive(Debug, Clone)]
struct Reload {
    at_ms: u64,
    killed: bool,
    editor_bytes: Option<u64>,
    export: Option<String>,
}

#[derive(Debug, Default)]
struct Editor {
    loads: u32,
    reloads: Vec<Reload>,
    reload_count: u32,
    /// A reload that lost its page process or an export: the editor slows until a restart.
    restart_recommended: bool,
    pid: Option<u32>,
    gpu_pid: Option<u32>,
    latest: Option<Sample>,
    peak_editor: Option<u64>,
}

struct State {
    editor: Editor,
    trace: Option<RunTrace>,
    /// An export the last page died with, for the new page's one-off notice.
    interrupted: Option<Value>,
}

static STATE: Mutex<State> = Mutex::new(State {
    editor: Editor {
        loads: 0,
        reloads: Vec::new(),
        reload_count: 0,
        restart_recommended: false,
        pid: None,
        gpu_pid: None,
        latest: None,
        peak_editor: None,
    },
    trace: None,
    interrupted: None,
});

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// `start_export` begins a trace once ffmpeg is running.
pub(crate) fn begin(trace: RunTrace) {
    let _ = std::fs::remove_file(&trace.health);
    state().trace = Some(trace);
}

/// Each pushed frame.
pub(crate) fn frame(written: u32) {
    if let Some(trace) = state().trace.as_mut() {
        trace.frame(written, now_ms());
    }
}

/// A finished export: its health file from any earlier failure is stale now.
pub(crate) fn succeeded() {
    if let Some(trace) = state().trace.take() {
        let _ = std::fs::remove_file(&trace.health);
    }
}

/// A failed export writes `<export>.health.json` and returns where it stopped (None when no run was traced).
pub(crate) fn failed(reason: &str, error: &str) -> Option<String> {
    let trace = state().trace.take()?;
    let summary = trace.summary();
    write_health(&trace, reason, &format!("{error} at {summary}"));
    Some(summary)
}

/// A cancel with no error behind it (the person or kb asked) leaves no health file.
pub(crate) fn cancelled() {
    state().trace = None;
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

/// The main window started a page load: the first is the boot, any later one lost the page an export may be running in, so that export is stopped and failed here instead of holding the slot until a restart.
pub(crate) fn on_main_page_load(app: &AppHandle) {
    let now = now_ms();
    let (first, old_pid, last_bytes, trace) = {
        let mut s = state();
        s.editor.loads += 1;
        let first = s.editor.loads == 1;
        let old_pid = s.editor.pid.take();
        s.editor.gpu_pid = None;
        let last = s.editor.latest.and_then(|l| l.editor);
        let trace = if first { None } else { s.trace.take() };
        (first, old_pid, last, trace)
    };
    crate::capture_service::forget_editor_pid();
    if first {
        return;
    }
    let killed = old_pid.is_some_and(|pid| !crate::bridge::pid_alive(pid));
    let why = if killed {
        match last_bytes {
            Some(bytes) => format!(
                "WebKit replaced the editor's page process, which was using {}",
                gb(bytes)
            ),
            None => "WebKit replaced the editor's page process".to_owned(),
        }
    } else {
        "the editor reloaded".to_owned()
    };
    let detail = trace.as_ref().map(|trace| {
        let error = format!("{why} during the export, at {}", trace.summary());
        write_health(trace, "editorReloaded", &error);
        error
    });
    let notice = trace.as_ref().map(|trace| {
        let cause = match (killed, last_bytes) {
            (true, Some(bytes)) if bytes >= MEMORY_KILL_BYTES => "memory",
            (true, _) => "crash",
            _ => "reload",
        };
        let percent = (f64::from(trace.written) * 100.0 / f64::from(trace.total.max(1))).floor();
        json!({ "percent": percent, "cause": cause })
    });
    let exports = app.state::<ExportState>();
    if exports.busy() {
        let _ = exports.cancel();
        exports.stills.cancel();
    }
    crate::bridge_export::editor_reloaded(detail.as_deref());
    match &detail {
        Some(detail) => log::warn!("[export] {detail}"),
        None => log::warn!("[editor] {why}"),
    }
    let mut s = state();
    if notice.is_some() {
        s.interrupted = notice;
    }
    s.editor.reload_count += 1;
    s.editor.restart_recommended |= killed || detail.is_some();
    if s.editor.reloads.len() >= MAX_RELOADS {
        s.editor.reloads.remove(0);
    }
    s.editor.reloads.push(Reload {
        at_ms: now,
        killed,
        editor_bytes: last_bytes,
        export: detail,
    });
}

/// The heartbeat's `health.editor`: page reloads since launch (one that lost its page process or an export means restart before exporting) and the latest memory.
pub(crate) fn editor_json() -> Value {
    let s = state();
    let e = &s.editor;
    let mb = |b: Option<u64>| b.map(|b| (b as f64 / 1e6).round() as u64);
    let latest = e.latest.unwrap_or_default();
    json!({
        "reloads": e.reload_count,
        "lastReload": e.reloads.last().map(|r| json!({
            "atMs": r.at_ms,
            "killed": r.killed,
            "editorMb": mb(r.editor_bytes),
            "export": r.export,
        })),
        "restartRecommended": e.restart_recommended,
        "memoryMb": {
            "editor": mb(latest.editor),
            "editorPeak": mb(e.peak_editor),
            "render": mb(latest.render),
            "gpu": mb(latest.gpu),
            "app": mb(latest.app),
        },
        "sampledAtMs": e.latest.map(|l| l.at_ms),
    })
}

/// The new page's one-off notice for an export its predecessor died with: `{ percent, cause }`, cause `memory`, `crash` or `reload`.
#[tauri::command]
pub fn take_export_interruption() -> Option<Value> {
    state().interrupted.take()
}

/// The editor's latest memory sample, for the memory probe.
#[tauri::command]
pub fn export_memory_sample() -> Value {
    let s = state();
    let mut out = s.editor.latest.unwrap_or_default().json();
    out["editorPid"] = json!(s.editor.pid);
    out["gpuPid"] = json!(s.editor.gpu_pid);
    out
}

#[cfg(target_os = "macos")]
fn fetch_gpu_pid(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    let _ = window.with_webview(move |webview| unsafe {
        let wk: *mut AnyObject = webview.inner().cast();
        let responds: Bool = msg_send![wk, respondsToSelector: sel!(_gpuProcessIdentifier)];
        if responds.as_bool() {
            let pid: i32 = msg_send![wk, _gpuProcessIdentifier];
            if let Ok(pid) = u32::try_from(pid) {
                if pid > 0 {
                    state().editor.gpu_pid = Some(pid);
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn fetch_gpu_pid(_window: &tauri::WebviewWindow) {}

/// Samples every 2 s: the editor's and render window's WebContent processes, WebKit's GPU process, the app and the export's ffmpeg.
pub(crate) fn spawn_sampler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SAMPLE_EVERY);
        let (pid, gpu_pid) = {
            let s = state();
            (s.editor.pid, s.editor.gpu_pid)
        };
        if let Some(main) = app.get_webview_window("main") {
            if pid.is_none() {
                crate::capture_service::fetch_web_content_pid(&main, |pid| {
                    state().editor.pid = Some(pid);
                });
            }
            if gpu_pid.is_none() {
                fetch_gpu_pid(&main);
            }
        }
        let sample = Sample {
            at_ms: now_ms(),
            editor: pid.and_then(footprint),
            render: crate::capture_service::render_pid().and_then(footprint),
            gpu: gpu_pid.and_then(footprint),
            app: footprint(std::process::id()),
            ffmpeg: app.state::<ExportState>().ffmpeg_pid().and_then(footprint),
        };
        let mut s = state();
        s.editor.latest = Some(sample);
        if let Some(bytes) = sample.editor {
            s.editor.peak_editor = Some(s.editor.peak_editor.map_or(bytes, |p| p.max(bytes)));
        }
        if let Some(trace) = s.trace.as_mut() {
            trace.memory(sample);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(poster: bool) -> RunTrace {
        RunTrace::new(
            30,
            300,
            poster,
            vec![
                SceneSpan {
                    id: "intro".into(),
                    start_ms: 0.0,
                    end_ms: 4_000.0,
                },
                SceneSpan {
                    id: "fold-open".into(),
                    start_ms: 3_500.0,
                    end_ms: 10_000.0,
                },
            ],
            PathBuf::from("/x/exports/product-tour-16x9.mp4"),
            PathBuf::from("/x/exports/product-tour-16x9.health.json"),
            1_000,
        )
    }

    #[test]
    fn scenes_follow_the_frame_and_a_poster_frame_shifts_them() {
        let t = trace(false);
        assert_eq!(t.scenes_at(0), vec!["intro"]);
        assert_eq!(t.scenes_at(110), vec!["intro", "fold-open"]);
        assert_eq!(t.scenes_at(120), vec!["fold-open"]);
        assert_eq!(t.scenes_at(400), vec!["fold-open"]);
        let p = trace(true);
        assert_eq!(p.scenes_at(120), vec!["intro", "fold-open"]);
        assert_eq!(p.scenes_at(121), vec!["fold-open"]);
    }

    #[test]
    fn the_trend_reads_start_middle_and_end() {
        let mut t = trace(false);
        let mut written = 0;
        let mut at = 1_000;
        for second in 0..60u32 {
            written += if second < 20 {
                8
            } else if second < 40 {
                3
            } else {
                1
            };
            at += 1_000;
            t.frame(written, at);
        }
        assert_eq!(t.trend(), vec![8.0, 3.0, 1.0]);
        let summary = t.summary();
        assert!(summary.starts_with("frame 241/300 (80%)"), "{summary}");
        assert!(summary.ends_with("render 8.0 → 3.0 → 1.0 fps"), "{summary}");
    }

    #[test]
    fn a_short_run_reports_one_rate() {
        let mut t = trace(false);
        t.frame(1, 2_000);
        t.frame(11, 4_000);
        assert_eq!(t.trend(), vec![5.0]);
        assert!(trace(false).trend().is_empty());
    }

    #[test]
    fn rate_points_are_one_a_second() {
        let mut t = trace(false);
        for i in 0..100 {
            t.frame(i, 1_000 + u64::from(i) * 100);
        }
        assert_eq!(t.rate.len(), 10);
    }

    #[test]
    fn the_health_body_names_where_it_stopped() {
        let mut t = trace(false);
        t.frame(1, 2_000);
        t.frame(151, 32_000);
        t.memory(Sample {
            at_ms: 3_000,
            editor: Some(3_900_000_000),
            ..Sample::default()
        });
        let body = t.body("editorReloaded", "boom", 40_000);
        assert_eq!(body["frame"], json!(152));
        assert_eq!(body["scenes"], json!(["fold-open"]));
        assert_eq!(body["peakMb"]["editor"], json!(3900));
        assert_eq!(body["elapsedMs"], json!(39_000));
        assert_eq!(body["hint"], json!(RESTART_HINT));
    }

    #[test]
    fn health_sits_beside_the_film() {
        assert_eq!(
            health_path(Path::new("/x/exports/product-tour-16x9-reels.mp4")),
            PathBuf::from("/x/exports/product-tour-16x9-reels.health.json")
        );
    }

    #[test]
    fn thinning_keeps_both_ends() {
        let items: Vec<u32> = (0..1000).collect();
        let thinned = thin(&items, 5);
        assert_eq!(thinned, vec![0, 250, 500, 749, 999]);
        assert_eq!(thin(&items[..3], 5), vec![0, 1, 2]);
    }
}
