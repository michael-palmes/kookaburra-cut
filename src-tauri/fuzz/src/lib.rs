//! The fuzz target bodies, one `pub fn` per target: `fuzz_targets/` wraps each for libFuzzer, and the stable smoke test below runs every one over its seeds so the harness cannot rot between nightly runs.

use std::path::Component;

use kookaburra_cut_lib::fuzz_api as api;

/// A zip entry name: `Ok` means a relative path kept as written, under `payload/`, with plain components only and within the depth cap; a dropped entry never validates.
pub fn pack_archive_path(data: &[u8]) {
    let Ok(raw) = std::str::from_utf8(data) else {
        return;
    };
    let dropped = api::is_dropped_entry(raw);
    let _ = api::is_ignorable(raw);
    match api::validate_archive_path(raw) {
        Ok(path) => {
            assert!(!dropped, "a dropped entry validated: {raw:?}");
            assert!(raw.starts_with(api::PAYLOAD_PREFIX));
            assert!(raw.len() <= api::MAX_PATH_BYTES);
            assert_eq!(path.to_str(), Some(raw), "a valid path is kept as written");
            let components: Vec<Component<'_>> = path.components().collect();
            assert!(components.len() <= api::MAX_PATH_DEPTH);
            assert!(components
                .iter()
                .all(|component| matches!(component, Component::Normal(_))));
        }
        Err(error) => {
            let _ = error.user_message();
            let _ = error.variant();
        }
    }
}

/// A `manifest.json`: writing a parsed manifest is a fixed point, and the contents and key checks never panic.
pub fn pack_manifest(data: &[u8]) {
    let Ok(manifest) = api::parse_manifest(data) else {
        return;
    };
    let bytes = api::manifest_bytes(&manifest).expect("a parsed manifest serialises");
    // An instanced axis past f32's range reads as infinity, which JSON cannot carry back.
    let axes_finite = manifest.contents.fonts.iter().all(|font| {
        font.instanced
            .as_ref()
            .is_none_or(|instanced| instanced.axes.values().all(|axis| axis.is_finite()))
    });
    if axes_finite {
        let again = api::parse_manifest(&bytes).expect("written bytes parse back");
        assert_eq!(
            api::manifest_bytes(&again).expect("a parsed manifest serialises"),
            bytes,
            "writing is a fixed point"
        );
    }
    let _ = api::validate_contents_paths(&manifest);
    let _ = api::key_id_of(&manifest.publisher.public_key);
}

/// `[key length][key][64-byte signature][message]`: nothing verifies without a parseable key and a 64-byte signature, and a key seeded from the input verifies exactly the message it signed.
pub fn pack_signature(data: &[u8]) {
    let Some((&key_len, rest)) = data.split_first() else {
        return;
    };
    let (key, rest) = rest.split_at(usize::from(key_len).min(rest.len()));
    let key = String::from_utf8_lossy(key);
    let (sig, message) = rest.split_at(rest.len().min(64));
    let parsed = api::parse_public_key(&key);
    assert_eq!(api::key_id_of(&key).is_some(), parsed);
    let verified = api::verify_manifest(&key, message, sig);
    if !parsed || sig.len() != 64 {
        assert!(!verified, "verified without a key and a 64-byte signature");
    }

    let mut seed = [0u8; 32];
    for (slot, byte) in seed.iter_mut().zip(data) {
        *slot = *byte;
    }
    let public = api::public_key_for(&seed);
    let signature = api::sign_with(&seed, message);
    assert!(api::parse_public_key(&public));
    assert_eq!(api::key_id_of(&public).map(|id| id.len()), Some(16));
    assert!(api::verify_manifest(&public, message, &signature));
    let mut tampered = message.to_vec();
    tampered.push(0);
    assert!(!api::verify_manifest(&public, &tampered, &signature));
    assert!(!api::verify_manifest(&public, message, &signature[..63]));
}

/// An `edits/<name>.json`: parse, write, parse again, write again is a fixed point, and the render argv never carries a NUL.
pub fn edit_doc(data: &[u8]) {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(doc) = api::parse_edit_doc(text) else {
        return;
    };
    let bytes = api::edit_doc_bytes(&doc).expect("a parsed document serialises");
    let written = std::str::from_utf8(&bytes).expect("document bytes are UTF-8");
    let again = api::parse_edit_doc(written).expect("written bytes parse back");
    assert_eq!(
        api::edit_doc_bytes(&again).expect("a parsed document serialises"),
        bytes,
        "writing is a fixed point"
    );
    if let Ok(args) = api::edit_render_args(&doc) {
        assert!(
            args.iter().all(|arg| !arg.contains('\0')),
            "render args carry a NUL"
        );
    }
}

