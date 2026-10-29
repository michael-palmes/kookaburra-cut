//! The capture service behind the hidden render window (docs/agent-kit.md, "The capture service"): what a request costs, the fair order the render window claims in, throttling, the GPU stall recycle state machine and its watchdog, response retention, and the `health` block of the serving heartbeat. The pure parts take their state explicitly and are tested below; the app glue reads one process-wide `SERVICE`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge::{self, BridgeRequest, RESPONSE_CAP_BYTES, RESPONSE_TTL_MS};

/// What kb may rely on from this build (`health.captureFeatures`).
pub const CAPTURE_FEATURES: &[&str] = &[
    "scale", "width", "probe", "client", "deadline", "recycle", "debug",
];
const HEALTH_VERSION: u32 = 1;
/// One unit is a 1280x720 frame's pixels; a 4K frame is 9.
pub(crate) const UNIT_PIXELS: u64 = 921_600;
/// A capture costing more is answered `tooLarge` (16 4K frames).
pub(crate) const MAX_REQUEST_UNITS: u32 = 144;
pub(crate) const CLIENT_UNITS_PER_MIN: u32 = 240;
pub(crate) const CLIENT_MAX_PENDING: usize = 4;
const USAGE_WINDOW_MS: u64 = 60_000;
const SAMPLE_CAP: usize = 32;
/// Sheets and multi-frame captures default to this long edge.
pub(crate) const SHEET_LONG_EDGE: u32 = 1280;
pub(crate) const MIN_CAPTURE_EDGE: u32 = 64;
/// WebKit's live WebGL contexts per WebContent process.
pub(crate) const WEBGL_CAP: u32 = 16;
const RECYCLE_WINDOW_MS: u64 = 600_000;
/// Backoff before the next render window, by how many recycles the last 10 minutes held.
const BACKOFF_MS: [u64; 3] = [0, 15_000, 60_000];
/// A request in flight with no render beat for this long is hung; a beaten window this quiet while requests wait is silent.
pub(crate) const HUNG_AFTER_MS: u64 = 45_000;
/// A new render window that has not beaten this long after its create is silent (dev allows a cold Vite load).
pub(crate) const FIRST_BEAT_WITHIN_MS: u64 = if cfg!(debug_assertions) {
    90_000
} else {
    30_000
};
/// A watchdog tick this long after the last one (the Mac slept, or the process was suspended) restarts the silence clocks.
const WATCH_GAP_MS: u64 = 20_000;
/// The page gets this long to write its own stall answer before the window goes.
const DESTROY_DELAY: Duration = Duration::from_millis(200);
const MIN_RETRY_AFTER_MS: u64 = 2_000;
const DEFAULT_UNIT_MS: f64 = 400.0;
const DEFAULT_OVERHEAD_MS: f64 = 1_000.0;
/// Nothing this fresh is pruned (a capture still writing its frames).
pub(crate) const RESPONSE_MIN_AGE_MS: u64 = 120_000;
const PRUNE_EVERY_MS: u64 = 60_000;
pub(crate) const STALL_HINT: &str = "The app's GPU stalled during this capture; Kookaburra Cut recycled its hidden render window, so the next capture starts fresh (kb retries once). Prefer the default sheet size or --scale 0.5 and fewer frames. If kb status shows GPU wedged, ask the user to quit and reopen Kookaburra Cut.";
pub(crate) const WEDGED_HINT: &str = "The GPU stalled 3 times in 10 minutes, so Kookaburra Cut stopped restarting its render window. Ask the user to quit and reopen Kookaburra Cut, or to press Retry captures in the editor.";
const THROTTLE_HINT: &str = "capture fewer or smaller frames (--scale 0.5)";
const TOO_LARGE_HINT: &str = "drop --scale/--width, use the default sheet size";

/// Mirror of `FORMATS` in src/engine/format.ts (a vitest pins the two together).
pub(crate) const CAPTURE_FORMATS: &[(&str, u32, u32)] = &[
    ("16:9", 3840, 2160),
    ("9:16", 2160, 3840),
    ("1:1", 2160, 2160),
    ("4:5", 2160, 2700),
    ("5:4", 2700, 2160),
    ("3:2", 3240, 2160),
    ("2:3", 2160, 3240),
    ("phone", 1206, 2622),
    ("phone-landscape", 2622, 1206),
];

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Cost ───────────────────────────────────────────────────────────────────

/// An aspect's export size; an unknown or missing aspect costs as 16:9.
pub(crate) fn native_size(aspect: Option<&str>) -> (u32, u32) {
    let (_, w, h) = CAPTURE_FORMATS
        .iter()
        .find(|(name, _, _)| Some(*name) == aspect)
        .unwrap_or(&CAPTURE_FORMATS[0]);
    (*w, *h)
}

fn even(x: f64) -> f64 {
    (x / 2.0).round() * 2.0
}

/// Mirror of `captureFormat` in src/render/bridgeRequests.ts: a literal width, else a scale, else the 1280 long edge for sheets and multi-frame captures, else native; never upscaled, even, at least 64 on the short edge.
pub(crate) fn capture_size(
    native: (u32, u32),
    width: Option<f64>,
    scale: Option<f64>,
    multi: bool,
) -> (u32, u32) {
    let (fw, fh) = (f64::from(native.0), f64::from(native.1));
    let long = fw.max(fh);
    let (mut w, mut h) = if let Some(width) = width.filter(|w| w.is_finite() && *w > 0.0) {
        if width >= fw {
            return native;
        }
        let w = even(width);
        (w, even(w * fh / fw))
    } else {
        let target = match scale.filter(|s| s.is_finite() && *s > 0.0) {
            Some(scale) => long * scale,
            None if multi => f64::from(SHEET_LONG_EDGE),
            None => long,
        };
        if target >= long {
            return native;
        }
        if fw >= fh {
            let w = even(target);
            (w, even(w * fh / fw))
        } else {
            let h = even(target);
            (even(h * fw / fh), h)
        }
    };
    let min = f64::from(MIN_CAPTURE_EDGE);
    if w.min(h) < min {
        if fw <= fh {
            w = min;
            h = even(min * fh / fw);
        } else {
            h = min;
            w = even(min * fw / fh);
        }
    }
    (w as u32, h as u32)
}

pub(crate) fn units_for(frames: u32, width: u32, height: u32) -> u32 {
    let px = u64::from(width) * u64::from(height);
    frames.saturating_mul(px.div_ceil(UNIT_PIXELS).max(1) as u32)
}

/// What one pending request costs and who sent it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RequestPeek {
    pub id: String,
    pub kind: String,
    pub op: Option<String>,
    pub client: String,
    pub frames: u32,
    pub units: u32,
    pub deadline_at_ms: Option<u64>,
    /// `retryOf` keeps the original's place in the queue.
    pub order_key: String,
}

/// Captures cost their frames' pixels at the size they will render (the editor's aspect when the request names none); every other kind costs one unit.
pub(crate) fn peek(request: &BridgeRequest, editor_aspect: Option<&str>) -> RequestPeek {
    let kind = request.kind.clone().unwrap_or_else(|| "capture".into());
    let capture = kind == "capture";
    let frames = if capture {
        request.frames.as_ref().map_or(1, |f| f.len().max(1)) as u32
    } else {
        1
    };
    let units = if capture {
        let native = native_size(request.aspect.as_deref().or(editor_aspect));
        let sized = request.width.is_some() || request.scale.is_some();
        let probe = request.probe.as_ref().is_some_and(|p| !p.is_null());
        let multi = (request.sheet == Some(true) || frames > 1) && (sized || !probe);
        let (w, h) = capture_size(native, request.width, request.scale, multi);
        units_for(frames, w, h)
    } else {
        1
    };
    RequestPeek {
        id: request.id.clone(),
        kind,
        op: request.op.clone(),
        client: client_of(request),
        frames,
        units,
        deadline_at_ms: request.deadline_at_ms,
        order_key: request
            .retry_of
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| request.id.clone()),
    }
}

/// A request without a `client` buckets as `anon`.
pub(crate) fn client_of(request: &BridgeRequest) -> String {
    request
        .client
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("anon")
        .to_owned()
}

// ── Usage, durations and the queue ─────────────────────────────────────────

#[derive(Debug, Clone)]
struct UsageEntry {
    at_ms: u64,
    client: String,
    units: u32,
    id: String,
}

/// Units each client was served in the last minute, recorded at claim.
#[derive(Debug, Clone, Default)]
pub(crate) struct Usage {
    entries: VecDeque<UsageEntry>,
}

impl Usage {
    pub(crate) const fn new() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }

    pub(crate) fn record(&mut self, now: u64, client: &str, units: u32, id: &str) {
        self.expire(now);
        self.entries.push_back(UsageEntry {
            at_ms: now,
            client: client.to_owned(),
            units,
            id: id.to_owned(),
        });
    }

    /// A stalled request gives its units back: its retry pays again.
    pub(crate) fn refund(&mut self, id: &str) {
        self.entries.retain(|e| e.id != id);
    }

    fn expire(&mut self, now: u64) {
        while self
            .entries
            .front()
            .is_some_and(|e| e.at_ms + USAGE_WINDOW_MS <= now)
        {
            self.entries.pop_front();
        }
    }

    fn live(&self, now: u64) -> impl Iterator<Item = &UsageEntry> {
        self.entries
            .iter()
            .filter(move |e| e.at_ms + USAGE_WINDOW_MS > now)
    }

    pub(crate) fn units(&self, client: &str, now: u64) -> u32 {
        self.live(now)
            .filter(|e| e.client == client)
            .map(|e| e.units)
            .sum()
    }

    fn clients(&self, now: u64) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for e in self.live(now) {
            if !out.contains(&e.client) {
                out.push(e.client.clone());
            }
        }
        out
    }

    /// How long until `over` of this client's units age out of the window.
    fn retry_after(&self, client: &str, now: u64, over: u32) -> Option<u64> {
        let mut freed = 0u32;
        for e in self.live(now).filter(|e| e.client == client) {
            freed += e.units;
            if freed >= over {
                return Some((e.at_ms + USAGE_WINDOW_MS).saturating_sub(now));
            }
        }
        None
    }
}

