//! The song's shape on top of the beat grid: sections (Foote novelty over per-bar loudness, onset density and flux, so every boundary lands on a downbeat), breaths (silences and sharp dips in a K-weighted 100 ms loudness) and the stab histogram (where in the bar the hits fall).

use serde::Serialize;

use super::onset::pick_onset_peaks;

/// The breath detector's loudness hop and window (ms).
const BREATH_HOP_MS: f64 = 10.0;
const BREATH_WINDOW_MS: f64 = 100.0;
const BREATH_CONTEXT_MS: f64 = 3000.0;
const SILENCE_LUFS: f64 = -50.0;
const DIP_DB: f64 = 15.0;
/// A dip needs music around it: quieter context than this is a quiet passage, not a breath.
const DIP_CONTEXT_MIN_LUFS: f64 = -40.0;
const BREATH_MIN_MS: f64 = 150.0;
/// The novelty kernel's half-width (bars) and the closest two section starts may sit.
const SECTION_KERNEL_BARS: usize = 4;
const SECTION_MIN_BARS: usize = 4;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub from_bar: i64,
    /// Exclusive: the next section's first bar.
    pub to_bar: i64,
    /// The boundary's novelty, 0..1 (0 for the opening section).
    pub novelty: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breath {
    pub from_ms: f64,
    pub to_ms: f64,
    pub kind: &'static str,
}

/// The bar grid sections are measured on: bar 1 starts at `offset_ms`.
#[derive(Debug, Clone, Copy)]
pub struct Bars {
    pub offset_ms: f64,
    pub bar_ms: f64,
    pub count: usize,
}

impl Bars {
    pub fn new(offset_ms: f64, bar_ms: f64, duration_ms: f64) -> Self {
        let count = if bar_ms > 0.0 && duration_ms > offset_ms {
            ((duration_ms - offset_ms) / bar_ms).floor() as usize
        } else {
            0
        };
        Self {
            offset_ms,
            bar_ms,
            count,
        }
    }

    fn index_of(&self, t_ms: f64) -> Option<usize> {
        let i = ((t_ms - self.offset_ms) / self.bar_ms).floor();
        (i >= 0.0 && (i as usize) < self.count).then_some(i as usize)
    }
}

