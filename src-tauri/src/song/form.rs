//! The song's form on the beat grid, from loudness and onset density alone: phrase length, parts named by their role (intro, build, peak, breakdown, outro; never verse or chorus, which nothing here can hear), fills, stop-time bars and the final hits. Bars run to the audible end, so trailing silence is never a section.

use serde_json::{json, Value};

use super::hits::{BandHits, Hit};
use super::structure::{zscore, SHORT_HOP_MS};

const PHRASE_LENGTHS: [usize; 2] = [8, 16];
/// A longer phrase wins only when its boundaries stand out this much more than the shorter one's.
const PHRASE_MARGIN: f64 = 1.25;
/// Below this share of the average bar-to-bar change, nothing marks a phrase.
const PHRASE_MIN_CONTRAST: f64 = 0.25;
/// Parts are judged against the song's loud level, the 75th percentile of its bars.
const BODY_PERCENTILE: f64 = 0.75;
const BREAKDOWN_DB: f64 = 6.0;
const SOFT_END_DB: f64 = 3.0;
const PEAK_DB: f64 = 1.5;
const BREAKDOWN_MIN_BARS: usize = 3;
const MIN_PART_BARS: usize = 2;
const STOP_MAX_BARS: usize = 2;
const STOP_NEIGHBOURS: usize = 4;
const STOP_GAP_DB: f64 = 12.0;
const STOP_MIN_QUIET: f64 = 0.4;
const STOP_MIN_CONTEXT_LUFS: f64 = -40.0;
const SLOT_MIN_STRENGTH: f64 = 0.3;
const FILL_CONTEXT_BARS: usize = 4;
const FILL_MIN_EXTRA_SLOTS: f64 = 3.0;
const FILL_MIN_RATIO: f64 = 1.5;
const FILL_BEAT_EXTRA_SLOTS: f64 = 1.5;
const FILL_RESOLVE_STRENGTH: f64 = 0.4;
const FINAL_MIN_STRENGTH: f64 = 0.5;
const FINAL_RUN_BARS: f64 = 2.0;
const LUFS_FLOOR: f64 = -70.0;

#[derive(Debug, Clone, Copy)]
pub struct Grid {
    pub offset_ms: f64,
    pub period_ms: f64,
    pub beats_per_bar: usize,
}

impl Grid {
    fn bar_ms(&self) -> f64 {
        self.period_ms * self.beats_per_bar as f64
    }

    fn slots_per_bar(&self) -> usize {
        self.beats_per_bar * 4
    }

    /// (0-based bar, 16th slot in the bar), the bar negative before bar 1.
    fn locate(&self, t_ms: f64) -> (i64, usize) {
        let per_bar = self.slots_per_bar() as i64;
        let n = ((t_ms - self.offset_ms) / (self.period_ms / 4.0)).round() as i64;
        (n.div_euclid(per_bar), n.rem_euclid(per_bar) as usize)
    }

