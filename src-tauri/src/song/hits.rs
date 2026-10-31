//! Strong onsets, full band and split into low, mid and high: what `kb song hits` lists, the beat lane ticks and the form reads for fills and final hits. Times are track ms; strength is 0..1 within its own band, the band's 99th-percentile peak being 1.

use serde_json::{json, Value};

use super::onset::{onset_strength, pick_onset_peaks, rms_envelope, smooth3, ONSET_HOP};
use super::structure::Biquad;

const LOW_TOP_HZ: f64 = 200.0;
const HIGH_BOTTOM_HZ: f64 = 2000.0;
/// A bass note's RMS ripples at twice its pitch, so the low envelope is averaged over this many hops either side (about 26 ms) and only real attacks rise.
const LOW_SMOOTH_HOPS: usize = 2;
/// A band whose samples never reach this holds nothing worth listing: normalising it would only amplify noise.
const BAND_FLOOR: f32 = 0.002;
const PEAK_WINDOW_MS: f64 = 250.0;
const PEAK_BIAS: f64 = 1.5;
/// Two peaks closer than this are one hit (a 16th at 300 BPM is 50 ms).
const MIN_GAP_MS: f64 = 30.0;
/// Weaker hits stay out of the cached result.
const MIN_STORED_STRENGTH: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub t_ms: f64,
    pub strength: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BandHits {
    pub full: Vec<Hit>,
    pub low: Vec<Hit>,
    pub mid: Vec<Hit>,
    pub high: Vec<Hit>,
}

impl BandHits {
    pub fn to_json(&self) -> Value {
        let list = |hits: &[Hit]| -> Vec<[f64; 2]> {
            hits.iter()
                .map(|h| [(h.t_ms * 10.0).round() / 10.0, h.strength])
                .collect()
        };
        json!({
            "full": list(&self.full),
            "low": list(&self.low),
            "mid": list(&self.mid),
            "high": list(&self.high),
        })
    }
}

/// Peaks of one onset signal, thinned and normalised within the band.
pub fn hits_of(strength: &[f64], hop_ms: f64) -> Vec<Hit> {
    let window = ((PEAK_WINDOW_MS / hop_ms).round() as usize).max(2);
    let mut peaks: Vec<Hit> = Vec::new();
    for p in pick_onset_peaks(strength, window, PEAK_BIAS) {
        let hit = Hit {
            t_ms: p as f64 * hop_ms,
            strength: strength[p],
        };
        match peaks.last_mut() {
            Some(last) if hit.t_ms - last.t_ms < MIN_GAP_MS => {
                if hit.strength > last.strength {
                    *last = hit;
                }
            }
            _ => peaks.push(hit),
        }
    }
    let mut sorted: Vec<f64> = peaks.iter().map(|h| h.strength).collect();
    sorted.sort_by(f64::total_cmp);
    let Some(&scale) = sorted.get((sorted.len().saturating_sub(1) as f64 * 0.99).round() as usize)
    else {
        return Vec::new();
    };
    if scale <= 0.0 {
        return Vec::new();
    }
    peaks
        .into_iter()
        .map(|h| Hit {
            t_ms: h.t_ms,
            strength: ((h.strength / scale).min(1.0) * 1000.0).round() / 1000.0,
        })
        .filter(|h| h.strength >= MIN_STORED_STRENGTH)
        .collect()
}

/// Two cascaded Butterworths (24 dB an octave) for each cut, so a snare's body stays out of the low band.
fn filtered(samples: &[f32], mut filters: Vec<Biquad>) -> Vec<f32> {
    samples
        .iter()
        .map(|&x| {
            filters
                .iter_mut()
                .fold(f64::from(x), |v, filter| filter.step(v)) as f32
        })
        .collect()
}

fn centred_mean(values: &[f64], half: usize) -> Vec<f64> {
    (0..values.len())
        .map(|i| {
            let span = &values[i.saturating_sub(half)..(i + half + 1).min(values.len())];
            span.iter().sum::<f64>() / span.len() as f64
        })
        .collect()
}

fn band_onset(band: &[f32], smooth_hops: usize) -> Vec<f64> {
    if !band.iter().any(|v| v.abs() >= BAND_FLOOR) {
        return Vec::new();
    }
    let envelope = centred_mean(&rms_envelope(band, ONSET_HOP), smooth_hops);
    smooth3(&onset_strength(&envelope))
}

