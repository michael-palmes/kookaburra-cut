//! Synthetic test signals with known beat times: click tracks (the research prototypes' generators, seeded the same way) and a kick, snare and hat groove.

pub const SR: u32 = 48_000;

/// The mulberry32 generator the prototypes seeded their noise with.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    pub fn signed(&mut self) -> f64 {
        self.next() * 2.0 - 1.0
    }
}

#[derive(Clone, Copy)]
pub struct Clicks {
    pub bpm: f64,
    pub offset_ms: f64,
    pub duration_ms: f64,
    pub noise: f64,
    pub missing: usize,
    pub offbeats: bool,
    pub burst: bool,
    pub seed: u32,
}

impl Clicks {
    pub fn new(bpm: f64, offset_ms: f64, duration_ms: f64) -> Self {
        Self {
            bpm,
            offset_ms,
            duration_ms,
            noise: 0.0,
            missing: 0,
            offbeats: false,
            burst: false,
            seed: 1,
        }
    }
}

fn add(x: &mut [f32], t_ms: f64, len: usize, mut f: impl FnMut(usize) -> f64) {
    let s0 = (t_ms / 1000.0 * f64::from(SR)).ceil() as usize;
    for j in 0..len {
        if let Some(v) = x.get_mut(s0 + j) {
            *v += f(j) as f32;
        }
    }
}

fn truth_times(bpm: f64, offset_ms: f64, duration_ms: f64, margin_ms: f64) -> Vec<f64> {
    let period = 60_000.0 / bpm;
    (0..)
        .map(|k| offset_ms + f64::from(k) * period)
        .take_while(|&t| t < duration_ms - margin_ms)
        .collect()
}

/// A click track and its TRUE beat times (missing clicks included: the grid still owns them).
pub fn clicks(o: Clicks) -> (Vec<f32>, Vec<f64>) {
    let mut rng = Rng::new(o.seed);
    let n = (o.duration_ms / 1000.0 * f64::from(SR)).round() as usize;
    let mut x = vec![0.0f32; n];
    let period = 60_000.0 / o.bpm;
    let truth = truth_times(o.bpm, o.offset_ms, o.duration_ms, 50.0);
    let mut drop = std::collections::BTreeSet::new();
    while drop.len() < o.missing {
        drop.insert(1 + (rng.next() * (truth.len() - 2) as f64).floor() as usize);
    }
    for (k, &t) in truth.iter().enumerate() {
        if drop.contains(&k) {
            continue;
        }
        let amp = if k % 4 == 0 { 1.0 } else { 0.75 };
        let len = if o.burst { 2400 } else { 512 };
        let burst = o.burst;
        add(&mut x, t, len, |j| {
            let env = if burst {
                (-(j as f64) / (len as f64 / 5.0)).exp()
            } else {
                1.0 - j as f64 / len as f64
            };
            let carrier = if burst { rng.signed() } else { 1.0 };
            amp * env * carrier
        });
        if o.offbeats {
            add(&mut x, t + period / 2.0, 900, |j| {
                0.35 * (-(j as f64) / 180.0).exp() * rng.signed()
            });
            if k % 2 == 1 {
                add(&mut x, t + period * 3.0 / 4.0, 600, |j| {
                    0.18 * (-(j as f64) / 120.0).exp() * rng.signed()
                });
            }
        }
    }
    if o.noise > 0.0 {
        for v in &mut x {
            *v += (o.noise * rng.signed()) as f32;
        }
    }
    (x, truth)
}

fn kick(x: &mut [f32], t: f64, amp: f64) {
    let sr = f64::from(SR);
    add(x, t, 9000, |j| {
        let jf = j as f64;
        amp * (-jf / 2500.0).exp()
            * (2.0 * std::f64::consts::PI * (50.0 + 80.0 * (-jf / 400.0).exp()) * (jf / sr)).sin()
    });
}

/// Kicks on the beats under LOUDER off-beat hats, so full-band onsets lock half a beat out: (samples, kick times).
pub fn offbeat_hats(bpm: f64, offset_ms: f64, duration_ms: f64, seed: u32) -> (Vec<f32>, Vec<f64>) {
    let mut rng = Rng::new(seed);
    let n = (duration_ms / 1000.0 * f64::from(SR)).round() as usize;
    let mut x = vec![0.0f32; n];
    let period = 60_000.0 / bpm;
    let truth = truth_times(bpm, offset_ms, duration_ms, 100.0);
    for &t in &truth {
        kick(&mut x, t, 0.3);
        add(&mut x, t + period / 2.0, 2400, |j| {
            0.9 * (-(j as f64) / 400.0).exp() * rng.signed()
        });
    }
    for v in &mut x {
        *v += (0.01 * rng.signed()) as f32;
    }
    (x, truth)
}

/// A four-beat groove (kick on 1 and 3, snare on 2 and 4, eighth hats, a crash every fourth bar) with bar 1 starting on beat `downbeat` of the click grid: (samples, beat times).
pub fn groove(
    bpm: f64,
    offset_ms: f64,
    duration_ms: f64,
    downbeat: usize,
    seed: u32,
) -> (Vec<f32>, Vec<f64>) {
    let mut rng = Rng::new(seed);
    let n = (duration_ms / 1000.0 * f64::from(SR)).round() as usize;
    let mut x = vec![0.0f32; n];
    let period = 60_000.0 / bpm;
    let truth = truth_times(bpm, offset_ms, duration_ms, 50.0);
    for (k, &t) in truth.iter().enumerate() {
        let rel = k as i64 - downbeat as i64;
        let b = rel.rem_euclid(4);
        let bar = rel.div_euclid(4);
        match b {
            0 => kick(&mut x, t, 0.9),
            2 => kick(&mut x, t, 0.75),
            _ => add(&mut x, t, 6000, |j| {
                0.45 * (-(j as f64) / 1200.0).exp() * rng.signed()
            }),
        }
        add(&mut x, t, 1500, |j| {
            0.12 * (-(j as f64) / 250.0).exp() * rng.signed()
        });
        add(&mut x, t + period / 2.0, 1500, |j| {
            0.16 * (-(j as f64) / 250.0).exp() * rng.signed()
        });
        if b == 0 && bar.rem_euclid(4) == 0 {
            add(&mut x, t, 30_000, |j| {
                0.25 * (-(j as f64) / 9000.0).exp() * rng.signed()
            });
        }
    }
    for v in &mut x {
        *v += (0.01 * rng.signed()) as f32;
    }
    (x, truth)
}

/// The largest distance from each true beat to the nearest of `grid`.
pub fn max_error(grid: &[f64], truth: &[f64]) -> f64 {
    truth
        .iter()
        .map(|&c| {
            grid.iter()
                .map(|&g| (g - c).abs())
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
}
