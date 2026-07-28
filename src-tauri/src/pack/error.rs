//! One variant per refusal, so "invalid pack" never reaches a user or a bug report.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum PackError {
    Io(String),
    Write(String),
    NotAPack(String),
    ManifestMissing,
    ManifestTooLarge { bytes: u64 },
    ManifestUnreadable(String),
    SignatureMissing,
    SignatureInvalid,
    FormatTooNew { found: u32, supported: u32 },
    AppTooOld { needs: String, running: String },
    PathAbsolute(String),
    PathTraversal(String),
    PathOutsidePayload(String),
    PathTooDeep(String),
    PathTooLong(String),
    PathNotUtf8(String),
    PathSuspicious(String),
    NotARegularFile(String),
    SymlinkRejected(String),
    ExtensionNotAllowed(String),
    EntryNotInManifest(String),
    ManifestEntryMissing(String),
    HashMismatch(String),
    TooManyEntries { found: usize, max: usize },
    TooLarge { bytes: u64, max: u64 },
    EntryTooLarge { path: String, bytes: u64, max: u64 },
    RatioExceeded { path: String, ratio: u64, max: u64 },
    DestinationInvalid(String),
    NoWorkspace,
    KeyPermissions(String),
    Cancelled,
}

impl PackError {
    /// The one-line refusal shown to the user. Names the offending path wherever there is one.
    pub fn user_message(&self) -> String {
        match self {
            Self::Io(e) => format!("Could not read the pack: {e}"),
            Self::Write(e) => format!("Could not write into your workspace: {e}"),
            Self::NotAPack(p) => format!("{p} is not a Kookaburra Pack."),
            Self::ManifestMissing => {
                "This pack has no manifest, so there is nothing to verify it against.".into()
            }
            Self::ManifestTooLarge { bytes } => {
                format!("This pack's manifest is {bytes} bytes, which is far larger than any real pack.")
            }
            Self::ManifestUnreadable(e) => format!("This pack's manifest could not be read: {e}"),
            Self::SignatureMissing => {
                "This pack is not signed. Kookaburra Cut only imports signed packs.".into()
            }
            Self::SignatureInvalid => {
                "This pack is damaged or has been modified since it was signed. It has not been imported and nothing on your Mac has changed.".into()
            }
            Self::FormatTooNew { found, supported } => format!(
                "This pack uses format version {found}. This version of Kookaburra Cut understands up to {supported}."
            ),
            Self::AppTooOld { needs, running } => {
                format!("This pack needs Kookaburra Cut {needs} or later. You have {running}.")
            }
            Self::PathAbsolute(p) => format!("This pack tries to write to an absolute path: {p}"),
            Self::PathTraversal(p) => {
                format!("This pack tries to write outside its own folder: {p}")
            }
            Self::PathOutsidePayload(p) => format!("This pack has a file outside its payload: {p}"),
            Self::PathTooDeep(p) => format!("This pack has a file nested too deeply: {p}"),
            Self::PathTooLong(p) => format!("This pack has a file name that is too long: {p}"),
            Self::PathNotUtf8(p) => format!("This pack has a file name that is not valid text: {p}"),
            Self::PathSuspicious(p) => {
                format!("This pack has a file name designed to be misread: {p}")
            }
            Self::NotARegularFile(p) => format!("This pack contains something that is not a file: {p}"),
            Self::SymlinkRejected(p) => format!("This pack contains a shortcut, which is not allowed: {p}"),
            Self::ExtensionNotAllowed(p) => {
                format!("This pack contains a file type that does not belong in a pack: {p}")
            }
            Self::EntryNotInManifest(p) => {
                format!("This pack contains a file its manifest does not list: {p}")
            }
            Self::ManifestEntryMissing(p) => {
                format!("This pack's manifest lists a file that is not in the pack: {p}")
            }
            Self::HashMismatch(p) => format!("A file in this pack does not match its signed contents: {p}"),
            Self::TooManyEntries { found, max } => {
                format!("This pack has {found} files, over the {max} limit.")
            }
            Self::TooLarge { bytes, max } => {
                format!("This pack unpacks to {bytes} bytes, over the {max} limit.")
            }
            Self::EntryTooLarge { path, bytes, max } => {
                format!("A file in this pack unpacks to {bytes} bytes, over the {max} limit: {path}")
            }
            Self::RatioExceeded { path, ratio, max } => {
                format!("A file in this pack expands {ratio} times, over the {max} limit: {path}")
            }
            Self::DestinationInvalid(e) => format!("That is not somewhere a pack can be saved: {e}"),
            Self::NoWorkspace => "Set up your workspace before importing a pack.".into(),
            Self::KeyPermissions(p) => format!(
                "Your signing key at {p} can be read by other accounts on this Mac. Run: chmod 600 {p}"
            ),
            Self::Cancelled => "Cancelled.".into(),
        }
    }

