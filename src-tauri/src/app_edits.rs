//! What the app changed in a project, for the agent working beside it (docs/agent-kit.md, "App edits"): `restamping_trust` wraps every native writer of `project.json` and `scenes/**`, so it compares the sources around each write and appends one line per changed file to `.kookaburra/app-edits.jsonl`. kb only reads the file. Values are the project's own text, capped and escaped here and treated as data by kb. Best effort: a journal that can't be written costs the agent a summary, never the person's edit.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::clean_text::clean_text_with_cap;
use crate::workspace::MANIFEST_FILENAME;

const JOURNAL_DIR: &str = ".kookaburra";
const JOURNAL: &str = "app-edits.jsonl";
const JOURNAL_OLD: &str = "app-edits.1.jsonl";
const JOURNAL_MAX_BYTES: u64 = 256 * 1024;
const LINE_MAX_BYTES: usize = 8 * 1024;
const VALUE_CAP: usize = 120;
const CHANGES_MAX: usize = 32;

/// A project's sources by relative path: the manifest and every non-hidden file under `scenes/`.
pub(crate) type Sources = BTreeMap<String, Vec<u8>>;

pub(crate) fn snapshot(dir: &Path) -> Sources {
    let mut files = Sources::new();
    if let Ok(bytes) = std::fs::read(dir.join(MANIFEST_FILENAME)) {
        files.insert(MANIFEST_FILENAME.to_owned(), bytes);
    }
    let mut stack: Vec<PathBuf> = vec![dir.join("scenes")];
    while let Some(current) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if !meta.is_file() {
                continue;
            } else if let (Ok(rel), Ok(bytes)) = (path.strip_prefix(dir), std::fs::read(&path)) {
                files.insert(rel.to_string_lossy().replace('\\', "/"), bytes);
            }
        }
    }
    files
}

/// One value as the journal stores it: scalars as they are (text capped and escaped), containers by size.
fn shown(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(clean_text_with_cap(text, VALUE_CAP)),
        Value::Array(items) => Value::String(format!("[{} items]", items.len())),
        Value::Object(fields) => Value::String(format!("{{{} keys}}", fields.len())),
        other => other.clone(),
    }
}

fn change(path: &str, before: Option<&Value>, after: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert(
        "path".into(),
        Value::String(clean_text_with_cap(path, VALUE_CAP)),
    );
    if let Some(before) = before {
        out.insert("before".into(), shown(before));
    }
    if let Some(after) = after {
        out.insert("after".into(), shown(after));
    }
    Value::Object(out)
}

fn walk(path: &str, before: &Value, after: &Value, out: &mut Vec<Value>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => walk(&child, x, y, out),
                    (x, y) => out.push(change(&child, x, y)),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                walk(&format!("{path}[{i}]"), x, y, out);
            }
        }
        _ => out.push(change(path, Some(before), Some(after))),
    }
}

/// A scene's stem from its manifest `file`.
fn stem(file: &str) -> &str {
    file.trim_start_matches("scenes/").trim_end_matches(".tsx")
}

/// The scenes array by scene rather than by index: which came and went, whether the order moved, and each surviving entry's own changes.
fn walk_scenes(before: &[Value], after: &[Value], out: &mut Vec<Value>) {
    let file = |scene: &Value| scene.get("file").and_then(Value::as_str).map(str::to_owned);
    let was: Vec<String> = before.iter().filter_map(file).collect();
    let now: Vec<String> = after.iter().filter_map(file).collect();
    let added: Vec<&String> = now.iter().filter(|f| !was.contains(f)).collect();
    let removed: Vec<&String> = was.iter().filter(|f| !now.contains(f)).collect();
    let kept_before: Vec<&String> = was.iter().filter(|f| now.contains(f)).collect();
    let kept_after: Vec<&String> = now.iter().filter(|f| was.contains(f)).collect();
    if !added.is_empty() || !removed.is_empty() || kept_before != kept_after {
        out.push(json!({
            "path": "scenes",
            "added": added.iter().map(|f| clean_text_with_cap(f, VALUE_CAP)).collect::<Vec<_>>(),
            "removed": removed.iter().map(|f| clean_text_with_cap(f, VALUE_CAP)).collect::<Vec<_>>(),
            "moved": kept_before != kept_after,
        }));
    }
    for scene in after {
        let Some(name) = file(scene) else { continue };
        if let Some(old) = before
            .iter()
            .find(|s| file(s).as_deref() == Some(name.as_str()))
        {
            walk(&format!("scenes[{}]", stem(&name)), old, scene, out);
        }
    }
}

