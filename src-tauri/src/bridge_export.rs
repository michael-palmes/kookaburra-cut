//! Claude's export through the bridge (docs/agent-kit.md, "Export through the bridge"): the native loop claims `export` and `cancelExport`, so the render window never sees them; Rust holds the one slot, checks the editor has the project open, hands the run to the main window (`useBridgeExport`, which runs the Export button's own code) and owns the progress file, the output's hash and the answer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::bridge::{self, BridgeRequest, EditorContext, EditorContextState};
use crate::{workspace, ExportState, FlashState};

/// The main window must take (or refuse) an export this soon after the event.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(10);
/// A cancel the editor has not honoured this long is forced natively.
const CANCEL_BACKSTOP: Duration = Duration::from_secs(15);
const CLIENT_POLL: Duration = Duration::from_secs(1);
const PROGRESS_MIN_INTERVAL_MS: u64 = 1_000;
const MAX_SOURCES: usize = 4_096;
const MAX_SHORT_EDGE: u32 = 8_192;
pub(crate) const EXPORT_EVENT: &str = "kookaburra://bridge-export";
pub(crate) const CANCEL_EVENT: &str = "kookaburra://bridge-export-cancel";
const STAGES: &[&str] = &[
    "waiting",
    "syncing",
    "preparing",
    "render",
    "pass1",
    "pass2",
    "finalising",
    "hashing",
];
/// Progress keys the editor may report; anything else is dropped.
const PROGRESS_KEYS: &[&str] = &[
    "stage",
    "run",
    "runs",
    "prepareStep",
    "prepareSteps",
    "prepareLabel",
    "frame",
    "total",
    "percent",
    "renderFps",
    "elapsedMs",
    "etaMs",
];
/// What the editor's finished answer may carry; Rust adds the file's facts.
const RESULT_KEYS: &[&str] = &[
    "aspect",
    "preset",
    "lane",
    "codec",
    "fps",
    "width",
    "height",
    "posterFrame",
    "frames",
    "durationMs",
    "totalMs",
    "timeline",
    "verify",
    "warnings",
];
/// Failure codes the editor may answer with; any other reads as `failed`.
const FAILURE_CODES: &[&str] = &[
    "busy",
    "editing",
    "notOpen",
    "wrongProject",
    "invalid",
    "refused",
    "stale",
    "cancelled",
    "gpuStalled",
    "gpuWedged",
    "failed",
    "interrupted",
];

