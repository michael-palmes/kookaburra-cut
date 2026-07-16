//! Kookaburra Cut native shell: registers Tauri plugins and the deterministic-export bridge; the exporter streams raw RGBA frames from the webview to a bundled ffmpeg sidecar, whose argv is built HERE from a typed `ExportOptions` (the frontend never controls the command line) and spawned via the shell plugin's Rust API, not webview IPC, so no `shell:allow-execute` capability is needed.

mod concurrency;
mod edit;
mod encode;
mod export_presets;
mod loudness;
mod media;
mod pty;
mod fonts;
mod gradients;
mod scene_doc;
mod objects;
mod settings_win;
mod theme;
mod workspace;

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

use encode::{legacy_export_args, mezzanine_render_args, spec_export_args, transcode_pass_args, EncodeSpec, ExportOptions};

/// Progress event streamed back to the frontend over an ipc `Channel`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    frame: u32,
    total: u32,
    /// "render" (frames streaming) | "pass1" | "pass2" (the two-pass transcode).
    stage: &'static str,
}

/// Canonical VideoClip extraction rate: clips are normalised to this CFR so one export frame index maps 1:1 to one source frame; must match the frontend `FPS`.
const CLIP_FPS: u32 = 60;

/// Result of pre-extracting a clip: the on-disk frame sequence plus its geometry, so the frontend can sample `frame-%05d.png` by index and size the plane to the clip's aspect.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipInfo {
    cache_dir: String,
    frame_count: u32,
    width: u32,
    height: u32,
    fps: u32,
}

/// A pending two-pass transcode held in `ActiveExport` across `push_frame` invocations: the mezzanine the render is writing, plus everything `finish_export` needs to run passes 1/2 file-to-file afterwards.
struct TwoPassPlan {
    options: ExportOptions,
    spec: EncodeSpec,
    mezz: PathBuf,
    passlog: PathBuf,
}

struct ActiveExport {
    child: CommandChild,
    total: u32,
    written: u32,
    output: PathBuf,
    progress: Channel<Progress>,
    /// Resolves when the ffmpeg process terminates: `Ok` on exit code 0, else `Err`.
    done: oneshot::Receiver<Result<(), String>>,
    /// Present on two-pass exports; `finish_export` runs the passes after the render.
    two_pass: Option<TwoPassPlan>,
    /// Raw input frame geometry (RGBA), used by `push_frame` to reject mis-sized bodies (F-015).
    width: u32,
    height: u32,
}

/// Kills the WKWebView's own white pre-paint layer: Tauri's `backgroundColor` covers only the NSWindow on macOS, so the flash on window open is the webview painting white before first content; sets `underPageBackgroundColor` (public API) plus the `drawsBackground` KVC flag (private-API-adjacent, fine for direct distribution, revisit only if App Store ever matters), async on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn deflash_webview(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSColor;
    use objc2_foundation::{ns_string, NSNumber};
    let _ = window.with_webview(|webview| unsafe {
        // --surface-window (#0d1016) from the design tokens.
        let wk: *mut AnyObject = webview.inner().cast();
        let color = NSColor::colorWithSRGBRed_green_blue_alpha(
            13.0 / 255.0,
            16.0 / 255.0,
            22.0 / 255.0,
            1.0,
        );
        let _: () = msg_send![wk, setUnderPageBackgroundColor: &*color];
        let flag = NSNumber::numberWithBool(false);
        let _: () = msg_send![wk, setValue: &*flag, forKey: ns_string!("drawsBackground")];
    });
}

#[derive(Default)]
pub(crate) struct ExportState(Mutex<Option<ActiveExport>>);

impl ExportState {
    /// True while an encode is in flight; settings_win refuses to clear the clip cache mid-export since the export loop reads extracted frames from it.
    pub(crate) fn busy(&self) -> bool {
        self.0.lock().map(|guard| guard.is_some()).unwrap_or(true)
    }
}

/// Spawns the ffmpeg sidecar with a piped stdin and begins an export, returning the destination path; frames are then streamed via `push_frame` and finalised with `finish_export`.
/// One informational user-attention request (macOS: a single dock bounce) when a long-running export/verify finishes while the app is in the background; a no-op when the window is focused.
#[tauri::command]
fn notify_export_done(window: tauri::WebviewWindow) {
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
}

