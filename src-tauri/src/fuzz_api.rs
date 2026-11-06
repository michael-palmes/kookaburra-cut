//! The fuzz harness's doorway (`fuzz/`): thin shims over the parsers that read untrusted bytes, so the targets reach private modules without widening the crate's surface. Built only with the `fuzzing` feature.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey};

pub use crate::edit::EditDoc;
pub use crate::pack::error::PackError;
pub use crate::pack::limits::{MAX_PATH_BYTES, MAX_PATH_DEPTH, PAYLOAD_PREFIX};
pub use crate::pack::model::{FontEmbedding, PackManifest};

use crate::{edit, fonts, mp4box, pack, png_decode};

// ── Pack archive paths ──

pub fn validate_archive_path(raw: &str) -> Result<PathBuf, PackError> {
    pack::paths::validate_archive_path(raw)
}

pub fn is_dropped_entry(raw: &str) -> bool {
    pack::paths::is_dropped_entry(raw)
}

pub fn is_ignorable(raw: &str) -> bool {
    pack::paths::is_ignorable(raw)
}

// ── Pack manifests ──

pub fn parse_manifest(bytes: &[u8]) -> Result<PackManifest, String> {
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

pub fn manifest_bytes(manifest: &PackManifest) -> Result<Vec<u8>, String> {
    serde_json::to_vec(manifest).map_err(|e| e.to_string())
}

pub fn validate_contents_paths(manifest: &PackManifest) -> Result<(), PackError> {
    pack::read::validate_contents_paths(manifest)
}

// ── Pack signatures ──

pub fn parse_public_key(public_key: &str) -> bool {
    pack::key::parse_public_key(public_key).is_some()
}

pub fn key_id_of(public_key: &str) -> Option<String> {
    pack::key::key_id_of(public_key)
}

pub fn verify_manifest(public_key: &str, bytes: &[u8], sig: &[u8]) -> bool {
    pack::key::verify_manifest(public_key, bytes, sig)
}

/// The public half of the key `seed` signs with, in the form a manifest publishes.
pub fn public_key_for(seed: &[u8; 32]) -> String {
    pack::key::published_key(&SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

pub fn sign_with(seed: &[u8; 32], bytes: &[u8]) -> Vec<u8> {
    SigningKey::from_bytes(seed).sign(bytes).to_bytes().to_vec()
}

// ── Edit documents ──

pub fn parse_edit_doc(text: &str) -> Result<EditDoc, String> {
    edit::parse_doc_coded(text).map_err(String::from)
}

pub fn edit_doc_bytes(doc: &EditDoc) -> Result<Vec<u8>, String> {
    edit::doc_bytes(doc)
}

/// The flatten render's ffmpeg argv on the software lane. The tap-frame folder is a placeholder, as `validate_doc` passes one: the overlay is built, nothing is read.
pub fn edit_render_args(doc: &EditDoc) -> Result<Vec<String>, String> {
    let tap_dot_dir = Path::new("/kc-fuzz/tapdot");
    edit::build_render_args(doc, "out.mp4", false, Some(tap_dot_dir)).map(|(args, _)| args)
}

// ── Fonts ──

/// What the embedding reader and the collection extractor make of `data`.
pub struct SfntProbe {
    pub embedding: FontEmbedding,
    pub face_offset: usize,
    /// The face `postscript` names, rebuilt as a standalone font, when the data is a collection carrying it.
    pub extracted: Option<Vec<u8>>,
}

pub fn sfnt_probe(data: &[u8], postscript: Option<&str>) -> SfntProbe {
    let face_offset = fonts::embedding_face_offset(data, postscript);
    let embedding = fonts::embedding_in_face(data, face_offset);
    if let Ok((_, tables)) = fonts::face_tables(data, face_offset) {
        let _ = fonts::parse_fvar(data, &tables);
    }
    let extracted = postscript.and_then(|ps| fonts::extract_face_from_collection(data, ps).ok());
    SfntProbe {
        embedding,
        face_offset,
        extracted,
    }
}

/// Every table's `(offset, length)` in the face at `face_offset`, or None when its directory does not parse.
pub fn sfnt_table_spans(data: &[u8], face_offset: usize) -> Option<Vec<(u32, u32)>> {
    let (_, tables) = fonts::face_tables(data, face_offset).ok()?;
    Some(tables.iter().map(|t| (t.offset, t.length)).collect())
}

// ── Movies ──

/// Whether the first video track's edit list opens past the trivial edit; None when `data` is no readable movie.
pub fn mp4_edit_start(data: &[u8]) -> Option<bool> {
    mp4box::edit_start_in(&mut Cursor::new(data)).map(|start| start.edited())
}

// ── Images ──

pub fn decode_png_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    png_decode::decode_png_rgba(bytes)
}

/// The most RGBA8 bytes a decode may produce.
pub const MAX_PNG_RGBA_BYTES: u64 = png_decode::MAX_OUTPUT_BYTES as u64;
