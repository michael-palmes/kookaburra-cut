//! Words on screen through Vision's text recogniser, which runs on this Mac and never touches the network: `<exe> media ocr` over frames kb has already decoded, so Vision only ever parses our own stills, never an untrusted film.

use std::path::{Path, PathBuf};

use objc2::rc::autoreleasepool;
use objc2::AnyThread;
use objc2_foundation::{NSDictionary, NSString, NSURL};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};
use serde::Serialize;

/// A frame this many lines long is noise, and the rest is dropped.
const MAX_LINES: usize = 200;
pub const MAX_FRAMES: usize = 4000;
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    pub text: String,
    pub confidence: f64,
}

/// The lines Vision reads in one still.
pub fn recognise(path: &Path) -> Result<Vec<Line>, String> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let options = NSDictionary::new();
        // SAFETY: the handler reads the still at `url`, and the empty options hold no objects of the wrong type.
        let handler = unsafe {
            VNImageRequestHandler::initWithURL_options(
                VNImageRequestHandler::alloc(),
                &url,
                &options,
            )
        };
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setAutomaticallyDetectsLanguage(true);
        request.setUsesLanguageCorrection(true);
        let base: &VNRequest = &request;
        handler
            .performRequests_error(&objc2_foundation::NSArray::from_slice(&[base]))
            .map_err(|e| e.localizedDescription().to_string())?;
        let mut lines = Vec::new();
        if let Some(results) = request.results() {
            for observation in results.iter().take(MAX_LINES) {
                if let Some(best) = observation.topCandidates(1).iter().next() {
                    lines.push(Line {
                        text: best.string().to_string(),
                        confidence: (f64::from(best.confidence()) * 1000.0).round() / 1000.0,
                    });
                }
            }
        }
        Ok(lines)
    })
}

/// The stills in a folder in name order: plain files only, so a link can't lead Vision elsewhere.
pub fn stills(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let plain = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        let still = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
        if plain && still {
            found.push(path);
        }
    }
    found.sort();
    if found.len() > MAX_FRAMES {
        return Err(format!(
            "{} holds {} stills; ocr reads at most {MAX_FRAMES}",
            dir.display(),
            found.len()
        ));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kb-ocr-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stills_are_plain_image_files_in_name_order() {
        let dir = scratch("list");
        for name in ["b.PNG", "a.jpg", "notes.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::create_dir(dir.join("c.png")).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", dir.join("d.png")).unwrap();
        let names: Vec<String> = stills(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.jpg", "b.PNG"]);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(stills(&dir).is_err());
    }

    #[test]
    fn a_still_that_is_not_an_image_fails_without_a_crash() {
        let dir = scratch("junk");
        let junk = dir.join("junk.png");
        std::fs::write(&junk, b"not an image").unwrap();
        assert!(recognise(&junk).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Black capitals on white, drawn from 5x7 rows: no font, no committed image.
    fn write_caption(path: &Path, text: &str) {
        let glyph = |c: char| -> [&str; 7] {
            match c {
                'H' => [
                    "10001", "10001", "10001", "11111", "10001", "10001", "10001",
                ],
                'E' => [
                    "11111", "10000", "10000", "11110", "10000", "10000", "11111",
                ],
                'L' => [
                    "10000", "10000", "10000", "10000", "10000", "10000", "11111",
                ],
                'O' => [
                    "01110", "10001", "10001", "10001", "10001", "10001", "01110",
                ],
                _ => ["00000"; 7],
            }
        };
        let (width, height, scale, left, top) = (1280usize, 720usize, 24usize, 80usize, 260usize);
        let mut rgb = vec![255u8; width * height * 3];
        for (i, c) in text.chars().enumerate() {
            for (row, bits) in glyph(c).iter().enumerate() {
                for (col, bit) in bits.chars().enumerate() {
                    if bit != '1' {
                        continue;
                    }
                    for y in 0..scale {
                        for x in 0..scale {
                            let px = left + i * 6 * scale + col * scale + x;
                            let py = top + row * scale + y;
                            rgb[(py * width + px) * 3..(py * width + px) * 3 + 3].fill(0);
                        }
                    }
                }
            }
        }
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = png::Encoder::new(file, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&rgb).unwrap();
    }

    #[test]
    #[ignore = "runs Vision's recogniser, which a virtual CI Mac may lack; run with --ignored"]
    fn vision_reads_the_words_a_test_draws() {
        let dir = scratch("words");
        let still = dir.join("caption.png");
        write_caption(&still, "HELLO");
        let lines = recognise(&still).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0].text.to_uppercase(), "HELLO");
        assert!(lines[0].confidence > 0.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