/// The export-only fields of a request, read back from its claimed file (the shared `BridgeRequest` ignores them).
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportFields {
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub short_edge: Option<u32>,
    #[serde(default)]
    pub poster_frame: Option<bool>,
    #[serde(default)]
    pub verify: bool,
    #[serde(default)]
    pub client_pid: Option<u32>,
    #[serde(default)]
    pub detach: bool,
    #[serde(default)]
    pub sources: Option<BTreeMap<String, String>>,
    /// `cancelExport`: the export request's id (absent = the running one).
    #[serde(default)]
    pub target: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn refusal(code: &str, error: &str, hint: Option<&str>) -> Value {
    let mut body = json!({ "ok": false, "code": code, "error": error });
    if let Some(hint) = hint {
        body["hint"] = json!(hint);
    }
    body
}

pub(crate) fn busy_body(error: &str) -> Value {
    let mut body = refusal(
        "busy",
        error,
        Some("rerun in a moment, once Kookaburra Cut is idle"),
    );
    body["busy"] = json!(true);
    body["retryAfterMs"] = json!(5_000);
    body
}

fn interrupted_body() -> Value {
    let mut body = refusal(
        "interrupted",
        "the editor reloaded during the export, so nothing was saved",
        Some("rerun kb export"),
    );
    body["retryAfterMs"] = json!(5_000);
    body
}

fn cancelled_body(by: &str) -> Value {
    let mut body = refusal(
        "cancelled",
        "the export was cancelled, so nothing was saved",
        None,
    );
    body["cancelled"] = json!(true);
    body["by"] = json!(by);
    body
}

fn valid_aspect(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 24
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

fn valid_preset(raw: &str) -> bool {
    raw.len() <= 80 && workspace::validate_slug(raw.strip_prefix("ws:").unwrap_or(raw)).is_ok()
}

fn valid_source(file: &str, hash: &str) -> bool {
    let file_ok = file == workspace::MANIFEST_FILENAME
        || file.strip_prefix("scenes/").is_some_and(|rest| {
            !rest.is_empty()
                && !rest.contains('/')
                && !rest.contains("..")
                && !rest.starts_with('.')
        });
    file_ok && hash.len() == 64 && hash.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// The request's syntax, before any state is touched: the workspace slug, or the refusal to answer.
pub(crate) fn validate(request: &BridgeRequest, fields: &ExportFields) -> Result<String, Value> {
    let invalid = |error: String| Err(refusal("invalid", &error, None));
    let Some(slug) = bridge::workspace_slug(request.project.as_deref()) else {
        return invalid("export needs a workspace project (ws:<folder>)".into());
    };
    if let Some(aspect) = fields.aspect.as_deref() {
        if !valid_aspect(aspect) {
            return invalid(format!(
                "{aspect:?} isn't an aspect (16:9, 9:16, 1:1, 4:5 ...)"
            ));
        }
    }
    if let Some(preset) = fields.preset.as_deref() {
        if !valid_preset(preset) {
            return invalid(format!("{preset:?} isn't an export preset id"));
        }
    }
    if let Some(fps) = fields.fps {
        if fps != 30 && fps != 60 {
            return invalid(format!("fps must be 30 or 60, not {fps}"));
        }
    }
    if let Some(edge) = fields.short_edge {
        if edge == 0 || edge > MAX_SHORT_EDGE {
            return invalid(format!("{edge} isn't a short edge"));
        }
    }
    if let Some(sources) = &fields.sources {
        if sources.len() > MAX_SOURCES {
            return invalid(format!("sources lists {} files", sources.len()));
        }
        if let Some((file, _)) = sources.iter().find(|(f, h)| !valid_source(f, h)) {
            return invalid(format!(
                "sources must map project.json and scenes/ files to SHA-256 hashes; {file:?} doesn't"
            ));
        }
    }
    Ok(slug.to_owned())
}

/// Only the project open in the editor exports; the Welcome screen or another project refuses.
pub(crate) fn open_project_refusal(
    context: Option<&EditorContext>,
    project: &str,
) -> Option<Value> {
    let hint = "ask the user to open this project in Kookaburra Cut, then rerun";
    let open = context.and_then(|c| c.project_id.as_deref());
    match open {
        Some(open) if open == project => None,
        Some(open) => Some(refusal(
            "wrongProject",
            &format!("Kookaburra Cut has {open} open, not {project}; kb export only exports the project open in the editor"),
            Some(hint),
        )),
        None => Some(refusal(
            "notOpen",
            &format!("Kookaburra Cut isn't showing {project} (it is on the Welcome screen); kb export only exports the project open in the editor"),
            Some(hint),
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Waiting,
    Running,
}

struct Slot {
    id: String,
    project: String,
    root: PathBuf,
    phase: Phase,
    accept: Option<oneshot::Sender<Value>>,
    finish: Option<oneshot::Sender<Value>>,
    stage: String,
    frame: u64,
    total: u64,
    last_write_ms: Option<u64>,
    written_stage: Option<String>,
    cancelled_by: Option<String>,
    output: Option<PathBuf>,
}

impl Slot {
    /// Answers whichever side the serve task awaits.
    fn fail(&mut self, body: Value) {
        if let Some(tx) = self.accept.take() {
            let _ = tx.send(body);
        } else if let Some(tx) = self.finish.take() {
            let _ = tx.send(body);
        }
    }
}

/// What a cancel found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CancelOutcome {
    Idle,
    /// Answered at once: the editor had not taken it yet.
    Cancelled(String),
    /// The editor is told; `first` is false for a repeat.
    Cancelling {
        id: String,
        first: bool,
    },
}

/// The one bridge export slot, plus the native run the heartbeat reports when no bridge export holds it.
pub(crate) struct Exports {
    slot: Mutex<Option<Slot>>,
    native: Mutex<Option<(&'static str, u32, u32)>>,
}

pub(crate) type Channels = (oneshot::Receiver<Value>, oneshot::Receiver<Value>);

impl Exports {
    pub(crate) const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            native: Mutex::new(None),
        }
    }

    /// Takes the slot for `id`; the holder's id when another export has it.
    pub(crate) fn begin(&self, id: &str, project: &str, root: &Path) -> Result<Channels, String> {
        let mut slot = self
            .slot
            .lock()
            .map_err(|_| "export slot poisoned".to_owned())?;
        if let Some(held) = slot.as_ref() {
            return Err(held.id.clone());
        }
        let (accept_tx, accept_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        *slot = Some(Slot {
            id: id.to_owned(),
            project: project.to_owned(),
            root: root.to_path_buf(),
            phase: Phase::Waiting,
            accept: Some(accept_tx),
            finish: Some(finish_tx),
            stage: "waiting".into(),
            frame: 0,
            total: 0,
            last_write_ms: None,
            written_stage: None,
            cancelled_by: None,
            output: None,
        });
        Ok((accept_rx, finish_rx))
    }

    /// The editor's answer to the export event: `{ "accepted": true }`, or a refusal. Ok(true) means run it now.
    pub(crate) fn accept(&self, id: &str, answer: Value) -> Result<bool, String> {
        let mut guard = self
            .slot
            .lock()
            .map_err(|_| "export slot poisoned".to_owned())?;
        let Some(slot) = guard
            .as_mut()
            .filter(|s| s.id == id && s.phase == Phase::Waiting)
        else {
            return Err(format!("no bridge export {id} is waiting for the editor"));
        };
        let accepted = answer.get("accepted") == Some(&Value::Bool(true));
        let Some(tx) = slot.accept.take() else {
            return Err(format!("bridge export {id} was already answered"));
        };
        if accepted {
            slot.phase = Phase::Running;
            slot.stage = "syncing".into();
        }
        if tx.send(answer).is_err() {
            *guard = None;
            return Err(format!("bridge export {id} gave up waiting for the editor"));
        }
        Ok(accepted)
    }

    /// The accept window closed; frees a slot the editor never took.
    pub(crate) fn expire(&self, id: &str) -> bool {
        let Ok(mut guard) = self.slot.lock() else {
            return false;
        };
        if guard
            .as_ref()
            .is_some_and(|s| s.id == id && s.phase == Phase::Waiting)
        {
            *guard = None;
            return true;
        }
        false
    }

    /// Records the editor's progress; returns the progress file and body when the throttle lets it be written (once a second, plus every stage change).
    pub(crate) fn progress(
        &self,
        id: &str,
        report: &Value,
        now: u64,
    ) -> Result<Option<(PathBuf, Value)>, String> {
        let mut guard = self
            .slot
            .lock()
            .map_err(|_| "export slot poisoned".to_owned())?;
        let Some(slot) = guard.as_mut().filter(|s| s.id == id) else {
            return Err(format!("no bridge export {id} is running"));
        };
        let mut body = Map::new();
        if let Some(object) = report.as_object() {
            for key in PROGRESS_KEYS {
                if let Some(value) = object.get(*key) {
                    body.insert((*key).to_owned(), value.clone());
                }
            }
        }
        if let Some(stage) = body.get("stage").and_then(Value::as_str) {
            if STAGES.contains(&stage) {
                slot.stage = stage.to_owned();
            }
        }
        body.insert("stage".into(), json!(slot.stage));
        if let Some(frame) = body.get("frame").and_then(Value::as_u64) {
            slot.frame = frame;
        }
        if let Some(total) = body.get("total").and_then(Value::as_u64) {
            slot.total = total;
        }
        let stage_changed = slot.written_stage.as_deref() != Some(slot.stage.as_str());
        let due = slot.last_write_ms.map_or(true, |last| {
            now.saturating_sub(last) >= PROGRESS_MIN_INTERVAL_MS
        });
        if !stage_changed && !due {
            return Ok(None);
        }
        slot.last_write_ms = Some(now);
        slot.written_stage = Some(slot.stage.clone());
        body.insert("version".into(), json!(2));
        body.insert("id".into(), json!(slot.id));
        body.insert("project".into(), json!(slot.project));
        body.insert("updatedAtMs".into(), json!(now));
        let path = slot
            .root
            .join("responses")
            .join(format!("{}.progress.json", slot.id));
        Ok(Some((path, Value::Object(body))))
    }

    /// The editor's finished answer (ok or not) for a running export.
    pub(crate) fn finish(&self, id: &str, result: Value) -> Result<(), String> {
        let mut guard = self
            .slot
            .lock()
            .map_err(|_| "export slot poisoned".to_owned())?;
        let Some(slot) = guard
            .as_mut()
            .filter(|s| s.id == id && s.phase == Phase::Running)
        else {
            return Err(format!("no bridge export {id} is running"));
        };
        let Some(tx) = slot.finish.take() else {
            return Err(format!("bridge export {id} already finished"));
        };
        let _ = tx.send(result);
        Ok(())
    }

    /// A finished native export: the running bridge export's file, the one Rust itself wrote.
    pub(crate) fn note_output(&self, path: &Path) {
        if let Ok(mut guard) = self.slot.lock() {
            if let Some(slot) = guard.as_mut().filter(|s| s.phase == Phase::Running) {
                slot.output = Some(path.to_path_buf());
            }
        }
    }

    pub(crate) fn output(&self, id: &str) -> Option<PathBuf> {
        let guard = self.slot.lock().ok()?;
        guard
            .as_ref()
            .filter(|s| s.id == id)
            .and_then(|s| s.output.clone())
    }

    pub(crate) fn set_stage(&self, id: &str, stage: &str) {
        if let Ok(mut guard) = self.slot.lock() {
            if let Some(slot) = guard.as_mut().filter(|s| s.id == id) {
                slot.stage = stage.to_owned();
            }
        }
    }

    pub(crate) fn is_current(&self, id: &str) -> bool {
        self.slot
            .lock()
            .map(|g| g.as_ref().is_some_and(|s| s.id == id))
            .unwrap_or(false)
    }

    /// Asks the running export (or `target`) to stop.
    pub(crate) fn cancel(&self, target: Option<&str>, by: &str) -> CancelOutcome {
        let Ok(mut guard) = self.slot.lock() else {
            return CancelOutcome::Idle;
        };
        let Some(slot) = guard
            .as_mut()
            .filter(|s| target.map_or(true, |t| s.id == t))
        else {
            return CancelOutcome::Idle;
        };
        let id = slot.id.clone();
        if slot.phase == Phase::Waiting {
            slot.fail(cancelled_body(by));
            *guard = None;
            return CancelOutcome::Cancelled(id);
        }
        let first = slot.cancelled_by.is_none();
        if first {
            slot.cancelled_by = Some(by.to_owned());
        }
        CancelOutcome::Cancelling { id, first }
    }

    /// Answers `body` to whoever waits on `id` and frees the slot.
    pub(crate) fn fail(&self, id: &str, body: Value) -> bool {
        let Ok(mut guard) = self.slot.lock() else {
            return false;
        };
        match guard.as_mut().filter(|s| s.id == id) {
            Some(slot) => {
                slot.fail(body);
                *guard = None;
                true
            }
            None => false,
        }
    }

    pub(crate) fn end(&self, id: &str) {
        if let Ok(mut guard) = self.slot.lock() {
            if guard.as_ref().is_some_and(|s| s.id == id) {
                *guard = None;
            }
        }
    }

    /// The main window (re)mounted: an export still in the slot lost its runner, so it fails now. Returns its id and whether it was running.
    pub(crate) fn reset(&self) -> Option<(String, bool)> {
        let mut guard = self.slot.lock().ok()?;
        let mut slot = guard.take()?;
        let running = slot.phase == Phase::Running;
        slot.fail(interrupted_body());
        Some((slot.id, running))
    }

    pub(crate) fn set_native(&self, job: Option<(&'static str, u32, u32)>) {
        if let Ok(mut guard) = self.native.lock() {
            *guard = job;
        }
    }

    /// The heartbeat's `exportJob`: the bridge export, else a run started from the app's own buttons.
    pub(crate) fn job(&self) -> Option<Value> {
        if let Some(slot) = self.slot.lock().ok().and_then(|g| {
            g.as_ref()
                .map(|s| (s.id.clone(), s.stage.clone(), s.frame, s.total))
        }) {
            let (id, stage, frame, total) = slot;
            return Some(
                json!({ "id": id, "origin": "bridge", "stage": stage, "frame": frame, "total": total }),
            );
        }
        let native = self.native.lock().ok().and_then(|g| *g)?;
        let (stage, frame, total) = native;
        Some(
            json!({ "id": null, "origin": "button", "stage": stage, "frame": frame, "total": total }),
        )
    }
}

static EXPORTS: Exports = Exports::new();

/// `exportJob` for the heartbeat.
pub(crate) fn job_value() -> Option<Value> {
    EXPORTS.job()
}

/// The native export's phase, from `start_export`, `push_frame` and `finish_export`.
pub(crate) fn native_job(job: Option<(&'static str, u32, u32)>) {
    EXPORTS.set_native(job);
}

pub(crate) fn note_output(path: &Path) {
    EXPORTS.note_output(path);
}

fn write_json_atomic(path: &Path, body: &Value) -> Result<(), String> {
    let dir = path.parent().ok_or("progress file has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("progress");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn read_fields(root: &Path, id: &str) -> Result<ExportFields, String> {
    let path = root
        .join("requests")
        .join(".claimed")
        .join(format!("{id}.json"));
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("the claimed request can't be read again: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("the request isn't valid: {e}"))
}

fn editor_context(app: &AppHandle) -> Option<EditorContext> {
    app.state::<EditorContextState>()
        .0
        .lock()
        .ok()
        .and_then(|c| c.clone())
}

fn main_window_only(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("bridge exports run in the main window only".into())
    }
}

/// The native loop's arm for `export` and `cancelExport`.
pub(crate) async fn serve(
    app: &AppHandle,
    root: &Path,
    request: &BridgeRequest,
) -> Result<Value, String> {
    let fields = match read_fields(root, &request.id) {
        Ok(fields) => fields,
        Err(error) => return Ok(refusal("invalid", &error, None)),
    };
    if request.kind.as_deref() == Some("cancelExport") {
        return Ok(serve_cancel(app, fields.target.as_deref()));
    }
    Ok(serve_export(app, root, request, fields).await)
}

fn serve_cancel(app: &AppHandle, target: Option<&str>) -> Value {
    match EXPORTS.cancel(target, "client") {
        CancelOutcome::Idle => json!({ "ok": true, "cancelled": false, "state": "idle" }),
        CancelOutcome::Cancelled(id) => {
            json!({ "ok": true, "cancelled": true, "state": "cancelled", "target": id })
        }
        CancelOutcome::Cancelling { id, first } => {
            if first {
                start_cancel(app, &id, "client");
            }
            json!({ "ok": true, "cancelled": true, "state": "cancelling", "target": id })
        }
    }
}

/// Tells the editor to abort, then forces the native encode down if it has not stopped in 15 s, and answers for it 15 s after that.
fn start_cancel(app: &AppHandle, id: &str, by: &str) {
    let _ = app.emit_to("main", CANCEL_EVENT, json!({ "id": id, "by": by }));
    let (app, id, by) = (app.clone(), id.to_owned(), by.to_owned());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CANCEL_BACKSTOP).await;
        if !EXPORTS.is_current(&id) {
            return;
        }
        log::warn!("[bridge] export {id} ignored its cancel for 15 s; stopping the encode");
        let _ = app.state::<ExportState>().cancel();
        tokio::time::sleep(CANCEL_BACKSTOP).await;
        EXPORTS.fail(&id, cancelled_body(&by));
    });
}

fn watch_client(app: &AppHandle, id: &str, pid: u32) {
    let (app, id) = (app.clone(), id.to_owned());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CLIENT_POLL).await;
            if !EXPORTS.is_current(&id) {
                return;
            }
            if !bridge::pid_alive(pid) {
                log::warn!("[bridge] kb (pid {pid}) exited; cancelling export {id}");
                if let CancelOutcome::Cancelling { first: true, .. } =
                    EXPORTS.cancel(Some(&id), "client-exit")
                {
                    start_cancel(&app, &id, "client-exit");
                }
                return;
            }
        }
    });
}

fn event_payload(request: &BridgeRequest, fields: &ExportFields, project: &str) -> Value {
    json!({
        "id": request.id,
        "project": project,
        "projectPath": request.project_path,
        "client": request.client,
        "aspect": fields.aspect,
        "preset": fields.preset,
        "fps": fields.fps,
        "shortEdge": fields.short_edge,
        "posterFrame": fields.poster_frame,
        "verify": fields.verify,
        "sources": fields.sources,
    })
}

async fn serve_export(
    app: &AppHandle,
    root: &Path,
    request: &BridgeRequest,
    fields: ExportFields,
) -> Value {
    let started = Instant::now();
    let slug = match validate(request, &fields) {
        Ok(slug) => slug,
        Err(body) => return body,
    };
    let project = format!("ws:{slug}");
    let settings = app.state::<workspace::SettingsState>();
    let dir = match workspace::project_dir(app, &settings, &slug).and_then(|dir| {
        bridge::check_project_dir(&dir, request.project_path.as_deref()).map(|()| dir)
    }) {
        Ok(dir) => dir,
        Err(error) => return refusal("invalid", &error, None),
    };
    let context = editor_context(app);
    if let Some(body) = open_project_refusal(context.as_ref(), &project) {
        return body;
    }
    if app.state::<ExportState>().busy() || context.as_ref().is_some_and(|c| c.export_locked) {
        return busy_body("Kookaburra Cut is exporting right now; retry once it finishes");
    }
    let id = request.id.clone();
    let (accept_rx, finish_rx) = match EXPORTS.begin(&id, &project, root) {
        Ok(channels) => channels,
        Err(holder) => {
            return busy_body(&format!(
                "Claude is already exporting through the bridge ({holder}); retry once it finishes"
            ))
        }
    };
    if let Ok(Some((path, body))) = EXPORTS.progress(&id, &json!({ "stage": "waiting" }), now_ms())
    {
        let _ = write_json_atomic(&path, &body);
    }
    if let Err(e) = app.emit_to(
        "main",
        EXPORT_EVENT,
        event_payload(request, &fields, &project),
    ) {
        EXPORTS.end(&id);
        return refusal("failed", &format!("couldn't reach the editor: {e}"), None);
    }
    let answer = match tokio::time::timeout(ACCEPT_TIMEOUT, accept_rx).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => {
            EXPORTS.end(&id);
            return interrupted_body();
        }
        Err(_) => {
            EXPORTS.expire(&id);
            let mut body = refusal(
                "acceptTimeout",
                "the editor did not take the export within 10 s",
                Some("rerun in a moment; if it keeps happening, ask the user to check Kookaburra Cut"),
            );
            body["retryAfterMs"] = json!(5_000);
            return body;
        }
    };
    if answer.get("accepted") != Some(&Value::Bool(true)) {
        EXPORTS.end(&id);
        return failure_body(answer);
    }
    if let (Some(pid), false) = (fields.client_pid, fields.detach) {
        watch_client(app, &id, pid);
    }
    let result = finish_rx.await.unwrap_or_else(|_| interrupted_body());
    let body = if result.get("ok") == Some(&Value::Bool(true)) {
        EXPORTS.set_stage(&id, "hashing");
        if let Ok(Some((path, body))) =
            EXPORTS.progress(&id, &json!({ "stage": "hashing" }), now_ms())
        {
            let _ = write_json_atomic(&path, &body);
        }
        complete(app, &id, &project, &dir, result, started).await
    } else {
        failure_body(result)
    };
    EXPORTS.end(&id);
    body
}

