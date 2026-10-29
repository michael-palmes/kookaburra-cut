//! The per-window ACL under test: `permissions/*.json` (one set per window role) and `capabilities/**/*.json` (which window gets which sets). A new `#[tauri::command]` fails here until it is placed in a set on purpose, and each window's whole command list is spelled out so a widening is a visible diff (docs/decisions.md, "Per-window ACL").

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const LIB_RS: &str = include_str!("lib.rs");
const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// Every command the release handler registers (the macro body before `$($dev,)*`).
fn registered_commands() -> BTreeSet<String> {
    let start = LIB_RS
        .find("tauri::generate_handler![")
        .expect("handler macro")
        + "tauri::generate_handler![".len();
    let end = LIB_RS[start..].find("$($dev,)*").expect("dev arm") + start;
    command_idents(&LIB_RS[start..end])
}

/// The commands the debug build adds (`kookaburra_handler![ ... ]` under cfg(debug_assertions)).
fn dev_commands() -> BTreeSet<String> {
    let start = LIB_RS
        .find(".invoke_handler(kookaburra_handler![")
        .expect("dev handler")
        + ".invoke_handler(kookaburra_handler![".len();
    let end = LIB_RS[start..].find("])").expect("dev handler end") + start;
    command_idents(&LIB_RS[start..end])
}

fn command_idents(list: &str) -> BTreeSet<String> {
    list.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| item.rsplit("::").next().unwrap_or(item).to_string())
        .collect()
}

