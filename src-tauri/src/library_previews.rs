use crate::workspace::{self, ProjectScope, SettingsState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePoint {
    pub scene: usize,
    pub scene_file: String,
    pub at_ms: f64,
    pub aspect: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSlot {
    pub slot: usize,
    pub point: Value,
    pub capture: Option<CapturePoint>,
    pub error: Option<String>,
    pub path: Option<String>,
    pub mtime_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPreviews {
    pub kind: String,
    pub cover: usize,
    pub slots: Vec<PreviewSlot>,
}

pub(crate) fn dimensions(aspect: &str) -> Result<(u32, u32), String> {
    match aspect {
        "16:9" => Ok((640, 360)),
        "9:16" => Ok((360, 640)),
        "1:1" => Ok((640, 640)),
        "4:5" => Ok((512, 640)),
        "5:4" => Ok((640, 512)),
        "3:2" => Ok((640, 427)),
        "2:3" => Ok((427, 640)),
        "phone" => Ok((294, 640)),
        "phone-landscape" => Ok((640, 294)),
        _ => Err("Choose a supported preview aspect.".into()),
    }
}

pub(crate) fn manifest_name(dir: &Path) -> &'static str {
    if dir.join("template.json").is_file() {
        "template.json"
    } else {
        "preset.json"
    }
}

pub(crate) fn preview_path(dir: &Path, slot: usize) -> PathBuf {
    if manifest_name(dir) == "template.json" {
        dir.join("previews").join(format!("{}.png", slot + 1))
    } else {
        dir.join("poster.png")
    }
}

pub(crate) fn preview_image_path(dir: &Path, slot: usize) -> Option<PathBuf> {
    let png = preview_path(dir, slot);
    [png.clone(), png.with_extension("jpg")]
        .into_iter()
        .find(|path| path.is_file())
}

pub(crate) fn modified(path: &Path) -> Option<u64> {
    Some(
        std::fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as u64,
    )
}

pub(crate) fn target(
    app: &AppHandle,
    settings: &State<'_, SettingsState>,
    slug: &str,
) -> Result<PathBuf, String> {
    let (scope, _) = workspace::parse_project_id(slug)?;
    let root = workspace::require_root(app, settings)?;
    let parent = match scope {
        ProjectScope::UserTemplate => root.join("templates"),
        ProjectScope::UserPreset => root.join("presets"),
        ProjectScope::BundledTemplate if cfg!(debug_assertions) => {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../projects")
        }
        ProjectScope::BundledPreset if cfg!(debug_assertions) => {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../presets")
        }
        _ => return Err("Library previews require an editable template or preset.".into()),
    }
    .canonicalize()
    .map_err(|e| e.to_string())?;
    let dir = workspace::project_dir_mut(app, settings, slug)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if dir.parent() != Some(parent.as_path()) {
        return Err("The library item resolves outside its library.".into());
    }
    let marker = match scope {
        ProjectScope::UserTemplate | ProjectScope::BundledTemplate => "template.json",
        _ => "preset.json",
    };
    if !dir.join(marker).is_file() {
        return Err("The library manifest is missing.".into());
    }
    for path in checked_preview_images(&dir)? {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| format!("Allowing library preview image: {e}"))?;
    }
    Ok(dir)
}

fn checked_preview_images(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let marker = manifest_name(&dir);
    let mut images = vec![dir.join("poster.png"), dir.join("poster.jpg")];
    if marker == "template.json" {
        images.extend((0..4).flat_map(|slot| {
            let png = preview_path(&dir, slot);
            [png.clone(), png.with_extension("jpg")]
        }));
    }
    for path in [dir.join(marker), dir.join("previews")]
        .iter()
        .chain(&images)
    {
        if path.exists()
            && !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&dir)
        {
            return Err("The preview path resolves outside its library item.".into());
        }
    }
    images.retain(|path| path.is_file());
    Ok(images)
}

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{}: {e}", path.display()))
}

