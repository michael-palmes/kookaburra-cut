//! Loudness measurement: a sidecar ebur128 pass over the EXACT export audio graph (trim/pad/fades/author gain included, the same `audio_filter_graph` string the mux uses), cached by content + graph so the modal's estimates are instant on re-open; the FRONTEND turns the measurement into a gain delta (`target - integrated`, 2 dp) and sends it in the EncodeSpec, gain-only, warn-never-limit.

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::encode::{audio_filter_graph, AudioOptions};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessInfo {
    /// Integrated programme loudness, LUFS (ebur128 "I:").
    pub integrated_lufs: f64,
    /// True peak, dBTP (ebur128 `peak=true` "Peak:").
    pub true_peak_dbtp: f64,
}

/// Measure the project soundtrack THROUGH the export graph; `total_frames`/`fps` are the OUTPUT values (fps decimation changes the pad length and so the fade-out position).
#[tauri::command]
// Arg list mirrors the frontend invoke payload; bundling into a struct would change the IPC shape.
#[allow(clippy::too_many_arguments)]
pub async fn measure_loudness(
    app: AppHandle,
    file: String,
    gain_db: f64,
    fade_in_ms: u64,
    fade_out_ms: u64,
    start_offset_ms: u64,
    total_frames: u32,
    fps: u32,
) -> Result<LoudnessInfo, String> {
    let path = std::path::PathBuf::from(&file);
    if !path.is_absolute() || !path.is_file() {
        return Err(format!("audio file not found: {file}"));
    }
    let audio = AudioOptions {
        file: file.clone(),
        gain_db,
        fade_in_ms,
        fade_out_ms,
        start_offset_ms,
    };
    let graph = audio_filter_graph(&audio, total_frames, fps)?;

    // Cache key: the file's bytes plus the exact graph string; any change to either (edited track, new fades, different duration) is a different measurement.
    let mut hasher = Sha256::new();
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    hasher.update(&bytes);
    hasher.update([0u8]);
    hasher.update(graph.as_bytes());
    let key = format!("{:x}", hasher.finalize());
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("loudness");
    let cache_file = cache_dir.join(format!("{key}.json"));
    if let Ok(text) = std::fs::read_to_string(&cache_file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let (Some(i), Some(p)) = (v["integratedLufs"].as_f64(), v["truePeakDbtp"].as_f64())
            {
                return Ok(LoudnessInfo {
                    integrated_lufs: i,
                    true_peak_dbtp: p,
                });
            }
        }
    }

    // ebur128 prints its summary to STDERR; `-f null -` runs the graph without a file.
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-i".into(),
        file,
        "-af".into(),
        format!("{graph},ebur128=peak=true:framelog=quiet"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let stderr = run_ffmpeg_stderr(&app, args).await?;
    let info = parse_ebur128_summary(&stderr)
        .ok_or_else(|| "could not parse the ebur128 summary".to_string())?;

    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(
        &cache_file,
        format!(
            "{{\"integratedLufs\":{},\"truePeakDbtp\":{}}}",
            info.integrated_lufs, info.true_peak_dbtp
        ),
    );
    Ok(info)
}

/// Parse the ebur128 Summary block: the "I:" (LUFS) and true-peak "Peak:" (dBFS) lines.
fn parse_ebur128_summary(stderr: &str) -> Option<LoudnessInfo> {
    let mut integrated: Option<f64> = None;
    let mut peak: Option<f64> = None;
    let mut in_true_peak = false;
    for line in stderr.lines() {
        let t = line.trim();
        if t.starts_with("I:") && t.ends_with("LUFS") && integrated.is_none() {
            integrated = t
                .trim_start_matches("I:")
                .trim()
                .trim_end_matches("LUFS")
                .trim()
                .parse()
                .ok();
        }
        if t.starts_with("True peak:") {
            in_true_peak = true;
        }
        if in_true_peak && t.starts_with("Peak:") && peak.is_none() {
            peak = t
                .trim_start_matches("Peak:")
                .trim()
                .trim_end_matches("dBFS")
                .trim()
                .parse()
                .ok();
        }
    }
    Some(LoudnessInfo {
        integrated_lufs: integrated?,
        true_peak_dbtp: peak?,
    })
}

/// Run the ffmpeg sidecar and capture STDERR (where ebur128 reports).
async fn run_ffmpeg_stderr(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    let mut stderr = String::new();
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(p) => {
                code = p.code;
                break;
            }
            _ => {}
        }
    }
    if code != Some(0) {
        return Err(format!("ffmpeg loudness pass exited with {code:?}"));
    }
    Ok(stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_summary_block() {
        let stderr = "\
[Parsed_ebur128_0 @ 0x600] Summary:

  Integrated loudness:
    I:         -23.1 LUFS
    Threshold: -33.2 LUFS

  Loudness range:
    LRA:         6.4 LU

  True peak:
    Peak:       -1.3 dBFS
";
        let info = parse_ebur128_summary(stderr).unwrap();
        assert_eq!(info.integrated_lufs, -23.1);
        assert_eq!(info.true_peak_dbtp, -1.3);
    }
}
