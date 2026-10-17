//! Photosensitive flash detection over a finished film (WCAG 2.3.1 general and red flash, ITU-R BT.1702), streamed one frame at a time so the export loop and `check flashes` share it. Approximate by design: frames fold into a 64-cell grid of linear-light means, each cell tracks its luminance and red swings, same-sign transitions within 66 ms group into one flash, and any 1 s with more than six opposing transitions over the area threshold fails. Contract: docs/agent-kit.md (Film checks and verify-export).

use serde::Serialize;
use serde_json::Value;

pub const REPORT_VERSION: u32 = 1;
/// Cells along the frame's long edge (16 px at 1024 wide, 60 px at 4K).
pub const GRID_LONG_EDGE: usize = 64;
/// WCAG's 341 x 256 px window at 1024 x 768, in cells; transposed in portrait.
const WINDOW_LONG: usize = 21;
const WINDOW_SHORT: usize = 16;
const GROUP_MS: f64 = 66.0;
const DELTA_L: f32 = 0.10;
const DARKER_MAX: f32 = 0.80;
/// A swing reverses only once the signal backs off this far from its extreme, so encoder noise never splits one.
const HYSTERESIS: f32 = 0.02;
const RED_RATIO: f32 = 0.8;
const RED_DUV: f32 = 0.2;
/// WCAG 2.0's red floor, (R - G - B) x 320 changing by more than 20, keeps near-black chroma noise out.
const RED_DELTA: f32 = 20.0 / 320.0;
const AREA_FAIL: f64 = 0.25;
const AREA_WARN: f64 = 0.15;
const FAIL_OVER: usize = 6;
const WARN_FROM: usize = 5;
/// Samples per cell edge before stride sampling starts (a 4K cell samples every third pixel).
const SAMPLES_PER_CELL_EDGE: usize = 16;
const D65_UV: (f32, f32) = (0.1978, 0.4683);

/// Which standards to judge against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Standards {
    pub wcag: bool,
    pub itu: bool,
}

impl Standards {
    pub const BOTH: Standards = Standards {
        wcag: true,
        itu: true,
    };

