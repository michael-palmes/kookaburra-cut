//! The onset front end over mono PCM: RMS envelopes, the rectified-rise onset signal, the autocorrelation tempo estimate, the coarse grid phase and the key moments. A port of the webview's original `beatAnalysis.ts`, operation for operation, so the coarse stage behaves as it always has; the refinement in `fit.rs` takes over from here.

/// Samples per waveform-display hop (~21.3 ms at 48 kHz).
pub const ENVELOPE_HOP: usize = 1024;
/// Finer hop for onset and tempo work: a coarse hop quantises beat periods badly.
pub const ONSET_HOP: usize = 256;

const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 180.0;
/// Key moments closer together than this collapse to the strongest.
pub const KEY_MOMENT_MIN_GAP_MS: f64 = 1500.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyMoment {
    pub t_ms: f64,
    pub strength: f64,
}

/// Peak-normalised RMS envelope, one value per hop, 0..1.
pub fn rms_envelope(samples: &[f32], hop: usize) -> Vec<f64> {
    let hops = samples.len() / hop;
    let mut env: Vec<f64> = (0..hops)
        .map(|i| {
            let sum: f64 = samples[i * hop..(i + 1) * hop]
                .iter()
                .map(|&s| f64::from(s) * f64::from(s))
                .sum();
            (sum / hop as f64).sqrt()
        })
        .collect();
    let max = env.iter().copied().fold(0.0, f64::max);
    if max > 0.0 {
        for v in &mut env {
            *v /= max;
        }
    }
    env
}

/// Half-wave rectified rise of the envelope: energy arriving, the onset signal.
pub fn onset_strength(envelope: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; envelope.len()];
    for i in 1..envelope.len() {
        out[i] = (envelope[i] - envelope[i - 1]).max(0.0);
    }
    out
}

/// Triangular smoothing so near-hop-boundary onsets still correlate across periods.
pub fn smooth3(values: &[f64]) -> Vec<f64> {
    (0..values.len())
        .map(|i| {
            let prev = if i > 0 { values[i - 1] } else { values[i] };
            let next = values.get(i + 1).copied().unwrap_or(values[i]);
            0.25 * prev + 0.5 * values[i] + 0.25 * next
        })
        .collect()
}

/// The smoothed onset signal at `ONSET_HOP`.
#[cfg(test)]
pub fn onset_signal(samples: &[f32]) -> Vec<f64> {
    smooth3(&onset_strength(&rms_envelope(samples, ONSET_HOP)))
}

/// Indices that are local maxima above a sliding mean threshold.
pub fn pick_onset_peaks(strength: &[f64], window_hops: usize, bias: f64) -> Vec<usize> {
    let mut peaks = Vec::new();
    if strength.len() < 3 {
        return peaks;
    }
    for i in 1..strength.len() - 1 {
        let s = strength[i];
        if s <= 0.0 || s < strength[i - 1] || s <= strength[i + 1] {
            continue;
        }
        let lo = i.saturating_sub(window_hops);
        let hi = (i + window_hops).min(strength.len());
        let mean = strength[lo..hi].iter().sum::<f64>() / (hi - lo) as f64;
        if s > mean * bias + 0.005 {
            peaks.push(i);
        }
    }
    peaks
}

