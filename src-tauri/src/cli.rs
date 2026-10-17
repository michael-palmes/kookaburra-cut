//! The headless edit CLI (`<app binary> edit <command>`): the same Rust cores as the editor's Tauri commands, so an agent's edit saves and renders exactly like the editor's. stdout carries one JSON object (JSON lines for `render`), stderr only diagnostics; nothing Tauri or AppKit starts on this path. Contract: docs/agent-kit.md (headless CLI).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Map, Value};

use crate::edit::{self, CoreError, EditDoc, RenderEvent, RenderJob, RenderTarget};
use crate::{live_edits, media, tools, workspace};

/// Bumped when a command or a JSON shape changes incompatibly; kb gates on it.
const CLI_VERSION: u32 = 1;
const COMMANDS: &[&str] = &["caps", "probe", "create", "validate", "save", "render"];
/// Counting packets demuxes the whole file, so only small files get an exact count when the container declares none.
const COUNT_PACKETS_MAX_BYTES: u64 = 256 * 1024 * 1024;

static CANCEL: AtomicBool = AtomicBool::new(false);

/// A failed command: its machine code, a sentence saying what to do, and any extra fields.
#[derive(Debug)]
struct Fail {
    code: &'static str,
    message: String,
    extra: Map<String, Value>,
}

impl Fail {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            extra: Map::new(),
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        Self::new("usage", message)
    }

    fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_owned(), value.into());
        self
    }

    fn exit_code(&self) -> i32 {
        match self.code {
            "usage" | "env" => 2,
            "interrupted" => 130,
            _ => 1,
        }
    }

    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("ok".into(), false.into());
        out.insert("code".into(), self.code.into());
        out.insert("error".into(), self.message.clone().into());
        for (key, value) in &self.extra {
            out.insert(key.clone(), value.clone());
        }
        Value::Object(out)
    }
}

impl From<CoreError> for Fail {
    fn from(error: CoreError) -> Self {
        Fail::new(error.code, error.message)
    }
}

/// Entry point for `edit …`; returns the process exit code.
pub fn main(args: Vec<OsString>) -> i32 {
    let args: Result<Vec<String>, _> = args.into_iter().map(OsString::into_string).collect();
    let Ok(args) = args else {
        return finish(Err(Fail::usage("arguments must be UTF-8 text")));
    };
    let Some((command, rest)) = args.split_first() else {
        return finish(Err(Fail::usage(format!(
            "give an edit command: {}",
            COMMANDS.join(", ")
        ))));
    };
    match command.as_str() {
        "caps" => finish(caps(rest)),
        "probe" => finish(probe(rest)),
        "create" => finish(create(rest)),
        "validate" => finish(validate(rest)),
        "save" => finish(save(rest)),
        "render" => render(rest),
        other => finish(Err(Fail::usage(format!(
            "unknown edit command {other:?}: use one of {}",
            COMMANDS.join(", ")
        )))),
    }
}

fn finish(result: Result<Value, Fail>) -> i32 {
    match result {
        Ok(value) => {
            print_line(&value);
            0
        }
        Err(fail) => {
            print_line(&fail.to_json());
            fail.exit_code()
        }
    }
}

fn print_line(value: &Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// `--key value`, `--key=value` and bare `--switch` flags, each allowed once.
#[derive(Debug, Default)]
struct Flags {
    values: BTreeMap<String, String>,
    switches: Vec<String>,
}

impl Flags {
    fn parse(args: &[String], valued: &[&str], switches: &[&str]) -> Result<Self, Fail> {
        let mut flags = Flags::default();
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let Some(body) = arg.strip_prefix("--") else {
                return Err(Fail::usage(format!("unexpected argument {arg:?}")));
            };
            let (key, inline) = match body.split_once('=') {
                Some((key, value)) => (key, Some(value.to_owned())),
                None => (body, None),
            };
            if valued.contains(&key) {
                let value = match inline {
                    Some(value) => value,
                    None => it
                        .next()
                        .filter(|v| !v.starts_with("--"))
                        .cloned()
                        .ok_or_else(|| Fail::usage(format!("--{key} needs a value")))?,
                };
                if flags.values.insert(key.to_owned(), value).is_some() {
                    return Err(Fail::usage(format!("--{key} is given twice")));
                }
            } else if switches.contains(&key) {
                if inline.is_some() {
                    return Err(Fail::usage(format!("--{key} takes no value")));
                }
                if flags.has(key) {
                    return Err(Fail::usage(format!("--{key} is given twice")));
                }
                flags.switches.push(key.to_owned());
            } else {
                return Err(Fail::usage(format!(
                    "unknown flag --{key} for this command"
                )));
            }
        }
        Ok(flags)
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn require(&self, key: &str) -> Result<&str, Fail> {
        self.get(key)
            .ok_or_else(|| Fail::usage(format!("--{key} is required")))
    }

    fn has(&self, key: &str) -> bool {
        self.switches.iter().any(|s| s == key)
    }
}

/// `--project`: an absolute folder holding `project.json`; the CLI never consults the workspace root.
fn project(flags: &Flags) -> Result<PathBuf, Fail> {
    let raw = flags.require("project")?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(Fail::usage(format!(
            "--project must be an absolute project folder, not {raw:?}"
        )));
    }
    if !path.join(workspace::MANIFEST_FILENAME).is_file() {
        return Err(Fail::usage(format!(
            "{raw} is not a project folder (it has no project.json)"
        )));
    }
    Ok(path)
}

