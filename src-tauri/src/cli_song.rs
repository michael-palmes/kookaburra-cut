//! `<app binary> song <command>`: the beat lane's song analyser, headless, with the edit CLI's conventions (one JSON object on stdout, diagnostics on stderr, exit 0 ok, 1 failed, 2 usage or environment, 130 interrupted). `song caps` says what this build can track; `song analyse` decodes with the bundled ffmpeg and writes the same `<sha>-v2.json` cache the app reads. Contract: docs/agent-kit.md (headless CLI).

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::cli::{finish, install_signal_handlers, require_tool, tools, Fail, Flags, CANCEL};
use crate::song::{self, Request, TrackerChoice};

const COMMANDS: &[&str] = &["caps", "analyse"];

/// Entry point for `song …`; returns the process exit code.
pub fn main(args: Vec<OsString>) -> i32 {
    let args: Result<Vec<String>, _> = args.into_iter().map(OsString::into_string).collect();
    let Ok(args) = args else {
        return finish(Err(Fail::usage("arguments must be UTF-8 text")));
    };
    let Some((command, rest)) = args.split_first() else {
        return finish(Err(Fail::usage(format!(
            "give a song command: {}",
            COMMANDS.join(", ")
        ))));
    };
    match command.as_str() {
        "caps" => finish(caps(rest)),
        "analyse" => finish(analyse(rest)),
        other => finish(Err(Fail::usage(format!(
            "unknown song command {other:?}: use one of {}",
            COMMANDS.join(", ")
        )))),
    }
}

fn model_dirs() -> Vec<PathBuf> {
    song::candidate_dirs(None)
}

fn caps(args: &[String]) -> Result<Value, Fail> {
    Flags::parse(args, &[], &[])?;
    let tools = tools()?;
    let model = match song::locate_model(&model_dirs()) {
        Ok(files) => {
            json!({ "name": song::MODEL_NAME, "available": true, "dir": files.dir.to_string_lossy() })
        }
        Err(reason) => json!({ "name": song::MODEL_NAME, "available": false, "reason": reason }),
    };
    Ok(json!({
        "ok": true,
        "commands": COMMANDS,
        "analysisVersion": song::ANALYSIS_VERSION,
        "trackers": song::TRACKERS,
        "model": model,
        "ffmpeg": { "path": tools.ffmpeg.to_string_lossy(), "ok": tools.ffmpeg.is_file() },
        "ffprobe": { "path": tools.ffprobe.to_string_lossy(), "ok": tools.ffprobe.is_file() },
    }))
}

fn audio_path(flags: &Flags) -> Result<PathBuf, Fail> {
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

fn tracker(flags: &Flags) -> Result<TrackerChoice, Fail> {
    match flags.get("tracker") {
        None => Ok(TrackerChoice::Auto),
        Some(raw) => TrackerChoice::parse(raw)
            .ok_or_else(|| Fail::usage(format!("--tracker takes nn or dsp, not {raw:?}"))),
    }
}

fn analyse(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["file", "tracker"], &["force"])?;
    let choice = tracker(&flags)?;
    let file = audio_path(&flags)?;
    let tools = tools()?;
    require_tool(&tools.ffmpeg, "ffmpeg")?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let cache = crate::tools::app_data_dir()
        .map(|dir| song::cache_dir(&dir))
        .map_err(|e| Fail::new("env", e))?;
    let dirs = model_dirs();
    install_signal_handlers();
    let req = Request {
        file: &file,
        tracker: choice,
        force: flags.has("force"),
        ffmpeg: &tools.ffmpeg,
        ffprobe: &tools.ffprobe,
        cache_dir: Some(&cache),
        model_dirs: &dirs,
    };
    let out = song::analyse(&req, &|| CANCEL.load(Ordering::SeqCst))
        .map_err(|e| Fail::new(e.code, e.message))?;
    Ok(json!({
        "ok": true,
        "file": file.to_string_lossy(),
        "cached": out.cached,
        "cachePath": out.cache_path.map(|p| p.to_string_lossy().into_owned()),
        "analysis": out.analysis,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(list: &[&str]) -> i32 {
        main(list.iter().map(OsString::from).collect())
    }

    #[test]
    fn usage_errors_exit_two_and_a_missing_file_exits_one() {
        assert_eq!(code(&[]), 2);
        assert_eq!(code(&["beats"]), 2);
        assert_eq!(code(&["analyse"]), 2);
        assert_eq!(code(&["analyse", "--file", "relative.mp3"]), 2);
        assert_eq!(
            code(&["analyse", "--file", "/tmp/x.mp3", "--tracker", "madmom"]),
            2
        );
        assert_eq!(code(&["analyse", "--file", "/tmp/x.mp3", "--force=1"]), 2);
        assert_eq!(code(&["analyse", "--file", "/nonexistent/kc-song.mp3"]), 1);
        assert_eq!(code(&["caps", "--extra"]), 2);
    }

    #[test]
    fn trackers_parse() {
        let flags = Flags::parse(&["--tracker".into(), "dsp".into()], &["tracker"], &[]).unwrap();
        assert_eq!(tracker(&flags).unwrap(), TrackerChoice::Dsp);
        let none = Flags::parse(&[], &["tracker"], &[]).unwrap();
        assert_eq!(tracker(&none).unwrap(), TrackerChoice::Auto);
    }

    #[test]
    fn caps_names_the_version_trackers_and_model() {
        let caps = caps(&[]).unwrap();
        assert_eq!(caps["analysisVersion"], 2);
        assert_eq!(caps["trackers"], json!(["nn", "dsp"]));
        assert_eq!(caps["commands"], json!(["caps", "analyse"]));
        assert_eq!(caps["model"]["name"], "beat_this_small");
        assert!(caps["model"]["available"].is_boolean());
    }
}
