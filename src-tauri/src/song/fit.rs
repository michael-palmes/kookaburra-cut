//! The beat-grid fit: per predicted beat, the strongest local onset peak in a shrinking window, refined to sub-hop with a 3-point parabola, then a weighted least-squares line t = phase + k * period with a weak-peak gate and MAD outlier rejection. The guards catch the two errors a line fit cannot see in its own residual: an octave (P/2, 2P) and a grid locked half a beat out by loud off-beats. Downbeats come from the kick band when no tracker supplies them.

use super::onset::{onset_strength, rms_envelope, smooth3, ONSET_HOP};

/// Above this drift (ms) the track is not treated as one constant tempo.
pub const CONSTANT_TEMPO_MAX_DRIFT_MS: f64 = 15.0;
/// The running-mean length (beats) that separates real drift from single-beat jitter.
const DRIFT_WINDOW: usize = 8;
const KICK_CUTOFF_HZ: f64 = 150.0;
/// Off-beats must out-weigh the beats by this much in the kick band before the grid moves.
const HALF_BEAT_MARGIN: f64 = 1.5;
/// An in-range tempo wins when its contrast is at least half an out-of-range winner's.
const OCTAVE_RANGE_SHARE: f64 = 0.5;
const PREFERRED_BPM: (f64, f64) = (70.0, 170.0);
/// Onsets read a little early, so a beat detected this close before 0 is still the track's first.
pub const PHASE_EDGE_MS: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinePoint {
    pub k: i64,
    pub t: f64,
    pub w: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineFit {
    pub period_ms: f64,
    /// The first beat, in [-PHASE_EDGE_MS, period - PHASE_EDGE_MS): a track that opens on a beat keeps it.
    pub phase_ms: f64,
    pub residual_ms: f64,
    pub max_drift_ms: f64,
    /// The peaks the final line was fitted through (k counted from the normalised phase).
    pub points: Vec<LinePoint>,
}

impl LineFit {
    pub fn bpm(&self) -> f64 {
        60_000.0 / self.period_ms
    }

    pub fn constant_tempo(&self) -> bool {
        self.max_drift_ms <= CONSTANT_TEMPO_MAX_DRIFT_MS
    }

    pub fn beat_times(&self, duration_ms: f64) -> Vec<f64> {
        grid_times(self.period_ms, self.phase_ms, duration_ms)
    }
}

pub fn grid_times(period_ms: f64, phase_ms: f64, duration_ms: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut k = 0.0;
    loop {
        let t = phase_ms + k * period_ms;
        if t >= duration_ms {
            break;
        }
        out.push(t);
        k += 1.0;
    }
    out
}

/// Linear interpolation of the strength signal at a fractional hop index.
fn lerp_at(s: &[f64], x: f64) -> f64 {
    if s.is_empty() || x < 0.0 || x > (s.len() - 1) as f64 {
        return 0.0;
    }
    let i = x.floor() as usize;
    let f = x - i as f64;
    if i + 1 < s.len() {
        s[i] * (1.0 - f) + s[i + 1] * f
    } else {
        s[i]
    }
}

/// The strongest local maximum of `s` within `window` ms of `pred`, refined to sub-hop: (time ms, strength).
fn peak_near(s: &[f64], hop_ms: f64, pred: f64, window: f64) -> Option<(f64, f64)> {
    if s.len() < 3 {
        return None;
    }
    let lo = (((pred - window) / hop_ms).floor() as i64).max(1);
    let hi = (((pred + window) / hop_ms).ceil() as i64).min(s.len() as i64 - 2);
    let mut best: Option<usize> = None;
    let mut bv = 0.0;
    let mut i = lo;
    while i <= hi {
        let u = i as usize;
        if s[u] > bv && s[u] >= s[u - 1] && s[u] >= s[u + 1] {
            bv = s[u];
            best = Some(u);
        }
        i += 1;
    }
    let bi = best?;
    let (a, b, c) = (s[bi - 1], s[bi], s[bi + 1]);
    let d = a - 2.0 * b + c;
    let frac = if d < 0.0 { (0.5 * (a - c)) / d } else { 0.0 };
    Some(((bi as f64 + frac) * hop_ms, bv))
}

/// A tracked beat moved onto the strongest onset peak within `window` ms, sub-hop.
pub fn snap_to_onset(strength: &[f64], hop_ms: f64, t: f64, window: f64) -> Option<f64> {
    peak_near(strength, hop_ms, t, window).map(|(t, _)| t)
}

fn median(sorted: &[f64]) -> f64 {
    sorted[sorted.len() / 2]
}

/// The refinement (the research prototype's R2), seeded with a period and phase within about a quarter beat of the truth. None when fewer than four beats show a peak.
pub fn refine_grid_fit(
    strength: &[f64],
    hop_ms: f64,
    period_ms: f64,
    phase_ms: f64,
    duration_ms: f64,
) -> Option<LineFit> {
    let mut p = period_ms;
    let mut phi = phase_ms;
    let mut resid = 0.0;
    let mut keep: Vec<LinePoint> = Vec::new();
    let mut fitted = false;
    for w in [
        period_ms / 4.0,
        period_ms / 8.0,
        period_ms / 12.0,
        period_ms / 12.0,
    ] {
        let mut pts: Vec<LinePoint> = Vec::new();
        let mut k = 0i64;
        loop {
            let pred = phi + k as f64 * p;
            if pred > duration_ms {
                break;
            }
            if let Some((t, v)) = peak_near(strength, hop_ms, pred, w) {
                pts.push(LinePoint { k, t, w: v });
            }
            k += 1;
        }
        if pts.len() < 4 {
            break;
        }
        let mut weights: Vec<f64> = pts.iter().map(|q| q.w).collect();
        weights.sort_by(f64::total_cmp);
        let med = median(&weights);
        keep = pts.into_iter().filter(|q| q.w >= 0.25 * med).collect();
        for _ in 0..3 {
            let (mut sw, mut sk, mut st, mut skk, mut skt) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for q in &keep {
                let kf = q.k as f64;
                sw += q.w;
                sk += q.w * kf;
                st += q.w * q.t;
                skk += q.w * kf * kf;
                skt += q.w * kf * q.t;
            }
            let det = sw * skk - sk * sk;
            if det <= 0.0 {
                break;
            }
            p = (sw * skt - sk * st) / det;
            phi = (st - p * sk) / sw;
            fitted = true;
            let r: Vec<f64> = keep
                .iter()
                .map(|q| (q.t - (phi + q.k as f64 * p)).abs())
                .collect();
            let mut sorted = r.clone();
            sorted.sort_by(f64::total_cmp);
            let m = median(&sorted);
            let mad = if m == 0.0 { 0.5 } else { m };
            resid = (r.iter().map(|v| v * v).sum::<f64>() / r.len() as f64).sqrt();
            let limit = (3.0 * 1.4826 * mad).max(hop_ms / 2.0);
            keep = keep
                .into_iter()
                .zip(r)
                .filter(|(_, ri)| *ri <= limit)
                .map(|(q, _)| q)
                .collect();
        }
    }
    if !fitted || !(p.is_finite() && p > 0.0 && phi.is_finite()) {
        return None;
    }
    let n = ((phi + PHASE_EDGE_MS) / p).floor();
    let phase = phi - n * p;
    let shift = n as i64;
    let points: Vec<LinePoint> = keep
        .into_iter()
        .map(|q| LinePoint {
            k: q.k + shift,
            ..q
        })
        .collect();
    let max_drift_ms = max_drift(&points, p, phase);
    Some(LineFit {
        period_ms: p,
        phase_ms: phase,
        residual_ms: resid,
        max_drift_ms,
        points,
    })
}

/// The largest deviation of the local beat phase (a running mean of residuals over `DRIFT_WINDOW` fitted peaks) from the line.
fn max_drift(points: &[LinePoint], p: f64, phase: f64) -> f64 {
    let residuals: Vec<f64> = points
        .iter()
        .map(|q| q.t - (phase + q.k as f64 * p))
        .collect();
    if residuals.is_empty() {
        return 0.0;
    }
    let w = DRIFT_WINDOW.min(residuals.len());
    residuals
        .windows(w)
        .map(|win| (win.iter().sum::<f64>() / w as f64).abs())
        .fold(0.0, f64::max)
}

/// A least-squares line through tracked beat times (a tracker's 20 ms frames), each beat numbered from its predecessor in median intervals (so a skipped beat counts two): (period, phase in [0, period)).
pub fn line_through(times: &[f64]) -> Option<(f64, f64)> {
    if times.len() < 4 {
        return None;
    }
    let mut intervals: Vec<f64> = times
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|d| *d > 0.0)
        .collect();
    if intervals.is_empty() {
        return None;
    }
    intervals.sort_by(f64::total_cmp);
    let p0 = median(&intervals);
    let (mut n, mut sk, mut st, mut skk, mut skt) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut k = 0.0;
    for (i, &t) in times.iter().enumerate() {
        if i > 0 {
            k += ((t - times[i - 1]) / p0).round().max(1.0);
        }
        n += 1.0;
        sk += k;
        st += t;
        skk += k * k;
        skt += k * t;
    }
    let det = n * skk - sk * sk;
    if det <= 0.0 {
        return None;
    }
    let p = (n * skt - sk * st) / det;
    let phi = (st - p * sk) / n;
    if !(p.is_finite() && p > 0.0) {
        return None;
    }
    Some((p, phi - ((phi + PHASE_EDGE_MS) / p).floor() * p))
}

