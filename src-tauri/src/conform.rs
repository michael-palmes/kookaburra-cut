//! Ingest conform: a variable-rate, edit-listed, misdecoded or wide-gamut recording becomes a constant 60 fps libx264 mezzanine plus `<stem>.timing.json`, decoded by AVFoundation (conform_av.rs, the one unsafe module) so the timing matches what QuickTime shows. The planning (the slot map, holds, triggers and the timing record) is pure and unit-tested here; the encode pipes raw NV12 into the bundled ffmpeg. Shared by `<exe> media` (cli_media.rs) and the app's import path (media.rs). Contract: docs/decisions.md (ingest conform).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{json, Value};

use crate::edit::CoreError;
use crate::mp4box::EditStart;

/// The mezzanine rate: the clip extraction rate (`CLIP_FPS`) and the frontend `FPS`.
pub(crate) const CONFORM_FPS: u32 = 60;
/// Bumped when the `timing.json` shape changes incompatibly.
pub(crate) const TIMING_VERSION: u32 = 1;
/// Bumped when the probe or conform JSON changes incompatibly; `edit caps` lists it under `media`.
pub(crate) const MEDIA_CLI_VERSION: u32 = 1;
pub(crate) const ORIGINALS_DIR: &str = ".originals";
const STAGING_DIR: &str = ".kc-render";
const CRF: u32 = 16;
const GOP: u32 = 30;
/// Leading packets the static probe reads for ffmpeg's discard flags: a trim's discarded GOP sits at the start.
const PACKET_SCAN: u32 = 600;
/// Decoders that disagree by more than this on a frame time are misdecoding, not rounding.
const PTS_TOLERANCE_MS: f64 = 2.0;

/// A rational media time, exact like a CMTime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MediaTime {
    pub value: i64,
    pub scale: i32,
}

impl MediaTime {
    pub(crate) fn new(value: i64, scale: i32) -> Self {
        Self { value, scale }
    }

    pub(crate) fn ms(self) -> f64 {
        if self.scale <= 0 {
            return 0.0;
        }
        self.value as f64 * 1000.0 / f64::from(self.scale)
    }

    /// Whether a frame at this time is due by slot `slot` (time `slot / fps`), compared exactly.
    fn due_by(self, slot: u64, fps: u32) -> bool {
        i128::from(self.value) * i128::from(fps) <= i128::from(slot) * i128::from(self.scale)
    }
}

/// ceil(duration × fps): a held last frame keeps its full length.
pub(crate) fn slot_count(duration: MediaTime, fps: u32) -> u64 {
    if duration.value <= 0 || duration.scale <= 0 {
        return 0;
    }
    let num = i128::from(duration.value) * i128::from(fps);
    let den = i128::from(duration.scale);
    ((num + den - 1) / den) as u64
}

fn slot_ms(slot: u64, fps: u32) -> f64 {
    slot as f64 * 1000.0 / f64::from(fps)
}

/// Milliseconds to one decimal, the precision the timing record keeps.
pub(crate) fn tenth(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}

/// Walks the CFR slot grid over frames in presentation order: slot k shows the latest frame due by k / fps, and a late first frame shows from slot 0.
pub(crate) struct SlotWalker<T, I>
where
    I: Iterator<Item = Result<(MediaTime, T), String>>,
{
    frames: I,
    pending: Option<(MediaTime, T)>,
    current: Option<T>,
    fps: u32,
    slots: u64,
    next_slot: u64,
    started: bool,
    /// Every frame taken, in order: the record's `sourcePtsMs`.
    pub pts: Vec<MediaTime>,
    /// `(firstSlot, sourceIndex)` each time the shown frame changes.
    pub runs: Vec<(u64, usize)>,
}

impl<T, I> SlotWalker<T, I>
where
    I: Iterator<Item = Result<(MediaTime, T), String>>,
{
    pub(crate) fn new(frames: I, slots: u64, fps: u32) -> Self {
        Self {
            frames,
            pending: None,
            current: None,
            fps,
            slots,
            next_slot: 0,
            started: false,
            pts: Vec::new(),
            runs: Vec::new(),
        }
    }

    fn pull(&mut self) -> Result<(), String> {
        self.pending = self.frames.next().transpose()?;
        Ok(())
    }

    fn take_pending(&mut self) -> Result<(), String> {
        if let Some((pts, frame)) = self.pending.take() {
            self.pts.push(pts);
            self.current = Some(frame);
        }
        self.pull()
    }

    /// The next slot's frame and whether it changed since the previous slot; None after the last slot.
    pub(crate) fn step(&mut self) -> Result<Option<(&T, bool)>, String> {
        if self.next_slot >= self.slots {
            return Ok(None);
        }
        if !self.started {
            self.started = true;
            self.pull()?;
        }
        let slot = self.next_slot;
        let before = self.pts.len();
        while self
            .pending
            .as_ref()
            .is_some_and(|(pts, _)| pts.due_by(slot, self.fps))
        {
            self.take_pending()?;
        }
        if self.current.is_none() {
            if self.pending.is_none() {
                return Err("the video has no frames to show".into());
            }
            self.take_pending()?;
        }
        let changed = self.pts.len() != before;
        if changed {
            self.runs.push((slot, self.pts.len() - 1));
        }
        self.next_slot += 1;
        Ok(self.current.as_ref().map(|frame| (frame, changed)))
    }

    /// Drain the frames past the last slot (they still count as decoded) and hand back the timing.
    pub(crate) fn finish(mut self) -> Result<SlotMap, String> {
        if !self.started {
            self.pull()?;
        }
        while let Some((pts, _)) = self.pending.take() {
            self.pts.push(pts);
            self.pull()?;
        }
        Ok(SlotMap {
            slots: self.slots,
            pts: self.pts,
            runs: self.runs,
        })
    }
}

/// The slot map alone, for timing tests.
#[cfg(test)]
pub(crate) fn map_slots(
    pts: &[MediaTime],
    duration: MediaTime,
    fps: u32,
) -> Result<SlotMap, String> {
    let slots = slot_count(duration, fps);
    let mut walker = SlotWalker::new(pts.iter().map(|p| Ok((*p, ()))), slots, fps);
    while walker.step()?.is_some() {}
    walker.finish()
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SlotMap {
    pub slots: u64,
    pub pts: Vec<MediaTime>,
    pub runs: Vec<(u64, usize)>,
}

/// One source frame shown for much longer than the clip's usual cadence.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hold {
    pub from_ms: f64,
    pub to_ms: f64,
    /// First and last slot, inclusive.
    pub slots: [u64; 2],
    pub source: usize,
}

/// Runs at least twice the median run and three slots long, so a steady 24, 30 or 60 fps clip lists none.
pub(crate) fn holds(runs: &[(u64, usize)], slots: u64, fps: u32) -> Vec<Hold> {
    let spans: Vec<(u64, u64, usize)> = runs
        .iter()
        .enumerate()
        .map(|(i, (first, source))| {
            let end = runs.get(i + 1).map_or(slots, |next| next.0);
            (*first, end, *source)
        })
        .collect();
    let mut lengths: Vec<u64> = spans.iter().map(|(a, b, _)| b - a).collect();
    if lengths.is_empty() {
        return Vec::new();
    }
    lengths.sort_unstable();
    let threshold = (lengths[lengths.len() / 2] * 2).max(3);
    spans
        .into_iter()
        .filter(|(a, b, _)| b - a >= threshold)
        .map(|(a, b, source)| Hold {
            from_ms: tenth(slot_ms(a, fps)),
            to_ms: tenth(slot_ms(b, fps)),
            slots: [a, b - 1],
            source,
        })
        .collect()
}

/// A colour tag set; None where the file says nothing.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Colour {
    pub primaries: Option<String>,
    pub transfer: Option<String>,
    pub matrix: Option<String>,
    pub range: Option<String>,
}

/// What ffprobe says about a video, beyond the library's `ProbeInfo`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FfFacts {
    pub container: String,
    pub codec: String,
    /// Display size (a quarter turn swaps the coded size), like `ProbeInfo`.
    pub width: u32,
    pub height: u32,
    /// ffprobe's display-matrix rotation in degrees, counter-clockwise.
    pub rotation: i64,
    pub r_fps: f64,
    pub avg_fps: f64,
    pub vfr: bool,
    /// The decoder's reorder delay (`has_b_frames`): above 0 means B-frames.
    pub bframes: u32,
    pub pix_fmt: String,
    pub bits: u32,
    pub colour: Colour,
    pub has_audio: bool,
    pub duration_ms: u64,
    pub nb_frames: Option<u64>,
    /// Packets ffmpeg drops for the edit list, over the leading `PACKET_SCAN`; None when not scanned.
    pub discarded_packets: Option<u32>,
    /// Where the container's edit list opens (mp4box.rs, kb's rule); None when its boxes can't be read.
    pub edit_start: Option<EditStart>,
}

fn tag(stream: &Value, key: &str) -> Option<String> {
    stream[key]
        .as_str()
        .filter(|v| !v.is_empty() && *v != "unknown" && *v != "unspecified")
        .map(str::to_owned)
}

