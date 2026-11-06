//! The install's Ed25519 pack-signing identity: 32 raw private-key bytes, created the first time something signs and
//! never at boot. Its home is the login Keychain (a generic password that is never synchronised); the 0600 file at
//! `$APPDATA/pack-key/ed25519.key` is the fallback where the Keychain cannot answer (no login keychain), and a file from
//! an earlier build is moved into the Keychain once, at signing time, and deleted.
//!
//! Settings reads only `identity.json`, the public half that signing keeps true; non-Developer ID builds and autoruns use `pack-key-dev/`.
//!
//! A signature is always over the exact stored `manifest.json` bytes, never over a re-serialisation, so a reader can
//! verify what it actually read.

use super::error::PackError;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const KEY_DIR: &str = "pack-key";
const DEV_KEY_DIR: &str = "pack-key-dev";
const KEY_FILE: &str = "ed25519.key";
const RECORD_FILE: &str = "identity.json";
/// Apple's Developer ID Application requirement: a Developer ID intermediate and leaf, any team.
const DEVELOPER_ID_REQUIREMENT: &str = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
        public_key: published_key(&raw),
    }
}

/// The wire form of a public key: the prefix and the base64 of its 32 raw bytes.
pub(crate) fn published_key(raw: &[u8; 32]) -> String {
    format!("{PUBLIC_KEY_PREFIX}{}", BASE64.encode(raw))
}

/// Parse an `ed25519:<base64>` public key. Anything else is not a key we can check a signature with.
pub fn parse_public_key(public_key: &str) -> Option<VerifyingKey> {
    let b64 = public_key.strip_prefix(PUBLIC_KEY_PREFIX)?;
    let raw = BASE64.decode(b64.trim()).ok()?;
    let raw: [u8; 32] = raw.as_slice().try_into().ok()?;
    VerifyingKey::from_bytes(&raw).ok()
}

fn key_dir(app: &AppHandle) -> Result<PathBuf, PackError> {
    let name = if developer_id_signed() && !crate::is_autorun() {
        KEY_DIR
    } else {
        DEV_KEY_DIR
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| PackError::Io(e.to_string()))?;
    Ok(dir.join(name))
}

/// The identity, creating the key if this install has never signed anything.
pub fn ensure_identity(app: &AppHandle) -> Result<PackIdentity, PackError> {
    Ok(identity_of(
        &load_or_create_in(&key_dir(app)?, keychain())?.0,
    ))
}

/// The identity from the record alone, so opening Settings never asks the Keychain. `None` until this build signs or rotates.
pub fn recorded_identity(app: &AppHandle) -> Option<(PackIdentity, KeyStorage)> {
    read_record(&key_dir(app).ok()?)
}

/// Sign the exact bytes that will be stored as `manifest.json`.
pub fn sign_manifest(app: &AppHandle, bytes: &[u8]) -> Result<Vec<u8>, PackError> {
    let (key, _) = load_or_create_in(&key_dir(app)?, keychain())?;
    Ok(key.sign(bytes).to_bytes().to_vec())
}

/// Replace the key. Recipients who trusted the old one will be asked again, which is the point.
pub fn rotate_identity(app: &AppHandle) -> Result<(PackIdentity, KeyStorage), PackError> {
    rotate_in(&key_dir(app)?, keychain())
}

// ── Where the key lives ──

/// Only a Developer ID build may use the Keychain item: one created by an ad-hoc or unsigned build trusts that build alone, so every release after it would prompt.
fn developer_id_signed() -> bool {
    static SIGNED: OnceLock<bool> = OnceLock::new();
    *SIGNED.get_or_init(|| {
        use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
        let signed = DEVELOPER_ID_REQUIREMENT
            .parse::<SecRequirement>()
            .and_then(|req| SecCode::for_self(Flags::NONE)?.check_validity(Flags::NONE, &req))
            .is_ok();
        if !signed {
            log::info!("[pack] not a Developer ID build; the signing key stays in {DEV_KEY_DIR}");
        }
        signed
    })
}