/// Dominant tempo via autocorrelation of onset strength with a log-Gaussian prior near 120 BPM, parabolic-refined; None when nothing periodic stands out.
pub fn estimate_tempo(strength: &[f64], hop_ms: f64) -> Option<f64> {
    if strength.len() < 3 {
        return None;
    }
    let min_lag = ((60_000.0 / (MAX_BPM * hop_ms)).floor() as usize).max(2);
    let max_lag = (strength.len() - 1).min((60_000.0 / (MIN_BPM * hop_ms)).ceil() as usize);
    if max_lag <= min_lag {
        return None;
    }
    let energy: f64 = strength.iter().map(|s| s * s).sum();
    if energy <= 0.0 {
        return None;
    }
    let acf_len = (strength.len() - 1).min(max_lag * 2);
    let mut acf = vec![0.0; acf_len + 1];
    for (lag, slot) in acf.iter_mut().enumerate().skip(min_lag) {
        let sum: f64 = (lag..strength.len())
            .map(|i| strength[i] * strength[i - lag])
            .sum();
        *slot = sum / energy;
    }
    let mut best_lag = 0usize;
    let mut best_score = 0.0;
    for lag in min_lag..=max_lag {
        let doubled = if lag * 2 <= acf_len {
            acf[lag * 2]
        } else {
            0.0
        };
        let prior = (-0.5 * ((lag as f64 * hop_ms) / 500.0).log2().powi(2)).exp();
        let score = (acf[lag] + 0.5 * doubled) * prior;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best_score < 0.05 {
        return None;
    }
    let a = acf.get(best_lag - 1).copied().unwrap_or(0.0);
    let b = acf[best_lag];
    let c = acf.get(best_lag + 1).copied().unwrap_or(0.0);
    let mut lag = best_lag as f64;
    let denom = a - 2.0 * b + c;
    if denom < 0.0 {
        lag += (0.5 * (a - c)) / denom;
    }
    Some(60_000.0 / (lag * hop_ms))
}

/// The coarse grid phase: the offset in [0, period) whose regular grid lands on the most onset strength.
pub fn align_phase(strength: &[f64], hop_ms: f64, bpm: f64, duration_ms: f64) -> f64 {
    let period_ms = 60_000.0 / bpm;
    let step = hop_ms / 2.0;
    let mut best_offset = 0.0;
    let mut best_score = -1.0;
    let mut offset = 0.0;
    while offset < period_ms {
        let mut score = 0.0;
        let mut t = offset;
        while t < duration_ms {
            let hop = (t / hop_ms).round() as usize;
            if let Some(s) = strength.get(hop) {
                score += s;
            }
            t += period_ms;
        }
        if score > best_score {
            best_score = score;
            best_offset = offset;
        }
        offset += step;
    }
    best_offset
}

/// Section-change signal: absolute difference of mean energy across adjacent ~2 s windows.
pub fn novelty_curve(envelope: &[f64], hop_ms: f64, window_ms: f64) -> Vec<f64> {
    let w = ((window_ms / hop_ms).round() as usize).max(1);
    let mut out = vec![0.0; envelope.len()];
    if envelope.len() < w * 2 {
        return out;
    }
    let mut prefix = vec![0.0; envelope.len() + 1];
    for i in 0..envelope.len() {
        prefix[i + 1] = prefix[i] + envelope[i];
    }
    for i in w..=envelope.len() - w {
        let before = (prefix[i] - prefix[i - w]) / w as f64;
        let after = (prefix[i + w] - prefix[i]) / w as f64;
        out[i] = (after - before).abs();
    }
    out
}

fn local_maxima(curve: &[f64], threshold: f64, min_gap_hops: usize) -> Vec<usize> {
    let mut picked: Vec<usize> = Vec::new();
    if curve.len() < 3 {
        return picked;
    }
    for i in 1..curve.len() - 1 {
        if curve[i] < threshold || curve[i] < curve[i - 1] || curve[i] <= curve[i + 1] {
            continue;
        }
        if let Some(last) = picked.last_mut() {
            if i - *last < min_gap_hops {
                if curve[i] > curve[*last] {
                    *last = i;
                }
                continue;
            }
        }
        picked.push(i);
    }
    picked
}

/// Greedy strongest-first spacing filter, returned in time order.
pub fn space_key_moments(moments: &[KeyMoment], min_gap_ms: f64) -> Vec<KeyMoment> {
    let mut by_strength = moments.to_vec();
    by_strength.sort_by(|m, n| n.strength.total_cmp(&m.strength));
    let mut kept: Vec<KeyMoment> = Vec::new();
    for m in by_strength {
        if kept.iter().all(|k| (k.t_ms - m.t_ms).abs() >= min_gap_ms) {
            kept.push(m);
        }
    }
    kept.sort_by(|m, n| m.t_ms.total_cmp(&n.t_ms));
    kept
}

/// Key moments: strong onsets plus energy-shift novelty peaks, spaced and strength-normalised (3 dp).
pub fn detect_key_moments(envelope: &[f64], strength: &[f64], hop_ms: f64) -> Vec<KeyMoment> {
    let mut candidates = Vec::new();
    let peaks = pick_onset_peaks(strength, ((500.0 / hop_ms).round() as usize).max(2), 1.5);
    let max_onset = peaks.iter().map(|&p| strength[p]).fold(0.0, f64::max);
    if max_onset > 0.0 {
        for &p in &peaks {
            let rel = strength[p] / max_onset;
            if rel >= 0.5 {
                candidates.push(KeyMoment {
                    t_ms: (p as f64 * hop_ms).round(),
                    strength: rel,
                });
            }
        }
    }
    let novelty = novelty_curve(envelope, hop_ms, 2000.0);
    let max_novelty = novelty.iter().copied().fold(0.0, f64::max);
    if max_novelty > 0.05 {
        let gap = ((KEY_MOMENT_MIN_GAP_MS / hop_ms).round() as usize).max(1);
        for i in local_maxima(&novelty, max_novelty * 0.35, gap) {
            candidates.push(KeyMoment {
                t_ms: (i as f64 * hop_ms).round(),
                strength: novelty[i] / max_novelty,
            });
        }
    }
    space_key_moments(&candidates, KEY_MOMENT_MIN_GAP_MS)
        .into_iter()
        .map(|m| KeyMoment {
            t_ms: m.t_ms,
            strength: (m.strength * 1000.0).round() / 1000.0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_constant_signal_normalises_to_ones() {
        let env = rms_envelope(&[0.5; 4096], ENVELOPE_HOP);
        assert_eq!(env.len(), 4);
        for v in env {
            assert!((v - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn onsets_keep_only_rises() {
        assert_eq!(
            onset_strength(&[0.0, 0.2, 1.0, 0.4]),
            vec![0.0, 0.2, 0.8, 0.0]
        );
    }

    #[test]
    fn spacing_keeps_the_strongest_of_a_cluster_in_time_order() {
        let spaced = space_key_moments(
            &[
                KeyMoment {
                    t_ms: 0.0,
                    strength: 0.5,
                },
                KeyMoment {
                    t_ms: 500.0,
                    strength: 1.0,
                },
                KeyMoment {
                    t_ms: 2100.0,
                    strength: 0.3,
                },
            ],
            KEY_MOMENT_MIN_GAP_MS,
        );
        let times: Vec<f64> = spaced.iter().map(|m| m.t_ms).collect();
        assert_eq!(times, vec![500.0, 2100.0]);
    }

    #[test]
    fn silence_has_no_tempo() {
        assert_eq!(estimate_tempo(&vec![0.0; 2000], 5.333), None);
        assert_eq!(estimate_tempo(&[], 5.333), None);
    }
}
