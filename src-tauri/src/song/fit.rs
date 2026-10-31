//! The beat-grid fit: per predicted beat, the strongest local onset peak in a shrinking window, refined to sub-hop with a 3-point parabola, then a weighted least-squares line t = phase + k * period with a weak-peak gate and MAD outlier rejection. The guards catch the two errors a line fit cannot see in its own residual: an octave (P/2, 2P) and a grid locked half a beat out by loud off-beats. Downbeats come from the kick band when no tracker supplies them.

use super::onset::{onset_strength, rms_envelope, smooth3, ONSET_HOP};

/// Above this drift (ms, one frame at 30 fps) the track is not treated as one constant tempo. kb's `model.MAX_GRID_DRIFT_MS` mirrors it.
pub const CONSTANT_TEMPO_MAX_DRIFT_MS: f64 = 33.0;
/// The running-mean length (beats) that separates real drift from single-beat jitter.
const DRIFT_WINDOW: usize = 8;
const KICK_CUTOFF_HZ: f64 = 150.0;
const INTERVAL_KEEP_SHARE: f64 = 0.25;
/// Under this, times sit on a period no better than chance would: the Rayleigh statistic, where 1.5 is a p of about 0.1.
const MIN_CLUSTERING: f64 = 1.5;
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

/// The line a tracker's beats agree on locally: the mean interval (those within a quarter of the median) and the circular mean phase. A beat skipped or doubled slips `line_through`'s count, and the whole line with it; this line never counts: (period, phase in [0, period)).
pub fn interval_line(times: &[f64]) -> Option<(f64, f64)> {
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
    let mid = median(&intervals);
    let kept: Vec<f64> = intervals
        .into_iter()
        .filter(|d| (d - mid).abs() <= mid * INTERVAL_KEEP_SHARE)
        .collect();
    let p = kept.iter().sum::<f64>() / kept.len() as f64;
    if !(p.is_finite() && p > 0.0) {
        return None;
    }
    let turn = 2.0 * std::f64::consts::PI / p;
    let (sin, cos) = times.iter().fold((0.0, 0.0), |(s, c), t| {
        (s + (t * turn).sin(), c + (t * turn).cos())
    });
    Some((p, wrap_phase(sin.atan2(cos) / turn, p)))
}

/// The vector sum of weighted times (t, weight) wrapped onto a period: large when they fall in step.
fn pull(points: &[(f64, f64)], period_ms: f64) -> f64 {
    let turn = 2.0 * std::f64::consts::PI / period_ms;
    let (sin, cos) = points.iter().fold((0.0, 0.0), |(s, c), (t, w)| {
        (s + w * (t * turn).sin(), c + w * (t * turn).cos())
    });
    sin.hypot(cos)
}

/// How far weighted times cluster on a period beyond chance. Half the period counts too: a tracker can read half time for a stretch, and a song's hits can favour the off-beat.
fn clustering(points: &[(f64, f64)], period_ms: f64) -> f64 {
    let squares: f64 = points.iter().map(|(_, w)| w * w).sum();
    if squares <= 0.0 {
        return 0.0;
    }
    pull(points, period_ms).max(pull(points, period_ms / 2.0)) / squares.sqrt()
}

/// Whether weighted times cluster on this period at all.
pub fn pulses_on(points: &[(f64, f64)], period_ms: f64) -> bool {
    clustering(points, period_ms) >= MIN_CLUSTERING
}

/// The candidate a tracker's own beats land on, if any. Residual and drift can't choose: a line picks its own peaks, and in dense music a false tempo finds peaks as tight as the true one's.
pub fn best_line(candidates: Vec<LineFit>, beats: &[f64]) -> Option<LineFit> {
    let beats: Vec<(f64, f64)> = beats.iter().map(|&t| (t, 1.0)).collect();
    candidates
        .into_iter()
        .map(|line| (clustering(&beats, line.period_ms), line))
        .filter(|(score, _)| *score >= MIN_CLUSTERING)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, line)| line)
}