/// ffprobe's `-show_streams -show_format` JSON (`media::probe_args`) read for the conform's facts.
pub(crate) fn parse_ff_facts(stdout: &str, abs: &Path) -> Result<FfFacts, String> {
    let info = crate::media::parse_probe(stdout, abs)?;
    let probe: Value = serde_json::from_str(stdout).map_err(|e| format!("ffprobe json: {e}"))?;
    let streams = probe["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or("no video stream found")?;
    let pix_fmt = video["pix_fmt"].as_str().unwrap_or_default().to_owned();
    let raw_bits = video["bits_per_raw_sample"]
        .as_str()
        .and_then(|b| b.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(FfFacts {
        container: probe["format"]["format_name"]
            .as_str()
            .and_then(|f| f.split(',').next())
            .unwrap_or_default()
            .to_owned(),
        codec: video["codec_name"].as_str().unwrap_or_default().to_owned(),
        width: info.width,
        height: info.height,
        rotation: info.rotation,
        r_fps: info.r_fps,
        avg_fps: info.avg_fps,
        vfr: info.vfr,
        bframes: video["has_b_frames"].as_u64().unwrap_or(0) as u32,
        bits: raw_bits.max(pix_fmt_bits(&pix_fmt)),
        pix_fmt,
        colour: Colour {
            primaries: tag(video, "color_primaries"),
            transfer: tag(video, "color_transfer"),
            matrix: tag(video, "color_space"),
            range: tag(video, "color_range"),
        },
        has_audio: streams
            .iter()
            .any(|s| s["codec_type"].as_str() == Some("audio")),
        duration_ms: info.duration_ms,
        nb_frames: info.nb_frames,
        discarded_packets: None,
        edit_start: None,
    })
}

/// Bit depth a pixel format name implies (`yuv420p10le` is 10); 8 when it names none.
fn pix_fmt_bits(pix_fmt: &str) -> u32 {
    let name = pix_fmt
        .strip_suffix("le")
        .or_else(|| pix_fmt.strip_suffix("be"))
        .unwrap_or(pix_fmt);
    let head = name.trim_end_matches(|c: char| c.is_ascii_digit());
    // The depth follows a `p` (`yuv420p10`, `p010`) or `gray`; `nv12` names its layout, not its depth.
    if !(head.ends_with('p') || head == "gray") {
        return 8;
    }
    match name[head.len()..].parse::<u32>() {
        Ok(bits) if (9..=16).contains(&bits) => bits,
        _ => 8,
    }
}

/// Packets flagged `D` in ffprobe's `packet=flags` CSV (`K__`, `_D_`, `KD_`).
fn count_discarded(csv: &str) -> u32 {
    csv.lines()
        .filter(|line| line.trim().chars().nth(1) == Some('D'))
        .count() as u32
}

fn run_capture(tool: &Path, args: &[String]) -> Result<String, String> {
    let out = crate::tools::sidecar_command(tool)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start {}: {e}", tool.display()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(stderr_tail(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// The ffprobe facts plus the leading packets' discard flags and the container's edit start; no decode.
pub(crate) fn ffprobe_facts(ffprobe: &Path, abs: &Path) -> Result<FfFacts, String> {
    let stdout = run_capture(ffprobe, &crate::media::probe_args(abs))
        .map_err(|e| format!("ffprobe could not read {}: {e}", abs.display()))?;
    let mut facts = parse_ff_facts(&stdout, abs)?;
    let packets = run_capture(
        ffprobe,
        &[
            "-v".into(),
            "error".into(),
            "-select_streams".into(),
            "v:0".into(),
            "-read_intervals".into(),
            format!("%+#{PACKET_SCAN}"),
            "-show_entries".into(),
            "packet=flags".into(),
            "-of".into(),
            "csv=p=0".into(),
            abs.to_string_lossy().into_owned(),
        ],
    );
    facts.discarded_packets = packets.ok().map(|csv| count_discarded(&csv));
    facts.edit_start = crate::mp4box::edit_start(abs);
    Ok(facts)
}

/// Presentation times one decoder produced, in ms.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DecodeTiming {
    pub pts_ms: Vec<f64>,
}

impl DecodeTiming {
    fn first(&self) -> Option<f64> {
        self.pts_ms.first().copied()
    }

    fn last(&self) -> Option<f64> {
        self.pts_ms.last().copied()
    }

    pub(crate) fn summary(&self, duration_ms: Option<f64>) -> Value {
        let mut out = json!({
            "frames": self.pts_ms.len(),
            "firstPtsMs": self.first().map(tenth),
            "lastPtsMs": self.last().map(tenth),
        });
        if let Some(duration) = duration_ms {
            out["durationMs"] = json!(tenth(duration));
        }
        out
    }
}

/// `pts_time:` of every frame ffmpeg's own pipeline passes through (`-fps_mode passthrough`), the timing today's extraction starts from.
pub(crate) fn ffmpeg_decode_timing(
    ffmpeg: &Path,
    abs: &Path,
    background: bool,
    cancel: &AtomicBool,
) -> Result<DecodeTiming, String> {
    let mut child = crate::tools::sidecar_command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info"])
        .args(["-protocol_whitelist", "file,pipe"])
        .arg("-i")
        .arg(abs)
        .args([
            "-map",
            "0:v:0",
            "-vf",
            "showinfo",
            "-fps_mode",
            "passthrough",
        ])
        .args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    if background {
        crate::concurrency::lower_priority(child.id());
    }
    let mut timing = DecodeTiming::default();
    let mut tail = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines() {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(INTERRUPTED.into());
            }
            let Ok(line) = line else { break };
            if let Some(ms) = showinfo_pts_ms(&line) {
                timing.pts_ms.push(ms);
            } else {
                tail.push(line);
                if tail.len() > 16 {
                    tail.remove(0);
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "ffmpeg could not decode the video: {}",
            tail.join("\n")
        ));
    }
    Ok(timing)
}

fn showinfo_pts_ms(line: &str) -> Option<f64> {
    if !line.contains("showinfo") {
        return None;
    }
    let (_, rest) = line.split_once("pts_time:")?;
    rest.split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .map(|s| s * 1000.0)
}

/// One edit-list entry as AVFoundation maps it; `media_start_ms` None for an empty edit (a delay).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditSegment {
    pub media_start_ms: Option<f64>,
    pub media_duration_ms: f64,
    pub target_start_ms: f64,
    pub target_duration_ms: f64,
}

impl EditSegment {
    fn rate(&self) -> f64 {
        if self.media_start_ms.is_none() || self.target_duration_ms <= 0.0 {
            1.0
        } else {
            self.media_duration_ms / self.target_duration_ms
        }
    }
}

/// What AVFoundation says about the first video track, without decoding.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvFacts {
    /// The format description's four-character code (`avc1`, `hvc1`).
    pub codec: String,
    /// Coded (natural) size, before the track transform.
    pub width: u32,
    pub height: u32,
    /// The transform's turn in degrees (AVFoundation's sense, clockwise on screen).
    pub rotation: i64,
    /// A mirrored or non-right-angle transform the mezzanine can't carry.
    pub odd_transform: bool,
    pub nominal_fps: f64,
    pub min_frame_ms: f64,
    #[serde(skip)]
    pub duration: Option<MediaTime>,
    pub duration_ms: f64,
    /// `requiresFrameReordering`: B-frames.
    pub reorders: bool,
    pub colour: Colour,
    pub bits: Option<u32>,
    pub edit_list: Vec<EditSegment>,
    pub has_audio: bool,
}

impl AvFacts {
    fn vfr(&self) -> bool {
        self.nominal_fps > 0.0
            && self.min_frame_ms > 0.0
            && (self.nominal_fps - 1000.0 / self.min_frame_ms).abs() > 0.5
    }

    /// More than one segment, an empty (delay) edit or a retimed one: anything past the B-frame composition delay.
    fn edited(&self) -> bool {
        self.edit_list.len() > 1
            || self
                .edit_list
                .iter()
                .any(|s| s.media_start_ms.is_none() || (s.rate() - 1.0).abs() > 1e-3)
    }
}

fn is_709_primaries(name: &str) -> bool {
    matches!(name, "ITU_R_709_2" | "bt709")
}

fn wide_gamut(ff: &FfFacts, av: Option<&AvFacts>) -> bool {
    let av_tag = av.and_then(|a| a.colour.primaries.as_deref());
    let ff_tag = ff.colour.primaries.as_deref();
    av_tag.or(ff_tag).is_some_and(|tag| !is_709_primaries(tag))
}

/// Whether AVFoundation should convert to BT.709 primaries with the sRGB transfer: only when the tags say the source is not already BT.709, so a BT.709 clip keeps today's code values.
pub(crate) fn needs_colour_convert(ff: &FfFacts, av: Option<&AvFacts>) -> bool {
    let matrix = av
        .and_then(|a| a.colour.matrix.as_deref())
        .or(ff.colour.matrix.as_deref());
    let foreign_matrix = matrix.is_some_and(|m| !matches!(m, "ITU_R_709_2" | "bt709"));
    wide_gamut(ff, av) || foreign_matrix
}

fn hdr(ff: &FfFacts, av: Option<&AvFacts>) -> bool {
    let av_transfer = av.and_then(|a| a.colour.transfer.as_deref());
    [av_transfer, ff.colour.transfer.as_deref()]
        .into_iter()
        .flatten()
        .any(|t| {
            matches!(
                t,
                "SMPTE_ST_2084_PQ" | "ITU_R_2100_HLG" | "smpte2084" | "arib-std-b67"
            )
        })
}

/// Why a file can't be conformed, and what to do instead.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Refusal {
    pub code: &'static str,
    pub hint: &'static str,
}

/// The probe's judgement: whether ffmpeg decodes the file faithfully, and whether to conform it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Verdict {
    /// `ok | suspect | ffmpeg-misdecodes`.
    pub verdict: &'static str,
    pub reasons: Vec<&'static str>,
    pub recommended: bool,
    /// The triggers behind `recommended`.
    pub why: Vec<&'static str>,
    pub refused: Option<Refusal>,
}

/// Compare the two decoders' timelines: a different frame count or span means ffmpeg shows other frames than AVFoundation.
fn decoder_reasons(av: &DecodeTiming, ff: &DecodeTiming) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if av.pts_ms.len() != ff.pts_ms.len() {
        reasons.push("count-mismatch");
    }
    let span = |t: &DecodeTiming| match (t.first(), t.last()) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    if let (Some(a), Some(b)) = (span(av), span(ff)) {
        if (a - b).abs() > PTS_TOLERANCE_MS {
            reasons.push("span-mismatch");
        }
    }
    reasons
}

pub(crate) fn evaluate(
    ff: &FfFacts,
    av: Option<&AvFacts>,
    decoded: Option<(&DecodeTiming, &DecodeTiming)>,
) -> Verdict {
    let mut reasons = Vec::new();
    let mut why = Vec::new();
    let mut verdict = "ok";
    let edited = av.is_some_and(AvFacts::edited)
        || ff.discarded_packets.is_some_and(|n| n > 0)
        || ff.edit_start.is_some_and(EditStart::edited);
    let mismatch = decoded.map_or_else(Vec::new, |(a, f)| decoder_reasons(a, f));
    if ff.vfr || av.is_some_and(AvFacts::vfr) {
        reasons.push("vfr");
        why.push("vfr");
    }
    if edited {
        reasons.push("edit-list");
        why.push("edit-list");
        verdict = "suspect";
    }
    // ffmpeg drops the frame the edit opens inside and shows the next one at 0 s.
    if ff.edit_start == Some(EditStart::MidSample) {
        reasons.push("edit-mid-sample");
        verdict = "ffmpeg-misdecodes";
    }
    // B-frames alone decode fine; they only count beside an edit list or a misdecode.
    if ff.bframes > 0 || av.is_some_and(|a| a.reorders) {
        reasons.push("b-frames");
        if edited || !mismatch.is_empty() {
            why.push("b-frames");
        }
    }
    if wide_gamut(ff, av) {
        reasons.push("primaries");
        why.push("primaries");
    }
    if !mismatch.is_empty() {
        verdict = "ffmpeg-misdecodes";
        why.push("decoders");
        reasons.extend(mismatch);
    }
    let refused = refusal(ff, av);
    if let Some(refusal) = &refused {
        reasons.push(refusal.code);
    }
    Verdict {
        verdict,
        reasons,
        recommended: !why.is_empty() && refused.is_none(),
        why,
        refused,
    }
}

