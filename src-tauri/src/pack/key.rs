//! The install's Ed25519 pack-signing identity: 32 raw private-key bytes, created the first time something signs and
//! never at boot. Its home is the login Keychain (a generic password that is never synchronised); the 0600 file at
//! `$APPDATA/pack-key/ed25519.key` is the fallback where the Keychain cannot answer (a background autorun, no login
//! keychain), and a file from an earlier build is moved into the Keychain once and deleted.
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
/// The Keychain item's service; the account is the running bundle's identifier, so an acceptance build keeps its own key.
const KEYCHAIN_SERVICE: &str = "Kookaburra Cut pack signing key";
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

/// Where the private half is kept, for the Settings pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyStorage {
    Keychain,
    File,
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

/// The id a published key really has, recomputed from the key itself rather than read from the manifest.
pub fn key_id_of(public_key: &str) -> Option<String> {
    parse_public_key(public_key).map(|key| key_id_for(&key.to_bytes()))
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
    Ok(identity_of(&load_or_create_key(app)?.0))
}

/// The identity if one exists, without creating it. Settings reads through here: opening a window is not signing.
pub fn existing_identity(app: &AppHandle) -> Result<Option<(PackIdentity, KeyStorage)>, PackError> {
    Ok(load_key(app)?.map(|(key, storage)| (identity_of(&key), storage)))
}

/// Sign the exact bytes that will be stored as `manifest.json`.
pub fn sign_manifest(app: &AppHandle, bytes: &[u8]) -> Result<Vec<u8>, PackError> {
    let (key, _) = load_or_create_key(app)?;
    Ok(key.sign(bytes).to_bytes().to_vec())
}

/// Replace the key. Recipients who trusted the old one will be asked again, which is the point.
pub fn rotate_identity(app: &AppHandle) -> Result<PackIdentity, PackError> {
    let key = generate_key()?;
    store_key(app, &key)?;
    Ok(identity_of(&key))
}

// ── Where the key lives ──

/// The Keychain answers for an interactive app. A background autorun never asks it (a prompt there would hang a gate), and `KOOKABURRA_PACK_KEY_FILE=1` keeps a dev session on the file.
fn keychain_allowed() -> bool {
    !crate::is_autorun() && std::env::var_os("KOOKABURRA_PACK_KEY_FILE").is_none()
}

fn keychain_account() -> String {
    crate::tools::bundle_identifier().to_owned()
}

enum KeychainMiss {
    /// No item under our service and account.
    Absent,
    /// The person declined macOS's prompt, so signing cannot go on; a second key on disk would only confuse recipients.
    Denied,
    /// No usable login keychain here; the file carries on.
    Unavailable(String),
}

/// Security.framework's OSStatus codes for the three outcomes that matter here.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_USER_CANCELED: i32 = -128;

fn keychain_miss(e: security_framework::base::Error) -> KeychainMiss {
    match e.code() {
        ERR_SEC_ITEM_NOT_FOUND => KeychainMiss::Absent,
        ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => KeychainMiss::Denied,
        _ => KeychainMiss::Unavailable(e.to_string()),
    }
}

fn keychain_get() -> Result<SigningKey, KeychainMiss> {
    let raw = security_framework::passwords::get_generic_password(
        KEYCHAIN_SERVICE,
        &keychain_account(),
    )
    .map_err(keychain_miss)?;
    let raw: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| KeychainMiss::Unavailable("the Keychain item is not a 32-byte key".into()))?;
    Ok(SigningKey::from_bytes(&raw))
}

fn keychain_set(key: &SigningKey) -> Result<(), KeychainMiss> {
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        &keychain_account(),
        &key.to_bytes(),
    )
    .map_err(keychain_miss)
}