/// Hits of every band over mono PCM; `full` is the onset signal the grid was fitted to, so a tick and a beat agree.
pub fn detect(samples: &[f32], sample_rate: u32, full: &[f64], hop_ms: f64) -> BandHits {
    let rate = f64::from(sample_rate);
    let low_pass = |hz: f64| [Biquad::low_pass(hz, rate), Biquad::low_pass(hz, rate)];
    let high_pass = |hz: f64| [Biquad::high_pass(hz, rate), Biquad::high_pass(hz, rate)];
    BandHits {
        full: hits_of(full, hop_ms),
        low: hits_of(
            &band_onset(
                &filtered(samples, low_pass(LOW_TOP_HZ).into()),
                LOW_SMOOTH_HOPS,
            ),
            hop_ms,
        ),
        mid: hits_of(
            &band_onset(
                &filtered(
                    samples,
                    high_pass(LOW_TOP_HZ)
                        .into_iter()
                        .chain(low_pass(HIGH_BOTTOM_HZ))
                        .collect(),
                ),
                0,
            ),
            hop_ms,
        ),
        high: hits_of(
            &band_onset(&filtered(samples, high_pass(HIGH_BOTTOM_HZ).into()), 0),
            hop_ms,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::synth::SR;
    use super::*;

    const HOP: f64 = 256.0 / 48.0;

    fn tone(x: &mut [f32], at_ms: f64, hz: f64, amp: f64) {
        let start = (at_ms / 1000.0 * f64::from(SR)) as usize;
        for j in 0..4800 {
            let t = j as f64 / f64::from(SR);
            let env = (-(j as f64) / 900.0).exp();
            x[start + j] += (amp * env * (2.0 * std::f64::consts::PI * hz * t).sin()) as f32;
        }
    }

    fn near(hits: &[Hit], at_ms: f64) -> Option<Hit> {
        hits.iter().copied().find(|h| (h.t_ms - at_ms).abs() < 15.0)
    }

    #[test]
    fn each_band_hears_its_own_hits_with_strength_by_level() {
        let mut x = vec![0.0f32; SR as usize * 4];
        tone(&mut x, 500.0, 60.0, 0.9);
        tone(&mut x, 1500.0, 700.0, 0.8);
        tone(&mut x, 2000.0, 700.0, 0.3);
        tone(&mut x, 3000.0, 7000.0, 0.8);
        let full = smooth3(&onset_strength(&rms_envelope(&x, ONSET_HOP)));
        let hits = detect(&x, SR, &full, HOP);
        assert!(near(&hits.low, 500.0).is_some(), "{:?}", hits.low);
        assert!(near(&hits.low, 1500.0).is_none(), "{:?}", hits.low);
        assert!(near(&hits.low, 3000.0).is_none(), "{:?}", hits.low);
        assert!(near(&hits.mid, 1500.0).is_some(), "{:?}", hits.mid);
        assert!(near(&hits.mid, 500.0).is_none(), "{:?}", hits.mid);
        assert!(near(&hits.high, 3000.0).is_some(), "{:?}", hits.high);
        assert!(near(&hits.high, 500.0).is_none(), "{:?}", hits.high);
        let (loud, soft) = (
            near(&hits.mid, 1500.0).unwrap(),
            near(&hits.mid, 2000.0).unwrap(),
        );
        assert!(loud.strength > soft.strength * 1.5, "{loud:?} {soft:?}");
        assert_eq!(hits.full.len(), 4, "{:?}", hits.full);
    }

    #[test]
    fn silence_has_no_hits_in_any_band() {
        let x = vec![0.0f32; SR as usize];
        let full = smooth3(&onset_strength(&rms_envelope(&x, ONSET_HOP)));
        assert_eq!(detect(&x, SR, &full, HOP), BandHits::default());
    }

    #[test]
    fn hits_too_close_collapse_to_the_stronger() {
        let mut s = vec![0.0; 200];
        s[50] = 0.5;
        s[53] = 0.9;
        s[120] = 0.45;
        let hits = hits_of(&s, HOP);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!((hits[0].t_ms - 53.0 * HOP).abs() < 1e-6);
        assert_eq!(hits[0].strength, 1.0);
        assert_eq!(hits[1].strength, 0.5);
    }
}
