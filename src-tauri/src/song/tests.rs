use super::synth::{self, Clicks, SR};
use super::*;

fn dsp(samples: &[f32]) -> Core {
    analyse_pcm(samples, TrackerChoice::Dsp, Err("dsp"), &|| false).unwrap()
}

fn fitted_beats(core: &Core) -> Vec<f64> {
    core.beats.iter().map(|b| b.ms).collect()
}

fn assert_grid(core: &Core, truth: &[f64], bpm: f64, max_ms: f64) {
    let fit = core.fit.as_ref().expect("a fit");
    assert!(
        (fit.line.bpm() - bpm).abs() < 0.02,
        "bpm {} for {bpm}",
        fit.line.bpm()
    );
    let err = synth::max_error(&fitted_beats(core), truth);
    assert!(err < max_ms, "max beat error {err:.2} ms at {bpm} BPM");
}

#[test]
fn a_65_s_click_at_a_fractional_tempo_fits_within_5_ms() {
    let (x, truth) = synth::clicks(Clicks::new(135.11, 447.5, 65_000.0));
    let core = dsp(&x);
    assert_eq!(core.tracker, "dsp");
    assert_grid(&core, &truth, 135.11, 5.0);
    let fit = core.fit.as_ref().unwrap();
    assert!(fit.line.constant_tempo());
    assert!(fit.line.residual_ms < 3.0, "{}", fit.line.residual_ms);
    assert_eq!(core.duration_ms, 65_000.0);
    assert!(core.beats.len() >= 145);
}

#[test]
fn noise_and_missing_clicks_still_fit_within_5_ms() {
    let mut o = Clicks::new(135.11, 447.5, 65_000.0);
    o.noise = 0.05;
    o.missing = 6;
    o.seed = 7;
    let (x, truth) = synth::clicks(o);
    assert_grid(&dsp(&x), &truth, 135.11, 5.0);

    o.burst = true;
    o.offbeats = true;
    o.seed = 11;
    let (x, truth) = synth::clicks(o);
    assert_grid(&dsp(&x), &truth, 135.11, 5.0);

    for bpm in [90.37, 128.4, 140.5] {
        let mut o = Clicks::new(bpm, 213.7, 65_000.0);
        o.noise = 0.03;
        o.missing = 4;
        o.burst = true;
        o.seed = 3;
        let (x, truth) = synth::clicks(o);
        assert_grid(&dsp(&x), &truth, bpm, 5.0);
    }
}

#[test]
fn the_half_beat_guard_puts_the_grid_on_the_kicks() {
    let bpm = 128.0;
    let (x, kicks) = synth::offbeat_hats(bpm, 250.0, 30_000.0, 2);
    let hop = hop_ms();
    let strength = onset::onset_signal(&x);
    let duration = 30_000.0;
    let bpm0 = onset::estimate_tempo(&strength, hop).unwrap();
    let phase0 = onset::align_phase(&strength, hop, bpm0, duration);
    let unguarded =
        fit::refine_grid_fit(&strength, hop, 60_000.0 / bpm0, phase0, duration).unwrap();
    let half = 60_000.0 / bpm / 2.0;
    let off = synth::max_error(&unguarded.beat_times(duration), &kicks);
    assert!(
        (off - half).abs() < 20.0,
        "the full band alone should lock half a beat out, got {off:.1} ms"
    );
    let core = dsp(&x);
    assert_grid(&core, &kicks, bpm, 5.0);
}

#[test]
fn the_octave_guard_lifts_a_fast_click_off_half_tempo() {
    let mut o = Clicks::new(174.0, 213.7, 65_000.0);
    o.noise = 0.03;
    o.burst = true;
    o.seed = 3;
    let (x, truth) = synth::clicks(o);
    let strength = onset::onset_signal(&x);
    let raw = onset::estimate_tempo(&strength, hop_ms()).unwrap();
    assert!(
        (raw - 87.0).abs() < 1.0,
        "the prior should pick half tempo, got {raw:.2}"
    );
    assert_grid(&dsp(&x), &truth, 174.0, 5.0);
}