/// How far a tracker's beats stray from a line and where, (ms, track ms): the running median over `DRIFT_WINDOW` beats with the tracker's steady lag taken out. A line's own drift can't show a slip in the song, since it picks the peaks nearest itself.
pub fn beat_stray(beats: &[f64], period_ms: f64) -> Option<(f64, f64)> {
    if beats.len() < DRIFT_WINDOW {
        return None;
    }
    let points: Vec<(f64, f64)> = beats.iter().map(|&t| (t, 1.0)).collect();
    let unit = if pull(&points, period_ms / 2.0) > pull(&points, period_ms) {
        period_ms / 2.0
    } else {
        period_ms
    };
    // Centred on the beats' own mean phase, so none sit on the wrap between plus and minus half a unit.
    let turn = 2.0 * std::f64::consts::PI / unit;
    let (sin, cos) = beats.iter().fold((0.0, 0.0), |(s, c), t| {
        (s + (t * turn).sin(), c + (t * turn).cos())
    });
    let centre = sin.atan2(cos) / turn;
    let residuals: Vec<f64> = beats
        .iter()
        .map(|t| wrap_phase(t - centre + unit / 2.0, unit) - unit / 2.0)
        .collect();
    let middle = |values: &[f64]| {
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        median(&sorted)
    };
    let lag = middle(&residuals);
    residuals
        .windows(DRIFT_WINDOW)
        .enumerate()
        .map(|(i, win)| ((middle(win) - lag).abs(), beats[i + DRIFT_WINDOW / 2]))
        .max_by(|a, b| a.0.total_cmp(&b.0))
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
    fn a_slipped_beat_tilts_the_counted_line_but_not_the_interval_line() {
        let mut times: Vec<f64> = (0..130).map(|k| 500.0 + k as f64 * 500.0).collect();
        // The tracker loses the plot through a breakdown: two beats land between grid lines, and one more goes missing.
        times[60] += 240.0;
        times[61] += 240.0;
        times.remove(90);
        times.remove(45);
        let (counted, _) = line_through(&times).unwrap();
        let (period, phase) = interval_line(&times).unwrap();
        assert!((period - 500.0).abs() < 0.5, "{period}");
        assert!(
            phase.abs() < 25.0 || (phase - 500.0).abs() < 25.0,
            "{phase}"
        );
        assert!(
            (counted - 500.0).abs() > (period - 500.0).abs(),
            "{counted} {period}"
        );
        assert!(interval_line(&[1.0, 2.0]).is_none());
    }

    fn line_at(period_ms: f64, residual_ms: f64) -> LineFit {
        LineFit {
            period_ms,
            phase_ms: 0.0,
            residual_ms,
            max_drift_ms: 0.0,
            points: Vec::new(),
        }
    }

    /// 20 ms tracker frames: `first` beats at `period`, then `rest` at `other`.
    fn two_speeds(period: f64, first: usize, other: f64, rest: usize) -> Vec<f64> {
        let mut at = 1600.0;
        let mut out = Vec::new();
        for k in 0..first + rest {
            out.push((at / 20.0_f64).round() * 20.0);
            at += if k < first { period } else { other };
        }
        out
    }

    #[test]
    fn a_tracker_that_drops_to_half_time_keeps_the_tempo_it_heard() {
        let beats = two_speeds(379.7, 120, 759.4, 140);
        let (counted, _) = line_through(&beats).unwrap();
        let (interval, _) = interval_line(&beats).unwrap();
        assert!((counted - 759.4).abs() > 100.0, "{counted}");
        assert!((interval - 759.4).abs() < 2.0, "{interval}");
        // The false line fits tighter, as it did on a real song.
        let best = best_line(
            vec![line_at(counted, 30.0), line_at(interval, 35.0)],
            &beats,
        )
        .unwrap();
        assert_eq!(best.period_ms, interval);
    }

    #[test]
    fn a_song_that_changes_tempo_has_no_line() {
        let beats = two_speeds(500.0, 120, 600.0, 100);
        let lines: Vec<LineFit> = [line_through(&beats), interval_line(&beats)]
            .into_iter()
            .flatten()
            .map(|(p, _)| line_at(p, 10.0))
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(best_line(lines, &beats).is_none());
        assert!(best_line(Vec::new(), &beats).is_none());
    }

    #[test]
    fn a_step_in_the_song_shows_in_the_beats_though_a_line_absorbs_it() {
        let beats: Vec<f64> = (0..125)
            .map(|k| {
                let t = 100.0 + k as f64 * 400.0 - if k >= 90 { 140.0 } else { 0.0 };
                (t / 20.0).round() * 20.0
            })
            .collect();
        let (period, _) = line_through(&beats).unwrap();
        let (stray, at) = beat_stray(&beats, period).unwrap();
        assert!(stray > 66.0, "{stray}");
        assert!(at > 20_000.0, "{at}");
        let steady: Vec<f64> = (0..125)
            .map(|k| ((100.0 + k as f64 * 400.0) / 20.0).round() * 20.0)
            .collect();
        assert!(beat_stray(&steady, 400.0).unwrap().0 < 10.0);
        assert!(beat_stray(&steady[..4], 400.0).is_none());
        let on_the_wrap: Vec<f64> = (0..125)
            .map(|k| 200.0 + k as f64 * 400.0 + if k % 2 == 0 { 10.0 } else { -10.0 })
            .collect();
        assert!(beat_stray(&on_the_wrap, 400.0).unwrap().0 < 25.0);
    }

    #[test]
    fn beats_in_half_time_are_no_stray() {
        let beats = two_speeds(379.7, 120, 759.4, 140);
        let (stray, _) = beat_stray(&beats, 759.4).unwrap();
        assert!(stray < 30.0, "{stray}");
    }

    #[test]
    fn times_pulse_on_their_period_and_noise_on_none() {
        let steady: Vec<(f64, f64)> = (0..60).map(|k| (k as f64 * 500.0, 1.0)).collect();
        assert!(pulses_on(&steady, 500.0));
        assert!(pulses_on(&steady, 1000.0), "half the period counts");
        assert!(!pulses_on(&steady, 613.0));
        let mut state = 12345u64;
        let noise: Vec<(f64, f64)> = (0..400)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((state >> 40) as f64 / 16777216.0 * 120_000.0, 1.0)
            })
            .collect();
        assert!(!pulses_on(&noise, 500.0));
        assert!(!pulses_on(&[], 500.0));
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