    /// `wcag`, `itu` or `both`.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "wcag" => Some(Self {
                wcag: true,
                itu: false,
            }),
            "itu" => Some(Self {
                wcag: false,
                itu: true,
            }),
            "both" => Some(Self::BOTH),
            _ => None,
        }
    }

    fn list(self) -> Vec<Std> {
        let mut out = Vec::new();
        if self.wcag {
            out.push(Std::Wcag);
        }
        if self.itu {
            out.push(Std::Itu);
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Std {
    Wcag,
    Itu,
}

impl Std {
    fn id(self) -> &'static str {
        match self {
            Std::Wcag => "wcag",
            Std::Itu => "itu",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Std::Wcag => "wcag-2.3.1",
            Std::Itu => "itu-bt1702",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    General,
    Red,
}

impl Kind {
    fn id(self) -> &'static str {
        match self {
            Kind::General => "general",
            Kind::Red => "red",
        }
    }
}

const KINDS: [Kind; 2] = [Kind::General, Kind::Red];

/// One flagged stretch of the film.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlashIssue {
    #[serde(rename = "type")]
    pub kind: String,
    pub standard: String,
    pub severity: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub tc: String,
    /// Filled by kb from the project timeline; null from the core.
    pub scene: Option<Value>,
    pub flashes_per_second: f64,
    pub area_pct: f64,
    /// Normalised `[x, y, w, h]` of the flashing cells, top-left origin.
    pub region: [f64; 4],
    pub delta_l: f64,
    pub hint: String,
}

/// The verdict: `ok` is false when any issue fails.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlashReport {
    pub version: u32,
    pub approximate: bool,
    pub standards: Vec<String>,
    pub source: String,
    pub fps: f64,
    pub frames: u64,
    pub grid: [usize; 2],
    pub ok: bool,
    pub issues: Vec<FlashIssue>,
    #[serde(skip_serializing_if = "is_zero")]
    pub skipped_frames: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// Per-cell swing tracker: an undirected start (lo/hi until the signal moves by the hysteresis), then a directed swing from `anchor` to the running extreme `peak`; a back-off past the hysteresis reverses it.
#[derive(Clone, Copy, Debug, Default)]
struct Tracker {
    started: bool,
    dir: i8,
    anchor: f32,
    anchor_rgb: [f32; 3],
    peak: f32,
    peak_rgb: [f32; 3],
    lo: f32,
    lo_rgb: [f32; 3],
    hi: f32,
    hi_rgb: [f32; 3],
    emitted: bool,
}

impl Tracker {
    /// Feeds one value; returns the swing's sign and amplitude the first frame it qualifies.
    fn update(&mut self, v: f32, rgb: [f32; 3], kind: Kind) -> Option<(i8, f32)> {
        if !self.started {
            *self = Tracker {
                started: true,
                lo: v,
                lo_rgb: rgb,
                hi: v,
                hi_rgb: rgb,
                ..Tracker::default()
            };
            return None;
        }
        if self.dir == 0 {
            if v < self.lo {
                self.lo = v;
                self.lo_rgb = rgb;
            }
            if v > self.hi {
                self.hi = v;
                self.hi_rgb = rgb;
            }
            if self.hi - self.lo < HYSTERESIS {
                return None;
            }
            if v >= self.hi {
                (self.dir, self.anchor, self.anchor_rgb) = (1, self.lo, self.lo_rgb);
            } else {
                (self.dir, self.anchor, self.anchor_rgb) = (-1, self.hi, self.hi_rgb);
            }
            (self.peak, self.peak_rgb) = (v, rgb);
        } else if (self.dir > 0 && v > self.peak) || (self.dir < 0 && v < self.peak) {
            (self.peak, self.peak_rgb) = (v, rgb);
        } else if (self.peak - v).abs() >= HYSTERESIS {
            (self.anchor, self.anchor_rgb) = (self.peak, self.peak_rgb);
            (self.peak, self.peak_rgb) = (v, rgb);
            self.dir = -self.dir;
            self.emitted = false;
        }
        if self.emitted || !self.qualifies(kind) {
            return None;
        }
        self.emitted = true;
        Some((self.dir, (self.peak - self.anchor).abs()))
    }

    fn qualifies(&self, kind: Kind) -> bool {
        let (a, b) = (self.anchor, self.peak);
        match kind {
            Kind::General => (b - a).abs() >= DELTA_L && a.min(b) < DARKER_MAX,
            Kind::Red => {
                let red_end = if b > a {
                    self.peak_rgb
                } else {
                    self.anchor_rgb
                };
                (b - a).abs() >= RED_DELTA
                    && red_ratio(red_end) >= RED_RATIO
                    && uv_distance(self.anchor_rgb, self.peak_rgb) > RED_DUV
            }
        }
    }
}

fn red_ratio(rgb: [f32; 3]) -> f32 {
    let sum = rgb[0] + rgb[1] + rgb[2];
    if sum <= 1e-6 {
        0.0
    } else {
        rgb[0] / sum
    }
}

/// CIE 1976 u'v' of linear BT.709 RGB; black reads as the D65 white point.
fn uv(rgb: [f32; 3]) -> (f32, f32) {
    let [r, g, b] = rgb;
    let x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    let d = x + 15.0 * y + 3.0 * z;
    if d <= 1e-5 {
        D65_UV
    } else {
        (4.0 * x / d, 9.0 * y / d)
    }
}

fn uv_distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (ua, va) = uv(a);
    let (ub, vb) = uv(b);
    ((ua - ub).powi(2) + (va - vb).powi(2)).sqrt()
}

/// Same-sign transitions of one standard and kind, unioned while they stay within 66 ms of the first.
#[derive(Clone, Debug)]
struct Group {
    first: u64,
    mask: Vec<bool>,
    delta: f32,
    open: bool,
}

/// A grouped flash transition that cleared the warning area.
#[derive(Clone, Debug)]
struct Event {
    frame: u64,
    sign: i8,
    area: f64,
    bbox: [usize; 4],
    delta: f32,
}

#[derive(Clone, Copy)]
struct Sample {
    offset: usize,
    cell: usize,
}

/// Streams frames into a flash report. Never panics: a zero-size detector or a short buffer is counted and skipped.
pub struct FlashDetector {
    width: usize,
    height: usize,
    fps: f64,
    standards: Vec<Std>,
    gw: usize,
    gh: usize,
    xs: Vec<Sample>,
    ys: Vec<Sample>,
    counts: Vec<f32>,
    luts: Vec<[f32; 256]>,
    sums: Vec<f32>,
    trackers: Vec<Tracker>,
    groups: Vec<Group>,
    events: Vec<Vec<Event>>,
    frames: u64,
    skipped: u64,
    pub source: String,
}

fn srgb_lut() -> [f32; 256] {
    let mut lut = [0.0f32; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let v = i as f64 / 255.0;
        *slot = if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        } as f32;
    }
    lut
}

fn power_lut() -> [f32; 256] {
    let mut lut = [0.0f32; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        *slot = (i as f64 / 255.0).powf(2.4) as f32;
    }
    lut
}