/// The Keychain answers for an interactive Developer ID app. A background autorun never asks it (a prompt there would hang a gate), and `KOOKABURRA_PACK_KEY_FILE=1` keeps a session on the file.
fn keychain_allowed() -> bool {
    !crate::is_autorun()
        && std::env::var_os("KOOKABURRA_PACK_KEY_FILE").is_none()
        && developer_id_signed()
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

/// The private half's store when the Keychain answers; a trait so the tests stand in for the login Keychain.
trait Keychain {
    fn get(&self) -> Result<SigningKey, KeychainMiss>;
    fn set(&self, key: &SigningKey) -> Result<(), KeychainMiss>;
}

struct LoginKeychain;

impl Keychain for LoginKeychain {
    fn get(&self) -> Result<SigningKey, KeychainMiss> {
        let raw = security_framework::passwords::get_generic_password(
            KEYCHAIN_SERVICE,
            &keychain_account(),
        )
        .map_err(keychain_miss)?;
        let raw: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
            KeychainMiss::Unavailable("the Keychain item is not a 32-byte key".into())
        })?;
        Ok(SigningKey::from_bytes(&raw))
    }

    fn set(&self, key: &SigningKey) -> Result<(), KeychainMiss> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            &keychain_account(),
            &key.to_bytes(),
        )
        .map_err(keychain_miss)
    }
}

fn keychain() -> Option<&'static dyn Keychain> {
    keychain_allowed().then_some(&LoginKeychain)
}

// ── Path-level core: `dir` holds the key file and the record, and the tests drive it with a stand-in Keychain ──