    /// Stable slug for tests and telemetry.
    pub fn variant(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Write(_) => "write",
            Self::NotAPack(_) => "notAPack",
            Self::ManifestMissing => "manifestMissing",
            Self::ManifestTooLarge { .. } => "manifestTooLarge",
            Self::ManifestUnreadable(_) => "manifestUnreadable",
            Self::SignatureMissing => "signatureMissing",
            Self::SignatureInvalid => "signatureInvalid",
            Self::FormatTooNew { .. } => "formatTooNew",
            Self::AppTooOld { .. } => "appTooOld",
            Self::PathAbsolute(_) => "pathAbsolute",
            Self::PathTraversal(_) => "pathTraversal",
            Self::PathOutsidePayload(_) => "pathOutsidePayload",
            Self::PathTooDeep(_) => "pathTooDeep",
            Self::PathTooLong(_) => "pathTooLong",
            Self::PathNotUtf8(_) => "pathNotUtf8",
            Self::PathSuspicious(_) => "pathSuspicious",
            Self::NotARegularFile(_) => "notARegularFile",
            Self::SymlinkRejected(_) => "symlinkRejected",
            Self::ExtensionNotAllowed(_) => "extensionNotAllowed",
            Self::EntryNotInManifest(_) => "entryNotInManifest",
            Self::ManifestEntryMissing(_) => "manifestEntryMissing",
            Self::HashMismatch(_) => "hashMismatch",
            Self::TooManyEntries { .. } => "tooManyEntries",
            Self::TooLarge { .. } => "tooLarge",
            Self::EntryTooLarge { .. } => "entryTooLarge",
            Self::RatioExceeded { .. } => "ratioExceeded",
            Self::DestinationInvalid(_) => "destinationInvalid",
            Self::NoWorkspace => "noWorkspace",
            Self::KeyPermissions(_) => "keyPermissions",
            Self::Cancelled => "cancelled",
        }
    }

    /// The path this refusal is about, for the error screen's detail line.
    pub fn path(&self) -> Option<&str> {
        match self {
            Self::NotAPack(p)
            | Self::PathAbsolute(p)
            | Self::PathTraversal(p)
            | Self::PathOutsidePayload(p)
            | Self::PathTooDeep(p)
            | Self::PathTooLong(p)
            | Self::PathNotUtf8(p)
            | Self::PathSuspicious(p)
            | Self::NotARegularFile(p)
            | Self::SymlinkRejected(p)
            | Self::ExtensionNotAllowed(p)
            | Self::EntryNotInManifest(p)
            | Self::ManifestEntryMissing(p)
            | Self::HashMismatch(p)
            | Self::KeyPermissions(p) => Some(p),
            Self::EntryTooLarge { path, .. } | Self::RatioExceeded { path, .. } => Some(path),
            _ => None,
        }
    }
}

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.user_message())
    }
}

impl std::error::Error for PackError {}

impl From<std::io::Error> for PackError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<zip::result::ZipError> for PackError {
    fn from(e: zip::result::ZipError) -> Self {
        match e {
            zip::result::ZipError::FileNotFound => Self::ManifestMissing,
            other => Self::NotAPack(other.to_string()),
        }
    }
}

/// Commands return `String` errors app-wide; keep the user message as the wire form.
impl From<PackError> for String {
    fn from(e: PackError) -> Self {
        e.user_message()
    }
}