fn edit_name(raw: &str) -> Result<String, Fail> {
    if workspace::validate_slug(raw).is_err() || raw.starts_with('_') {
        return Err(Fail::usage(format!(
            "{raw:?} is not an edit name: use letters, digits, - and _, not starting with _ or ."
        )));
    }
    Ok(raw.to_owned())
}

fn read_stdin() -> Result<Vec<u8>, Fail> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|e| Fail::new("env", format!("reading the document from stdin: {e}")))?;
    Ok(bytes)
}

/// `--doc -` reads the document from stdin; any other value is a usage error.
fn stdin_doc_bytes(flags: &Flags) -> Result<Option<Vec<u8>>, Fail> {
    match flags.get("doc") {
        None => Ok(None),
        Some("-") => read_stdin().map(Some),
        Some(other) => Err(Fail::usage(format!(
            "--doc takes - (the document on stdin), not {other:?}"
        ))),
    }
}

fn parse_doc(bytes: &[u8]) -> Result<EditDoc, CoreError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CoreError::new("corrupt", "edit is corrupt: not UTF-8 text"))?;
    edit::parse_doc_coded(text)
}

fn tools() -> Result<tools::Tools, Fail> {
    tools::Tools::beside_exe().map_err(|e| Fail::new("env", e))
}

fn require_tool(path: &Path, name: &str) -> Result<(), Fail> {
    if path.is_file() {
        Ok(())
    } else {
        Err(Fail::new(
            "env",
            format!(
                "{name} is missing beside the app ({}): reinstall Kookaburra Cut",
                path.display()
            ),
        ))
    }
}

fn run_tool(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// Filter names from `ffmpeg -filters`: rows of flags, name and an `in->out` pad description, after the legend.
fn parse_filters(text: &str) -> Vec<String> {
    let mut names: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let flags = parts.next()?;
            let name = parts.next()?;
            let pads = parts.next()?;
            // ffmpeg 8 prints two flag columns (`TS`), older builds three (`TSC`).
            let flag_like = (2..=3).contains(&flags.len())
                && flags
                    .chars()
                    .all(|c| c == '.' || c.is_ascii_uppercase() || c == '|');
            (flag_like && pads.contains("->")).then(|| name.to_owned())
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

fn caps(args: &[String]) -> Result<Value, Fail> {
    caps_in(args, tools::app_data_dir().ok())
}

fn caps_in(args: &[String], app_data: Option<PathBuf>) -> Result<Value, Fail> {
    Flags::parse(args, &[], &[])?;
    let tools = tools()?;
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let filters = run_tool(&tools.ffmpeg, &["-hide_banner", "-filters"]).map(|t| parse_filters(&t));
    let ffprobe_ok = run_tool(&tools.ffprobe, &["-hide_banner", "-version"]).is_ok();
    let hardware = app_data.map_or(true, |dir| tools::hardware_enabled(&dir));
    let styles: Vec<&str> = crate::tap_dot_frames::TAP_DOT_STYLES
        .iter()
        .map(|(id, _)| *id)
        .collect();
    let colors: Vec<&str> = crate::tap_dot_frames::TAP_DOT_COLORS
        .iter()
        .map(|(id, _)| *id)
        .collect();
    Ok(json!({
        "ok": true,
        "cli": CLI_VERSION,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "build": if cfg!(debug_assertions) { "dev" } else { "release" },
        "exe": exe,
        "commands": COMMANDS,
        "docVersion": { "read": edit::EDIT_VERSION_READ_MAX, "write": [1, edit::EDIT_VERSION_MASKS] },
        "ffmpeg": { "path": tools.ffmpeg.to_string_lossy(), "ok": filters.is_ok() },
        "ffprobe": { "path": tools.ffprobe.to_string_lossy(), "ok": ffprobe_ok },
        "filters": filters.unwrap_or_default(),
        "hardwareVideo": hardware,
        "tap": {
            "styles": styles,
            "colors": colors,
            "sizeRange": [0.25, 4],
            "defaultSize": 1.25,
            "durationMs": edit::TAP_ANIMATION_DURATION_MS as u64,
            "defaultStyle": styles.first(),
            "defaultColor": colors.first(),
        },
        "mask": {
            "styles": ["solid", "blur", "pixelate"],
            "defaultStrength": crate::edit_masks::DEFAULT_STRENGTH,
            "defaultColor": "#000000",
        },
        "limits": {
            "minClipSourceMs": edit::MIN_CLIP_SOURCE_MS,
            "minHoldMs": edit::MIN_HOLD_MS,
            "defaultHoldMs": edit::DEFAULT_IMAGE_HOLD_MS,
            "defaultFps": 60,
        },
    }))
}

fn media_kind(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)?;
    if workspace::VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some("video")
    } else if workspace::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some("image")
    } else {
        None
    }
}