/// The cell grid for a frame: 64 along the long edge, the short edge in proportion, never more cells than pixels.
pub fn grid_for(width: u32, height: u32) -> (usize, usize) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let (gw, gh) = if w >= h {
        let short = ((GRID_LONG_EDGE * h) as f64 / w as f64).round() as usize;
        (GRID_LONG_EDGE, short.max(1))
    } else {
        let short = ((GRID_LONG_EDGE * w) as f64 / h as f64).round() as usize;
        (short.max(1), GRID_LONG_EDGE)
    };
    (gw.min(w), gh.min(h))
}

/// Sample positions along one axis: each cell's pixels at a stride that keeps about 16 per cell edge, centred in the stride.
fn axis_samples(pixels: usize, cells: usize, step: usize) -> (Vec<Sample>, Vec<usize>) {
    let mut samples = Vec::new();
    let mut per_cell = vec![0usize; cells];
    for (cell, count) in per_cell.iter_mut().enumerate() {
        let start = cell * pixels / cells;
        let end = ((cell + 1) * pixels / cells).max(start + 1).min(pixels);
        let span = end - start;
        let stride = (span / SAMPLES_PER_CELL_EDGE).max(1);
        let mut p = start + stride / 2;
        while p < end {
            samples.push(Sample {
                offset: p * step,
                cell,
            });
            *count += 1;
            p += stride;
        }
    }
    (samples, per_cell)
}

impl FlashDetector {
    pub fn new(width: u32, height: u32, fps: f64, standards: Standards) -> Self {
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            60.0
        };
        let standards = standards.list();
        let (gw, gh) = grid_for(width, height);
        let (w, h) = (width as usize, height as usize);
        let (xs, nx) = axis_samples(w, gw, 1);
        let (ys, ny) = axis_samples(h, gh, 1);
        let mut counts = Vec::with_capacity(gw * gh);
        for row in &ny {
            for col in &nx {
                counts.push((col * row).max(1) as f32);
            }
        }
        let luts = standards
            .iter()
            .map(|s| match s {
                Std::Wcag => srgb_lut(),
                Std::Itu => power_lut(),
            })
            .collect::<Vec<_>>();
        let cells = gw * gh;
        let keys = standards.len() * KINDS.len();
        FlashDetector {
            width: w,
            height: h,
            fps,
            gw,
            gh,
            xs,
            ys,
            counts,
            sums: vec![0.0; cells * standards.len() * 3],
            trackers: vec![Tracker::default(); cells * keys],
            groups: (0..keys * 2)
                .map(|_| Group {
                    first: 0,
                    mask: vec![false; cells],
                    delta: 0.0,
                    open: false,
                })
                .collect(),
            events: vec![Vec::new(); keys],
            luts,
            standards,
            frames: 0,
            skipped: 0,
            source: "export".to_owned(),
        }
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// One RGBA frame, rows top-down unless `bottom_up` (a GL readback).
    pub fn push_rgba(&mut self, data: &[u8], bottom_up: bool) {
        self.push(data, 4, bottom_up);
    }

    /// One packed RGB frame (ffmpeg `rgb24`).
    pub fn push_rgb(&mut self, data: &[u8], bottom_up: bool) {
        self.push(data, 3, bottom_up);
    }

    fn push(&mut self, data: &[u8], channels: usize, bottom_up: bool) {
        let needed = self.width * self.height * channels;
        if self.gw == 0 || data.len() < needed {
            self.skipped += 1;
            return;
        }
        self.sums.iter_mut().for_each(|s| *s = 0.0);
        let nstd = self.standards.len();
        let stride = nstd * 3;
        let row_bytes = self.width * channels;
        for y in &self.ys {
            let row = if bottom_up {
                self.height - 1 - y.offset
            } else {
                y.offset
            };
            let base = row * row_bytes;
            let cell_row = y.cell * self.gw;
            for x in &self.xs {
                let p = base + x.offset * channels;
                let (r, g, b) = (data[p] as usize, data[p + 1] as usize, data[p + 2] as usize);
                let cell = (cell_row + x.cell) * stride;
                for (s, lut) in self.luts.iter().enumerate() {
                    let at = cell + s * 3;
                    self.sums[at] += lut[r];
                    self.sums[at + 1] += lut[g];
                    self.sums[at + 2] += lut[b];
                }
            }
        }
        let frame = self.frames;
        let cells = self.gw * self.gh;
        let mut hits: Vec<(usize, usize, i8, f32)> = Vec::new();
        for cell in 0..cells {
            let n = self.counts[cell];
            for s in 0..nstd {
                let at = cell * stride + s * 3;
                let rgb = [
                    self.sums[at] / n,
                    self.sums[at + 1] / n,
                    self.sums[at + 2] / n,
                ];
                let l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                let red = (rgb[0] - rgb[1] - rgb[2]).max(0.0);
                for (k, kind) in KINDS.iter().enumerate() {
                    let key = s * KINDS.len() + k;
                    let v = if *kind == Kind::General { l } else { red };
                    if let Some((sign, delta)) =
                        self.trackers[key * cells + cell].update(v, rgb, *kind)
                    {
                        hits.push((key, cell, sign, delta));
                    }
                }
            }
        }
        self.close_groups(frame, false);
        for (key, cell, sign, delta) in hits {
            let g = &mut self.groups[key * 2 + usize::from(sign > 0)];
            if !g.open {
                g.open = true;
                g.first = frame;
                g.delta = 0.0;
            }
            g.mask[cell] = true;
            g.delta = g.delta.max(delta);
        }
        self.frames += 1;
    }

