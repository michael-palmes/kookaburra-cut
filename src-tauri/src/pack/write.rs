//! Building a `.kbpack`. Deterministic for the same input set: fixed entry order, fixed methods, no timestamps beyond the manifest's own.

use super::error::PackError;
use super::limits::{MANIFEST_ENTRY, PACK_EXTENSION, SIGNATURE_ENTRY};
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

pub struct PackEntry {
    pub archive_path: String,
    pub source: PathBuf,
}

pub struct PackWriteSummary {
    pub path: PathBuf,
    pub bytes: u64,
}

/// Already-compressed payloads gain ~1% from deflate and cost real CPU, so they are stored.
pub fn method_for(path: &str) -> CompressionMethod {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "mov" | "m4v" | "webm" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "glb"
        | "mp3" | "m4a" | "aac" | "ogg" => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    }
}

fn options(path: &str) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(method_for(path))
        .unix_permissions(0o644)
        // A fixed timestamp keeps two packs of the same content byte-identical.
        .last_modified_time(zip::DateTime::default())
}

/// Write to `<out>.part` and rename on success, so a cancelled build never leaves a half pack wearing a valid extension.
pub fn write_pack(
    out: &Path,
    manifest_json: &[u8],
    signature: &[u8],
    entries: &[PackEntry],
    mut on_progress: impl FnMut(usize, usize),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<PackWriteSummary, PackError> {
    let part = out.with_extension(format!("{PACK_EXTENSION}.part"));
    if let Some(dir) = part.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let result = write_inner(
        &part,
        manifest_json,
        signature,
        entries,
        &mut on_progress,
        is_cancelled,
    );
    match result {
        Ok(()) => {
            std::fs::rename(&part, out)?;
            let bytes = std::fs::metadata(out)?.len();
            Ok(PackWriteSummary {
                path: out.to_path_buf(),
                bytes,
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn write_inner(
    part: &Path,
    manifest_json: &[u8],
    signature: &[u8],
    entries: &[PackEntry],
    on_progress: &mut impl FnMut(usize, usize),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(), PackError> {
    let file = std::fs::File::create(part)?;
    let mut zip = zip::ZipWriter::new(file);

    // Entry 0 and 1, always: a reader verifies both before touching the payload.
    zip.start_file(MANIFEST_ENTRY, options(MANIFEST_ENTRY))?;
    zip.write_all(manifest_json)?;
    zip.start_file(
        SIGNATURE_ENTRY,
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644)
            .last_modified_time(zip::DateTime::default()),
    )?;
    zip.write_all(signature)?;

    let total = entries.len();
    let mut sorted: Vec<&PackEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.archive_path.cmp(&b.archive_path));

    for (index, entry) in sorted.iter().enumerate() {
        if is_cancelled() {
            return Err(PackError::Cancelled);
        }
        zip.start_file(&entry.archive_path, options(&entry.archive_path))?;
        let mut source = std::fs::File::open(&entry.source)?;
        std::io::copy(&mut source, &mut zip)?;
        on_progress(index + 1, total);
    }

    let mut finished = zip.finish()?;
    finished.flush()?;
    finished.rewind()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_is_stored_and_text_is_deflated() {
        assert_eq!(method_for("payload/a/x.mp4"), CompressionMethod::Stored);
        assert_eq!(method_for("payload/a/x.PNG"), CompressionMethod::Stored);
        assert_eq!(method_for("payload/a/x.glb"), CompressionMethod::Stored);
        assert_eq!(method_for("payload/a/x.tsx"), CompressionMethod::Deflated);
        assert_eq!(method_for("payload/a/x.json"), CompressionMethod::Deflated);
        assert_eq!(method_for("payload/a/x.ttf"), CompressionMethod::Deflated);
        assert_eq!(method_for("payload/a/x.hdr"), CompressionMethod::Deflated);
    }
}