/// The exact packet count of the first video stream, when the file is small enough to demux quickly.
fn count_packets(ffprobe: &Path, abs: &Path) -> Option<u64> {
    let size = std::fs::metadata(abs).ok()?.len();
    if size > COUNT_PACKETS_MAX_BYTES {
        return None;
    }
    edit::count_video_packets(ffprobe, abs).ok()
}

fn probe(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["project", "source", "file"], &[])?;
    let abs = match (flags.get("source"), flags.get("file")) {
        (Some(rel), None) => {
            let project = project(&flags)?;
            media::resolve_asset_in(&project, rel).map_err(Fail::usage)?
        }
        (None, Some(file)) => {
            if flags.get("project").is_some() {
                project(&flags)?;
            }
            let path = PathBuf::from(file);
            if !path.is_absolute() {
                return Err(Fail::usage(format!(
                    "--file must be an absolute path, not {file:?}"
                )));
            }
            path
        }
        _ => return Err(Fail::usage("give exactly one of --source R or --file ABS")),
    };
    if !abs.is_file() {
        return Err(Fail::new(
            "missing",
            format!("no file at {}", abs.display()),
        ));
    }
    let Some(kind) = media_kind(&abs) else {
        return Err(Fail::new(
            "invalid",
            format!(
                "{} is not a video or image the editor can use",
                abs.display()
            ),
        ));
    };
    let tools = tools()?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let info = media::probe_media_at(&tools.ffprobe, &abs).map_err(|e| Fail::new("invalid", e))?;
    let nb_frames = match kind {
        "video" => info
            .nb_frames
            .or_else(|| count_packets(&tools.ffprobe, &abs)),
        _ => None,
    };
    let (even_w, even_h) = edit::even(info.width, info.height);
    Ok(json!({
        "ok": true,
        "kind": info.kind,
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "rFps": info.r_fps,
        "avgFps": info.avg_fps,
        "durationMs": info.duration_ms,
        "vfr": info.vfr,
        "rotation": info.rotation,
        "nbFrames": nb_frames,
        "editFps": edit::edit_fps(&info),
        "evenSize": [even_w, even_h],
    }))
}