fn zscore(values: &mut [f64]) {
    let n = values.len() as f64;
    if n == 0.0 {
        return;
    }
    let mean = values.iter().sum::<f64>() / n;
    let sd = (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt();
    for v in values.iter_mut() {
        *v = if sd > 1e-12 { (*v - mean) / sd } else { 0.0 };
    }
}

/// Per-bar features: mean momentary loudness (LUFS, every 100 ms), onset count and onset flux.
fn bar_features(bars: &Bars, momentary: &[f64], strength: &[f64], hop_ms: f64) -> Vec<[f64; 3]> {
    let mut loud = vec![(0.0, 0.0); bars.count];
    for (i, &m) in momentary.iter().enumerate() {
        // ebur128 frame i closes the 400 ms window ending at (i + 1) * 100 ms.
        let centre = (i as f64 + 1.0) * 100.0 - 200.0;
        if let Some(b) = bars.index_of(centre) {
            loud[b].0 += m.max(-70.0);
            loud[b].1 += 1.0;
        }
    }
    let mut flux = vec![0.0; bars.count];
    for (i, &s) in strength.iter().enumerate() {
        if let Some(b) = bars.index_of(i as f64 * hop_ms) {
            flux[b] += s;
        }
    }
    let mut density = vec![0.0; bars.count];
    for p in pick_onset_peaks(strength, ((250.0 / hop_ms).round() as usize).max(2), 1.5) {
        if let Some(b) = bars.index_of(p as f64 * hop_ms) {
            density[b] += 1.0;
        }
    }
    let mut cols: [Vec<f64>; 3] = [
        loud.iter()
            .map(|&(sum, n)| if n > 0.0 { sum / n } else { -70.0 })
            .collect(),
        density,
        flux,
    ];
    for col in &mut cols {
        zscore(col);
    }
    (0..bars.count)
        .map(|b| [cols[0][b], cols[1][b], cols[2][b]])
        .collect()
}

fn similarity(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let d2: f64 = a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum();
    (-d2 / 6.0).exp()
}

/// Foote novelty at each bar boundary: a checkerboard kernel slid along the bar self-similarity diagonal.
fn novelty(features: &[[f64; 3]], half: usize) -> Vec<f64> {
    let n = features.len();
    let mut out = vec![0.0; n];
    for (b, slot) in out.iter_mut().enumerate() {
        let w = half.min(b).min(n - b);
        if w == 0 {
            continue;
        }
        let mut score = 0.0;
        let mut count = 0.0;
        for i in b - w..b + w {
            for j in b - w..b + w {
                let same_side = (i < b) == (j < b);
                let s = similarity(&features[i], &features[j]);
                score += if same_side { s } else { -s };
                count += 1.0;
            }
        }
        *slot = (score / count).max(0.0);
    }
    out
}

/// Sections over the bar grid, unlabelled: novelty peaks at least `SECTION_MIN_BARS` apart.
pub fn sections(bars: &Bars, momentary: &[f64], strength: &[f64], hop_ms: f64) -> Vec<Section> {
    if bars.count == 0 {
        return Vec::new();
    }
    let features = bar_features(bars, momentary, strength, hop_ms);
    let curve = novelty(&features, SECTION_KERNEL_BARS);
    let max = curve.iter().copied().fold(0.0, f64::max);
    let mut starts: Vec<(usize, f64)> = Vec::new();
    if max > 1e-9 {
        let mean = curve.iter().sum::<f64>() / curve.len() as f64;
        let threshold = mean.max(max * 0.3);
        let mut peaks: Vec<usize> = (1..curve.len())
            .filter(|&b| {
                let prev = curve[b - 1];
                let next = curve.get(b + 1).copied().unwrap_or(0.0);
                curve[b] >= threshold && curve[b] >= prev && curve[b] > next
            })
            .collect();
        peaks.sort_by(|&a, &b| curve[b].total_cmp(&curve[a]));
        for b in peaks {
            let clear = b >= SECTION_MIN_BARS
                && bars.count - b >= SECTION_MIN_BARS
                && starts
                    .iter()
                    .all(|&(s, _)| s.abs_diff(b) >= SECTION_MIN_BARS);
            if clear {
                starts.push((b, curve[b] / max));
            }
        }
    }
    starts.push((0, 0.0));
    starts.sort_by_key(|&(b, _)| b);
    starts
        .iter()
        .enumerate()
        .map(|(i, &(b, novelty))| Section {
            from_bar: b as i64 + 1,
            to_bar: starts.get(i + 1).map_or(bars.count, |&(n, _)| n) as i64 + 1,
            novelty: (novelty * 1000.0).round() / 1000.0,
        })
        .collect()
}

/// A biquad in direct form I.
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn step(&mut self, x0: f64) -> f64 {
        let y0 = self.b[0] * x0 + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x0, self.x[0]];
        self.y = [y0, self.y[0]];
        y0
    }
}

/// BS.1770 K-weighting at 48 kHz (the high shelf, then the RLB high-pass).
fn k_weight(samples: &[f32]) -> Vec<f64> {
    let mut shelf = Biquad {
        b: [
            1.535_124_859_586_97,
            -2.691_696_189_406_38,
            1.198_392_810_852_85,
        ],
        a: [-1.690_659_293_182_41, 0.732_480_774_215_85],
        x: [0.0; 2],
        y: [0.0; 2],
    };
    let mut high_pass = Biquad {
        b: [1.0, -2.0, 1.0],
        a: [-1.990_047_454_833_98, 0.990_072_250_366_21],
        x: [0.0; 2],
        y: [0.0; 2],
    };
    samples
        .iter()
        .map(|&s| high_pass.step(shelf.step(f64::from(s))))
        .collect()
}