/// The last 32 capture durations (claim to answer) against their units.
#[derive(Debug, Clone, Default)]
pub(crate) struct Durations {
    samples: VecDeque<(u32, u64)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Estimate {
    pub unit_ms: f64,
    pub overhead_ms: f64,
    pub samples: usize,
}

impl Estimate {
    pub(crate) fn cost(&self, units: u32) -> f64 {
        self.overhead_ms + f64::from(units) * self.unit_ms
    }
}

impl Durations {
    pub(crate) const fn new() -> Self {
        Self {
            samples: VecDeque::new(),
        }
    }

    pub(crate) fn record(&mut self, units: u32, ms: u64) {
        if self.samples.len() >= SAMPLE_CAP {
            self.samples.pop_front();
        }
        self.samples.push_back((units.max(1), ms));
    }

    /// A least-squares fit of ms = overhead + units x unitMs, clamped; with one size of request only, half the mean (at most a second) is overhead.
    pub(crate) fn estimate(&self) -> Estimate {
        let n = self.samples.len();
        if n == 0 {
            return Estimate {
                unit_ms: DEFAULT_UNIT_MS,
                overhead_ms: DEFAULT_OVERHEAD_MS,
                samples: 0,
            };
        }
        let mu = self.samples.iter().map(|s| f64::from(s.0)).sum::<f64>() / n as f64;
        let mm = self.samples.iter().map(|s| s.1 as f64).sum::<f64>() / n as f64;
        let var: f64 = self
            .samples
            .iter()
            .map(|s| (f64::from(s.0) - mu).powi(2))
            .sum();
        if var > 0.0 {
            let cov: f64 = self
                .samples
                .iter()
                .map(|s| (f64::from(s.0) - mu) * (s.1 as f64 - mm))
                .sum();
            let slope = cov / var;
            let intercept = mm - slope * mu;
            if slope >= 20.0 && intercept >= 0.0 {
                return Estimate {
                    unit_ms: slope.min(60_000.0),
                    overhead_ms: intercept.min(60_000.0),
                    samples: n,
                };
            }
        }
        let overhead = DEFAULT_OVERHEAD_MS.min(mm / 2.0);
        Estimate {
            unit_ms: ((mm - overhead) / mu).max(20.0),
            overhead_ms: overhead,
            samples: n,
        }
    }
}

/// What the queue does with one pending request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Verdict {
    Serve,
    TooLarge,
    Throttled { retry_after_ms: u64, why: String },
    Wedged,
}

fn throttled_kind(kind: &str) -> bool {
    matches!(kind, "capture" | "check")
}

/// One verdict per peek (given oldest first): wedged answers everything; a capture over 144 units is too large; a client's fifth pending capture or check, or one that would take it past 240 units a minute (counting what it already queued), is throttled.
pub(crate) fn verdicts(
    peeks: &[RequestPeek],
    usage: &Usage,
    estimate: &Estimate,
    now: u64,
    wedged: bool,
) -> Vec<Verdict> {
    let mut queued: Vec<(String, usize, u32, u32)> = Vec::new();
    peeks
        .iter()
        .map(|p| {
            if wedged {
                return Verdict::Wedged;
            }
            if p.kind == "capture" && p.units > MAX_REQUEST_UNITS {
                return Verdict::TooLarge;
            }
            if !throttled_kind(&p.kind) {
                return Verdict::Serve;
            }
            let slot = match queued.iter().position(|q| q.0 == p.client) {
                Some(i) => i,
                None => {
                    queued.push((p.client.clone(), 0, 0, p.units));
                    queued.len() - 1
                }
            };
            let (_, count, ahead, first) = queued[slot].clone();
            if count >= CLIENT_MAX_PENDING {
                return Verdict::Throttled {
                    retry_after_ms: (estimate.cost(first) as u64).max(MIN_RETRY_AFTER_MS),
                    why: format!(
                        "{} already has {CLIENT_MAX_PENDING} requests waiting (at most {CLIENT_MAX_PENDING})",
                        p.client
                    ),
                };
            }
            let used = usage.units(&p.client, now) + ahead + p.units;
            if used > CLIENT_UNITS_PER_MIN {
                let wait = usage
                    .retry_after(&p.client, now, used - CLIENT_UNITS_PER_MIN)
                    .unwrap_or_else(|| estimate.cost(ahead) as u64);
                return Verdict::Throttled {
                    retry_after_ms: wait.max(MIN_RETRY_AFTER_MS),
                    why: format!(
                        "{} would use {used} capture units in a minute (at most {CLIENT_UNITS_PER_MIN})",
                        p.client
                    ),
                };
            }
            queued[slot].1 += 1;
            queued[slot].2 += p.units;
            Verdict::Serve
        })
        .collect()
}

/// The order the render window serves `peeks` in: work-conserving, the client with the fewest units served in the last minute first (each pick counts against it), then its oldest (`retryOf` keeps its place), ties by the oldest id.
pub(crate) fn fair_order(peeks: &[RequestPeek], usage: &Usage, now: u64) -> Vec<usize> {
    let mut served: Vec<(String, u32)> = Vec::new();
    let used = |client: &str, served: &mut Vec<(String, u32)>| -> u32 {
        match served.iter().find(|s| s.0 == client) {
            Some(s) => s.1,
            None => {
                let units = usage.units(client, now);
                served.push((client.to_owned(), units));
                units
            }
        }
    };
    let mut left: Vec<usize> = (0..peeks.len()).collect();
    let mut order = Vec::with_capacity(peeks.len());
    while !left.is_empty() {
        let mut best = 0;
        for i in 1..left.len() {
            let (a, b) = (&peeks[left[i]], &peeks[left[best]]);
            let key_a = (used(&a.client, &mut served), &a.order_key, &a.id);
            let key_b = (used(&b.client, &mut served), &b.order_key, &b.id);
            if key_a < key_b {
                best = i;
            }
        }
        let pick = left.remove(best);
        let p = &peeks[pick];
        used(&p.client, &mut served);
        if let Some(s) = served.iter_mut().find(|s| s.0 == p.client) {
            s.1 += p.units;
        }
        order.push(pick);
    }
    order
}

/// Estimated ms until each request in `order` is answered: what is left of the one in flight, any stall backoff, then each request's overhead and units.
pub(crate) fn queue_eta(
    order: &[usize],
    peeks: &[RequestPeek],
    estimate: &Estimate,
    in_flight_left_units: f64,
    blocked_ms: u64,
) -> Vec<u64> {
    let mut at = in_flight_left_units * estimate.unit_ms + blocked_ms as f64;
    order
        .iter()
        .map(|&i| {
            at += estimate.cost(peeks[i].units);
            at.round() as u64
        })
        .collect()
}

// ── Stalls ─────────────────────────────────────────────────────────────────

/// What one stall did: whether the window is recycled, how long kb should wait, and whether the GPU is now wedged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct StallOutcome {
    pub recycled: bool,
    pub retry_after_ms: Option<u64>,
    pub wedged: bool,
    pub stalled_until_ms: Option<u64>,
}

/// The recycle backoff: 0, 15 and 60 s for the 1st, 2nd and 3rd recycle within 10 minutes; a stall after that is wedged (no new window) until 10 quiet minutes pass or the editor resets it. A debug recycle never counts.
#[derive(Debug, Clone, Default)]
pub(crate) struct RecycleState {
    recent: VecDeque<u64>,
    stalled_until_ms: Option<u64>,
    wedged_at_ms: Option<u64>,
    last_stall_ms: Option<u64>,
    total: u32,
    last: Option<(u64, String)>,
}

impl RecycleState {
    pub(crate) const fn new() -> Self {
        Self {
            recent: VecDeque::new(),
            stalled_until_ms: None,
            wedged_at_ms: None,
            last_stall_ms: None,
            total: 0,
            last: None,
        }
    }

    fn expire(&mut self, now: u64) {
        while self
            .recent
            .front()
            .is_some_and(|at| at + RECYCLE_WINDOW_MS <= now)
        {
            self.recent.pop_front();
        }
        if self.wedged_at_ms.is_some()
            && self
                .last_stall_ms
                .map_or(true, |at| at + RECYCLE_WINDOW_MS <= now)
        {
            self.wedged_at_ms = None;
            self.recent.clear();
        }
        if self.stalled_until_ms.is_some_and(|until| until <= now) {
            self.stalled_until_ms = None;
        }
    }

    pub(crate) fn stall(&mut self, now: u64, reason: &str, counts: bool) -> StallOutcome {
        self.expire(now);
        if self.wedged_at_ms.is_some() {
            self.last_stall_ms = Some(now);
            return self.outcome(false);
        }
        if !counts {
            self.total += 1;
            self.last = Some((now, reason.to_owned()));
            return StallOutcome {
                recycled: true,
                retry_after_ms: Some(0),
                wedged: false,
                stalled_until_ms: self.stalled_until_ms,
            };
        }
        self.last_stall_ms = Some(now);
        if self.recent.len() >= BACKOFF_MS.len() {
            self.wedged_at_ms = Some(now);
            self.stalled_until_ms = None;
            return self.outcome(false);
        }
        let backoff = BACKOFF_MS[self.recent.len()];
        self.recent.push_back(now);
        self.total += 1;
        self.last = Some((now, reason.to_owned()));
        self.stalled_until_ms = (backoff > 0).then_some(now + backoff);
        StallOutcome {
            recycled: true,
            retry_after_ms: Some(backoff),
            wedged: false,
            stalled_until_ms: self.stalled_until_ms,
        }
    }