fn doc_value(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn create(args: &[String]) -> Result<Value, Fail> {
    create_with(args, tools)
}

fn create_with(
    args: &[String],
    tools: impl FnOnce() -> Result<tools::Tools, Fail>,
) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["project", "source", "name"], &["reuse", "force"])?;
    let project = project(&flags)?;
    let source_rel = flags.require("source")?;
    if flags.has("reuse") && flags.has("force") {
        return Err(Fail::usage("give one of --reuse or --force, not both"));
    }
    let source_abs = media::resolve_asset_in(&project, source_rel).map_err(Fail::usage)?;
    if !source_abs.is_file() {
        return Err(Fail::new(
            "missing",
            format!("source not found: {source_rel}"),
        ));
    }
    let name = match flags.get("name") {
        Some(raw) => edit_name(raw)?,
        None => edit::default_edit_name(&source_abs),
    };
    let path = edit::edit_path(&project, &name);
    let rel = edit::edit_rel(&name);
    if path.is_file() && !flags.has("force") {
        if flags.has("reuse") {
            let (_, bytes, hash) = edit::load_doc_bytes(&project, &name)?;
            return Ok(json!({
                "ok": true, "created": false, "name": name, "path": path_string(&path),
                "hash": hash, "doc": doc_value(&bytes),
            }));
        }
        let bytes = std::fs::read(&path).unwrap_or_default();
        let source = parse_doc(&bytes)
            .ok()
            .and_then(|doc| doc.sources.first().map(|s| s.rel.clone()));
        return Err(Fail::new(
            "exists",
            format!("{rel} already exists: pass --reuse to use it or --force to replace it"),
        )
        .with("name", name.clone())
        .with("path", path_string(&path))
        .with("hash", live_edits::content_hash(&bytes))
        .with("sourceRel", source));
    }
    let tools = tools()?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let doc = edit::create_default_doc_at(&tools.ffprobe, &project, &name, source_rel)?;
    if flags.has("force") {
        edit::backup_doc(&project, &name);
    }
    let landed = edit::write_doc_checked(&project, &name, &doc, Some(live_edits::ABSENT_BASE))
        .map_err(|e| {
            if e.starts_with(live_edits::CONFLICT_PREFIX) {
                Fail::new(
                    "exists",
                    format!("{rel} appeared while it was being created: run again"),
                )
            } else {
                Fail::new("invalid", e)
            }
        })?;
    let bytes = edit::doc_bytes(&doc).map_err(|e| Fail::new("invalid", e))?;
    Ok(json!({
        "ok": true, "created": true, "name": name, "path": path_string(&path),
        "hash": landed.hash, "doc": doc_value(&bytes),
    }))
}

/// The report for a document that cannot be parsed: no plan, one error.
fn unreadable_report(error: &CoreError, hash: &str) -> Value {
    json!({
        "ok": false, "version": null, "totalFrames": null, "durationMs": null, "fps": null,
        "width": null, "height": null, "clips": [], "taps": [],
        "errors": [{ "code": error.code, "message": error.message }],
        "warnings": [], "hash": hash,
    })
}

fn validate(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["project", "name", "doc"], &[])?;
    let project = project(&flags)?;
    let name = flags.get("name").map(edit_name).transpose()?;
    let bytes = match (stdin_doc_bytes(&flags)?, &name) {
        (Some(bytes), _) => bytes,
        (None, Some(name)) => {
            let path = edit::edit_path(&project, name);
            std::fs::read(&path).map_err(|e| {
                Fail::new(
                    "missing",
                    format!("cannot read {}: {e}", edit::edit_rel(name)),
                )
            })?
        }
        (None, None) => return Err(Fail::usage("give --name N or --doc -")),
    };
    let hash = live_edits::content_hash(&bytes);
    let doc = match parse_doc(&bytes) {
        Ok(doc) => doc,
        Err(error) => return Ok(unreadable_report(&error, &hash)),
    };
    let mut report = serde_json::to_value(edit::validate_doc(&project, &doc, name.as_deref()))
        .map_err(|e| Fail::new("invalid", e.to_string()))?;
    report["hash"] = hash.into();
    Ok(report)
}

fn valid_base(base: &str) -> bool {
    base == live_edits::ABSENT_BASE
        || (base.len() == 64
            && base
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
}

fn save(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["project", "name", "doc", "base"], &[])?;
    let project = project(&flags)?;
    let name = edit_name(flags.require("name")?)?;
    let base = flags.require("base")?;
    if !valid_base(base) {
        return Err(Fail::usage(
            "--base takes the sha256 hex of the document you read, or absent for a new one",
        ));
    }
    let bytes = stdin_doc_bytes(&flags)?.ok_or_else(|| Fail::usage("--doc - is required"))?;
    let doc = parse_doc(&bytes)?;
    edit::check_doc_name(&doc, &name).map_err(|e| Fail::new("invalid", e))?;
    let path = edit::edit_path(&project, &name);
    let landed = edit::write_doc_checked(&project, &name, &doc, Some(base)).map_err(|e| {
        if e.starts_with(live_edits::CONFLICT_PREFIX) {
            Fail::new(
                "conflict",
                format!(
                    "{} changed since the version you read: read it again, reapply the change and save with its hash",
                    edit::edit_rel(&name)
                ),
            )
            .with(
                "hash",
                live_edits::current_hash(&path).unwrap_or_default(),
            )
        } else {
            Fail::new("invalid", e)
        }
    })?;
    edit::write_tap_prefs(&project, &doc);
    let written = edit::doc_bytes(&doc).map(|b| b.len()).unwrap_or(0);
    Ok(json!({
        "ok": true, "name": name, "path": path_string(&path), "hash": landed.hash, "bytes": written,
    }))
}

