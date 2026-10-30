//! `<app binary> check <command>`: headless film checks over the app's own cores, with the edit CLI's conventions (one JSON object on stdout, diagnostics on stderr, exit 0 ok, 1 failed, 2 usage or environment, 130 interrupted). `check flashes` decodes a film with the bundled ffmpeg and runs the flash detector the export loop uses. Contract: docs/agent-kit.md (headless CLI).

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::cli::{finish, install_signal_handlers, require_tool, tools, Fail, Flags, CANCEL};
use crate::flashes::{FlashDetector, Standards};
use crate::media;

/// What `edit caps` lists under `checks`; kb runs `check X` only when X is listed (an older binary would start the GUI).
pub const CHECKS: &[&str] = &["flashes"];
/// The decode width: 16 px cells on a 64-cell grid.
const DECODE_WIDTH: u32 = 1024;
const MIN_FPS: f64 = 1.0;
const MAX_FPS: f64 = 240.0;

/// Entry point for `check …`; returns the process exit code.
pub fn main(args: Vec<OsString>) -> i32 {
    let args: Result<Vec<String>, _> = args.into_iter().map(OsString::into_string).collect();
    let Ok(args) = args else {
        return finish(Err(Fail::usage("arguments must be UTF-8 text")));
    };
    let Some((command, rest)) = args.split_first() else {
        return finish(Err(Fail::usage(format!(
            "give a check: {}",
            CHECKS.join(", ")
        ))));
    };
    match command.as_str() {
        "flashes" => finish(flashes(rest)),
        other => finish(Err(Fail::usage(format!(
            "unknown check {other:?}: use one of {}",
            CHECKS.join(", ")
        )))),
    }
}

/// The decode size for a display size: 1024 wide, the height in proportion and even (ffmpeg's `scale=1024:-2`).
fn decode_size(width: u32, height: u32) -> (u32, u32) {
    let h = (f64::from(DECODE_WIDTH) * f64::from(height) / f64::from(width.max(1)) / 2.0).round()
        as u32
        * 2;
    (DECODE_WIDTH, h.max(2))
}

fn parse_fps(raw: &str) -> Result<f64, Fail> {
    raw.parse::<f64>()
        .ok()
        .filter(|f| f.is_finite() && (MIN_FPS..=MAX_FPS).contains(f))
        .ok_or_else(|| Fail::usage(format!("--fps takes a rate from 1 to 240, not {raw:?}")))
}

fn film_path(flags: &Flags) -> Result<PathBuf, Fail> {
    let raw = flags.require("file")?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(Fail::usage(format!(
            "--file must be an absolute path, not {raw:?}"
        )));
    }
    if !path.is_file() {
        return Err(Fail::new("missing", format!("no file at {raw}")));
    }
    Ok(path)
}

fn flashes(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["file", "standard", "fps"], &[])?;
    let standards = match flags.get("standard") {
        None => Standards::BOTH,
        Some(raw) => Standards::parse(raw).ok_or_else(|| {
            Fail::usage(format!("--standard takes wcag, itu or both, not {raw:?}"))
        })?,
    };
    let forced_fps = flags.get("fps").map(parse_fps).transpose()?;
    let file = film_path(&flags)?;
    let tools = tools()?;
    require_tool(&tools.ffmpeg, "ffmpeg")?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let info = media::probe_media_at(&tools.ffprobe, &file).map_err(|e| Fail::new("invalid", e))?;
    if info.kind != "video" || info.width == 0 || info.height == 0 {
        return Err(Fail::new(
            "invalid",
            format!("{} is not a video", file.display()),
        ));
    }
    let probed = [info.avg_fps, info.r_fps, info.fps]
        .into_iter()
        .find(|f| f.is_finite() && *f > 0.0);
    let resample = forced_fps.or(if info.vfr { probed } else { None });
    let fps = forced_fps.or(probed).unwrap_or(60.0);
    let (width, height) = decode_size(info.width, info.height);
    install_signal_handlers();
    let mut detector = FlashDetector::new(width, height, fps, standards);
    detector.source = "file".to_owned();
    decode_into(&tools.ffmpeg, &file, width, height, resample, &mut detector)?;
    let report = detector.finish();
    Ok(json!({
        "ok": true,
        "file": file.to_string_lossy(),
        "width": info.width,
        "height": info.height,
        "decode": { "width": width, "height": height, "fps": fps, "resampled": resample.is_some() },
        "report": report,
    }))
}