    fn outcome(&self, recycled: bool) -> StallOutcome {
        StallOutcome {
            recycled,
            retry_after_ms: None,
            wedged: self.wedged_at_ms.is_some(),
            stalled_until_ms: self.stalled_until_ms,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.recent.clear();
        self.stalled_until_ms = None;
        self.wedged_at_ms = None;
    }

    pub(crate) fn wedged(&mut self, now: u64) -> bool {
        self.expire(now);
        self.wedged_at_ms.is_some()
    }

    /// While wedged or backing off, `ensure_render_window` creates nothing.
    pub(crate) fn window_blocked(&mut self, now: u64) -> bool {
        self.expire(now);
        self.wedged_at_ms.is_some() || self.stalled_until_ms.is_some_and(|until| now < until)
    }

    fn gpu_json(&mut self, now: u64, editor_lost_at_ms: Option<u64>) -> Value {
        self.expire(now);
        json!({
            "stalled": self.stalled_until_ms.is_some_and(|until| now < until),
            "stalledUntilMs": self.stalled_until_ms,
            "wedged": self.wedged_at_ms.is_some(),
            "stallsLast10Min": self.recent.len(),
            "editorLostAtMs": editor_lost_at_ms,
        })
    }

    fn last_json(&self) -> Value {
        self.last.as_ref().map_or(
            Value::Null,
            |(at, reason)| json!({ "atMs": at, "reason": reason }),
        )
    }
}

/// The render window this process has: its generation (one per create), beats and reloads.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowTrack {
    generation: u64,
    created_at_ms: Option<u64>,
    last_seq: Option<u64>,
    created_since_beat: bool,
    last_beat_ms: Option<u64>,
    gl_ms: Option<f64>,
    loaded_project: Option<String>,
    content_reloads: u32,
    web_content_pid: Option<u32>,
    recycled_generation: Option<u64>,
    /// A window created after the last recycle has beaten.
    recovered: bool,
    last_outcome: Option<StallOutcome>,
}

impl WindowTrack {
    pub(crate) const fn new() -> Self {
        Self {
            generation: 0,
            created_at_ms: None,
            last_seq: None,
            created_since_beat: false,
            last_beat_ms: None,
            gl_ms: None,
            loaded_project: None,
            content_reloads: 0,
            web_content_pid: None,
            recycled_generation: None,
            recovered: false,
            last_outcome: None,
        }
    }

    pub(crate) fn created(&mut self, now: u64) {
        self.generation += 1;
        self.created_at_ms = Some(now);
        self.last_seq = None;
        self.created_since_beat = true;
        self.last_beat_ms = None;
        self.gl_ms = None;
        self.loaded_project = None;
        self.web_content_pid = None;
    }

    /// Records a beat; true when its `seq` dropped with no create in between (wry reloaded the page after a WebContent kill).
    pub(crate) fn beat(&mut self, seq: u64, gl_ms: f64, now: u64) -> bool {
        let reloaded = !self.created_since_beat && self.last_seq.is_some_and(|last| seq < last);
        if reloaded {
            self.content_reloads += 1;
            self.web_content_pid = None;
        }
        if self
            .recycled_generation
            .is_some_and(|g| self.generation > g)
        {
            self.recovered = true;
        }
        self.last_seq = Some(seq);
        self.created_since_beat = false;
        self.last_beat_ms = Some(now);
        self.gl_ms = Some(gl_ms);
        reloaded
    }

    /// A recycle happened and no window made since has beaten (kb's "restarting its render window" line).
    pub(crate) fn restarting(&self) -> bool {
        self.recycled_generation.is_some() && !self.recovered
    }

    fn recycled(&mut self, outcome: StallOutcome) {
        self.recycled_generation = Some(self.generation);
        self.recovered = false;
        self.last_outcome = Some(outcome);
    }
}

/// The request the render window is serving.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InFlight {
    pub id: String,
    pub kind: String,
    pub client: String,
    pub frames: u32,
    pub frames_done: u32,
    pub units: u32,
    pub started_at_ms: u64,
    pub generation: u64,
    pub version: u32,
}

/// The watchdog's own clocks: when it last ran, when it resumed after a gap, and since when render requests have waited unclaimed.
#[derive(Debug, Clone, Default)]
pub(crate) struct SilenceWatch {
    last_tick_ms: Option<u64>,
    resumed_at_ms: Option<u64>,
    pending_since_ms: Option<u64>,
}

impl SilenceWatch {
    pub(crate) const fn new() -> Self {
        Self {
            last_tick_ms: None,
            resumed_at_ms: None,
            pending_since_ms: None,
        }
    }

    /// One watchdog tick; a gap since the last one restarts the clocks, so a wake from sleep never reads as silence.
    pub(crate) fn tick(&mut self, now: u64, pending: bool) {
        if self
            .last_tick_ms
            .map_or(true, |at| now.saturating_sub(at) > WATCH_GAP_MS)
        {
            self.resumed_at_ms = Some(now);
        }
        self.last_tick_ms = Some(now);
        self.pending_since_ms = if pending {
            self.pending_since_ms.or(Some(now))
        } else {
            None
        };
    }
}

/// Why the watchdog recycles a render window that answers nothing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Silence {
    /// Created and no first beat within 30 s.
    NoFirstBeat,
    /// Beat before, then none for 45 s while render requests wait.
    Stopped,
}

fn since(times: &[Option<u64>], now: u64) -> u64 {
    now.saturating_sub(times.iter().flatten().copied().max().unwrap_or(now))
}

/// Whether the hung watchdog fires: a request in flight and no beat (or create, or claim, or watchdog resume) for 45 s.
pub(crate) fn hung(
    in_flight: &InFlight,
    window: &WindowTrack,
    watch: &SilenceWatch,
    now: u64,
) -> bool {
    let quiet = since(
        &[
            Some(in_flight.started_at_ms),
            window.last_beat_ms,
            window.created_at_ms,
            watch.resumed_at_ms,
        ],
        now,
    );
    quiet > HUNG_AFTER_MS
}

/// Whether a live render window is silent: no first beat 30 s after its create, or beats stopped for 45 s while render requests wait (counted from the later of the last beat, the wait's start and any claim, so the hung check answers a request in flight first). Hidden pages beat about every 2 s, far inside both.
pub(crate) fn silent(
    window: &WindowTrack,
    watch: &SilenceWatch,
    in_flight: Option<&InFlight>,
    now: u64,
) -> Option<Silence> {
    let created = window.created_at_ms?;
    match window.last_beat_ms {
        None => (since(&[Some(created), watch.resumed_at_ms], now) > FIRST_BEAT_WITHIN_MS)
            .then_some(Silence::NoFirstBeat),
        Some(beat) => {
            let waiting = watch.pending_since_ms?;
            let quiet = since(
                &[
                    Some(beat),
                    Some(waiting),
                    watch.resumed_at_ms,
                    in_flight.map(|f| f.started_at_ms),
                ],
                now,
            );
            (quiet > HUNG_AFTER_MS).then_some(Silence::Stopped)
        }
    }
}

struct Censuses {
    editor: Option<Value>,
    render: Option<Value>,
    editor_pid: Option<u32>,
}

struct ServiceInner {
    in_flight: Option<InFlight>,
    usage: Usage,
    durations: Durations,
    recycle: RecycleState,
    window: WindowTrack,
    watch: SilenceWatch,
    censuses: Censuses,
    /// Ids Rust answered itself; a late page answer for one is dropped.
    answered: VecDeque<String>,
}

static SERVICE: Mutex<ServiceInner> = Mutex::new(ServiceInner {
    in_flight: None,
    usage: Usage::new(),
    durations: Durations::new(),
    recycle: RecycleState::new(),
    window: WindowTrack::new(),
    watch: SilenceWatch::new(),
    censuses: Censuses {
        editor: None,
        render: None,
        editor_pid: None,
    },
    answered: VecDeque::new(),
});

fn service() -> MutexGuard<'static, ServiceInner> {
    SERVICE.lock().unwrap_or_else(|e| e.into_inner())
}

fn editor_aspect(app: &AppHandle) -> Option<String> {
    app.state::<bridge::EditorContextState>()
        .0
        .lock()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.aspect.clone()))
}

fn render_alive(app: &AppHandle) -> bool {
    app.get_webview_window("render").is_some()
}

// ── App glue ───────────────────────────────────────────────────────────────

/// `ensure_render_window`'s gate: wedged or inside a stall's backoff.
pub(crate) fn window_blocked() -> bool {
    service().recycle.window_blocked(now_ms())
}

/// A request is in flight (the idle teardown waits for it).
pub(crate) fn serving_request() -> bool {
    service().in_flight.is_some()
}

pub(crate) fn on_window_created(app: &AppHandle) {
    service().window.created(now_ms());
    emit_state(app);
}

/// The render window claimed `request`: it is in flight and its units count against its client.
pub(crate) fn on_claim(app: &AppHandle, request: &BridgeRequest) {
    let now = now_ms();
    let p = peek(request, editor_aspect(app).as_deref());
    {
        let mut s = service();
        s.usage.record(now, &p.client, p.units, &p.id);
        let generation = s.window.generation;
        s.in_flight = Some(InFlight {
            id: p.id.clone(),
            kind: p.kind.clone(),
            client: p.client.clone(),
            frames: p.frames,
            frames_done: 0,
            units: p.units,
            started_at_ms: now,
            generation,
            version: crate::bridge::response_version(request),
        });
    }
    emit_activity(app, true, &p.id, &p.kind, &p.client, p.frames);
}