/// The key this install signs with, if it has one: the Keychain first, then a file from an earlier build (moved into the Keychain on the way and deleted), then the file where the Keychain cannot answer.
fn load_key_in(
    dir: &Path,
    keychain: Option<&dyn Keychain>,
) -> Result<Option<(SigningKey, KeyStorage)>, PackError> {
    let path = dir.join(KEY_FILE);
    if let Some(keychain) = keychain {
        match keychain.get() {
            Ok(key) => return Ok(Some((key, KeyStorage::Keychain))),
            Err(KeychainMiss::Denied) => return Err(PackError::KeyDenied),
            Err(KeychainMiss::Absent) => {
                if !path.exists() {
                    return Ok(None);
                }
                let key = read_key(&path)?;
                return Ok(Some(match keychain.set(&key) {
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

/// The signing path: the key, created if there is none, with the record brought in line with it.
fn load_or_create_in(
    dir: &Path,
    keychain: Option<&dyn Keychain>,
) -> Result<(SigningKey, KeyStorage), PackError> {
    let (key, storage) = match load_key_in(dir, keychain)? {
        Some(found) => found,
        None => {
            let key = generate_key()?;
            let storage = store_key_in(dir, keychain, &key)?;
            (key, storage)
        }
    };
    sync_record(dir, &identity_of(&key), storage);
    Ok((key, storage))
}

fn rotate_in(
    dir: &Path,
    keychain: Option<&dyn Keychain>,
) -> Result<(PackIdentity, KeyStorage), PackError> {
    let key = generate_key()?;
    let storage = store_key_in(dir, keychain, &key)?;
    let identity = identity_of(&key);
    sync_record(dir, &identity, storage);
    Ok((identity, storage))
}

/// Keep a new key: in the Keychain when it answers, else the 0600 file. A file left from before is removed once the Keychain holds the key.
fn store_key_in(
    dir: &Path,
    keychain: Option<&dyn Keychain>,
    key: &SigningKey,
) -> Result<KeyStorage, PackError> {
    let path = dir.join(KEY_FILE);
    if let Some(keychain) = keychain {
        match keychain.set(key) {
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

/// The public half and where the private half lives. Never secret, and never trusted further than Settings' display.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityRecord {
    key_id: String,
    public_key: String,
    stored_in: KeyStorage,
}

/// The recorded identity, or `None` when there is none or its id is not the hash of its key.
fn read_record(dir: &Path) -> Option<(PackIdentity, KeyStorage)> {
    let text = match std::fs::read_to_string(dir.join(RECORD_FILE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[pack] could not read the signing key record: {e}");
            return None;
        }
    };
    let record: IdentityRecord = serde_json::from_str(&text).ok()?;
    (key_id_of(&record.public_key)? == record.key_id).then_some((
        PackIdentity {
            key_id: record.key_id,
            public_key: record.public_key,
        },
        record.stored_in,
    ))
}

/// Rewrite the record when it disagrees with the key in hand. Best effort: signing never fails over a display record.
fn sync_record(dir: &Path, identity: &PackIdentity, storage: KeyStorage) {
    if read_record(dir).is_some_and(|recorded| recorded == (identity.clone(), storage)) {
        return;
    }
    let record = IdentityRecord {
        key_id: identity.key_id.clone(),
        public_key: identity.public_key.clone(),
        stored_in: storage,
    };
    let written = serde_json::to_string_pretty(&record)
        .map_err(std::io::Error::other)
        .and_then(|json| {
            crate::privacy::private_dir(dir)?;
            crate::privacy::atomic_write_private(&dir.join(RECORD_FILE), &json)
        });
    if let Err(e) = written {
        log::warn!("[pack] could not record the signing key's public half: {e}");
    }
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

fn existing_key_at(path: &Path) -> Result<Option<SigningKey>, PackError> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_key(path)?))
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
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-pack-key-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn ensure(dir: &Path, keychain: Option<&dyn Keychain>) -> PackIdentity {
        identity_of(&load_or_create_in(dir, keychain).unwrap().0)
    }

    fn sign(
        dir: &Path,
        keychain: Option<&dyn Keychain>,
        bytes: &[u8],
    ) -> Result<Vec<u8>, PackError> {
        let (key, _) = load_or_create_in(dir, keychain)?;
        Ok(key.sign(bytes).to_bytes().to_vec())
    }

    /// Stands in for the login Keychain: holds one key, or answers every call with one miss.
    #[derive(Default)]
    struct FakeKeychain {
        held: RefCell<Option<SigningKey>>,
        denies: bool,
        denies_set: bool,
        unavailable: bool,
    }

    impl FakeKeychain {
        fn miss(&self) -> Option<KeychainMiss> {
            if self.denies {
                Some(KeychainMiss::Denied)
            } else if self.unavailable {
                Some(KeychainMiss::Unavailable("no login keychain".into()))
            } else {
                None
            }
        }
    }

    impl Keychain for FakeKeychain {
        fn get(&self) -> Result<SigningKey, KeychainMiss> {
            if let Some(miss) = self.miss() {
                return Err(miss);
            }
            self.held.borrow().clone().ok_or(KeychainMiss::Absent)
        }

        fn set(&self, key: &SigningKey) -> Result<(), KeychainMiss> {
            if self.denies_set {
                return Err(KeychainMiss::Denied);
            }
            if let Some(miss) = self.miss() {
                return Err(miss);
            }
            *self.held.borrow_mut() = Some(key.clone());
            Ok(())
        }
    }

    fn write_record_text(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(RECORD_FILE), text).unwrap();
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let dir = scratch_dir();
        let identity = ensure(&dir, None);
        let manifest = br#"{"format":"kookaburra-pack"}"#;
        let sig = sign(&dir, None, manifest).unwrap();
        assert_eq!(sig.len(), 64);
        assert!(verify_manifest(&identity.public_key, manifest, &sig));
    }

    #[test]
    fn verify_fails_on_a_flipped_manifest_byte() {
        let dir = scratch_dir();
        let identity = ensure(&dir, None);
        let mut manifest = br#"{"format":"kookaburra-pack"}"#.to_vec();
        let sig = sign(&dir, None, &manifest).unwrap();
        manifest[3] ^= 0x01;
        assert!(!verify_manifest(&identity.public_key, &manifest, &sig));
    }

    #[test]
    fn verify_fails_against_another_key() {
        let mine = scratch_dir();
        let theirs = scratch_dir();
        let manifest = b"same bytes, different signer";
        let sig = sign(&mine, None, manifest).unwrap();
        let other = ensure(&theirs, None);
        assert!(!verify_manifest(&other.public_key, manifest, &sig));
        assert!(!verify_manifest("rsa:abc", manifest, &sig));
        assert!(!verify_manifest(&other.public_key, manifest, &sig[..63]));
    }

    #[test]
    fn key_id_is_stable_for_the_same_key() {
        let dir = scratch_dir();
        let first = ensure(&dir, None);
        let second = ensure(&dir, None);
        assert_eq!(first, second);
        assert_eq!(first.key_id.len(), 16);
        assert_eq!(read_record(&dir), Some((first, KeyStorage::File)));
    }

    #[test]
    fn a_missing_key_is_absent_not_created() {
        let dir = scratch_dir();
        assert!(load_key_in(&dir, None).unwrap().is_none());
        assert_eq!(read_record(&dir), None);
        assert!(!dir.exists());
    }

    #[test]
    fn key_id_of_recomputes_the_id_from_the_public_key_alone() {
        let identity = ensure(&scratch_dir(), None);
        assert_eq!(
            key_id_of(&identity.public_key).as_deref(),
            Some(identity.key_id.as_str())
        );
        assert_eq!(key_id_of("ed25519:not-base64!"), None);
        assert_eq!(key_id_of("rsa:AAAA"), None);
        assert_eq!(key_id_of(""), None);
    }

    #[test]
    fn rotate_produces_a_different_key_id_and_records_it() {
        let dir = scratch_dir();
        let before = ensure(&dir, None);
        let (after, storage) = rotate_in(&dir, None).unwrap();
        assert_eq!(storage, KeyStorage::File);
        assert_ne!(before.key_id, after.key_id);
        assert_ne!(before.public_key, after.public_key);
        assert_eq!(ensure(&dir, None), after);
        assert_eq!(read_record(&dir), Some((after, KeyStorage::File)));
    }

    #[cfg(unix)]
    #[test]
    fn the_key_and_record_are_written_owner_only_and_a_widened_key_refuses_to_sign() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir();
        let path = dir.join(KEY_FILE);
        ensure(&dir, None);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir.join(RECORD_FILE)), 0o600);
        assert_eq!(mode(&dir), 0o700);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = sign(&dir, None, b"anything").unwrap_err();
        assert_eq!(err.variant(), "keyPermissions");
        // Rotating is the documented way out, and it restores the mode.
        rotate_in(&dir, None).unwrap();
        assert!(sign(&dir, None, b"anything").is_ok());
    }

    #[test]
    fn the_record_answers_without_the_private_key() {
        let dir = scratch_dir();
        let identity = ensure(&dir, None);
        std::fs::remove_file(dir.join(KEY_FILE)).unwrap();
        assert_eq!(read_record(&dir), Some((identity, KeyStorage::File)));
    }

    #[test]
    fn a_stale_record_is_rewritten_at_signing_and_a_broken_one_is_ignored() {
        let dir = scratch_dir();
        let real = ensure(&dir, None);
        let other = ensure(&scratch_dir(), None);
        let stale = format!(
            r#"{{"keyId":"{}","publicKey":"{}","storedIn":"keychain"}}"#,
            other.key_id, other.public_key
        );
        write_record_text(&dir, &stale);
        assert_eq!(
            read_record(&dir),
            Some((other.clone(), KeyStorage::Keychain))
        );
        sign(&dir, None, b"manifest").unwrap();
        assert_eq!(read_record(&dir), Some((real.clone(), KeyStorage::File)));

        let mismatched = format!(
            r#"{{"keyId":"{}","publicKey":"{}","storedIn":"file"}}"#,
            other.key_id, real.public_key
        );
        write_record_text(&dir, &mismatched);
        assert_eq!(read_record(&dir), None);
        write_record_text(&dir, "not json");
        assert_eq!(read_record(&dir), None);
        write_record_text(
            &dir,
            r#"{"keyId":"","publicKey":"rsa:AAAA","storedIn":"file"}"#,
        );
        assert_eq!(read_record(&dir), None);
    }

    #[test]
    fn a_legacy_file_moves_into_the_keychain_only_when_signing() {
        let dir = scratch_dir();
        let legacy = generate_key().unwrap();
        write_key(&dir.join(KEY_FILE), &legacy).unwrap();
        let keychain = FakeKeychain::default();
        assert_eq!(
            read_record(&dir),
            None,
            "nothing is recorded or moved before a sign"
        );
        assert!(keychain.held.borrow().is_none());

        let identity = ensure(&dir, Some(&keychain));
        assert_eq!(
            identity,
            identity_of(&legacy),
            "the same key, so recipients see no change"
        );
        assert!(!dir.join(KEY_FILE).exists());
        assert_eq!(
            keychain.held.borrow().as_ref().map(identity_of),
            Some(identity.clone())
        );
        assert_eq!(read_record(&dir), Some((identity, KeyStorage::Keychain)));
    }

    #[test]
    fn a_denied_move_keeps_the_legacy_file() {
        let dir = scratch_dir();
        let legacy = generate_key().unwrap();
        write_key(&dir.join(KEY_FILE), &legacy).unwrap();
        let keychain = FakeKeychain {
            denies_set: true,
            ..Default::default()
        };
        let err = sign(&dir, Some(&keychain), b"manifest").unwrap_err();
        assert_eq!(err.variant(), "keyDenied");
        assert!(
            dir.join(KEY_FILE).exists(),
            "the only copy of the key stays put"
        );
        assert_eq!(read_record(&dir), None);
        assert_eq!(ensure(&dir, None), identity_of(&legacy));
    }

    #[test]
    fn a_new_key_goes_into_the_keychain_and_rotating_replaces_it() {
        let dir = scratch_dir();
        let keychain = FakeKeychain::default();
        let first = ensure(&dir, Some(&keychain));
        assert!(!dir.join(KEY_FILE).exists());
        assert_eq!(
            read_record(&dir),
            Some((first.clone(), KeyStorage::Keychain))
        );
        let (rotated, storage) = rotate_in(&dir, Some(&keychain)).unwrap();
        assert_eq!(storage, KeyStorage::Keychain);
        assert_ne!(rotated, first);
        assert_eq!(
            keychain.held.borrow().as_ref().map(identity_of),
            Some(rotated.clone())
        );
        assert_eq!(read_record(&dir), Some((rotated, KeyStorage::Keychain)));
    }

    #[test]
    fn a_denied_keychain_stops_signing_but_never_the_record() {
        let dir = scratch_dir();
        let held = FakeKeychain::default();
        let identity = ensure(&dir, Some(&held));
        let denied = FakeKeychain {
            held: RefCell::new(held.held.borrow().clone()),
            denies: true,
            ..Default::default()
        };
        let err = sign(&dir, Some(&denied), b"manifest").unwrap_err();
        assert_eq!(err.variant(), "keyDenied");
        assert_eq!(
            rotate_in(&dir, Some(&denied)).unwrap_err().variant(),
            "keyDenied"
        );
        assert_eq!(read_record(&dir), Some((identity, KeyStorage::Keychain)));
        assert!(
            !dir.join(KEY_FILE).exists(),
            "a denial never mints a second key on disk"
        );

        let fresh = scratch_dir();
        assert_eq!(
            sign(&fresh, Some(&denied), b"manifest")
                .unwrap_err()
                .variant(),
            "keyDenied"
        );
        assert!(!fresh.join(KEY_FILE).exists());
        assert_eq!(read_record(&fresh), None);
    }

    #[test]
    fn an_unavailable_keychain_falls_back_to_the_file() {
        let dir = scratch_dir();
        let keychain = FakeKeychain {
            unavailable: true,
            ..Default::default()
        };
        let identity = ensure(&dir, Some(&keychain));
        assert!(dir.join(KEY_FILE).exists());
        assert_eq!(ensure(&dir, Some(&keychain)), identity);
        assert_eq!(read_record(&dir), Some((identity, KeyStorage::File)));
    }

    #[test]
    fn key_id_displays_in_fours() {
        assert_eq!(format_key_id("a1b2c3d4e5f60718"), "a1b2 c3d4 e5f6 0718");
        assert_eq!(format_key_id(""), "");
    }
}
