//! AV sync acceptance: each export lane's real argv through the real sidecar, fed raw RGBA as the exporter feeds it (a white frame first at or after each beat) with a click track on the beats, then measured from the file as a player sees it (edit lists honoured) and as three naive readings do. `cargo test --lib av_sync -- --nocapture` prints the table; it skips with a reason when the sidecar is missing or CI's stub.

use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const W: u32 = 320;
const H: u32 = 180;
const DURATION_MS: f64 = 6000.0;
const RATE: u32 = 48_000;
const CLICK_AMP: f64 = 16_384.0;
const CLICK_MS: f64 = 8.0;
const CLICK_THRESHOLD: i32 = 4_096;
const REFRACTORY_MS: f64 = 150.0;
const WHITE: u8 = 200;
/// Measured onsets match the prediction to under 0.01 ms (pts are exact, the cosine click starts at full scale); 1 ms leaves room for an AAC encoder change smearing the transient.
const TOL_MS: f64 = 1.0;
const POSTER_GREY: u8 = 128;

#[derive(Clone, Copy)]
enum Soundtrack {
    Wav,
    M4a,
}

struct Lane {
    name: &'static str,
    fps: u32,
    codec: Codec,
    spec: Option<EncodeSpec>,
    soundtrack: Soundtrack,
    start_offset_ms: u64,
    optional: bool,
}

#[derive(Clone, Copy)]
struct Grid {
    bpm: f64,
    offset_ms: f64,
}

const GRIDS: [Grid; 2] = [
    Grid {
        bpm: 120.0,
        offset_ms: 500.0,
    },
    Grid {
        bpm: 128.0,
        offset_ms: 37.0,
    },
];

#[derive(Clone, Copy, PartialEq)]
enum Method {
    Player,
    NoEditList,
    PacketDts,
}

#[derive(Default)]
struct Measured {
    player: Vec<f64>,
    predicted: Vec<f64>,
    click_vs_grid: Vec<f64>,
    flash_vs_grid: Vec<f64>,
    no_edit_list: Vec<f64>,
    packet_dts: Vec<f64>,
    reorder_ms: f64,
}

fn sidecar(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "bin/{name}-{}-apple-darwin",
        std::env::consts::ARCH
    ))
}

/// The real sidecar answers `-version`; CI's stub exits 0 silently.
fn usable(bin: &Path) -> bool {
    Command::new(bin)
        .args(["-hide_banner", "-version"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("version"))
        .unwrap_or(false)
}

fn has_encoder(name: &str) -> bool {
    Command::new(sidecar("ffmpeg"))
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .any(|w| w == name)
        })
        .unwrap_or(false)
}