/// Per-frame progress from the render window's liveness check.
pub(crate) fn note_progress(id: &str, frame: u32) {
    if let Some(f) = service().in_flight.as_mut().filter(|f| f.id == id) {
        f.frames_done = frame.min(f.frames);
    }
}

/// A render-window answer about to be written: closes the in-flight request (a sample for the estimator), and a stall (or a debug lose-context) gets the recycle's outcome filled in. False drops a late answer Rust already gave.
pub(crate) fn on_response(app: &AppHandle, id: &str, body: &mut Value) -> bool {
    let now = now_ms();
    let closed = {
        let mut s = service();
        if s.answered.iter().any(|a| a == id) {
            return false;
        }
        match s.in_flight.take() {
            Some(f) if f.id == id => {
                if f.kind == "capture" && body.get("ok") == Some(&Value::Bool(true)) {
                    s.durations
                        .record(f.units, now.saturating_sub(f.started_at_ms));
                }
                Some(f)
            }
            other => {
                s.in_flight = other;
                None
            }
        }
    };
    if body.get("gpuStalled") == Some(&Value::Bool(true)) {
        service().usage.refund(id);
        let reason = body
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("contextLost")
            .to_owned();
        let outcome = stall(app, &reason, true);
        fill_stall(body, &outcome);
    } else if body.get("op").and_then(Value::as_str) == Some("lose-context")
        && body.get("recycling") == Some(&Value::Bool(true))
    {
        let outcome = stall(app, "debug", false);
        body["recycled"] = json!(outcome.recycled);
    }
    if let Some(f) = closed {
        emit_activity(app, false, &f.id, &f.kind, &f.client, f.frames);
    }
    true
}

fn fill_stall(body: &mut Value, outcome: &StallOutcome) {
    body["recycled"] = json!(outcome.recycled);
    body["retryAfterMs"] = json!(outcome.retry_after_ms);
    body["wedged"] = json!(outcome.wedged);
    body["hint"] = json!(if outcome.wedged {
        WEDGED_HINT
    } else {
        STALL_HINT
    });
}

/// One stall of the current render window, counted once however many paths report it: the recycle state decides the backoff, and the window is destroyed 200 ms later (the page may still write its own answer) with any unanswered in-flight request answered from here.
pub(crate) fn stall(app: &AppHandle, reason: &str, counts: bool) -> StallOutcome {
    let now = now_ms();
    let (outcome, generation, fresh) = {
        let mut s = service();
        let generation = s.window.generation;
        match (s.window.recycled_generation, s.window.last_outcome) {
            (Some(g), Some(last)) if g == generation => (last, generation, false),
            _ => {
                let outcome = s.recycle.stall(now, reason, counts);
                s.window.recycled(outcome);
                (outcome, generation, true)
            }
        }
    };
    if fresh {
        log::warn!(
            "[capture] render window stalled ({reason}); recycled={} wedged={} retryAfterMs={:?}",
            outcome.recycled,
            outcome.wedged,
            outcome.retry_after_ms
        );
        let app = app.clone();
        let reason = reason.to_owned();
        std::thread::spawn(move || {
            std::thread::sleep(DESTROY_DELAY);
            crate::render_win::recycle_render_window(&app);
            answer_in_flight(&app, generation, &reason, &outcome);
            emit_state(&app);
        });
    }
    outcome
}

fn stall_error(reason: &str) -> String {
    match reason {
        "hung" => "GPU stalled: the render window stopped responding for 45 s mid-request, so Kookaburra Cut recycled it".into(),
        "silent" => "GPU stalled: the render window stopped beating (it could not draw), so Kookaburra Cut recycled it".into(),
        "wedged" => "GPU wedged: the render window stalled 3 times in 10 minutes, so Kookaburra Cut stopped capturing".into(),
        other => format!("GPU stalled ({other}): the render window lost its WebGL context, so Kookaburra Cut recycled it"),
    }
}

fn stall_body(f: &InFlight, reason: &str, outcome: &StallOutcome) -> Value {
    let mut body = json!({
        "version": f.version, "id": f.id, "ok": false, "gpuStalled": true,
        "reason": reason, "error": stall_error(reason),
    });
    fill_stall(&mut body, outcome);
    body
}

fn write_answer(app: &AppHandle, id: &str, mut body: Value) {
    let Ok(root) = crate::bridge::bridge_root(app) else {
        return;
    };
    crate::bridge::stamp_served_by(&mut body, crate::bridge::own_served_by(app).as_ref());
    {
        let mut s = service();
        if s.answered.len() >= 32 {
            s.answered.pop_front();
        }
        s.answered.push_back(id.to_owned());
    }
    if let Err(e) = crate::bridge::write_response_value(&root, id, &body) {
        log::warn!("[capture] answer for {id} failed: {e}");
    }
}

fn answer_in_flight(app: &AppHandle, generation: u64, reason: &str, outcome: &StallOutcome) {
    let f = {
        let mut s = service();
        match s.in_flight.take() {
            Some(f) if f.generation == generation => {
                s.usage.refund(&f.id);
                Some(f)
            }
            other => {
                s.in_flight = other;
                None
            }
        }
    };
    if let Some(f) = f {
        write_answer(app, &f.id.clone(), stall_body(&f, reason, outcome));
        emit_activity(app, false, &f.id, &f.kind, &f.client, f.frames);
    }
}

/// A beat from the render window; a dropped `seq` answers the in-flight request as transient (its page reloaded under it).
pub(crate) fn on_beat(
    app: &AppHandle,
    seq: u64,
    gl_ms: f64,
    census: Option<Value>,
    loaded_project: Option<String>,
) {
    let now = now_ms();
    let (reloaded, lost, want_pid) = {
        let mut s = service();
        let reloaded = s.window.beat(seq, gl_ms, now);
        if let Some(census) = census {
            s.censuses.render = Some(census);
        }
        if loaded_project.is_some() {
            s.window.loaded_project = loaded_project;
        }
        let lost = if reloaded { s.in_flight.take() } else { None };
        (reloaded, lost, s.window.web_content_pid.is_none())
    };
    if want_pid {
        if let Some(win) = app.get_webview_window("render") {
            fetch_web_content_pid(&win, |pid| service().window.web_content_pid = Some(pid));
        }
    }
    if !reloaded {
        return;
    }
    log::warn!("[capture] the render window's page reloaded (WebContent process replaced)");
    crate::preset_posters::restart_claimed(
        &app.state::<crate::preset_posters::PresetPosterQueueState>(),
    );
    if let Some(f) = lost {
        let body = json!({
            "version": f.version, "id": f.id, "ok": false, "transient": true, "reason": "contentReload",
            "error": "the render window's page reloaded mid-request (WebKit replaced its WebContent process, usually for memory); rerun it",
            "hint": "rerun with fewer or smaller frames (the default sheet size or --scale 0.5)",
        });
        write_answer(app, &f.id.clone(), body);
        emit_activity(app, false, &f.id, &f.kind, &f.client, f.frames);
    }
}

/// An unexpected WebGL loss the render window saw outside a request; a deliberate one (teardown, debug) changes nothing.
pub(crate) fn report_gpu_event(app: &AppHandle, reason: &str, deliberate: bool) {
    if deliberate {
        log::info!("[capture] deliberate context loss in the render window ({reason})");
        return;
    }
    if render_alive(app) {
        stall(app, reason, true);
    }
}

/// The editor's Retry captures: back to a clean state, so the next request gets a fresh window at once.
pub(crate) fn reset(app: &AppHandle) {
    {
        let mut s = service();
        s.recycle.reset();
        s.window.last_outcome = None;
    }
    emit_state(app);
}

/// The native loop's watchdog, given how many render requests wait unclaimed: a hung request or a silent window recycles the window (counted like any stall, so the backoff and the wedged state apply); one left in flight by a window that is gone is answered transient.
pub(crate) fn watchdog(app: &AppHandle, pending: usize) {
    let now = now_ms();
    let alive = render_alive(app);
    let (recycle, orphan) = {
        let mut s = service();
        s.watch.tick(now, pending > 0);
        let stale = s
            .in_flight
            .as_ref()
            .is_some_and(|f| hung(f, &s.window, &s.watch, now));
        if !alive {
            (None, if stale { s.in_flight.take() } else { None })
        } else if stale {
            (Some(("hung", None)), None)
        } else {
            let quiet = silent(&s.window, &s.watch, s.in_flight.as_ref(), now);
            (quiet.map(|q| ("silent", Some(q))), None)
        }
    };
    if let Some((reason, quiet)) = recycle {
        match quiet {
            Some(Silence::NoFirstBeat) => log::warn!(
                "[capture] the render window sent no first beat {} s after its create",
                FIRST_BEAT_WITHIN_MS / 1000
            ),
            Some(Silence::Stopped) => log::warn!(
                "[capture] the render window stopped beating for {} s with {pending} request(s) waiting",
                HUNG_AFTER_MS / 1000
            ),
            None => {}
        }
        stall(app, reason, true);
    }
    if let Some(f) = orphan {
        let body = json!({
            "version": f.version, "id": f.id, "ok": false, "transient": true, "reason": "windowClosed",
            "error": "the render window closed mid-request; rerun it",
        });
        write_answer(app, &f.id.clone(), body);
        emit_activity(app, false, &f.id, &f.kind, &f.client, f.frames);
    }
}