    fn group_frames(&self) -> f64 {
        GROUP_MS * self.fps / 1000.0
    }

    /// Closes groups whose window has passed (or all of them at the end), turning each into an event.
    fn close_groups(&mut self, frame: u64, all: bool) {
        let span = self.group_frames();
        for gi in 0..self.groups.len() {
            let g = &self.groups[gi];
            if !g.open || (!all && ((frame - g.first) as f64) <= span) {
                continue;
            }
            let key = gi / 2;
            let std = self.standards[key / KINDS.len()];
            let area = match std {
                Std::Wcag => self.window_area(&g.mask),
                Std::Itu => {
                    g.mask.iter().filter(|m| **m).count() as f64 / g.mask.len().max(1) as f64
                }
            };
            let bbox = self.bbox(&g.mask);
            let event = Event {
                frame: g.first,
                sign: if gi % 2 == 1 { 1 } else { -1 },
                area,
                bbox,
                delta: g.delta,
            };
            if area >= AREA_WARN {
                self.events[key].push(event);
            }
            let g = &mut self.groups[gi];
            g.open = false;
            g.mask.iter_mut().for_each(|m| *m = false);
        }
    }

    /// WCAG area: the best 21 x 16 cell window's coverage (16 x 21 in portrait), clamped to the grid.
    fn window_area(&self, mask: &[bool]) -> f64 {
        let (gw, gh) = (self.gw, self.gh);
        let (ww, wh) = if gw >= gh {
            (WINDOW_LONG.min(gw), WINDOW_SHORT.min(gh))
        } else {
            (WINDOW_SHORT.min(gw), WINDOW_LONG.min(gh))
        };
        let mut sat = vec![0u32; (gw + 1) * (gh + 1)];
        for y in 0..gh {
            for x in 0..gw {
                let v = u32::from(mask[y * gw + x]);
                sat[(y + 1) * (gw + 1) + x + 1] =
                    v + sat[y * (gw + 1) + x + 1] + sat[(y + 1) * (gw + 1) + x]
                        - sat[y * (gw + 1) + x];
            }
        }
        let mut best = 0u32;
        for y in 0..=gh - wh {
            for x in 0..=gw - ww {
                let at = |yy: usize, xx: usize| sat[yy * (gw + 1) + xx];
                let n = at(y + wh, x + ww) + at(y, x) - at(y, x + ww) - at(y + wh, x);
                best = best.max(n);
            }
        }
        f64::from(best) / (ww * wh).max(1) as f64
    }

