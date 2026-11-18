//! Bridge signing (docs/agent-kit.md, "Signing"): each serving instance's key in `_bridge/keys/<pid>.key`, HMAC-SHA256 over a file's exact bytes with its mac's 64 digits read as zeros, and the request ids already accepted. Mirrored by kb's `kblib/bridgeauth.py`.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const AUTH_VERSION: u64 = 1;
pub(crate) const KEYS_DIR: &str = "keys";
const KEY_BYTES: usize = 32;
const MAC_DIGITS: usize = 64;
const ZERO_MAC: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// A signed request sent further ahead than this is refused: kb and the app share one clock.
const CLOCK_SKEW_MS: u64 = 60_000;
/// Bytes after the mac's digits in every signed file: the mac's closing quote, then `auth`'s and the object's braces.
const TAIL: &str = "\"}}";

pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(Sha256::digest(key).as_slice());
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    let outer = Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner.as_slice())
        .finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(outer.as_slice());
    out
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Append `"auth": {"v": 1, <extra>, "mac": "<zeros>"}` to a JSON object's text, then fill the mac in.
pub(crate) fn sign_text(
    key: &[u8],
    object_text: &str,
    extra: Option<&str>,
) -> Result<String, String> {
    let body = object_text.trim_end();
    let body = body
        .strip_suffix('}')
        .ok_or("only a JSON object can be signed")?
        .trim_end();
    let separator = if body.trim() == "{" { "" } else { "," };
    let extra = extra.map(|e| format!("{e},")).unwrap_or_default();
    let mut signed = format!(
        "{body}{separator}\"auth\":{{\"v\":{AUTH_VERSION},{extra}\"mac\":\"{ZERO_MAC}{TAIL}"
    );
    let mac = crate::hex_digest(&hmac_sha256(key, signed.as_bytes()));
    let at = signed.len() - TAIL.len() - MAC_DIGITS;
    signed.replace_range(at..at + MAC_DIGITS, &mac);
    Ok(signed)
}

/// What a file's `auth` says about it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Mac {
    /// No `auth` at all: a kit from before signing.
    Absent,
    Bad(&'static str),
    Good,
}

/// Check a file's mac against `key`; the digits must appear exactly once, so the zeroed bytes are unambiguous.
pub(crate) fn check_mac(key: &[u8], text: &str) -> Mac {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Mac::Bad("not JSON");
    };
    let Some(auth) = value.as_object().and_then(|o| o.get("auth")) else {
        return Mac::Absent;
    };
    if auth.get("v").and_then(Value::as_u64) != Some(AUTH_VERSION) {
        return Mac::Bad("unknown auth version");
    }
    let Some(mac) = auth.get("mac").and_then(Value::as_str) else {
        return Mac::Bad("no mac");
    };
    if !lower_hex(mac, MAC_DIGITS) {
        return Mac::Bad("malformed mac");
    }
    let mut found = text.match_indices(mac);
    let (Some((at, _)), None) = (found.next(), found.next()) else {
        return Mac::Bad("mac digits appear more than once");
    };
    let mut zeroed = text.as_bytes().to_vec();
    zeroed[at..at + MAC_DIGITS].copy_from_slice(ZERO_MAC.as_bytes());
    let expected = crate::hex_digest(&hmac_sha256(key, &zeroed));
    if same_bytes(expected.as_bytes(), mac.as_bytes()) {
        Mac::Good
    } else {
        Mac::Bad("wrong mac")
    }
}

/// One serving instance's key and the request ids it has accepted, each held until its deadline.
pub(crate) struct BridgeAuth {
    key: [u8; KEY_BYTES],
    accepted: Mutex<HashMap<String, u64>>,
}

