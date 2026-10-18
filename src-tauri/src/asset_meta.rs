//! Asset provenance: `assets/_meta.json` v1, one record per asset, `{ version, assets: { rel: { sha256, origin { kind, from, sourceName, tool, atMs }, licence?, transforms[] } } }`. An underscore name, not a dot file, so packs carry and hash it like any project file; the media library never lists it. Project-relative paths only, and a record whose `sha256` no longer matches its file reads as stale. Fields this build doesn't write (`licence`, anything newer) survive a rewrite.

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

/// The provenance record's project-relative path.
pub(crate) const META_REL: &str = "assets/_meta.json";

const META_VERSION: u64 = 1;

/// Serialises this process's read-modify-write cycles (two conform jobs can land together).
static WRITES: Mutex<()> = Mutex::new(());

fn project_rel(rel: &str) -> Result<(), String> {
    let ok = rel.starts_with("assets/")
        && rel.len() > "assets/".len()
        && !rel.contains('\\')
        && !rel.split('/').any(|part| part.is_empty() || part == "." || part == "..");
    if ok {
        Ok(())
    } else {
        Err(format!("provenance paths are project-relative under assets/, not {rel:?}"))
    }
}

/// `origin.from` is another asset, `origin.sourceName` a bare file name: never an absolute path.
fn check_origin(origin: &Value) -> Result<(), String> {
    let Some(fields) = origin.as_object() else {
        return Err("origin must be an object".into());
    };
    if let Some(from) = fields.get("from").filter(|v| !v.is_null()) {
        project_rel(from.as_str().ok_or("origin.from must be a string")?)?;
    }
    if let Some(name) = fields.get("sourceName").filter(|v| !v.is_null()) {
        let name = name.as_str().ok_or("origin.sourceName must be a string")?;
        if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
            return Err(format!("origin.sourceName must be a bare file name, not {name:?}"));
        }
    }
    Ok(())
}

fn read_meta(project: &Path) -> Result<Map<String, Value>, String> {
    let path = project.join(META_REL);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Map::from_iter([
                ("version".into(), json!(META_VERSION)),
                ("assets".into(), json!({})),
            ]));
        }
        Err(e) => return Err(format!("reading {META_REL}: {e}")),
    };
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("{META_REL} isn't valid JSON: {e}"))?;
    let Value::Object(mut doc) = doc else {
        return Err(format!("{META_REL} must be a JSON object"));
    };
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != META_VERSION {
        return Err(format!(
            "{META_REL} is version {version}; this build reads version {META_VERSION}"
        ));
    }
    if !doc.get("assets").is_some_and(Value::is_object) {
        doc.insert("assets".into(), json!({}));
    }
    Ok(doc)
}

fn write_meta(project: &Path, doc: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    crate::write_atomic(&project.join(META_REL), format!("{text}\n").as_bytes())
}

fn assets_of(doc: &mut Map<String, Value>) -> &mut Map<String, Value> {
    doc.get_mut("assets")
        .and_then(Value::as_object_mut)
        .expect("read_meta guarantees an assets object")
}

fn sha256_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(crate::hex_digest(hasher.finalize().as_slice()))
}

/// Record where `rel` came from and what was done to it, hashing the file as it is now; replaces any earlier origin and transforms, keeping the record's other fields (a `licence`).
pub(crate) fn record_asset_origin(
    project: &Path,
    rel: &str,
    origin: Value,
    transforms: Vec<Value>,
) -> Result<(), String> {
    project_rel(rel)?;
    check_origin(&origin)?;
    let sha = sha256_of(&project.join(rel)).map_err(|e| format!("hashing {rel}: {e}"))?;
    let _serial = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_meta(project)?;
    let record = assets_of(&mut doc)
        .entry(rel.to_owned())
        .or_insert_with(|| json!({}));
    if !record.is_object() {
        *record = json!({});
    }
    let fields = record.as_object_mut().expect("just made an object");
    fields.insert("sha256".into(), Value::String(sha));
    fields.insert("origin".into(), origin);
    fields.insert("transforms".into(), Value::Array(transforms));
    write_meta(project, &doc)
}