fn refusal(ff: &FfFacts, av: Option<&AvFacts>) -> Option<Refusal> {
    let Some(av) = av else {
        return Some(Refusal {
            code: "unreadable",
            hint: "AVFoundation can't read this video (a WebM or VP9 file?): export it as H.264 or HEVC first",
        });
    };
    if hdr(ff, Some(av)) {
        return Some(Refusal {
            code: "hdr",
            hint: "HDR video (PQ or HLG) can't be conformed: export an SDR version first",
        });
    }
    if ff.bits > 8 || av.bits.is_some_and(|b| b > 8) {
        return Some(Refusal {
            code: "10-bit",
            hint: "10-bit video can't be conformed: export an 8-bit H.264 or HEVC version first",
        });
    }
    if av.odd_transform {
        return Some(Refusal {
            code: "transform",
            hint: "the video is mirrored or turned by an odd angle: export it upright first",
        });
    }
    None
}

/// The `probe` JSON: both decoders' facts and the verdict (the CLI prints it; the app caches it by content sha).
pub(crate) fn probe_report(
    ff: &FfFacts,
    av: Option<&AvFacts>,
    decoded: Option<(&DecodeTiming, &DecodeTiming)>,
    with_pts: bool,
) -> Value {
    let verdict = evaluate(ff, av, decoded);
    let mut ffmpeg = serde_json::to_value(ff).unwrap_or(Value::Null);
    let mut avfoundation = av
        .and_then(|a| serde_json::to_value(a).ok())
        .unwrap_or(Value::Null);
    if let Some((av_timing, ff_timing)) = decoded {
        ffmpeg["decode"] = ff_timing.summary(None);
        if avfoundation.is_object() {
            avfoundation["decode"] = av_timing.summary(av.map(|a| a.duration_ms));
        }
        if with_pts {
            ffmpeg["decode"]["ptsMs"] = json!(ff_timing
                .pts_ms
                .iter()
                .map(|p| tenth(*p))
                .collect::<Vec<_>>());
            if avfoundation.is_object() {
                avfoundation["decode"]["ptsMs"] = json!(av_timing
                    .pts_ms
                    .iter()
                    .map(|p| tenth(*p))
                    .collect::<Vec<_>>());
            }
        }
    }
    json!({
        "ffmpeg": ffmpeg,
        "avfoundation": avfoundation,
        "verdict": verdict.verdict,
        "reasons": verdict.reasons,
        "conform": {
            "recommended": verdict.recommended,
            "why": verdict.why,
            "refused": verdict.refused,
        },
    })
}

/// AVFoundation's facts, or why it can't read the file (always the latter off macOS).
pub(crate) fn av_facts(abs: &Path) -> Result<AvFacts, String> {
    #[cfg(target_os = "macos")]
    {
        crate::conform_av::probe(abs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = abs;
        Err("AVFoundation needs macOS".into())
    }
}

/// The static probe: ffprobe and AVFoundation facts, no decode.
pub(crate) fn probe_static(
    ffprobe: &Path,
    abs: &Path,
) -> Result<(FfFacts, Option<AvFacts>), String> {
    let ff = ffprobe_facts(ffprobe, abs)?;
    Ok((ff, av_facts(abs).ok()))
}

/// One decoded source frame: its presentation time and, when pixels were asked for, even-cropped NV12.
pub(crate) struct SourceFrame {
    pub width: u32,
    pub height: u32,
    pub nv12: Vec<u8>,
}

type FrameIter = Box<dyn Iterator<Item = Result<(MediaTime, SourceFrame), String>>>;

fn av_frames(abs: &Path, convert_colour: bool, pixels: bool) -> Result<FrameIter, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(crate::conform_av::Frames::open(
            abs,
            convert_colour,
            pixels,
        )?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (abs, convert_colour, pixels);
        Err("AVFoundation needs macOS".into())
    }
}

/// AVFoundation's presentation times, decoding every frame but keeping no pixels.
pub(crate) fn av_decode_timing(abs: &Path, cancel: &AtomicBool) -> Result<DecodeTiming, String> {
    let mut timing = DecodeTiming::default();
    for frame in av_frames(abs, false, false)? {
        if cancel.load(Ordering::SeqCst) {
            return Err(INTERRUPTED.into());
        }
        timing.pts_ms.push(frame?.0.ms());
    }
    Ok(timing)
}

pub(crate) const INTERRUPTED: &str = "interrupted";

const COLOUR_TAGS: &[&str] = &[
    "-color_primaries",
    "bt709",
    "-color_trc",
    "iec61966-2-1",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
];

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn container(mov: bool) -> &'static str {
    if mov {
        "mov"
    } else {
        "mp4"
    }
}

/// The ffmpeg argv for the mezzanine: raw NV12 on stdin to libx264 with the colour tags the clip path reads, bit-exact so two runs match.
pub(crate) fn encode_args(width: u32, height: u32, mov: bool, out: &Path) -> Vec<String> {
    let mut args = strings(&["-hide_banner", "-nostats", "-loglevel", "error", "-y"]);
    args.extend(strings(&["-f", "rawvideo", "-pix_fmt", "nv12", "-s"]));
    args.push(format!("{width}x{height}"));
    args.extend(["-r".into(), CONFORM_FPS.to_string()]);
    // The same tags on the raw input: untagged NV12 reads as BT.601, and ffmpeg would convert it on the way to the BT.709 output.
    args.extend(strings(COLOUR_TAGS));
    args.extend(strings(&[
        "-i", "-", "-c:v", "libx264", "-preset", "veryfast",
    ]));
    args.extend(["-crf".into(), CRF.to_string(), "-bf".into(), "0".into()]);
    args.extend(["-g".into(), GOP.to_string()]);
    args.extend(strings(&["-pix_fmt", "yuv420p"]));
    args.extend(strings(COLOUR_TAGS));
    args.extend(strings(&["-flags:v", "+bitexact", "-fflags", "+bitexact"]));
    args.extend(strings(&["-map_metadata", "-1", "-an", "-f"]));
    args.push(container(mov).into());
    args.push(out.to_string_lossy().into_owned());
    args
}

/// The stream copy that gives a turned mezzanine its source's display matrix: ffmpeg drops a raw input's matrix at encode, so it rides in on a remux.
pub(crate) fn rotate_args(rotation: i64, mov: bool, input: &Path, out: &Path) -> Vec<String> {
    let mut args = strings(&["-hide_banner", "-nostats", "-loglevel", "error", "-y"]);
    args.extend([
        "-display_rotation".into(),
        rotation.to_string(),
        "-i".into(),
    ]);
    args.push(input.to_string_lossy().into_owned());
    args.extend(strings(&["-map", "0:v:0", "-c", "copy"]));
    args.extend(strings(&[
        "-fflags",
        "+bitexact",
        "-map_metadata",
        "-1",
        "-f",
    ]));
    args.push(container(mov).into());
    args.push(out.to_string_lossy().into_owned());
    args
}

fn stderr_tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

/// A conform's progress, for JSON lines and the app's chip.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ConformEvent {
    Start { total: u64, out: PathBuf },
    Progress { frame: u64, total: u64 },
}

/// What the encode produced, before the files move into place.
struct Encoded {
    width: u32,
    height: u32,
    map: SlotMap,
}

/// One encode: the source AVFoundation decodes and where ffmpeg writes.
struct EncodeJob<'a> {
    source: &'a Path,
    duration: MediaTime,
    convert_colour: bool,
    mov: bool,
    out: &'a Path,
}

/// Decode with AVFoundation, map onto the slot grid and stream every slot into ffmpeg.
fn encode(
    tools: &ConformTools,
    job: &EncodeJob<'_>,
    on: &mut dyn FnMut(ConformEvent),
    cancel: &AtomicBool,
) -> Result<Encoded, CoreError> {
    let EncodeJob {
        source,
        duration,
        convert_colour,
        mov,
        out,
    } = *job;
    let slots = slot_count(duration, CONFORM_FPS);
    if slots == 0 {
        return Err(CoreError::new(
            "invalid",
            "the video has no duration to conform",
        ));
    }
    let frames =
        av_frames(source, convert_colour, true).map_err(|e| CoreError::new("invalid", e))?;
    let mut walker = SlotWalker::new(frames, slots, CONFORM_FPS);
    let mut child: Option<std::process::Child> = None;
    let mut stdin: Option<std::process::ChildStdin> = None;
    let mut drain: Option<std::thread::JoinHandle<String>> = None;
    let mut size = (0u32, 0u32);
    let mut frame_no = 0u64;
    let fail = |child: &mut Option<std::process::Child>| {
        if let Some(mut c) = child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    };
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(stdin.take());
            fail(&mut child);
            return Err(CoreError::new("interrupted", "the conform was interrupted"));
        }
        let step = match walker.step() {
            Ok(step) => step,
            Err(e) => {
                drop(stdin.take());
                fail(&mut child);
                return Err(CoreError::new(
                    "invalid",
                    format!("AVFoundation could not decode the video: {e}"),
                ));
            }
        };
        let Some((frame, _)) = step else { break };
        if child.is_none() {
            size = (frame.width, frame.height);
            let mut spawned = crate::tools::sidecar_command(&tools.ffmpeg)
                .args(encode_args(frame.width, frame.height, mov, out))
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| CoreError::new("env", format!("failed to start ffmpeg: {e}")))?;
            if tools.background {
                crate::concurrency::lower_priority(spawned.id());
            }
            stdin = spawned.stdin.take();
            let stderr = spawned.stderr.take();
            drain = Some(std::thread::spawn(move || {
                let mut text = String::new();
                if let Some(mut stderr) = stderr {
                    let _ = stderr.read_to_string(&mut text);
                }
                text
            }));
            child = Some(spawned);
            on(ConformEvent::Start {
                total: slots,
                out: out.to_path_buf(),
            });
        }
        if (frame.width, frame.height) != size {
            drop(stdin.take());
            fail(&mut child);
            return Err(CoreError::new(
                "invalid",
                "the video changes size mid-stream: conform can't keep one frame size",
            ));
        }
        let wrote = stdin
            .as_mut()
            .map(|pipe| pipe.write_all(&frame.nv12))
            .unwrap_or(Ok(()));
        if let Err(e) = wrote {
            drop(stdin.take());
            fail(&mut child);
            let tail = drain.take().and_then(|d| d.join().ok()).unwrap_or_default();
            return Err(CoreError::new(
                "ffmpeg",
                format!("ffmpeg stopped taking frames ({e}): {}", stderr_tail(&tail)),
            ));
        }
        frame_no += 1;
        if frame_no % 30 == 0 || frame_no == slots {
            on(ConformEvent::Progress {
                frame: frame_no,
                total: slots,
            });
        }
    }
    drop(stdin.take());
    let status = child.as_mut().map(|c| c.wait());
    let tail = drain.and_then(|d| d.join().ok()).unwrap_or_default();
    match status {
        Some(Ok(status)) if status.success() => {}
        Some(Ok(status)) => {
            return Err(CoreError::new(
                "ffmpeg",
                format!(
                    "ffmpeg exited with {:?}: {}",
                    status.code(),
                    stderr_tail(&tail)
                ),
            ))
        }
        Some(Err(e)) => return Err(CoreError::new("ffmpeg", e.to_string())),
        None => {
            return Err(CoreError::new(
                "invalid",
                "the video has no frames to conform",
            ))
        }
    }
    let map = walker.finish().map_err(|e| {
        CoreError::new(
            "invalid",
            format!("AVFoundation could not decode the video: {e}"),
        )
    })?;
    Ok(Encoded {
        width: size.0,
        height: size.1,
        map,
    })
}