#[test]
fn dsp_downbeats_follow_the_kick_and_the_crash() {
    for downbeat in [0usize, 1, 2, 3] {
        let (x, truth) = synth::groove(122.7, 91.0, 40_000.0, downbeat, 4 + downbeat as u32);
        let core = dsp(&x);
        assert_grid(&core, &truth, 122.7, 5.0);
        let fit = core.fit.as_ref().unwrap();
        let first_bar = truth[downbeat];
        assert!(
            (fit.offset_ms - first_bar).abs() < 5.0,
            "downbeat {downbeat}: bar 1 at {:.1}, expected {first_bar:.1}",
            fit.offset_ms
        );
        let one = core
            .beats
            .iter()
            .find(|b| b.bar == 1 && b.beat == 1)
            .unwrap();
        assert!((one.ms - fit.offset_ms).abs() < 1e-6);
        let pickups = core.beats.iter().filter(|b| b.bar == 0).count();
        assert_eq!(pickups, downbeat);
    }
}

#[test]
fn a_track_that_opens_on_a_beat_keeps_it() {
    let (x, truth) = synth::clicks(Clicks::new(120.0, 0.0, 20_000.0));
    let core = dsp(&x);
    assert_grid(&core, &truth, 120.0, 5.0);
    let first = core.beats[0].ms;
    assert!(
        first.abs() < fit::PHASE_EDGE_MS,
        "first beat at {first:.2} ms"
    );
}

#[test]
fn silence_degrades_to_no_grid() {
    let core = dsp(&vec![0.0; SR as usize * 2]);
    assert!(core.fit.is_none());
    assert!(core.beats.is_empty());
}

#[test]
fn an_explicit_nn_request_without_the_model_fails() {
    let err = analyse_pcm(
        &[0.0; 4800],
        TrackerChoice::Nn,
        Err("no model here"),
        &|| false,
    )
    .unwrap_err();
    assert_eq!(err.code, "model");
    assert_eq!(err.message, "no model here");
    let auto = analyse_pcm(
        &[0.0; 4800],
        TrackerChoice::Auto,
        Err("no model here"),
        &|| false,
    )
    .unwrap();
    assert_eq!(auto.tracker, "dsp");
    assert_eq!(auto.fallback_reason.as_deref(), Some("no model here"));
}

#[test]
fn the_v2_document_carries_every_contract_field() {
    let (x, _) = synth::clicks(Clicks::new(120.0, 500.0, 12_000.0));
    let core = analyse_pcm(&x, TrackerChoice::Auto, Err("missing"), &|| false).unwrap();
    let extras = Extras {
        loudness: Ok(decode::Loudness {
            momentary: vec![-20.04; 120],
            short_term: vec![-21.0; 120],
            integrated: Some(-20.0),
            range: Some(1.5),
        }),
        lyrics: None,
        decoder_version: Some("8.1.2".into()),
    };
    let v = assemble("abc", &x, &core, extras);
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "beats",
            "breaths",
            "decoder",
            "durationMs",
            "energy",
            "envelope",
            "fallbackReason",
            "fit",
            "keyMoments",
            "lyrics",
            "model",
            "sections",
            "sha256",
            "stabs",
            "tracker",
            "version"
        ]
    );
    assert_eq!(v["version"], 2);
    assert_eq!(v["tracker"], "dsp");
    assert_eq!(v["fallbackReason"], "missing");
    assert_eq!(v["model"], Value::Null);
    assert_eq!(v["lyrics"], Value::Null);
    assert_eq!(v["durationMs"], 12_000);
    assert_eq!(v["decoder"]["version"], "8.1.2");
    let fit = &v["fit"];
    for key in [
        "bpm",
        "offsetMs",
        "periodMs",
        "phaseMs",
        "residualMs",
        "maxDriftMs",
    ] {
        assert!(fit[key].is_f64(), "{key}");
    }
    assert_eq!(fit["beatsPerBar"], 4);
    assert_eq!(fit["constantTempo"], true);
    assert!((fit["periodMs"].as_f64().unwrap() - 500.0).abs() < 0.5);
    // Beat 0 is the grid reaching back before the first click at 500 ms, so it has no onset.
    let beat = &v["beats"][1];
    assert!(beat["ms"].is_f64() && beat["bar"].is_i64() && beat["beat"].is_i64());
    assert!((beat["ms"].as_f64().unwrap() - 500.0).abs() < 5.0);
    assert!(beat["conf"].as_f64().unwrap() > 0.5);
    assert_eq!(v["beats"][0]["conf"], 0.0);
    assert_eq!(v["energy"]["hopMs"], 100);
    assert_eq!(v["energy"]["momentaryLufs"][0], -20.0);
    assert_eq!(v["stabs"]["per16th"].as_array().unwrap().len(), 16);
    assert!(v["sections"].is_array() && v["breaths"].is_array());
    assert_eq!(v["envelope"]["hopMs"], 21.333);
    assert!(v["keyMoments"].is_array());
}

