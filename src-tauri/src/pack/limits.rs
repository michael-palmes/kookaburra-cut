//! Hard ceilings for reading an untrusted `.kbpack`. Every one of these is a refusal, not a truncation.

/// Zip entries in one pack.
pub const MAX_ENTRIES: usize = 50_000;
/// Total inflated bytes, counted as they stream (headers lie).
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024;
/// Inflated bytes for any single entry.
pub const MAX_SINGLE_UNCOMPRESSED: u64 = 4 * 1024 * 1024 * 1024;
/// Inflated / compressed for any single entry.
pub const MAX_RATIO_PER_ENTRY: u64 = 200;

const MIB: u64 = 1024 * 1024;
/// Per-kind ceilings, by extension, checked against the central directory before consent and against the stream while staging.
pub const MAX_FONT_BYTES: u64 = 64 * MIB;
pub const MAX_MODEL_BYTES: u64 = 512 * MIB;
pub const MAX_IMAGE_BYTES: u64 = 256 * MIB;
pub const MAX_VIDEO_BYTES: u64 = 4 * 1024 * MIB;
pub const MAX_AUDIO_BYTES: u64 = 512 * MIB;
pub const MAX_TEXT_BYTES: u64 = 16 * MIB;

/// What a payload entry is, with the most bytes a file of that kind may inflate to. An extension the allowlist does not know falls to the single-entry cap; `paths` refuses it anyway.
pub fn kind_cap(path: &str) -> (&'static str, u64) {
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "ttf" | "otf" => ("font", MAX_FONT_BYTES),
        "glb" => ("3D model", MAX_MODEL_BYTES),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg" | "hdr" | "exr" => {
            ("image", MAX_IMAGE_BYTES)
        }
        "mp4" | "mov" | "m4v" | "webm" => ("video", MAX_VIDEO_BYTES),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" => ("audio file", MAX_AUDIO_BYTES),
        "json" | "md" | "txt" | "tsx" => ("text file", MAX_TEXT_BYTES),
        _ => ("file", MAX_SINGLE_UNCOMPRESSED),
    }
}
/// Path components below `payload/`.
pub const MAX_PATH_DEPTH: usize = 16;
pub const MAX_PATH_BYTES: usize = 512;
pub const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
/// An Ed25519 signature is 64 bytes; the entry is read to a small bound, never to its end.
pub const MAX_SIGNATURE_BYTES: u64 = 256;
/// One scene source inflated for the code-disclosure viewer.
pub const MAX_SOURCE_VIEW_BYTES: u64 = 1024 * 1024;
/// Staging and backup directories are swept past this age.
pub const STALE_STAGING_SECS: u64 = 24 * 60 * 60;

pub const MANIFEST_ENTRY: &str = "manifest.json";
pub const SIGNATURE_ENTRY: &str = "manifest.sig";
pub const PAYLOAD_PREFIX: &str = "payload/";
pub const PACK_EXTENSION: &str = "kbpack";
pub const STAGING_DIR: &str = "import-staging";
pub const BACKUP_DIR: &str = "import-backup";