fn verdict_body(request: &BridgeRequest, p: &RequestPeek, verdict: &Verdict) -> Value {
    let base = json!({ "version": crate::bridge::response_version(request), "id": request.id, "ok": false });
    let mut body = base;
    match verdict {
        Verdict::Serve => {}
        Verdict::TooLarge => {
            body["tooLarge"] = json!(true);
            body["units"] = json!(p.units);
            body["maxUnits"] = json!(MAX_REQUEST_UNITS);
            body["error"] = json!(format!(
                "this capture costs {} units ({} frame(s)); one request takes at most {MAX_REQUEST_UNITS} (a 4K frame is 9)",
                p.units, p.frames
            ));
            body["hint"] = json!(TOO_LARGE_HINT);
        }
        Verdict::Throttled {
            retry_after_ms,
            why,
        } => {
            body["throttled"] = json!(true);
            body["retryAfterMs"] = json!(retry_after_ms);
            body["error"] = json!(why);
            body["hint"] = json!(THROTTLE_HINT);
        }
        Verdict::Wedged => {
            body["gpuStalled"] = json!(true);
            body["wedged"] = json!(true);
            body["recycled"] = json!(false);
            body["retryAfterMs"] = Value::Null;
            body["reason"] = json!("wedged");
            body["error"] = json!(stall_error("wedged"));
            body["hint"] = json!(WEDGED_HINT);
        }
    }
    body
}

/// The native loop's triage of this instance's pending render requests: wedged, too large and throttled ones are answered at once (claimed first, so the render window never serves them too). Returns how many are left for the render window.
pub(crate) fn triage(app: &AppHandle, root: &Path, pid: u32) -> usize {
    let now = now_ms();
    let own = crate::bridge::own_workspace_root(app);
    let pending = crate::bridge::pending_claimable_requests(root, own.as_deref(), pid, now);
    if pending.is_empty() {
        return 0;
    }
    let aspect = editor_aspect(app);
    let peeks: Vec<RequestPeek> = pending
        .iter()
        .map(|(r, _)| peek(r, aspect.as_deref()))
        .collect();
    let judged = {
        let mut s = service();
        let wedged = s.recycle.wedged(now);
        verdicts(&peeks, &s.usage, &s.durations.estimate(), now, wedged)
    };
    let left = judged.iter().filter(|v| **v == Verdict::Serve).count();
    for (((request, _), p), verdict) in pending.iter().zip(&peeks).zip(&judged) {
        if *verdict == Verdict::Serve {
            continue;
        }
        let requests = root.join("requests");
        let claimed = requests.join(".claimed");
        if std::fs::create_dir_all(&claimed).is_err() {
            return left;
        }
        let from = requests.join(format!("{}.json", request.id));
        if std::fs::rename(&from, claimed.join(format!("{}.json", request.id))).is_err() {
            continue;
        }
        write_answer(app, &request.id, verdict_body(request, p, verdict));
    }
    left
}

/// The render claim's order: drop what triage answers, then serve fairly.
pub(crate) fn order_claims(app: &AppHandle, pending: &mut Vec<crate::bridge::PendingClaim>) {
    let now = now_ms();
    let aspect = editor_aspect(app);
    let peeks: Vec<RequestPeek> = pending
        .iter()
        .map(|c| peek(&c.request, aspect.as_deref()))
        .collect();
    let (judged, order) = {
        let mut s = service();
        let wedged = s.recycle.wedged(now);
        let judged = verdicts(&peeks, &s.usage, &s.durations.estimate(), now, wedged);
        (judged, fair_order(&peeks, &s.usage, now))
    };
    let mut taken: Vec<Option<crate::bridge::PendingClaim>> =
        std::mem::take(pending).into_iter().map(Some).collect();
    for i in order {
        if judged[i] == Verdict::Serve {
            if let Some(claim) = taken[i].take() {
                pending.push(claim);
            }
        }
    }
}

// ── Health ─────────────────────────────────────────────────────────────────

/// A window's census as reported (its `contexts` list stays out of the heartbeat).
fn census_summary(census: Option<&Value>) -> Value {
    let Some(Value::Object(map)) = census else {
        return Value::Null;
    };
    let mut out = map.clone();
    out.remove("contexts");
    Value::Object(out)
}

/// The heartbeat's `health` block (docs/agent-kit.md, "Health"), from in-memory state plus one scan of the pending requests.
pub(crate) fn health(app: &AppHandle) -> Value {
    let now = now_ms();
    let alive = render_alive(app);
    let depth = crate::bridge::served_pending_count(app);
    let pending = crate::bridge::served_pending(app);
    let aspect = editor_aspect(app);
    let peeks: Vec<RequestPeek> = pending
        .iter()
        .map(|(r, _)| peek(r, aspect.as_deref()))
        .collect();
    let oldest = pending
        .iter()
        .map(|(r, age)| {
            if r.requested_at_ms > 0 {
                now.saturating_sub(r.requested_at_ms)
            } else {
                *age
            }
        })
        .max();
    let mut s = service();
    let estimate = s.durations.estimate();
    let wedged = s.recycle.wedged(now);
    let judged = verdicts(&peeks, &s.usage, &estimate, now, wedged);
    let serve: Vec<RequestPeek> = peeks
        .iter()
        .zip(&judged)
        .filter(|(_, v)| **v == Verdict::Serve)
        .map(|(p, _)| p.clone())
        .collect();
    let order = fair_order(&serve, &s.usage, now);
    let left_units = s.in_flight.as_ref().map_or(0.0, |f| {
        let left = f.frames.saturating_sub(f.frames_done) as f64 / f64::from(f.frames.max(1));
        f64::from(f.units) * left
    });
    let blocked = s
        .recycle
        .stalled_until_ms
        .map_or(0, |until| until.saturating_sub(now));
    let eta = queue_eta(&order, &serve, &estimate, left_units, blocked);
    let mut clients: Vec<String> = s.usage.clients(now);
    for p in &peeks {
        if !clients.contains(&p.client) {
            clients.push(p.client.clone());
        }
    }
    let editor_lost = s
        .censuses
        .editor
        .as_ref()
        .and_then(|c| c.get("stageLostAtMs"))
        .and_then(Value::as_u64);
    let mut render_window = json!({
        "alive": alive,
        "beatAgeMs": s.window.last_beat_ms.map(|at| now.saturating_sub(at)),
        "glMs": s.window.gl_ms,
        "createdAtMs": s.window.created_at_ms,
        "loadedProject": s.window.loaded_project,
        "contentReloads": s.window.content_reloads,
        "restarting": s.window.restarting(),
        "recycles": s.recycle.total,
        "lastRecycle": s.recycle.last_json(),
    });
    if let Some(pid) = s.window.web_content_pid.filter(|_| alive) {
        render_window["webContentPid"] = json!(pid);
    }
    json!({
        "version": HEALTH_VERSION,
        "captureFeatures": CAPTURE_FEATURES,
        "queue": {
            "depth": depth,
            "oldestAgeMs": oldest,
            "order": order.iter().map(|&i| serve[i].id.clone()).collect::<Vec<_>>(),
            "etaMs": eta,
            "inFlight": s.in_flight.as_ref().map(|f| json!({
                "id": f.id, "kind": f.kind, "client": f.client, "frames": f.frames,
                "framesDone": f.frames_done, "units": f.units, "startedAtMs": f.started_at_ms,
            })),
            "unitMs": estimate.unit_ms.round() as u64,
            "overheadMs": estimate.overhead_ms.round() as u64,
            "samples": estimate.samples,
        },
        "renderWindow": render_window,
        "gpu": s.recycle.gpu_json(now, editor_lost),
        "webgl": {
            "cap": WEBGL_CAP,
            "editor": census_summary(s.censuses.editor.as_ref()),
            "render": census_summary(s.censuses.render.as_ref()),
        },
        "clients": clients.iter().map(|c| json!({
            "client": c,
            "unitsLastMin": s.usage.units(c, now),
            "capPerMin": CLIENT_UNITS_PER_MIN,
            "pending": peeks.iter().filter(|p| &p.client == c).count(),
        })).collect::<Vec<_>>(),
    })
}

/// `kind: "debug", op: "contexts"`: every window's census, answered natively (never spawns a window).
pub(crate) fn contexts_report(app: &AppHandle) -> Value {
    let alive = render_alive(app);
    let s = service();
    let mut render = s.censuses.render.clone().unwrap_or_else(|| json!({}));
    render["alive"] = json!(alive);
    json!({
        "ok": true,
        "op": "contexts",
        "cap": WEBGL_CAP,
        "windows": { "editor": s.censuses.editor, "render": render },
        "webContentPids": {
            "editor": s.censuses.editor_pid,
            "render": s.window.web_content_pid.filter(|_| alive),
        },
    })
}

/// The editor's page reloaded: its WebContent process may be new, so the next census reads the pid again.
pub(crate) fn forget_editor_pid() {
    service().censuses.editor_pid = None;
}

/// The render window's WebContent pid, for the memory sampler.
pub(crate) fn render_pid() -> Option<u32> {
    service().window.web_content_pid
}

/// The editor's view of the service (the GPU notices).
pub(crate) fn status(app: &AppHandle) -> Value {
    let now = now_ms();
    let alive = render_alive(app);
    let mut s = service();
    let gpu = s.recycle.gpu_json(now, None);
    json!({
        "stalledUntilMs": gpu["stalledUntilMs"],
        "wedged": gpu["wedged"],
        "stallsLast10Min": gpu["stallsLast10Min"],
        "recycles": s.recycle.total,
        "lastRecycle": s.recycle.last_json(),
        "renderAlive": alive,
    })
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit("kookaburra://capture-service", status(app));
}

fn emit_activity(app: &AppHandle, active: bool, id: &str, kind: &str, client: &str, frames: u32) {
    let queued = crate::bridge::served_pending_count(app);
    let _ = app.emit(
        "kookaburra://bridge-activity",
        json!({ "active": active, "id": id, "kind": kind, "client": client, "frames": frames, "queued": queued }),
    );
}