/// A refusal or failure from the editor, with its code kept to the documented set.
pub(crate) fn failure_body(answer: Value) -> Value {
    let mut body = match answer {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    body["ok"] = json!(false);
    if let Some(object) = body.as_object_mut() {
        object.remove("accepted");
    }
    let code = body.get("code").and_then(Value::as_str).unwrap_or("failed");
    if !FAILURE_CODES.contains(&code) {
        body["code"] = json!("failed");
    }
    if body.get("error").and_then(Value::as_str).is_none() {
        body["error"] = json!("the export failed");
    }
    body
}

/// What Rust knows first hand about a finished bridge export.
pub(crate) struct Written<'a> {
    pub output: &'a Path,
    pub bytes: u64,
    pub sha256: &'a str,
    pub flashes: Option<&'a crate::FlashOutcome>,
    pub exports_dir: &'a Path,
    pub elapsed_ms: u64,
}

/// The success answer: the editor's facts plus Rust's own (the file it wrote, its size and hash, the flash tap's report).
pub(crate) fn success_body(result: &Value, project: &str, written: &Written<'_>) -> Value {
    let Written {
        output,
        bytes,
        sha256,
        flashes,
        exports_dir,
        elapsed_ms,
    } = *written;
    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    body.insert("surface".into(), json!("editor"));
    body.insert("project".into(), json!(project));
    if let Some(object) = result.as_object() {
        for key in RESULT_KEYS {
            if let Some(value) = object.get(*key) {
                body.insert((*key).to_owned(), value.clone());
            }
        }
    }
    let mut warnings: Vec<Value> = body
        .get("warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !output.starts_with(exports_dir) {
        warnings.push(json!(format!(
            "the export was written to {}, outside the project's exports/ folder",
            output.display()
        )));
    }
    let report = flashes.and_then(|f| f.report.as_ref());
    if let Some(reason) = flashes.map_or(Some("flash check unavailable"), |f| {
        f.unavailable.as_deref()
    }) {
        warnings.push(json!(reason));
    }
    body.insert("warnings".into(), Value::Array(warnings));
    body.insert("path".into(), json!(output.to_string_lossy()));
    body.insert("bytes".into(), json!(bytes));
    body.insert("sha256".into(), json!(sha256));
    body.insert(
        "flashes".into(),
        report.map_or(Value::Null, |r| {
            serde_json::to_value(r).unwrap_or(Value::Null)
        }),
    );
    body.insert("elapsedMs".into(), json!(elapsed_ms));
    let mismatch = result
        .get("verify")
        .and_then(|v| v.get("identical"))
        .and_then(Value::as_bool)
        == Some(false);
    if mismatch {
        body.insert("ok".into(), json!(false));
        body.insert("code".into(), json!("verifyMismatch"));
        body.insert(
            "error".into(),
            json!("the two renders were not byte-identical, so this export is not deterministic"),
        );
    }
    Value::Object(body)
}