#[test]
fn caches_are_versioned_by_name_and_go_stale_when_the_model_arrives() {
    let dir = Path::new("/x/cache/beats");
    assert_eq!(
        cache_path(dir, "abc", TrackerChoice::Auto),
        dir.join("abc-v2.json")
    );
    assert_eq!(
        cache_path(dir, "abc", TrackerChoice::Nn),
        dir.join("abc-v2.json")
    );
    assert_eq!(
        cache_path(dir, "abc", TrackerChoice::Dsp),
        dir.join("abc-v2-dsp.json")
    );
    let fallback =
        json!({ "version": 2, "sha256": "abc", "tracker": "dsp", "fallbackReason": "no model" });
    let yes = || true;
    let no = || false;
    let unasked = || -> bool { panic!("the model is only looked for to refresh a fallback") };
    assert!(cache_is_fresh(&fallback, "abc", TrackerChoice::Auto, no));
    assert!(!cache_is_fresh(&fallback, "abc", TrackerChoice::Auto, yes));
    assert!(!cache_is_fresh(
        &fallback,
        "abc",
        TrackerChoice::Nn,
        unasked
    ));
    assert!(!cache_is_fresh(
        &fallback,
        "abd",
        TrackerChoice::Auto,
        unasked
    ));
    let forced = json!({ "version": 2, "sha256": "abc", "tracker": "dsp", "fallbackReason": null });
    assert!(cache_is_fresh(&forced, "abc", TrackerChoice::Dsp, unasked));
    assert!(cache_is_fresh(&forced, "abc", TrackerChoice::Auto, unasked));
    let nn = json!({ "version": 2, "sha256": "abc", "tracker": "nn", "model": { "sha256": nn::BEAT_MODEL_SHA256 } });
    assert!(cache_is_fresh(&nn, "abc", TrackerChoice::Auto, unasked));
    assert!(cache_is_fresh(&nn, "abc", TrackerChoice::Nn, unasked));
    assert!(!cache_is_fresh(&nn, "abc", TrackerChoice::Dsp, unasked));
    let old_model =
        json!({ "version": 2, "sha256": "abc", "tracker": "nn", "model": { "sha256": "0" } });
    assert!(!cache_is_fresh(
        &old_model,
        "abc",
        TrackerChoice::Auto,
        unasked
    ));
    let tried = json!({ "version": 2, "sha256": "abc", "tracker": "dsp", "fallbackReason": "the model found too few beats", "model": { "sha256": nn::BEAT_MODEL_SHA256 } });
    assert!(cache_is_fresh(&tried, "abc", TrackerChoice::Auto, unasked));
    let tried_old = json!({ "version": 2, "sha256": "abc", "tracker": "dsp", "fallbackReason": "x", "model": { "sha256": "0" } });
    assert!(!cache_is_fresh(
        &tried_old,
        "abc",
        TrackerChoice::Auto,
        unasked
    ));
    assert!(!cache_is_fresh(
        &json!({ "version": 1, "sha256": "abc" }),
        "abc",
        TrackerChoice::Auto,
        unasked
    ));
}

