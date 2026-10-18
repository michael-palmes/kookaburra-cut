//! `<app binary> media <command>`: the ingest conform's headless CLI, with the edit CLI's conventions (one JSON object on stdout, JSON lines for `conform`, diagnostics on stderr, exit 0 ok, 1 failed, 2 usage or environment, 130 interrupted). `media probe` reports what AVFoundation and ffmpeg each see and whether to conform; `media conform` writes the mezzanine and its timing record and keeps the original in `assets/.originals/`. Contract: docs/decisions.md (ingest conform).

use std::ffi::OsString;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::cli::{
    finish, install_signal_handlers, print_line, project, require_tool, tools, Fail, Flags, CANCEL,
};
use crate::conform::{self, ConformEvent, ConformTools, KeepOriginal};
use crate::{media, workspace};

const COMMANDS: &[&str] = &["caps", "probe", "conform"];
/// What `edit caps` lists under `media.commands`.
pub const CAPS_COMMANDS: &[&str] = &["probe", "conform"];

/// Entry point for `media …`; returns the process exit code.
pub fn main(args: Vec<OsString>) -> i32 {
    let args: Result<Vec<String>, _> = args.into_iter().map(OsString::into_string).collect();
    let Ok(args) = args else {
        return finish(Err(Fail::usage("arguments must be UTF-8 text")));
    };
    let Some((command, rest)) = args.split_first() else {
        return finish(Err(Fail::usage(format!(
            "give a media command: {}",
            COMMANDS.join(", ")
        ))));
    };
    match command.as_str() {
        "caps" => finish(caps(rest)),
        "probe" => finish(probe(rest)),
        "conform" => conform_command(rest),
        other => finish(Err(Fail::usage(format!(
            "unknown media command {other:?}: use one of {}",
            COMMANDS.join(", ")
        )))),
    }
}

fn caps(args: &[String]) -> Result<Value, Fail> {
    Flags::parse(args, &[], &[])?;
    Ok(json!({
        "ok": true,
        "cli": conform::MEDIA_CLI_VERSION,
        "commands": COMMANDS,
        "timingVersion": conform::TIMING_VERSION,
        "fps": conform::CONFORM_FPS,
        "keepOriginal": ["move", "copy"],
        "exitCodes": { "ok": 0, "failed": 1, "usage": 2, "interrupted": 130 },
    }))
}

fn video_file(flags: &Flags) -> Result<PathBuf, Fail> {
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
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !workspace::VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(Fail::new("invalid", format!("{raw} is not a video")));
    }
    Ok(path)
}

fn interrupted_or(code: &'static str) -> impl Fn(String) -> Fail {
    move |e| {
        if e == conform::INTERRUPTED {
            Fail::new("interrupted", "the probe was interrupted")
        } else {
            Fail::new(code, e)
        }
    }
}

fn probe(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["file"], &["pts"])?;
    let file = video_file(&flags)?;
    let tools = tools()?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let ff = conform::ffprobe_facts(&tools.ffprobe, &file).map_err(|e| Fail::new("invalid", e))?;
    let av = conform::av_facts(&file);
    let decoded = if flags.has("pts") {
        require_tool(&tools.ffmpeg, "ffmpeg")?;
        install_signal_handlers();
        let ff_timing = conform::ffmpeg_decode_timing(&tools.ffmpeg, &file, false, &CANCEL)
            .map_err(interrupted_or("ffmpeg"))?;
        let av_timing = match &av {
            Ok(_) => {
                Some(conform::av_decode_timing(&file, &CANCEL).map_err(interrupted_or("invalid"))?)
            }
            Err(_) => None,
        };
        Some((av_timing.unwrap_or_default(), ff_timing))
    } else {
        None
    };
    let pairs = decoded.as_ref().map(|(a, f)| (a, f));
    let mut report = conform::probe_report(&ff, av.as_ref().ok(), pairs, flags.has("pts"));
    if let Err(e) = &av {
        report["avfoundationError"] = json!(e);
    }
    let mut out = json!({ "ok": true, "file": file.to_string_lossy(), "kind": "video" });
    if let (Some(out), Some(report)) = (out.as_object_mut(), report.as_object()) {
        out.extend(report.clone());
    }
    Ok(out)
}

fn conform_command(args: &[String]) -> i32 {
    match conform_inner(args) {
        Ok(done) => {
            print_line(&done);
            0
        }
        Err(fail) => finish(Err(fail)),
    }
}