impl BridgeAuth {
    pub(crate) fn new(key: [u8; KEY_BYTES]) -> Self {
        Self {
            key,
            accepted: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn generate() -> Result<Self, String> {
        let mut key = [0u8; KEY_BYTES];
        getrandom::fill(&mut key).map_err(|e| format!("no random bytes: {e}"))?;
        Ok(Self::new(key))
    }

    pub(crate) fn check(&self, text: &str) -> Mac {
        check_mac(&self.key, text)
    }

    /// The signed request's deadline: it must carry `requestedAtMs`, not sent in the future, so the deadline comes from signed fields only (at most 1 h after sending).
    pub(crate) fn deadline(
        &self,
        request: &crate::bridge::BridgeRequest,
        now: u64,
    ) -> Result<u64, &'static str> {
        if request.requested_at_ms == 0 {
            return Err("no requestedAtMs");
        }
        if request.requested_at_ms > now + CLOCK_SKEW_MS {
            return Err("sent in the future");
        }
        Ok(crate::bridge::request_deadline(request, 0, now))
    }

    pub(crate) fn replayed(&self, id: &str, now: u64) -> bool {
        let Ok(mut accepted) = self.accepted.lock() else {
            return true;
        };
        accepted.retain(|_, deadline| *deadline >= now);
        accepted.contains_key(id)
    }

    pub(crate) fn accept(&self, id: &str, deadline: u64) {
        if let Ok(mut accepted) = self.accepted.lock() {
            accepted.insert(id.to_owned(), deadline);
        }
    }

    /// An answer as written: signed, with the SHA-256 of each PNG in `responses` it names.
    pub(crate) fn sign_answer(&self, body: &Value, responses: &Path) -> Result<String, String> {
        let mut body = body.clone();
        let object = body.as_object_mut().ok_or("an answer is a JSON object")?;
        object.remove("auth");
        let files = png_hashes(&body, responses);
        let extra = format!("\"files\":{}", json!(files));
        sign_text(&self.key, &body.to_string(), Some(&extra))
    }

    fn key_hex(&self) -> String {
        crate::hex_digest(&self.key)
    }
}

/// Every string in `value` naming a `.png` directly inside `responses`, hashed without following a link; one that can't be read is left out, and kb refuses the answer.
fn png_hashes(value: &Value, responses: &Path) -> BTreeMap<String, String> {
    let mut paths = Vec::new();
    collect_strings(value, &mut paths);
    let mut out = BTreeMap::new();
    for raw in paths {
        let path = Path::new(&raw);
        let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
        else {
            continue;
        };
        if !name.ends_with(".png") || !crate::bridge::same_dir(parent, responses) {
            continue;
        }
        if let Some(hash) = file_sha256(path) {
            out.insert(name.to_owned(), hash);
        }
    }
    out
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(crate::hex_digest(hasher.finalize().as_slice()))
}

pub(crate) fn key_path(bridge: &Path, pid: u32) -> PathBuf {
    bridge.join(KEYS_DIR).join(format!("{pid}.key"))
}

/// Write `keys/<pid>.key` (folder 0700, file 0600 from its first byte, hex); a leftover file or link at that name is removed, never written through.
pub(crate) fn write_key(bridge: &Path, pid: u32, auth: &BridgeAuth) -> Result<(), String> {
    crate::privacy::private_dir(bridge).map_err(|e| e.to_string())?;
    let dir = crate::real_dir::real_dir(bridge, KEYS_DIR)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let path = key_path(bridge, pid);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(auth.key_hex().as_bytes())
        .map_err(|e| e.to_string())
}

pub(crate) fn remove_key(bridge: &Path, pid: u32) {
    let _ = std::fs::remove_file(key_path(bridge, pid));
}

/// Remove other instances' keys whose pid is dead, or whose heartbeat is gone and the key is older than `max_age_ms`; stray files go after `max_age_ms` too.
pub(crate) fn prune_keys(
    bridge: &Path,
    own_pid: u32,
    max_age_ms: u64,
    alive: impl Fn(u32) -> bool,
) {
    let Ok(entries) = std::fs::read_dir(bridge.join(KEYS_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age.as_millis() as u64 > max_age_ms);
        let name = entry.file_name().to_string_lossy().into_owned();
        let pid = name
            .strip_suffix(".key")
            .and_then(|stem| stem.parse::<u32>().ok());
        let remove = match pid {
            Some(pid) if pid == own_pid => false,
            Some(pid) => {
                !alive(pid) || (old && !bridge.join("apps").join(format!("{pid}.json")).exists())
            }
            None => old,
        };
        if remove {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const TEST_KEY: [u8; 32] = [7u8; 32];

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        let cases: [(Vec<u8>, Vec<u8>, &str); 6] = [
            (
                vec![0x0b; 20],
                b"Hi There".to_vec(),
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            ),
            (
                b"Jefe".to_vec(),
                b"what do ya want for nothing?".to_vec(),
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            ),
            (
                vec![0xaa; 20],
                vec![0xdd; 50],
                "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
            ),
            (
                unhex("0102030405060708090a0b0c0d0e0f10111213141516171819"),
                vec![0xcd; 50],
                "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
            ),
            (
                vec![0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First".to_vec(),
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            ),
            (
                vec![0xaa; 131],
                b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.".to_vec(),
                "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
            ),
        ];
        for (key, data, expected) in cases {
            assert_eq!(crate::hex_digest(&hmac_sha256(&key, &data)), expected);
        }
    }

    /// The same bytes kb's `test_bridgeauth` signs: both sides must produce this exact file.
    #[test]
    fn kb_and_the_app_sign_the_same_bytes_alike() {
        let key: Vec<u8> = (0u8..32).collect();
        let signed =
            sign_text(&key, r#"{"version": 2, "id": "0001-1-a", "at": 1.5}"#, None).unwrap();
        assert_eq!(
            signed,
            r#"{"version": 2, "id": "0001-1-a", "at": 1.5,"auth":{"v":1,"mac":"13279f23bf504534f17a4b126c112e026939b973bdca4e6c503495cca35dca7d"}}"#
        );
        assert_eq!(check_mac(&key, &signed), Mac::Good);
    }

    #[test]
    fn a_mac_covers_every_byte() {
        let signed = sign_text(&TEST_KEY, r#"{"id":"a","at":1}"#, None).unwrap();
        assert_eq!(check_mac(&TEST_KEY, &signed), Mac::Good);
        assert_eq!(
            check_mac(&TEST_KEY, &signed.replace("\"at\":1", "\"at\":2")),
            Mac::Bad("wrong mac")
        );
        assert_eq!(
            check_mac(&TEST_KEY, &signed.replace("{\"id\"", "{ \"id\"")),
            Mac::Bad("wrong mac")
        );
        assert_eq!(check_mac(&[8u8; 32], &signed), Mac::Bad("wrong mac"));
        assert_eq!(check_mac(&TEST_KEY, r#"{"id":"a"}"#), Mac::Absent);
        assert_eq!(check_mac(&TEST_KEY, "{"), Mac::Bad("not JSON"));
        let mac = &signed[signed.len() - 3 - 64..signed.len() - 3];
        let doubled = signed.replacen("\"at\":1", &format!("\"at\":1,\"x\":\"{mac}\""), 1);
        assert_eq!(
            check_mac(&TEST_KEY, &doubled),
            Mac::Bad("mac digits appear more than once")
        );
        assert_eq!(
            check_mac(&TEST_KEY, &signed.replace("\"v\":1", "\"v\":2")),
            Mac::Bad("unknown auth version")
        );
        assert_eq!(
            sign_text(&TEST_KEY, "{}", None)
                .unwrap()
                .matches(",")
                .count(),
            1
        );
        assert!(sign_text(&TEST_KEY, "[1]", None).is_err());
    }

    #[test]
    fn an_answer_names_the_hash_of_each_png_it_points_at() {
        let dir = std::env::temp_dir().join(format!("kc-auth-png-{}", std::process::id()));
        let responses = dir.join("responses");
        std::fs::create_dir_all(&responses).unwrap();
        std::fs::write(responses.join("a.png"), b"png-a").unwrap();
        std::fs::write(dir.join("elsewhere.png"), b"png-b").unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere.png"), responses.join("link.png")).unwrap();
        let body = json!({
            "ok": true, "auth": "planted",
            "path": responses.join("a.png"),
            "frames": [{ "path": dir.join("elsewhere.png") }, { "path": responses.join("link.png") }],
        });
        let auth = BridgeAuth::new(TEST_KEY);
        let signed = auth.sign_answer(&body, &responses).unwrap();
        assert_eq!(auth.check(&signed), Mac::Good);
        let value: Value = serde_json::from_str(&signed).unwrap();
        assert_eq!(
            value["auth"]["files"],
            json!({ "a.png": crate::hex_digest(Sha256::digest(b"png-a").as_slice()) })
        );
        assert_eq!(value["ok"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keys_are_private_and_removed_with_their_instance() {
        let bridge = std::env::temp_dir().join(format!("kc-auth-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bridge);
        let auth = BridgeAuth::new(TEST_KEY);
        std::fs::create_dir_all(bridge.join("keys")).unwrap();
        std::os::unix::fs::symlink(bridge.join("victim"), key_path(&bridge, 41)).unwrap();
        write_key(&bridge, 41, &auth).unwrap();
        assert!(
            !bridge.join("victim").exists(),
            "a planted link is replaced, never written through"
        );
        let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&bridge.join("keys")), 0o700);
        assert_eq!(mode(&key_path(&bridge, 41)), 0o600);
        assert_eq!(
            std::fs::read_to_string(key_path(&bridge, 41)).unwrap(),
            "07".repeat(32)
        );
        write_key(&bridge, 42, &auth).unwrap();
        write_key(&bridge, 43, &auth).unwrap();
        std::fs::write(bridge.join("keys/stray"), b"x").unwrap();
        let age = |p: PathBuf| {
            let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(hour_ago)
                .unwrap();
        };
        prune_keys(&bridge, 41, 600_000, |pid| pid != 42);
        assert!(key_path(&bridge, 41).exists() && !key_path(&bridge, 42).exists());
        assert!(key_path(&bridge, 43).exists() && bridge.join("keys/stray").exists());
        age(key_path(&bridge, 43));
        age(bridge.join("keys/stray"));
        prune_keys(&bridge, 41, 600_000, |_| true);
        assert!(!key_path(&bridge, 43).exists() && !bridge.join("keys/stray").exists());
        remove_key(&bridge, 41);
        assert!(!key_path(&bridge, 41).exists());
        let _ = std::fs::remove_dir_all(&bridge);

        let linked = std::env::temp_dir().join(format!("kc-auth-linked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&linked);
        std::fs::create_dir_all(linked.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(linked.join("elsewhere"), linked.join("keys")).unwrap();
        assert!(write_key(&linked, 41, &auth).is_err());
        assert!(std::fs::read_dir(linked.join("elsewhere"))
            .unwrap()
            .next()
            .is_none());
        let _ = std::fs::remove_dir_all(&linked);
    }
}