fn tools_or_skip() -> crate::tools::Tools {
    let tools = crate::tools::Tools::beside_exe().unwrap();
    assert!(tools.ffmpeg.is_file(), "run pnpm setup:ffmpeg first");
    tools
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kc-song-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn encode(ffmpeg: &Path, samples: &[f32], out: &Path, codec: &[&str]) {
    let raw = out.with_extension("f32");
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    std::fs::write(&raw, bytes).unwrap();
    let ok = std::process::Command::new(ffmpeg)
        .args([
            "-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i",
        ])
        .arg(&raw)
        .args(codec)
        .arg(out)
        .status()
        .unwrap();
    assert!(ok.success());
}

/// The sidecar decodes MP3 and AAC with no offset: `cargo test -- --ignored song_decode_`.
#[test]
#[ignore]
fn song_decode_mp3_and_aac_without_decoder_bias() {
    let tools = tools_or_skip();
    let dir = scratch("decode");
    let (x, truth) = synth::clicks(Clicks::new(135.11, 447.5, 65_000.0));
    let reference = dsp(&x).fit.unwrap();
    for (name, codec) in [
        ("click.mp3", &["-c:a", "libmp3lame", "-b:a", "192k"][..]),
        ("click.m4a", &["-c:a", "aac", "-b:a", "192k"][..]),
    ] {
        let file = dir.join(name);
        encode(&tools.ffmpeg, &x, &file, codec);
        let pcm = decode::decode_pcm(&tools.ffmpeg, &file, &|| false).unwrap();
        let core = dsp(&pcm);
        let fit = core.fit.as_ref().unwrap();
        let shift = fit.line.phase_ms - reference.line.phase_ms;
        let err = synth::max_error(&fitted_beats(&core), &truth);
        println!("{name}: phase shift {shift:+.3} ms against the PCM fit, max error {err:.2} ms");
        assert!(shift.abs() < 2.0, "{name} decodes {shift:.2} ms off");
        assert!(err < 5.0, "{name}: max error {err:.2} ms");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The provisioning folder too, so release test builds (which skip the debug fallback) find the model.
fn test_model_dirs() -> Vec<PathBuf> {
    let mut dirs = candidate_dirs(None);
    dirs.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/models"
    )));
    dirs
}

fn model_or_skip() -> ModelFiles {
    nn::locate(&test_model_dirs()).expect("run pnpm setup:models first")
}

/// Raw tracked beats against the truth (ends trimmed: the model needs context): (max error, mean signed error).
fn raw_errors(tracked: &[f64], truth: &[f64]) -> (f64, f64) {
    let inner = &truth[2..truth.len() - 2];
    let signed: Vec<f64> = inner
        .iter()
        .map(|&c| {
            tracked
                .iter()
                .map(|&b| b - c)
                .min_by(|a, b| a.abs().total_cmp(&b.abs()))
                .unwrap_or(f64::INFINITY)
        })
        .collect();
    let max = signed.iter().map(|v| v.abs()).fold(0.0, f64::max);
    (max, signed.iter().sum::<f64>() / signed.len() as f64)
}

/// beat-this on a generated click and a groove, raw and refined: `cargo test -- --ignored song_beat_this_ --nocapture`.
#[test]
#[ignore]
fn song_beat_this_tracks_generated_clicks_and_grooves() {
    let model = model_or_skip();
    let mut click = Clicks::new(135.11, 447.5, 30_000.0);
    click.burst = true;
    let cases = [
        ("click", synth::clicks(click), None),
        (
            "groove",
            synth::groove(122.7, 91.0, 40_000.0, 2, 6),
            Some(2usize),
        ),
    ];
    for (label, (x, truth), downbeat) in cases {
        let tracked = nn::track(&model, &x, SR, &|| false).unwrap();
        let (raw, bias) = raw_errors(&tracked.beats_ms, &truth);
        let core = analyse_pcm(&x, TrackerChoice::Nn, Ok(&model), &|| false).unwrap();
        assert_eq!(core.tracker, "nn");
        let fit = core.fit.as_ref().unwrap();
        let refined = synth::max_error(&fitted_beats(&core), &truth);
        println!(
            "{label}: raw {} beats, max error {raw:.1} ms (mean {bias:+.1} ms); refined {:.3} BPM, max error {refined:.2} ms, bar 1 at {:.1}, {} beats per bar",
            tracked.beats_ms.len(),
            fit.line.bpm(),
            fit.offset_ms,
            fit.beats_per_bar
        );
        assert!(raw < 30.0, "{label}: raw beats {raw:.1} ms off");
        assert!(refined < 5.0, "{label}: refined beats {refined:.2} ms off");
        if let Some(d) = downbeat {
            assert!(
                (fit.offset_ms - truth[d]).abs() < 5.0,
                "{label}: bar 1 misplaced"
            );
        }
    }
}