/// The WebContent pid behind a window (private `_webProcessIdentifier`, diagnostics only), stored once the main thread reads it.
#[cfg(target_os = "macos")]
pub(crate) fn fetch_web_content_pid(
    window: &tauri::WebviewWindow,
    store: impl FnOnce(u32) + Send + 'static,
) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    let _ = window.with_webview(move |webview| unsafe {
        let wk: *mut AnyObject = webview.inner().cast();
        let responds: Bool = msg_send![wk, respondsToSelector: sel!(_webProcessIdentifier)];
        if responds.as_bool() {
            let pid: i32 = msg_send![wk, _webProcessIdentifier];
            if let Ok(pid) = u32::try_from(pid) {
                if pid > 0 {
                    store(pid);
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn fetch_web_content_pid(
    _window: &tauri::WebviewWindow,
    _store: impl FnOnce(u32) + Send + 'static,
) {
}

/// A window's WebGL census (`src/engine/glContexts.ts`): the editor on its tick, the render window rides its beat.
#[tauri::command]
pub fn capture_report_census(app: AppHandle, window: String, census: Value) {
    if window != "editor" {
        return;
    }
    let want_pid = {
        let mut s = service();
        s.censuses.editor = Some(census);
        s.censuses.editor_pid.is_none()
    };
    if want_pid {
        if let Some(win) = app.get_webview_window("main") {
            fetch_web_content_pid(&win, |pid| service().censuses.editor_pid = Some(pid));
        }
    }
}

#[tauri::command]
pub fn capture_service_status(app: AppHandle) -> Value {
    status(&app)
}

// ── Retention ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) struct PruneLimits {
    pub ttl_ms: u64,
    pub cap_bytes: u64,
    pub min_age_ms: u64,
}

pub(crate) const DEFAULT_LIMITS: PruneLimits = PruneLimits {
    ttl_ms: RESPONSE_TTL_MS,
    cap_bytes: RESPONSE_CAP_BYTES,
    min_age_ms: RESPONSE_MIN_AGE_MS,
};

struct Group {
    files: Vec<(PathBuf, u64)>,
    newest_ms: u64,
    json: Option<PathBuf>,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Which response a file belongs to: `<id>.json` and `<id>.progress.json`, its frames `<id>.png` and `<id>-N.png`, its `<id>-sheet.png`; a temp file stands alone.
fn group_key(name: &str, ids: &[String], stems: &[String]) -> String {
    if name.starts_with('.') {
        return name.to_owned();
    }
    if let Some(id) = name.strip_suffix(".progress.json") {
        return id.to_owned();
    }
    if let Some(id) = name.strip_suffix(".json") {
        return id.to_owned();
    }
    let stem = name.strip_suffix(".png").unwrap_or(name);
    if ids.iter().any(|id| id == stem) {
        return stem.to_owned();
    }
    if let Some(base) = stem.strip_suffix("-sheet") {
        return base.to_owned();
    }
    if let Some((base, n)) = stem.rsplit_once('-') {
        let known = ids.iter().chain(stems).any(|s| s == base);
        if known && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
            return base.to_owned();
        }
    }
    stem.to_owned()
}

fn served_pid(json: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(json).ok()?;
    let body: Value = serde_json::from_str(&text).ok()?;
    let pid = body.get("servedBy")?.get("pid")?.as_u64()?;
    u32::try_from(pid).ok()
}

/// Prune `responses/` by response: past the TTL, then oldest first while over the size cap; never one under the minimum age, and only ones this instance owns (`servedBy.pid` ours or dead, or no `servedBy`). Returns the groups removed.
pub(crate) fn prune_responses_at(
    dir: &Path,
    own_pid: u32,
    now: u64,
    limits: &PruneLimits,
    alive: impl Fn(u32) -> bool,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let files: Vec<(String, PathBuf, u64, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| {
                (
                    e.file_name().to_string_lossy().into_owned(),
                    e.path(),
                    meta.len(),
                    mtime_ms(&meta),
                )
            })
        })
        .collect();
    let ids: Vec<String> = files
        .iter()
        .filter_map(|(n, ..)| {
            (!n.starts_with('.') && !n.ends_with(".progress.json"))
                .then(|| n.strip_suffix(".json").map(str::to_owned))
                .flatten()
        })
        .collect();
    let stems: Vec<String> = files
        .iter()
        .filter_map(|(n, ..)| n.strip_suffix(".png").map(str::to_owned))
        .collect();
    let mut groups: Vec<(String, Group)> = Vec::new();
    for (name, path, size, mtime) in files {
        let key = group_key(&name, &ids, &stems);
        let slot = match groups.iter().position(|(k, _)| *k == key) {
            Some(i) => i,
            None => {
                groups.push((
                    key.clone(),
                    Group {
                        files: Vec::new(),
                        newest_ms: 0,
                        json: None,
                    },
                ));
                groups.len() - 1
            }
        };
        let group = &mut groups[slot].1;
        if name == format!("{key}.json") {
            group.json = Some(path.clone());
        }
        group.newest_ms = group.newest_ms.max(mtime);
        group.files.push((path, size));
    }
    let mut total: u64 = groups
        .iter()
        .flat_map(|(_, g)| g.files.iter().map(|f| f.1))
        .sum();
    let owned = |g: &Group| {
        g.json
            .as_deref()
            .and_then(served_pid)
            .map_or(true, |pid| pid == own_pid || !alive(pid))
    };
    let mut removable: Vec<&Group> = groups
        .iter()
        .map(|(_, g)| g)
        .filter(|g| now.saturating_sub(g.newest_ms) >= limits.min_age_ms && owned(g))
        .collect();
    removable.sort_by_key(|g| g.newest_ms);
    let mut removed = 0;
    for g in removable {
        let expired = now.saturating_sub(g.newest_ms) > limits.ttl_ms;
        if !expired && total <= limits.cap_bytes {
            continue;
        }
        for (path, size) in &g.files {
            if std::fs::remove_file(path).is_ok() {
                total = total.saturating_sub(*size);
            }
        }
        removed += 1;
    }
    removed
}

static LAST_PRUNE_MS: AtomicU64 = AtomicU64::new(0);

/// The response prune, at most once a minute whichever path asks.
pub(crate) fn maybe_prune_responses(root: &Path, own_pid: u32) {
    let now = now_ms();
    let last = LAST_PRUNE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < PRUNE_EVERY_MS
        || LAST_PRUNE_MS
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    prune_responses_at(
        &root.join("responses"),
        own_pid,
        now,
        &DEFAULT_LIMITS,
        crate::bridge::pid_alive,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, fields: Value) -> BridgeRequest {
        let mut body = json!({ "version": 2, "id": id, "kind": "capture" });
        for (k, v) in fields.as_object().unwrap() {
            body[k] = v.clone();
        }
        crate::bridge::parse_request(&body.to_string()).unwrap()
    }

    fn p(id: &str, client: &str, units: u32) -> RequestPeek {
        RequestPeek {
            id: id.into(),
            kind: "capture".into(),
            op: None,
            client: client.into(),
            frames: 1,
            units,
            deadline_at_ms: None,
            order_key: id.into(),
        }
    }

    #[test]
    fn capture_sizes_follow_the_rules() {
        let k4 = native_size(Some("16:9"));
        assert_eq!(k4, (3840, 2160));
        assert_eq!(capture_size(k4, None, None, false), (3840, 2160));
        assert_eq!(capture_size(k4, None, None, true), (1280, 720));
        assert_eq!(capture_size(k4, None, Some(0.5), true), (1920, 1080));
        assert_eq!(capture_size(k4, None, Some(1.0), true), (3840, 2160));
        assert_eq!(capture_size(k4, Some(640.0), None, false), (640, 360));
        assert_eq!(capture_size(k4, Some(641.0), None, false), (642, 362));
        assert_eq!(capture_size(k4, Some(9000.0), None, false), (3840, 2160));
        assert_eq!(capture_size(k4, Some(10.0), None, false), (114, 64));
        assert_eq!(
            capture_size(native_size(Some("9:16")), None, None, true),
            (720, 1280)
        );
        assert_eq!(
            capture_size(native_size(Some("9:16")), Some(640.0), None, false),
            (640, 1138)
        );
        assert_eq!(
            capture_size(native_size(Some("4:5")), None, None, true),
            (1024, 1280)
        );
        assert_eq!(
            capture_size(native_size(Some("phone")), None, None, true),
            (588, 1280)
        );
        assert_eq!(
            capture_size(
                native_size(Some("phone-landscape")),
                Some(64.0),
                None,
                false
            ),
            (140, 64)
        );
        assert_eq!(native_size(Some("nope")), (3840, 2160));
    }

    #[test]
    fn units_count_frames_by_their_pixels() {
        assert_eq!(units_for(1, 3840, 2160), 9);
        assert_eq!(units_for(1, 1280, 720), 1);
        assert_eq!(units_for(1, 1024, 1280), 2);
        assert_eq!(units_for(1, 720, 1280), 1);
        assert_eq!(units_for(48, 1280, 720), 48);
        assert_eq!(units_for(16, 3840, 2160), MAX_REQUEST_UNITS);
        let sheet = request(
            "a",
            json!({ "frames": [{ "scene": "0" }, { "scene": "1" }], "sheet": true }),
        );
        assert_eq!(peek(&sheet, Some("16:9")).units, 2);
        let native = request(
            "b",
            json!({ "frames": [{ "scene": "0" }, { "scene": "1" }], "scale": 1 }),
        );
        assert_eq!(peek(&native, None).units, 18);
        let probe = request("c", json!({ "frames": [{}, {}], "probe": [[1, 2]] }));
        assert_eq!(peek(&probe, None).units, 18);
        let single = request("d", json!({ "aspect": "9:16" }));
        assert_eq!(
            (
                peek(&single, Some("16:9")).units,
                peek(&single, None).frames
            ),
            (9, 1)
        );
        let check = request("e", json!({ "kind": "check", "render": true }));
        assert_eq!(
            (peek(&check, None).kind.as_str(), peek(&check, None).units),
            ("check", 1)
        );
        let v1 = crate::bridge::parse_request(r#"{"id":"f"}"#).unwrap();
        assert_eq!(
            (
                peek(&v1, Some("1:1")).kind.as_str(),
                peek(&v1, Some("1:1")).units
            ),
            ("capture", 6)
        );
        let retry = request("g", json!({ "retryOf": "a", "client": " agent:2 " }));
        assert_eq!(
            (
                peek(&retry, None).order_key.as_str(),
                peek(&retry, None).client.as_str()
            ),
            ("a", "agent:2")
        );
        assert_eq!(peek(&single, None).client, "anon");
    }

    #[test]
    fn the_picker_favours_the_client_served_least_then_the_oldest() {
        let now = 1_000_000;
        let mut usage = Usage::new();
        usage.record(now - 10_000, "a", 30, "x");
        usage.record(now - 70_000, "b", 500, "old");
        let peeks = vec![
            p("1", "a", 1),
            p("2", "a", 1),
            p("3", "b", 9),
            p("4", "c", 1),
        ];
        assert_eq!(fair_order(&peeks, &usage, now), vec![2, 3, 0, 1]);
        let mut retry = p("5", "c", 1);
        retry.order_key = "0".into();
        let peeks = vec![p("4", "c", 1), retry];
        assert_eq!(fair_order(&peeks, &usage, now), vec![1, 0]);
        let tie = vec![p("9", "d", 1), p("8", "e", 1)];
        assert_eq!(fair_order(&tie, &Usage::new(), now), vec![1, 0]);
    }

    #[test]
    fn throttles_count_pending_and_a_minute_of_units() {
        let now = 1_000_000;
        let est = Durations::new().estimate();
        let peeks: Vec<RequestPeek> = (0..6).map(|i| p(&format!("{i}"), "a", 1)).collect();
        let v = verdicts(&peeks, &Usage::new(), &est, now, false);
        assert_eq!(
            &v[..4],
            &[
                Verdict::Serve,
                Verdict::Serve,
                Verdict::Serve,
                Verdict::Serve
            ]
        );
        assert!(matches!(&v[4], Verdict::Throttled { why, .. } if why.contains("waiting")));
        let mut usage = Usage::new();
        usage.record(now - 50_000, "a", 144, "x");
        usage.record(now - 20_000, "a", 90, "y");
        let v = verdicts(&[p("1", "a", 9), p("2", "b", 9)], &usage, &est, now, false);
        assert_eq!(
            v[0],
            Verdict::Throttled {
                retry_after_ms: 10_000,
                why: "a would use 243 capture units in a minute (at most 240)".into()
            }
        );
        assert_eq!(v[1], Verdict::Serve);
        let v = verdicts(&[p("1", "a", 6)], &usage, &est, now + 10_001, false);
        assert_eq!(v[0], Verdict::Serve);
        let ahead = verdicts(
            &[p("1", "b", 144), p("2", "b", 144)],
            &Usage::new(),
            &est,
            now,
            false,
        );
        assert!(
            matches!(ahead[1], Verdict::Throttled { retry_after_ms, .. } if retry_after_ms >= MIN_RETRY_AFTER_MS)
        );
        let big = verdicts(&[p("1", "a", 145)], &Usage::new(), &est, now, false);
        assert_eq!(big[0], Verdict::TooLarge);
        let mut fonts = p("1", "a", 1);
        fonts.kind = "fonts".into();
        let many: Vec<RequestPeek> = (0..6).map(|_| fonts.clone()).collect();
        assert!(verdicts(&many, &Usage::new(), &est, now, false)
            .iter()
            .all(|v| *v == Verdict::Serve));
        assert!(verdicts(&many, &Usage::new(), &est, now, true)
            .iter()
            .all(|v| *v == Verdict::Wedged));
        let mut usage = Usage::new();
        usage.record(now, "a", 9, "z");
        usage.refund("z");
        assert_eq!(usage.units("a", now), 0);
    }

    #[test]
    fn the_estimate_fits_overhead_and_unit_cost() {
        let mut d = Durations::new();
        assert_eq!(
            d.estimate(),
            Estimate {
                unit_ms: 400.0,
                overhead_ms: 1000.0,
                samples: 0
            }
        );
        for (units, ms) in [(1, 1400), (9, 4600), (1, 1400), (9, 4600)] {
            d.record(units, ms);
        }
        let e = d.estimate();
        assert_eq!((e.unit_ms, e.overhead_ms, e.samples), (400.0, 1000.0, 4));
        let mut one = Durations::new();
        one.record(4, 3000);
        assert_eq!(
            one.estimate(),
            Estimate {
                unit_ms: 500.0,
                overhead_ms: 1000.0,
                samples: 1
            }
        );
        for _ in 0..40 {
            one.record(1, 100);
        }
        assert_eq!(one.estimate().samples, SAMPLE_CAP);
        let peeks = vec![p("1", "a", 1), p("2", "b", 9)];
        assert_eq!(
            queue_eta(&[1, 0], &peeks, &e, 2.0, 500),
            vec![1000 + 500 + 800 + 3600, 1000 + 500 + 800 + 3600 + 1400]
        );
    }

    #[test]
    fn recycles_back_off_then_wedge_until_quiet_or_reset() {
        let mut r = RecycleState::new();
        let t = 1_000_000;
        assert_eq!(
            r.stall(t, "debug", false),
            StallOutcome {
                recycled: true,
                retry_after_ms: Some(0),
                wedged: false,
                stalled_until_ms: None
            }
        );
        let first = r.stall(t, "contextLost", true);
        assert_eq!(
            (first.recycled, first.retry_after_ms, first.wedged),
            (true, Some(0), false)
        );
        assert!(!r.window_blocked(t));
        let second = r.stall(t + 1_000, "contextLost", true);
        assert_eq!(
            (second.retry_after_ms, second.stalled_until_ms),
            (Some(15_000), Some(t + 16_000))
        );
        assert!(r.window_blocked(t + 15_999) && !r.window_blocked(t + 16_000));
        let third = r.stall(t + 20_000, "hung", true);
        assert_eq!(third.retry_after_ms, Some(60_000));
        let fourth = r.stall(t + 90_000, "contextLost", true);
        assert_eq!(
            (fourth.recycled, fourth.wedged, fourth.retry_after_ms),
            (false, true, None)
        );
        assert!(r.wedged(t + 90_000) && r.window_blocked(t + 500_000));
        assert_eq!(r.total, 4);
        assert_eq!(r.last.as_ref().map(|l| l.1.as_str()), Some("hung"));
        assert!(!r.wedged(t + 90_000 + RECYCLE_WINDOW_MS));
        assert_eq!(r.recent.len(), 0);
        let again = r.stall(t + 90_000 + RECYCLE_WINDOW_MS, "contextLost", true);
        assert_eq!(again.retry_after_ms, Some(0));
        r.stall(t + 91_000 + RECYCLE_WINDOW_MS, "contextLost", true);
        r.reset();
        assert!(!r.window_blocked(t + 91_001 + RECYCLE_WINDOW_MS));
        let spaced = {
            let mut r = RecycleState::new();
            r.stall(0, "a", true);
            r.stall(RECYCLE_WINDOW_MS, "a", true)
        };
        assert_eq!(spaced.retry_after_ms, Some(0));
    }

    #[test]
    fn a_dropped_seq_without_a_create_is_a_content_reload() {
        let mut w = WindowTrack::new();
        w.created(10);
        assert!(!w.beat(0, 1.0, 11));
        assert!(!w.beat(0, 1.0, 12));
        assert!(!w.beat(5, 1.0, 13));
        assert!(w.beat(0, 2.0, 14));
        assert_eq!(
            (w.content_reloads, w.gl_ms, w.last_beat_ms),
            (1, Some(2.0), Some(14))
        );
        w.created(20);
        assert!(!w.beat(0, 1.0, 21));
        assert_eq!((w.content_reloads, w.generation), (1, 2));
        assert!(!w.restarting());
        w.recycled(StallOutcome {
            recycled: true,
            retry_after_ms: Some(0),
            wedged: false,
            stalled_until_ms: None,
        });
        w.beat(1, 1.0, 22);
        assert!(
            w.restarting(),
            "the stalled window's own late beat proves nothing"
        );
        w.created(30);
        assert!(w.restarting());
        w.beat(0, 1.0, 31);
        assert!(!w.restarting());
        w.created(40);
        assert!(
            !w.restarting(),
            "a cold start after a recovery is not a restart"
        );
        let f = InFlight {
            id: "a".into(),
            kind: "capture".into(),
            client: "anon".into(),
            frames: 1,
            frames_done: 0,
            units: 9,
            started_at_ms: 100,
            generation: 2,
            version: 2,
        };
        let mut w = WindowTrack::new();
        w.created(0);
        let watch = SilenceWatch::new();
        assert!(!hung(&f, &w, &watch, 100 + HUNG_AFTER_MS));
        assert!(hung(&f, &w, &watch, 101 + HUNG_AFTER_MS));
        w.beat(1, 1.0, 40_000);
        assert!(!hung(&f, &w, &watch, 40_000 + HUNG_AFTER_MS));
    }

    fn in_flight(started_at_ms: u64) -> InFlight {
        InFlight {
            id: "a".into(),
            kind: "capture".into(),
            client: "anon".into(),
            frames: 1,
            frames_done: 0,
            units: 1,
            started_at_ms,
            generation: 1,
            version: 2,
        }
    }

    /// Ticks the watchdog every 300 ms over `[from, to)`, as the native loop does.
    fn tick_through(watch: &mut SilenceWatch, from: u64, to: u64, pending: bool) {
        let mut t = from;
        while t < to {
            watch.tick(t, pending);
            t += 300;
        }
    }

    #[test]
    fn a_window_with_no_first_beat_in_30_s_is_silent() {
        let t = 1_000_000;
        let mut w = WindowTrack::new();
        let mut watch = SilenceWatch::new();
        assert_eq!(silent(&w, &watch, None, t), None);
        w.created(t);
        tick_through(&mut watch, t, t + FIRST_BEAT_WITHIN_MS, false);
        watch.tick(t + FIRST_BEAT_WITHIN_MS, false);
        assert_eq!(silent(&w, &watch, None, t + FIRST_BEAT_WITHIN_MS), None);
        watch.tick(t + FIRST_BEAT_WITHIN_MS + 1, false);
        assert_eq!(
            silent(&w, &watch, None, t + FIRST_BEAT_WITHIN_MS + 1),
            Some(Silence::NoFirstBeat)
        );
        w.beat(0, 1.0, t + 2_000);
        assert_eq!(silent(&w, &watch, None, t + FIRST_BEAT_WITHIN_MS + 1), None);
    }

    #[test]
    fn beats_that_stop_with_work_waiting_are_silent_and_idle_ones_are_not() {
        let t = 1_000_000;
        let mut w = WindowTrack::new();
        let mut watch = SilenceWatch::new();
        w.created(t);
        w.beat(0, 1.0, t + 1_000);
        tick_through(&mut watch, t, t + 600_000, false);
        assert_eq!(
            silent(&w, &watch, None, t + 600_000),
            None,
            "idle teardown owns a quiet idle window"
        );
        let queued = t + 600_000;
        tick_through(&mut watch, queued, queued + HUNG_AFTER_MS + 300, true);
        assert_eq!(silent(&w, &watch, None, queued + HUNG_AFTER_MS), None);
        assert_eq!(
            silent(&w, &watch, None, queued + HUNG_AFTER_MS + 1),
            Some(Silence::Stopped)
        );
        let claimed = in_flight(queued + 10_000);
        assert_eq!(
            silent(&w, &watch, Some(&claimed), queued + HUNG_AFTER_MS + 1),
            None,
            "the hung check answers a request in flight first"
        );
        assert!(hung(&claimed, &w, &watch, queued + 10_001 + HUNG_AFTER_MS));
        watch.tick(queued + HUNG_AFTER_MS + 600, false);
        assert_eq!(silent(&w, &watch, None, queued + HUNG_AFTER_MS + 600), None);
    }

    #[test]
    fn hidden_page_beats_and_a_wake_from_sleep_never_read_as_silence() {
        let t = 1_000_000;
        let mut w = WindowTrack::new();
        let mut watch = SilenceWatch::new();
        w.created(t);
        let mut at = t;
        for seq in 0..600 {
            at = t + 1_500 + seq * 2_000;
            w.beat(seq, 1.0, at);
            tick_through(&mut watch, at, at + 2_000, true);
            assert_eq!(silent(&w, &watch, None, at + 1_999), None);
        }
        let woke = at + 3_600_000;
        watch.tick(woke, true);
        assert_eq!(silent(&w, &watch, None, woke), None);
        assert!(!hung(&in_flight(at), &w, &watch, woke));
        tick_through(&mut watch, woke, woke + HUNG_AFTER_MS + 300, true);
        assert_eq!(
            silent(&w, &watch, None, woke + HUNG_AFTER_MS + 1),
            Some(Silence::Stopped)
        );
        let mut fresh = WindowTrack::new();
        fresh.created(t);
        let mut slept = SilenceWatch::new();
        slept.tick(t, false);
        slept.tick(t + 25_000, false);
        assert_eq!(silent(&fresh, &slept, None, t + 31_000), None);
        assert_eq!(
            silent(&fresh, &slept, None, t + 25_001 + FIRST_BEAT_WITHIN_MS),
            Some(Silence::NoFirstBeat)
        );
    }

    /// The scenario C failure: every new window stays silent. Each one is recycled through the same backoff, and the fourth stall wedges.
    #[test]
    fn silent_windows_recycle_through_the_backoff_then_wedge_until_retry() {
        let t = 1_000_000;
        let mut r = RecycleState::new();
        let mut w = WindowTrack::new();
        let mut watch = SilenceWatch::new();
        let mut alive = false;
        let mut outcomes: Vec<(u64, StallOutcome)> = Vec::new();
        let mut now = t;
        while now < t + 600_000 && !r.wedged(now) {
            watch.tick(now, true);
            if !alive && !r.window_blocked(now) {
                w.created(now);
                alive = true;
            }
            if alive && silent(&w, &watch, None, now).is_some() {
                outcomes.push((now, r.stall(now, "silent", true)));
                alive = false;
            }
            now += 300;
        }
        let backoffs: Vec<Option<u64>> = outcomes.iter().map(|(_, o)| o.retry_after_ms).collect();
        assert_eq!(backoffs, [Some(0), Some(15_000), Some(60_000), None]);
        let (at, last) = outcomes[3];
        assert!(last.wedged && !last.recycled);
        let bound = 4 * FIRST_BEAT_WITHIN_MS + 90_000;
        assert!(
            at - t < bound,
            "wedged within {bound} ms, not {} ms",
            at - t
        );
        assert_eq!(
            (r.total, r.last.as_ref().map(|l| l.1.as_str())),
            (3, Some("silent"))
        );
        assert!(r.window_blocked(at + 300_000));
        r.reset();
        assert!(!r.wedged(at + 300_000) && !r.window_blocked(at + 300_000));
        assert_eq!(
            r.stall(at + 300_000, "silent", true).retry_after_ms,
            Some(0)
        );
    }

    fn touch(path: &Path, bytes: usize, mtime: u64) {
        std::fs::write(path, vec![b'x'; bytes]).unwrap();
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_millis(mtime))
            .unwrap();
    }

    fn answer(dir: &Path, id: &str, pid: Option<u32>, mtime: u64) {
        let body = match pid {
            Some(pid) => json!({ "id": id, "servedBy": { "pid": pid } }),
            None => json!({ "id": id }),
        };
        std::fs::write(dir.join(format!("{id}.json")), body.to_string()).unwrap();
        let file = std::fs::File::options()
            .write(true)
            .open(dir.join(format!("{id}.json")))
            .unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_millis(mtime))
            .unwrap();
    }

    #[test]
    fn responses_prune_by_ttl_size_owner_and_minimum_age() {
        let dir =
            std::env::temp_dir().join(format!("kookaburra-capture-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let now = 10_000_000_000u64;
        let hour = RESPONSE_TTL_MS;
        answer(&dir, "0001-1-old", Some(7), now - hour - 1);
        touch(&dir.join("0001-1-old.png"), 10, now - hour - 1);
        touch(&dir.join("0001-1-old-1.png"), 10, now - hour - 1);
        touch(&dir.join("0001-1-old-sheet.png"), 10, now - hour - 1);
        answer(&dir, "0002-1-foreign", Some(8), now - hour - 1);
        answer(&dir, "0003-1-dead", Some(9), now - hour - 1);
        answer(&dir, "0004-1-legacy", None, now - hour - 1);
        answer(&dir, "0005-1-big", Some(7), now - 600_000);
        touch(&dir.join("0005-1-big.png"), 6_000, now - 600_000);
        answer(&dir, "0006-1-newer", Some(7), now - 300_000);
        touch(&dir.join("0006-1-newer.png"), 6_000, now - 300_000);
        touch(&dir.join("0007-1-123456.png"), 9_000, now - 60_000);
        touch(&dir.join("0007-1-123456-1.png"), 9_000, now - 1_000);
        let limits = PruneLimits {
            ttl_ms: hour,
            cap_bytes: 25_000,
            min_age_ms: RESPONSE_MIN_AGE_MS,
        };
        let alive = |pid: u32| pid == 7 || pid == 8;
        let removed = prune_responses_at(&dir, 7, now, &limits, alive);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort_unstable();
        assert_eq!(
            left,
            [
                "0002-1-foreign.json",
                "0006-1-newer.json",
                "0006-1-newer.png",
                "0007-1-123456-1.png",
                "0007-1-123456.png"
            ]
        );
        assert_eq!(removed, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_group_by_their_response() {
        let ids = vec!["0001-2-abc".to_string()];
        let stems = vec!["0001-2-abc".to_string(), "0009-2-123456".to_string()];
        assert_eq!(group_key("0001-2-abc.json", &ids, &stems), "0001-2-abc");
        assert_eq!(group_key("0001-2-abc-12.png", &ids, &stems), "0001-2-abc");
        assert_eq!(
            group_key("0001-2-abc-sheet.png", &ids, &stems),
            "0001-2-abc"
        );
        assert_eq!(
            group_key("0001-2-abc.progress.json", &ids, &stems),
            "0001-2-abc"
        );
        assert_eq!(
            group_key("0009-2-123456.png", &ids, &stems),
            "0009-2-123456"
        );
        assert_eq!(
            group_key("0009-2-123456-3.png", &ids, &stems),
            "0009-2-123456"
        );
        assert_eq!(
            group_key(".0001-2-abc.json.5.tmp", &ids, &stems),
            ".0001-2-abc.json.5.tmp"
        );
    }
}
