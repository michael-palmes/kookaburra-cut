//! The install's Ed25519 pack-signing identity: 32 raw private-key bytes at `$APPDATA/pack-key/ed25519.key`, mode 0600, written the first time something signs and never at boot.
//!
//! A signature is always over the exact stored `manifest.json` bytes, never over a re-serialisation, so a reader can
//! verify what it actually read.

use super::error::PackError;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const KEY_DIR: &str = "pack-key";
const KEY_FILE: &str = "ed25519.key";
/// Wire prefix on every published key, so a future algorithm change is a parse failure rather than a silent mismatch.
const PUBLIC_KEY_PREFIX: &str = "ed25519:";

/// What a publisher shows the world: never the private half.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackIdentity {
    /// hex of sha256(raw pubkey)[0..8], 16 characters.
    pub key_id: String,
    /// `ed25519:<base64 of the 32 raw bytes>`
    pub public_key: String,
}

/// Group the id in fours so someone can read it down a phone: `a1b2 c3d4 e5f6 0718`.
pub fn format_key_id(key_id: &str) -> String {
    key_id
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn key_id_for(raw_pubkey: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_pubkey);
    crate::hex_digest(&hasher.finalize()[..8])
}

fn identity_of(key: &SigningKey) -> PackIdentity {
    let raw = key.verifying_key().to_bytes();
    PackIdentity {
        key_id: key_id_for(&raw),
        public_key: format!("{PUBLIC_KEY_PREFIX}{}", BASE64.encode(raw)),
    }
}

/// Parse an `ed25519:<base64>` public key. Anything else is not a key we can check a signature with.
pub fn parse_public_key(public_key: &str) -> Option<VerifyingKey> {
    let b64 = public_key.strip_prefix(PUBLIC_KEY_PREFIX)?;
    let raw = BASE64.decode(b64.trim()).ok()?;
    let raw: [u8; 32] = raw.as_slice().try_into().ok()?;
    VerifyingKey::from_bytes(&raw).ok()
}

pub fn key_path(app: &AppHandle) -> Result<PathBuf, PackError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| PackError::Io(e.to_string()))?;
    Ok(dir.join(KEY_DIR).join(KEY_FILE))
}

/// The identity, creating the key if this install has never signed anything.
pub fn ensure_identity(app: &AppHandle) -> Result<PackIdentity, PackError> {
    ensure_identity_at(&key_path(app)?)
}

/// The identity if one exists, without creating it. Settings reads through here: opening a window is not signing.
pub fn existing_identity(app: &AppHandle) -> Result<Option<PackIdentity>, PackError> {
    existing_identity_at(&key_path(app)?)
}

/// Sign the exact bytes that will be stored as `manifest.json`.
pub fn sign_manifest(app: &AppHandle, bytes: &[u8]) -> Result<Vec<u8>, PackError> {
    sign_at(&key_path(app)?, bytes)
}

/// Replace the key. Recipients who trusted the old one will be asked again, which is the point.
pub fn rotate_identity(app: &AppHandle) -> Result<PackIdentity, PackError> {
    rotate_at(&key_path(app)?)
}

/// True only if `sig` is this key's signature over exactly `bytes`.
pub fn verify_manifest(public_key: &str, bytes: &[u8], sig: &[u8]) -> bool {
    let Some(verifying) = parse_public_key(public_key) else {
        return false;
    };
    let Ok(raw): Result<[u8; 64], _> = sig.try_into() else {
        return false;
    };
    verifying
        .verify_strict(bytes, &Signature::from_bytes(&raw))
        .is_ok()
}

// ── Path-level core (the AppHandle wrappers above are the only callers in the app) ──

pub fn ensure_identity_at(path: &Path) -> Result<PackIdentity, PackError> {
    Ok(identity_of(&load_or_create(path)?))
}

pub fn existing_identity_at(path: &Path) -> Result<Option<PackIdentity>, PackError> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(identity_of(&read_key(path)?)))
}

pub fn sign_at(path: &Path, bytes: &[u8]) -> Result<Vec<u8>, PackError> {
    let key = load_or_create(path)?;
    Ok(key.sign(bytes).to_bytes().to_vec())
}