/// Drop `rel`'s record (its file was deleted); a missing record file is nothing to do.
pub(crate) fn forget_asset(project: &Path, rel: &str) -> Result<(), String> {
    if !project.join(META_REL).is_file() {
        return Ok(());
    }
    let _serial = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_meta(project)?;
    if assets_of(&mut doc).remove(rel).is_none() {
        return Ok(());
    }
    write_meta(project, &doc)
}

/// An original left the project (Remove original): every record whose `origin.from` names it loses that link and gains `origin.originalRemovedAtMs`, and any record of the original itself goes. Returns how many records changed; a missing record file is nothing to do.
pub(crate) fn detach_original(project: &Path, original: &str, at_ms: u64) -> Result<usize, String> {
    project_rel(original)?;
    if !project.join(META_REL).is_file() {
        return Ok(0);
    }
    let _serial = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_meta(project)?;
    let assets = assets_of(&mut doc);
    let mut changed = usize::from(assets.remove(original).is_some());
    for record in assets.values_mut() {
        let Some(origin) = record.get_mut("origin").and_then(Value::as_object_mut) else {
            continue;
        };
        if origin.get("from").and_then(Value::as_str) == Some(original) {
            origin.remove("from");
            origin.insert("originalRemovedAtMs".into(), json!(at_ms));
            changed += 1;
        }
    }
    if changed > 0 {
        write_meta(project, &doc)?;
    }
    Ok(changed)
}

/// One asset's provenance as recorded, with whether its file has changed since (`stale`: the sha256 no longer matches, or the file is gone).
#[allow(dead_code)] // Read by kb's `assets meta` in a later wave.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AssetRecord {
    pub record: Value,
    pub stale: bool,
}

