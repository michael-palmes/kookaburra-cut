use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::EditorContextState;
use crate::workspace::{self, SettingsState};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterJob {
    slug: String,
    revision: String,
    at_ms: Option<f64>,
    slot: usize,
    scene_file: String,
    aspect: String,
    #[serde(skip)]
    claimed: bool,
}

#[derive(Default)]
pub(crate) struct PosterQueue {
    jobs: BTreeMap<String, PosterJob>,
    completed: BTreeMap<String, String>,
}

impl PosterQueue {
    pub(crate) fn invalidate(&mut self, slug: &str, slot: usize) {
        self.completed.remove(&job_key(slug, slot));
    }

    fn submit(&mut self, job: PosterJob, poster_exists: bool) {
        let key = job_key(&job.slug, job.slot);
        if poster_exists && self.completed.get(&key) == Some(&job.revision) {
            return;
        }
        if self
            .jobs
            .get(&key)
            .is_some_and(|j| j.revision == job.revision)
        {
            return;
        }
        self.jobs.insert(key, job);
    }

    fn take(&mut self) -> Option<PosterJob> {
        let job = self.jobs.values_mut().find(|job| !job.claimed)?;
        job.claimed = true;
        Some(job.clone())
    }

    fn owns(&self, slug: &str, slot: usize, revision: &str) -> bool {
        self.jobs
            .get(&job_key(slug, slot))
            .is_some_and(|j| j.claimed && j.revision == revision)
    }

    fn finish(&mut self, slug: &str, slot: usize, revision: &str, retry: bool) {
        if !self.owns(slug, slot, revision) {
            return;
        }
        if retry {
            self.jobs.get_mut(&job_key(slug, slot)).unwrap().claimed = false;
        } else {
            self.jobs.remove(&job_key(slug, slot));
        }
    }
}

fn job_key(slug: &str, slot: usize) -> String {
    format!("{slug}\0{slot}")
}

#[derive(Default)]
pub struct PresetPosterQueueState(pub(crate) Mutex<PosterQueue>);

pub(crate) fn pending_count(state: &PresetPosterQueueState) -> usize {
    state.0.lock().unwrap().jobs.len()
}

pub(crate) fn restart_claimed(state: &PresetPosterQueueState) {
    for job in state.0.lock().unwrap().jobs.values_mut() {
        job.claimed = false;
    }
}

fn paused(context: &EditorContextState) -> bool {
    context
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map_or(true, |c| c.export_locked || c.playing)
}

fn collect_theme_ids(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(fields) => {
            if let Some(id) = fields.get("themeId").and_then(Value::as_str) {
                ids.insert(id.to_owned());
            }
            for child in fields.values() {
                collect_theme_ids(child, ids);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_theme_ids(child, ids);
            }
        }
        _ => {}
    }
}