/// Loudness (LUFS) of centred windows `window_ms` wide every `BREATH_HOP_MS`.
fn windowed_lufs(prefix: &[f64], sample_rate: f64, window_ms: f64) -> Vec<f64> {
    let n = prefix.len() - 1;
    let hop = (sample_rate * BREATH_HOP_MS / 1000.0) as usize;
    let half = (sample_rate * window_ms / 2000.0) as usize;
    (0..n / hop)
        .map(|i| {
            let c = i * hop + hop / 2;
            let lo = c.saturating_sub(half);
            let hi = (c + half).min(n);
            let ms = (prefix[hi] - prefix[lo]) / (hi - lo).max(1) as f64;
            if ms > 0.0 {
                -0.691 + 10.0 * ms.log10()
            } else {
                -120.0
            }
        })
        .collect()
}

/// Breaths: spans of at least `BREATH_MIN_MS` below -50 LUFS ("silence") or 15 dB under the surrounding 3 s ("dip"), never touching the track's ends. Expects 48 kHz (the K-weighting coefficients).
pub fn breaths(samples: &[f32], sample_rate: u32) -> Vec<Breath> {
    let weighted = k_weight(samples);
    let mut prefix = Vec::with_capacity(weighted.len() + 1);
    prefix.push(0.0);
    let mut acc = 0.0;
    for v in &weighted {
        acc += v * v;
        prefix.push(acc);
    }
    let rate = f64::from(sample_rate);
    let short = windowed_lufs(&prefix, rate, BREATH_WINDOW_MS);
    let context = windowed_lufs(&prefix, rate, BREATH_CONTEXT_MS);
    let kind_at = |i: usize| -> Option<&'static str> {
        if short[i] < SILENCE_LUFS {
            Some("silence")
        } else if context[i] >= DIP_CONTEXT_MIN_LUFS && short[i] <= context[i] - DIP_DB {
            Some("dip")
        } else {
            None
        }
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < short.len() {
        let Some(first) = kind_at(i) else {
            i += 1;
            continue;
        };
        let start = i;
        let mut silent = first == "silence";
        while i < short.len() {
            match kind_at(i) {
                Some(k) => {
                    silent |= k == "silence";
                    i += 1;
                }
                None => break,
            }
        }
        // A run of window centres widens by half a window each side to the quiet span itself.
        let from_ms = start as f64 * BREATH_HOP_MS + BREATH_HOP_MS / 2.0 - BREATH_WINDOW_MS / 2.0;
        let to_ms = (i - 1) as f64 * BREATH_HOP_MS + BREATH_HOP_MS / 2.0 + BREATH_WINDOW_MS / 2.0;
        if start > 0 && i < short.len() && to_ms - from_ms >= BREATH_MIN_MS {
            out.push(Breath {
                from_ms,
                to_ms,
                kind: if silent { "silence" } else { "dip" },
            });
        }
    }
    out
}