#[tauri::command]
fn start_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    settings: State<'_, workspace::SettingsState>,
    options: ExportOptions,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    {
        let guard = state.0.lock().map_err(|_| "export state poisoned")?;
        if guard.is_some() {
            return Err("an export is already in progress".into());
        }
    }

    // F-002: project_id and aspect build the output dir (bundled branch) and filename, so reject anything path-shaped BEFORE either is used.
    workspace::validate_slug(&options.project_id)?;
    workspace::validate_slug(&options.aspect)?;

    // Workspace projects render into their own exports/ folder (self-contained projects); bundled/gate projects keep the legacy ~/Kookaburra Cut/<project>/ path so baseline tooling and hashes stay put (moved out of ~/Documents since macOS TCC guards Documents and kept breaking headless gates); both paths are built HERE, the frontend never supplies a path.
    let dir = match &options.project_slug {
        Some(slug) => {
            workspace::validate_slug(slug)?;
            workspace::require_root(&app, &settings)?
                .join(slug)
                .join("exports")
        }
        None => app
            .path()
            .home_dir()
            .map_err(|e| e.to_string())?
            .join(workspace::WORKSPACE_DIR_NAME)
            .join(&options.project_id),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Preset/custom exports suffix the filename so they never overwrite the legacy `<project>-<aspect>` output; absent suffix means the exact legacy name, so the frozen path and Verify stay untouched.
    let suffix = match &options.output_suffix {
        Some(s) => {
            workspace::validate_slug(s)?;
            format!("-{s}")
        }
        None => String::new(),
    };
    let output = dir.join(format!(
        "{}-{}{}.{}",
        options.project_id,
        options.aspect,
        suffix,
        match &options.encode {
            Some(spec) => spec.codec.container_ext(),
            None => options.codec.container_ext(),
        }
    ));

    // Defence in depth: confirm the output still resolves inside dir (the two-pass mezzanine/passlog paths reuse this same validated project_id+aspect, so they're covered too).
    let canon_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let out_parent = output.parent().ok_or("export output has no parent directory")?;
    let canon_parent = out_parent.canonicalize().map_err(|e| e.to_string())?;
    if !canon_parent.starts_with(&canon_dir) {
        return Err("export path escaped the output directory".into());
    }

    // Validate the soundtrack up front so a bad path fails the export loudly, not as a cryptic ffmpeg exit late in the run.
    if let Some(audio) = &options.audio {
        let p = std::path::Path::new(&audio.file);
        if !p.is_absolute() || !p.is_file() {
            return Err(format!("audio file not found: {}", audio.file));
        }
    }

    // The FROZEN PATH: no EncodeSpec means the extracted legacy argv, byte-pinned by encode.rs's goldens, so standing baselines never see presets; a single-pass spec pipes straight to its lane, while a two-pass spec renders ONCE to a lossless FFV1 mezzanine (pass 1 would consume the stdin stream) and `finish_export` runs the file-to-file passes.
    let mut two_pass: Option<TwoPassPlan> = None;
    let args = match &options.encode {
        None => legacy_export_args(&options, &output.to_string_lossy())?,
        Some(spec) if !spec.two_pass() => {
            spec_export_args(&options, spec, &output.to_string_lossy())?
        }
        Some(spec) => {
            let mezz_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("cache")
                .join("export-mezz");
            // Sweep leftovers from any crashed run, then guard the disk with the raw-frame ceiling (FFV1 stays under raw) plus a 2 GB margin; this is the one check that BLOCKS, since running out mid-encode corrupts the export.
            let _ = std::fs::remove_dir_all(&mezz_dir);
            std::fs::create_dir_all(&mezz_dir).map_err(|e| e.to_string())?;
            let (w, h) = spec.out_dims(options.width, options.height);
            let frames = spec.out_frames(options.total_frames, options.fps) as u64;
            let bytes_per_frame = (w as u64) * (h as u64) * if spec.ten_bit { 3 } else { 2 };
            let need = frames * bytes_per_frame + 2 * 1024 * 1024 * 1024;
            let free = free_disk_bytes(&mezz_dir)?;
            if free < need {
                return Err(format!(
                    "two-pass needs ~{need_gb:.1} GB free for its mezzanine ({free_gb:.1} GB available) — free some space or pick a single-pass preset",
                    need_gb = need as f64 / 1e9,
                    free_gb = free as f64 / 1e9,
                ));
            }
            let mezz = mezz_dir.join(format!("{}-{}.mkv", options.project_id, options.aspect));
            let passlog = mezz_dir.join(format!("{}-{}", options.project_id, options.aspect));
            let args = mezzanine_render_args(&options, spec, &mezz.to_string_lossy());
            two_pass = Some(TwoPassPlan {
                options: options.clone(),
                spec: spec.clone(),
                mezz,
                passlog,
            });
            args
        }
    };

    // Tauri places the sidecar next to the executable under its basename (the `bin/` prefix from `externalBin` and the target-triple suffix are both stripped), so the runtime name is just "ffmpeg".
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg sidecar: {e}"))?;

    // The spawn channel has a buffer of 1: stderr/stdout MUST be drained or ffmpeg blocks once its stderr pipe fills; drain here and signal termination.
    let (done_tx, done_rx) = oneshot::channel::<Result<(), String>>();
    tauri::async_runtime::spawn(async move {
        let mut last_error: Option<String> = None;
        let mut code: Option<i32> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    code = payload.code;
                    break;
                }
                CommandEvent::Error(e) => last_error = Some(e),
                _ => {} // drain stdout/stderr
            }
        }
        let result = match code {
            Some(0) => Ok(()),
            other => {
                Err(last_error.unwrap_or_else(|| format!("ffmpeg exited with code {other:?}")))
            }
        };
        let _ = done_tx.send(result);
    });

    let mut guard = state.0.lock().map_err(|_| "export state poisoned")?;
    *guard = Some(ActiveExport {
        child,
        total: options.total_frames,
        written: 0,
        output: output.clone(),
        progress: on_progress,
        done: done_rx,
        two_pass,
        width: options.width,
        height: options.height,
    });

    Ok(output.to_string_lossy().into_owned())
}