fn source_revision(
    dir: &Path,
    preset_bytes: Option<&[u8]>,
    theme_paths: impl Fn(&str) -> Option<PathBuf>,
) -> Result<String, String> {
    let manifest = dir.join(crate::library_previews::manifest_name(dir));
    let mut files = vec![dir.join("project.json"), manifest.clone()];
    let mut folders = vec![dir.join("scenes"), dir.join("assets")];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                folders.push(path);
            } else if !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".tmp"))
            {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut digest = Sha256::new();
    digest.update(
        dir.canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .as_bytes(),
    );
    let mut themes = BTreeSet::from(["kookaburra-default".to_owned()]);
    for file in files {
        digest.update(
            file.strip_prefix(dir)
                .unwrap_or(&file)
                .to_string_lossy()
                .as_bytes(),
        );
        if matches!(
            file.extension().and_then(|e| e.to_str()),
            Some("json" | "tsx" | "ts" | "js")
        ) {
            let bytes = match preset_bytes.filter(|_| file == manifest) {
                Some(bytes) => bytes.to_vec(),
                None => {
                    std::fs::read(&file).map_err(|e| format!("reading {}: {e}", file.display()))?
                }
            };
            if let Ok(json) = serde_json::from_slice::<Value>(&bytes) {
                collect_theme_ids(&json, &mut themes);
            }
            digest.update(bytes);
        } else {
            let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
            digest.update(meta.len().to_le_bytes());
            digest.update(
                meta.modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
                    .to_le_bytes(),
            );
        }
    }
    for id in themes {
        digest.update(id.as_bytes());
        if let Some(path) = theme_paths(&id) {
            digest.update(std::fs::read(path).unwrap_or_default());
        }
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn saved_jobs(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
    slug: &str,
) -> Result<Vec<(PosterJob, PathBuf)>, String> {
    let dir = crate::library_previews::target(app, settings, slug)?;
    let manifest_name = crate::library_previews::manifest_name(&dir);
    let bytes = std::fs::read(dir.join(manifest_name)).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let project_bytes = std::fs::read(dir.join("project.json")).map_err(|e| e.to_string())?;
    let project: Value = serde_json::from_slice(&project_bytes).map_err(|e| e.to_string())?;
    let (_, points) = crate::library_previews::points(&manifest, manifest_name == "template.json")?;
    let root = workspace::require_root(app, settings)?;
    let revision = source_revision(&dir, Some(&bytes), |id| {
        if let Some(slug) = id.strip_prefix("ws:") {
            workspace::validate_slug(slug).ok()?;
            Some(root.join("themes").join(slug).join("theme.json"))
        } else if cfg!(debug_assertions) {
            workspace::validate_slug(id).ok()?;
            Some(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../src/theme/builtin")
                    .join(format!("{id}.json")),
            )
        } else {
            None
        }
    })?;
    if std::fs::read(dir.join("project.json")).map_err(|e| e.to_string())? != project_bytes {
        return Err("The project changed while scheduling its previews.".into());
    }
    let mut jobs = Vec::new();
    for (slot, point) in points.iter().enumerate() {
        let Ok(capture) = crate::library_previews::capture_point(point, &project) else {
            continue;
        };
        jobs.push((
            PosterJob {
                slug: slug.into(),
                revision: revision.clone(),
                slot,
                scene_file: capture.scene_file,
                at_ms: Some(capture.at_ms),
                aspect: capture.aspect,
                claimed: false,
            },
            crate::library_previews::preview_path(&dir, slot),
        ));
    }
    Ok(jobs)
}

#[tauri::command]
pub fn render_reset_preset_posters(queue: State<PresetPosterQueueState>) {
    restart_claimed(&queue);
}

#[tauri::command]
pub fn render_submit_preset_poster(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    queue: State<PresetPosterQueueState>,
    slug: String,
) -> Result<(), String> {
    let jobs = saved_jobs(&app, &settings, &slug)?;
    let mut queue = queue.0.lock().unwrap();
    queue.jobs.retain(|_, job| {
        job.slug != slug || jobs.iter().any(|(current, _)| current.slot == job.slot)
    });
    for (job, path) in jobs {
        queue.submit(job, path.is_file());
    }
    Ok(())
}

#[tauri::command]
pub fn render_take_preset_poster(
    queue: State<PresetPosterQueueState>,
    context: State<EditorContextState>,
) -> Option<PosterJob> {
    if paused(&context) {
        return None;
    }
    queue.0.lock().unwrap().take()
}

#[tauri::command]
pub fn render_finish_preset_poster(
    queue: State<PresetPosterQueueState>,
    slug: String,
    revision: String,
    retry: bool,
    slot: Option<usize>,
) -> bool {
    let mut queue = queue.0.lock().unwrap();
    let owns = queue.owns(&slug, slot.unwrap_or(0), &revision);
    queue.finish(&slug, slot.unwrap_or(0), &revision, retry);
    owns
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterSaved {
    project_id: String,
    slot: usize,
    path: String,
    mtime_ms: Option<u64>,
}

#[tauri::command]
pub fn write_preset_poster(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    queue: State<PresetPosterQueueState>,
    context: State<EditorContextState>,
    request: tauri::ipc::Request,
) -> Result<Option<PosterSaved>, String> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("missing {name} header"))
    };
    let slug = header("x-kookaburra-slug")?;
    let revision = header("x-kookaburra-revision")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("poster expects a raw PNG body".into());
    };
    let slot = header("x-kookaburra-slot")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    let mut queue = queue.0.lock().unwrap();
    if !queue.owns(slug, slot, revision) {
        return Ok(None);
    }
    if paused(&context) {
        queue.finish(slug, slot, revision, true);
        return Ok(None);
    }
    let mut jobs = saved_jobs(&app, &settings, slug)?;
    let Some(index) = jobs.iter().position(|(job, _)| job.slot == slot) else {
        queue.finish(slug, slot, revision, false);
        return Ok(None);
    };
    let (saved, path) = jobs.remove(index);
    if saved.revision != revision {
        queue.submit(saved, false);
        return Ok(None);
    }
    let (width, height) = crate::library_previews::dimensions(&saved.aspect)?;
    if bytes.len() < 24
        || bytes.len() > 5 * 1024 * 1024
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || bytes[12..16] != *b"IHDR"
        || bytes[16..20] != width.to_be_bytes()
        || bytes[20..24] != height.to_be_bytes()
    {
        return Err(format!("The preview must be a {width} x {height} PNG."));
    }
    let current = || -> Result<bool, String> {
        Ok(!paused(&context)
            && saved_jobs(&app, &settings, slug)?
                .iter()
                .any(|(job, _)| job.slot == slot && job.revision == revision))
    };
    let Some(written) = workspace::write_snapshot_file(&path, bytes, current)? else {
        queue.finish(slug, slot, revision, true);
        return Ok(None);
    };
    let dir = crate::library_previews::target(&app, &settings, slug)?;
    if crate::library_previews::manifest_name(&dir) == "template.json"
        && crate::library_previews::read_previews(&dir)?.cover == slot
    {
        workspace::write_snapshot_file(&dir.join("poster.png"), bytes, current)?;
    }
    queue.jobs.remove(&job_key(slug, slot));
    queue
        .completed
        .insert(job_key(slug, slot), revision.to_owned());
    let saved = PosterSaved {
        project_id: slug.to_owned(),
        slot,
        path: written.path,
        mtime_ms: written.mtime_ms,
    };
    drop(queue);
    app.emit("kookaburra://library-preview-saved", &saved)
        .map_err(|e| e.to_string())?;
    Ok(Some(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn job(slug: &str, revision: &str) -> PosterJob {
        PosterJob {
            slug: slug.into(),
            revision: revision.into(),
            at_ms: Some(1200.0),
            slot: 0,
            scene_file: "scenes/hero.tsx".into(),
            aspect: "16:9".into(),
            claimed: false,
        }
    }

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "kookaburra-poster-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(path.join("scenes")).unwrap();
        std::fs::create_dir_all(path.join("assets")).unwrap();
        std::fs::write(
            path.join("project.json"),
            r#"{"themeId":"ws:paper","scenes":[{"file":"scenes/hero.tsx"}]}"#,
        )
        .unwrap();
        std::fs::write(
            path.join("preset.json"),
            r#"{"preview":{"scene":0,"atMs":1200}}"#,
        )
        .unwrap();
        std::fs::write(path.join("scenes/hero.tsx"), "first scene").unwrap();
        std::fs::write(
            path.join("scenes/hero.json"),
            r#"{"text":{"title":"First"}}"#,
        )
        .unwrap();
        path
    }

    #[test]
    fn latest_revision_supersedes_in_flight_without_cancelling_other_presets() {
        let mut queue = PosterQueue::default();
        queue.submit(job("preset:one", "a"), false);
        let first = queue.take().unwrap();
        queue.submit(job("ws-preset:two", "x"), false);
        queue.submit(job("preset:one", "b"), false);
        assert!(!queue.owns(&first.slug, 0, &first.revision));
        queue.finish(&first.slug, 0, &first.revision, false);
        assert_eq!(queue.jobs.len(), 2);
        let second = queue.take().unwrap();
        assert_eq!(second.revision, "b");
        queue.finish(&second.slug, 0, &second.revision, true);
        assert_eq!(queue.take().unwrap().revision, "b");
        assert_eq!(queue.take().unwrap().slug, "ws-preset:two");
    }

    #[test]
    fn duplicate_submissions_do_not_reclaim_a_job_or_repeat_a_completed_poster() {
        let mut queue = PosterQueue::default();
        queue.submit(job("preset:one", "a"), false);
        queue.take().unwrap();
        queue.submit(job("preset:one", "a"), false);
        assert!(queue.take().is_none());
        queue.finish("preset:one", 0, "a", false);
        queue.completed.insert(job_key("preset:one", 0), "a".into());
        queue.submit(job("preset:one", "a"), true);
        assert!(queue.take().is_none());
        queue.invalidate("preset:one", 0);
        queue.submit(job("preset:one", "a"), true);
        assert!(queue.take().is_some());
    }

    #[test]
    fn four_template_slots_supersede_independently_and_share_the_preset_queue() {
        let mut queue = PosterQueue::default();
        for slot in 0..4 {
            let mut next = job("ws-template:demo", "first");
            next.slot = slot;
            queue.submit(next, false);
        }
        let first = queue.take().unwrap();
        let mut replacement = job("ws-template:demo", "second");
        replacement.slot = first.slot;
        queue.submit(replacement, false);
        assert!(!queue.owns(&first.slug, first.slot, &first.revision));
        queue.submit(job("ws-preset:demo", "preset"), false);
        assert_eq!(queue.jobs.len(), 5);
        queue.finish(&first.slug, first.slot, &first.revision, false);
        assert_eq!(queue.jobs.len(), 5);
    }

    #[test]
    fn revision_covers_saved_preview_project_scene_assets_and_referenced_theme() {
        let path = fixture();
        let theme = path.join("theme.json");
        std::fs::write(&theme, "first theme").unwrap();
        let stamp = || source_revision(&path, None, |_| Some(theme.clone())).unwrap();
        let mut previous = stamp();
        for (file, bytes) in [
            ("preset.json", r#"{"preview":0}"#),
            ("project.json", r#"{"themeId":"ws:paper","changed":true}"#),
            ("scenes/hero.tsx", "updated scene"),
            ("scenes/hero.json", r#"{"text":{"title":"Second"}}"#),
            ("assets/photo.png", "new image"),
            ("theme.json", "second theme"),
        ] {
            std::fs::write(path.join(file), bytes).unwrap();
            let current = stamp();
            assert_ne!(current, previous, "{file}");
            previous = current;
        }
        std::fs::write(path.join("poster.png"), "generated art").unwrap();
        std::fs::write(path.join("poster.png.1.2.tmp"), "partial art").unwrap();
        std::fs::write(path.join("scenes/hero.json.tmp"), "partial scene").unwrap();
        assert_eq!(stamp(), previous);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn preview_frame_and_revision_use_the_same_manifest_snapshot() {
        let path = fixture();
        let captured = std::fs::read(path.join("preset.json")).unwrap();
        let before = source_revision(&path, Some(&captured), |_| None).unwrap();
        std::fs::write(
            path.join("preset.json"),
            r#"{"preview":{"scene":0,"atMs":3000}}"#,
        )
        .unwrap();
        assert_eq!(
            source_revision(&path, Some(&captured), |_| None).unwrap(),
            before
        );
        assert_ne!(source_revision(&path, None, |_| None).unwrap(), before);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn stale_capture_keeps_newer_poster_and_cleans_its_temporary_file() {
        let path = fixture();
        let poster = path.join("poster.png");
        std::fs::write(&poster, "current poster").unwrap();
        let captured_revision = source_revision(&path, None, |_| None).unwrap();
        std::fs::write(path.join("scenes/hero.json"), "newer scene").unwrap();
        let result = workspace::write_snapshot_file(&poster, b"obsolete capture", || {
            Ok(source_revision(&path, None, |_| None)? == captured_revision)
        })
        .unwrap();
        assert!(result.is_none());
        assert_eq!(std::fs::read_to_string(&poster).unwrap(), "current poster");
        assert!(!std::fs::read_dir(&path)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")));
        let current = source_revision(&path, None, |_| None).unwrap();
        assert!(
            workspace::write_snapshot_file(&poster, b"fresh poster", || Ok(source_revision(
                &path,
                None,
                |_| None
            )? == current))
            .unwrap()
            .is_some()
        );
        assert_eq!(std::fs::read_to_string(&poster).unwrap(), "fresh poster");
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn missing_editor_context_and_active_export_or_playback_defer_work() {
        let state = EditorContextState::default();
        assert!(paused(&state));
        for (playing, export_locked, expected) in [
            (false, false, false),
            (true, false, true),
            (false, true, true),
        ] {
            *state.0.lock().unwrap() = Some(crate::bridge::EditorContext {
                project_id: None,
                aspect: "9:16".into(),
                current_ms: 999.0,
                export_locked,
                playing,
            });
            assert_eq!(paused(&state), expected);
        }
    }
}
