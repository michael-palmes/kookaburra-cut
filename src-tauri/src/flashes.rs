//! Photosensitive flash detection over a finished film (WCAG 2.3.1 general and red flash, ITU-R BT.1702), streamed one frame at a time so the export loop and `check flashes` share it. Approximate by design: frames fold into a 64-cell grid of linear-light means, and flashes are counted per region, not across the frame. A region (every WCAG window position, or ITU's large windows and the whole frame) makes a transition when its mean swings and enough of its cells change by the threshold that way between the swing's two ends; more than six opposing transitions in any 1 s of one region fails. A moving object's leading and trailing edges cancel in a region's mean, so motion reads as at most one flash per pass. Contract: docs/agent-kit.md (Film checks and verify-export).

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

pub const REPORT_VERSION: u32 = 1;
/// Cells along the frame's long edge (16 px at 1024 wide, 60 px at 4K).
pub const GRID_LONG_EDGE: usize = 64;
/// WCAG's 341 x 256 px window at 1024 x 768, in cells; transposed in portrait.
const WINDOW_LONG: usize = 21;
const WINDOW_SHORT: usize = 16;
const DELTA_L: f32 = 0.10;
const DARKER_MAX: f32 = 0.80;
const RED_RATIO: f32 = 0.8;
const RED_DUV: f32 = 0.2;
/// WCAG 2.0's red floor, (R - G - B) x 320 changing by more than 20, keeps near-black chroma noise out.
const RED_DELTA: f32 = 20.0 / 320.0;
const AREA_FAIL: f32 = 0.25;
const AREA_WARN: f32 = 0.15;
/// A region's mean reverses once it backs off this share of the smallest swing that could count.
const MEAN_HYSTERESIS: f32 = 0.2;
const FAIL_OVER: usize = 6;
const WARN_FROM: usize = 5;
const LEVEL_WARN: u8 = 1;
const LEVEL_FAIL: u8 = 2;
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

    /// The per-cell change that counts: relative luminance for general flashes, (R - G - B) for red.
    fn delta(self) -> f32 {
        match self {
            Kind::General => DELTA_L,
            Kind::Red => RED_DELTA,
        }
    }

    fn signal(self, rgb: [f32; 3]) -> f32 {
        match self {
            Kind::General => luminance(rgb),
            Kind::Red => (rgb[0] - rgb[1] - rgb[2]).max(0.0),
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

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
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

/// Whether one cell changed enough between two moments, in the swing's direction, to count as flashing.
fn cell_qualifies(kind: Kind, before: [f32; 3], after: [f32; 3], dir: i8) -> bool {
    let change = (kind.signal(after) - kind.signal(before)) * f32::from(dir);
    if change < kind.delta() {
        return false;
    }
    match kind {
        Kind::General => luminance(before).min(luminance(after)) < DARKER_MAX,
        Kind::Red => {
            let red_end = if dir > 0 { after } else { before };
            red_ratio(red_end) >= RED_RATIO && uv_distance(before, after) > RED_DUV
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Still,
    Started,
    Extended,
}

/// A region's mean signal: an undirected start until it moves by the hysteresis, then a swing from `anchor` to the running extreme `peak`; backing off past the hysteresis starts the opposite swing.
#[derive(Clone, Copy, Debug, Default)]
struct Swing {
    started: bool,
    dir: i8,
    anchor: f32,
    anchor_frame: u64,
    peak: f32,
    lo: f32,
    lo_frame: u64,
    hi: f32,
    hi_frame: u64,
    peak_frame: u64,
}

impl Swing {
    fn update(&mut self, v: f32, frame: u64, hysteresis: f32) -> Step {
        if !self.started {
            *self = Swing {
                started: true,
                lo: v,
                hi: v,
                lo_frame: frame,
                hi_frame: frame,
                ..Swing::default()
            };
            return Step::Still;
        }
        if self.dir == 0 {
            if v < self.lo {
                (self.lo, self.lo_frame) = (v, frame);
            }
            if v > self.hi {
                (self.hi, self.hi_frame) = (v, frame);
            }
            if self.hi - self.lo < hysteresis {
                return Step::Still;
            }
            if v >= self.hi {
                (self.dir, self.anchor, self.anchor_frame) = (1, self.lo, self.lo_frame);
            } else {
                (self.dir, self.anchor, self.anchor_frame) = (-1, self.hi, self.hi_frame);
            }
            (self.peak, self.peak_frame) = (v, frame);
            return Step::Started;
        }
        if (self.dir > 0 && v > self.peak) || (self.dir < 0 && v < self.peak) {
            (self.peak, self.peak_frame) = (v, frame);
            return Step::Extended;
        }
        if (self.peak - v).abs() >= hysteresis {
            (self.anchor, self.anchor_frame) = (self.peak, self.peak_frame);
            (self.peak, self.peak_frame) = (v, frame);
            self.dir = -self.dir;
            return Step::Started;
        }
        Step::Still
    }
}

/// One counted transition of a region: its sign, how strongly it counted and what changed.
#[derive(Clone, Copy, Debug)]
struct Mark {
    frame: u64,
    sign: i8,
    level: u8,
    area: f32,
    delta: f32,
    bbox: [usize; 4],
}

/// A judged region: the WCAG window at one position, or one of ITU's large windows.
#[derive(Clone, Debug)]
struct Region {
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
    /// The cells an area share is measured against: the window itself for WCAG, the whole frame for ITU.
    reference: f64,
    swing: Swing,
    /// The frame of the current swing's mark, so a stronger reading upgrades it instead of adding another.
    open: Option<u64>,
    marks: VecDeque<Mark>,
}

#[derive(Clone, Debug)]
struct Span {
    fail: bool,
    count: usize,
    from: u64,
    to: u64,
    area: f32,
    bbox: [usize; 4],
    delta: f32,
}

/// One standard and kind: its regions and the stretches they flagged.
#[derive(Clone, Debug)]
struct Lane {
    std: Std,
    std_index: usize,
    kind: Kind,
    regions: Vec<Region>,
    spans: Vec<Span>,
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
    window: u64,
    standards: Vec<Std>,
    gw: usize,
    gh: usize,
    xs: Vec<Sample>,
    ys: Vec<Sample>,
    counts: Vec<f32>,
    luts: Vec<[f32; 256]>,
    sums: Vec<f32>,
    /// The last second of per-cell linear RGB per standard, so a swing compares each cell at its two ends.
    history: Vec<Vec<[f32; 3]>>,
    depth: u64,
    lanes: Vec<Lane>,
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

/// ITU windows step this far, in cells.
const ITU_STRIDE: usize = 4;

/// The regions a standard judges: every position of the WCAG window (upright in portrait); for ITU, the whole frame plus windows of three quarters, full-width halves and full-height halves, so a quarter of the screen flashing anywhere fits inside one.
fn regions_for(std: Std, gw: usize, gh: usize) -> Vec<Region> {
    let cells = (gw * gh) as f64;
    let region = |x0, y0, w, h, reference| Region {
        x0,
        y0,
        w,
        h,
        reference,
        swing: Swing::default(),
        open: None,
        marks: VecDeque::new(),
    };
    if gw == 0 || gh == 0 {
        return Vec::new();
    }
    let slide = |out: &mut Vec<Region>, ww: usize, wh: usize, step: usize, reference: f64| {
        let (ww, wh) = (ww.clamp(1, gw), wh.clamp(1, gh));
        let mut y0 = 0;
        loop {
            let mut x0 = 0;
            loop {
                out.push(region(x0, y0, ww, wh, reference));
                if x0 + ww >= gw {
                    break;
                }
                x0 = (x0 + step).min(gw - ww);
            }
            if y0 + wh >= gh {
                break;
            }
            y0 = (y0 + step).min(gh - wh);
        }
    };
    let mut out = Vec::new();
    match std {
        Std::Wcag => {
            let (ww, wh) = if gw >= gh {
                (WINDOW_LONG, WINDOW_SHORT)
            } else {
                (WINDOW_SHORT, WINDOW_LONG)
            };
            let (ww, wh) = (ww.min(gw), wh.min(gh));
            slide(&mut out, ww, wh, 1, (ww * wh) as f64);
        }
        Std::Itu => {
            out.push(region(0, 0, gw, gh, cells));
            slide(
                &mut out,
                (gw * 3).div_ceil(4),
                (gh * 3).div_ceil(4),
                ITU_STRIDE,
                cells,
            );
            slide(&mut out, gw, gh.div_ceil(2), ITU_STRIDE, cells);
            slide(&mut out, gw.div_ceil(2), gh, ITU_STRIDE, cells);
        }
    }
    out
}

/// A summed-area table over a grid of values, one row and column of zeros in front.
fn summed<T: Copy + Into<f64>>(values: &[T], gw: usize, gh: usize, out: &mut Vec<f64>) {
    out.clear();
    out.resize((gw + 1) * (gh + 1), 0.0);
    for y in 0..gh {
        let mut row = 0.0;
        for x in 0..gw {
            row += values[y * gw + x].into();
            out[(y + 1) * (gw + 1) + x + 1] = out[y * (gw + 1) + x + 1] + row;
        }
    }
}

fn rect_sum(sat: &[f64], gw: usize, r: &Region) -> f64 {
    let at = |y: usize, x: usize| sat[y * (gw + 1) + x];
    at(r.y0 + r.h, r.x0 + r.w) + at(r.y0, r.x0) - at(r.y0, r.x0 + r.w) - at(r.y0 + r.h, r.x0)
}

/// Opposing transitions among a region's marks at or over a level: a sign change counts, a repeat of the same sign does not.
fn alternations(marks: &VecDeque<Mark>, level: u8) -> usize {
    let mut count = 0;
    let mut last = 0i8;
    for m in marks.iter().filter(|m| m.level >= level) {
        if m.sign != last {
            count += 1;
            last = m.sign;
        }
    }
    count
}

fn union(a: [usize; 4], b: [usize; 4]) -> [usize; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

const EMPTY_BOX: [usize; 4] = [usize::MAX, usize::MAX, 0, 0];

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
        let window = fps.round().max(1.0) as u64;
        let depth = window + 1;
        let mut lanes = Vec::new();
        for (std_index, std) in standards.iter().enumerate() {
            for kind in KINDS {
                lanes.push(Lane {
                    std: *std,
                    std_index,
                    kind,
                    regions: regions_for(*std, gw, gh),
                    spans: Vec::new(),
                });
            }
        }
        FlashDetector {
            width: w,
            height: h,
            fps,
            window,
            gw,
            gh,
            xs,
            ys,
            counts,
            sums: vec![0.0; cells * standards.len() * 3],
            history: vec![vec![[0.0; 3]; cells * depth as usize]; standards.len()],
            depth,
            lanes,
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
        let slot = (frame % self.depth) as usize * cells;
        for cell in 0..cells {
            let n = self.counts[cell];
            for (s, history) in self.history.iter_mut().enumerate() {
                let at = cell * stride + s * 3;
                history[slot + cell] = [
                    self.sums[at] / n,
                    self.sums[at + 1] / n,
                    self.sums[at + 2] / n,
                ];
            }
        }
        let mut lanes = std::mem::take(&mut self.lanes);
        for lane in &mut lanes {
            self.judge_frame(lane, frame);
        }
        self.lanes = lanes;
        self.frames += 1;
    }

    /// The history slot holding `frame`, clamped to the oldest frame still held.
    fn slot_of(&self, frame: u64, now: u64) -> usize {
        let oldest = now.saturating_sub(self.depth - 1);
        (frame.max(oldest) % self.depth) as usize * self.gw * self.gh
    }

    fn judge_frame(&self, lane: &mut Lane, frame: u64) {
        let (gw, gh) = (self.gw, self.gh);
        let cells = gw * gh;
        let history = &self.history[lane.std_index];
        let now = self.slot_of(frame, frame);
        let kind = lane.kind;
        let signal: Vec<f32> = (0..cells).map(|c| kind.signal(history[now + c])).collect();
        let mut sat = Vec::new();
        summed(&signal, gw, gh, &mut sat);
        let warn_mean = kind.delta() * AREA_WARN;
        let fail_mean = kind.delta() * AREA_FAIL;
        // Per-cell qualification masks between an anchor frame and now, shared by every region anchored there.
        let mut masks: Vec<(u64, i8, Vec<f32>, Vec<f64>)> = Vec::new();
        for region in &mut lane.regions {
            let area = (region.w * region.h) as f64;
            // A swing's size and its cells are both judged per reference cell, so a large ITU window needs a quarter of the screen.
            let scale = (area / region.reference) as f32;
            let mean = (rect_sum(&sat, gw, region) / area) as f32;
            let step = region
                .swing
                .update(mean, frame, warn_mean * MEAN_HYSTERESIS / scale);
            if step == Step::Started {
                region.open = None;
            }
            let swing = region.swing;
            let open_level = region
                .open
                .and_then(|f| region.marks.back().filter(|m| m.frame == f))
                .map_or(0, |m| m.level);
            let moved = (swing.peak - swing.anchor).abs() * scale;
            if step != Step::Still && open_level < LEVEL_FAIL && moved >= warn_mean {
                let anchor = swing.anchor_frame.max(frame.saturating_sub(self.depth - 1));
                let key = masks
                    .iter()
                    .position(|(a, d, _, _)| *a == anchor && *d == swing.dir);
                let index = match key {
                    Some(i) => i,
                    None => {
                        let then = self.slot_of(anchor, frame);
                        let mask: Vec<f32> = (0..cells)
                            .map(|c| {
                                f32::from(u8::from(cell_qualifies(
                                    kind,
                                    history[then + c],
                                    history[now + c],
                                    swing.dir,
                                )))
                            })
                            .collect();
                        let mut msat = Vec::new();
                        summed(&mask, gw, gh, &mut msat);
                        masks.push((anchor, swing.dir, mask, msat));
                        masks.len() - 1
                    }
                };
                let (_, _, mask, msat) = &masks[index];
                let covered = (rect_sum(msat, gw, region) / region.reference) as f32;
                let level = if covered >= AREA_FAIL && moved >= fail_mean {
                    LEVEL_FAIL
                } else if covered >= AREA_WARN {
                    LEVEL_WARN
                } else {
                    0
                };
                if level > open_level {
                    let then = self.slot_of(anchor, frame);
                    let (mut bbox, mut delta) = (EMPTY_BOX, 0.0f32);
                    for y in region.y0..region.y0 + region.h {
                        for x in region.x0..region.x0 + region.w {
                            let c = y * gw + x;
                            if mask[c] > 0.5 {
                                bbox = union(bbox, [x, y, x + 1, y + 1]);
                                let change = (kind.signal(history[now + c])
                                    - kind.signal(history[then + c]))
                                .abs();
                                delta = delta.max(change);
                            }
                        }
                    }
                    let mark = Mark {
                        frame,
                        sign: swing.dir,
                        level,
                        area: covered,
                        delta,
                        bbox,
                    };
                    match region
                        .marks
                        .back_mut()
                        .filter(|m| Some(m.frame) == region.open)
                    {
                        Some(open) => {
                            *open = Mark {
                                frame: open.frame,
                                ..mark
                            }
                        }
                        None => {
                            region.marks.push_back(mark);
                            region.open = Some(frame);
                        }
                    }
                }
            }
            while region
                .marks
                .front()
                .is_some_and(|m| m.frame + self.window <= frame)
            {
                region.marks.pop_front();
            }
        }
        self.flag(lane, frame);
    }

    /// The frame's verdict from its regions' last second, folded into the lane's flagged stretches.
    fn flag(&self, lane: &mut Lane, frame: u64) {
        let mut worst: Option<Span> = None;
        for region in lane.regions.iter().filter(|r| r.marks.len() >= WARN_FROM) {
            let fail_count = alternations(&region.marks, LEVEL_FAIL);
            let warn_count = alternations(&region.marks, LEVEL_WARN);
            let fail = fail_count > FAIL_OVER;
            if !fail && fail_count < WARN_FROM && warn_count <= FAIL_OVER {
                continue;
            }
            let (level, count) = if fail || fail_count >= WARN_FROM {
                (LEVEL_FAIL, fail_count)
            } else {
                (LEVEL_WARN, warn_count)
            };
            let mut span = Span {
                fail,
                count,
                from: frame,
                to: 0,
                area: 0.0,
                bbox: EMPTY_BOX,
                delta: 0.0,
            };
            for m in region.marks.iter().filter(|m| m.level >= level) {
                span.from = span.from.min(m.frame);
                span.to = span.to.max(m.frame);
                span.area = span.area.max(m.area);
                span.delta = span.delta.max(m.delta);
                span.bbox = union(span.bbox, m.bbox);
            }
            worst = Some(match worst {
                None => span,
                Some(w) if w.fail && !span.fail => w,
                Some(w) if span.fail && !w.fail => span,
                Some(w) => Span {
                    fail: w.fail,
                    count: w.count.max(span.count),
                    from: w.from.min(span.from),
                    to: w.to.max(span.to),
                    area: w.area.max(span.area),
                    bbox: union(w.bbox, span.bbox),
                    delta: w.delta.max(span.delta),
                },
            });
        }
        let Some(span) = worst else {
            return;
        };
        match lane.spans.last_mut() {
            // The tail of a failing stretch reads as a warning while its last second runs out: not a new moment.
            Some(last) if last.fail && !span.fail && span.from <= last.to + self.window => {}
            Some(last) if span.from <= last.to + self.window => {
                last.fail |= span.fail;
                last.count = last.count.max(span.count);
                last.to = last.to.max(span.to);
                last.area = last.area.max(span.area);
                last.delta = last.delta.max(span.delta);
                last.bbox = union(last.bbox, span.bbox);
            }
            _ => lane.spans.push(span),
        }
    }

    /// The report: the lanes' flagged stretches as issues.
    pub fn finish(self) -> FlashReport {
        let ms = |frame: u64| (frame as f64 * 1000.0 / self.fps).round() as u64;
        let mut issues = Vec::new();
        for lane in &self.lanes {
            for s in &lane.spans {
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
                issues.push(FlashIssue {
                    kind: lane.kind.id().to_owned(),
                    standard: lane.std.id().to_owned(),
                    severity: if s.fail { "fail" } else { "warn" }.to_owned(),
                    start_ms,
                    end_ms: ms(s.to + 1),
                    tc: timecode(start_ms),
                    scene: None,
                    flashes_per_second: s.count as f64 / 2.0,
                    area_pct: (f64::from(s.area) * 1000.0).round() / 10.0,
                    region,
                    delta_l: round3(f64::from(s.delta)),
                    hint: hint(lane.kind, s.fail, s.count).to_owned(),
                });
            }
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

    // Motion cases run on a 256 x 144 frame: the same 64 x 36 grid with 4 px cells.
    const MW: u32 = 256;
    const MH: u32 = 144;

    fn film(frames: usize, paint: impl Fn(usize, usize, usize) -> [u8; 3]) -> FlashReport {
        let mut d = FlashDetector::new(MW, MH, 60.0, Standards::BOTH);
        for f in 0..frames {
            d.push_rgba(&frame(MW, MH, |x, y| paint(f, x / 4, y / 4)), false);
        }
        d.finish()
    }

    #[test]
    fn textured_tiles_flying_past_fast_are_motion_not_flashes() {
        let (light, dark) = (grey_for(0.6), grey_for(0.02));
        // Striped 12 x 16 cell tiles crossing the frame at two cells a frame (two screen widths a second).
        let tiles = |bands: usize| {
            film(180, move |f, cx, cy| {
                let band = (cy / 18).min(bands - 1);
                let x = (cx + 128 - (2 * f) % 64 - 32 * band) % 64;
                let row = if bands == 1 { cy + 8 } else { cy % 18 + 16 };
                let on_tile = x < 12 && (18..34).contains(&row);
                if on_tile && x % 4 != 1 {
                    [dark, dark, dark]
                } else {
                    [light, light, light]
                }
            })
        };
        let one = tiles(1);
        assert!(one.issues.is_empty(), "{:?}", one.issues);
        // Two rows of tiles half a period apart darken a window between them nearly four times a second: a warning at most.
        let two = tiles(2);
        assert!(two.ok, "{:?}", two.issues);
    }

    #[test]
    fn a_smooth_global_ramp_is_not_a_flash() {
        let levels: Vec<u8> = (0..180)
            .map(|f| {
                let t = (f % 60) as f64 / 60.0;
                let up = (f / 60) % 2 == 0;
                grey_for(0.02 + 0.88 * if up { t } else { 1.0 - t })
            })
            .collect();
        let r = film(180, |f, _, _| [levels[f], levels[f], levels[f]]);
        assert!(r.issues.is_empty(), "{:?}", r.issues);
    }

    #[test]
    fn a_dark_block_crossing_back_and_forth_flashes_only_past_three_a_second() {
        let (light, dark) = (grey_for(0.6), grey_for(0.02));
        let crossing = |per_second: f64| {
            film(180, move |f, cx, cy| {
                let phase = (f as f64 / 60.0 * per_second) % 2.0;
                let left = 48.0 * if phase < 1.0 { phase } else { 2.0 - phase };
                let x = cx as f64;
                if x >= left && x < left + 16.0 && (8..28).contains(&cy) {
                    [dark, dark, dark]
                } else {
                    [light, light, light]
                }
            })
        };
        let calm = crossing(2.0);
        assert!(calm.ok, "{:?}", calm.issues);
        assert!(
            calm.issues.iter().all(|i| i.severity == "warn"),
            "{:?}",
            calm.issues
        );
        let busy = crossing(4.0);
        assert!(
            !busy.ok,
            "four crossings a second over more than a quarter of the window"
        );
        assert!(busy
            .issues
            .iter()
            .any(|i| i.standard == "wcag" && i.severity == "fail" && i.area_pct > 25.0));
    }

    #[test]
    fn a_full_frame_four_hertz_swap_fails_both_standards() {
        let (light, dark) = (255u8, 0u8);
        let swap = film(120, |f, cx, _| {
            let state = (f * 8 / 60) % 2 == 1;
            let left = cx < 32;
            if left == state {
                [dark, dark, dark]
            } else {
                [light, light, light]
            }
        });
        let fails: Vec<(String, String)> = swap
            .issues
            .iter()
            .filter(|i| i.severity == "fail")
            .map(|i| (i.standard.clone(), i.kind.clone()))
            .collect();
        assert_eq!(
            fails,
            [
                ("itu".to_owned(), "general".to_owned()),
                ("wcag".to_owned(), "general".to_owned())
            ]
        );
        let whole = film(120, |f, _, _| {
            let v = if (f * 8 / 60) % 2 == 1 { light } else { dark };
            [v, v, v]
        });
        assert!(!whole.ok);
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