    fn beat_ms(&self, bar: usize, beat: usize) -> f64 {
        self.offset_ms + (bar * self.beats_per_bar + beat) as f64 * self.period_ms
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Phrase {
    pub bars: usize,
    pub start_bar: i64,
    pub detected: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarStat {
    pub bar: i64,
    pub lufs: f64,
    pub onsets: usize,
    pub quiet: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
    pub from_bar: i64,
    pub to_bar: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Moment {
    pub id: String,
    pub kind: &'static str,
    pub ms: f64,
    pub bar: i64,
    pub to_bar: i64,
    pub band: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub phrase: Phrase,
    pub bars: Vec<BarStat>,
    pub parts: Vec<Part>,
    pub moments: Vec<Moment>,
}

impl Form {
    pub fn to_json(&self) -> Value {
        json!({
            "phrase": {
                "bars": self.phrase.bars,
                "startBar": self.phrase.start_bar,
                "detected": self.phrase.detected,
            },
            "bars": self.bars.iter().map(|b| json!({
                "bar": b.bar,
                "lufs": b.lufs,
                "onsets": b.onsets,
                "quiet": b.quiet,
            })).collect::<Vec<_>>(),
            "parts": self.parts.iter().map(|p| json!({
                "id": p.id,
                "label": p.label,
                "kind": p.kind,
                "fromBar": p.from_bar,
                "toBar": p.to_bar,
            })).collect::<Vec<_>>(),
            "moments": self.moments.iter().map(|m| json!({
                "id": m.id,
                "kind": m.kind,
                "ms": (m.ms * 10.0).round() / 10.0,
                "bar": m.bar,
                "toBar": m.to_bar,
                "band": m.band,
            })).collect::<Vec<_>>(),
        })
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn percentile(values: &[f64], p: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted
        .get((sorted.len().saturating_sub(1) as f64 * p).round() as usize)
        .copied()
        .unwrap_or(0.0)
}

/// 16th slots of each bar holding a hit at least `SLOT_MIN_STRENGTH` strong.
fn occupied(grid: &Grid, count: usize, hits: &[Hit]) -> Vec<Vec<bool>> {
    let mut slots = vec![vec![false; grid.slots_per_bar()]; count];
    for h in hits.iter().filter(|h| h.strength >= SLOT_MIN_STRENGTH) {
        let (bar, slot) = grid.locate(h.t_ms);
        if bar >= 0 && (bar as usize) < count {
            slots[bar as usize][slot] = true;
        }
    }
    slots
}

fn slot_counts(slots: &[Vec<bool>]) -> Vec<f64> {
    slots
        .iter()
        .map(|bar| bar.iter().filter(|s| **s).count() as f64)
        .collect()
}

/// The comb of bar-to-bar change: the phase whose bars change the most, and how far it stands above the average.
fn comb(change: &[f64], len: usize, overall: f64) -> (f64, usize) {
    let at = |phase: usize| -> f64 {
        let picked: Vec<f64> = (1..change.len())
            .filter(|b| b % len == phase)
            .map(|b| change[b])
            .collect();
        mean(&picked)
    };
    let mut best = (f64::MIN, 0);
    for phase in 0..len {
        let v = at(phase);
        if v > best.0 + 1e-9 {
            best = (v, phase);
        }
    }
    let mut phase = best.1;
    // A fill changes two bars (itself and the bar after); the phrase starts on the later one, and on bar 1 when that fits as well.
    if at((phase + 1) % len) >= best.0 * 0.9 {
        phase = (phase + 1) % len;
    }
    if at(0) >= best.0 * 0.9 {
        phase = 0;
    }
    (best.0 - overall, phase)
}

fn phrase_of(change: &[f64]) -> Phrase {
    let unknown = Phrase {
        bars: 4,
        start_bar: 1,
        detected: false,
    };
    if change.len() < 8 {
        return unknown;
    }
    let overall = mean(&change[1..]);
    if overall <= 1e-9 {
        return unknown;
    }
    let (mut contrast, mut phase) = comb(change, 4, overall);
    let mut bars = 4;
    for len in PHRASE_LENGTHS {
        if change.len() < len * 2 {
            break;
        }
        let (c, p) = comb(change, len, overall);
        if c >= contrast * PHRASE_MARGIN {
            (contrast, phase, bars) = (c, p, len);
        }
    }
    if contrast < overall * PHRASE_MIN_CONTRAST {
        return unknown;
    }
    Phrase {
        bars,
        start_bar: phase as i64 + 1,
        detected: true,
    }
}

/// Runs of at least `BREAKDOWN_MIN_BARS` bars well under the song's loud level: [start, end) in bars.
fn quiet_runs(lufs: &[f64], body: f64) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut b = 0;
    while b < lufs.len() {
        if lufs[b] > body - BREAKDOWN_DB {
            b += 1;
            continue;
        }
        let start = b;
        while b < lufs.len() && lufs[b] <= body - BREAKDOWN_DB {
            b += 1;
        }
        if b - start >= BREAKDOWN_MIN_BARS {
            runs.push((start, b));
        }
    }
    runs
}

/// Part boundaries: the novelty sections' starts, kept clear of the quiet runs, whose own edges always stand.
fn boundaries(section_starts: &[i64], runs: &[(usize, usize)], count: usize) -> Vec<usize> {
    let mut edges: Vec<usize> = runs.iter().flat_map(|&(a, b)| [a, b]).collect();
    edges.retain(|&e| e > 0 && e < count);
    let mut all = edges.clone();
    for &bar in section_starts {
        let at = bar - 1;
        if at <= 0 || at as usize >= count {
            continue;
        }
        let at = at as usize;
        if edges.iter().all(|&e| e.abs_diff(at) > MIN_PART_BARS)
            && !runs.iter().any(|&(a, b)| at > a && at < b)
        {
            all.push(at);
        }
    }
    all.push(0);
    all.sort_unstable();
    all.dedup();
    all
}

fn parts_of(
    section_starts: &[i64],
    lufs: &[f64],
    density: &[f64],
    body: f64,
    runs: &[(usize, usize)],
) -> Vec<Part> {
    let count = lufs.len();
    let starts = boundaries(section_starts, runs, count);
    if starts.len() < 2 {
        return Vec::new();
    }
    let dense = percentile(density, 0.5);
    let mut numbers = [0usize; 3];
    let mut out = Vec::new();
    for (i, &from) in starts.iter().enumerate() {
        let to = starts.get(i + 1).copied().unwrap_or(count);
        let level = percentile(&lufs[from..to], 0.5);
        let quiet = level <= body - BREAKDOWN_DB;
        let soft = level <= body - SOFT_END_DB;
        let (kind, slot) = if i == 0 && soft {
            ("intro", None)
        } else if i + 1 == starts.len() && soft {
            ("outro", None)
        } else if quiet {
            ("breakdown", Some(0))
        } else if level >= body - PEAK_DB && percentile(&density[from..to], 0.5) >= dense {
            ("peak", Some(1))
        } else {
            ("build", Some(2))
        };
        let (id, label) = match slot {
            None => {
                let mut name = kind.to_owned();
                name[..1].make_ascii_uppercase();
                (kind.to_owned(), name)
            }
            Some(s) => {
                numbers[s] += 1;
                let mut name = kind.to_owned();
                name[..1].make_ascii_uppercase();
                (
                    format!("{kind}-{}", numbers[s]),
                    format!("{name} {}", numbers[s]),
                )
            }
        };
        out.push(Part {
            id,
            label,
            kind,
            from_bar: from as i64 + 1,
            to_bar: to as i64 + 1,
        });
    }
    out
}

/// Bars with a gap in them while the bars around stay loud; a longer quiet stretch is a breakdown, not a stop, and the song's first and last bars have nothing to stop from or come back to.
fn stops_of(quiet: &[f64], runs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut stops: Vec<(usize, usize)> = Vec::new();
    for (b, &share) in quiet
        .iter()
        .enumerate()
        .take(quiet.len().saturating_sub(1))
        .skip(1)
    {
        let in_run = runs.iter().any(|&(a, z)| b >= a && b < z);
        if in_run || share < STOP_MIN_QUIET {
            continue;
        }
        match stops.last_mut() {
            Some(last) if last.1 == b => last.1 = b + 1,
            _ => stops.push((b, b + 1)),
        }
    }
    stops.retain(|&(a, z)| z - a <= STOP_MAX_BARS);
    stops
}

/// The loudness hops of one bar, cut off at the audible end.
fn bar_hops<'a>(grid: &Grid, short: &'a [f64], b: usize, end_ms: f64) -> &'a [f64] {
    let from = grid.offset_ms + b as f64 * grid.bar_ms();
    let to = (from + grid.bar_ms()).min(end_ms);
    let lo = ((from.max(0.0) / SHORT_HOP_MS) as usize).min(short.len());
    let hi = ((to.max(0.0) / SHORT_HOP_MS) as usize).clamp(lo, short.len());
    &short[lo..hi]
}

/// The share of each bar under the bars around it by `STOP_GAP_DB`.
fn quiet_shares(grid: &Grid, short: &[f64], count: usize, end_ms: f64) -> Vec<f64> {
    let level: Vec<f64> = (0..count)
        .map(|b| percentile(bar_hops(grid, short, b, end_ms), 0.5))
        .collect();
    (0..count)
        .map(|b| {
            let lo = b.saturating_sub(STOP_NEIGHBOURS);
            let hi = (b + STOP_NEIGHBOURS + 1).min(count);
            let around: Vec<f64> = (lo..hi).filter(|&n| n != b).map(|n| level[n]).collect();
            if around.is_empty() {
                return 0.0;
            }
            let context = percentile(&around, 0.75);
            let hops = bar_hops(grid, short, b, end_ms);
            if context < STOP_MIN_CONTEXT_LUFS || hops.is_empty() {
                return 0.0;
            }
            let gaps = hops.iter().filter(|&&v| v < context - STOP_GAP_DB).count();
            gaps as f64 / hops.len() as f64
        })
        .collect()
}

/// A bar busier than the bars before it by a clear margin, that hands over to a strong next downbeat. The fill starts on the first beat of the busy stretch ending the bar.
fn fills_of(
    grid: &Grid,
    band_slots: &[(&'static str, Vec<Vec<bool>>)],
    band_counts: &[Vec<f64>],
    full: &[Hit],
    runs: &[(usize, usize)],
    count: usize,
) -> Vec<(usize, usize, &'static str)> {
    let resolves = |bar: usize| -> bool {
        let at = grid.beat_ms(bar, 0);
        full.iter().any(|h| {
            h.strength >= FILL_RESOLVE_STRENGTH && (h.t_ms - at).abs() <= grid.period_ms / 8.0
        })
    };
    let mut out: Vec<(usize, usize, &'static str, f64)> = Vec::new();
    for b in 2..count.saturating_sub(1) {
        if runs.iter().any(|&(a, z)| b >= a && b < z) || !resolves(b + 1) {
            continue;
        }
        let mut best: Option<(usize, &'static str, f64)> = None;
        for ((band, slots), counts) in band_slots.iter().zip(band_counts) {
            let context = percentile(&counts[b.saturating_sub(FILL_CONTEXT_BARS)..b], 0.5);
            let here = counts[b];
            if here < context + FILL_MIN_EXTRA_SLOTS
                || here < context * FILL_MIN_RATIO
                || counts[b + 1] >= here
            {
                continue;
            }
            let extra = here - context;
            if best.is_some_and(|(_, _, e)| e >= extra) {
                continue;
            }
            let per_beat = context / grid.beats_per_bar as f64;
            let mut start = grid.beats_per_bar - 1;
            for beat in (0..grid.beats_per_bar).rev() {
                let busy = slots[b][beat * 4..(beat + 1) * 4]
                    .iter()
                    .filter(|s| **s)
                    .count();
                if (busy as f64) < per_beat + FILL_BEAT_EXTRA_SLOTS {
                    break;
                }
                start = beat;
            }
            best = Some((start, band, extra));
        }
        if let Some((beat, band, extra)) = best {
            out.push((b, beat, band, extra));
        }
    }
    out.into_iter()
        .map(|(b, beat, band, _)| (b, beat, band))
        .collect()
}

fn final_moments(grid: &Grid, full: &[Hit], end_ms: f64, count: usize) -> Vec<Moment> {
    let strong: Vec<Hit> = full
        .iter()
        .copied()
        .filter(|h| h.strength >= FINAL_MIN_STRENGTH && h.t_ms <= end_ms)
        .collect();
    let Some(&last) = strong.last() else {
        return Vec::new();
    };
    let mut first = last;
    for h in strong.iter().rev().skip(1) {
        if last.t_ms - h.t_ms > FINAL_RUN_BARS * grid.bar_ms() {
            break;
        }
        first = *h;
    }
    let bar_of = |t: f64| grid.locate(t).0 + 1;
    let to_bar = count as i64 + 1;
    let mut out = Vec::new();
    if first.t_ms < last.t_ms {
        out.push(Moment {
            id: "final-hits".to_owned(),
            kind: "final",
            ms: first.t_ms,
            bar: bar_of(first.t_ms),
            to_bar,
            band: None,
        });
    }
    out.push(Moment {
        id: "final-hit".to_owned(),
        kind: "final",
        ms: last.t_ms,
        bar: bar_of(last.t_ms),
        to_bar,
        band: None,
    });
    out
}

/// The form of a fitted track. `section_starts` are the novelty sections' first bars; `short` is the K-weighted 100 ms loudness every `SHORT_HOP_MS`.
pub fn analyse(
    grid: &Grid,
    section_starts: &[i64],
    short: &[f64],
    hits: &BandHits,
    audible_end_ms: f64,
) -> Option<Form> {
    if grid.period_ms <= 0.0 || grid.beats_per_bar == 0 || audible_end_ms <= grid.offset_ms {
        return None;
    }
    let count = ((audible_end_ms - grid.offset_ms) / grid.bar_ms()).ceil() as usize;
    if count == 0 {
        return None;
    }
    let quiet = quiet_shares(grid, short, count, audible_end_ms);
    let lufs: Vec<f64> = (0..count)
        .map(|b| {
            let span: Vec<f64> = bar_hops(grid, short, b, audible_end_ms)
                .iter()
                .map(|v| v.max(LUFS_FLOOR))
                .collect();
            if span.is_empty() {
                LUFS_FLOOR
            } else {
                mean(&span)
            }
        })
        .collect();
    let band_slots: Vec<(&'static str, Vec<Vec<bool>>)> = vec![
        ("full", occupied(grid, count, &hits.full)),
        ("low", occupied(grid, count, &hits.low)),
        ("mid", occupied(grid, count, &hits.mid)),
        ("high", occupied(grid, count, &hits.high)),
    ];
    let counts: Vec<Vec<f64>> = band_slots.iter().map(|(_, s)| slot_counts(s)).collect();
    let body = percentile(&lufs, BODY_PERCENTILE);
    let runs = quiet_runs(&lufs, body);
    let mut features: Vec<Vec<f64>> = std::iter::once(lufs.clone())
        .chain(counts.clone())
        .collect();
    for col in &mut features {
        zscore(col);
    }
    let change: Vec<f64> = (0..count)
        .map(|b| {
            if b == 0 {
                return 0.0;
            }
            features
                .iter()
                .map(|col| (col[b] - col[b - 1]).powi(2))
                .sum::<f64>()
                .sqrt()
        })
        .collect();
    let phrase = phrase_of(&change);
    let parts = parts_of(section_starts, &lufs, &counts[0], body, &runs);
    let mut moments = Vec::new();
    for (i, (b, beat, band)) in fills_of(grid, &band_slots, &counts, &hits.full, &runs, count)
        .into_iter()
        .enumerate()
    {
        moments.push(Moment {
            id: format!("fill-{}", i + 1),
            kind: "fill",
            ms: grid.beat_ms(b, beat),
            bar: b as i64 + 1,
            to_bar: b as i64 + 2,
            band: Some(band),
        });
    }
    for (i, (a, z)) in stops_of(&quiet, &runs).into_iter().enumerate() {
        moments.push(Moment {
            id: format!("stop-{}", i + 1),
            kind: "stop",
            ms: grid.beat_ms(a, 0),
            bar: a as i64 + 1,
            to_bar: z as i64 + 1,
            band: None,
        });
    }
    moments.extend(final_moments(grid, &hits.full, audible_end_ms, count));
    moments.sort_by(|a, b| a.ms.total_cmp(&b.ms));
    let bars = (0..count)
        .map(|b| BarStat {
            bar: b as i64 + 1,
            lufs: (lufs[b] * 10.0).round() / 10.0,
            onsets: counts[0][b] as usize,
            quiet: (quiet[b] * 100.0).round() / 100.0,
        })
        .collect();
    Some(Form {
        phrase,
        bars,
        parts,
        moments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRID: Grid = Grid {
        offset_ms: 0.0,
        period_ms: 500.0,
        beats_per_bar: 4,
    };

    fn hop_count(bars: usize) -> usize {
        (bars as f64 * GRID.bar_ms() / SHORT_HOP_MS) as usize
    }

    /// Steady music at `lufs` per bar, with kick, snare and eighth hats as full-band hits.
    fn song(lufs: &[f64]) -> (Vec<f64>, BandHits) {
        let mut short = Vec::new();
        for &l in lufs {
            short.extend(vec![l; hop_count(1)]);
        }
        let mut hits = BandHits::default();
        for (bar, &l) in lufs.iter().enumerate() {
            if l < -60.0 {
                continue;
            }
            for slot in (0..16).step_by(2) {
                let t = bar as f64 * GRID.bar_ms() + slot as f64 * 125.0;
                let strength = if slot % 8 == 0 { 0.9 } else { 0.4 };
                hits.full.push(Hit { t_ms: t, strength });
                if slot % 8 == 4 {
                    hits.mid.push(Hit {
                        t_ms: t,
                        strength: 0.8,
                    });
                }
                if slot % 8 == 0 {
                    hits.low.push(Hit {
                        t_ms: t,
                        strength: 0.9,
                    });
                }
            }
        }
        (short, hits)
    }

    fn end_of(bars: usize) -> f64 {
        bars as f64 * GRID.bar_ms()
    }

    #[test]
    fn a_fill_is_named_where_it_starts_and_the_downbeat_it_leads_to() {
        let (short, mut hits) = song(&[-14.0; 16]);
        for slot in 8..16 {
            hits.mid.push(Hit {
                t_ms: 7.0 * GRID.bar_ms() + slot as f64 * 125.0,
                strength: 0.8,
            });
        }
        hits.mid.sort_by(|a, b| a.t_ms.total_cmp(&b.t_ms));
        let form = analyse(&GRID, &[1], &short, &hits, end_of(16)).unwrap();
        let fills: Vec<&Moment> = form.moments.iter().filter(|m| m.kind == "fill").collect();
        assert_eq!(fills.len(), 1, "{:?}", form.moments);
        assert_eq!(fills[0].id, "fill-1");
        assert_eq!(fills[0].bar, 8);
        assert_eq!(fills[0].to_bar, 9);
        assert_eq!(fills[0].band, Some("mid"));
        assert_eq!(fills[0].ms, GRID.beat_ms(7, 2));
    }

    #[test]
    fn a_gap_in_a_loud_stretch_is_stop_time_but_a_long_lull_is_a_breakdown() {
        let mut lufs = vec![-14.0; 32];
        for l in &mut lufs[16..24] {
            *l = -28.0;
        }
        let (mut short, hits) = song(&lufs);
        let bar = hop_count(1);
        for v in &mut short[9 * bar + bar / 4..10 * bar] {
            *v = -60.0;
        }
        let form = analyse(&GRID, &[1, 17, 25], &short, &hits, end_of(32)).unwrap();
        let stops: Vec<&Moment> = form.moments.iter().filter(|m| m.kind == "stop").collect();
        assert_eq!(stops.len(), 1, "{:?}", form.moments);
        assert_eq!((stops[0].bar, stops[0].to_bar), (10, 11));
        let parts: Vec<(&str, i64, i64)> = form
            .parts
            .iter()
            .map(|p| (p.id.as_str(), p.from_bar, p.to_bar))
            .collect();
        assert_eq!(
            parts,
            [
                ("peak-1", 1, 17),
                ("breakdown-1", 17, 25),
                ("peak-2", 25, 33)
            ]
        );
        assert_eq!(form.parts[1].label, "Breakdown 1");
    }

    #[test]
    fn the_last_bar_ringing_out_is_not_stop_time() {
        let (mut short, hits) = song(&[-14.0; 12]);
        let bar = hop_count(1);
        for v in &mut short[11 * bar + bar / 4..12 * bar] {
            *v = -60.0;
        }
        let form = analyse(&GRID, &[1], &short, &hits, end_of(12)).unwrap();
        assert!(
            !form.moments.iter().any(|m| m.kind == "stop"),
            "{:?}",
            form.moments
        );
    }

    #[test]
    fn a_short_quiet_opening_is_not_stop_time() {
        let mut lufs = vec![-14.0; 12];
        lufs[0] = -40.0;
        let (mut short, hits) = song(&lufs);
        let bar = hop_count(1);
        for v in &mut short[bar / 4..bar] {
            *v = -60.0;
        }
        let form = analyse(&GRID, &[1], &short, &hits, end_of(12)).unwrap();
        assert!(
            !form.moments.iter().any(|m| m.kind == "stop"),
            "{:?}",
            form.moments
        );
    }

    #[test]
    fn one_quiet_bar_does_not_demote_a_peak() {
        let mut lufs = vec![-14.0; 24];
        for l in &mut lufs[8..16] {
            *l = -28.0;
        }
        lufs[3] = -60.0;
        let (short, hits) = song(&lufs);
        let form = analyse(&GRID, &[1, 9, 17], &short, &hits, end_of(24)).unwrap();
        assert_eq!(form.parts[0].id, "peak-1", "{:?}", form.parts);
    }

    #[test]
    fn a_soft_start_and_end_are_the_intro_and_outro() {
        let mut lufs = vec![-14.0; 24];
        for l in &mut lufs[..4] {
            *l = -26.0;
        }
        for l in &mut lufs[20..] {
            *l = -24.0;
        }
        let (short, hits) = song(&lufs);
        let form = analyse(&GRID, &[1], &short, &hits, end_of(24)).unwrap();
        let ids: Vec<&str> = form.parts.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["intro", "peak-1", "outro"]);
        assert_eq!(form.parts[0].label, "Intro");
    }

    #[test]
    fn a_steady_song_has_no_parts_and_assumes_four_bar_phrases() {
        let (short, hits) = song(&[-14.0; 16]);
        let form = analyse(&GRID, &[1], &short, &hits, end_of(16)).unwrap();
        assert!(form.parts.is_empty(), "{:?}", form.parts);
        assert_eq!(
            form.phrase,
            Phrase {
                bars: 4,
                start_bar: 1,
                detected: false
            }
        );
        assert!(!form
            .moments
            .iter()
            .any(|m| m.kind == "fill" || m.kind == "stop"));
    }

    #[test]
    fn phrases_come_from_where_the_bars_change() {
        let eight: Vec<f64> = (0..48)
            .map(|b| {
                if b % 8 == 7 {
                    2.0
                } else {
                    0.1 + (b % 3) as f64 * 0.01
                }
            })
            .collect();
        let phrase = phrase_of(&eight);
        assert_eq!((phrase.bars, phrase.detected), (8, true), "{phrase:?}");
        let four: Vec<f64> = (0..48)
            .map(|b| if b % 4 == 0 && b > 0 { 2.0 } else { 0.1 })
            .collect();
        let phrase = phrase_of(&four);
        assert_eq!(
            (phrase.bars, phrase.start_bar, phrase.detected),
            (4, 1, true),
            "{phrase:?}"
        );
        assert!(!phrase_of(&[0.0; 32]).detected);
    }

    #[test]
    fn the_final_hits_are_the_strong_ones_ending_the_song_and_silence_is_no_section() {
        let mut lufs = vec![-14.0; 16];
        lufs.extend([-120.0; 4]);
        let (short, hits) = song(&lufs);
        let form = analyse(&GRID, &[1], &short, &hits, end_of(16)).unwrap();
        assert_eq!(form.bars.len(), 16);
        let last = form.moments.last().unwrap();
        assert_eq!(last.id, "final-hit");
        assert_eq!(last.bar, 16);
        assert_eq!(last.to_bar, 17);
        let first = form.moments.iter().find(|m| m.id == "final-hits").unwrap();
        assert_eq!(first.bar, 14);
    }

    #[test]
    fn no_grid_or_no_sound_has_no_form() {
        let flat = Grid {
            period_ms: 0.0,
            ..GRID
        };
        assert!(analyse(&flat, &[], &[], &BandHits::default(), 1000.0).is_none());
        assert!(analyse(&GRID, &[], &[], &BandHits::default(), 0.0).is_none());
    }
}