fn conform_inner(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(
        args,
        &["project", "source", "name", "keep-original"],
        &["force"],
    )?;
    let project = project(&flags)?;
    let keep = match flags.get("keep-original") {
        None | Some("move") => KeepOriginal::Move,
        Some("copy") => KeepOriginal::Copy,
        Some(other) => {
            return Err(Fail::usage(format!(
                "--keep-original takes move or copy, not {other:?}"
            )))
        }
    };
    let plan = conform::plan(
        flags.require("source")?,
        flags.get("name"),
        keep,
        flags.has("force"),
    )?;
    // Moving a named source away would break every scene that points at it; kb re-points first.
    let vanishes =
        keep == KeepOriginal::Move && !plan.in_place() && plan.source_rel != plan.original_rel;
    if vanishes {
        let used = media::media_references(&project, &plan.source_rel);
        if !used.is_empty() {
            return Err(Fail::new(
                "in-use",
                format!(
                    "{} is used by {}: re-point them to {} first, or pass --keep-original copy",
                    plan.source_rel,
                    used.join(", "),
                    plan.target_rel
                ),
            )
            .with("files", used));
        }
    }
    let tools = tools()?;
    require_tool(&tools.ffmpeg, "ffmpeg")?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    install_signal_handlers();
    let mut on = |event: ConformEvent| {
        let line = match event {
            ConformEvent::Start { total, out } => json!({
                "event": "start", "total": total, "out": out.to_string_lossy(),
            }),
            ConformEvent::Progress { frame, total } => {
                json!({ "event": "progress", "frame": frame, "total": total })
            }
        };
        print_line(&line);
    };
    let outcome = conform::conform(
        &project,
        &plan,
        &ConformTools {
            ffmpeg: tools.ffmpeg,
            ffprobe: tools.ffprobe,
            background: false,
        },
        &mut on,
        &CANCEL,
    )
    .map_err(|e| {
        if e.code == "ffmpeg" {
            eprintln!("{}", e.message);
        }
        Fail::from(e)
    })?;
    Ok(json!({
        "event": "done",
        "ok": true,
        "rel": outcome.target_rel,
        "path": project.join(&outcome.target_rel).to_string_lossy(),
        "original": outcome.original_rel,
        "timing": outcome.timing_rel,
        "inPlace": plan.in_place(),
        "frames": outcome.frames,
        "durationMs": outcome.duration_ms,
        "bytes": outcome.bytes,
        "elapsedMs": outcome.elapsed_ms,
        "verdict": outcome.verdict.verdict,
        "reasons": outcome.verdict.reasons,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(list: &[&str]) -> i32 {
        main(list.iter().map(OsString::from).collect())
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-media-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn usage_errors_exit_two_before_any_work() {
        let dir = temp_project("usage");
        let p = dir.to_str().unwrap().to_owned();
        assert_eq!(code(&[]), 2);
        assert_eq!(code(&["frobnicate"]), 2);
        assert_eq!(code(&["probe"]), 2);
        assert_eq!(code(&["probe", "--file", "relative.mp4"]), 2);
        assert_eq!(code(&["probe", "--file", "/nonexistent/a.mp4"]), 1);
        assert_eq!(code(&["conform", "--project", &p]), 2);
        assert_eq!(
            code(&["conform", "--project", &p, "--source", "../x.mp4"]),
            2
        );
        assert_eq!(
            code(&[
                "conform",
                "--project",
                &p,
                "--source",
                "assets/a.mp4",
                "--keep-original",
                "trash"
            ]),
            2
        );
        assert_eq!(
            code(&[
                "conform",
                "--project",
                &p,
                "--source",
                "assets/a.mp4",
                "--keep-original",
                "copy"
            ]),
            2
        );
        assert_eq!(
            code(&["conform", "--project", &p, "--source", "assets/a.mp4"]),
            1
        );
        assert_eq!(
            code(&["conform", "--project", "/nope", "--source", "assets/a.mp4"]),
            2
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_referenced_source_is_not_moved_away() {
        let dir = temp_project("in-use");
        std::fs::write(dir.join("assets/rec.mov"), b"not a video").unwrap();
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        std::fs::write(dir.join("scenes/01-a.json"), r#"{"src":"assets/rec.mov"}"#).unwrap();
        let p = dir.to_str().unwrap().to_owned();
        let run = |extra: &[&str]| {
            let mut list = vec!["conform", "--project", &p, "--source", "assets/rec.mov"];
            list.extend_from_slice(extra);
            code(&list)
        };
        let failed = format!(
            "{:?}",
            conform_inner(
                &[
                    "--project",
                    &p,
                    "--source",
                    "assets/rec.mov",
                    "--name",
                    "take"
                ]
                .map(String::from)
            )
            .unwrap_err()
        );
        assert!(
            failed.contains("in-use") && failed.contains("01-a.json"),
            "{failed}"
        );
        assert_eq!(run(&["--name", "take"]), 1);
        assert!(dir.join("assets/rec.mov").is_file());
        assert!(!dir.join("assets/.originals").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The CLI and the core land the same bytes, with JSON lines on the way.
    #[test]
    #[ignore = "runs the dev ffmpeg sidecar and the app binary that `cargo test` builds"]
    fn media_cli_conforms_like_the_core() {
        use crate::conform::tests::{barcode_source, decode_barcodes, temp_project};
        let bin = crate::tools::sidecar_path("kookaburra-cut").unwrap();
        assert!(
            bin.is_file(),
            "{} is missing: run `cargo test`",
            bin.display()
        );
        let dir = temp_project("cli");
        barcode_source(&dir.join("assets/rec.mp4"), 1, "N");
        let source = std::fs::read(dir.join("assets/rec.mp4")).unwrap();

        let probe = std::process::Command::new(&bin)
            .args(["media", "probe", "--pts", "--file"])
            .arg(dir.join("assets/rec.mp4"))
            .output()
            .unwrap();
        assert!(probe.status.success());
        let report: Value = serde_json::from_slice(&probe.stdout).unwrap();
        assert_eq!(report["verdict"], "ok");
        assert!(report["conform"]["refused"].is_null());
        assert_eq!(report["avfoundation"]["decode"]["frames"], 60);
        assert_eq!(report["ffmpeg"]["decode"]["frames"], 60);

        let run = std::process::Command::new(&bin)
            .args(["media", "conform", "--project"])
            .arg(&dir)
            .args(["--source", "assets/rec.mp4"])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&run.stdout);
        assert!(run.status.success(), "{stdout}");
        let lines: Vec<Value> = stdout
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["event"], "start");
        assert_eq!(lines[0]["total"], 60);
        assert!(lines.iter().any(|l| l["event"] == "progress"));
        let done = lines.last().unwrap();
        assert_eq!(
            (
                done["event"].clone(),
                done["rel"].clone(),
                done["inPlace"].clone()
            ),
            (json!("done"), json!("assets/rec.mp4"), json!(true))
        );
        assert_eq!(done["original"], "assets/.originals/rec.mp4");
        let cli_bytes = std::fs::read(dir.join("assets/rec.mp4")).unwrap();
        assert_eq!(
            decode_barcodes(&dir.join("assets/rec.mp4")),
            (0..60).collect::<Vec<u32>>()
        );

        let again = std::process::Command::new(&bin)
            .args(["media", "conform", "--project"])
            .arg(&dir)
            .args(["--source", "assets/rec.mp4"])
            .output()
            .unwrap();
        assert_eq!(
            again.status.code(),
            Some(1),
            "an existing mezzanine is refused"
        );

        let core = temp_project("core");
        std::fs::write(core.join("assets/rec.mp4"), &source).unwrap();
        let plan = conform::plan("assets/rec.mp4", None, KeepOriginal::Move, false).unwrap();
        let tools = ConformTools {
            ffmpeg: crate::tools::sidecar_path("ffmpeg").unwrap(),
            ffprobe: crate::tools::sidecar_path("ffprobe").unwrap(),
            background: false,
        };
        let never = std::sync::atomic::AtomicBool::new(false);
        conform::conform(&core, &plan, &tools, &mut |_| {}, &never).unwrap();
        assert!(std::fs::read(core.join("assets/rec.mp4")).unwrap() == cli_bytes);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&core);
    }

    #[test]
    fn caps_names_the_commands_and_exit_codes() {
        let caps = caps(&[]).unwrap();
        assert_eq!(caps["cli"], 1);
        assert_eq!(caps["commands"], json!(["caps", "probe", "conform"]));
        assert_eq!(caps["exitCodes"]["interrupted"], 130);
        assert_eq!(code(&["caps", "--bogus"]), 2);
    }
}