/// Where in the bar the hits fall: onset peaks weighted by strength, snapped to the nearest 16th of the grid, summed per bar position and normalised so the busiest slot is 1. `beats_per_bar * 4` slots (16 in 4/4).
pub fn stabs(
    strength: &[f64],
    hop_ms: f64,
    period_ms: f64,
    offset_ms: f64,
    beats_per_bar: usize,
) -> Vec<f64> {
    let slots = beats_per_bar.max(1) * 4;
    let mut hist = vec![0.0; slots];
    let peaks = pick_onset_peaks(strength, ((250.0 / hop_ms).round() as usize).max(2), 1.5);
    let max = peaks.iter().map(|&p| strength[p]).fold(0.0, f64::max);
    if max <= 0.0 || period_ms <= 0.0 {
        return hist;
    }
    let sixteenth = period_ms / 4.0;
    for p in peaks {
        let rel = strength[p] / max;
        if rel < 0.3 {
            continue;
        }
        let n = ((p as f64 * hop_ms - offset_ms) / sixteenth).round() as i64;
        hist[n.rem_euclid(slots as i64) as usize] += rel;
    }
    let top = hist.iter().copied().fold(0.0, f64::max);
    if top > 0.0 {
        for v in &mut hist {
            *v = (*v / top * 1000.0).round() / 1000.0;
        }
    }
    hist
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn noise(len: usize, amp: f32, seed: &mut u32) -> Vec<f32> {
        (0..len)
            .map(|_| {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 17;
                *seed ^= *seed << 5;
                amp * ((*seed as f32 / u32::MAX as f32) * 2.0 - 1.0)
            })
            .collect()
    }

    #[test]
    fn a_gap_in_the_music_is_a_silence_and_a_drop_is_a_dip() {
        let mut seed = 7;
        let sec = SR as usize;
        let mut x = noise(sec * 3, 0.3, &mut seed);
        x.extend(vec![0.0; sec * 2 / 5]);
        x.extend(noise(sec * 3, 0.3, &mut seed));
        x.extend(noise(sec / 4, 0.01, &mut seed));
        x.extend(noise(sec * 3, 0.3, &mut seed));
        let found = breaths(&x, SR);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].kind, "silence");
        assert!((found[0].from_ms - 3000.0).abs() <= 30.0, "{:?}", found[0]);
        assert!((found[0].to_ms - 3400.0).abs() <= 30.0, "{:?}", found[0]);
        assert_eq!(found[1].kind, "dip");
        assert!((found[1].from_ms - 6400.0).abs() <= 40.0, "{:?}", found[1]);
        assert!((found[1].to_ms - 6650.0).abs() <= 40.0, "{:?}", found[1]);
        let short_gap: Vec<f32> = noise(sec * 2, 0.3, &mut seed)
            .into_iter()
            .chain(vec![0.0; sec / 20])
            .chain(noise(sec * 2, 0.3, &mut seed))
            .collect();
        assert!(breaths(&short_gap, SR).is_empty());
        let leading: Vec<f32> = vec![0.0; sec]
            .into_iter()
            .chain(noise(sec * 2, 0.3, &mut seed))
            .collect();
        assert!(breaths(&leading, SR).is_empty());
    }

    #[test]
    fn the_stab_histogram_finds_the_offbeat_hits() {
        let hop_ms = 256.0 / 48.0;
        let period = 500.0;
        let mut s = vec![0.0; (16_000.0 / hop_ms) as usize];
        for bar in 0..8 {
            for (slot, amp) in [(0usize, 1.0), (6, 0.9), (10, 0.5)] {
                let t = 100.0 + bar as f64 * 2000.0 + slot as f64 * period / 4.0;
                s[(t / hop_ms).round() as usize] = amp;
            }
        }
        let hist = stabs(&s, hop_ms, period, 100.0, 4);
        assert_eq!(hist.len(), 16);
        assert_eq!(hist[0], 1.0);
        assert!((hist[6] - 0.9).abs() < 1e-9);
        assert!((hist[10] - 0.5).abs() < 1e-9);
        assert_eq!(hist.iter().filter(|&&v| v > 0.0).count(), 3);
    }

    #[test]
    fn sections_split_where_the_bars_change_character() {
        let hop_ms = 256.0 / 48.0;
        let bar_ms = 2000.0;
        let bars = Bars::new(0.0, bar_ms, 32.0 * bar_ms);
        assert_eq!(bars.count, 32);
        let mut strength = vec![0.0; (32.0 * bar_ms / hop_ms) as usize];
        let mut momentary = Vec::new();
        for i in 0..(32.0 * bar_ms / 100.0) as usize {
            momentary.push(if i * 100 < 16 * 2000 { -30.0 } else { -12.0 });
        }
        for b in 0..32 {
            let hits = if b < 16 { 4 } else { 16 };
            for h in 0..hits {
                let t = b as f64 * bar_ms + h as f64 * bar_ms / hits as f64 + 20.0;
                strength[(t / hop_ms).round() as usize] = if b < 16 { 0.3 } else { 1.0 };
            }
        }
        let found = sections(&bars, &momentary, &strength, hop_ms);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!((found[0].from_bar, found[0].to_bar), (1, 17));
        assert_eq!((found[1].from_bar, found[1].to_bar), (17, 33));
        assert_eq!(found[1].novelty, 1.0);
        assert!(sections(&Bars::new(0.0, 0.0, 1000.0), &[], &[], hop_ms).is_empty());
    }
}