fn read_json(path: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn json_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

/// Permission identifier -> the commands it allows.
fn permission_sets() -> BTreeMap<String, BTreeSet<String>> {
    let mut sets = BTreeMap::new();
    for path in json_files(&Path::new(MANIFEST_DIR).join("permissions")) {
        let doc = read_json(&path);
        for permission in doc["permission"].as_array().expect("permission array") {
            let id = permission["identifier"]
                .as_str()
                .expect("identifier")
                .to_string();
            let commands: BTreeSet<String> = permission["commands"]["allow"]
                .as_array()
                .expect("commands.allow")
                .iter()
                .map(|c| c.as_str().expect("command name").to_string())
                .collect();
            assert!(
                permission["commands"]["deny"].is_null(),
                "{id}: deny lists are not used"
            );
            assert!(
                sets.insert(id.clone(), commands).is_none(),
                "duplicate permission {id}"
            );
        }
    }
    sets
}

/// Window label -> the app permission identifiers its capability grants (plugin permissions, with a `:`, are left out).
fn capabilities(dir: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut windows: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in json_files(&Path::new(MANIFEST_DIR).join(dir)) {
        let doc = read_json(&path);
        let labels: Vec<String> = doc["windows"]
            .as_array()
            .expect("windows")
            .iter()
            .map(|w| w.as_str().unwrap().to_string())
            .collect();
        let app_permissions: BTreeSet<String> = doc["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .map(|p| p.as_str().expect("permission id").to_string())
            .filter(|p| !p.contains(':'))
            .collect();
        for label in labels {
            windows
                .entry(label)
                .or_default()
                .extend(app_permissions.iter().cloned());
        }
    }
    windows
}

/// The commands a window may invoke in a release build.
fn allowed(label: &str) -> BTreeSet<String> {
    let sets = permission_sets();
    capabilities("capabilities")
        .remove(label)
        .unwrap_or_else(|| panic!("no capability for window {label}"))
        .iter()
        .flat_map(|id| {
            sets.get(id)
                .unwrap_or_else(|| panic!("unknown permission {id}"))
                .iter()
                .cloned()
        })
        .collect()
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn every_command_is_placed_in_exactly_the_sets_that_name_it() {
    let sets = permission_sets();
    let placed: BTreeSet<String> = sets.values().flatten().cloned().collect();
    let registered = registered_commands();
    let dev = dev_commands();
    let unplaced: Vec<_> = registered
        .union(&dev)
        .filter(|c| !placed.contains(*c))
        .collect();
    assert!(
        unplaced.is_empty(),
        "commands with no permission set (place each one deliberately): {unplaced:?}"
    );
    let stale: Vec<_> = placed
        .iter()
        .filter(|c| !registered.contains(*c) && !dev.contains(*c))
        .collect();
    assert!(
        stale.is_empty(),
        "permission sets name commands that are not registered: {stale:?}"
    );
    for command in &dev {
        let homes: Vec<_> = sets
            .iter()
            .filter(|(_, cmds)| cmds.contains(command))
            .map(|(id, _)| id.as_str())
            .collect();
        assert!(
            homes.iter().all(|id| id.starts_with("dev-")),
            "{command} is dev-only and belongs in a dev- set, found in {homes:?}"
        );
    }
}

#[test]
fn dev_sets_are_granted_only_by_the_dev_capabilities() {
    for (label, grants) in capabilities("capabilities") {
        let dev: Vec<_> = grants.iter().filter(|g| g.starts_with("dev-")).collect();
        assert!(
            dev.is_empty(),
            "{label} grants {dev:?} outside capabilities/dev/"
        );
    }
    let dev = capabilities("capabilities/dev");
    assert_eq!(
        dev.keys().cloned().collect::<Vec<_>>(),
        ["main", "theme-editor"]
    );
    for grants in dev.values() {
        assert!(
            grants.iter().all(|g| g.starts_with("dev-")),
            "capabilities/dev grants only dev- sets: {grants:?}"
        );
    }
    let registered = registered_commands();
    for command in dev_commands() {
        assert!(
            !registered.contains(&command),
            "{command} is registered in release builds too"
        );
    }
}

#[test]
fn every_window_has_a_capability() {
    let labels: BTreeSet<String> = capabilities("capabilities").into_keys().collect();
    assert_eq!(
        labels,
        names(&[
            "editor",
            "main",
            "packs",
            "present",
            "render",
            "settings",
            "theme-editor"
        ])
    );
}

#[test]
fn only_the_main_window_reaches_the_terminal_trust_and_the_rest_of_the_studio() {
    for label in [
        "present",
        "render",
        "packs",
        "settings",
        "theme-editor",
        "editor",
    ] {
        let commands = allowed(label);
        for denied in [
            "pty_spawn",
            "pty_write",
            "check_project_trust",
            "request_project_trust",
            "trust_project",
            "start_export",
            "delete_project",
            "website_grant_origin",
            "init_default_workspace",
        ] {
            assert!(
                !commands.contains(denied),
                "{label} must not reach {denied}"
            );
        }
    }
    // Workspace relocation is the settings window's alone; applying a pack is the packs window's alone.
    for label in ["main", "present", "render", "theme-editor", "editor"] {
        for denied in ["init_workspace", "move_workspace", "apply_import"] {
            assert!(
                !allowed(label).contains(denied),
                "{label} must not reach {denied}"
            );
        }
    }
    assert!(!allowed("packs").contains("move_workspace"));
    assert!(!allowed("settings").contains("apply_import"));
}

#[test]
fn the_main_window_keeps_the_studio() {
    let commands = allowed("main");
    let registered = registered_commands();
    let not_main: BTreeSet<String> = registered.difference(&commands).cloned().collect();
    // Everything the main window does NOT get belongs to another window alone.
    assert_eq!(
        not_main,
        names(&[
            "apply_import",
            "begin_bridge_screenshot",
            "bridge_check_assets",
            "bridge_claim_request",
            "bridge_confirm_project",
            "bridge_request_live",
            "bridge_write_response",
            "bridge_write_sheet",
            "build_pack",
            "cache_stats",
            "cancel_pack_build",
            "clear_clips_cache",
            "clear_media_cache",
            "discard_staged_pack",
            "font_embedding_for",
            "forget_publisher",
            "get_editor_context",
            "get_editor_target",
            "get_packs_target",
            "get_present_target",
            "get_publisher_profile",
            "get_theme_editor_target",
            "hardware_video_support",
            "init_workspace",
            "inspect_pack",
            "list_known_publishers",
            "list_packables",
            "load_edit",
            "load_edit_entry",
            "move_workspace",
            "open_imported_project",
            "pin_fonts_for_pack",
            "plan_pack",
            "read_pack_scene_docs",
            "read_pack_scene_source",
            "render_edit",
            "render_finish_preset_poster",
            "render_heartbeat",
            "render_report_gpu_event",
            "render_reset_preset_posters",
            "render_take_preset_poster",
            "render_take_thumb_job",
            "reset_edit",
            "reveal_pack",
            "rotate_publisher_key",
            "save_bridge_screenshot",
            "save_edit",
            "set_clip_cache_cap",
            "set_conform_new_videos",
            "set_hardware_video",
            "set_publisher_profile",
            "sidecar_versions",
            "stage_pack",
            "website_clear_data",
            "website_list_data",
            "workspace_root_path",
            "write_preset_poster",
            "write_scene_thumb",
            "write_theme",
        ])
    );
}

#[test]
fn the_present_window_reads_renders_and_shows_approved_websites() {
    let mut expected = allowed_project_read_and_render();
    expected.extend(names(&[
        "get_present_target",
        "website_open",
        "website_show",
        "website_hide",
        "website_set_bounds",
        "website_action",
        "website_close",
    ]));
    assert_eq!(allowed("present"), expected);
}

#[test]
fn the_render_window_reads_renders_and_serves_the_bridge() {
    let mut expected = allowed_project_read_and_render();
    expected.extend(names(&[
        "render_heartbeat",
        "render_take_thumb_job",
        "render_report_gpu_event",
        "render_reset_preset_posters",
        "render_take_preset_poster",
        "render_finish_preset_poster",
        "write_preset_poster",
        "write_scene_thumb",
        "bridge_claim_request",
        "bridge_write_response",
        "begin_bridge_screenshot",
        "save_bridge_screenshot",
        "bridge_write_sheet",
        "bridge_check_assets",
        "bridge_request_live",
        "bridge_confirm_project",
        "get_editor_context",
        "copy_scene_to_project",
    ]));
    assert_eq!(allowed("render"), expected);
}

#[test]
fn the_theme_editor_reads_renders_and_writes_themes() {
    let mut expected = allowed_project_read_and_render();
    expected.extend(names(&[
        "get_theme_editor_target",
        "open_theme_editor_window",
        "write_theme",
        "sample_screen_colour",
    ]));
    assert_eq!(allowed("theme-editor"), expected);
}

#[test]
fn the_editor_window_edits_documents_and_reads_media() {
    assert_eq!(
        allowed("editor"),
        names(&[
            "edit_stamps",
            "get_editor_target",
            "get_settings",
            "import_media_bytes",
            "list_edits",
            "list_project_asset_stamps",
            "load_edit",
            "load_edit_entry",
            "media_meta",
            "project_assets_stamp",
            "read_project_manifest_snapshot",
            "read_scene_doc",
            "render_edit",
            "reset_edit",
            "save_edit",
        ])
    );
}

#[test]
fn the_packs_window_handles_packs_and_nothing_else() {
    assert_eq!(
        allowed("packs"),
        names(&[
            "apply_import",
            "build_pack",
            "cancel_pack_build",
            "discard_staged_pack",
            "font_embedding_for",
            "get_packs_target",
            "get_publisher_profile",
            "get_settings",
            "inspect_pack",
            "list_packables",
            "list_projects",
            "next_queued_pack",
            "note_picked_folder",
            "open_imported_project",
            "open_pack_import",
            "pin_fonts_for_pack",
            "plan_pack",
            "read_pack_scene_docs",
            "read_pack_scene_source",
            "read_scene_doc",
            "reveal_in_finder",
            "reveal_pack",
            "stage_pack",
            "workspace_root_path",
        ])
    );
}

#[test]
fn the_settings_window_owns_caches_the_workspace_location_updates_and_the_publisher() {
    assert_eq!(
        allowed("settings"),
        names(&[
            "cache_stats",
            "check_for_update",
            "claude_app_status",
            "clear_clips_cache",
            "clear_media_cache",
            "default_workspace_root",
            "forget_publisher",
            "get_publisher_profile",
            "get_settings",
            "hardware_video_support",
            "init_workspace",
            "install_update_and_relaunch",
            "list_known_publishers",
            "managed_policy",
            "move_workspace",
            "note_picked_folder",
            "open_claude_download",
            "open_in_claude",
            "open_privacy_page",
            "open_project_folder",
            "record_skipped_version",
            "reveal_in_finder",
            "rotate_publisher_key",
            "set_claude_preferences",
            "set_clip_cache_cap",
            "set_conform_new_videos",
            "set_export_to_downloads",
            "set_hardware_video",
            "set_lag_warning",
            "set_publisher_profile",
            "set_update_consent",
            "sidecar_versions",
            "user_home_dir",
            "website_clear_data",
            "website_list_data",
        ])
    );
}

/// The read-only project loading surface plus the two render writes, shared by every window that draws scenes.
fn allowed_project_read_and_render() -> BTreeSet<String> {
    names(&[
        "get_settings",
        "get_autorun_config",
        "list_projects",
        "read_project_manifest",
        "release_project",
        "read_scene_source",
        "project_fingerprint",
        "project_file_stamps",
        "is_project_trusted",
        "list_project_assets",
        "list_project_environments",
        "list_project_media",
        "list_project_asset_stamps",
        "project_assets_stamp",
        "file_revisions",
        "hash_file",
        "read_scene_doc",
        "read_scene_doc_entry",
        "read_project_manifest_snapshot",
        "list_project_scenes",
        "list_objects",
        "read_object",
        "list_themes",
        "read_theme",
        "list_theme_previews",
        "read_builtin_theme",
        "list_user_templates",
        "list_user_presets",
        "list_brands",
        "list_brand_images",
        "brand_image_meta",
        "list_export_presets",
        "list_workspace_fonts",
        "list_system_fonts",
        "clip_info",
        "ensure_clip_chunks",
        "read_clip_frame",
        "ensure_clip_previews",
        "set_clip_cache_pins",
        "clip_cache_session_stats",
        "clip_conform_pending",
        "conform_status",
        "media_meta",
        "read_media_thumb",
        "decode_png",
        "probe_audio",
        "bridge_instance",
        "read_emoji_raster",
        "pin_system_font",
        "write_emoji_raster",
    ])
}