pub fn rotate_at(path: &Path) -> Result<PackIdentity, PackError> {
    let key = SigningKey::generate(&mut rand_core::OsRng);
    write_key(path, &key)?;
    Ok(identity_of(&key))
}

fn load_or_create(path: &Path) -> Result<SigningKey, PackError> {
    if path.exists() {
        return read_key(path);
    }
    let key = SigningKey::generate(&mut rand_core::OsRng);
    write_key(path, &key)?;
    Ok(key)
}

fn read_key(path: &Path) -> Result<SigningKey, PackError> {
    assert_owner_only(path)?;
    let bytes = std::fs::read(path)?;
    let raw: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        PackError::Io(format!(
            "the signing key at {} is not a 32-byte Ed25519 key",
            path.display()
        ))
    })?;
    Ok(SigningKey::from_bytes(&raw))
}

fn write_key(path: &Path, key: &SigningKey) -> Result<(), PackError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        set_mode(dir, 0o700)?;
    }
    std::fs::write(path, key.to_bytes())?;
    set_mode(path, 0o600)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), PackError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), PackError> {
    Ok(())
}

/// A signing key any other account can read is worth stopping for, not warning about.
#[cfg(unix)]
fn assert_owner_only(path: &Path) -> Result<(), PackError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(PackError::KeyPermissions(path.display().to_string()));
    }
    Ok(())
}

#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), PackError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch_key() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-pack-key-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("ed25519.key")
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let path = scratch_key();
        let identity = ensure_identity_at(&path).unwrap();
        let manifest = br#"{"format":"kookaburra-pack"}"#;
        let sig = sign_at(&path, manifest).unwrap();
        assert_eq!(sig.len(), 64);
        assert!(verify_manifest(&identity.public_key, manifest, &sig));
    }

    #[test]
    fn verify_fails_on_a_flipped_manifest_byte() {
        let path = scratch_key();
        let identity = ensure_identity_at(&path).unwrap();
        let mut manifest = br#"{"format":"kookaburra-pack"}"#.to_vec();
        let sig = sign_at(&path, &manifest).unwrap();
        manifest[3] ^= 0x01;
        assert!(!verify_manifest(&identity.public_key, &manifest, &sig));
    }

    #[test]
    fn verify_fails_against_another_key() {
        let mine = scratch_key();
        let theirs = scratch_key();
        let manifest = b"same bytes, different signer";
        let sig = sign_at(&mine, manifest).unwrap();
        let other = ensure_identity_at(&theirs).unwrap();
        assert!(!verify_manifest(&other.public_key, manifest, &sig));
        assert!(!verify_manifest("rsa:abc", manifest, &sig));
        assert!(!verify_manifest(&other.public_key, manifest, &sig[..63]));
    }

    #[test]
    fn key_id_is_stable_for_the_same_key() {
        let path = scratch_key();
        let first = ensure_identity_at(&path).unwrap();
        let second = ensure_identity_at(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.key_id.len(), 16);
        assert_eq!(existing_identity_at(&path).unwrap(), Some(first));
    }

    #[test]
    fn a_missing_key_is_absent_not_created() {
        let path = scratch_key();
        assert_eq!(existing_identity_at(&path).unwrap(), None);
        assert!(!path.exists());
    }

    #[test]
    fn rotate_produces_a_different_key_id() {
        let path = scratch_key();
        let before = ensure_identity_at(&path).unwrap();
        let after = rotate_at(&path).unwrap();
        assert_ne!(before.key_id, after.key_id);
        assert_ne!(before.public_key, after.public_key);
        assert_eq!(existing_identity_at(&path).unwrap(), Some(after));
    }

    #[cfg(unix)]
    #[test]
    fn the_key_is_written_owner_only_and_a_widened_one_refuses_to_sign() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch_key();
        ensure_identity_at(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = sign_at(&path, b"anything").unwrap_err();
        assert_eq!(err.variant(), "keyPermissions");
        // Rotating is the documented way out, and it restores the mode.
        rotate_at(&path).unwrap();
        assert!(sign_at(&path, b"anything").is_ok());
    }

    #[test]
    fn key_id_displays_in_fours() {
        assert_eq!(format_key_id("a1b2c3d4e5f60718"), "a1b2 c3d4 e5f6 0718");
        assert_eq!(format_key_id(""), "");
    }
}