/// What happens to the source once its mezzanine lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeepOriginal {
    /// The original lives only in `assets/.originals/`.
    Move,
    /// The source stays where it was too (only when the mezzanine has another name).
    Copy,
}

/// Where a conform reads, keeps and writes; every path inside the project's `assets/`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConformPlan {
    pub source_rel: String,
    pub original_rel: String,
    pub target_rel: String,
    pub timing_rel: String,
    pub keep: KeepOriginal,
    pub force: bool,
}

impl ConformPlan {
    pub(crate) fn in_place(&self) -> bool {
        self.source_rel == self.target_rel
    }
}

fn split_rel(rel: &str) -> (&str, &str) {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

fn valid_stem(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && !name.contains("..")
}

/// The plan for conforming `source_rel`: in place (same rel, same container) unless `name` or an original under `assets/.originals/` asks for a new `assets/<name>.mp4`.
pub(crate) fn plan(
    source_rel: &str,
    name: Option<&str>,
    keep: KeepOriginal,
    force: bool,
) -> Result<ConformPlan, CoreError> {
    let source_rel = source_rel.trim_start_matches("./").to_owned();
    let inside_assets = source_rel.starts_with("assets/")
        && !source_rel.split('/').any(|p| p == ".." || p.is_empty());
    if !inside_assets {
        return Err(CoreError::new(
            "usage",
            format!("--source must be a file under assets/, not {source_rel:?}"),
        ));
    }
    let (stem, ext) = split_rel(&source_rel);
    let ext = ext.to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
        return Err(CoreError::new(
            "invalid",
            format!("{source_rel} is not an MP4, MOV or M4V video AVFoundation can conform"),
        ));
    }
    let originals_prefix = format!("assets/{ORIGINALS_DIR}/");
    let from_originals = source_rel.starts_with(&originals_prefix);
    let file_name = source_rel.rsplit('/').next().unwrap_or_default().to_owned();
    if let Some(name) = name {
        if !valid_stem(name) {
            return Err(CoreError::new(
                "usage",
                format!("{name:?} is not a file name: no slashes, no leading dot"),
            ));
        }
    }
    let in_place = !from_originals && name.map_or(true, |n| n == stem);
    let target_rel = if in_place {
        source_rel.clone()
    } else {
        format!("assets/{}.mp4", name.unwrap_or(stem))
    };
    if keep == KeepOriginal::Copy && target_rel == source_rel {
        return Err(CoreError::new(
            "usage",
            "--keep-original copy needs a mezzanine with another name: give --name",
        ));
    }
    let original_rel = if from_originals {
        source_rel.clone()
    } else {
        format!("{originals_prefix}{file_name}")
    };
    let (target_stem, _) = split_rel(&target_rel);
    let target_dir = target_rel.rsplit_once('/').map_or("assets", |(dir, _)| dir);
    Ok(ConformPlan {
        timing_rel: format!("{target_dir}/{target_stem}.timing.json"),
        source_rel,
        original_rel,
        target_rel,
        keep,
        force,
    })
}

/// A finished conform: the record and where everything landed.
#[derive(Debug, Clone)]
pub(crate) struct ConformOutcome {
    pub target_rel: String,
    pub original_rel: String,
    pub timing_rel: String,
    pub frames: u64,
    pub duration_ms: f64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub verdict: Verdict,
}

/// The tools a conform runs; `background` drops ffmpeg's priority (the app's import jobs).
pub(crate) struct ConformTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub background: bool,
}

fn io(code: &'static str) -> impl Fn(std::io::Error) -> CoreError {
    move |e| CoreError::new(code, e.to_string())
}

