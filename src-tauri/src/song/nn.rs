//! The bundled beat-this small model (MIT, see NOTICE.md): where it lives, whether it is the pinned build, and one tracking pass over decoded PCM. Its beats sit on 20 ms frames; `fit.rs` refines them against our own onsets.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use beat_this::{beat_counts, BeatThis, RtenRuntime};
use sha2::{Digest, Sha256};

pub const MODEL_NAME: &str = "beat_this_small";
pub const BEAT_MODEL_FILE: &str = "beat_this_small.onnx";
pub const MEL_MODEL_FILE: &str = "mel_spectrogram.onnx";
/// SHA-256 pins, identical to `scripts/setup-models.sh` (a test keeps them in step).
pub const BEAT_MODEL_SHA256: &str =
    "a5f8d39d989f31859454ba27afe61c5317ca95e4d9373e6853e5361b8937172f";
pub const MEL_MODEL_SHA256: &str =
    "fdd59e65c515331308e4c8841edf99972deca646bdf6197744c2a5b7755e3de9";
const MODEL_FPS: f64 = 50.0;
const PUSH_CHUNK: usize = 1 << 16;

/// The verified model pair.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelFiles {
    pub dir: PathBuf,
    pub beat: PathBuf,
    pub mel: PathBuf,
}

/// Where the models may live, best first: the app's resource folder, the bundle's `Resources/models` beside a headless executable, and in debug builds the repo's provisioning folder.
pub fn candidate_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = resource_dir {
        dirs.push(dir.join("models"));
    }
    if let Some(dir) = bundle_resources() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/models"
    )));
    dirs
}

/// `<bundle>.app/Contents/Resources/models` for an executable in `Contents/MacOS/`.
fn bundle_resources() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents")
        .then(|| contents.join("Resources").join("models"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(crate::hex_digest(Sha256::digest(&bytes).as_slice()))
}

/// Files already hashed this process, by path, size and mtime: a 10 MB hash per project open adds up in debug builds.
type Stamp = (PathBuf, u64, Option<SystemTime>);
static HASHED: Mutex<Vec<(Stamp, String)>> = Mutex::new(Vec::new());

fn sha256_memo(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let stamp: Stamp = (path.to_path_buf(), meta.len(), meta.modified().ok());
    if let Ok(seen) = HASHED.lock() {
        if let Some((_, sha)) = seen.iter().find(|(s, _)| *s == stamp) {
            return Ok(sha.clone());
        }
    }
    let sha = sha256_file(path)?;
    if let Ok(mut seen) = HASHED.lock() {
        seen.retain(|(s, _)| s.0 != stamp.0);
        seen.push((stamp, sha.clone()));
    }
    Ok(sha)
}

/// The first candidate holding both files at their pins, else the reason none does.
pub fn locate(dirs: &[PathBuf]) -> Result<ModelFiles, String> {
    let mut reasons = Vec::new();
    for dir in dirs {
        let beat = dir.join(BEAT_MODEL_FILE);
        let mel = dir.join(MEL_MODEL_FILE);
        if !beat.is_file() || !mel.is_file() {
            reasons.push(format!("{} has no model", dir.display()));
            continue;
        }
        match (sha256_memo(&beat), sha256_memo(&mel)) {
            (Ok(b), Ok(m)) if b == BEAT_MODEL_SHA256 && m == MEL_MODEL_SHA256 => {
                return Ok(ModelFiles {
                    dir: dir.clone(),
                    beat,
                    mel,
                })
            }
            (Ok(_), Ok(_)) => reasons.push(format!(
                "{} holds a model that is not the pinned build (run pnpm setup:models)",
                dir.display()
            )),
            (Err(e), _) | (_, Err(e)) => reasons.push(e),
        }
    }
    if reasons.is_empty() {
        reasons.push("no model folder to look in".to_owned());
    }
    Err(format!(
        "the beat-this model is unavailable: {}",
        reasons.join("; ")
    ))
}

/// Tracked beats in ms with each beat's model confidence (0..1) and bar count (1 = downbeat), plus the downbeats.
#[derive(Debug, Clone, Default)]
pub struct Tracked {
    pub beats_ms: Vec<f64>,
    pub conf: Vec<f64>,
    pub counts: Vec<i32>,
    pub downbeats_ms: Vec<f64>,
}

fn sigmoid(x: f32) -> f64 {
    1.0 / (1.0 + (-f64::from(x)).exp())
}

/// One beat-this pass. `cancelled` is polled between chunks.
pub fn track(
    files: &ModelFiles,
    samples: &[f32],
    sample_rate: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<Tracked, String> {
    let mut bt = BeatThis::new(&RtenRuntime, &files.mel, &files.beat)
        .map_err(|e| format!("loading the beat-this model: {e}"))?;
    let mut stream = bt
        .stream(sample_rate)
        .map_err(|e| format!("beat-this: {e}"))?;
    for chunk in samples.chunks(PUSH_CHUNK) {
        if cancelled() {
            return Err("interrupted".to_owned());
        }
        stream.push(chunk).map_err(|e| format!("beat-this: {e}"))?;
    }
    let analysis = stream.finish().map_err(|e| format!("beat-this: {e}"))?;
    let counts = beat_counts(&analysis);
    let conf = analysis
        .beats
        .iter()
        .map(|&t| {
            let frame = (f64::from(t) * MODEL_FPS).round() as usize;
            analysis.beat_logits.get(frame).map_or(0.0, |&l| sigmoid(l))
        })
        .collect();
    Ok(Tracked {
        beats_ms: analysis
            .beats
            .iter()
            .map(|&t| f64::from(t) * 1000.0)
            .collect(),
        conf,
        counts,
        downbeats_ms: analysis
            .downbeats
            .iter()
            .map(|&t| f64::from(t) * 1000.0)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_match_the_setup_script() {
        let script = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/setup-models.sh"
        ))
        .unwrap();
        assert!(script.contains(&format!("{BEAT_MODEL_FILE}|{BEAT_MODEL_SHA256}|")));
        assert!(script.contains(&format!("{MEL_MODEL_FILE}|{MEL_MODEL_SHA256}|")));
    }

    #[test]
    fn the_bundle_maps_both_files_into_resources_models() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        let resources = &config["bundle"]["resources"];
        for file in [BEAT_MODEL_FILE, MEL_MODEL_FILE] {
            assert_eq!(
                resources[format!("resources/models/{file}")],
                format!("models/{file}")
            );
        }
    }

    #[test]
    fn a_missing_or_unpinned_model_says_why() {
        let dir = std::env::temp_dir().join(format!("kc-song-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err = locate(std::slice::from_ref(&dir)).unwrap_err();
        assert!(err.contains("has no model"), "{err}");
        std::fs::write(dir.join(BEAT_MODEL_FILE), "placeholder").unwrap();
        std::fs::write(dir.join(MEL_MODEL_FILE), "placeholder").unwrap();
        let err = locate(std::slice::from_ref(&dir)).unwrap_err();
        assert!(err.contains("not the pinned build"), "{err}");
        assert!(locate(&[]).unwrap_err().contains("no model folder"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn candidates_lead_with_the_resource_dir() {
        let dirs = candidate_dirs(Some(Path::new("/x/Resources")));
        assert_eq!(dirs[0], PathBuf::from("/x/Resources/models"));
        assert!(dirs.last().unwrap().ends_with("src-tauri/resources/models"));
    }
}