pub(crate) fn capture_point(point: &Value, project: &Value) -> Result<CapturePoint, String> {
    if point
        .get("sceneFile")
        .is_some_and(|value| !value.is_string())
    {
        return Err("The saved scene file is invalid. Recapture this slot.".into());
    }
    let scenes = project
        .get("scenes")
        .and_then(Value::as_array)
        .ok_or("The project has no scenes. Recapture this slot.")?;
    let scene_hint = point
        .as_u64()
        .or_else(|| point.get("scene").and_then(Value::as_u64))
        .ok_or("The saved scene is invalid. Recapture this slot.")? as usize;
    let normalise = |file: &str| file.trim_start_matches("./").to_owned();
    let scene = if let Some(file) = point.get("sceneFile").and_then(Value::as_str) {
        scenes
            .iter()
            .position(|entry| {
                entry
                    .get("file")
                    .and_then(Value::as_str)
                    .is_some_and(|candidate| normalise(candidate) == normalise(file))
            })
            .ok_or("The saved scene was removed. Recapture this slot.")?
    } else {
        scene_hint
    };
    let entry = scenes
        .get(scene)
        .ok_or("The saved scene was removed. Recapture this slot.")?;
    let scene_file = entry
        .get("file")
        .and_then(Value::as_str)
        .ok_or("The saved scene has no file.")?
        .to_owned();
    let duration = entry
        .get("durationMs")
        .and_then(Value::as_f64)
        .ok_or("The saved scene has no duration.")?;
    let at_ms = match point.get("atMs") {
        Some(value) => value
            .as_f64()
            .ok_or("The saved time is invalid. Recapture this slot.")?,
        None => duration * 0.5,
    };
    if !at_ms.is_finite() || at_ms < 0.0 || at_ms > duration || duration <= 0.0 {
        return Err("The saved time is outside this scene. Recapture this slot.".into());
    }
    let aspect = match point.get("aspect") {
        Some(value) => value.as_str().ok_or("The saved aspect is invalid.")?,
        None => "16:9",
    }
    .to_owned();
    dimensions(&aspect)?;
    Ok(CapturePoint {
        scene,
        scene_file,
        at_ms,
        aspect,
    })
}

pub(crate) fn points(manifest: &Value, template: bool) -> Result<(usize, Vec<Value>), String> {
    let preview = manifest
        .get("preview")
        .ok_or("The library item has no preview settings.")?;
    if !template {
        return Ok((0, vec![preview.clone()]));
    }
    let frames = preview
        .get("frames")
        .and_then(Value::as_array)
        .filter(|frames| frames.len() == 4)
        .ok_or("A template needs four preview slots.")?;
    let cover = preview
        .get("poster")
        .and_then(Value::as_u64)
        .filter(|cover| *cover < 4)
        .ok_or("The cover slot must be between 1 and 4.")? as usize;
    Ok((cover, frames.clone()))
}

