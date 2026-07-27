//! Content hashing. `sha2` is already the app's hash everywhere else (media, clip and font caches).

use super::error::PackError;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub fn sha256_file(path: &Path) -> Result<String, PackError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(crate::hex_digest(hasher.finalize().as_slice()))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    crate::hex_digest(hasher.finalize().as_slice())
}

/// An item's conflict key: over content only, so a copy that moved machines but did not change still reads identical.
pub fn content_hash(files: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (path, sha) in sorted {
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update(sha.as_bytes());
        hasher.update(*b"\n");
    }
    crate::hex_digest(hasher.finalize().as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `contentHash` is the conflict key, so its exact byte recipe is contract: a drift would make every previously
    /// packed item read as changed. Pinned against an independent computation, not against itself.
    #[test]
    fn content_hash_recipe_is_pinned() {
        let files = vec![
            ("a.tsx".to_owned(), "aa".to_owned()),
            ("b.json".to_owned(), "bb".to_owned()),
        ];
        assert_eq!(
            content_hash(&files),
            "4619a8c322cea193c39da778acb76a155068fe08dffcf1d8aca6222d04342782"
        );
        // Order in must not matter: the recipe sorts.
        let reversed = vec![
            ("b.json".to_owned(), "bb".to_owned()),
            ("a.tsx".to_owned(), "aa".to_owned()),
        ];
        assert_eq!(content_hash(&files), content_hash(&reversed));
    }
}