fn json_changes(rel: &str, before: &[u8], after: &[u8]) -> Option<Vec<Value>> {
    let a: Value = serde_json::from_slice(before).ok()?;
    let mut b: Value = serde_json::from_slice(after).ok()?;
    let mut a = a;
    let mut out = Vec::new();
    if rel == MANIFEST_FILENAME {
        if let (Some(Value::Array(x)), Some(Value::Array(y))) = (
            a.as_object_mut().and_then(|m| m.remove("scenes")),
            b.as_object_mut().and_then(|m| m.remove("scenes")),
        ) {
            walk_scenes(&x, &y, &mut out);
        }
    }
    walk("", &a, &b, &mut out);
    Some(out)
}

fn entry(rel: &str, before: Option<&Vec<u8>>, after: Option<&Vec<u8>>, at_ms: u64) -> Value {
    let mut line = json!({ "v": 1, "atMs": at_ms, "file": clean_text_with_cap(rel, VALUE_CAP) });
    let fields = line.as_object_mut().expect("a json object");
    match (before, after) {
        (None, Some(_)) => {
            fields.insert("created".into(), Value::Bool(true));
        }
        (Some(_), None) => {
            fields.insert("removed".into(), Value::Bool(true));
        }
        (Some(a), Some(b)) => {
            let changes = rel
                .ends_with(".json")
                .then(|| json_changes(rel, a, b))
                .flatten();
            if let Some(mut changes) = changes {
                let more = changes.len().saturating_sub(CHANGES_MAX);
                changes.truncate(CHANGES_MAX);
                fields.insert("changes".into(), Value::Array(changes));
                if more > 0 {
                    fields.insert("more".into(), json!(more));
                }
            }
        }
        (None, None) => {}
    }
    line
}

/// One line per changed file. A file whose bytes moved but whose JSON didn't (a reformat) is not an edit.
pub(crate) fn entries(before: &Sources, after: &Sources, at_ms: u64) -> Vec<Value> {
    let paths: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let mut out = Vec::new();
    for rel in paths {
        let (a, b) = (before.get(rel), after.get(rel));
        if a == b {
            continue;
        }
        let line = entry(rel, a, b, at_ms);
        let unchanged = line
            .get("changes")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        if !unchanged {
            out.push(line);
        }
    }
    out
}

fn encode(line: &Value) -> String {
    let text = line.to_string();
    if text.len() <= LINE_MAX_BYTES {
        return text;
    }
    // Long values are capped, so only a very wide edit gets here: the file and a count still say something changed.
    let listed = line
        .get("changes")
        .and_then(Value::as_array)
        .map_or(0, Vec::len) as u64;
    let more = line.get("more").and_then(Value::as_u64).unwrap_or(0);
    json!({
        "v": 1,
        "atMs": line.get("atMs").cloned().unwrap_or(Value::Null),
        "file": line.get("file").cloned().unwrap_or(Value::Null),
        "more": listed + more,
    })
    .to_string()
}

/// Never through a link: a folder can arrive with `.kookaburra` or the journal pointing anywhere on the Mac.
fn append(dir: &Path, lines: &[Value]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let folder = dir.join(JOURNAL_DIR);
    if std::fs::symlink_metadata(&folder).is_ok_and(|meta| !meta.is_dir()) {
        return Err(std::io::Error::other(format!(
            "{JOURNAL_DIR} is not a folder"
        )));
    }
    std::fs::create_dir_all(&folder)?;
    let path = folder.join(JOURNAL);
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.is_file() && meta.len() > JOURNAL_MAX_BYTES)
    {
        std::fs::rename(&path, folder.join(JOURNAL_OLD))?;
    }
    let text: String = lines.iter().map(|line| encode(line) + "\n").collect();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    file.write_all(text.as_bytes())
}