/// Two one-pole low-pass passes, then the onset chain: a kick-band onset signal.
pub fn low_band_onset(samples: &[f32], sample_rate: u32) -> Vec<f64> {
    let a = (-2.0 * std::f64::consts::PI * KICK_CUTOFF_HZ / f64::from(sample_rate)).exp();
    let mut s1 = 0.0f64;
    let mut s2 = 0.0f64;
    let filtered: Vec<f32> = samples
        .iter()
        .map(|&x| {
            s1 = (1.0 - a) * f64::from(x) + a * s1;
            s2 = (1.0 - a) * s1 + a * s2;
            s2 as f32
        })
        .collect();
    smooth3(&onset_strength(&rms_envelope(&filtered, ONSET_HOP)))
}

/// The largest value of `s` within three hops of time `t`.
pub fn strength_near(s: &[f64], hop_ms: f64, t: f64) -> f64 {
    let c = (t / hop_ms).round() as i64;
    (c - 3..=c + 3)
        .filter(|&i| i >= 0 && (i as usize) < s.len())
        .map(|i| s[i as usize])
        .fold(0.0, f64::max)
}

fn wrap_phase(phase: f64, p: f64) -> f64 {
    phase - (phase / p).floor() * p
}

/// Mean strength on the grid minus mean strength half a period off it: how much the grid explains.
fn grid_contrast(s: &[f64], hop_ms: f64, p: f64, phase: f64, duration_ms: f64) -> f64 {
    let (mut on, mut off, mut n) = (0.0, 0.0, 0.0);
    let mut k = 0.0;
    loop {
        let t = phase + k * p;
        if t >= duration_ms {
            break;
        }
        on += lerp_at(s, t / hop_ms);
        off += lerp_at(s, (t + p / 2.0) / hop_ms);
        n += 1.0;
        k += 1.0;
    }
    if n == 0.0 {
        0.0
    } else {
        (on - off) / n
    }
}

