//! Hard ceilings for reading an untrusted `.kbpack`. Every one of these is a refusal, not a truncation.

/// Zip entries in one pack.
pub const MAX_ENTRIES: usize = 50_000;
/// Total inflated bytes, counted as they stream (headers lie).
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024;
/// Inflated bytes for any single entry.
pub const MAX_SINGLE_UNCOMPRESSED: u64 = 4 * 1024 * 1024 * 1024;
/// Inflated / compressed for any single entry.
pub const MAX_RATIO_PER_ENTRY: u64 = 200;
/// Path components below `payload/`.
pub const MAX_PATH_DEPTH: usize = 16;
pub const MAX_PATH_BYTES: usize = 512;
pub const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
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