fn run(bin: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let out = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    if !out.status.success() {
        return Err(format!(
            "{} {}: {}",
            bin.display(),
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(out.stdout)
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

fn beats(grid: Grid) -> Vec<f64> {
    let period = 60_000.0 / grid.bpm;
    (0..)
        .map(|k| grid.offset_ms + k as f64 * period)
        .take_while(|&b| b < DURATION_MS - 400.0)
        .filter(|&b| b >= 200.0)
        .collect()
}

/// The exporter's frame k shows `k * (1000 / fps)` and `resolveAt` is half-open, so a cut at B first shows on the first frame whose time reaches B.
fn first_frame_at_or_after(beat_ms: f64, fps: u32) -> u32 {
    let step = 1000.0 / fps as f64;
    let mut k = (beat_ms / step).floor().max(0.0) as u32;
    while (k as f64) * step < beat_ms {
        k += 1;
    }
    while k > 0 && ((k - 1) as f64) * step >= beat_ms {
        k -= 1;
    }
    k
}

fn write_click_wav(path: &Path, beats_ms: &[f64], start_offset_ms: u64) {
    let len = ((DURATION_MS + start_offset_ms as f64 + 1000.0) / 1000.0 * RATE as f64) as usize;
    let mut samples = vec![0i16; len];
    let click = (CLICK_MS / 1000.0 * RATE as f64) as usize;
    for &b in beats_ms {
        let at = ((b + start_offset_ms as f64) / 1000.0 * RATE as f64).round() as usize;
        for j in 0..click {
            let phase = 2.0 * std::f64::consts::PI * 3000.0 * j as f64 / RATE as f64;
            samples[at + j] = (CLICK_AMP * phase.cos()) as i16;
        }
    }
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, wav).unwrap();
}

fn options(lane: &Lane, total_frames: u32, audio_file: &Path) -> ExportOptions {
    ExportOptions {
        project_id: "av-sync".into(),
        width: W,
        height: H,
        fps: lane.fps,
        total_frames,
        aspect: "16x9".into(),
        codec: lane.codec,
        project_slug: None,
        audio: Some(AudioOptions {
            file: audio_file.to_string_lossy().into_owned(),
            gain_db: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            fade_out_curve: None,
            start_offset_ms: lane.start_offset_ms,
            track_duration_ms: None,
        }),
        encode: lane.spec.clone(),
        output_suffix: None,
        destination: None,
    }
}

/// Pipes the frames into one argv exactly as `start_export` does: raw RGBA on stdin, stderr drained.
fn pipe_frames(
    args: &[String],
    frames: &[u8],
    frame_bytes: usize,
    log: &Path,
) -> Result<(), String> {
    let mut child = Command::new(sidecar("ffmpeg"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(log).unwrap())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let mut stdin = child.stdin.take().unwrap();
        for frame in frames.chunks(frame_bytes) {
            stdin.write_all(frame).map_err(|e| e.to_string())?;
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(std::fs::read_to_string(log).unwrap_or_default());
    }
    Ok(())
}

fn encode(lane: &Lane, dir: &Path, grid: Grid) -> Result<(PathBuf, Vec<f64>), String> {
    let beats_ms = beats(grid);
    let wav = dir.join("clicks.wav");
    write_click_wav(&wav, &beats_ms, lane.start_offset_ms);
    let audio_file = match lane.soundtrack {
        Soundtrack::Wav => wav,
        Soundtrack::M4a => {
            let m4a = dir.join("clicks.m4a");
            run(
                &sidecar("ffmpeg"),
                &strings(&[
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    &wav.to_string_lossy(),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    &m4a.to_string_lossy(),
                ]),
            )?;
            m4a
        }
    };
    let poster = lane.spec.as_ref().is_some_and(|s| s.poster_frame);
    let normal = (DURATION_MS / 1000.0 * lane.fps as f64).round() as u32;
    let total = normal + u32::from(poster);
    let frame_bytes = (W * H * 4) as usize;
    let mut frames = vec![0u8; frame_bytes * total as usize];
    let lead = usize::from(poster);
    if poster {
        frames[..frame_bytes].fill(POSTER_GREY);
    }
    for &b in &beats_ms {
        let k = first_frame_at_or_after(b, lane.fps) as usize + lead;
        frames[k * frame_bytes..(k + 1) * frame_bytes].fill(255);
    }
    let opts = options(lane, total, &audio_file);
    let ext = match &lane.spec {
        Some(s) => s.codec.container_ext(),
        None => lane.codec.container_ext(),
    };
    let out = dir.join(format!("out.{ext}"));
    let out_s = out.to_string_lossy().into_owned();
    match &lane.spec {
        None => pipe_frames(
            &legacy_export_args(&opts, &out_s)?,
            &frames,
            frame_bytes,
            &dir.join("encode.log"),
        )?,
        Some(spec) if !spec.two_pass() => pipe_frames(
            &spec_export_args(&opts, spec, &out_s)?,
            &frames,
            frame_bytes,
            &dir.join("encode.log"),
        )?,
        Some(spec) => {
            let mezz = dir.join("mezz.mkv").to_string_lossy().into_owned();
            let passlog = dir.join("passlog").to_string_lossy().into_owned();
            pipe_frames(
                &mezzanine_render_args(&opts, spec, &mezz),
                &frames,
                frame_bytes,
                &dir.join("mezz.log"),
            )?;
            for pass in [1, 2] {
                run(
                    &sidecar("ffmpeg"),
                    &transcode_pass_args(&opts, spec, &mezz, &out_s, pass, &passlog)?,
                )?;
            }
        }
    }
    Ok((out, beats_ms))
}

fn probe_times(file: &Path, pre: &[&str], stream: &str, entry: &str) -> Vec<f64> {
    let mut args = strings(&["-v", "error"]);
    args.extend(strings(pre));
    args.extend(strings(&[
        "-select_streams",
        stream,
        "-show_entries",
        entry,
        "-of",
        "csv=p=0",
        &file.to_string_lossy(),
    ]));
    let out = run(&sidecar("ffprobe"), &args).unwrap();
    String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| l.split(',').next()?.trim().parse::<f64>().ok())
        .map(|s| s * 1000.0)
        .collect()
}

fn decode(file: &Path, pre: &[&str], tail: &[&str]) -> Vec<u8> {
    let mut args = strings(&["-v", "error"]);
    args.extend(strings(pre));
    args.extend(strings(&["-i", &file.to_string_lossy()]));
    args.extend(strings(tail));
    run(&sidecar("ffmpeg"), &args).unwrap()
}

/// (flash times, click onsets) in ms on the stream clock as `method` reads it.
fn read(file: &Path, method: Method) -> (Vec<f64>, Vec<f64>) {
    let pre: &[&str] = if method == Method::NoEditList {
        &["-ignore_editlist", "1"]
    } else {
        &[]
    };
    let luma = decode(
        file,
        pre,
        &[
            "-map",
            "0:v:0",
            "-vf",
            "scale=4:4:flags=area,format=gray",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-",
        ],
    );
    let means: Vec<u32> = luma
        .chunks(16)
        .map(|c| c.iter().map(|&v| v as u32).sum::<u32>() / 16)
        .collect();
    let times = match method {
        Method::PacketDts => probe_times(file, pre, "v:0", "packet=dts_time"),
        _ => probe_times(file, pre, "v:0", "frame=pts_time"),
    };
    let flashes: Vec<f64> = (0..means.len().min(times.len()))
        .filter(|&i| means[i] >= WHITE as u32 && (i == 0 || means[i - 1] < WHITE as u32))
        .map(|i| times[i])
        .collect();
    let origin = match method {
        Method::PacketDts => probe_times(file, pre, "a:0", "packet=pts_time")[0],
        _ => probe_times(file, pre, "a:0", "frame=pts_time")[0],
    };
    let pcm = decode(
        file,
        pre,
        &["-map", "0:a:0", "-ac", "1", "-f", "s16le", "-"],
    );
    let refractory = (REFRACTORY_MS / 1000.0 * RATE as f64) as usize;
    let mut clicks = Vec::new();
    let mut last_loud: Option<usize> = None;
    for (i, pair) in pcm.chunks_exact(2).enumerate() {
        if (i16::from_le_bytes([pair[0], pair[1]]) as i32).abs() < CLICK_THRESHOLD {
            continue;
        }
        if !matches!(last_loud, Some(l) if i - l <= refractory) {
            clicks.push(origin + i as f64 * 1000.0 / RATE as f64);
        }
        last_loud = Some(i);
    }
    (flashes, clicks)
}

fn measure_lane(lane: &Lane, root: &Path) -> Result<Measured, String> {
    let mut m = Measured::default();
    let poster_ms = if lane.spec.as_ref().is_some_and(|s| s.poster_frame) {
        1000.0 / lane.fps as f64
    } else {
        0.0
    };
    for (g, grid) in GRIDS.iter().enumerate() {
        let dir = root.join(format!("{}-{g}", lane.name.replace([' ', ','], "-")));
        std::fs::create_dir_all(&dir).unwrap();
        let (file, beats_ms) = encode(lane, &dir, *grid)?;
        let (flashes, clicks) = read(&file, Method::Player);
        if flashes.len() != beats_ms.len() || clicks.len() != beats_ms.len() {
            return Err(format!(
                "{}: {} beats but {} flashes and {} clicks",
                lane.name,
                beats_ms.len(),
                flashes.len(),
                clicks.len()
            ));
        }
        for (i, &b) in beats_ms.iter().enumerate() {
            let shown = first_frame_at_or_after(b, lane.fps) as f64 * 1000.0 / lane.fps as f64;
            m.player.push(flashes[i] - clicks[i]);
            m.predicted.push(shown - b);
            m.click_vs_grid.push(clicks[i] - b - poster_ms);
            m.flash_vs_grid.push(flashes[i] - b);
        }
        for (method, sink) in [
            (Method::NoEditList, &mut m.no_edit_list),
            (Method::PacketDts, &mut m.packet_dts),
        ] {
            let (f, c) = read(&file, method);
            sink.extend(f.iter().zip(&c).map(|(f, c)| f - c));
        }
        m.reorder_ms = probe_times(&file, &["-ignore_editlist", "1"], "v:0", "frame=pts_time")
            .into_iter()
            .fold(f64::INFINITY, f64::min);
    }
    Ok(m)
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    if s.is_empty() {
        return f64::NAN;
    }
    s[s.len() / 2]
}

fn span(v: &[f64]) -> String {
    let lo = v.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    format!("{lo:6.1} {:6.1} {hi:6.1}", median(v))
}

fn spec(codec: EncodeCodec, fps: u32, rate: RateControl, aac_kbps: Option<u32>) -> EncodeSpec {
    EncodeSpec {
        codec,
        scale_short_edge_to: None,
        fps,
        rate,
        profile: None,
        level: None,
        gop_seconds: None,
        b_frames: None,
        entropy: None,
        ten_bit: false,
        faststart: false,
        colour_tags: false,
        poster_frame: false,
        audio: Some(EncodeAudio {
            codec: match aac_kbps {
                Some(aac_kbps) => EncodeAudioCodec::Aac { aac_kbps },
                None => EncodeAudioCodec::Pcm { pcm_bits: 24 },
            },
            loudness_gain_db: 0.0,
        }),
    }
}

fn social(fps: u32, poster: bool) -> EncodeSpec {
    EncodeSpec {
        scale_short_edge_to: Some(1080),
        profile: Some("high".into()),
        level: Some("4.2".into()),
        gop_seconds: Some(2.0),
        b_frames: Some(2),
        faststart: true,
        colour_tags: true,
        poster_frame: poster,
        ..spec(
            EncodeCodec::Libx264,
            fps,
            RateControl::Bitrate {
                target_kbps: 12_000,
                max_kbps: 16_000,
                bufsize_kbps: 24_000,
                two_pass: false,
            },
            Some(128),
        )
    }
}

fn lanes() -> Vec<Lane> {
    let lane = |name, fps, spec: Option<EncodeSpec>| Lane {
        name,
        fps,
        codec: Codec::Libx264,
        spec,
        soundtrack: Soundtrack::Wav,
        start_offset_ms: 0,
        optional: false,
    };
    let high_quality = |fps| EncodeSpec {
        poster_frame: true,
        ..spec(
            EncodeCodec::Libx264,
            fps,
            RateControl::Crf { crf: 18 },
            Some(192),
        )
    };
    vec![
        lane("legacy x264", 30, None),
        lane("legacy x264", 60, None),
        Lane {
            soundtrack: Soundtrack::M4a,
            start_offset_ms: 250,
            ..lane("legacy x264, m4a +250ms", 60, None)
        },
        lane("high quality, poster", 60, Some(high_quality(60))),
        lane(
            "custom 720p draft, poster",
            30,
            Some(EncodeSpec {
                scale_short_edge_to: Some(720),
                ..high_quality(30)
            }),
        ),
        lane("social bf2", 30, Some(social(30, false))),
        lane("social bf2, poster", 30, Some(social(30, true))),
        lane("social bf2, poster", 60, Some(social(60, true))),
        lane(
            "two-pass, poster",
            30,
            Some(EncodeSpec {
                rate: RateControl::Bitrate {
                    target_kbps: 8_000,
                    max_kbps: 10_000,
                    bufsize_kbps: 16_000,
                    two_pass: true,
                },
                ..social(30, true)
            }),
        ),
        lane(
            "x265 crf",
            60,
            Some(spec(
                EncodeCodec::Libx265,
                60,
                RateControl::Crf { crf: 32 },
                Some(128),
            )),
        ),
        Lane {
            codec: Codec::ProresKs,
            ..lane(
                "prores + pcm",
                60,
                Some(spec(
                    EncodeCodec::ProresKs,
                    60,
                    RateControl::Crf { crf: 0 },
                    None,
                )),
            )
        },
        Lane {
            optional: true,
            ..lane(
                "videotoolbox, poster",
                30,
                Some(EncodeSpec {
                    poster_frame: true,
                    ..spec(
                        EncodeCodec::H264Videotoolbox,
                        30,
                        RateControl::Bitrate {
                            target_kbps: 8_000,
                            max_kbps: 10_000,
                            bufsize_kbps: 16_000,
                            two_pass: false,
                        },
                        Some(128),
                    )
                }),
            )
        },
    ]
}

fn lane_encoder(lane: &Lane) -> &'static str {
    match lane.spec.as_ref().map(|s| s.codec) {
        None => "libx264",
        Some(EncodeCodec::Libx265) => "libx265",
        Some(EncodeCodec::ProresKs) => "prores_ks",
        Some(EncodeCodec::H264Videotoolbox) => "h264_videotoolbox",
        Some(EncodeCodec::HevcVideotoolbox) => "hevc_videotoolbox",
        Some(EncodeCodec::ProresVideotoolbox) => "prores_videotoolbox",
        Some(EncodeCodec::Libx264) => "libx264",
    }
}

/// Each lane's cuts land on the beat in the file as a player sees it: never early, never more than one frame late (the frame grid's built-in quantisation), and exactly where `ceil(B x fps)` predicts.
#[test]
fn export_lanes_keep_cuts_on_the_beat() {
    if !usable(&sidecar("ffmpeg")) || !usable(&sidecar("ffprobe")) {
        eprintln!(
            "skipped: no real ffmpeg sidecar at {} (pnpm setup:ffmpeg)",
            sidecar("ffmpeg").display()
        );
        return;
    }
    let root = std::env::temp_dir().join(format!("kc-av-sync-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let lanes = lanes();
    let results: Vec<Option<Result<Measured, String>>> = std::thread::scope(|s| {
        let handles: Vec<_> = lanes
            .iter()
            .enumerate()
            .map(|(i, lane)| {
                let root = root.join(i.to_string());
                s.spawn(move || {
                    if !has_encoder(lane_encoder(lane)) {
                        return None;
                    }
                    Some(measure_lane(lane, &root))
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    println!(
        "\nAV sync: flash presentation time minus click onset, ms (min med max); bound 0..1000/fps"
    );
    println!(
        "{:<28} {:>3}  {:>20}  {:>5}  {:>20}  {:>20}  {:>20}  {:>7}",
        "lane",
        "fps",
        "player",
        "err",
        "edit lists ignored",
        "packet dts",
        "film vs grid",
        "reorder"
    );
    let mut failures: Vec<String> = Vec::new();
    for (lane, result) in lanes.iter().zip(results) {
        let m = match result {
            None => {
                println!(
                    "{:<28} {:>3}  skipped: no {}",
                    lane.name,
                    lane.fps,
                    lane_encoder(lane)
                );
                continue;
            }
            Some(Err(e)) if lane.optional => {
                println!(
                    "{:<28} {:>3}  skipped: {}",
                    lane.name,
                    lane.fps,
                    e.lines().last().unwrap_or("")
                );
                continue;
            }
            Some(Err(e)) => {
                failures.push(format!("{} @{}: {e}", lane.name, lane.fps));
                continue;
            }
            Some(Ok(m)) => m,
        };
        let err = m
            .player
            .iter()
            .zip(&m.predicted)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        println!(
            "{:<28} {:>3}  {}  {err:>5.2}  {}  {}  {}  {:>7.1}",
            lane.name,
            lane.fps,
            span(&m.player),
            span(&m.no_edit_list),
            span(&m.packet_dts),
            span(&m.flash_vs_grid),
            m.reorder_ms
        );
        let frame_ms = 1000.0 / lane.fps as f64;
        for (i, &got) in m.player.iter().enumerate() {
            if got < -TOL_MS || got >= frame_ms + TOL_MS || (got - m.predicted[i]).abs() > TOL_MS {
                failures.push(format!(
                    "{} @{}: beat {i} cut lands {got:.2} ms after its click, predicted {:.2}",
                    lane.name, lane.fps, m.predicted[i]
                ));
            }
            if m.click_vs_grid[i].abs() > TOL_MS {
                failures.push(format!(
                    "{} @{}: beat {i} click sounds {:.2} ms off its grid time",
                    lane.name, lane.fps, m.click_vs_grid[i]
                ));
            }
        }
    }
    if failures.is_empty() {
        let _ = std::fs::remove_dir_all(&root);
    }
    assert!(
        failures.is_empty(),
        "{}\n(files kept in {})",
        failures.join("\n"),
        root.display()
    );
}