/// The octave guard: of P/2, P and 2P (both phases for 2P), the grid with the best contrast, preferring 70 to 170 BPM when an in-range candidate comes close. Returns (period, phase).
pub fn octave_guard(
    strength: &[f64],
    hop_ms: f64,
    period_ms: f64,
    phase_ms: f64,
    duration_ms: f64,
) -> (f64, f64) {
    let mut candidates = vec![(period_ms, phase_ms)];
    if 60_000.0 / (period_ms / 2.0) <= 300.0 {
        candidates.push((period_ms / 2.0, wrap_phase(phase_ms, period_ms / 2.0)));
    }
    if 60_000.0 / (period_ms * 2.0) >= 30.0 {
        candidates.push((period_ms * 2.0, phase_ms));
        candidates.push((period_ms * 2.0, phase_ms + period_ms));
    }
    let scored: Vec<(f64, f64, f64)> = candidates
        .into_iter()
        .map(|(p, ph)| (p, ph, grid_contrast(strength, hop_ms, p, ph, duration_ms)))
        .collect();
    let in_range = |p: f64| {
        let bpm = 60_000.0 / p;
        bpm >= PREFERRED_BPM.0 && bpm <= PREFERRED_BPM.1
    };
    let best = scored
        .iter()
        .copied()
        .fold(scored[0], |b, c| if c.2 > b.2 { c } else { b });
    let pick = if in_range(best.0) {
        best
    } else {
        scored
            .iter()
            .copied()
            .filter(|c| in_range(c.0) && c.2 >= OCTAVE_RANGE_SHARE * best.2)
            .fold(None, |b: Option<(f64, f64, f64)>, c| match b {
                Some(b) if b.2 >= c.2 => Some(b),
                _ => Some(c),
            })
            .unwrap_or(best)
    };
    (pick.0, pick.1)
}