pub(crate) fn read_previews(dir: &Path) -> Result<LibraryPreviews, String> {
    let template = manifest_name(dir) == "template.json";
    let manifest = read_json(&dir.join(manifest_name(dir)))?;
    let project = read_json(&dir.join("project.json"))?;
    let (cover, points) = points(&manifest, template)?;
    let legacy = [dir.join("poster.png"), dir.join("poster.jpg")]
        .into_iter()
        .find(|path| path.is_file());
    let slots = points
        .into_iter()
        .enumerate()
        .map(|(index, point)| {
            let result = capture_point(&point, &project);
            let path = preview_image_path(dir, index).or_else(|| legacy.clone());
            PreviewSlot {
                slot: index,
                point,
                error: result.as_ref().err().cloned(),
                capture: result.ok(),
                mtime_ms: path.as_ref().and_then(|path| modified(path)),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect();
    Ok(LibraryPreviews {
        kind: if template { "template" } else { "preset" }.into(),
        cover,
        slots,
    })
}

#[tauri::command]
pub fn get_library_previews(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    slug: String,
) -> Result<LibraryPreviews, String> {
    read_previews(&target(&app, &settings, &slug)?)
}

#[tauri::command]
pub fn set_library_preview(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    queue: State<'_, crate::preset_posters::PresetPosterQueueState>,
    slug: String,
    slot: usize,
    capture: Option<CapturePoint>,
    cover: Option<usize>,
) -> Result<LibraryPreviews, String> {
    let dir = target(&app, &settings, &slug)?;
    let recapture = capture.is_some();
    let result = write_preview_settings(&dir, slot, capture, cover)?;
    if recapture {
        queue.0.lock().unwrap().invalidate(&slug, slot);
    }
    app.emit(
        "kookaburra://library-previews-changed",
        json!({"projectId":slug, "manifest":read_json(&dir.join(manifest_name(&dir)))?}),
    )
    .map_err(|e| e.to_string())?;
    Ok(result)
}

fn write_preview_settings(
    dir: &Path,
    slot: usize,
    capture: Option<CapturePoint>,
    cover: Option<usize>,
) -> Result<LibraryPreviews, String> {
    let manifest_path = dir.join(manifest_name(dir));
    let mut manifest = read_json(&manifest_path)?;
    if manifest.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("This library manifest needs a supported version.".into());
    }
    let template = manifest_name(dir) == "template.json";
    let (_, frames) = points(&manifest, template)?;
    if slot >= frames.len() || cover.is_some_and(|cover| cover >= frames.len()) {
        return Err("Choose an available preview slot.".into());
    }
    if let Some(capture) = capture {
        let value = serde_json::to_value(capture).map_err(|e| e.to_string())?;
        let validated = capture_point(&value, &read_json(&dir.join("project.json"))?)?;
        let value = serde_json::to_value(validated).map_err(|e| e.to_string())?;
        if template {
            manifest["preview"]["frames"][slot] = value;
        } else {
            manifest["preview"] = value;
        }
    }
    if let Some(cover) = cover {
        if template {
            manifest["preview"]["poster"] = json!(cover);
        }
    }
    crate::library::atomic_write_json(&manifest_path, &manifest)?;
    if let Some(cover) = cover {
        if let Some(image) = preview_image_path(dir, cover).filter(|_| template) {
            workspace::write_snapshot_file(
                &dir.join("poster.png")
                    .with_extension(image.extension().unwrap_or_default()),
                &std::fs::read(image).map_err(|e| e.to_string())?,
                || Ok(true),
            )?;
        }
    }
    read_previews(dir)
}

pub(crate) fn bind_scene_files(dir: &Path, project: &Value) -> Result<(), String> {
    let path = dir.join("template.json");
    if !path.is_file() {
        return Ok(());
    }
    let mut manifest = read_json(&path)?;
    let (_, frames) = points(&manifest, true)?;
    let mut changed = false;
    for (index, point) in frames.iter().enumerate() {
        if point.get("sceneFile").is_some() {
            continue;
        }
        if let Ok(capture) = capture_point(point, project) {
            manifest["preview"]["frames"][index] =
                serde_json::to_value(capture).map_err(|e| e.to_string())?;
            changed = true;
        }
    }
    if changed {
        crate::library::atomic_write_json(&path, &manifest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(template: bool) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "library-preview-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(dir.join("previews")).unwrap();
            crate::library::atomic_write_json(&dir.join("project.json"), &project()).unwrap();
            let (name, preview) = if template {
                ("template.json", json!({"poster":0,"frames":[0,1,0,1]}))
            } else {
                ("preset.json", json!(0))
            };
            crate::library::atomic_write_json(
                &dir.join(name),
                &json!({"version":1,"preview":preview,"future":"keep"}),
            )
            .unwrap();
            std::fs::write(dir.join("poster.png"), b"legacy poster").unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn project() -> Value {
        json!({"scenes":[{"file":"scenes/a.tsx","durationMs":2000},{"file":"scenes/b.tsx","durationMs":4000}]})
    }

    #[test]
    fn four_slots_keep_legacy_posters_until_each_capture_is_available() {
        let f = Fixture::new(true);
        let previews = read_previews(&f.0).unwrap();
        assert_eq!(previews.slots.len(), 4);
        assert!(previews.slots.iter().all(|slot| slot
            .path
            .as_ref()
            .unwrap()
            .ends_with("poster.png")));
        std::fs::write(f.0.join("previews/3.png"), b"third preview").unwrap();
        let next = read_previews(&f.0).unwrap();
        assert!(next.slots[2]
            .path
            .as_ref()
            .unwrap()
            .ends_with("previews/3.png"));
        assert!(next.slots[1].path.as_ref().unwrap().ends_with("poster.png"));
    }

    #[test]
    fn preview_access_covers_existing_images_without_exposing_project_files() {
        let f = Fixture::new(true);
        std::fs::write(f.0.join("previews/3.png"), b"third preview").unwrap();
        std::fs::write(f.0.join("previews/4.jpg"), b"fourth preview").unwrap();
        std::fs::write(f.0.join("previews/notes.txt"), b"private notes").unwrap();
        let dir = f.0.canonicalize().unwrap();
        assert_eq!(
            checked_preview_images(&f.0).unwrap(),
            [
                dir.join("poster.png"),
                dir.join("previews/3.png"),
                dir.join("previews/4.jpg"),
            ]
        );
        let preset = Fixture::new(false);
        assert_eq!(
            checked_preview_images(&preset.0).unwrap(),
            [preset.0.canonicalize().unwrap().join("poster.png")]
        );
    }

    #[test]
    fn preview_access_includes_a_new_capture_when_the_target_is_reopened() {
        let f = Fixture::new(false);
        std::fs::remove_file(f.0.join("poster.png")).unwrap();
        assert!(checked_preview_images(&f.0).unwrap().is_empty());
        std::fs::write(f.0.join("poster.png"), b"captured image").unwrap();
        assert_eq!(checked_preview_images(&f.0).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preview_access_rejects_images_and_preview_folders_outside_the_item() {
        use std::os::unix::fs::symlink;

        let outside = Fixture::new(false);
        let image = Fixture::new(true);
        symlink(outside.0.join("poster.png"), image.0.join("previews/2.png")).unwrap();
        assert!(checked_preview_images(&image.0).is_err());
        let folder = Fixture::new(true);
        std::fs::remove_dir(folder.0.join("previews")).unwrap();
        symlink(&outside.0, folder.0.join("previews")).unwrap();
        assert!(checked_preview_images(&folder.0).is_err());
    }

    #[test]
    fn capture_settings_and_cover_preserve_other_fields_and_images() {
        let f = Fixture::new(true);
        for (slot, aspect) in ["16:9", "9:16", "1:1", "4:5"].iter().enumerate() {
            let capture = CapturePoint {
                scene: 0,
                scene_file: "scenes/b.tsx".into(),
                at_ms: 1234.5,
                aspect: aspect.to_string(),
            };
            let state = write_preview_settings(&f.0, slot, Some(capture), None).unwrap();
            let capture = state.slots[slot].capture.as_ref().unwrap();
            assert_eq!(capture.scene, 1);
            assert_eq!(capture.aspect, *aspect);
            assert_eq!(capture.at_ms, 1234.5);
            std::fs::write(
                f.0.join(format!("previews/{}.png", slot + 1)),
                format!("slot {slot}"),
            )
            .unwrap();
        }
        let state = write_preview_settings(&f.0, 2, None, Some(2)).unwrap();
        assert_eq!(state.cover, 2);
        assert_eq!(std::fs::read(f.0.join("poster.png")).unwrap(), b"slot 2");
        assert_eq!(
            read_json(&f.0.join("template.json")).unwrap()["future"],
            "keep"
        );
        assert!(write_preview_settings(&f.0, 4, None, Some(4)).is_err());
    }

    #[test]
    fn points_follow_scene_files_through_reordering_and_report_removal_or_shortening() {
        let point = json!({"scene":0,"sceneFile":"scenes/b.tsx","atMs":3000,"aspect":"9:16"});
        assert_eq!(capture_point(&point, &project()).unwrap().scene, 1);
        let mut reordered = project();
        reordered["scenes"].as_array_mut().unwrap().reverse();
        assert_eq!(capture_point(&point, &reordered).unwrap().scene, 0);
        reordered["scenes"][0]["durationMs"] = json!(1000);
        assert!(capture_point(&point, &reordered)
            .unwrap_err()
            .contains("outside"));
        reordered["scenes"].as_array_mut().unwrap().remove(0);
        assert!(capture_point(&point, &reordered)
            .unwrap_err()
            .contains("removed"));
    }

    #[test]
    fn binds_legacy_choices_before_scene_order_changes_without_replacing_art() {
        let f = Fixture::new(true);
        bind_scene_files(&f.0, &project()).unwrap();
        let mut reordered = project();
        reordered["scenes"].as_array_mut().unwrap().reverse();
        crate::library::atomic_write_json(&f.0.join("project.json"), &reordered).unwrap();
        let state = read_previews(&f.0).unwrap();
        assert_eq!(state.slots[0].capture.as_ref().unwrap().scene, 1);
        assert_eq!(state.slots[0].capture.as_ref().unwrap().at_ms, 1000.0);
        assert_eq!(state.slots[0].capture.as_ref().unwrap().aspect, "16:9");
        assert_eq!(
            std::fs::read(f.0.join("poster.png")).unwrap(),
            b"legacy poster"
        );
    }

    #[test]
    fn presets_keep_one_slot_and_invalid_points_keep_the_old_image() {
        let f = Fixture::new(false);
        let state = read_previews(&f.0).unwrap();
        assert_eq!(state.slots.len(), 1);
        assert_eq!(state.slots[0].capture.as_ref().unwrap().at_ms, 1000.0);
        crate::library::atomic_write_json(
            &f.0.join("preset.json"),
            &json!({"version":1,"preview":{"scene":0,"atMs":9999}}),
        )
        .unwrap();
        let state = read_previews(&f.0).unwrap();
        assert!(state.slots[0].error.as_ref().unwrap().contains("Recapture"));
        assert!(state.slots[0].path.is_some());
    }

    #[test]
    fn aspect_dimensions_match_the_uncropped_frame() {
        for (aspect, size) in [
            ("16:9", (640, 360)),
            ("9:16", (360, 640)),
            ("1:1", (640, 640)),
            ("4:5", (512, 640)),
            ("5:4", (640, 512)),
            ("3:2", (640, 427)),
            ("2:3", (427, 640)),
            ("phone", (294, 640)),
            ("phone-landscape", (640, 294)),
        ] {
            assert_eq!(dimensions(aspect).unwrap(), size);
        }
        assert!(capture_point(&json!({"scene":0,"aspect":"invalid"}), &project()).is_err());
        assert!(capture_point(&json!({"scene":0,"aspect":42}), &project()).is_err());
        assert!(capture_point(&json!({"scene":0,"atMs":-1}), &project()).is_err());
    }
}