/// Case-insensitive component prefix test (APFS folds case by default).
fn path_within(path: &Path, dir: &Path) -> bool {
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let (path, dir) = (lower(path), lower(dir));
    path.len() > dir.len() && path[..dir.len()] == dir[..]
}

/// The path with its deepest existing ancestor canonicalised, so a not-yet-created file compares like a real one.
fn canonical_lenient(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => {
                rest.push(name.to_owned());
                existing.pop();
            }
            None => break,
        }
    }
    let mut base = existing.canonicalize().unwrap_or(existing);
    for part in rest.iter().rev() {
        base.push(part);
    }
    base
}

/// A review render's `--out`: an absolute `.mp4` outside the project's `assets/` (canonical outputs come only from `--name`).
fn review_output(project: &Path, raw: &str) -> Result<PathBuf, Fail> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(Fail::usage(format!(
            "--out must be an absolute .mp4 path, not {raw:?}"
        )));
    }
    let mp4 = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    if !mp4 {
        return Err(Fail::usage("--out must name an .mp4 file"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Fail::usage("--out must not contain .."));
    }
    let assets = canonical_lenient(&project.join("assets"));
    if path_within(&canonical_lenient(&path), &assets)
        || path_within(&path, &project.join("assets"))
    {
        return Err(Fail::usage(
            "--out cannot be inside the project's assets/: render the named edit without --out for its canonical output",
        ));
    }
    Ok(path)
}

fn parse_scale(raw: &str) -> Result<f64, Fail> {
    raw.parse::<f64>()
        .ok()
        .filter(|f| f.is_finite() && (0.1..=1.0).contains(f))
        .ok_or_else(|| Fail::usage(format!("--scale takes a factor from 0.1 to 1, not {raw:?}")))
}

extern "C" fn on_signal(_signal: libc::c_int) {
    CANCEL.store(true, Ordering::SeqCst);
}

/// SIGINT/SIGTERM only raise the cancel flag; the render loop kills ffmpeg and removes its staging.
fn install_signal_handlers() {
    let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}

fn render(args: &[String]) -> i32 {
    match render_inner(args) {
        Ok(done) => {
            print_line(&done);
            0
        }
        Err(fail) => {
            let mut line = fail.to_json();
            line["event"] = "error".into();
            print_line(&line);
            fail.exit_code()
        }
    }
}