    fn bbox(&self, mask: &[bool]) -> [usize; 4] {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for (i, _) in mask.iter().enumerate().filter(|(_, m)| **m) {
            let (x, y) = (i % self.gw, i / self.gw);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
        if x0 == usize::MAX {
            [0, 0, 0, 0]
        } else {
            [x0, y0, x1, y1]
        }
    }

    /// The report: every 1 s window judged, flagged windows merged into issues.
    pub fn finish(mut self) -> FlashReport {
        self.close_groups(self.frames, true);
        // The final flush closes groups in key order, not start order.
        for events in &mut self.events {
            events.sort_by_key(|e| e.frame);
        }
        let window = self.fps.round().max(1.0) as u64;
        let mut issues = Vec::new();
        for (key, events) in self.events.iter().enumerate() {
            let std = self.standards[key / KINDS.len()];
            let kind = KINDS[key % KINDS.len()];
            issues.extend(self.judge(events, window, std, kind));
        }
        issues.sort_by(|a, b| {
            a.start_ms
                .cmp(&b.start_ms)
                .then_with(|| a.standard.cmp(&b.standard))
                .then_with(|| a.kind.cmp(&b.kind))
        });
        FlashReport {
            version: REPORT_VERSION,
            approximate: true,
            standards: self.standards.iter().map(|s| s.name().to_owned()).collect(),
            source: self.source.clone(),
            fps: self.fps,
            frames: self.frames,
            grid: [self.gw, self.gh],
            ok: !issues.iter().any(|i| i.severity == "fail"),
            issues,
            skipped_frames: self.skipped,
        }
    }

    fn judge(&self, events: &[Event], window: u64, std: Std, kind: Kind) -> Vec<FlashIssue> {
        struct Span {
            fail: bool,
            count: usize,
            from: u64,
            to: u64,
            area: f64,
            bbox: [usize; 4],
            delta: f32,
        }
        let mut spans: Vec<Span> = Vec::new();
        for (i, start) in events.iter().enumerate() {
            let inside: Vec<&Event> = events[i..]
                .iter()
                .take_while(|e| e.frame < start.frame + window)
                .collect();
            let fail_count = alternations(&inside, AREA_FAIL);
            let warn_count = alternations(&inside, AREA_WARN);
            let fail = fail_count > FAIL_OVER;
            let warn = !fail && (fail_count >= WARN_FROM || warn_count > FAIL_OVER);
            if !fail && !warn {
                continue;
            }
            let by_count = fail || fail_count >= WARN_FROM;
            let (floor, count) = if by_count {
                (AREA_FAIL, fail_count)
            } else {
                (AREA_WARN, warn_count)
            };
            let counted: Vec<&&Event> = inside.iter().filter(|e| e.area >= floor).collect();
            let from = counted.first().map_or(start.frame, |e| e.frame);
            let to = counted.last().map_or(start.frame, |e| e.frame);
            let area = counted.iter().map(|e| e.area).fold(0.0, f64::max);
            let delta = counted.iter().map(|e| e.delta).fold(0.0, f32::max);
            let bbox = counted.iter().fold([usize::MAX, usize::MAX, 0, 0], |b, e| {
                [
                    b[0].min(e.bbox[0]),
                    b[1].min(e.bbox[1]),
                    b[2].max(e.bbox[2]),
                    b[3].max(e.bbox[3]),
                ]
            });
            match spans.last_mut() {
                Some(last) if from <= last.to + window => {
                    last.fail |= fail;
                    last.count = last.count.max(count);
                    last.to = last.to.max(to);
                    last.area = last.area.max(area);
                    last.delta = last.delta.max(delta);
                    last.bbox = [
                        last.bbox[0].min(bbox[0]),
                        last.bbox[1].min(bbox[1]),
                        last.bbox[2].max(bbox[2]),
                        last.bbox[3].max(bbox[3]),
                    ];
                }
                _ => spans.push(Span {
                    fail,
                    count,
                    from,
                    to,
                    area,
                    bbox,
                    delta,
                }),
            }
        }
        let ms = |frame: u64| (frame as f64 * 1000.0 / self.fps).round() as u64;
        spans
            .into_iter()
            .map(|s| {
                let start_ms = ms(s.from);
                let [x0, y0, x1, y1] = s.bbox;
                let region = if x0 == usize::MAX {
                    [0.0; 4]
                } else {
                    [
                        round3(x0 as f64 / self.gw as f64),
                        round3(y0 as f64 / self.gh as f64),
                        round3((x1 - x0) as f64 / self.gw as f64),
                        round3((y1 - y0) as f64 / self.gh as f64),
                    ]
                };
                FlashIssue {
                    kind: kind.id().to_owned(),
                    standard: std.id().to_owned(),
                    severity: if s.fail { "fail" } else { "warn" }.to_owned(),
                    start_ms,
                    end_ms: ms(s.to + 1),
                    tc: timecode(start_ms),
                    scene: None,
                    flashes_per_second: s.count as f64 / 2.0,
                    area_pct: (s.area * 1000.0).round() / 10.0,
                    region,
                    delta_l: round3(f64::from(s.delta)),
                    hint: hint(kind, s.fail, s.count).to_owned(),
                }
            })
            .collect()
    }
}

/// Opposing transitions among events at or over an area: a sign change counts, a repeat of the same sign does not.
fn alternations(events: &[&Event], floor: f64) -> usize {
    let mut count = 0;
    let mut last = 0i8;
    for e in events.iter().filter(|e| e.area >= floor) {
        if e.sign != last {
            count += 1;
            last = e.sign;
        }
    }
    count
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// `MM:SS.mmm` (minutes run past 59 on long films).
pub fn timecode(ms: u64) -> String {
    format!(
        "{:02}:{:02}.{:03}",
        ms / 60_000,
        (ms % 60_000) / 1000,
        ms % 1000
    )
}

fn hint(kind: Kind, fail: bool, count: usize) -> &'static str {
    match (kind, fail) {
        (Kind::Red, _) => {
            "avoid flashing saturated red: hold each state at least 334 ms, or soften the red"
        }
        (Kind::General, true) => {
            "hold each state at least 334 ms, or keep the change under 10% luminance"
        }
        (Kind::General, false) if (WARN_FROM..=FAIL_OVER).contains(&count) => {
            "close to the limit: slow it to at most 2 flashes a second"
        }
        (Kind::General, false) => {
            "close to the limit: keep the flashing area under 15% of the view, or slow it down"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 1024;
    const H: u32 = 576;

    /// The sRGB byte whose WCAG relative luminance is closest to `l`.
    fn grey_for(l: f64) -> u8 {
        let lut = srgb_lut();
        (0..=255u8)
            .min_by(|a, b| {
                let da = (f64::from(lut[*a as usize]) - l).abs();
                let db = (f64::from(lut[*b as usize]) - l).abs();
                da.partial_cmp(&db).unwrap()
            })
            .unwrap()
    }

    fn frame(w: u32, h: u32, paint: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let (w, h) = (w as usize, h as usize);
        let mut out = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = paint(x, y);
                let p = (y * w + x) * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
            }
        }
        out
    }

    /// A square wave between two frames: `period` frames per cycle, half in each state, after `lead` frames of A.
    fn strobe(
        w: u32,
        h: u32,
        a: &[u8],
        b: &[u8],
        period: usize,
        frames: usize,
        standards: Standards,
    ) -> FlashReport {
        let mut d = FlashDetector::new(w, h, 60.0, standards);
        for f in 0..frames {
            let on = (f % period) >= period / 2;
            d.push_rgba(if on { b } else { a }, false);
        }
        d.finish()
    }

    fn full(w: u32, h: u32, c: [u8; 3]) -> Vec<u8> {
        frame(w, h, |_, _| c)
    }

    fn severities(r: &FlashReport) -> Vec<(String, String, String)> {
        r.issues
            .iter()
            .map(|i| (i.standard.clone(), i.kind.clone(), i.severity.clone()))
            .collect()
    }

    #[test]
    fn full_frame_strobes_pass_up_to_three_a_second_and_fail_at_five() {
        let black = full(W, H, [0, 0, 0]);
        let white = full(W, H, [255, 255, 255]);
        for (hz, expect_ok, expect_warn) in [
            (1, true, false),
            (2, true, false),
            (3, true, true),
            (5, false, false),
        ] {
            let r = strobe(W, H, &black, &white, 60 / hz, 180, Standards::BOTH);
            assert_eq!(r.ok, expect_ok, "{hz} Hz: {:?}", r.issues);
            let warns = r.issues.iter().filter(|i| i.severity == "warn").count();
            assert_eq!(warns > 0, expect_warn, "{hz} Hz: {:?}", r.issues);
            if hz == 5 {
                let fail = r.issues.iter().find(|i| i.standard == "wcag").unwrap();
                assert_eq!(fail.kind, "general");
                assert_eq!(fail.flashes_per_second, 5.0);
                assert_eq!(fail.area_pct, 100.0);
                assert_eq!(fail.region, [0.0, 0.0, 1.0, 1.0]);
                assert!(fail.delta_l > 0.99);
                assert_eq!(fail.start_ms, 100);
                assert_eq!(fail.tc, "00:00.100");
                assert!(fail.end_ms >= 2900);
                assert!(r
                    .issues
                    .iter()
                    .any(|i| i.standard == "itu" && i.severity == "fail"));
            }
        }
        let calm = strobe(W, H, &black, &white, 30, 180, Standards::BOTH);
        assert!(calm.issues.is_empty(), "2 Hz control: {:?}", calm.issues);
        assert_eq!((calm.frames, calm.grid, calm.fps), (180, [64, 36], 60.0));
    }

    #[test]
    fn five_hertz_over_an_eighth_of_the_frame_passes_when_spread_and_fails_wcag_when_compact() {
        let grey = grey_for(0.2);
        let spread = |on: bool| {
            frame(W, H, move |x, y| {
                let lit = on && (x / 16) % 4 == 0 && (y / 16) % 2 == 0;
                if lit {
                    [255, 255, 255]
                } else {
                    [grey, grey, grey]
                }
            })
        };
        let r = strobe(
            W,
            H,
            &spread(false),
            &spread(true),
            12,
            120,
            Standards::BOTH,
        );
        assert!(r.issues.is_empty(), "spread: {:?}", r.issues);

        let compact = |on: bool| {
            frame(W, H, move |x, y| {
                let lit = on && x < 24 * 16 && y < 12 * 16;
                if lit {
                    [255, 255, 255]
                } else {
                    [grey, grey, grey]
                }
            })
        };
        let r = strobe(
            W,
            H,
            &compact(false),
            &compact(true),
            12,
            120,
            Standards::BOTH,
        );
        assert_eq!(
            severities(&r),
            [("wcag".into(), "general".into(), "fail".into())]
        );
        let issue = &r.issues[0];
        assert_eq!(issue.region, [0.0, 0.0, 0.375, 0.333]);
    }

    #[test]
    fn a_saturated_red_flash_fails_as_red_without_a_luminance_swing() {
        let red = full(W, H, [255, 0, 0]);
        let grey = grey_for(0.2126);
        let match_grey = full(W, H, [grey, grey, grey]);
        let r = strobe(W, H, &match_grey, &red, 12, 120, Standards::BOTH);
        assert!(!r.ok);
        assert_eq!(
            severities(&r),
            [
                ("itu".into(), "red".into(), "fail".into()),
                ("wcag".into(), "red".into(), "fail".into())
            ]
        );
        // Dark red against black stays under WCAG 2.0's red floor.
        let dark = full(W, H, [40, 0, 0]);
        let black = full(W, H, [0, 0, 0]);
        let r = strobe(W, H, &black, &dark, 12, 120, Standards::BOTH);
        assert!(r.issues.is_empty(), "{:?}", r.issues);
    }

    #[test]
    fn grey_steps_fail_only_when_the_change_and_the_darker_side_qualify() {
        let step = |a: f64, b: f64| {
            let (ga, gb) = (grey_for(a), grey_for(b));
            strobe(
                W,
                H,
                &full(W, H, [ga, ga, ga]),
                &full(W, H, [gb, gb, gb]),
                12,
                120,
                Standards::BOTH,
            )
        };
        let big = step(0.30, 0.42);
        assert!(!big.ok);
        assert!(big.issues.iter().all(|i| i.kind == "general"));
        assert!(step(0.30, 0.37).issues.is_empty());
        assert!(step(0.85, 0.97).issues.is_empty());
    }

    #[test]
    fn the_wcag_window_turns_upright_in_portrait() {
        let strip = |w: u32, h: u32| {
            move |on: bool| {
                frame(w, h, move |x, y| {
                    let lit = on && x < 4 * 16 && y < 21 * 16;
                    if lit {
                        [255, 255, 255]
                    } else {
                        [0, 0, 0]
                    }
                })
            }
        };
        let wcag = Standards::parse("wcag").unwrap();
        let portrait = strip(H, W);
        let r = strobe(H, W, &portrait(false), &portrait(true), 12, 120, wcag);
        assert_eq!(r.grid, [36, 64]);
        assert_eq!(
            severities(&r),
            [("wcag".into(), "general".into(), "fail".into())]
        );
        assert_eq!(r.issues[0].area_pct, 25.0);
        let landscape = strip(W, H);
        let r = strobe(W, H, &landscape(false), &landscape(true), 12, 120, wcag);
        assert_eq!(
            severities(&r),
            [("wcag".into(), "general".into(), "warn".into())]
        );
    }

    #[test]
    fn bottom_up_rows_read_the_same_picture() {
        let block = |on: bool, flip: bool| {
            frame(W, H, move |x, y| {
                let row = if flip { H as usize - 1 - y } else { y };
                let lit = on && x < 512 && row < 288;
                if lit {
                    [255, 255, 255]
                } else {
                    [0, 0, 0]
                }
            })
        };
        let run = |flip: bool, bottom_up: bool| {
            let mut d = FlashDetector::new(W, H, 60.0, Standards::BOTH);
            for f in 0..120 {
                d.push_rgba(&block(f % 12 >= 6, flip), bottom_up);
            }
            d.finish()
        };
        let top_down = run(false, false);
        assert!(!top_down.ok);
        assert_eq!(top_down.issues[0].region, [0.0, 0.0, 0.5, 0.5]);
        assert_eq!(run(true, true), top_down);
        let mirrored = run(false, true);
        assert_eq!(mirrored.issues[0].region, [0.0, 0.5, 0.5, 0.5]);
    }

    #[test]
    fn staggered_halves_group_into_one_flash() {
        let black = full(W, H, [0, 0, 0]);
        let white = full(W, H, [255, 255, 255]);
        let top = frame(
            W,
            H,
            |_, y| if y < 288 { [255, 255, 255] } else { [0, 0, 0] },
        );
        let bottom = frame(
            W,
            H,
            |_, y| if y < 288 { [0, 0, 0] } else { [255, 255, 255] },
        );
        let mut d = FlashDetector::new(W, H, 60.0, Standards::BOTH);
        for f in 0..120 {
            let phase = f % 12;
            let picture = match phase {
                0..=5 => &black,
                6 => &top,
                7..=11 => &white,
                _ => unreachable!(),
            };
            // The fall reaches the bottom half one frame late too.
            let picture = if phase == 0 && f > 0 {
                &bottom
            } else {
                picture
            };
            d.push_rgba(picture, false);
        }
        let r = d.finish();
        let wcag = r.issues.iter().find(|i| i.standard == "wcag").unwrap();
        assert_eq!((wcag.severity.as_str(), wcag.area_pct), ("fail", 100.0));
    }

    #[test]
    fn zero_sizes_short_buffers_and_bad_rates_never_panic() {
        let mut d = FlashDetector::new(0, 0, 60.0, Standards::BOTH);
        d.push_rgba(&[], false);
        d.push_rgb(&[1, 2, 3], true);
        let r = d.finish();
        assert_eq!(
            (r.ok, r.frames, r.skipped_frames, r.grid),
            (true, 0, 2, [0, 0])
        );

        let mut d = FlashDetector::new(64, 36, f64::NAN, Standards::BOTH);
        d.push_rgba(&[0; 10], false);
        d.push_rgba(&vec![0; 64 * 36 * 4], true);
        let r = d.finish();
        assert_eq!((r.fps, r.frames, r.skipped_frames), (60.0, 1, 1));

        let mut d = FlashDetector::new(1, 1, 0.0, Standards::BOTH);
        for f in 0..30 {
            d.push_rgb(
                if f % 2 == 0 {
                    &[0, 0, 0]
                } else {
                    &[255, 255, 255]
                },
                false,
            );
        }
        let r = d.finish();
        assert_eq!(r.grid, [1, 1]);
        assert!(!r.ok);

        let mut d = FlashDetector::new(1000, 1, 30.0, Standards::BOTH);
        d.push_rgb(&vec![9; 3000], false);
        assert_eq!(d.finish().grid, [64, 1]);
        assert_eq!(grid_for(3840, 2160), (64, 36));
        assert_eq!(grid_for(2160, 3840), (36, 64));
        assert_eq!(grid_for(10, 3), (10, 3));
        assert!(Standards::parse("ada").is_none());
    }

    #[test]
    fn the_report_serialises_in_the_contract_shape() {
        let black = full(64, 36, [0, 0, 0]);
        let white = full(64, 36, [255, 255, 255]);
        let mut r = strobe(64, 36, &black, &white, 12, 90, Standards::BOTH);
        r.source = "file".into();
        let v = serde_json::to_value(&r).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "approximate",
                "fps",
                "frames",
                "grid",
                "issues",
                "ok",
                "source",
                "standards",
                "version"
            ]
        );
        assert_eq!(
            v["standards"],
            serde_json::json!(["wcag-2.3.1", "itu-bt1702"])
        );
        let issue = v["issues"][0].as_object().unwrap();
        let mut keys: Vec<&str> = issue.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "areaPct",
                "deltaL",
                "endMs",
                "flashesPerSecond",
                "hint",
                "region",
                "scene",
                "severity",
                "standard",
                "startMs",
                "tc",
                "type"
            ]
        );
        assert!(issue["scene"].is_null());
        assert_eq!(timecode(3_723_456), "62:03.456");
    }

    /// `cargo test --release -- --ignored flashes_4k_cost` prints the per-frame cost.
    #[test]
    #[ignore]
    fn flashes_4k_cost() {
        let a = full(3840, 2160, [10, 20, 30]);
        let b = full(3840, 2160, [240, 230, 220]);
        let mut d = FlashDetector::new(3840, 2160, 60.0, Standards::BOTH);
        let start = std::time::Instant::now();
        for f in 0..120 {
            d.push_rgba(if f % 12 < 6 { &a } else { &b }, true);
        }
        let per = start.elapsed().as_secs_f64() * 1000.0 / 120.0;
        eprintln!("flash detector: {per:.2} ms per 4K RGBA frame");
        assert!(!d.finish().ok);
    }
}