/// `rel`'s record, if any.
#[allow(dead_code)] // Read by kb's `assets meta` in a later wave.
pub(crate) fn asset_record(project: &Path, rel: &str) -> Result<Option<AssetRecord>, String> {
    project_rel(rel)?;
    let mut doc = read_meta(project)?;
    let Some(record) = assets_of(&mut doc).remove(rel) else {
        return Ok(None);
    };
    let recorded = record.get("sha256").and_then(Value::as_str);
    let stale = match sha256_of(&project.join(rel)) {
        Ok(sha) => recorded != Some(sha.as_str()),
        Err(_) => true,
    };
    Ok(Some(AssetRecord { record, stale }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-meta-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets/.originals")).unwrap();
        dir
    }

    fn conform_origin() -> Value {
        json!({ "kind": "import", "from": "assets/.originals/rec.mov", "sourceName": "rec.mov", "tool": "app import", "atMs": 1 })
    }

    fn conform_steps() -> Vec<Value> {
        vec![json!({ "op": "conform", "fps": 60, "colour": "bt709" })]
    }

    #[test]
    fn a_record_lands_with_the_file_hash_and_reads_fresh() {
        let project = scratch("record");
        std::fs::write(project.join("assets/rec.mp4"), b"mezzanine").unwrap();
        record_asset_origin(&project, "assets/rec.mp4", conform_origin(), conform_steps())
            .unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(project.join(META_REL)).unwrap())
                .unwrap();
        assert_eq!(doc["version"], 1);
        let record = &doc["assets"]["assets/rec.mp4"];
        assert_eq!(record["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(record["origin"]["from"], "assets/.originals/rec.mov");
        assert_eq!(record["transforms"][0]["op"], "conform");
        let read = asset_record(&project, "assets/rec.mp4").unwrap().unwrap();
        assert!(!read.stale);
        assert_eq!(asset_record(&project, "assets/other.mp4").unwrap(), None);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_changed_or_missing_file_reads_stale() {
        let project = scratch("stale");
        std::fs::write(project.join("assets/rec.mp4"), b"one").unwrap();
        record_asset_origin(&project, "assets/rec.mp4", conform_origin(), conform_steps())
            .unwrap();
        std::fs::write(project.join("assets/rec.mp4"), b"two").unwrap();
        assert!(asset_record(&project, "assets/rec.mp4").unwrap().unwrap().stale);
        std::fs::remove_file(project.join("assets/rec.mp4")).unwrap();
        assert!(asset_record(&project, "assets/rec.mp4").unwrap().unwrap().stale);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_rewrite_keeps_other_records_and_unknown_fields() {
        let project = scratch("merge");
        std::fs::write(project.join("assets/rec.mp4"), b"one").unwrap();
        std::fs::write(
            project.join(META_REL),
            r#"{"version":1,"assets":{"assets/rec.mp4":{"licence":{"id":"proprietary"}},"assets/logo.png":{"sha256":"x"}}}"#,
        )
        .unwrap();
        record_asset_origin(&project, "assets/rec.mp4", conform_origin(), conform_steps())
            .unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(project.join(META_REL)).unwrap())
                .unwrap();
        assert_eq!(doc["assets"]["assets/rec.mp4"]["licence"]["id"], "proprietary");
        assert_eq!(doc["assets"]["assets/logo.png"]["sha256"], "x");
        forget_asset(&project, "assets/rec.mp4").unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(project.join(META_REL)).unwrap())
                .unwrap();
        assert!(doc["assets"].get("assets/rec.mp4").is_none());
        assert_eq!(doc["assets"]["assets/logo.png"]["sha256"], "x");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn absolute_paths_and_newer_versions_are_refused() {
        let project = scratch("refuse");
        std::fs::write(project.join("assets/rec.mp4"), b"one").unwrap();
        let absolute = json!({ "kind": "import", "from": "/Users/x/rec.mov", "tool": "app import", "atMs": 1 });
        assert!(record_asset_origin(&project, "assets/rec.mp4", absolute, vec![]).is_err());
        let named = json!({ "kind": "import", "sourceName": "/Users/x/rec.mov", "tool": "app import", "atMs": 1 });
        assert!(record_asset_origin(&project, "assets/rec.mp4", named, vec![]).is_err());
        assert!(record_asset_origin(&project, "/Users/x/rec.mp4", conform_origin(), vec![]).is_err());
        assert!(record_asset_origin(&project, "assets/../rec.mp4", conform_origin(), vec![]).is_err());
        std::fs::write(project.join(META_REL), r#"{"version":2,"assets":{}}"#).unwrap();
        assert!(record_asset_origin(&project, "assets/rec.mp4", conform_origin(), vec![]).is_err());
        assert_eq!(
            std::fs::read_to_string(project.join(META_REL)).unwrap(),
            r#"{"version":2,"assets":{}}"#
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_removed_original_unlinks_every_record_that_came_from_it() {
        let project = scratch("detach");
        std::fs::write(project.join("assets/rec.mp4"), b"mezzanine").unwrap();
        std::fs::write(project.join("assets/other.mp4"), b"other").unwrap();
        record_asset_origin(&project, "assets/rec.mp4", conform_origin(), conform_steps())
            .unwrap();
        let elsewhere = json!({ "kind": "import", "from": "assets/.originals/other.mov", "sourceName": "other.mov", "tool": "app import", "atMs": 1 });
        record_asset_origin(&project, "assets/other.mp4", elsewhere, conform_steps()).unwrap();
        assert_eq!(
            detach_original(&project, "assets/.originals/rec.mov", 42).unwrap(),
            1
        );
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(project.join(META_REL)).unwrap())
                .unwrap();
        let origin = &doc["assets"]["assets/rec.mp4"]["origin"];
        assert!(origin.get("from").is_none());
        assert_eq!(origin["originalRemovedAtMs"], 42);
        assert_eq!(origin["sourceName"], "rec.mov");
        assert_eq!(doc["assets"]["assets/rec.mp4"]["transforms"][0]["op"], "conform");
        assert_eq!(
            doc["assets"]["assets/other.mp4"]["origin"]["from"],
            "assets/.originals/other.mov"
        );
        let before = std::fs::read_to_string(project.join(META_REL)).unwrap();
        assert_eq!(
            detach_original(&project, "assets/.originals/rec.mov", 43).unwrap(),
            0
        );
        assert_eq!(std::fs::read_to_string(project.join(META_REL)).unwrap(), before);
        assert!(detach_original(&project, "/Users/x/rec.mov", 1).is_err());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn detaching_without_a_record_file_writes_nothing() {
        let project = scratch("detach-none");
        assert_eq!(
            detach_original(&project, "assets/.originals/rec.mov", 1).unwrap(),
            0
        );
        assert!(!project.join(META_REL).exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn forgetting_without_a_record_file_writes_nothing() {
        let project = scratch("forget");
        forget_asset(&project, "assets/rec.mp4").unwrap();
        assert!(!project.join(META_REL).exists());
        let _ = std::fs::remove_dir_all(&project);
    }
}
