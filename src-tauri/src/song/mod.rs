//! Song analysis v2: one analyser for the beat lane (`song_analysis`) and the headless `<exe> song analyse`. It decodes with the ffmpeg sidecar (the export's decoder), tracks beats and downbeats with the bundled beat-this model or the DSP fit, refines the grid against our own onsets, and adds loudness, sections, breaths, a stab histogram and any lyrics tag. Editor and agent guidance only: nothing here ever feeds a render. Results are cached by audio SHA-256 as `<sha>-v2.json` under `$APPDATA/cache/beats/`, the version in the name so two builds never fight over one file.

mod decode;
mod fit;
mod nn;
mod onset;
mod structure;
#[cfg(test)]
mod synth;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::workspace::{self, SettingsState};
use fit::LineFit;
use onset::{ENVELOPE_HOP, ONSET_HOP};

pub use nn::{candidate_dirs, locate as locate_model, ModelFiles, MODEL_NAME};

pub const ANALYSIS_VERSION: u32 = 2;
/// The pinned decode rate: results never depend on the file's own rate or the output device.
pub const SAMPLE_RATE: u32 = 48_000;
/// What `edit caps` and `song caps` advertise under `trackers`.
pub const TRACKERS: &[&str] = &["nn", "dsp"];
const MIN_TRACKED_BEATS: usize = 8;
const DEFAULT_BEATS_PER_BAR: usize = 4;
const LOUDNESS_HOP_MS: u32 = 100;

/// `--tracker`: `Auto` takes the model when it is there and says why when it is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackerChoice {
    Auto,
    Nn,
    Dsp,
}