/// The ffmpeg argv for a scaled rgb24 decode on stdout (no path ever enters a filter graph).
fn decode_args(file: &Path, width: u32, height: u32, resample: Option<f64>) -> Vec<String> {
    let mut vf = Vec::new();
    if let Some(fps) = resample {
        vf.push(format!("fps={fps}"));
    }
    vf.push(format!("scale={width}:{height}:flags=area"));
    vf.push("format=rgb24".to_owned());
    [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        &file.to_string_lossy(),
        "-an",
        "-sn",
        "-dn",
        "-vf",
        &vf.join(","),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn decode_into(
    ffmpeg: &Path,
    file: &Path,
    width: u32,
    height: u32,
    resample: Option<f64>,
    detector: &mut FlashDetector,
) -> Result<(), Fail> {
    let mut child = crate::tools::sidecar_command(ffmpeg)
        .args(decode_args(file, width, height, resample))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Fail::new("env", format!("could not start ffmpeg: {e}")))?;
    let mut stderr = child.stderr.take();
    let tail = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(err) = stderr.as_mut() {
            let _ = err.read_to_string(&mut text);
        }
        text
    });
    let mut stdout = child.stdout.take();
    let mut frame = vec![0u8; width as usize * height as usize * 3];
    let mut interrupted = false;
    if let Some(out) = stdout.as_mut() {
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                interrupted = true;
                let _ = child.kill();
                break;
            }
            match out.read_exact(&mut frame) {
                Ok(()) => detector.push_rgb(&frame, false),
                Err(_) => break,
            }
        }
    }
    drop(stdout);
    let status = child.wait();
    let errors = tail.join().unwrap_or_default();
    if interrupted {
        return Err(Fail::new("interrupted", "the flash check was interrupted"));
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if !ok || detector.frames() == 0 {
        let detail = errors.trim();
        eprintln!("{detail}");
        let tail: String = detail
            .chars()
            .rev()
            .take(400)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(Fail::new(
            "ffmpeg",
            format!(
                "ffmpeg could not decode {}{}",
                file.display(),
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(": {tail}")
                }
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(list: &[&str]) -> i32 {
        main(list.iter().map(OsString::from).collect())
    }

    #[test]
    fn decode_sizes_match_scale_minus_two() {
        assert_eq!(decode_size(3840, 2160), (1024, 576));
        assert_eq!(decode_size(2160, 3840), (1024, 1820));
        assert_eq!(decode_size(2160, 2700), (1024, 1280));
        assert_eq!(decode_size(1206, 2622), (1024, 2226));
        assert_eq!(decode_size(1, 0), (1024, 2));
    }

    #[test]
    fn the_decode_keeps_paths_out_of_the_filter_graph() {
        let args = decode_args(Path::new("/tmp/a,b.mp4"), 1024, 576, None);
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(vf, "scale=1024:576:flags=area,format=rgb24");
        assert!(args.contains(&"/tmp/a,b.mp4".to_owned()));
        let args = decode_args(Path::new("/tmp/x.mp4"), 1024, 576, Some(30.0));
        assert!(args.contains(&"fps=30,scale=1024:576:flags=area,format=rgb24".to_owned()));
    }

    #[test]
    fn usage_errors_exit_two_and_a_missing_film_exits_one() {
        assert_eq!(code(&[]), 2);
        assert_eq!(code(&["patterns"]), 2);
        assert_eq!(code(&["flashes"]), 2);
        assert_eq!(code(&["flashes", "--file", "relative.mp4"]), 2);
        assert_eq!(
            code(&["flashes", "--file", "/tmp/x.mp4", "--standard", "ada"]),
            2
        );
        assert_eq!(code(&["flashes", "--file", "/tmp/x.mp4", "--fps", "0"]), 2);
        assert_eq!(code(&["flashes", "--file", "/nonexistent/kc-film.mp4"]), 1);
        assert_eq!(parse_fps("29.97").unwrap(), 29.97);
    }

    #[test]
    fn checks_are_listed_for_caps() {
        assert_eq!(CHECKS, ["flashes"]);
    }

    /// End to end through the real sidecar: `cargo test -- --ignored check_flashes_`.
    #[test]
    #[ignore]
    fn check_flashes_reads_a_strobe_through_ffmpeg() {
        let tools = crate::tools::Tools::beside_exe().unwrap();
        assert!(tools.ffmpeg.is_file(), "run pnpm setup:ffmpeg first");
        let dir = std::env::temp_dir().join(format!("kc-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let film = dir.join("strobe.mp4");
        let graph = "color=c=black:s=640x360:r=60:d=2[a];color=c=white:s=640x360:r=60:d=2[b];[a][b]overlay=enable='gte(mod(n\\,12)\\,6)',format=yuv420p[out]";
        let made = std::process::Command::new(&tools.ffmpeg)
            .args([
                "-v",
                "error",
                "-y",
                "-filter_complex",
                graph,
                "-map",
                "[out]",
            ])
            .args(["-c:v", "libx264", "-preset", "ultrafast"])
            .arg(&film)
            .status()
            .unwrap();
        assert!(made.success());
        let out = flashes(&["--file".into(), film.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(out["report"]["ok"], false);
        assert_eq!(out["report"]["frames"], 120);
        assert_eq!(out["report"]["source"], "file");
        assert_eq!(out["decode"]["width"], 1024);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