/// CPU time for a 65 s track through decode, DSP and the model: `cargo test --release -- --ignored song_cpu_ --nocapture`.
#[test]
#[ignore]
fn song_cpu_time_for_a_65_s_track() {
    let tools = tools_or_skip();
    let dirs = test_model_dirs();
    let model = nn::locate(&dirs).ok();
    let dir = scratch("cpu");
    let (x, _) = synth::groove(135.11, 447.5, 65_000.0, 0, 9);
    let file = dir.join("groove.m4a");
    encode(&tools.ffmpeg, &x, &file, &["-c:a", "aac", "-b:a", "192k"]);
    let timed = |label: &str, f: &mut dyn FnMut()| {
        let t = std::time::Instant::now();
        f();
        println!("{label}: {:?}", t.elapsed());
    };
    let req = Request {
        file: &file,
        tracker: TrackerChoice::Auto,
        force: true,
        ffmpeg: &tools.ffmpeg,
        ffprobe: &tools.ffprobe,
        cache_dir: None,
        model_dirs: &dirs,
    };
    let mut tracker = Value::Null;
    timed("whole analysis", &mut || {
        tracker = analyse(&req, &|| false).unwrap().analysis["tracker"].clone();
    });
    println!("tracker: {tracker}");
    let mut pcm = Vec::new();
    timed("decode", &mut || {
        pcm = decode::decode_pcm(&tools.ffmpeg, &file, &|| false).unwrap()
    });
    timed("ebur128", &mut || {
        drop(decode::loudness(&tools.ffmpeg, &file).unwrap())
    });
    timed("lyrics probe", &mut || {
        drop(decode::lyrics(&tools.ffprobe, &file).unwrap())
    });
    timed("DSP tracking", &mut || drop(dsp(&pcm)));
    timed("breaths", &mut || drop(structure::breaths(&pcm, SR)));
    if let Some(m) = &model {
        timed("beat-this", &mut || {
            drop(nn::track(m, &pcm, SR, &|| false).unwrap())
        });
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Embedded lyrics and the whole file path through the sidecars: `cargo test -- --ignored song_file_`.
#[test]
#[ignore]
fn song_file_analysis_caches_and_reads_lyrics() {
    let tools = tools_or_skip();
    let dir = scratch("file");
    let (x, _) = synth::clicks(Clicks::new(120.0, 500.0, 10_000.0));
    let file = dir.join("tagged.m4a");
    encode(
        &tools.ffmpeg,
        &x,
        &file,
        &[
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-metadata",
            "lyrics=placeholder words",
        ],
    );
    let cache = dir.join("cache");
    let dirs: Vec<PathBuf> = Vec::new();
    let req = Request {
        file: &file,
        tracker: TrackerChoice::Auto,
        force: false,
        ffmpeg: &tools.ffmpeg,
        ffprobe: &tools.ffprobe,
        cache_dir: Some(&cache),
        model_dirs: &dirs,
    };
    let first = analyse(&req, &|| false).unwrap();
    assert!(!first.cached);
    assert_eq!(first.analysis["tracker"], "dsp");
    assert!(first.analysis["fallbackReason"].is_string());
    assert_eq!(first.analysis["lyrics"]["text"], "placeholder words");
    assert_eq!(first.analysis["lyrics"]["lang"], Value::Null);
    assert!(first.analysis["energy"]["integratedLufs"].is_f64());
    let second = analyse(&req, &|| false).unwrap();
    assert!(second.cached);
    assert_eq!(second.analysis, first.analysis);
    assert!(first.cache_path.unwrap().ends_with(format!(
        "{}-v2.json",
        first.analysis["sha256"].as_str().unwrap()
    )));
    let _ = std::fs::remove_dir_all(&dir);
}