async fn complete(
    app: &AppHandle,
    id: &str,
    project: &str,
    dir: &Path,
    result: Value,
    started: Instant,
) -> Value {
    let Some(output) = EXPORTS.output(id) else {
        return refusal(
            "failed",
            "the editor reported a finished export, but Kookaburra Cut wrote no file for it",
            None,
        );
    };
    let hashed = {
        let output = output.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = std::fs::metadata(&output)
                .map(|m| m.len())
                .map_err(|e| e.to_string())?;
            crate::sha256_file(&output).map(|sha| (bytes, sha))
        })
        .await
    };
    let (bytes, sha) = match hashed {
        Ok(Ok(facts)) => facts,
        Ok(Err(e)) => {
            return refusal(
                "failed",
                &format!("couldn't hash {}: {e}", output.display()),
                None,
            )
        }
        Err(e) => return refusal("failed", &format!("couldn't hash the export: {e}"), None),
    };
    let flashes = app
        .state::<FlashState>()
        .latest()
        .filter(|f| Path::new(&f.path) == output);
    let exports_dir = dir.join("exports");
    let written = Written {
        output: &output,
        bytes,
        sha256: &sha,
        flashes: flashes.as_ref(),
        exports_dir: &exports_dir,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    success_body(&result, project, &written)
}