fn sha256_file(path: &Path) -> Result<(String, u64), CoreError> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(io("missing"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut bytes = 0u64;
    loop {
        let read = file.read(&mut buf).map_err(io("invalid"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hasher.update(&buf[..read]);
    }
    Ok((crate::hex_digest(hasher.finalize().as_slice()), bytes))
}

/// The mezzanine while ffmpeg writes it: a hidden FOLDER (`assets/.kc-render/`) because hidden files would list in the media library; dropped on any failure.
struct Staging {
    dir: PathBuf,
    file: PathBuf,
}

impl Staging {
    fn create(assets: &Path, file_name: &str) -> Result<Self, CoreError> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = crate::real_dir::real_dir(assets, STAGING_DIR)
            .map_err(|e| CoreError::new("invalid", e))?;
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let file = dir.join(format!("{}-{seq}-conform-{file_name}", std::process::id()));
        Ok(Self { dir, file })
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// The original's copy in `assets/.originals/` until the mezzanine lands; a failed conform removes it, so a retry needs no `--force`.
struct KeptCopy(Option<PathBuf>);

impl Drop for KeptCopy {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn ffmpeg_version(ffmpeg: &Path) -> String {
    run_capture(ffmpeg, &["-hide_banner".into(), "-version".into()])
        .ok()
        .and_then(|text| {
            text.lines()
                .next()
                .and_then(|line| line.strip_prefix("ffmpeg version "))
                .and_then(|rest| rest.split_whitespace().next())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn timing_rel_of(rel: &str) -> Option<String> {
    let (stem, _) = split_rel(rel);
    rel.rsplit_once('/')
        .map(|(dir, _)| format!("{dir}/{stem}.timing.json"))
}

/// A file with a timing record beside it is a mezzanine this conform wrote.
pub(crate) fn source_is_mezzanine(project: &Path, rel: &str) -> bool {
    timing_rel_of(rel).is_some_and(|timing| project.join(timing).is_file())
}

/// Refuse what the plan would clobber, before any work. An existing original is never overwritten, even with `--force`.
fn check_plan(project: &Path, plan: &ConformPlan) -> Result<(), CoreError> {
    if !project.join(&plan.source_rel).is_file() {
        return Err(CoreError::new(
            "missing",
            format!("no video at {}", plan.source_rel),
        ));
    }
    let mezzanine = source_is_mezzanine(project, &plan.source_rel);
    if plan.original_rel != plan.source_rel
        && project.join(&plan.original_rel).exists()
        && !mezzanine
    {
        return Err(CoreError::new(
            "exists",
            format!(
                "{} already holds an original: move it aside first",
                plan.original_rel
            ),
        ));
    }
    if plan.force {
        return Ok(());
    }
    if mezzanine {
        return Err(CoreError::new("exists", format!("{} is already a conformed mezzanine: pass --force to conform it again from its original", plan.source_rel)));
    }
    if !plan.in_place() && project.join(&plan.target_rel).exists() {
        return Err(CoreError::new(
            "exists",
            format!(
                "{} already exists: pass --name for another name or --force to replace it",
                plan.target_rel
            ),
        ));
    }
    if project.join(&plan.timing_rel).exists() {
        return Err(CoreError::new(
            "exists",
            format!(
                "{} already exists: pass --force to replace it",
                plan.timing_rel
            ),
        ));
    }
    Ok(())
}

/// Conform one project video: probe, keep the original in `assets/.originals/`, decode it with AVFoundation, encode the mezzanine in staging, rename it into place and write its timing record. The original is copied aside before anything replaces the source, so no step can lose it; a forced re-conform of a mezzanine decodes its kept original again.
pub(crate) fn conform(
    project: &Path,
    plan: &ConformPlan,
    tools: &ConformTools,
    on: &mut dyn FnMut(ConformEvent),
    cancel: &AtomicBool,
) -> Result<ConformOutcome, CoreError> {
    let started = std::time::Instant::now();
    check_plan(project, plan)?;
    let source = project.join(&plan.source_rel);
    let assets = project.join("assets");
    let original = project.join(&plan.original_rel);
    let input = if original.is_file() {
        &original
    } else {
        &source
    };
    let ff = ffprobe_facts(&tools.ffprobe, input).map_err(|e| CoreError::new("invalid", e))?;
    if ff.width == 0 || ff.height == 0 {
        return Err(CoreError::new(
            "invalid",
            format!("{} has no picture", plan.source_rel),
        ));
    }
    let av = av_facts(input).ok();
    if let Some(refusal) = refusal(&ff, av.as_ref()) {
        return Err(CoreError::new("refused", refusal.hint));
    }
    let av = av.expect("refusal covers a missing AVFoundation read");
    let duration = av
        .duration
        .filter(|d| d.value > 0)
        .ok_or_else(|| CoreError::new("invalid", "AVFoundation reports no duration"))?;
    let mut kept = KeptCopy(None);
    if !original.exists() {
        std::fs::create_dir_all(assets.join(ORIGINALS_DIR)).map_err(io("invalid"))?;
        std::fs::copy(&source, &original)
            .map_err(|e| CoreError::new("invalid", format!("keeping the original: {e}")))?;
        kept.0 = Some(original.clone());
    }
    let (original_sha, original_bytes) = sha256_file(&original)?;
    let ff_timing = ffmpeg_decode_timing(&tools.ffmpeg, &original, tools.background, cancel)
        .map_err(|e| {
            if e == INTERRUPTED {
                CoreError::new("interrupted", "the conform was interrupted")
            } else {
                CoreError::new("ffmpeg", e)
            }
        })?;
    let mov = plan.target_rel.to_ascii_lowercase().ends_with(".mov");
    let target_name = plan
        .target_rel
        .rsplit('/')
        .next()
        .unwrap_or("mezzanine.mp4");
    let staging = Staging::create(&assets, target_name)?;
    let job = EncodeJob {
        source: &original,
        duration,
        convert_colour: needs_colour_convert(&ff, Some(&av)),
        mov,
        out: &staging.file,
    };
    let encoded = encode(tools, &job, on, cancel)?;
    let turned = Staging::create(&assets, target_name)?;
    let mezzanine = if ff.rotation.rem_euclid(360) == 0 {
        &staging.file
    } else {
        let args = rotate_args(ff.rotation, mov, &staging.file, &turned.file);
        run_capture(&tools.ffmpeg, &args)
            .map_err(|e| CoreError::new("ffmpeg", format!("carrying the rotation: {e}")))?;
        &turned.file
    };
    let av_timing = DecodeTiming {
        pts_ms: encoded.map.pts.iter().map(|p| p.ms()).collect(),
    };
    let verdict = evaluate(&ff, Some(&av), Some((&av_timing, &ff_timing)));
    let (mezzanine_sha, mezzanine_bytes) = sha256_file(mezzanine)?;
    let target = project.join(&plan.target_rel);
    std::fs::rename(mezzanine, &target)
        .map_err(|e| CoreError::new("invalid", format!("moving the mezzanine into place: {e}")))?;
    kept.0 = None;
    if plan.keep == KeepOriginal::Move && !plan.in_place() && plan.source_rel != plan.original_rel {
        let _ = std::fs::remove_file(&source);
    }
    let duration_ms = tenth(slot_ms(encoded.map.slots, CONFORM_FPS));
    let record = timing_record(&TimingInputs {
        plan,
        original_sha: &original_sha,
        original_bytes,
        ff: &ff,
        av: &av,
        av_timing: &av_timing,
        ff_timing: &ff_timing,
        verdict: &verdict,
        mezzanine_sha: &mezzanine_sha,
        width: encoded.width,
        height: encoded.height,
        map: &encoded.map,
        ffmpeg_version: &ffmpeg_version(&tools.ffmpeg),
    });
    crate::write_atomic(
        &project.join(&plan.timing_rel),
        timing_text(&record).as_bytes(),
    )
    .map_err(|e| CoreError::new("invalid", e))?;
    Ok(ConformOutcome {
        target_rel: plan.target_rel.clone(),
        original_rel: plan.original_rel.clone(),
        timing_rel: plan.timing_rel.clone(),
        frames: encoded.map.slots,
        duration_ms,
        bytes: mezzanine_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
        verdict,
    })
}

struct TimingInputs<'a> {
    plan: &'a ConformPlan,
    original_sha: &'a str,
    original_bytes: u64,
    ff: &'a FfFacts,
    av: &'a AvFacts,
    av_timing: &'a DecodeTiming,
    ff_timing: &'a DecodeTiming,
    verdict: &'a Verdict,
    mezzanine_sha: &'a str,
    width: u32,
    height: u32,
    map: &'a SlotMap,
    ffmpeg_version: &'a str,
}

/// The `timing.json` v1 record (plan section 4); deterministic for one source and build.
fn timing_record(input: &TimingInputs<'_>) -> Value {
    let av = input.av;
    let colour = |c: &Colour| json!({ "primaries": c.primaries, "transfer": c.transfer, "matrix": c.matrix, "range": c.range });
    let source_colour = if av.colour == Colour::default() {
        colour(&input.ff.colour)
    } else {
        let mut merged = av.colour.clone();
        merged.range = merged.range.or(input.ff.colour.range.clone());
        colour(&merged)
    };
    let edit_list: Vec<Value> = av
        .edit_list
        .iter()
        .map(|s| {
            json!({
                "mediaTimeMs": s.media_start_ms.map(tenth),
                "durationMs": tenth(s.target_duration_ms),
                "rate": (s.rate() * 1000.0).round() / 1000.0,
            })
        })
        .collect();
    let holds = holds(&input.map.runs, input.map.slots, CONFORM_FPS);
    // Display size, like the source: a quarter turn swaps the coded size.
    let display = if (input.ff.rotation / 90).rem_euclid(2) == 1 {
        (input.height, input.width)
    } else {
        (input.width, input.height)
    };
    json!({
        "version": TIMING_VERSION,
        "kind": "conform",
        "source": {
            "original": input.plan.original_rel,
            "sha256": input.original_sha,
            "bytes": input.original_bytes,
            "container": input.ff.container,
            "codec": input.ff.codec,
            "width": input.ff.width,
            "height": input.ff.height,
            "rotation": input.ff.rotation,
            "hasAudio": input.ff.has_audio || av.has_audio,
            "vfr": input.verdict.reasons.contains(&"vfr"),
            "colour": source_colour,
            "editList": edit_list,
            "decoders": {
                "avfoundation": input.av_timing.summary(Some(av.duration_ms)),
                "ffmpeg": input.ff_timing.summary(None),
            },
            "verdict": input.verdict.verdict,
            "reasons": input.verdict.reasons,
        },
        "mezzanine": {
            "path": input.plan.target_rel,
            "sha256": input.mezzanine_sha,
            "width": display.0,
            "height": display.1,
            "fps": CONFORM_FPS,
            "frames": input.map.slots,
            "durationMs": tenth(slot_ms(input.map.slots, CONFORM_FPS)),
            "codec": "h264",
            "bframes": 0,
            "gop": GOP,
            "crf": CRF,
            "audio": if input.ff.has_audio || av.has_audio { "dropped" } else { "none" },
            "colour": { "primaries": "bt709", "transfer": "iec61966-2-1", "matrix": "bt709", "range": "tv" },
        },
        "conform": { "cli": MEDIA_CLI_VERSION, "ffmpeg": input.ffmpeg_version },
        "sourcePtsMs": input.map.pts.iter().map(|p| tenth(p.ms())).collect::<Vec<_>>(),
        "slots": input.map.runs.iter().map(|(slot, source)| [*slot as usize, *source]).collect::<Vec<_>>(),
        "holds": holds,
    })
}

/// Top-level keys one per line, each value compact: readable, and small for long clips.
pub(crate) fn timing_text(record: &Value) -> String {
    const ORDER: &[&str] = &[
        "version",
        "kind",
        "source",
        "mezzanine",
        "conform",
        "sourcePtsMs",
        "slots",
        "holds",
    ];
    let Some(map) = record.as_object() else {
        return format!("{record}\n");
    };
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_by_key(|k| ORDER.iter().position(|o| o == k).unwrap_or(ORDER.len()));
    let lines: Vec<String> = keys
        .into_iter()
        .map(|k| format!("  {}: {}", Value::String(k.clone()), map[k.as_str()]))
        .collect();
    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn at(ms: i64) -> MediaTime {
        MediaTime::new(ms, 1000)
    }

    #[test]
    fn a_linked_staging_folder_is_refused_by_name() {
        use crate::real_dir::hostile;
        let (project, victim) = hostile::folder("conform-staging");
        hostile::plant(&project, "assets/.kc-render", &victim);
        let e = Staging::create(&project.join("assets"), "clip.mp4").err().unwrap();
        assert_eq!(e.code, "invalid");
        assert!(e.message.contains(".kc-render is a link or a file"), "{}", e.message);
        hostile::assert_untouched(&victim);
        hostile::clean_up(&project);
    }

    #[test]
    fn slot_counts_round_up_exactly() {
        assert_eq!(slot_count(MediaTime::new(4, 1), 60), 240);
        assert_eq!(slot_count(MediaTime::new(3450, 1000), 60), 207);
        assert_eq!(slot_count(MediaTime::new(3983, 1000), 60), 239);
        assert_eq!(slot_count(MediaTime::new(1, 600), 60), 1);
        assert_eq!(slot_count(MediaTime::new(0, 600), 60), 0);
        assert_eq!(slot_count(MediaTime::new(-5, 600), 60), 0);
    }

    #[test]
    fn a_slot_shows_the_latest_frame_due_by_it() {
        let pts: Vec<MediaTime> = [0, 950, 966].map(at).to_vec();
        let map = map_slots(&pts, at(1000), 60).unwrap();
        assert_eq!(map.slots, 60);
        // 950 ms is due by slot 57 (950 ms exactly); 966 ms by slot 58 (966.7 ms).
        assert_eq!(map.runs, vec![(0, 0), (57, 1), (58, 2)]);
        assert_eq!(map.pts.len(), 3);
    }

    #[test]
    fn a_late_first_frame_shows_from_slot_zero() {
        let pts: Vec<MediaTime> = [40, 50].map(at).to_vec();
        let map = map_slots(&pts, at(100), 60).unwrap();
        // Slot 0 borrows the first frame early; 50 ms is due by slot 3 (50 ms).
        assert_eq!(map.runs, vec![(0, 0), (3, 1)]);
        assert_eq!(map.slots, 6);
    }

    #[test]
    fn frames_sharing_a_slot_keep_the_latest_and_still_count() {
        let pts: Vec<MediaTime> = [0, 2, 4, 20].map(at).to_vec();
        let map = map_slots(&pts, at(50), 60).unwrap();
        assert_eq!(map.runs, vec![(0, 0), (1, 2), (2, 3)]);
        assert_eq!(map.pts.len(), 4);
    }

    #[test]
    fn frames_past_the_duration_are_drained_not_shown() {
        let pts: Vec<MediaTime> = [0, 10, 500].map(at).to_vec();
        let map = map_slots(&pts, at(20), 60).unwrap();
        assert_eq!(map.slots, 2);
        assert_eq!(map.runs, vec![(0, 0), (1, 1)]);
        assert_eq!(map.pts.len(), 3);
    }

    #[test]
    fn an_empty_video_fails_and_a_zero_duration_maps_nothing() {
        assert!(map_slots(&[], at(100), 60).is_err());
        let none = map_slots(&[at(0)], at(0), 60).unwrap();
        assert_eq!((none.slots, none.runs.len(), none.pts.len()), (0, 0, 1));
    }

    #[test]
    fn exact_rational_comparison_beats_float_rounding() {
        // 1001/60000 s is just past slot 1 (1/60 s); floats would call it due.
        let pts = [MediaTime::new(0, 60000), MediaTime::new(1001, 60000)];
        let map = map_slots(&pts, MediaTime::new(3003, 60000), 60).unwrap();
        assert_eq!(map.runs, vec![(0, 0), (2, 1)]);
    }

    #[test]
    fn holds_are_runs_far_longer_than_the_usual_cadence() {
        // A 30 fps clip: every frame covers two slots, no holds.
        let steady: Vec<(u64, usize)> = (0..30).map(|i| (i * 2, i as usize)).collect();
        assert!(holds(&steady, 60, 60).is_empty());
        // A screen recording: frame 0 held to 950 ms, then 60 fps.
        let mut held = vec![(0, 0)];
        held.extend((57..120).map(|s| (s, (s - 56) as usize)));
        assert_eq!(
            holds(&held, 120, 60),
            vec![Hold {
                from_ms: 0.0,
                to_ms: 950.0,
                slots: [0, 56],
                source: 0
            }]
        );
        assert!(holds(&[], 0, 60).is_empty());
    }

    fn ff_clean() -> FfFacts {
        FfFacts {
            container: "mov".into(),
            codec: "h264".into(),
            width: 320,
            height: 240,
            r_fps: 60.0,
            avg_fps: 60.0,
            pix_fmt: "yuv420p".into(),
            bits: 8,
            duration_ms: 1000,
            discarded_packets: Some(0),
            ..FfFacts::default()
        }
    }

    fn av_clean() -> AvFacts {
        AvFacts {
            codec: "avc1".into(),
            width: 320,
            height: 240,
            nominal_fps: 60.0,
            min_frame_ms: 1000.0 / 60.0,
            duration: Some(MediaTime::new(1, 1)),
            duration_ms: 1000.0,
            edit_list: vec![EditSegment {
                media_start_ms: Some(0.0),
                media_duration_ms: 1000.0,
                target_start_ms: 0.0,
                target_duration_ms: 1000.0,
            }],
            ..AvFacts::default()
        }
    }

    #[test]
    fn a_clean_constant_rate_file_needs_nothing() {
        let v = evaluate(&ff_clean(), Some(&av_clean()), None);
        assert_eq!(v.verdict, "ok");
        assert!(v.reasons.is_empty() && v.why.is_empty());
        assert!(!v.recommended);
        assert_eq!(v.refused, None);
    }

    #[test]
    fn each_trigger_recommends_a_conform() {
        let mut vfr = ff_clean();
        vfr.vfr = true;
        assert_eq!(evaluate(&vfr, Some(&av_clean()), None).why, ["vfr"]);
        let mut av_vfr = av_clean();
        av_vfr.nominal_fps = 15.2;
        assert_eq!(evaluate(&ff_clean(), Some(&av_vfr), None).why, ["vfr"]);

        // B-frames alone are information, not a trigger.
        let mut bframes = ff_clean();
        bframes.bframes = 2;
        let v = evaluate(&bframes, Some(&av_clean()), None);
        assert_eq!(v.reasons, ["b-frames"]);
        assert!(v.why.is_empty() && !v.recommended);
        assert_eq!(v.verdict, "ok");
        let mut reorders = av_clean();
        reorders.reorders = true;
        assert!(!evaluate(&ff_clean(), Some(&reorders), None).recommended);
        let same = DecodeTiming {
            pts_ms: vec![0.0, 16.7],
        };
        assert!(!evaluate(&bframes, Some(&av_clean()), Some((&same, &same))).recommended);
        // Beside an edit list or a misdecode they count.
        let mut trimmed = bframes.clone();
        trimmed.discarded_packets = Some(3);
        assert_eq!(
            evaluate(&trimmed, Some(&av_clean()), None).why,
            ["edit-list", "b-frames"]
        );
        let short = DecodeTiming { pts_ms: vec![0.0] };
        let v = evaluate(&bframes, Some(&av_clean()), Some((&same, &short)));
        assert_eq!(v.why, ["b-frames", "decoders"]);
        assert!(v.recommended);

        let mut p3 = av_clean();
        p3.colour.primaries = Some("P3_D65".into());
        assert_eq!(evaluate(&ff_clean(), Some(&p3), None).why, ["primaries"]);
        let mut ff_p3 = ff_clean();
        ff_p3.colour.primaries = Some("smpte432".into());
        assert_eq!(
            evaluate(&ff_p3, None, None).reasons,
            ["primaries", "unreadable"]
        );
        let mut bt709 = av_clean();
        bt709.colour.primaries = Some("ITU_R_709_2".into());
        assert!(!evaluate(&ff_clean(), Some(&bt709), None).recommended);
    }

    #[test]
    fn an_edit_list_past_the_composition_delay_is_suspect() {
        let mut discarded = ff_clean();
        discarded.discarded_packets = Some(3);
        let v = evaluate(&discarded, Some(&av_clean()), None);
        assert_eq!((v.verdict, v.why.clone()), ("suspect", vec!["edit-list"]));

        let mut two = av_clean();
        two.edit_list.push(two.edit_list[0].clone());
        assert_eq!(evaluate(&ff_clean(), Some(&two), None).verdict, "suspect");
        let mut delay = av_clean();
        delay.edit_list[0].media_start_ms = None;
        assert_eq!(evaluate(&ff_clean(), Some(&delay), None).verdict, "suspect");
        let mut fast = av_clean();
        fast.edit_list[0].media_duration_ms = 2000.0;
        assert_eq!(evaluate(&ff_clean(), Some(&fast), None).verdict, "suspect");
        // The B-frame composition delay alone (one segment from a later media time) is no edit.
        let mut delayed = av_clean();
        delayed.edit_list[0].media_start_ms = Some(33.3);
        assert_eq!(evaluate(&ff_clean(), Some(&delayed), None).verdict, "ok");
    }

    #[test]
    fn the_containers_edit_start_judges_like_kb() {
        let with = |start| FfFacts {
            edit_start: Some(start),
            ..ff_clean()
        };
        let verdict = |start| {
            let v = evaluate(&with(start), Some(&av_clean()), None);
            (v.verdict, v.reasons, v.why)
        };
        assert_eq!(verdict(EditStart::None), ("ok", vec![], vec![]));
        assert_eq!(verdict(EditStart::FirstFrame), ("ok", vec![], vec![]));
        for start in [EditStart::Frame, EditStart::Gap, EditStart::Complex] {
            assert_eq!(
                verdict(start),
                ("suspect", vec!["edit-list"], vec!["edit-list"])
            );
        }
        assert_eq!(
            verdict(EditStart::MidSample),
            (
                "ffmpeg-misdecodes",
                vec!["edit-list", "edit-mid-sample"],
                vec!["edit-list"]
            )
        );
        // The decoder check stays: a disagreement over a trivial edit still misdecodes.
        let av = DecodeTiming {
            pts_ms: vec![0.0, 16.7],
        };
        let ff = DecodeTiming { pts_ms: vec![0.0] };
        let v = evaluate(
            &with(EditStart::FirstFrame),
            Some(&av_clean()),
            Some((&av, &ff)),
        );
        assert_eq!((v.verdict, v.why), ("ffmpeg-misdecodes", vec!["decoders"]));
    }

    /// The kit's `edit-start-vectors.json`, which kb's tests replay through kblib/mp4box.py and kblib/conform.py.
    #[test]
    fn edit_start_vectors_match_kb() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/edit-start-vectors.json"
        ))
        .expect("edit-start-vectors.json");
        let vectors: Value = serde_json::from_str(&text).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 4);
        let ints = |v: &Value| -> Vec<i64> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_i64().unwrap())
                .collect()
        };
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let m = &case["movie"];
            let offsets = m.get("offsets").map(ints);
            let edits: Option<Vec<(u64, i64, f64)>> = m.get("edits").map(|e| {
                e.as_array()
                    .unwrap()
                    .iter()
                    .map(|row| {
                        (
                            row[0].as_u64().unwrap(),
                            row[1].as_i64().unwrap(),
                            row[2].as_f64().unwrap(),
                        )
                    })
                    .collect()
            });
            let bytes = crate::mp4box::synth::movie(
                &ints(&m["deltas"]),
                offsets.as_deref(),
                edits.as_deref(),
                m.get("timescale").and_then(Value::as_u64).unwrap_or(600) as u32,
                m.get("movieScale").and_then(Value::as_u64).unwrap_or(1000) as u32,
                m.get("elstVersion").and_then(Value::as_u64).unwrap_or(0) as u8,
            );
            let path = std::env::temp_dir()
                .join(format!("kc-edit-start-{}-{name}.mov", std::process::id()));
            std::fs::write(&path, &bytes).unwrap();
            let start = crate::mp4box::edit_start(&path);
            let _ = std::fs::remove_file(&path);
            assert_eq!(
                serde_json::to_value(start).unwrap(),
                case["editStart"],
                "{name}"
            );
            let ff = FfFacts {
                edit_start: start,
                ..ff_clean()
            };
            let v = evaluate(&ff, Some(&av_clean()), None);
            assert_eq!(v.verdict, case["verdict"].as_str().unwrap(), "{name}");
            assert_eq!(json!(v.reasons), case["reasons"], "{name}");
            assert_eq!(
                v.recommended,
                case["recommended"].as_bool().unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn decoders_that_disagree_mean_ffmpeg_misdecodes() {
        let av = DecodeTiming {
            pts_ms: vec![0.0, 950.0, 966.7, 3433.3],
        };
        let ff = DecodeTiming {
            pts_ms: vec![0.0, 16.7, 2483.3],
        };
        let v = evaluate(&ff_clean(), Some(&av_clean()), Some((&av, &ff)));
        assert_eq!(v.verdict, "ffmpeg-misdecodes");
        assert_eq!(v.reasons, ["count-mismatch", "span-mismatch"]);
        assert_eq!(v.why, ["decoders"]);
        assert!(v.recommended);
        let same = evaluate(&ff_clean(), Some(&av_clean()), Some((&av, &av)));
        assert_eq!(same.verdict, "ok");
    }

    #[test]
    fn hdr_ten_bit_odd_transforms_and_unreadable_files_are_refused() {
        let mut pq = av_clean();
        pq.colour.transfer = Some("SMPTE_ST_2084_PQ".into());
        let v = evaluate(&ff_clean(), Some(&pq), None);
        assert_eq!(v.refused.as_ref().map(|r| r.code), Some("hdr"));
        let mut hlg = ff_clean();
        hlg.colour.transfer = Some("arib-std-b67".into());
        hlg.vfr = true;
        let v = evaluate(&hlg, Some(&av_clean()), None);
        assert_eq!(v.refused.as_ref().map(|r| r.code), Some("hdr"));
        assert!(!v.recommended);
        let mut deep = ff_clean();
        deep.bits = 10;
        assert_eq!(
            evaluate(&deep, Some(&av_clean()), None)
                .refused
                .map(|r| r.code),
            Some("10-bit")
        );
        let mut mirrored = av_clean();
        mirrored.odd_transform = true;
        assert_eq!(
            evaluate(&ff_clean(), Some(&mirrored), None)
                .refused
                .map(|r| r.code),
            Some("transform")
        );
        assert_eq!(
            evaluate(&ff_clean(), None, None).refused.map(|r| r.code),
            Some("unreadable")
        );
    }

    #[test]
    fn colour_converts_only_when_the_tags_leave_bt709() {
        assert!(!needs_colour_convert(&ff_clean(), Some(&av_clean())));
        let mut tagged = av_clean();
        tagged.colour = Colour {
            primaries: Some("ITU_R_709_2".into()),
            transfer: Some("ITU_R_709_2".into()),
            matrix: Some("ITU_R_709_2".into()),
            range: None,
        };
        assert!(!needs_colour_convert(&ff_clean(), Some(&tagged)));
        tagged.colour.primaries = Some("P3_D65".into());
        assert!(needs_colour_convert(&ff_clean(), Some(&tagged)));
        let mut sd = ff_clean();
        sd.colour.matrix = Some("smpte170m".into());
        assert!(needs_colour_convert(&sd, None));
    }

    #[test]
    fn ffprobe_facts_read_codecs_bits_colour_and_audio() {
        let out = r#"{"streams":[{"codec_type":"video","codec_name":"hevc","width":1206,"height":2622,
            "r_frame_rate":"600/1","avg_frame_rate":"15196/1000","has_b_frames":0,"pix_fmt":"yuv420p10le",
            "color_primaries":"smpte432","color_transfer":"iec61966-2-1","color_space":"bt709","color_range":"tv",
            "side_data_list":[{"rotation":-90}]},{"codec_type":"audio"}],
            "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"3.983000"}}"#;
        let facts = parse_ff_facts(out, Path::new("/x/rec.mov")).unwrap();
        assert_eq!(facts.container, "mov");
        assert_eq!(facts.codec, "hevc");
        assert_eq!(
            (facts.width, facts.height, facts.rotation),
            (2622, 1206, -90)
        );
        assert!(facts.vfr && facts.has_audio);
        assert_eq!(facts.bits, 10);
        assert_eq!(facts.colour.primaries.as_deref(), Some("smpte432"));
        assert_eq!(facts.colour.range.as_deref(), Some("tv"));
        assert_eq!(facts.duration_ms, 3983);
        let plain = r#"{"streams":[{"codec_type":"video","width":2,"height":2,"r_frame_rate":"30/1",
            "avg_frame_rate":"30/1","pix_fmt":"yuv420p","color_primaries":"unknown"}],"format":{"duration":"1"}}"#;
        let facts = parse_ff_facts(plain, Path::new("/x/a.mp4")).unwrap();
        assert_eq!(
            (facts.bits, facts.colour.primaries.clone(), facts.has_audio),
            (8, None, false)
        );
    }

    #[test]
    fn pixel_format_names_carry_their_bit_depth() {
        assert_eq!(pix_fmt_bits("yuv420p"), 8);
        assert_eq!(pix_fmt_bits("nv12"), 8);
        assert_eq!(pix_fmt_bits("yuv420p10le"), 10);
        assert_eq!(pix_fmt_bits("p010le"), 10);
        assert_eq!(pix_fmt_bits("yuv444p12be"), 12);
        assert_eq!(pix_fmt_bits("gray"), 8);
        assert_eq!(pix_fmt_bits("gray10le"), 10);
        assert_eq!(pix_fmt_bits("nv21"), 8);
        assert_eq!(pix_fmt_bits("yuvj420p"), 8);
    }

    #[test]
    fn discard_flags_count_the_second_column() {
        assert_eq!(count_discarded("KD_\n_D_\nK__\n___\n"), 2);
        assert_eq!(count_discarded(""), 0);
    }

    #[test]
    fn showinfo_lines_yield_presentation_times() {
        let line = "[Parsed_showinfo_0 @ 0x1] n:   3 pts:   2560 pts_time:0.166667 duration:256";
        assert!((showinfo_pts_ms(line).unwrap() - 166.667).abs() < 1e-3);
        assert_eq!(showinfo_pts_ms("frame=  10 fps=0.0"), None);
    }

    #[test]
    fn the_encode_argv_is_the_pinned_mezzanine_recipe() {
        let args = encode_args(1206, 2622, false, Path::new("/p/assets/.kc-render/x.mp4"));
        assert_eq!(
            args.join(" "),
            "-hide_banner -nostats -loglevel error -y -f rawvideo -pix_fmt nv12 -s 1206x2622 -r 60 -color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709 -color_range tv -i - -c:v libx264 -preset veryfast -crf 16 -bf 0 -g 30 -pix_fmt yuv420p -color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709 -color_range tv -flags:v +bitexact -fflags +bitexact -map_metadata -1 -an -f mp4 /p/assets/.kc-render/x.mp4"
        );
        let mov = encode_args(320, 240, true, Path::new("/o.mov"));
        assert_eq!(mov[mov.len() - 2], "mov");
        assert_eq!(
            rotate_args(-90, false, Path::new("/s/a.mp4"), Path::new("/s/b.mp4")).join(" "),
            "-hide_banner -nostats -loglevel error -y -display_rotation -90 -i /s/a.mp4 -map 0:v:0 -c copy -fflags +bitexact -map_metadata -1 -f mp4 /s/b.mp4"
        );
    }

    #[test]
    fn plans_conform_in_place_or_to_a_new_mp4() {
        let p = plan("assets/rec.mov", None, KeepOriginal::Move, false).unwrap();
        assert_eq!(p.target_rel, "assets/rec.mov");
        assert_eq!(p.original_rel, "assets/.originals/rec.mov");
        assert_eq!(p.timing_rel, "assets/rec.timing.json");
        assert!(p.in_place());
        let named = plan("assets/rec.mov", Some("take-2"), KeepOriginal::Copy, false).unwrap();
        assert_eq!(named.target_rel, "assets/take-2.mp4");
        assert_eq!(named.timing_rel, "assets/take-2.timing.json");
        let same = plan("./assets/rec.mp4", Some("rec"), KeepOriginal::Move, false).unwrap();
        assert!(same.in_place());
        let original = plan("assets/.originals/rec.MOV", None, KeepOriginal::Move, false).unwrap();
        assert_eq!(original.target_rel, "assets/rec.mp4");
        assert_eq!(original.original_rel, "assets/.originals/rec.MOV");
        let nested = plan("assets/clips/rec.mp4", None, KeepOriginal::Move, false).unwrap();
        assert_eq!(nested.target_rel, "assets/clips/rec.mp4");
        assert_eq!(nested.timing_rel, "assets/clips/rec.timing.json");
        assert_eq!(nested.original_rel, "assets/.originals/rec.mp4");
        let code = |r: Result<ConformPlan, CoreError>| r.unwrap_err().code;
        assert_eq!(
            code(plan("scenes/a.mp4", None, KeepOriginal::Move, false)),
            "usage"
        );
        assert_eq!(
            code(plan("assets/../x.mp4", None, KeepOriginal::Move, false)),
            "usage"
        );
        assert_eq!(
            code(plan("assets/a.webm", None, KeepOriginal::Move, false)),
            "invalid"
        );
        assert_eq!(
            code(plan(
                "assets/a.mp4",
                Some(".hidden"),
                KeepOriginal::Move,
                false
            )),
            "usage"
        );
        assert_eq!(
            code(plan("assets/a.mp4", Some("a/b"), KeepOriginal::Move, false)),
            "usage"
        );
        assert_eq!(
            code(plan("assets/a.mp4", None, KeepOriginal::Copy, false)),
            "usage"
        );
    }

    #[test]
    fn the_timing_text_keeps_the_contract_order_one_key_per_line() {
        let record = json!({ "slots": [[0, 0]], "version": 1, "kind": "conform", "holds": [] });
        assert_eq!(
            timing_text(&record),
            "{\n  \"version\": 1,\n  \"kind\": \"conform\",\n  \"slots\": [[0,0]],\n  \"holds\": []\n}\n"
        );
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

    pub(crate) fn temp_project(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-conform-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        dir
    }

    /// Frame index `value` as 16 bits across the top 32 rows of a grey 320×240 picture, x264 lossless with its default B-frames.
    pub(crate) fn barcode_source(out: &Path, seconds: u32, value: &str) {
        let graph = format!(
            "color=c=gray:s=320x240:r=60:d={seconds},format=yuv420p,\
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

    /// The barcode of every stored frame, in order (passthrough: one value per frame the file holds).
    pub(crate) fn decode_barcodes(path: &Path) -> Vec<u32> {
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

    /// The centre pixel as the clip path sees it: ffmpeg to RGB, honouring the file's tags.
    fn centre_rgb(path: &Path) -> [i32; 3] {
        let out = std::process::Command::new(DEV_FFMPEG)
            .args([
                "-v",
                "error",
                "-i",
                path.to_str().unwrap(),
                "-frames:v",
                "1",
            ])
            .args([
                "-vf",
                "crop=2:2:159:119,format=rgb24",
                "-f",
                "rawvideo",
                "-",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        [
            out.stdout[0].into(),
            out.stdout[1].into(),
            out.stdout[2].into(),
        ]
    }

    fn tools() -> ConformTools {
        ConformTools {
            ffmpeg: PathBuf::from(DEV_FFMPEG),
            ffprobe: PathBuf::from(DEV_FFPROBE),
            background: false,
        }
    }

    fn conform_in(dir: &Path, rel: &str) -> ConformOutcome {
        let plan = plan(rel, None, KeepOriginal::Move, false).unwrap();
        conform(dir, &plan, &tools(), &mut |_| {}, &AtomicBool::new(false)).unwrap()
    }

    fn read(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    /// Ingest conformance on synthetic barcode clips: a held variable-rate recording, a stream-copy trim whose edit list starts inside a held frame (the class ffmpeg misdecodes), a P3-tagged colour and a turned clip. Each mezzanine is decoded back to the source frame every slot shows, and two runs must match byte for byte.
    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg) and AVFoundation"]
    fn conform_barcode_conformance() {
        let work = temp_project("sources");
        let held = work.join("held.mp4");
        // 0..29 at 60 fps, 29 held to 1.5 s, 90..149, 149 held to 3.5 s, then 210..239.
        barcode_source(
            &held,
            4,
            "if(lt(N,30),N,if(lt(N,90),29,if(lt(N,150),N,if(lt(N,210),149,N))))",
        );
        let vfr = work.join("vfr.mov");
        ffmpeg_ok(&[
            "-i",
            held.to_str().unwrap(),
            "-vf",
            "mpdecimate=hi=1:lo=1:frac=0:max=0",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            "-pix_fmt",
            "yuv420p",
            vfr.to_str().unwrap(),
        ]);
        let trim = work.join("trim.mov");
        ffmpeg_ok(&[
            "-ss",
            "0.55",
            "-i",
            vfr.to_str().unwrap(),
            "-c",
            "copy",
            trim.to_str().unwrap(),
        ]);

        // The two decoders disagree on the trim: AVFoundation keeps the partly covered held frame.
        let never = AtomicBool::new(false);
        let av = av_decode_timing(&trim, &never).unwrap();
        let ff = ffmpeg_decode_timing(Path::new(DEV_FFMPEG), &trim, false, &never).unwrap();
        assert_eq!((av.pts_ms.len(), ff.pts_ms.len()), (91, 90));
        assert!((av.pts_ms[1] - 950.0).abs() < 0.5, "{:?}", &av.pts_ms[..3]);
        assert_eq!(
            decode_barcodes(&trim)[0],
            90,
            "ffmpeg shows frame 90 at 0 s"
        );
        // The static probe already knows, as kb's does: the trim's edit opens inside the held frame.
        let (ff_trim, av_trim) = probe_static(Path::new(DEV_FFPROBE), &trim).unwrap();
        assert_eq!(ff_trim.edit_start, Some(EditStart::MidSample));
        assert_eq!(
            evaluate(&ff_trim, av_trim.as_ref(), None).verdict,
            "ffmpeg-misdecodes"
        );
        let (ff_vfr, _) = probe_static(Path::new(DEV_FFPROBE), &vfr).unwrap();
        assert_eq!(ff_vfr.edit_start, Some(EditStart::FirstFrame));

        let mut hashes = Vec::new();
        for run in 0..2 {
            let dir = temp_project(&format!("run{run}"));
            std::fs::copy(&vfr, dir.join("assets/vfr.mov")).unwrap();
            std::fs::copy(&trim, dir.join("assets/trim.mov")).unwrap();

            let out = conform_in(&dir, "assets/trim.mov");
            assert_eq!(out.verdict.verdict, "ffmpeg-misdecodes");
            assert_eq!(out.frames, 207, "3.45 s after the trim");
            let codes = decode_barcodes(&dir.join("assets/trim.mov"));
            assert_eq!(codes.len(), 207);
            assert!(codes[..57].iter().all(|c| *c == 29), "{:?}", &codes[..60]);
            assert_eq!(&codes[57..60], &[90, 91, 92]);
            let record: Value =
                serde_json::from_slice(&read(&dir.join("assets/trim.timing.json"))).unwrap();
            assert_eq!(record["slots"][0], json!([0, 0]));
            assert_eq!(record["slots"][1], json!([57, 1]));
            assert_eq!(
                record["holds"][0],
                json!({ "fromMs": 0.0, "toMs": 950.0, "slots": [0, 56], "source": 0 })
            );
            assert_eq!(record["source"]["decoders"]["avfoundation"]["frames"], 91);
            assert_eq!(record["source"]["decoders"]["ffmpeg"]["frames"], 90);
            assert_eq!(record["mezzanine"]["frames"], 207);
            assert!(dir.join("assets/.originals/trim.mov").is_file());
            assert_eq!(read(&dir.join("assets/.originals/trim.mov")), read(&trim));

            let out = conform_in(&dir, "assets/vfr.mov");
            assert_eq!(out.frames, 240);
            let codes = decode_barcodes(&dir.join("assets/vfr.mov"));
            let expected: Vec<u32> = (0..240u32)
                .map(|k| match k {
                    30..=89 => 29,
                    150..=209 => 149,
                    _ => k,
                })
                .collect();
            assert_eq!(codes, expected);
            assert!(!dir.join("assets/.kc-render").exists());
            for rel in [
                "assets/trim.mov",
                "assets/trim.timing.json",
                "assets/vfr.mov",
                "assets/vfr.timing.json",
            ] {
                hashes.push((run, rel, read(&dir.join(rel))));
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        let (first, second) = hashes.split_at(hashes.len() / 2);
        for (a, b) in first.iter().zip(second) {
            assert!(a.2 == b.2, "{} differs between runs", a.1);
        }
        let _ = std::fs::remove_dir_all(&work);
    }

    /// sRGB-transfer Display P3 code values to sRGB: the reference the mezzanine must land near.
    fn p3_to_srgb(rgb: [i32; 3]) -> [i32; 3] {
        let decode = |v: i32| {
            let c = f64::from(v) / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let encode = |l: f64| {
            let l = l.clamp(0.0, 1.0);
            let c = if l <= 0.003_130_8 {
                l * 12.92
            } else {
                1.055 * l.powf(1.0 / 2.4) - 0.055
            };
            (c * 255.0).round() as i32
        };
        let [r, g, b] = rgb.map(decode);
        [
            encode(1.224_940 * r - 0.224_940 * g),
            encode(-0.042_057 * r + 1.042_057 * g),
            encode(-0.019_638 * r - 0.078_636 * g + 1.098_274 * b),
        ]
    }

    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg) and AVFoundation"]
    fn conform_converts_p3_and_keeps_rotation() {
        let dir = temp_project("colour");
        let p3 = dir.join("assets/p3.mp4");
        ffmpeg_ok(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=0xC66530:s=320x240:r=60:d=1",
            // ffmpeg 8 tags from the frames, so the filter graph carries the P3 tags too.
            "-vf",
            "format=yuv420p,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv",
            "-c:v",
            "libx264",
            "-bf",
            "0",
            "-color_primaries",
            "smpte432",
            "-color_trc",
            "iec61966-2-1",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
            p3.to_str().unwrap(),
        ]);
        let before = centre_rgb(&p3);
        let out = conform_in(&dir, "assets/p3.mp4");
        assert_eq!(out.verdict.why, ["primaries"]);
        let after = centre_rgb(&p3);
        let want = p3_to_srgb(before);
        for c in 0..3 {
            assert!(
                (after[c] - want[c]).abs() <= 3,
                "P3 {before:?} converted to {after:?}, want {want:?}"
            );
        }
        assert!(
            after[0] - before[0] > 8,
            "no conversion happened: {before:?} to {after:?}"
        );
        let tags = crate::media::probe_media_at(Path::new(DEV_FFPROBE), &p3).unwrap();
        assert!(!tags.vfr);

        let upright = dir.join("upright.mp4");
        barcode_source(&upright, 1, "N");
        let turned = dir.join("assets/turned.mp4");
        ffmpeg_ok(&[
            "-display_rotation",
            "90",
            "-i",
            upright.to_str().unwrap(),
            "-c",
            "copy",
            turned.to_str().unwrap(),
        ]);
        let source = crate::media::probe_media_at(Path::new(DEV_FFPROBE), &turned).unwrap();
        assert_eq!(
            (source.rotation, source.width, source.height),
            (90, 240, 320)
        );
        conform_in(&dir, "assets/turned.mp4");
        let mezzanine = crate::media::probe_media_at(Path::new(DEV_FFPROBE), &turned).unwrap();
        assert_eq!(
            (mezzanine.rotation, mezzanine.width, mezzanine.height),
            (90, 240, 320)
        );
        assert_eq!(decode_barcodes(&turned).len(), 60);
        let record: Value =
            serde_json::from_slice(&read(&dir.join("assets/turned.timing.json"))).unwrap();
        assert_eq!(
            (
                &record["mezzanine"]["width"],
                &record["mezzanine"]["height"]
            ),
            (&json!(240), &json!(320))
        );
        assert_eq!(record["source"]["rotation"], 90);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg) and AVFoundation"]
    fn a_conform_refuses_to_clobber_and_cleans_up_a_failure() {
        let dir = temp_project("clobber");
        barcode_source(&dir.join("assets/a.mp4"), 1, "N");
        conform_in(&dir, "assets/a.mp4");
        let again = plan("assets/a.mp4", None, KeepOriginal::Move, false).unwrap();
        let refused =
            conform(&dir, &again, &tools(), &mut |_| {}, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(refused.code, "exists");
        // A forced re-conform decodes the kept original again and lands the same bytes.
        let first = read(&dir.join("assets/a.mp4"));
        let forced = plan("assets/a.mp4", None, KeepOriginal::Move, true).unwrap();
        conform(
            &dir,
            &forced,
            &tools(),
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(read(&dir.join("assets/a.mp4")), first);

        std::fs::write(dir.join("assets/broken.mp4"), b"not a video").unwrap();
        let broken = plan("assets/broken.mp4", None, KeepOriginal::Move, false).unwrap();
        assert!(conform(
            &dir,
            &broken,
            &tools(),
            &mut |_| {},
            &AtomicBool::new(false)
        )
        .is_err());
        assert!(!dir.join("assets/.originals/broken.mp4").exists());
        assert!(dir.join("assets/broken.mp4").is_file());

        barcode_source(&dir.join("assets/b.mp4"), 1, "N");
        let cancelled = plan("assets/b.mp4", None, KeepOriginal::Move, false).unwrap();
        let fail = conform(
            &dir,
            &cancelled,
            &tools(),
            &mut |_| {},
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(fail.code, "interrupted");
        assert!(!dir.join("assets/.originals/b.mp4").exists());
        assert!(!dir.join("assets/.kc-render").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
