//! Everything the analyser asks of the media tools: mono 48 kHz PCM from the ffmpeg sidecar (the export's decoder, so analysis and the mux agree on where a beat is), the ebur128 loudness series, ffprobe's lyrics tags and the decoder version.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use serde_json::Value;

use super::SAMPLE_RATE;

const READ_CHUNK: usize = 1 << 16;

fn tail(text: &str, max: usize) -> String {
    let text = text.trim();
    let start = text
        .char_indices()
        .rev()
        .nth(max.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    text[start..].to_owned()
}

/// The decode argv: the first audio stream, downmixed to mono f32 at 48 kHz on stdout (no path ever enters a filter graph).
pub fn decode_args(file: &Path) -> Vec<String> {
    [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        &file.to_string_lossy(),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        &SAMPLE_RATE.to_string(),
        "-f",
        "f32le",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Decode `file` to mono f32 at `SAMPLE_RATE`. `cancelled` is polled per chunk; a cancel kills ffmpeg and returns `Err("interrupted")`.
pub fn decode_pcm(
    ffmpeg: &Path,
    file: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<f32>, String> {
    let mut child = crate::tools::sidecar_command(ffmpeg)
        .args(decode_args(file))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let mut stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(err) = stderr.as_mut() {
            let _ = err.read_to_string(&mut text);
        }
        text
    });
    let mut bytes = Vec::new();
    let mut interrupted = false;
    if let Some(mut out) = child.stdout.take() {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            if cancelled() {
                interrupted = true;
                let _ = child.kill();
                break;
            }
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
            }
        }
    }
    let status = child.wait();
    let errors = errors.join().unwrap_or_default();
    if interrupted {
        return Err("interrupted".to_owned());
    }
    if !status.map(|s| s.success()).unwrap_or(false) {
        let detail = tail(&errors, 400);
        return Err(format!(
            "ffmpeg could not decode {}{}",
            file.display(),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

/// The ebur128 series: momentary (400 ms window) and short-term (3 s) loudness every 100 ms, plus the integrated loudness and range.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Loudness {
    pub momentary: Vec<f64>,
    pub short_term: Vec<f64>,
    pub integrated: Option<f64>,
    pub range: Option<f64>,
}

/// One `NAME: value` number from an ebur128 log line (`-inf` reads as ebur128's silence floor).
fn field(line: &str, name: &str) -> Option<f64> {
    let rest = &line[line.find(name)? + name.len()..];
    let token = rest.split_whitespace().next()?;
    match token {
        "-inf" => Some(-120.7),
        t => t.parse().ok(),
    }
}

/// Parse ebur128's per-frame lines (`t: … M: … S: …`) and its Summary block.
pub fn parse_ebur128(stderr: &str) -> Loudness {
    let mut out = Loudness::default();
    let mut in_summary = false;
    let mut in_range = false;
    for line in stderr.lines() {
        if line.contains("Summary:") {
            in_summary = true;
            continue;
        }
        if !in_summary {
            if line.contains(" t:") && line.contains(" M:") && line.contains(" S:") {
                if let (Some(m), Some(s)) = (field(line, " M:"), field(line, " S:")) {
                    out.momentary.push(m);
                    out.short_term.push(s);
                }
            }
            continue;
        }
        let t = line.trim();
        if t.starts_with("Loudness range:") {
            in_range = true;
        } else if t.starts_with("I:") && out.integrated.is_none() {
            out.integrated = field(t, "I:");
        } else if in_range && t.starts_with("LRA:") && out.range.is_none() {
            out.range = field(t, "LRA:");
        }
    }
    out
}

/// Run ebur128 over the first audio stream as the file stores it (every channel, its own rate).
pub fn loudness(ffmpeg: &Path, file: &Path) -> Result<Loudness, String> {
    let out = crate::tools::sidecar_command(ffmpeg)
        .args(["-hide_banner", "-nostats", "-nostdin"])
        .args(["-protocol_whitelist", "file,pipe", "-i"])
        .arg(file)
        .args([
            "-map",
            "0:a:0",
            "-af",
            "ebur128=framelog=info",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(format!("ebur128 failed: {}", tail(&stderr, 300)));
    }
    Ok(parse_ebur128(&stderr))
}

/// Embedded lyrics: ID3 `USLT` reads as `lyrics-<lang>`, MP4 `©lyr` as `lyrics`.
#[derive(Debug, Clone, PartialEq)]
pub struct Lyrics {
    pub source: String,
    pub lang: Option<String>,
    pub text: String,
}

/// The first non-empty `lyrics*` tag in ffprobe's JSON, format tags before stream tags.
pub fn pick_lyrics(probe: &Value) -> Option<Lyrics> {
    let mut tag_sets: Vec<&serde_json::Map<String, Value>> = Vec::new();
    if let Some(tags) = probe["format"]["tags"].as_object() {
        tag_sets.push(tags);
    }
    if let Some(streams) = probe["streams"].as_array() {
        tag_sets.extend(streams.iter().filter_map(|s| s["tags"].as_object()));
    }
    for tags in tag_sets {
        let mut keys: Vec<&String> = tags.keys().collect();
        keys.sort();
        for key in keys {
            let lower = key.to_ascii_lowercase();
            let lang = if lower == "lyrics" {
                None
            } else if let Some(lang) = lower.strip_prefix("lyrics-") {
                Some(lang.to_owned())
            } else {
                continue;
            };
            let Some(text) = tags[key].as_str().map(str::trim).filter(|t| !t.is_empty()) else {
                continue;
            };
            return Some(Lyrics {
                source: format!("tag:{key}"),
                lang,
                text: text.to_owned(),
            });
        }
    }
    None
}

pub fn lyrics(ffprobe: &Path, file: &Path) -> Result<Option<Lyrics>, String> {
    let out = crate::tools::sidecar_command(ffprobe)
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format_tags:stream_tags",
            "-of",
            "json",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not start ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(tail(&String::from_utf8_lossy(&out.stderr), 300));
    }
    let probe: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(pick_lyrics(&probe))
}

/// `8.1.2` from `ffmpeg version 8.1.2 Copyright …`.
pub fn ffmpeg_version(ffmpeg: &Path) -> Option<String> {
    let out = crate::tools::sidecar_command(ffmpeg)
        .args(["-hide_banner", "-version"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .strip_prefix("ffmpeg version ")?
        .split_whitespace()
        .next()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_decode_keeps_the_path_out_of_any_filter() {
        let args = decode_args(Path::new("/tmp/a,b [x].mp3"));
        assert!(args.contains(&"/tmp/a,b [x].mp3".to_owned()));
        assert!(!args.iter().any(|a| a == "-af" || a == "-filter_complex"));
        let tail: Vec<&str> = args[args.len() - 7..].iter().map(String::as_str).collect();
        assert_eq!(tail, ["-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
    }

    #[test]
    fn ebur128_frames_and_summary_parse() {
        let stderr = "\
[Parsed_ebur128_0 @ 0x7b] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x7b] t: 0.199977   TARGET:-23 LUFS    M: -21.8 S: -inf     I: -21.8 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x7b] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  Loudness range:
    LRA:         4.5 LU
    Threshold:   0.0 LUFS
";
        let l = parse_ebur128(stderr);
        assert_eq!(l.momentary, vec![-120.7, -21.8]);
        assert_eq!(l.short_term, vec![-120.7, -120.7]);
        assert_eq!(l.integrated, Some(-21.8));
        assert_eq!(l.range, Some(4.5));
    }

    #[test]
    fn lyrics_come_from_id3_or_mp4_tags() {
        let id3 = json!({ "format": { "tags": { "title": "x", "lyrics-eng": "  la la\nla  " } } });
        assert_eq!(
            pick_lyrics(&id3),
            Some(Lyrics {
                source: "tag:lyrics-eng".into(),
                lang: Some("eng".into()),
                text: "la la\nla".into()
            })
        );
        let mp4 = json!({ "format": {}, "streams": [{ "tags": { "LYRICS": "words" } }] });
        assert_eq!(pick_lyrics(&mp4).unwrap().lang, None);
        assert_eq!(
            pick_lyrics(&json!({ "format": { "tags": { "lyrics": " " } } })),
            None
        );
        assert_eq!(pick_lyrics(&json!({})), None);
    }
}