/// The editor's answer to the export event.
#[tauri::command]
pub fn bridge_export_accept(
    window: tauri::Window,
    id: String,
    answer: Value,
) -> Result<bool, String> {
    main_window_only(&window)?;
    EXPORTS.accept(&id, answer)
}

/// One progress report from the editor (fps and ETA are computed there, from the export callbacks).
#[tauri::command]
pub fn bridge_export_progress(
    window: tauri::Window,
    id: String,
    progress: Value,
) -> Result<(), String> {
    main_window_only(&window)?;
    if let Some((path, body)) = EXPORTS.progress(&id, &progress, now_ms())? {
        write_json_atomic(&path, &body)?;
    }
    Ok(())
}

/// The editor's finished answer; Rust hashes the file it recorded and writes the response.
#[tauri::command]
pub fn bridge_export_finish(
    window: tauri::Window,
    id: String,
    result: Value,
) -> Result<(), String> {
    main_window_only(&window)?;
    EXPORTS.finish(&id, result)
}

/// Called by the main window on mount: an export left in the slot by a reload fails instead of hanging.
#[tauri::command]
pub fn bridge_export_reset(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    main_window_only(&window)?;
    Ok(EXPORTS.reset().map(|(id, running)| {
        if running {
            let _ = app.state::<ExportState>().cancel();
        }
        log::warn!("[bridge] the editor reloaded during export {id}; it failed");
        id
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(project: &str) -> BridgeRequest {
        bridge::parse_request(&format!(
            r#"{{"version":2,"id":"0001-1-a","kind":"export","project":"{project}"}}"#
        ))
        .unwrap()
    }

    fn context(project: Option<&str>) -> EditorContext {
        EditorContext {
            project_id: project.map(str::to_owned),
            aspect: "16:9".into(),
            current_ms: 0.0,
            export_locked: false,
            playing: false,
        }
    }

    fn code(body: &Value) -> &str {
        body["code"].as_str().unwrap_or("")
    }

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("kc-bridge-export-{}", std::process::id()))
    }

    #[test]
    fn validation_takes_workspace_projects_and_well_formed_fields() {
        let ok = ExportFields {
            aspect: Some("phone-landscape".into()),
            preset: Some("ws:my-preset".into()),
            fps: Some(30),
            short_edge: Some(1080),
            sources: Some(BTreeMap::from([
                ("project.json".to_owned(), "a".repeat(64)),
                ("scenes/01-a.tsx".to_owned(), "0".repeat(64)),
            ])),
            ..ExportFields::default()
        };
        assert_eq!(validate(&request("ws:demo"), &ok).unwrap(), "demo");
        let bad = |fields: ExportFields| {
            code(&validate(&request("ws:demo"), &fields).unwrap_err()).to_owned()
        };
        assert_eq!(
            code(&validate(&request("showcase-tour"), &ok).unwrap_err()),
            "invalid"
        );
        assert_eq!(
            bad(ExportFields {
                aspect: Some("16/9".into()),
                ..ok.clone()
            }),
            "invalid"
        );
        assert_eq!(
            bad(ExportFields {
                preset: Some("../x".into()),
                ..ok.clone()
            }),
            "invalid"
        );
        assert_eq!(
            bad(ExportFields {
                fps: Some(24),
                ..ok.clone()
            }),
            "invalid"
        );
        assert_eq!(
            bad(ExportFields {
                short_edge: Some(0),
                ..ok.clone()
            }),
            "invalid"
        );
        let sources = BTreeMap::from([("assets/x.png".to_owned(), "a".repeat(64))]);
        assert_eq!(
            bad(ExportFields {
                sources: Some(sources),
                ..ok.clone()
            }),
            "invalid"
        );
        let sources = BTreeMap::from([("scenes/a/b.tsx".to_owned(), "a".repeat(64))]);
        assert_eq!(
            bad(ExportFields {
                sources: Some(sources),
                ..ok.clone()
            }),
            "invalid"
        );
        let sources = BTreeMap::from([("project.json".to_owned(), "ABC".into())]);
        assert_eq!(
            bad(ExportFields {
                sources: Some(sources),
                ..ok
            }),
            "invalid"
        );
    }

    #[test]
    fn the_request_fields_parse_from_the_claimed_file() {
        let fields: ExportFields = serde_json::from_str(
            r#"{"id":"x","kind":"export","aspect":"9:16","preset":"tiktok","fps":null,"shortEdge":720,"posterFrame":false,"verify":true,"clientPid":4242,"detach":false,"sources":{"project.json":"aa"},"unknown":1}"#,
        )
        .unwrap();
        assert_eq!(fields.aspect.as_deref(), Some("9:16"));
        assert_eq!(fields.short_edge, Some(720));
        assert_eq!(fields.poster_frame, Some(false));
        assert!(fields.verify);
        assert_eq!(fields.client_pid, Some(4242));
        assert_eq!(fields.fps, None);
    }

    #[test]
    fn only_the_open_project_exports() {
        assert!(open_project_refusal(Some(&context(Some("ws:demo"))), "ws:demo").is_none());
        let welcome = open_project_refusal(Some(&context(None)), "ws:demo").unwrap();
        assert_eq!(code(&welcome), "notOpen");
        assert!(welcome["hint"]
            .as_str()
            .unwrap()
            .contains("open this project"));
        assert_eq!(
            code(&open_project_refusal(None, "ws:demo").unwrap()),
            "notOpen"
        );
        let other = open_project_refusal(Some(&context(Some("ws:other"))), "ws:demo").unwrap();
        assert_eq!(code(&other), "wrongProject");
        assert!(other["error"].as_str().unwrap().contains("ws:other"));
    }

    #[test]
    fn one_slot_at_a_time_and_busy_names_the_holder() {
        let exports = Exports::new();
        let _channels = exports.begin("a", "ws:demo", &root()).unwrap();
        assert_eq!(exports.begin("b", "ws:demo", &root()).unwrap_err(), "a");
        exports.end("a");
        assert!(exports.begin("b", "ws:demo", &root()).is_ok());
        let busy = busy_body("x");
        assert_eq!(busy["busy"], true);
        assert_eq!(code(&busy), "busy");
    }

    #[test]
    fn accept_runs_the_export_and_a_refusal_comes_back_whole() {
        let exports = Exports::new();
        let (mut accept, _finish) = exports.begin("a", "ws:demo", &root()).unwrap();
        assert!(exports.accept("other", json!({"accepted": true})).is_err());
        assert!(exports.accept("a", json!({"accepted": true})).unwrap());
        assert_eq!(accept.try_recv().unwrap()["accepted"], true);
        assert!(
            exports.accept("a", json!({"accepted": true})).is_err(),
            "answered once"
        );
        exports.end("a");

        let (mut accept, _finish) = exports.begin("b", "ws:demo", &root()).unwrap();
        let refusal = json!({"accepted": false, "code": "editing", "busy": true, "error": "a field is focused"});
        assert!(!exports.accept("b", refusal).unwrap());
        let answer = failure_body(accept.try_recv().unwrap());
        assert_eq!(code(&answer), "editing");
        assert_eq!(answer["busy"], true);
        assert_eq!(answer["ok"], false);
        assert!(answer.get("accepted").is_none());
    }

    #[test]
    fn an_accept_after_the_window_closed_is_refused() {
        let exports = Exports::new();
        let (accept, _finish) = exports.begin("a", "ws:demo", &root()).unwrap();
        assert!(exports.expire("a"));
        assert!(exports.accept("a", json!({"accepted": true})).is_err());
        drop(accept);

        let (accept, _finish) = exports.begin("b", "ws:demo", &root()).unwrap();
        drop(accept);
        assert!(
            exports.accept("b", json!({"accepted": true})).is_err(),
            "the serve task gave up"
        );
        assert!(!exports.is_current("b"));
        assert!(!exports.expire("b"));
    }

    #[test]
    fn reset_fails_the_slot_whichever_side_waits() {
        let exports = Exports::new();
        let (mut accept, _finish) = exports.begin("a", "ws:demo", &root()).unwrap();
        assert_eq!(exports.reset(), Some(("a".to_owned(), false)));
        assert_eq!(code(&accept.try_recv().unwrap()), "interrupted");
        assert!(exports.reset().is_none());

        let (_accept, mut finish) = exports.begin("b", "ws:demo", &root()).unwrap();
        exports.accept("b", json!({"accepted": true})).unwrap();
        assert_eq!(exports.reset(), Some(("b".to_owned(), true)));
        assert_eq!(code(&finish.try_recv().unwrap()), "interrupted");
        assert!(
            exports.begin("c", "ws:demo", &root()).is_ok(),
            "the slot is free again"
        );
    }

    #[test]
    fn cancel_answers_at_once_before_accept_and_asks_the_editor_after() {
        let exports = Exports::new();
        assert_eq!(exports.cancel(None, "client"), CancelOutcome::Idle);
        let (mut accept, _finish) = exports.begin("a", "ws:demo", &root()).unwrap();
        assert_eq!(exports.cancel(Some("zzz"), "client"), CancelOutcome::Idle);
        assert_eq!(
            exports.cancel(Some("a"), "client"),
            CancelOutcome::Cancelled("a".into())
        );
        let answer = accept.try_recv().unwrap();
        assert_eq!(code(&answer), "cancelled");
        assert!(!exports.is_current("a"));

        let (_accept, mut finish) = exports.begin("b", "ws:demo", &root()).unwrap();
        exports.accept("b", json!({"accepted": true})).unwrap();
        assert_eq!(
            exports.cancel(None, "client-exit"),
            CancelOutcome::Cancelling {
                id: "b".into(),
                first: true
            }
        );
        assert_eq!(
            exports.cancel(Some("b"), "client"),
            CancelOutcome::Cancelling {
                id: "b".into(),
                first: false
            }
        );
        assert!(
            exports.is_current("b"),
            "the editor answers for a running export"
        );
        assert!(exports.fail("b", cancelled_body("client-exit")));
        let answer = finish.try_recv().unwrap();
        assert_eq!(code(&answer), "cancelled");
        assert_eq!(answer["by"], "client-exit");
    }

    #[test]
    fn progress_writes_once_a_second_plus_every_stage_change() {
        let exports = Exports::new();
        let base = root();
        let (_a, _f) = exports.begin("a", "ws:demo", &base).unwrap();
        exports.accept("a", json!({"accepted": true})).unwrap();
        let report = |stage: &str, frame: u64| json!({"stage": stage, "frame": frame, "total": 100, "percent": frame, "bogus": 1});
        let (path, body) = exports
            .progress("a", &report("syncing", 0), 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(path, base.join("responses").join("a.progress.json"));
        assert_eq!(body["version"], 2);
        assert_eq!(body["id"], "a");
        assert_eq!(body["project"], "ws:demo");
        assert_eq!(body["updatedAtMs"], 1_000);
        assert!(body.get("bogus").is_none());
        let (_, body) = exports
            .progress("a", &report("render", 1), 1_100)
            .unwrap()
            .unwrap();
        assert_eq!(body["stage"], "render", "a stage change writes at once");
        assert!(exports
            .progress("a", &report("render", 2), 1_500)
            .unwrap()
            .is_none());
        assert!(exports
            .progress("a", &report("render", 3), 2_099)
            .unwrap()
            .is_none());
        let (_, body) = exports
            .progress("a", &report("render", 4), 2_100)
            .unwrap()
            .unwrap();
        assert_eq!(body["frame"], 4);
        let (_, body) = exports
            .progress("a", &report("warp", 5), 2_200)
            .unwrap()
            .unwrap_or_default();
        assert_eq!(
            body,
            Value::Null,
            "an unknown stage keeps the last one and the throttle"
        );
        assert!(exports.progress("b", &report("render", 1), 9_000).is_err());
        assert_eq!(exports.job().unwrap()["frame"], 5);
    }

    #[test]
    fn the_heartbeat_job_names_the_bridge_export_then_the_button() {
        let exports = Exports::new();
        assert!(exports.job().is_none());
        exports.set_native(Some(("render", 10, 300)));
        assert_eq!(
            exports.job().unwrap(),
            json!({"id": null, "origin": "button", "stage": "render", "frame": 10, "total": 300})
        );
        let (_a, _f) = exports.begin("a", "ws:demo", &root()).unwrap();
        assert_eq!(exports.job().unwrap()["origin"], "bridge");
        assert_eq!(exports.job().unwrap()["id"], "a");
        exports.end("a");
        exports.set_native(None);
        assert!(exports.job().is_none());
    }

    #[test]
    fn the_output_is_the_file_rust_finished_for_the_running_export() {
        let exports = Exports::new();
        exports.note_output(Path::new("/tmp/stray.mp4"));
        let (_a, _f) = exports.begin("a", "ws:demo", &root()).unwrap();
        exports.note_output(Path::new("/tmp/early.mp4"));
        assert_eq!(exports.output("a"), None, "not before the editor took it");
        exports.accept("a", json!({"accepted": true})).unwrap();
        exports.note_output(Path::new("/x/exports/demo-16x9.mp4"));
        assert_eq!(
            exports.output("a"),
            Some(PathBuf::from("/x/exports/demo-16x9.mp4"))
        );
    }

    #[test]
    fn failures_keep_documented_codes_only() {
        assert_eq!(
            code(&failure_body(json!({"code": "gpuStalled", "error": "x"}))),
            "gpuStalled"
        );
        assert_eq!(code(&failure_body(json!({"code": "whatever"}))), "failed");
        assert_eq!(
            failure_body(json!("nonsense"))["error"],
            "the export failed"
        );
    }

    #[test]
    fn success_carries_rust_facts_over_the_editor_claims() {
        let result = json!({
            "ok": true, "path": "/elsewhere/claimed.mp4", "sha256": "forged", "lane": "spec", "codec": "libx264",
            "fps": 60, "width": 3840, "height": 2160, "posterFrame": true, "frames": 3901, "durationMs": 65016.67,
            "totalMs": 65000, "timeline": [], "verify": null, "warnings": ["w"], "aspect": "16:9", "preset": "kookaburra-standard",
        });
        fn written<'a>(output: &'a str, flashes: Option<&'a crate::FlashOutcome>) -> Written<'a> {
            Written {
                output: Path::new(output),
                bytes: 1234,
                sha256: "ab",
                flashes,
                exports_dir: Path::new("/x/exports"),
                elapsed_ms: 42,
            }
        }
        let outcome = crate::FlashOutcome {
            path: "/x/exports/demo-16x9.mp4".into(),
            report: None,
            unavailable: None,
        };
        let body = success_body(
            &result,
            "ws:demo",
            &written("/x/exports/demo-16x9.mp4", Some(&outcome)),
        );
        assert_eq!(body["ok"], true);
        assert_eq!(body["path"], "/x/exports/demo-16x9.mp4");
        assert_eq!(body["sha256"], "ab");
        assert_eq!(body["bytes"], 1234);
        assert_eq!(body["surface"], "editor");
        assert_eq!(body["elapsedMs"], 42);
        assert_eq!(body["flashes"], Value::Null);
        assert_eq!(body["warnings"], json!(["w"]));
        let outside = success_body(&result, "ws:demo", &written("/y/a.mp4", None));
        let warnings = outside["warnings"].as_array().unwrap();
        assert!(warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("outside")));
        assert!(warnings.iter().any(|w| w == "flash check unavailable"));
        let mismatch = success_body(
            &json!({"ok": true, "verify": {"identical": false, "hashA": "a", "hashB": "b"}}),
            "ws:demo",
            &written("/x/exports/demo-16x9.mp4", Some(&outcome)),
        );
        assert_eq!(mismatch["ok"], false);
        assert_eq!(code(&mismatch), "verifyMismatch");
        assert_eq!(mismatch["sha256"], "ab");
    }
}