impl TrackerChoice {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "nn" => Some(Self::Nn),
            "dsp" => Some(Self::Dsp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SongError {
    pub code: &'static str,
    pub message: String,
}

impl SongError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct Request<'a> {
    pub file: &'a Path,
    pub tracker: TrackerChoice,
    pub force: bool,
    pub ffmpeg: &'a Path,
    pub ffprobe: &'a Path,
    /// None skips the cache entirely.
    pub cache_dir: Option<&'a Path>,
    pub model_dirs: &'a [PathBuf],
}

#[derive(Debug)]
pub struct Outcome {
    pub analysis: Value,
    pub cached: bool,
    pub cache_path: Option<PathBuf>,
}

/// The cache file for a SHA and tracker choice: the default analysis, or the forced DSP one beside it.
pub fn cache_path(dir: &Path, sha: &str, tracker: TrackerChoice) -> PathBuf {
    match tracker {
        TrackerChoice::Dsp => dir.join(format!("{sha}-v{ANALYSIS_VERSION}-dsp.json")),
        _ => dir.join(format!("{sha}-v{ANALYSIS_VERSION}.json")),
    }
}

/// A cached result is reused only for the same bytes and version, and only while it is still the best this build can do: a fallback made without the model goes stale once the model is present, and any result the model produced or tried goes stale when its pin moves.
fn cache_is_fresh(
    v: &Value,
    sha: &str,
    tracker: TrackerChoice,
    model_ok: impl FnOnce() -> bool,
) -> bool {
    if v["version"] != ANALYSIS_VERSION || v["sha256"] != sha {
        return false;
    }
    match (tracker, v["tracker"].as_str()) {
        (TrackerChoice::Dsp, Some("dsp")) => true,
        (TrackerChoice::Dsp, _) => false,
        (_, Some("nn")) => v["model"]["sha256"] == nn::BEAT_MODEL_SHA256,
        (TrackerChoice::Nn, _) => false,
        (TrackerChoice::Auto, Some("dsp")) => match v["model"]["sha256"].as_str() {
            Some(sha) => sha == nn::BEAT_MODEL_SHA256,
            None => !(v["fallbackReason"].is_string() && model_ok()),
        },
        _ => false,
    }
}

fn round_to(v: f64, dp: i32) -> f64 {
    let f = 10f64.powi(dp);
    (v * f).round() / f
}

/// One beat of the output: track ms, 1-based bar (0 = pickup) and beat, tracker confidence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Beat {
    pub ms: f64,
    pub bar: i64,
    pub beat: i64,
    pub conf: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fit {
    pub line: LineFit,
    pub beats_per_bar: usize,
    /// Track ms of bar 1 beat 1.
    pub offset_ms: f64,
}

/// The beat-tracking core over decoded PCM: everything the lane and the grid need.
#[derive(Debug, Clone)]
pub struct Core {
    pub tracker: &'static str,
    pub fallback_reason: Option<String>,
    /// The model ran, whether or not its beats were used.
    pub model_ran: bool,
    pub duration_ms: f64,
    pub fit: Option<Fit>,
    pub beats: Vec<Beat>,
    pub strength: Vec<f64>,
    pub fine_envelope: Vec<f64>,
    pub hop_ms: f64,
}

fn hop_ms() -> f64 {
    ONSET_HOP as f64 / f64::from(SAMPLE_RATE) * 1000.0
}

/// The DSP line: tempo estimate, coarse phase, refinement, then the octave and half-beat guards (each re-refining when it moves the grid).
fn dsp_line(strength: &[f64], low: &[f64], hop: f64, duration_ms: f64) -> Option<LineFit> {
    let bpm0 = onset::estimate_tempo(strength, hop)?;
    let phase0 = onset::align_phase(strength, hop, bpm0, duration_ms);
    let mut line = fit::refine_grid_fit(strength, hop, 60_000.0 / bpm0, phase0, duration_ms)?;
    let (p, phase) = fit::octave_guard(strength, hop, line.period_ms, line.phase_ms, duration_ms);
    if p != line.period_ms || phase != line.phase_ms {
        if let Some(next) = fit::refine_grid_fit(strength, hop, p, phase, duration_ms) {
            line = next;
        }
    }
    if let Some(phase) = fit::half_beat_guard(low, hop, line.period_ms, line.phase_ms, duration_ms)
    {
        if let Some(next) = fit::refine_grid_fit(strength, hop, line.period_ms, phase, duration_ms)
        {
            line = next;
        }
    }
    Some(line)
}

fn grid_index(line: &LineFit, t: f64) -> i64 {
    ((t - line.phase_ms) / line.period_ms).round() as i64
}

/// Bars between consecutive tracked downbeats, as a median, kept to 2..=12.
fn tracked_beats_per_bar(tracked: &nn::Tracked) -> usize {
    let mut lengths: Vec<usize> = Vec::new();
    let mut since: Option<usize> = None;
    for &count in &tracked.counts {
        if count == 1 {
            if let Some(n) = since {
                lengths.push(n);
            }
            since = Some(1);
        } else if let Some(n) = since.as_mut() {
            *n += 1;
        }
    }
    if lengths.is_empty() {
        return DEFAULT_BEATS_PER_BAR;
    }
    lengths.sort_unstable();
    lengths[lengths.len() / 2].clamp(2, 12)
}

/// The downbeat phase (grid index mod beats per bar) most tracked downbeats land on.
fn tracked_downbeat_phase(
    line: &LineFit,
    downbeats: &[f64],
    beats_per_bar: usize,
) -> Option<usize> {
    let mut votes = vec![0usize; beats_per_bar];
    for &t in downbeats {
        let k = grid_index(line, t);
        if k >= 0 {
            votes[k as usize % beats_per_bar] += 1;
        }
    }
    let best = (0..beats_per_bar).max_by_key(|&j| (votes[j], std::cmp::Reverse(j)))?;
    (votes[best] > 0).then_some(best)
}

fn grid_beats(
    line: &LineFit,
    duration_ms: f64,
    downbeat: usize,
    beats_per_bar: usize,
    conf: impl Fn(f64) -> f64,
) -> Vec<Beat> {
    line.beat_times(duration_ms)
        .into_iter()
        .enumerate()
        .map(|(k, ms)| {
            let rel = k as i64 - downbeat as i64;
            Beat {
                ms,
                bar: rel.div_euclid(beats_per_bar as i64) + 1,
                beat: rel.rem_euclid(beats_per_bar as i64) + 1,
                conf: round_to(conf(ms).clamp(0.0, 1.0), 3),
            }
        })
        .collect()
}

/// The 95th-percentile onset strength on the grid: the level a confident DSP beat reaches.
fn strength_scale(strength: &[f64], hop: f64, times: &[f64]) -> f64 {
    let mut v: Vec<f64> = times
        .iter()
        .map(|&t| fit::strength_near(strength, hop, t))
        .collect();
    if v.is_empty() {
        return 1.0;
    }
    v.sort_by(f64::total_cmp);
    let p95 = v[((v.len() as f64 * 0.95) as usize).min(v.len() - 1)];
    if p95 > 0.0 {
        p95
    } else {
        1.0
    }
}

/// Track beats over mono `SAMPLE_RATE` PCM. `model` None (or a failed pass) means the DSP fit with `fallback_reason` set when the model was wanted.
pub fn analyse_pcm(
    samples: &[f32],
    choice: TrackerChoice,
    model: Result<&ModelFiles, &str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Core, SongError> {
    let hop = hop_ms();
    let duration_ms = (samples.len() as f64 / f64::from(SAMPLE_RATE) * 1000.0).round();
    let fine_envelope = onset::rms_envelope(samples, ONSET_HOP);
    let strength = onset::smooth3(&onset::onset_strength(&fine_envelope));
    let low = fit::low_band_onset(samples, SAMPLE_RATE);
    let mut fallback_reason: Option<String> = None;
    let mut tracked: Option<nn::Tracked> = None;
    let model_ran = choice != TrackerChoice::Dsp && model.is_ok();
    if choice != TrackerChoice::Dsp {
        match model {
            Ok(files) => match nn::track(files, samples, SAMPLE_RATE, cancelled) {
                Ok(t) if t.beats_ms.len() >= MIN_TRACKED_BEATS => tracked = Some(t),
                Ok(_) => fallback_reason = Some("the model found too few beats".to_owned()),
                Err(e) if e == "interrupted" => {
                    return Err(SongError::new(
                        "interrupted",
                        "the analysis was interrupted",
                    ))
                }
                Err(e) => fallback_reason = Some(e),
            },
            Err(reason) => fallback_reason = Some(reason.to_owned()),
        }
        if choice == TrackerChoice::Nn && tracked.is_none() {
            return Err(SongError::new(
                "model",
                fallback_reason.unwrap_or_else(|| "the model did not run".to_owned()),
            ));
        }
    }
    if cancelled() {
        return Err(SongError::new(
            "interrupted",
            "the analysis was interrupted",
        ));
    }

    let (tracker, fit, beats) = match &tracked {
        Some(t) => {
            let line = fit::line_through(&t.beats_ms)
                .and_then(|(p, phase)| fit::refine_grid_fit(&strength, hop, p, phase, duration_ms));
            let beats_per_bar = tracked_beats_per_bar(t);
            match line {
                Some(line) => {
                    let downbeat = tracked_downbeat_phase(&line, &t.downbeats_ms, beats_per_bar)
                        .unwrap_or_else(|| {
                            let times = line.beat_times(duration_ms);
                            fit::downbeat_phase(&strength, &low, hop, &times, beats_per_bar)
                        });
                    let conf_at = |ms: f64| {
                        let window = line.period_ms / 4.0;
                        t.beats_ms
                            .iter()
                            .zip(&t.conf)
                            .filter(|(b, _)| (**b - ms).abs() <= window)
                            .map(|(_, c)| *c)
                            .fold(0.0, f64::max)
                    };
                    let beats = if line.constant_tempo() {
                        grid_beats(&line, duration_ms, downbeat, beats_per_bar, conf_at)
                    } else {
                        tracked_beats(t, &strength, hop, line.period_ms / 8.0)
                    };
                    let offset_ms = line.phase_ms + downbeat as f64 * line.period_ms;
                    (
                        "nn",
                        Some(Fit {
                            line,
                            beats_per_bar,
                            offset_ms,
                        }),
                        beats,
                    )
                }
                None => ("nn", None, tracked_beats(t, &strength, hop, 0.0)),
            }
        }
        None => match dsp_line(&strength, &low, hop, duration_ms) {
            Some(line) => {
                let times = line.beat_times(duration_ms);
                let downbeat =
                    fit::downbeat_phase(&strength, &low, hop, &times, DEFAULT_BEATS_PER_BAR);
                let scale = strength_scale(&strength, hop, &times);
                let beats = grid_beats(&line, duration_ms, downbeat, DEFAULT_BEATS_PER_BAR, |ms| {
                    fit::strength_near(&strength, hop, ms) / scale
                });
                let offset_ms = line.phase_ms + downbeat as f64 * line.period_ms;
                (
                    "dsp",
                    Some(Fit {
                        line,
                        beats_per_bar: DEFAULT_BEATS_PER_BAR,
                        offset_ms,
                    }),
                    beats,
                )
            }
            None => ("dsp", None, Vec::new()),
        },
    };
    Ok(Core {
        tracker,
        fallback_reason: if tracker == "dsp" {
            fallback_reason
        } else {
            None
        },
        model_ran,
        duration_ms,
        fit,
        beats,
        strength,
        fine_envelope,
        hop_ms: hop,
    })
}

/// A drifting track keeps the model's own beats, each moved onto the nearest onset peak (within `window` ms) and numbered by its tracked bar position.
fn tracked_beats(t: &nn::Tracked, strength: &[f64], hop: f64, window: f64) -> Vec<Beat> {
    let mut bar = 0i64;
    t.beats_ms
        .iter()
        .enumerate()
        .map(|(i, &ms)| {
            let count = i64::from(t.counts.get(i).copied().unwrap_or(1));
            if count == 1 {
                bar += 1;
            }
            let ms = if window > 0.0 {
                fit::snap_to_onset(strength, hop, ms, window).unwrap_or(ms)
            } else {
                ms
            };
            Beat {
                ms,
                bar,
                beat: count.max(1),
                conf: round_to(t.conf.get(i).copied().unwrap_or(0.0), 3),
            }
        })
        .collect()
}

/// Extras gathered beside the core: the loudness series, lyrics and the decoder version.
struct Extras {
    loudness: Result<decode::Loudness, String>,
    lyrics: Option<decode::Lyrics>,
    decoder_version: Option<String>,
}

fn fit_json(fit: &Fit) -> Value {
    let line = &fit.line;
    json!({
        "bpm": round_to(line.bpm(), 3),
        "offsetMs": round_to(fit.offset_ms, 3),
        "beatsPerBar": fit.beats_per_bar,
        "periodMs": round_to(line.period_ms, 3),
        "phaseMs": round_to(line.phase_ms, 3),
        "residualMs": round_to(line.residual_ms, 2),
        "maxDriftMs": round_to(line.max_drift_ms, 2),
        "constantTempo": line.constant_tempo(),
    })
}

fn assemble(sha: &str, samples: &[f32], core: &Core, extras: Extras) -> Value {
    let energy = match &extras.loudness {
        Ok(l) if !l.momentary.is_empty() => json!({
            "hopMs": LOUDNESS_HOP_MS,
            "momentaryLufs": l.momentary.iter().map(|v| round_to(*v, 1)).collect::<Vec<_>>(),
            "shortTermLufs": l.short_term.iter().map(|v| round_to(*v, 1)).collect::<Vec<_>>(),
            "integratedLufs": l.integrated,
            "rangeLu": l.range,
        }),
        _ => Value::Null,
    };
    let momentary: &[f64] = match &extras.loudness {
        Ok(l) => &l.momentary,
        Err(_) => &[],
    };
    let (sections, stabs) = match &core.fit {
        Some(fit) => {
            let bars = structure::Bars::new(
                fit.offset_ms,
                fit.line.period_ms * fit.beats_per_bar as f64,
                core.duration_ms,
            );
            (
                structure::sections(&bars, momentary, &core.strength, core.hop_ms),
                structure::stabs(
                    &core.strength,
                    core.hop_ms,
                    fit.line.period_ms,
                    fit.offset_ms,
                    fit.beats_per_bar,
                ),
            )
        }
        None => (Vec::new(), vec![0.0; DEFAULT_BEATS_PER_BAR * 4]),
    };
    let display = onset::rms_envelope(samples, ENVELOPE_HOP);
    let key_moments = onset::detect_key_moments(&core.fine_envelope, &core.strength, core.hop_ms);
    json!({
        "version": ANALYSIS_VERSION,
        "sha256": sha,
        "decoder": {
            "name": "ffmpeg",
            "version": extras.decoder_version,
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
        },
        "tracker": core.tracker,
        "model": if core.model_ran {
            json!({ "name": MODEL_NAME, "sha256": nn::BEAT_MODEL_SHA256 })
        } else {
            Value::Null
        },
        "fallbackReason": core.fallback_reason,
        "durationMs": core.duration_ms as u64,
        "fit": core.fit.as_ref().map_or(Value::Null, fit_json),
        "beats": core.beats.iter().map(|b| json!({
            "ms": round_to(b.ms, 3),
            "bar": b.bar,
            "beat": b.beat,
            "conf": b.conf,
        })).collect::<Vec<_>>(),
        "energy": energy,
        "sections": sections,
        "breaths": structure::breaths(samples, SAMPLE_RATE),
        "stabs": { "per16th": stabs },
        "lyrics": extras.lyrics.map(|l| json!({ "source": l.source, "lang": l.lang, "text": l.text })),
        "keyMoments": key_moments.iter().map(|m| json!({ "tMs": m.t_ms, "strength": m.strength })).collect::<Vec<_>>(),
        "envelope": {
            "hopMs": round_to(ENVELOPE_HOP as f64 / f64::from(SAMPLE_RATE) * 1000.0, 3),
            "values": display.iter().map(|v| round_to(*v, 3)).collect::<Vec<_>>(),
        },
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    crate::hex_digest(Sha256::digest(bytes).as_slice())
}

fn write_cache(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, value.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Analyse one audio file, cache first. `cancelled` is polled through the decode and the model pass.
pub fn analyse(req: &Request, cancelled: &dyn Fn() -> bool) -> Result<Outcome, SongError> {
    let bytes = std::fs::read(req.file)
        .map_err(|e| SongError::new("missing", format!("{}: {e}", req.file.display())))?;
    let sha = sha256_hex(&bytes);
    drop(bytes);
    let locate = || {
        if req.tracker == TrackerChoice::Dsp {
            Err("the DSP tracker was asked for".to_owned())
        } else {
            nn::locate(req.model_dirs)
        }
    };
    let mut located: Option<Result<ModelFiles, String>> = None;
    let cache = req.cache_dir.map(|dir| cache_path(dir, &sha, req.tracker));
    if let (Some(path), false) = (&cache, req.force) {
        if let Some(v) = std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            let fresh = cache_is_fresh(&v, &sha, req.tracker, || {
                let found = locate();
                let ok = found.is_ok();
                located = Some(found);
                ok
            });
            if fresh {
                return Ok(Outcome {
                    analysis: v,
                    cached: true,
                    cache_path: cache,
                });
            }
        }
    }
    let model = located.unwrap_or_else(locate);

    let samples = decode::decode_pcm(req.ffmpeg, req.file, cancelled).map_err(|e| {
        if e == "interrupted" {
            SongError::new("interrupted", "the analysis was interrupted")
        } else {
            SongError::new("ffmpeg", e)
        }
    })?;
    let (ffmpeg, ffprobe, file) = (
        req.ffmpeg.to_path_buf(),
        req.ffprobe.to_path_buf(),
        req.file.to_path_buf(),
    );
    let side = std::thread::spawn(move || Extras {
        loudness: decode::loudness(&ffmpeg, &file),
        lyrics: decode::lyrics(&ffprobe, &file).ok().flatten(),
        decoder_version: decode::ffmpeg_version(&ffmpeg),
    });
    let core = analyse_pcm(
        &samples,
        req.tracker,
        model.as_ref().map_err(String::as_str),
        cancelled,
    );
    let extras = side
        .join()
        .map_err(|_| SongError::new("internal", "the loudness pass panicked"))?;
    let core = core?;
    let analysis = assemble(&sha, &samples, &core, extras);
    if let Some(path) = &cache {
        if let Err(e) = write_cache(path, &analysis) {
            eprintln!("[song] cache write failed (analysis kept): {e}");
        }
    }
    Ok(Outcome {
        analysis,
        cached: false,
        cache_path: cache,
    })
}

/// Where the app caches analyses (the kit reads the same folder).
pub fn cache_dir(app_data: &Path) -> PathBuf {
    app_data.join("cache").join("beats")
}

/// The beat lane's analysis of a soundtrack: cache-first, else a fresh pass on a blocking thread.
#[tauri::command]
pub async fn song_analysis(
    app: AppHandle,
    state: State<'_, SettingsState>,
    path: String,
    force: Option<bool>,
) -> Result<Value, String> {
    let abs = workspace::confine_readable(&app, &state, &path)?;
    if !abs.is_file() {
        return Err(format!("audio file not found: {path}"));
    }
    let cache = cache_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?);
    let dirs = candidate_dirs(app.path().resource_dir().ok().as_deref());
    let tools = crate::tools::Tools::beside_exe()?;
    tauri::async_runtime::spawn_blocking(move || {
        let req = Request {
            file: &abs,
            tracker: TrackerChoice::Auto,
            force: force.unwrap_or(false),
            ffmpeg: &tools.ffmpeg,
            ffprobe: &tools.ffprobe,
            cache_dir: Some(&cache),
            model_dirs: &dirs,
        };
        analyse(&req, &|| false)
            .map(|o| o.analysis)
            .map_err(|e| e.message)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