/// Journal what changed since `before`.
pub(crate) fn record(dir: &Path, before: &Sources) {
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let lines = entries(before, &snapshot(dir), at_ms);
    if lines.is_empty() {
        return;
    }
    if let Err(e) = append(dir, &lines) {
        log::warn!("[app-edits] {}: {e}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(files: &[(&str, &str)]) -> Sources {
        files
            .iter()
            .map(|(rel, text)| (rel.to_string(), text.as_bytes().to_vec()))
            .collect()
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-app-edits-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        dir
    }

    #[test]
    fn an_audio_change_names_the_field_and_both_values() {
        let before = sources(&[(
            "project.json",
            r#"{"audio":{"file":"assets/a.mp3","fadeOutMs":1000,"gainDb":-3},"scenes":[]}"#,
        )]);
        let after = sources(&[(
            "project.json",
            r#"{"audio":{"file":"assets/a.mp3","fadeOutMs":4000,"gainDb":-6},"scenes":[]}"#,
        )]);
        let lines = entries(&before, &after, 7);
        assert_eq!(
            lines,
            vec![json!({
                "v": 1, "atMs": 7, "file": "project.json",
                "changes": [
                    { "path": "audio.fadeOutMs", "before": 1000, "after": 4000 },
                    { "path": "audio.gainDb", "before": -3, "after": -6 },
                ],
            })]
        );
    }

    #[test]
    fn the_scene_list_is_compared_by_scene_not_by_index() {
        let before = sources(&[(
            "project.json",
            r#"{"scenes":[{"file":"scenes/01-a.tsx","durationMs":3000},{"file":"scenes/02-b.tsx","durationMs":2000}]}"#,
        )]);
        let after = sources(&[(
            "project.json",
            r#"{"scenes":[{"file":"scenes/02-b.tsx","durationMs":2500},{"file":"scenes/03-c.tsx","durationMs":1000},{"file":"scenes/01-a.tsx","durationMs":3000}]}"#,
        )]);
        let lines = entries(&before, &after, 1);
        assert_eq!(
            lines[0]["changes"],
            json!([
                { "path": "scenes", "added": ["scenes/03-c.tsx"], "removed": [], "moved": true },
                { "path": "scenes[02-b].durationMs", "before": 2000, "after": 2500 },
            ])
        );
    }

    #[test]
    fn sidecars_walk_into_arrays_and_code_only_names_the_file() {
        let before = sources(&[
            (
                "scenes/01-a.json",
                r#"{"text":{"title":"Old"},"camera":{"keys":[{"id":"k1","tMs":0},{"id":"k2","tMs":2000}]}}"#,
            ),
            ("scenes/01-a.tsx", "old code"),
        ]);
        let after = sources(&[
            (
                "scenes/01-a.json",
                r#"{"text":{"title":"New"},"camera":{"keys":[{"id":"k1","tMs":0},{"id":"k2","tMs":2500}]}}"#,
            ),
            ("scenes/01-a.tsx", "new code"),
            ("scenes/02-b.json", "{}"),
        ]);
        let lines = entries(&before, &after, 1);
        assert_eq!(lines[0]["file"], "scenes/01-a.json");
        assert_eq!(
            lines[0]["changes"],
            json!([
                { "path": "camera.keys[1].tMs", "before": 2000, "after": 2500 },
                { "path": "text.title", "before": "Old", "after": "New" },
            ])
        );
        assert_eq!(
            lines[1],
            json!({ "v": 1, "atMs": 1, "file": "scenes/01-a.tsx" })
        );
        assert_eq!(
            lines[2],
            json!({ "v": 1, "atMs": 1, "file": "scenes/02-b.json", "created": true })
        );
        let gone = entries(&after, &before, 2);
        assert_eq!(gone[2]["removed"], true);
    }

    #[test]
    fn a_reformat_is_not_an_edit_and_values_are_capped_and_escaped() {
        let before = sources(&[("scenes/01-a.json", r#"{"text":{"title":"Same"}}"#)]);
        let spaced = sources(&[(
            "scenes/01-a.json",
            "{ \"text\": { \"title\": \"Same\" } }\n",
        )]);
        assert!(entries(&before, &spaced, 1).is_empty());
        let long = "x".repeat(400);
        let hostile = sources(&[(
            "scenes/01-a.json",
            &format!("{{\"text\":{{\"title\":\"\\u001b]52;c;x\\u0007{long}\"}}}}"),
        )]);
        let lines = entries(&before, &hostile, 1);
        let after = lines[0]["changes"][0]["after"].as_str().unwrap();
        assert!(!after.contains('\u{1b}'), "{after}");
        assert!(after.contains("\\u001B"), "{after}");
        assert!(after.chars().count() < 200, "{after}");
    }

    #[test]
    fn a_pipe_in_scenes_is_never_opened() {
        let dir = scratch("fifo");
        let pipe = std::ffi::CString::new(dir.join("scenes/x.tsx").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o644) }, 0);
        assert!(!snapshot(&dir).contains_key("scenes/x.tsx"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_line_too_long_to_list_keeps_its_count() {
        let changes: Vec<Value> = (0..CHANGES_MAX)
            .map(|i| json!({ "path": format!("k{i}"), "before": "x".repeat(200), "after": "y".repeat(200) }))
            .collect();
        let line =
            json!({ "v": 1, "atMs": 1, "file": "project.json", "changes": changes, "more": 3 });
        let short: Value = serde_json::from_str(&encode(&line)).unwrap();
        assert_eq!(short["more"], CHANGES_MAX as u64 + 3);
        assert!(short.get("changes").is_none());
    }

    #[test]
    fn a_very_wide_edit_is_counted_not_listed_in_full() {
        let mut before = Map::new();
        let mut after = Map::new();
        for i in 0..80 {
            before.insert(format!("k{i:02}"), json!(i));
            after.insert(format!("k{i:02}"), json!(i + 1));
        }
        let a = sources(&[("scenes/01-a.json", &Value::Object(before).to_string())]);
        let b = sources(&[("scenes/01-a.json", &Value::Object(after).to_string())]);
        let lines = entries(&a, &b, 1);
        assert_eq!(lines[0]["changes"].as_array().unwrap().len(), CHANGES_MAX);
        assert_eq!(lines[0]["more"], 48);
    }

    #[test]
    fn record_appends_and_rotates() {
        let dir = scratch("record");
        std::fs::write(
            dir.join("project.json"),
            r#"{"audio":{"gainDb":0},"scenes":[]}"#,
        )
        .unwrap();
        let before = snapshot(&dir);
        record(&dir, &before);
        assert!(
            !dir.join(JOURNAL_DIR).join(JOURNAL).exists(),
            "nothing changed"
        );
        std::fs::write(
            dir.join("project.json"),
            r#"{"audio":{"gainDb":-6},"scenes":[]}"#,
        )
        .unwrap();
        record(&dir, &before);
        let text = std::fs::read_to_string(dir.join(JOURNAL_DIR).join(JOURNAL)).unwrap();
        let line: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(line["changes"][0]["path"], "audio.gainDb");
        std::fs::write(
            dir.join(JOURNAL_DIR).join(JOURNAL),
            "x".repeat(JOURNAL_MAX_BYTES as usize + 1),
        )
        .unwrap();
        record(&dir, &before);
        assert!(dir.join(JOURNAL_DIR).join(JOURNAL_OLD).is_file());
        let fresh = std::fs::read_to_string(dir.join(JOURNAL_DIR).join(JOURNAL)).unwrap();
        assert_eq!(fresh.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_planted_link_never_takes_a_journal_line() {
        for link_folder in [false, true] {
            let dir = scratch(if link_folder {
                "link-folder"
            } else {
                "link-file"
            });
            let target = dir.join("profile");
            std::fs::write(&target, "mine\n").unwrap();
            std::fs::write(dir.join("project.json"), r#"{"name":"A"}"#).unwrap();
            let before = snapshot(&dir);
            if link_folder {
                let elsewhere = dir.join("elsewhere");
                std::fs::create_dir_all(&elsewhere).unwrap();
                std::os::unix::fs::symlink(&elsewhere, dir.join(JOURNAL_DIR)).unwrap();
                std::fs::write(dir.join("project.json"), r#"{"name":"B"}"#).unwrap();
                record(&dir, &before);
                assert!(!elsewhere.join(JOURNAL).exists());
            } else {
                std::fs::create_dir_all(dir.join(JOURNAL_DIR)).unwrap();
                std::os::unix::fs::symlink(&target, dir.join(JOURNAL_DIR).join(JOURNAL)).unwrap();
                std::fs::write(dir.join("project.json"), r#"{"name":"B"}"#).unwrap();
                record(&dir, &before);
            }
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "mine\n");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_linked_scene_file_stays_out_of_the_snapshot() {
        let dir = scratch("snapshot-link");
        let secret = dir.join("secret.json");
        std::fs::write(&secret, "{}").unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("scenes/01-a.json")).unwrap();
        assert!(snapshot(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_and_foreign_files_stay_out_of_the_snapshot() {
        let dir = scratch("snapshot");
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        std::fs::write(dir.join("scenes/01-a.tsx"), "code").unwrap();
        std::fs::write(dir.join("scenes/.hidden.tmp"), "x").unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "notes").unwrap();
        let names: Vec<String> = snapshot(&dir).into_keys().collect();
        assert_eq!(names, ["project.json", "scenes/01-a.tsx"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