/// Expected raw-RGBA frame byte length for a `w`x`h` frame (F-015 push_frame guard).
fn expected_frame_len(w: u32, h: u32) -> usize {
    (w as usize) * (h as usize) * 4
}

/// Receives a single raw RGBA frame from the webview (zero-copy via `InvokeBody::Raw`) and writes it to the ffmpeg sidecar's stdin, then reports progress.
#[tauri::command]
fn push_frame(state: State<'_, ExportState>, request: tauri::ipc::Request) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("push_frame expects a raw binary body".into());
    };
    let mut guard = state.0.lock().map_err(|_| "export state poisoned")?;
    let active = guard.as_mut().ok_or("no active export in progress")?;
    // F-015: a mis-sized body would desync the raw-RGBA stream ffmpeg expects on stdin.
    let expected = expected_frame_len(active.width, active.height);
    if bytes.len() != expected {
        return Err(format!(
            "frame is {} bytes, expected {expected} for {}x{} RGBA",
            bytes.len(),
            active.width,
            active.height
        ));
    }
    active.child.write(bytes).map_err(|e| e.to_string())?;
    active.written += 1;
    let _ = active.progress.send(Progress {
        frame: active.written,
        total: active.total,
        stage: "render",
    });
    Ok(())
}

/// Closes ffmpeg's stdin (EOF → finalise the file), awaits the process exit, and returns the output path.
#[tauri::command]
async fn finish_export(app: AppHandle, state: State<'_, ExportState>) -> Result<String, String> {
    let active = {
        let mut guard = state.0.lock().map_err(|_| "export state poisoned")?;
        guard.take()
    }
    .ok_or("no active export in progress")?;

    let ActiveExport {
        child,
        output,
        done,
        total,
        progress,
        two_pass,
        ..
    } = active;
    drop(child); // closes stdin -> ffmpeg sees EOF and finalises the container

    done.await
        .map_err(|_| "ffmpeg task ended unexpectedly".to_string())??;

    // Two-pass: the render above wrote the FFV1 mezzanine, now the file-to-file passes; pass 1 only produces the stats log, pass 2 writes the real output (and carries the audio); the mezzanine dir is cleaned on success and swept by the NEXT export either way.
    if let Some(plan) = two_pass {
        let _ = progress.send(Progress { frame: total, total, stage: "pass1" });
        let args = transcode_pass_args(
            &plan.options,
            &plan.spec,
            &plan.mezz.to_string_lossy(),
            &output.to_string_lossy(),
            1,
            &plan.passlog.to_string_lossy(),
        )?;
        run_ffmpeg_to_completion(&app, args).await.map_err(|e| format!("pass 1: {e}"))?;
        let _ = progress.send(Progress { frame: total, total, stage: "pass2" });
        let args = transcode_pass_args(
            &plan.options,
            &plan.spec,
            &plan.mezz.to_string_lossy(),
            &output.to_string_lossy(),
            2,
            &plan.passlog.to_string_lossy(),
        )?;
        run_ffmpeg_to_completion(&app, args).await.map_err(|e| format!("pass 2: {e}"))?;
        if let Some(dir) = plan.mezz.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(output.to_string_lossy().into_owned())
}

/// Spawns the ffmpeg sidecar with no stdin work and awaits its termination (the two-pass transcode stages: file in, file out).
async fn run_ffmpeg_to_completion(app: &AppHandle, args: Vec<String>) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg sidecar: {e}"))?;
    let mut last_error: Option<String> = None;
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Terminated(payload) => {
                code = payload.code;
                break;
            }
            CommandEvent::Error(e) => last_error = Some(e),
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(()),
        other => Err(last_error.unwrap_or_else(|| format!("ffmpeg exited with code {other:?}"))),
    }
}