fn render_inner(args: &[String]) -> Result<Value, Fail> {
    let flags = Flags::parse(
        args,
        &["project", "name", "doc", "out", "scale", "expect-hash"],
        &["software", "draft"],
    )?;
    let project = project(&flags)?;
    let name = flags.get("name").map(edit_name).transpose()?;
    let out = flags
        .get("out")
        .map(|raw| review_output(&project, raw))
        .transpose()?;
    let draft = flags.has("draft");
    let scale = flags.get("scale").map(parse_scale).transpose()?;
    if draft && scale.is_some() {
        return Err(Fail::usage(
            "--draft already renders at half size: give --draft or --scale",
        ));
    }
    if flags.get("doc").is_none() && out.is_none() && (draft || scale.is_some()) {
        return Err(Fail::usage(
            "a draft or scaled render needs --out ABS.mp4: the edit's own output is always full size",
        ));
    }
    let (doc, doc_hash, target) = match (name, flags.get("doc")) {
        (Some(name), None) => {
            let (doc, _, hash) = edit::load_doc_bytes(&project, &name)?;
            if let Some(expect) = flags.get("expect-hash") {
                if expect != hash {
                    return Err(Fail::new(
                        "conflict",
                        format!(
                            "{} changed since the version you expected: validate it again before rendering",
                            edit::edit_rel(&name)
                        ),
                    )
                    .with("hash", hash));
                }
            }
            let target = match out {
                Some(path) => RenderTarget::File(path),
                None => RenderTarget::Canonical(name),
            };
            (doc, hash, target)
        }
        (None, Some(_)) => {
            if flags.get("expect-hash").is_some() {
                return Err(Fail::usage(
                    "--expect-hash checks a named edit: use it with --name",
                ));
            }
            let Some(path) = out else {
                return Err(Fail::usage(
                    "--doc - renders to a review file: add --out ABS.mp4",
                ));
            };
            let bytes = stdin_doc_bytes(&flags)?.unwrap_or_default();
            let doc = parse_doc(&bytes)?;
            (
                doc,
                live_edits::content_hash(&bytes),
                RenderTarget::File(path),
            )
        }
        _ => return Err(Fail::usage("give --name N, or --doc - with --out ABS.mp4")),
    };
    let tools = tools()?;
    require_tool(&tools.ffmpeg, "ffmpeg")?;
    require_tool(&tools.ffprobe, "ffprobe")?;
    let app_data = tools::app_data_dir().map_err(|e| Fail::new("env", e))?;
    let hardware = !flags.has("software") && !draft && tools::hardware_enabled(&app_data);
    let job = RenderJob {
        project,
        doc,
        doc_hash,
        target,
        ffmpeg: tools.ffmpeg,
        ffprobe: Some(tools.ffprobe),
        app_data,
        hardware,
        scale: if draft { Some(0.5) } else { scale },
        draft,
    };
    install_signal_handlers();
    let mut on = |event: RenderEvent| {
        let line = match event {
            RenderEvent::Start { lane, total, out } => json!({
                "event": "start", "lane": lane.as_str(), "total": total, "out": path_string(&out),
            }),
            RenderEvent::Progress { frame, total } => {
                json!({ "event": "progress", "frame": frame, "total": total })
            }
            RenderEvent::Retry { lane, error } => {
                eprintln!("hardware render failed, retrying in software: {error}");
                json!({ "event": "retry", "lane": lane.as_str(), "error": error })
            }
        };
        print_line(&line);
    };
    let outcome = edit::render_doc(job, &mut on, &CANCEL).map_err(|e| {
        if e.code == "ffmpeg" {
            eprintln!("{}", e.message);
        }
        Fail::from(e)
    })?;
    Ok(json!({
        "event": "done", "ok": true, "rel": outcome.rel, "path": path_string(&outcome.path),
        "lane": outcome.lane.as_str(), "frames": outcome.frames, "durationMs": outcome.duration_ms,
        "bytes": outcome.bytes, "elapsedMs": outcome.elapsed_ms, "docHash": outcome.doc_hash,
        "width": outcome.width, "height": outcome.height, "fps": outcome.fps,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_take_values_inline_or_next_and_refuse_strays() {
        let flags = Flags::parse(
            &args(&["--project", "/p", "--name=cut", "--reuse"]),
            &["project", "name"],
            &["reuse"],
        )
        .unwrap();
        assert_eq!(flags.get("project"), Some("/p"));
        assert_eq!(flags.get("name"), Some("cut"));
        assert!(flags.has("reuse"));
        let fail = |list: &[&str]| {
            Flags::parse(&args(list), &["project"], &["reuse"])
                .unwrap_err()
                .exit_code()
        };
        assert_eq!(fail(&["--bogus"]), 2);
        assert_eq!(fail(&["stray"]), 2);
        assert_eq!(fail(&["--project"]), 2);
        assert_eq!(fail(&["--project", "--reuse"]), 2);
        assert_eq!(fail(&["--project", "/a", "--project", "/b"]), 2);
        assert_eq!(fail(&["--reuse=yes"]), 2);
    }

    #[test]
    fn failures_map_codes_to_exit_codes_and_carry_extras() {
        assert_eq!(Fail::usage("x").exit_code(), 2);
        assert_eq!(Fail::new("env", "x").exit_code(), 2);
        assert_eq!(Fail::new("conflict", "x").exit_code(), 1);
        assert_eq!(Fail::new("interrupted", "x").exit_code(), 130);
        let json = Fail::new("exists", "taken").with("hash", "abc").to_json();
        assert_eq!(
            json,
            json!({"ok": false, "code": "exists", "error": "taken", "hash": "abc"})
        );
    }

    #[test]
    fn filter_names_come_from_the_rows_not_the_legend() {
        let text = "Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n  ..C = Command support\n  A = Audio input/output\n  | = Source or sink filter\n ... abench            A->A       Benchmark part of a filtergraph.\n TSC drawbox           V->V       Draw a colored box on the input video.\n ... color             |->V       Provide an uniformly colored input.\n";
        assert_eq!(parse_filters(text), ["abench", "color", "drawbox"]);
        let v8 = "Filters:\n  T.. = Timeline support\n  A = Audio input/output\n ------\n TS aap               AA->A      Apply Affine Projection.\n .. freezedetect      V->V       Detects frozen video input.\n .S blackdetect       V->V       Detect black intervals.\n";
        assert_eq!(parse_filters(v8), ["aap", "blackdetect", "freezedetect"]);
    }

    #[test]
    fn caps_pins_its_keys() {
        let caps = caps_in(
            &[],
            Some(std::env::temp_dir().join("kc-cli-caps-no-settings")),
        )
        .unwrap();
        let keys: Vec<&str> = caps
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = vec![
            "ok",
            "cli",
            "appVersion",
            "build",
            "exe",
            "commands",
            "docVersion",
            "ffmpeg",
            "ffprobe",
            "filters",
            "hardwareVideo",
            "tap",
            "mask",
            "limits",
        ];
        expected.sort();
        let mut got = keys.clone();
        got.sort();
        assert_eq!(got, expected);
        assert_eq!(caps["cli"], 1);
        assert_eq!(caps["commands"], json!(COMMANDS));
        assert_eq!(caps["docVersion"], json!({"read": 2, "write": [1, 2]}));
        assert_eq!(
            caps["tap"]["styles"][0],
            crate::tap_dot_frames::TAP_DOT_STYLES[0].0
        );
        assert_eq!(caps["tap"]["defaultColor"], "blue");
        assert_eq!(caps["tap"]["durationMs"], 550);
        assert_eq!(caps["mask"]["defaultStrength"], 0.5);
        assert_eq!(
            caps["limits"],
            json!({"minClipSourceMs": 100, "minHoldMs": 100, "defaultHoldMs": 2000, "defaultFps": 60})
        );
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn a_review_output_must_be_an_absolute_mp4_outside_assets() {
        let dir = temp_project("out");
        let ok = |raw: &str| review_output(&dir, raw).is_ok();
        let elsewhere = std::env::temp_dir().join("kc-cli-review/draft.mp4");
        assert!(ok(elsewhere.to_str().unwrap()));
        assert!(!ok("draft.mp4"));
        assert!(!ok(&format!(
            "{}/x.mov",
            elsewhere.parent().unwrap().display()
        )));
        assert!(!ok(&format!("{}/assets/x-edited.mp4", dir.display())));
        assert!(!ok(&format!("{}/Assets/sub/new.mp4", dir.display())));
        assert!(!ok(&format!("{}/scenes/../assets/x.mp4", dir.display())));
        // The project's own folder outside assets/ is fine (only assets/ is canonical).
        assert!(ok(&format!("{}/review.mp4", dir.display())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_paths_must_be_absolute_project_folders() {
        let dir = temp_project("proj");
        let flags = |p: &str| Flags::parse(&args(&["--project", p]), &["project"], &[]).unwrap();
        assert!(project(&flags(dir.to_str().unwrap())).is_ok());
        assert_eq!(project(&flags("relative/p")).unwrap_err().exit_code(), 2);
        std::fs::remove_file(dir.join("project.json")).unwrap();
        assert_eq!(
            project(&flags(dir.to_str().unwrap())).unwrap_err().code,
            "usage"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_errors_exit_two_before_any_work() {
        let dir = temp_project("usage");
        let p = dir.to_str().unwrap().to_owned();
        let code = |list: &[&str]| main(list.iter().map(OsString::from).collect());
        assert_eq!(code(&[]), 2);
        assert_eq!(code(&["frobnicate"]), 2);
        assert_eq!(code(&["create", "--project", &p]), 2);
        assert_eq!(
            code(&["create", "--project", &p, "--source", "../x.mp4"]),
            2
        );
        assert_eq!(
            code(&[
                "create",
                "--project",
                &p,
                "--source",
                "assets/a.mp4",
                "--reuse",
                "--force"
            ]),
            2
        );
        assert_eq!(
            code(&["create", "--project", &p, "--source", "assets/a.mp4"]),
            1
        );
        assert_eq!(code(&["validate", "--project", &p]), 2);
        assert_eq!(
            code(&["validate", "--project", &p, "--name", "_tap_prefs"]),
            2
        );
        assert_eq!(code(&["validate", "--project", &p, "--name", "nope"]), 1);
        assert_eq!(
            code(&[
                "save",
                "--project",
                &p,
                "--name",
                "cut",
                "--doc",
                "-",
                "--base",
                "beef"
            ]),
            2
        );
        assert_eq!(
            code(&["render", "--project", &p, "--name", "cut", "--draft"]),
            2
        );
        assert_eq!(
            code(&[
                "render",
                "--project",
                &p,
                "--name",
                "cut",
                "--draft",
                "--scale",
                "0.5"
            ]),
            2
        );
        assert_eq!(
            code(&[
                "render",
                "--project",
                &p,
                "--name",
                "cut",
                "--scale",
                "3",
                "--out",
                "/tmp/x.mp4"
            ]),
            2
        );
        assert_eq!(
            code(&[
                "render",
                "--project",
                &p,
                "--name",
                "cut",
                "--out",
                &format!("{p}/assets/x.mp4")
            ]),
            2
        );
        assert_eq!(code(&["render", "--project", &p, "--doc", "-"]), 2);
        assert_eq!(code(&["render", "--project", &p, "--name", "missing"]), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bases_are_sha256_hex_or_absent() {
        assert!(valid_base("absent"));
        assert!(valid_base(&"a".repeat(64)));
        assert!(!valid_base(&"A".repeat(64)));
        assert!(!valid_base(&"a".repeat(63)));
        assert!(!valid_base(""));
    }

    fn fake_tool(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn create_refuses_an_existing_edit_reuses_it_or_forces_with_a_backup() {
        let dir = temp_project("create");
        std::fs::write(dir.join("assets/Screen Rec.mp4"), b"not really a video").unwrap();
        let probe = r#"cat <<'JSON'
{"streams":[{"codec_type":"video","width":1920,"height":1080,"r_frame_rate":"30/1","avg_frame_rate":"30/1"}],"format":{"duration":"2.500000"}}
JSON"#;
        let fake = fake_tool(&dir, "ffprobe", probe);
        let tools = || {
            Ok(tools::Tools {
                ffmpeg: PathBuf::from("/nonexistent/ffmpeg"),
                ffprobe: fake.clone(),
            })
        };
        let p = dir.to_str().unwrap().to_owned();
        let run = |extra: &[&str]| {
            let mut list = vec!["--project", &p, "--source", "assets/Screen Rec.mp4"];
            list.extend_from_slice(extra);
            create_with(&args(&list), tools)
        };
        let made = run(&[]).unwrap();
        assert_eq!(made["created"], true);
        assert_eq!(made["name"], "screen-rec");
        assert_eq!(made["doc"]["clips"][0]["outMs"], 2500);
        assert_eq!(made["doc"]["settings"]["fps"], 30.0);
        let on_disk = std::fs::read(dir.join("edits/screen-rec.json")).unwrap();
        assert_eq!(made["hash"], live_edits::content_hash(&on_disk));

        let refused = run(&[]).unwrap_err();
        assert_eq!((refused.code, refused.exit_code()), ("exists", 1));
        assert_eq!(refused.extra["hash"], made["hash"]);
        assert_eq!(refused.extra["sourceRel"], "assets/Screen Rec.mp4");

        let reused = run(&["--reuse"]).unwrap();
        assert_eq!(reused["created"], false);
        assert_eq!(reused["hash"], made["hash"]);

        std::fs::write(dir.join("edits/screen-rec.json"), b"{broken").unwrap();
        assert_eq!(run(&["--reuse"]).unwrap_err().code, "corrupt");
        let forced = run(&["--force"]).unwrap();
        assert_eq!(forced["created"], true);
        assert_eq!(
            std::fs::read(dir.join("edits/screen-rec.json.bak")).unwrap(),
            b"{broken"
        );
        assert_eq!(forced["hash"], made["hash"]);

        let named = run(&["--name", "take-2"]).unwrap();
        assert_eq!(named["doc"]["name"], "take-2");
        assert_eq!(run(&["--name", "Bad Name"]).unwrap_err().code, "usage");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