/// A font file followed by `[PostScript name][name length]`: the readers never panic, and a face extracted from a collection has a readable directory whose every table lies inside it.
pub fn sfnt_face(data: &[u8]) {
    let Some((&name_len, rest)) = data.split_last() else {
        return;
    };
    let (font, name) = rest.split_at(rest.len().saturating_sub(usize::from(name_len)));
    let postscript = (name_len > 0)
        .then(|| std::str::from_utf8(name).ok())
        .flatten();
    let probe = api::sfnt_probe(font, postscript);
    let _ = probe.embedding;
    let Some(face) = probe.extracted else {
        return;
    };
    let spans = api::sfnt_table_spans(&face, 0).expect("an extracted face has a directory");
    for (offset, length) in spans {
        assert!(
            u64::from(offset) + u64::from(length) <= face.len() as u64,
            "an extracted face's table runs past its end"
        );
    }
}

/// A movie file: the edit-start reader never panics.
pub fn mp4_edit_start(data: &[u8]) {
    let _ = api::mp4_edit_start(data);
}

/// RGBA8 bytes a fuzz iteration may decode: the app allows four times this, which a loop of hostile one-bit images turns into a 2 GB peak.
const FUZZ_PNG_RGBA_BYTES: u64 = api::MAX_PNG_RGBA_BYTES / 4;

/// The RGBA8 bytes a PNG header asks for, when the signature and IHDR are there.
fn png_rgba_bytes(data: &[u8]) -> Option<u64> {
    let ihdr = data.strip_prefix(b"\x89PNG\r\n\x1a\n")?.get(8..16)?;
    let field = |at: usize| -> Option<u64> {
        Some(u64::from(u32::from_be_bytes(
            ihdr[at..at + 4].try_into().ok()?,
        )))
    };
    field(0)?.checked_mul(field(4)?)?.checked_mul(4)
}

/// A PNG: a decode that succeeds fills exactly width × height RGBA8 texels, and one past the ceiling is refused on its header.
pub fn png_decode(data: &[u8]) {
    let asked = png_rgba_bytes(data);
    if asked.is_some_and(|bytes| bytes > FUZZ_PNG_RGBA_BYTES && bytes <= api::MAX_PNG_RGBA_BYTES) {
        return;
    }
    if let Ok((rgba, width, height)) = api::decode_png_rgba(data) {
        assert_eq!(
            rgba.len() as u64,
            u64::from(width) * u64::from(height) * 4,
            "decoded texels do not match the declared size"
        );
    }
    if asked.is_some_and(|bytes| bytes > api::MAX_PNG_RGBA_BYTES) {
        assert!(
            api::decode_png_rgba(data).is_err(),
            "a PNG past the RGBA ceiling decoded"
        );
    }
}

#[cfg(test)]
mod seeds {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    type Body = fn(&[u8]);

    const TARGETS: &[(&str, Body)] = &[
        ("edit_doc", super::edit_doc),
        ("mp4_edit_start", super::mp4_edit_start),
        ("pack_archive_path", super::pack_archive_path),
        ("pack_manifest", super::pack_manifest),
        ("pack_signature", super::pack_signature),
        ("png_decode", super::png_decode),
        ("sfnt_face", super::sfnt_face),
    ];

    fn crate_dir() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
    }

    /// Visible entries of `dir`, sorted; a missing directory is the failure it names.
    fn entries(dir: &Path) -> Vec<PathBuf> {
        let listing = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
        let mut out: Vec<PathBuf> = listing
            .map(|entry| entry.expect("directory entry").path())
            .filter(|path| {
                !path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            })
            .collect();
        out.sort();
        out
    }

    fn stems(paths: &[PathBuf]) -> BTreeSet<String> {
        paths
            .iter()
            .map(|p| {
                p.file_stem()
                    .expect("a name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn every_target_runs_over_its_seeds() {
        for (name, body) in TARGETS {
            let seeds = entries(&crate_dir().join("seeds").join(name));
            assert!(!seeds.is_empty(), "{name} has no seeds");
            for seed in seeds {
                let bytes = std::fs::read(&seed).expect("a readable seed");
                body(&bytes);
            }
        }
    }

    #[test]
    fn targets_seed_folders_and_wrappers_agree() {
        let bodies: BTreeSet<String> = TARGETS.iter().map(|(name, _)| name.to_string()).collect();
        let folders = stems(&entries(&crate_dir().join("seeds")));
        let wrappers = stems(&entries(&crate_dir().join("fuzz_targets")));
        assert_eq!(folders, bodies, "seeds/ folders and target bodies differ");
        assert_eq!(
            wrappers, bodies,
            "fuzz_targets/ wrappers and target bodies differ"
        );
    }
}