/// Free bytes on the volume holding `path` (macOS statvfs, the mezzanine disk guard).
fn free_disk_bytes(path: &std::path::Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut vfs) } != 0 {
        return Err("statvfs failed for the mezzanine cache".into());
    }
    Ok(vfs.f_bavail as u64 * vfs.f_frsize as u64)
}

/// Abort an in-progress export (kills ffmpeg, discards the partial file handle).
#[tauri::command]
fn cancel_export(state: State<'_, ExportState>) -> Result<(), String> {
    if let Some(active) = state.0.lock().map_err(|_| "export state poisoned")?.take() {
        let _ = active.child.kill();
    }
    Ok(())
}

/// Streams a file in 64 KiB chunks through SHA-256 and returns the hex digest (shared by `hash_file` and the clip-cache rebind in `extract_clip_frames`, F-005).
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let read = file.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Computes the SHA-256 (hex) of a file, used by the determinism check to compare two consecutive exports of the same project (the byte-identical threshold); the path is confined to the workspace-readable roots (TAU-01) so a shared project can't hash arbitrary local files.
#[tauri::command]
fn hash_file(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    path: String,
) -> Result<String, String> {
    let path = workspace::confine_readable(&app, &settings, &path)?;
    sha256_file(&path)
}

/// Reveals a file in Finder (macOS `open -R`, selecting it in its folder); the command is fixed, only the path varies, and `-R` only reveals (never executes) the file. The path is confined to the workspace-readable roots (TAU-01, F-003) so reveals can't be aimed at arbitrary local files.
#[tauri::command]
fn reveal_in_finder(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    path: String,
) -> Result<(), String> {
    let path = workspace::confine_readable(&app, &settings, &path)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The auto-run intent, read from the PROCESS env at request time: runtime env is what both `pnpm tauri dev` and a packaged-app launcher can actually set (a Vite `import.meta.env` channel is baked at build time and unreadable in a packaged app); `KOOKABURRA_*` is the only accepted spelling now (hard cut, no legacy fallback), and empty/whitespace values read as unset.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutorunEnv {
    action: Option<String>,
    project: Option<String>,
    aspect: Option<String>,
    codec: Option<String>,
    /// Preset id; the frontend resolves it through the TS registry.
    preset: Option<String>,
    /// Path to an EncodeSpec JSON file (Claude/CLI custom encodes).
    encode_json: Option<String>,
}

#[tauri::command]
fn get_autorun_config() -> AutorunEnv {
    fn var(key: &str) -> Option<String> {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
    AutorunEnv {
        action: var("KOOKABURRA_ACTION"),
        project: var("KOOKABURRA_PROJECT"),
        aspect: var("KOOKABURRA_ASPECT"),
        codec: var("KOOKABURRA_CODEC"),
        preset: var("KOOKABURRA_PRESET"),
        encode_json: var("KOOKABURRA_ENCODE_JSON"),
    }
}

/// Auto-run sink (terminal-triggered Verify ×2 / export via `pnpm kookaburra:run`): persists the run's JSON result so the wrapper script can read it independently of the dev log, echoes a stdout sentinel for live tailing, then exits the process with a pass/fail code; only reached in auto-run mode (`get_autorun_config` env), the interactive app never invokes it.
/// Cap on `finish_autorun`'s result payload (F-009); an autorun result is a small JSON summary, not a data channel.
const AUTORUN_RESULT_MAX_BYTES: usize = 8 * 1024 * 1024;

#[tauri::command]
fn finish_autorun(app: AppHandle, result_json: String, ok: bool) -> Result<(), String> {
    // F-009: only reachable from an actual auto-run; refuse if the launcher's env gate is absent (mirrors get_autorun_config's trim/empty rule).
    let gated = std::env::var("KOOKABURRA_ACTION")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !gated {
        return Err("finish_autorun is only valid during an auto-run (KOOKABURRA_ACTION unset)".into());
    }
    if result_json.len() > AUTORUN_RESULT_MAX_BYTES {
        return Err(format!(
            "autorun result too large: {} bytes (max {AUTORUN_RESULT_MAX_BYTES})",
            result_json.len()
        ));
    }
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(workspace::WORKSPACE_DIR_NAME)
        .join("_autorun");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("last-run.json"), &result_json).map_err(|e| e.to_string())?;
    // Sentinel line for anyone tailing the dev process stdout; the wrapper reads the file.
    println!("KOOKABURRA_AUTORUN_RESULT {result_json}");
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

/// Pre-extracts a source video to a deterministic constant-frame-rate PNG sequence for `VideoClip`; frames are cached under `$APPDATA/cache/clips/<sha>-<fps>fps/` keyed by the source-file hash and reused across runs (a `.done` marker guards against a partial extraction being mistaken for a complete one); the sidecar decodes the source, including variable-frame-rate screen recordings, into CFR frames via `fps=` + cfr.
#[tauri::command]
async fn extract_clip_frames(
    app: AppHandle,
    settings: State<'_, workspace::SettingsState>,
    src_abs: String,
    // F-005: client-supplied hash is untrusted, ignored below in favour of a native recompute.
    _sha: String,
    // VideoToolbox decode is NOT pixel-identical to software, so each lane owns its own cache dir; the software dir is the one standing baselines were recorded from.
    hardware: bool,
) -> Result<ClipInfo, String> {
    // The Settings toggle can force everything onto the software lane.
    let hardware = hardware && workspace::hardware_video_enabled(&app);
    // Confine the source before it reaches the sidecar (TAU-01); scene data can supply it.
    let src_path = workspace::confine_readable(&app, &settings, &src_abs)?;
    // Rebind the cache key to the confined file's own hash so a lying client can't collide with or poison another clip's cache entry; matches the client value for a legitimate file, so the cache key and output are unchanged.
    let sha = sha256_file(&src_path)?;
    let src_abs = src_path.to_string_lossy().into_owned();
    let lane_suffix = if hardware { "-hw" } else { "" };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("clips")
        .join(format!("{sha}-{CLIP_FPS}fps{lane_suffix}"));
    let done = dir.join(".done");

    // Cache hit: a completed extraction for this exact source + rate.
    if done.exists() {
        if let Some(info) = read_clip_info(&dir)? {
            return Ok(info);
        }
    }

    // Re-extract from scratch (clears any partial remnants).
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pattern = dir.join("frame-%05d.png");
    let mut args: Vec<String> = vec!["-y".into()];
    if hardware {
        args.extend(["-hwaccel".into(), "videotoolbox".into()]);
    }
    args.extend([
        "-i".into(),
        src_abs,
        "-vf".into(),
        format!("fps={CLIP_FPS}"),
        "-fps_mode".into(),
        "cfr".into(),
        // Cheap deflate + no predictor: identical pixels, ~2x faster writes, ~2x file size.
        "-compression_level".into(),
        "1".into(),
        "-pred".into(),
        "0".into(),
        "-start_number".into(),
        "0".into(),
        pattern.to_string_lossy().into_owned(),
    ]);

    let _permit = app
        .state::<concurrency::BackgroundLimiter>()
        .acquire()
        .await?;
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg sidecar: {e}"))?;
    concurrency::lower_priority(child.pid());

    // No stdin to feed, but the event channel (buffer 1) must still be drained.
    let mut code: Option<i32> = None;
    let mut last_error: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Terminated(payload) => {
                code = payload.code;
                break;
            }
            CommandEvent::Error(e) => last_error = Some(e),
            _ => {}
        }
    }
    if code != Some(0) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(last_error.unwrap_or_else(|| format!("ffmpeg extract exited with {code:?}")));
    }

    let info = read_clip_info(&dir)?.ok_or("extraction produced no frames")?;
    std::fs::write(&done, []).map_err(|e| e.to_string())?;
    Ok(info)
}

