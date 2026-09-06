use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

use crate::workspace::{require_root, validate_slug, SettingsState};

type ReadyReply = (u64, oneshot::Sender<Result<(), String>>);

#[derive(Default)]
pub struct ThemeMoveState {
    gate: tokio::sync::Mutex<()>,
    ready: Mutex<Option<ReadyReply>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeMoveResult {
    pub old_id: String,
    pub theme_id: String,
    pub json: String,
    pub updated_files: usize,
    pub recovery_path: String,
}

struct Change {
    path: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn real(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !canonical.starts_with(root)
        || fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err(format!(
            "Refusing a linked content path: {}",
            path.display()
        ));
    }
    Ok(canonical)
}

fn pretty(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn replace_reference(value: &mut Value, from: &str, to: &str) -> bool {
    if value.get("themeId").and_then(Value::as_str) != Some(from) {
        return false;
    }
    value["themeId"] = Value::String(to.into());
    true
}

fn collect_documents(
    container: &Path,
    root: &Path,
    paths: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    if !container.exists() {
        return Ok(());
    }
    let container = real(container, root)?;
    for entry in fs::read_dir(container).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            || !path.is_dir()
        {
            continue;
        }
        if !path.join("project.json").is_file() {
            continue;
        }
        let dir = real(&path, root)?;
        paths.insert(real(&dir.join("project.json"), root)?);
        let scenes = dir.join("scenes");
        if !scenes.exists() {
            continue;
        }
        for entry in fs::read_dir(real(&scenes, root)?).map_err(|e| e.to_string())? {
            let file = entry.map_err(|e| e.to_string())?.path();
            if file.extension().is_some_and(|e| e == "json") {
                paths.insert(real(&file, root)?);
            }
        }
    }
    Ok(())
}

fn replace_file(path: &Path, expected: &[u8], bytes: &[u8]) -> Result<(), String> {
    if read(path)? != expected {
        return Err(format!(
            "Content changed during the move: {}",
            path.display()
        ));
    }
    let tmp = path.with_extension(format!("theme-move-{}.tmp", std::process::id()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if read(path)? != expected {
            return Err(format!(
                "Content changed during the move: {}",
                path.display()
            ));
        }
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(tmp);
    result
}

fn move_theme(
    workspace: &Path,
    checkout: &Path,
    slug: &str,
    id: &str,
    name: &str,
    category: &str,
    fail_after: Option<usize>,
) -> Result<ThemeMoveResult, String> {
    validate_slug(slug)?;
    validate_slug(id)?;
    if name.trim().is_empty() {
        return Err("Give the app theme a name.".into());
    }
    if ![
        "essentials",
        "quiet-technology",
        "human-centred-ai",
        "maker-energy",
        "sensory-and-surreal",
        "digital-assets",
        "modern-finance",
    ]
    .contains(&category)
    {
        return Err("Choose a theme category.".into());
    }
    let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
    let checkout = checkout.canonicalize().map_err(|e| e.to_string())?;
    let source = real(&workspace.join("themes").join(slug), &workspace)?;
    let source_file = real(&source.join("theme.json"), &workspace)?;
    let original = read(&source_file)?;
    let mut doc: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
    if !doc.is_object() || !matches!(doc.get("version").and_then(Value::as_u64), Some(1 | 2)) {
        return Err("This theme needs a supported theme document version.".into());
    }
    let destination =
        real(&checkout.join("src/theme/builtin"), &checkout)?.join(format!("{id}.json"));
    if destination.exists() {
        return Err("An app theme already uses that identity. Choose another name.".into());
    }
    doc["id"] = json!(id);
    doc["name"] = json!(name.trim());
    if doc.get("catalogue").is_none() {
        doc["catalogue"] = json!({});
    }
    let catalogue = doc
        .get_mut("catalogue")
        .and_then(Value::as_object_mut)
        .ok_or("The theme catalogue must be an object.")?;
    catalogue.insert("category".into(), json!(category));
    catalogue
        .entry("useLabel")
        .or_insert(json!("Custom app theme"));
    catalogue.entry("tags").or_insert(json!([]));
    catalogue.entry("stage").or_insert(json!("none"));
    if !catalogue
        .get("useLabel")
        .and_then(Value::as_str)
        .is_some_and(|label| !label.trim().is_empty())
        || !catalogue
            .get("tags")
            .and_then(Value::as_array)
            .is_some_and(|tags| {
                tags.iter()
                    .all(|tag| tag.as_str().is_some_and(|tag| !tag.trim().is_empty()))
            })
        || !catalogue
            .get("stage")
            .and_then(Value::as_str)
            .is_some_and(|stage| ["physical", "lighting-only", "none"].contains(&stage))
        || catalogue
            .get("hidden")
            .is_some_and(|value| !value.is_boolean())
        || catalogue.get("order").is_some_and(|value| {
            value
                .as_u64()
                .map_or(true, |order| order > 9_007_199_254_740_991)
        })
    {
        return Err(
            "Fix the theme's catalogue fields in the theme editor before moving it.".into(),
        );
    }
    let new_theme = pretty(&doc)?;
    let old_id = format!("ws:{slug}");
    let mut paths = BTreeSet::new();
    for container in [
        &workspace,
        &workspace.join("templates"),
        &workspace.join("presets"),
    ] {
        collect_documents(container, &workspace, &mut paths)?;
    }
    for container in [checkout.join("projects"), checkout.join("presets")] {
        collect_documents(&container, &checkout, &mut paths)?;
    }
    let mut changes = Vec::new();
    for path in paths {
        let before = read(&path)?;
        let mut doc: Value =
            serde_json::from_slice(&before).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut changed = replace_reference(&mut doc, &old_id, id);
        if path.file_name().is_some_and(|name| name != "project.json") {
            if let Some(compare) = doc.get_mut("compare") {
                for side in ["a", "b"] {
                    if let Some(value) = compare.get_mut(side) {
                        changed |= replace_reference(value, &old_id, id);
                    }
                }
            }
        }
        if changed {
            changes.push(Change {
                path,
                before,
                after: pretty(&doc)?,
            });
        }
    }
    let recovery_root = workspace.join(".theme-moves");
    fs::create_dir_all(&recovery_root).map_err(|e| e.to_string())?;
    let recovery_root = real(&recovery_root, &workspace)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let recovery = loop {
        let path = recovery_root.join(format!(
            "{slug}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let staged = recovery.join("destination.json");
    fs::write(&staged, &new_theme).map_err(|e| e.to_string())?;
    fs::write(recovery.join("source.json"), &original).map_err(|e| e.to_string())?;
    for (index, change) in changes.iter().enumerate() {
        fs::write(
            recovery.join(format!("{index}.before.json")),
            &change.before,
        )
        .map_err(|e| e.to_string())?;
        fs::write(recovery.join(format!("{index}.after.json")), &change.after)
            .map_err(|e| e.to_string())?;
    }
    let mut journal = json!({"status":"pending", "source":source, "destination":destination, "references":changes.iter().map(|c| &c.path).collect::<Vec<_>>()});
    fs::write(recovery.join("journal.json"), pretty(&journal)?).map_err(|e| e.to_string())?;
    let mut published = false;
    let mut applied = 0;
    let result = (|| {
        fs::hard_link(&staged, &destination)
            .map_err(|e| format!("Cannot create the app theme without replacing content: {e}"))?;
        published = true;
        for change in &changes {
            if fail_after == Some(applied) {
                return Err("Interrupted theme move".into());
            }
            replace_file(&change.path, &change.before, &change.after)?;
            applied += 1;
        }
        if fail_after == Some(applied) {
            return Err("Interrupted theme move".into());
        }
        if read(&source_file)? != original {
            return Err(
                "The personal theme changed during the move. Try again after saving.".into(),
            );
        }
        for change in &changes {
            if read(&change.path)? != change.after {
                return Err(format!(
                    "Content changed during the move: {}",
                    change.path.display()
                ));
            }
        }
        if read(&destination)? != new_theme {
            return Err("The app theme changed during the move.".into());
        }
        fs::rename(&source, recovery.join("source-theme")).map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        let mut incomplete = Vec::new();
        for change in changes[..applied].iter().rev() {
            if let Err(e) = replace_file(&change.path, &change.after, &change.before) {
                incomplete.push(e);
            }
        }
        if published
            && incomplete.is_empty()
            && read(&destination).ok().as_deref() == Some(&new_theme)
        {
            if let Err(e) = fs::remove_file(&destination) {
                incomplete.push(e.to_string());
            }
        }
        journal["status"] = json!(if incomplete.is_empty() {
            "rolled-back"
        } else {
            "incomplete"
        });
        let _ = fs::write(recovery.join("journal.json"), pretty(&journal)?);
        return Err(format!(
            "{error}. The personal theme is retained. Recovery files: {}. {}",
            recovery.display(),
            incomplete.join("; ")
        ));
    }
    journal["status"] = json!("complete");
    if let Err(e) = fs::write(recovery.join("journal.json"), pretty(&journal)?) {
        log::warn!("Theme move completed, but its journal could not be updated: {e}");
    }
    Ok(ThemeMoveResult {
        old_id,
        theme_id: id.into(),
        json: String::from_utf8(new_theme).map_err(|e| e.to_string())?,
        updated_files: changes.len(),
        recovery_path: recovery.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
        checkout: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "theme-move-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let workspace = root.join("workspace");
            let checkout = root.join("checkout");
            fs::create_dir_all(workspace.join("themes/personal")).unwrap();
            fs::create_dir_all(checkout.join("src/theme/builtin")).unwrap();
            fs::write(workspace.join("themes/personal/theme.json"), r#"{"version":2,"id":"old","name":"Personal","future":{"keep":42},"catalogue":{"category":"essentials","tags":["custom"],"useLabel":"Test","stage":"physical","future":"keep"}}"#).unwrap();
            Self {
                root,
                workspace,
                checkout,
            }
        }
        fn project(&self, base: &Path, slug: &str) -> PathBuf {
            let dir = base.join(slug);
            fs::create_dir_all(dir.join("scenes")).unwrap();
            fs::write(
                dir.join("project.json"),
                r#"{"version":2,"themeId":"ws:personal","future":42}"#,
            )
            .unwrap();
            fs::write(dir.join("scenes/one.json"), r#"{"version":1,"themeId":"ws:personal","compare":{"b":{"themeId":"ws:personal"}},"text":{"themeId":"ws:personal"}}"#).unwrap();
            dir
        }
        fn run(&self, fail: Option<usize>) -> Result<ThemeMoveResult, String> {
            move_theme(
                &self.workspace,
                &self.checkout,
                "personal",
                "new-app",
                "New app",
                "maker-energy",
                fail,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn moves_raw_theme_and_all_scoped_references_with_recoverable_originals() {
        let f = Fixture::new();
        let dirs = [
            f.project(&f.workspace, "project"),
            f.project(&f.workspace.join("templates"), "template"),
            f.project(&f.workspace.join("presets"), "preset"),
            f.project(&f.checkout.join("projects"), "bundled"),
            f.project(&f.checkout.join("presets"), "bundled"),
        ];
        let untouched = f.project(&f.root.join("other-worktree"), "untouched");
        let result = f.run(None).unwrap();
        assert_eq!(result.updated_files, 10);
        assert!(!f.workspace.join("themes/personal").exists());
        assert!(Path::new(&result.recovery_path)
            .join("source-theme/theme.json")
            .is_file());
        let doc: Value = serde_json::from_str(&result.json).unwrap();
        assert_eq!(doc["id"], "new-app");
        assert_eq!(doc["future"]["keep"], 42);
        assert_eq!(doc["catalogue"]["future"], "keep");
        assert_eq!(doc["catalogue"]["stage"], "physical");
        for dir in dirs {
            let scene: Value =
                serde_json::from_slice(&read(&dir.join("scenes/one.json")).unwrap()).unwrap();
            assert_eq!(scene["themeId"], "new-app");
            assert_eq!(scene["compare"]["b"]["themeId"], "new-app");
            assert_eq!(scene["text"]["themeId"], "ws:personal");
        }
        assert!(
            String::from_utf8(read(&untouched.join("project.json")).unwrap())
                .unwrap()
                .contains("ws:personal")
        );
    }

    #[test]
    fn rejects_collisions_without_replacing_either_theme() {
        let f = Fixture::new();
        let destination = f.checkout.join("src/theme/builtin/new-app.json");
        fs::write(&destination, "existing").unwrap();
        assert!(f.run(None).unwrap_err().contains("already uses"));
        assert_eq!(read(&destination).unwrap(), b"existing");
        assert!(f.workspace.join("themes/personal/theme.json").exists());
    }

    #[test]
    fn interrupted_moves_restore_references_and_keep_the_source_and_journal() {
        for fail in 0..=2 {
            let f = Fixture::new();
            let project = f.project(&f.workspace, "project");
            let before = read(&project.join("project.json")).unwrap();
            assert!(f.run(Some(fail)).unwrap_err().contains("Recovery files"));
            assert_eq!(read(&project.join("project.json")).unwrap(), before);
            assert!(f.workspace.join("themes/personal/theme.json").exists());
            assert!(!f.checkout.join("src/theme/builtin/new-app.json").exists());
            let recovery = fs::read_dir(f.workspace.join(".theme-moves"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert!(read(&recovery.join("journal.json")).is_ok());
            assert!(read(&recovery.join("source.json")).is_ok());
        }
    }

    #[test]
    fn malformed_content_stops_before_publishing() {
        let f = Fixture::new();
        let dir = f.project(&f.workspace, "invalid");
        fs::write(dir.join("scenes/one.json"), "invalid").unwrap();
        assert!(f.run(None).is_err());
        assert!(!f.checkout.join("src/theme/builtin/new-app.json").exists());
        assert!(f.workspace.join("themes/personal/theme.json").exists());
    }

    #[test]
    fn rejects_linked_content_and_concurrent_reference_changes() {
        let f = Fixture::new();
        let external = f.project(&f.root, "outside");
        std::os::unix::fs::symlink(&external, f.workspace.join("linked")).unwrap();
        assert!(f.run(None).unwrap_err().contains("linked content"));
        let path = external.join("project.json");
        assert!(replace_file(&path, b"obsolete", b"replacement")
            .unwrap_err()
            .contains("changed"));
        assert_ne!(read(&path).unwrap(), b"replacement");
    }
}

#[tauri::command]
pub fn theme_editor_move_ready(
    window: WebviewWindow,
    state: State<'_, ThemeMoveState>,
    request_id: u64,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "theme-editor" {
        return Err("Only the theme editor can complete its save.".into());
    }
    let mut ready = state.ready.lock().map_err(|e| e.to_string())?;
    if ready.as_ref().is_some_and(|(id, _)| *id == request_id) {
        if let Some((_, sender)) = ready.take() {
            let _ = sender.send(error.map_or(Ok(()), Err));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn dev_move_theme(
    app: AppHandle,
    state: State<'_, ThemeMoveState>,
    settings: State<'_, SettingsState>,
    slug: String,
    id: String,
    name: String,
    category: String,
) -> Result<ThemeMoveResult, String> {
    let _guard = state.gate.lock().await;
    let workspace = require_root(&app, &settings)?;
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let old_id = format!("ws:{slug}");
    let result = async {
        if let Some(window) = app.get_webview_window("theme-editor") {
            static REQUEST: AtomicU64 = AtomicU64::new(1);
            let request_id = REQUEST.fetch_add(1, Ordering::Relaxed);
            let (sender, receiver) = oneshot::channel();
            *state.ready.lock().map_err(|e| e.to_string())? = Some((request_id, sender));
            window
                .emit(
                    "kookaburra://theme-move-prepare",
                    json!({"requestId":request_id,"themeId":old_id}),
                )
                .map_err(|e| e.to_string())?;
            let response = tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await;
            state.ready.lock().map_err(|e| e.to_string())?.take();
            response
                .map_err(|_| {
                    "The theme editor did not finish saving. Close it and try again.".to_string()
                })?
                .map_err(|e| e.to_string())??;
        }
        tauri::async_runtime::spawn_blocking(move || {
            move_theme(&workspace, &checkout, &slug, &id, &name, &category, None)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    let payload = match &result {
        Ok(moved) => serde_json::to_value(moved).map_err(|e| e.to_string())?,
        Err(error) => json!({"oldId":old_id,"error":error}),
    };
    let _ = app.emit("kookaburra://theme-move-finished", payload);
    if let Ok(moved) = &result {
        if let Ok(mut target) = app
            .state::<crate::theme_editor_win::ThemeEditorState>()
            .0
            .lock()
        {
            if target.as_ref().is_some_and(|t| t.theme_id == old_id) {
                *target = Some(crate::theme_editor_win::ThemeEditorTarget {
                    theme_id: moved.theme_id.clone(),
                });
            }
        }
    }
    result
}