/// The key this install signs with, if it has one: the Keychain first, then a file from an earlier build (moved into the Keychain on the way and deleted), then the file where the Keychain cannot answer.
fn load_key(app: &AppHandle) -> Result<Option<(SigningKey, KeyStorage)>, PackError> {
    let path = key_path(app)?;
    if keychain_allowed() {
        match keychain_get() {
            Ok(key) => return Ok(Some((key, KeyStorage::Keychain))),
            Err(KeychainMiss::Denied) => return Err(PackError::KeyDenied),
            Err(KeychainMiss::Absent) => {
                if !path.exists() {
                    return Ok(None);
                }
                let key = read_key(&path)?;
                return Ok(Some(match keychain_set(&key) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&path);
                        log::info!("[pack] moved the signing key into the login Keychain");
                        (key, KeyStorage::Keychain)
                    }
                    Err(KeychainMiss::Denied) => return Err(PackError::KeyDenied),
                    Err(_) => (key, KeyStorage::File),
                }));
            }
            Err(KeychainMiss::Unavailable(why)) => {
                log::warn!("[pack] the Keychain is unavailable ({why}); using the key file");
            }
        }
    }
    Ok(existing_key_at(&path)?.map(|key| (key, KeyStorage::File)))
}

fn load_or_create_key(app: &AppHandle) -> Result<(SigningKey, KeyStorage), PackError> {
    if let Some(found) = load_key(app)? {
        return Ok(found);
    }
    let key = generate_key()?;
    let storage = store_key(app, &key)?;
    Ok((key, storage))
}

/// Keep a new key: in the Keychain when it answers, else the 0600 file. A file left from before is removed once the Keychain holds the key.
fn store_key(app: &AppHandle, key: &SigningKey) -> Result<KeyStorage, PackError> {
    let path = key_path(app)?;
    if keychain_allowed() {
        match keychain_set(key) {
            Ok(()) => {
                let _ = std::fs::remove_file(&path);
                return Ok(KeyStorage::Keychain);
            }
            Err(KeychainMiss::Denied) => return Err(PackError::KeyDenied),
            Err(_) => {}
        }
    }
    write_key(&path, key)?;
    Ok(KeyStorage::File)
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

// ── Path-level core: the file store, exercised directly by the tests ──

#[cfg(test)]
pub fn ensure_identity_at(path: &Path) -> Result<PackIdentity, PackError> {
    Ok(identity_of(&load_or_create(path)?))
}

#[cfg(test)]
pub fn existing_identity_at(path: &Path) -> Result<Option<PackIdentity>, PackError> {
    Ok(existing_key_at(path)?.map(|key| identity_of(&key)))
}

fn existing_key_at(path: &Path) -> Result<Option<SigningKey>, PackError> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_key(path)?))
}

#[cfg(test)]
pub fn sign_at(path: &Path, bytes: &[u8]) -> Result<Vec<u8>, PackError> {
    let key = load_or_create(path)?;
    Ok(key.sign(bytes).to_bytes().to_vec())
}

#[cfg(test)]
pub fn rotate_at(path: &Path) -> Result<PackIdentity, PackError> {
    let key = generate_key()?;
    write_key(path, &key)?;
    Ok(identity_of(&key))
}

#[cfg(test)]
fn load_or_create(path: &Path) -> Result<SigningKey, PackError> {
    if path.exists() {
        return read_key(path);
    }
    let key = generate_key()?;
    write_key(path, &key)?;
    Ok(key)
}

/// An Ed25519 signing key is 32 uniform random bytes, so the OS entropy source is the whole generator.
fn generate_key() -> Result<SigningKey, PackError> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw)
        .map_err(|e| PackError::Io(format!("could not read system entropy: {e}")))?;
    Ok(SigningKey::from_bytes(&raw))
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
    fn key_id_of_recomputes_the_id_from_the_public_key_alone() {
        let identity = ensure_identity_at(&scratch_key()).unwrap();
        assert_eq!(key_id_of(&identity.public_key).as_deref(), Some(identity.key_id.as_str()));
        assert_eq!(key_id_of("ed25519:not-base64!"), None);
        assert_eq!(key_id_of("rsa:AAAA"), None);
        assert_eq!(key_id_of(""), None);
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