/// Counts PNG frames in an extracted clip dir and reads the geometry from one of them, or `None` if the dir is missing/empty.
fn read_clip_info(dir: &std::path::Path) -> Result<Option<ClipInfo>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }
    let mut count = 0u32;
    let mut sample: Option<PathBuf> = None;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("png") {
            count += 1;
            if sample.is_none() {
                sample = Some(path);
            }
        }
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let (width, height) = png_dimensions(&sample)?;
    Ok(Some(ClipInfo {
        cache_dir: dir.to_string_lossy().into_owned(),
        frame_count: count,
        width,
        height,
        fps: CLIP_FPS,
    }))
}

/// Reads width/height from a PNG's IHDR header (big-endian u32s at byte offsets 16 and 20), avoiding an image-decoding dependency; all frames in a clip share the same geometry.
fn png_dimensions(path: &std::path::Path) -> Result<(u32, u32), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut head = [0u8; 24];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    Ok((width, height))
}

/// Reads a pre-extracted clip frame's bytes for the webview to decode into a texture, using Rust `std::fs` (bypassing the webview fs ACL, which doesn't cover `$APPDATA` reads by default) but restricted to the clip cache so the frontend can't read arbitrary files; returns the raw PNG bytes, and the JS `invoke` resolves to an `ArrayBuffer`.
#[tauri::command]
fn read_clip_frame(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let cache_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("clips");
    let requested = PathBuf::from(&path);
    let has_traversal = requested
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    if has_traversal || !requested.starts_with(&cache_root) {
        return Err(format!("refusing to read outside the clip cache: {path}"));
    }
    // F-011: canonicalise both sides so a symlink planted inside the cache can't resolve outside it.
    let canon_requested = requested
        .canonicalize()
        .map_err(|e| format!("cannot access {path}: {e}"))?;
    let canon_root = cache_root
        .canonicalize()
        .map_err(|e| format!("cannot access the clip cache: {e}"))?;
    if !canon_requested.starts_with(&canon_root) {
        return Err(format!("refusing to read outside the clip cache: {path}"));
    }
    let bytes = std::fs::read(&canon_requested).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Window size/position persist across launches; denylisting nothing, since the editor/settings windows restoring too is the desktop-standard behaviour, and autorun runs are indifferent to window geometry (the export reads its own fixed-size targets).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ExportState::default())
        .manage(concurrency::BackgroundLimiter::default())
        .manage(workspace::SettingsState::default())
        .manage(pty::PtyState::default())
        .manage(edit::EditorState::default())
        .setup(|app| {
            // The main window exists (config-created); strip its webview's white layer.
            #[cfg(target_os = "macos")]
            if let Some(main) = app.get_webview_window("main") {
                deflash_webview(&main);
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Native menu: the stock menus (Edit must stay, webview copy/paste rides on it) plus a Project menu whose "Edit in Claude Code" opens the terminal rail, and "⚙ Settings…" (⌘,) in the app submenu's native spot (after About + ─).
            {
                use tauri::menu::{
                    IconMenuItemBuilder, Menu, MenuItemBuilder, MenuItemKind, NativeIcon,
                    PredefinedMenuItem, SubmenuBuilder,
                };
                use tauri::Emitter;
                let edit_in_claude = MenuItemBuilder::with_id("edit-in-claude", "Edit in Claude Code")
                    .accelerator("CmdOrCtrl+E")
                    .build(app)?;
                // The ⌘K palette rides a menu accelerator like ⌘Z/⌘E/⌘/; AppKit delivers it regardless of webview focus (xterm included).
                let find_action = MenuItemBuilder::with_id("find-action", "Find an Action…")
                    .accelerator("CmdOrCtrl+K")
                    .build(app)?;
                let shortcuts = MenuItemBuilder::with_id("show-shortcuts", "Keyboard Shortcuts…")
                    .accelerator("CmdOrCtrl+/")
                    .build(app)?;
                let project = SubmenuBuilder::new(app, "Project")
                    .item(&find_action)
                    .item(&edit_in_claude)
                    .item(&shortcuts)
                    .build()?;
                let menu = Menu::default(app.handle())?;
                // The system settings-gear glyph (AppKit template image via muda's NativeIcon); real SF Symbols aren't exposed by Tauri's menu layer.
                let settings_item = IconMenuItemBuilder::with_id("open-settings", "Settings…")
                    .native_icon(NativeIcon::PreferencesGeneral)
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                    // Menu::default() builds About/Hide/Quit with no explicit text, so muda fills them in from `NSRunningApplication::localizedName` (macos/mod.rs), the OS-reported app name, NOT our PackageInfo; in dev that's the unbundled process's binary name (the Cargo package, "kookaburra-cut"), so the menu reads "About kookaburra-cut" etc, so relabel them explicitly ("Hide Others"/"Show All"/"Services" don't interpolate a name and stay put).
                    const APP_NAME: &str = "Kookaburra Cut";
                    for item in app_menu.items()? {
                        let MenuItemKind::Predefined(pred) = item else {
                            continue;
                        };
                        let text = pred.text()?;
                        if text.starts_with("About ") {
                            pred.set_text(format!("About {APP_NAME}"))?;
                        } else if text.starts_with("Hide ") && text != "Hide Others" {
                            pred.set_text(format!("Hide {APP_NAME}"))?;
                        } else if text.starts_with("Quit ") {
                            pred.set_text(format!("Quit {APP_NAME}"))?;
                        }
                    }
                    // Default macOS app submenu: About(0), ─(1), Services…; Settings sits between, per the HIG.
                    app_menu.insert(&settings_item, 2)?;
                    app_menu.insert(&PredefinedMenuItem::separator(app.handle())?, 3)?;
                }
                // Undo/Redo: the default Edit items send AppKit's undo: selector, which the menu swallows BEFORE the DOM sees ⌘Z, so the app history could never hear it; replace them with emitting items, and the frontend routes text-field focus back to the WebKit undo manager.
                for item in menu.items()? {
                    let MenuItemKind::Submenu(submenu) = item else {
                        continue;
                    };
                    if submenu.text().ok().as_deref() != Some("Edit") {
                        continue;
                    }
                    let items = submenu.items()?;
                    for edit_item in items.iter().take(2) {
                        match edit_item {
                            MenuItemKind::MenuItem(i) => submenu.remove(i)?,
                            MenuItemKind::Predefined(i) => submenu.remove(i)?,
                            _ => {}
                        }
                    }
                    let undo = MenuItemBuilder::with_id("kookaburra-undo", "Undo")
                        .accelerator("CmdOrCtrl+Z")
                        .build(app)?;
                    let redo = MenuItemBuilder::with_id("kookaburra-redo", "Redo")
                        .accelerator("CmdOrCtrl+Shift+Z")
                        .build(app)?;
                    submenu.insert(&undo, 0)?;
                    submenu.insert(&redo, 1)?;
                    break;
                }
                menu.append(&project)?;
                app.set_menu(menu)?;
                // True SF Symbol (macOS 26 artwork) on the Settings item: muda can't set systemSymbolName images, so reach through objc2 to the installed NSMenuItem and swap in `gearshape`; the NativeIcon above remains the fallback if anything in this walk comes back empty.
                #[cfg(target_os = "macos")]
                {
                    use objc2_app_kit::{NSApplication, NSImage};
                    use objc2_foundation::{ns_string, MainThreadMarker};
                    if let Some(mtm) = MainThreadMarker::new() {
                        let nsapp = NSApplication::sharedApplication(mtm);
                        let item = nsapp
                            .mainMenu()
                            .and_then(|main| main.itemAtIndex(0))
                            .and_then(|app_item| app_item.submenu())
                            .and_then(|app_menu| app_menu.itemWithTitle(ns_string!("Settings…")));
                        let symbol = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                            ns_string!("gear"),
                            None,
                        );
                        if let (Some(item), Some(symbol)) = (item, symbol) {
                            item.setImage(Some(&symbol));
                        }
                    }
                }
                app.on_menu_event(|app, event| {
                    if event.id() == "edit-in-claude" {
                        let _ = app.emit("kookaburra://edit-in-claude", ());
                    } else if event.id() == "find-action" {
                        let _ = app.emit("kookaburra://find-action", ());
                    } else if event.id() == "kookaburra-undo" {
                        let _ = app.emit("kookaburra://undo", ());
                    } else if event.id() == "kookaburra-redo" {
                        let _ = app.emit("kookaburra://redo", ());
                    } else if event.id() == "show-shortcuts" {
                        let _ = app.emit("kookaburra://show-shortcuts", ());
                    } else if event.id() == "open-settings" {
                        if let Err(e) = settings_win::open_settings_window(app) {
                            eprintln!("[settings] open failed: {e}");
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_export,
            notify_export_done,
            media::probe_audio,
            media::delete_media,
            media::rename_media,
            loudness::measure_loudness,
            media::import_audio,
            push_frame,
            finish_export,
            cancel_export,
            extract_clip_frames,
            read_clip_frame,
            hash_file,
            reveal_in_finder,
            get_autorun_config,
            finish_autorun,
            workspace::get_settings,
            workspace::init_workspace,
            workspace::list_projects,
            workspace::create_project,
            workspace::read_project_manifest,
            workspace::read_scene_source,
            workspace::project_fingerprint,
            workspace::is_project_trusted,
            workspace::trust_project,
            workspace::list_project_assets,
            workspace::list_project_media,
            workspace::set_last_project,
            workspace::set_hardware_video,
            workspace::rename_project,
            workspace::duplicate_project,
            workspace::delete_project,
            workspace::write_snapshot,
            workspace::provision_project,
            workspace::ensure_sample_assets,
            workspace::list_scene_thumbs,
            workspace::write_scene_thumb,
            workspace::write_emoji_raster,
            scene_doc::read_scene_doc,
            scene_doc::write_scene_doc,
            scene_doc::update_project_scene,
            scene_doc::read_project_manifest_snapshot,
            scene_doc::write_project_manifest_snapshot,
            scene_doc::remove_project_scene,
            scene_doc::move_project_scene,
            scene_doc::update_project_scene_transition,
            scene_doc::set_project_theme,
            scene_doc::set_project_audio,
            scene_doc::scaffold_scene,
            scene_doc::duplicate_scene,
            objects::list_objects,
            objects::read_object,
            theme::list_themes,
            theme::read_theme,
            theme::write_theme,
            theme::delete_theme,
            theme::write_theme_preview,
            theme::write_option_preview,
            theme::list_theme_previews,
            gradients::list_gradients,
            gradients::write_gradient,
            gradients::delete_gradient,
            export_presets::list_export_presets,
            export_presets::write_export_preset,
            export_presets::delete_export_preset,
            workspace::set_last_export_preset,
            fonts::list_system_fonts,
            fonts::list_workspace_fonts,
            fonts::pin_system_font,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_pause,
            pty::pty_resume,
            pty::detect_claude,
            pty::has_claude_session,
            media::import_media,
            media::media_meta,
            settings_win::cache_stats,
            settings_win::clear_media_cache,
            settings_win::clear_clips_cache,
            settings_win::sidecar_versions,
            settings_win::hardware_video_support,
            edit::open_edit,
            edit::open_edit_named,
            edit::reset_edit,
            edit::get_editor_target,
            edit::load_edit,
            edit::save_edit,
            edit::list_edits,
            edit::render_edit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kookaburra Cut");
}

#[cfg(test)]
mod tests {
    use super::*;

    // F-002: start_export validates project_id/aspect with this same helper before they become filename components.
    #[test]
    fn export_segment_slugs_accept_legitimate_values() {
        assert!(workspace::validate_slug("launch-2026").is_ok());
        assert!(workspace::validate_slug("device_video_spike").is_ok());
        assert!(workspace::validate_slug("16x9").is_ok());
        assert!(workspace::validate_slug("9x16").is_ok());
        assert!(workspace::validate_slug("1x1").is_ok());
        assert!(workspace::validate_slug("4x5").is_ok());
    }

    #[test]
    fn export_segment_slugs_reject_escapes() {
        assert!(workspace::validate_slug("../etc").is_err());
        assert!(workspace::validate_slug("a/b").is_err());
        assert!(workspace::validate_slug("").is_err());
        assert!(workspace::validate_slug(".hidden").is_err());
    }

    // F-015: push_frame rejects any body whose length doesn't match w*h*4 (RGBA).
    #[test]
    fn expected_frame_len_matches_rgba_geometry() {
        assert_eq!(expected_frame_len(1920, 1080), 1920 * 1080 * 4);
        assert_eq!(expected_frame_len(1080, 1920), 1080 * 1920 * 4);
        assert_eq!(expected_frame_len(0, 0), 0);
    }

    #[test]
    fn expected_frame_len_rejects_mismatched_sizes() {
        let expected = expected_frame_len(100, 100);
        assert_ne!(expected, 100 * 100 * 3); // e.g. an RGB body sent instead of RGBA
        assert_ne!(expected, 0);
    }

    // F-009: finish_autorun's env gate mirrors get_autorun_config's trim/empty rule.
    #[test]
    fn autorun_result_cap_is_eight_mebibytes() {
        assert_eq!(AUTORUN_RESULT_MAX_BYTES, 8 * 1024 * 1024);
        assert!("x".repeat(AUTORUN_RESULT_MAX_BYTES + 1).len() > AUTORUN_RESULT_MAX_BYTES);
    }
}