/// The half-beat guard: when the kick band lands clearly harder half a beat off the grid, the grid moves there.
pub fn half_beat_guard(
    low: &[f64],
    hop_ms: f64,
    period_ms: f64,
    phase_ms: f64,
    duration_ms: f64,
) -> Option<f64> {
    let (mut on, mut off) = (0.0, 0.0);
    for t in grid_times(period_ms, phase_ms, duration_ms) {
        on += strength_near(low, hop_ms, t);
        off += strength_near(low, hop_ms, t + period_ms / 2.0);
    }
    (off > 0.0 && off > on * HALF_BEAT_MARGIN)
        .then(|| wrap_phase(phase_ms + period_ms / 2.0, period_ms))
}

/// The DSP downbeat heuristic: the beat phase (mod `beats_per_bar`) carrying the most kick-band onset, plus the top 5% of full-band hits (crashes, drops).
pub fn downbeat_phase(
    full: &[f64],
    low: &[f64],
    hop_ms: f64,
    beats: &[f64],
    beats_per_bar: usize,
) -> usize {
    if beats.is_empty() || beats_per_bar < 2 {
        return 0;
    }
    let peaks: Vec<f64> = beats
        .iter()
        .map(|&t| strength_near(full, hop_ms, t))
        .collect();
    let mut sorted = peaks.clone();
    sorted.sort_by(|a, b| b.total_cmp(a));
    let strong_cut = sorted
        .get((sorted.len() as f64 * 0.05).floor() as usize)
        .copied()
        .unwrap_or(0.0);
    let mut scores = vec![0.0; beats_per_bar];
    for (k, &t) in beats.iter().enumerate() {
        let j = k % beats_per_bar;
        scores[j] += strength_near(low, hop_ms, t);
        if peaks[k] >= strong_cut {
            scores[j] += 0.5 * peaks[k];
        }
    }
    let mut best = 0;
    for j in 1..beats_per_bar {
        if scores[j] > scores[best] {
            best = j;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_through_jittered_frames_recovers_period_and_phase() {
        let p = 444.07;
        let times: Vec<f64> = (0..100)
            .map(|k| {
                let t = 213.7 + k as f64 * p;
                (t / 20.0).round() * 20.0
            })
            .collect();
        let (period, phase) = line_through(&times).unwrap();
        assert!((period - p).abs() < 0.05, "{period}");
        assert!((phase - 213.7).abs() < 6.0, "{phase}");
    }

    #[test]
    fn peak_near_interpolates_between_hops() {
        let s = [0.0, 0.0, 0.5, 1.0, 0.5, 0.0, 0.0];
        let (t, v) = peak_near(&s, 10.0, 30.0, 20.0).unwrap();
        assert!((t - 30.0).abs() < 1e-9);
        assert_eq!(v, 1.0);
        let s = [0.0, 0.0, 0.2, 1.0, 0.6, 0.0, 0.0];
        let (t, _) = peak_near(&s, 10.0, 30.0, 20.0).unwrap();
        assert!(t > 30.0 && t < 35.0, "{t}");
        assert!(peak_near(&[0.0; 7], 10.0, 30.0, 20.0).is_none());
    }

    #[test]
    fn drift_ignores_single_beat_jitter_but_sees_a_wander() {
        let jitter: Vec<LinePoint> = (0..64)
            .map(|k| LinePoint {
                k,
                t: k as f64 * 500.0 + if k % 2 == 0 { 6.0 } else { -6.0 },
                w: 1.0,
            })
            .collect();
        assert!(max_drift(&jitter, 500.0, 0.0) < 1.0);
        let wander: Vec<LinePoint> = (0..64)
            .map(|k| LinePoint {
                k,
                t: k as f64 * 500.0 + 30.0 * (k as f64 / 10.0).sin(),
                w: 1.0,
            })
            .collect();
        assert!(max_drift(&wander, 500.0, 0.0) > 20.0);
    }
}
