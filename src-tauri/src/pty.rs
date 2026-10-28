//! Embedded terminal backend: real PTYs for the in-app Claude Code session.
//!
//! - `portable-pty` for the PTY pair; the slave is dropped right after spawn (or the reader never sees EOF) and the child is reaped by `wait()` on the reader thread.
//! - Output streams to the webview over a `tauri::ipc::Channel` as RAW byte chunks (the event system is documented as unsuited to this throughput); raw bytes, not strings, let xterm.js reassemble codepoints split across chunk boundaries.
//! - Flow control: the frontend applies the xterm.js watermark scheme and calls `pty_pause`/`pty_resume`; a paused reader stops draining, the kernel PTY buffer fills, and the child blocks, real backpressure.
//! - The shell is spawned as a LOGIN shell so `/etc/zprofile` + `~/.zprofile` rebuild the user's PATH inside the terminal (GUI apps inherit launchd's bare PATH); that is NOT sufficient for `claude` itself, since the default install adds its dir in `~/.zshrc`, which a login non-interactive shell never sources, so a Claude session execs the DETECTED binary by full path (the path `detect_claude` stored natively, never one the webview supplies) and prepends its dir to the child PATH.
//! - The webview never supplies a command string. `Launch` is a closed enum: Claude Code with the app's fixed flags (the grounding rides as one argv element behind a fixed `exec "$0" "$@"` script, so no shell parsing touches it) or an interactive shell; only the main window may launch Claude.
//! - The child environment is built from an allow-list (`child_environment`), not by scrubbing a few names: `launchctl setenv` variables outside `CLAUDE_*`/`ANTHROPIC_*` do not reach the terminal.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// Pause/resume gate shared with a session's reader thread.
#[derive(Default)]
struct FlowGate {
    paused: Mutex<bool>,
    cv: Condvar,
}

impl FlowGate {
    fn set(&self, paused: bool) {
        *self.paused.lock().unwrap() = paused;
        self.cv.notify_all();
    }
    fn wait_while_paused(&self) {
        let mut paused = self.paused.lock().unwrap();
        while *paused {
            paused = self.cv.wait(paused).unwrap();
        }
    }
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    gate: Arc<FlowGate>,
    /// Label of the window that spawned the session. The rail's `main` sessions live until the app exits; the present window's die with it (`kill_sessions_owned_by` from its destroy hook).
    owner: String,
}

type SessionMap = Arc<Mutex<HashMap<u32, PtySession>>>;

#[derive(Default)]
pub struct PtyState {
    sessions: SessionMap,
    next_id: AtomicU32,
    /// Where `detect_claude` last found the CLI; a Claude session launches this path and nothing the webview names.
    claude_path: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Working directory for the shell (the project folder).
    pub cwd: String,
    /// What runs in the PTY; an interactive shell when absent.
    #[serde(default)]
    pub launch: Launch,
    pub cols: u16,
    pub rows: u16,
    /// Opts out of the F-006 workspace confinement: scene terminals may open a user-chosen start path (docs/decisions.md). The path must still resolve to a real directory, and commands are never auto-run there.
    #[serde(default)]
    pub allow_external_cwd: bool,
}

/// What a PTY session runs. Closed by design: the webview picks a shape and supplies data, Rust builds the argv.
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Launch {
    /// Claude Code at the natively detected path with the app's fixed flags; `grounding` is the system-prompt text the frontend supplies as data.
    ClaudeSession {
        #[serde(default)]
        continue_last: bool,
        grounding: String,
    },
    /// The user's login shell with a prompt; whatever runs there, the user typed.
    #[default]
    InteractiveShell,
}

impl Launch {
    fn is_command(&self) -> bool {
        matches!(self, Launch::ClaudeSession { .. })
    }
}

/// The one window allowed to start Claude Code: the embedded terminal lives in the main window, and a scene terminal elsewhere only ever seats a prompt.
const CLAUDE_LAUNCH_WINDOWS: [&str; 1] = ["main"];

/// Longest grounding accepted; the app's own is well under a page.
const GROUNDING_MAX_BYTES: usize = 16 * 1024;

/// The flags every Claude session gets. Fixed here so the webview cannot vary them.
const CLAUDE_FIXED_ARGS: [&str; 6] = [
    "--permission-mode",
    "auto",
    "--model",
    "claude-opus-5-5",
    "--effort",
    "high",
];

/// Refuses a launch the calling window may not make, or a grounding that is not plain text.
fn validate_launch(launch: &Launch, window_label: &str) -> Result<(), String> {
    let Launch::ClaudeSession { grounding, .. } = launch else {
        return Ok(());
    };
    if !CLAUDE_LAUNCH_WINDOWS.contains(&window_label) {
        return Err("only the main window can start Claude Code".into());
    }
    if grounding.trim().is_empty() || grounding.len() > GROUNDING_MAX_BYTES {
        return Err("the Claude grounding must be a short plain-text prompt".into());
    }
    if grounding.chars().any(|c| c.is_control() && c != '\n') {
        return Err("the Claude grounding cannot carry control characters".into());
    }
    Ok(())
}

/// Claude Code's argv after the binary: `--continue` when resuming, the fixed flags, then the grounding as one element.
fn claude_argv(continue_last: bool, grounding: &str) -> Vec<String> {
    let mut args = Vec::new();
    if continue_last {
        args.push("--continue".to_string());
    }
    args.extend(CLAUDE_FIXED_ARGS.iter().map(|a| a.to_string()));
    args.push("--append-system-prompt".to_string());
    args.push(grounding.to_string());
    args
}

/// The fixed `-c` script that execs `$0` with the remaining argv untouched; the login shell still runs its profile first, so PATH is the user's. Fish has no `$0` and names the rest `$argv`.
fn exec_script(shell: &str) -> &'static str {
    let name = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell);
    if name == "fish" {
        "exec $argv"
    } else {
        "exec \"$0\" \"$@\""
    }
}

/// Inherited names the child keeps as they are.
const ENV_ALLOW: [&str; 10] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "TMPDIR",
    "TERM",
    "COLORTERM",
    "SSH_AUTH_SOCK",
];
/// Inherited prefixes the child keeps (locale, terminal, Claude Code and Anthropic settings such as `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`).
const ENV_ALLOW_PREFIX: [&str; 4] = ["LC_", "TERM_", "CLAUDE_", "ANTHROPIC_"];
/// Allowed by prefix but dropped anyway: the host terminal's identity (claude fingerprints it) and the markers of an enclosing Claude session, which would read as nesting.
const ENV_DENY: [&str; 4] = [
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
];

/// The child's whole environment: the allow-listed part of `inherited`, then the terminal's own values (`TERM_PROGRAM` names us so claude never adopts a host IDE; `FORCE_COLOR` declares the 24-bit colour xterm.js really renders; the IDE auto-install stays off) and `prepend` ahead of PATH.
fn child_environment<I>(inherited: I, prepend: Option<&str>) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env: BTreeMap<String, String> = inherited
        .into_iter()
        .filter(|(key, _)| {
            !ENV_DENY.contains(&key.as_str())
                && (ENV_ALLOW.contains(&key.as_str())
                    || ENV_ALLOW_PREFIX.iter().any(|p| key.starts_with(p)))
        })
        .collect();
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("TERM_PROGRAM".into(), "KookaburraCut".into());
    env.insert("FORCE_COLOR".into(), "3".into());
    env.insert("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL".into(), "1".into());
    env.entry("LANG".into())
        .or_insert_with(|| "en_US.UTF-8".into());
    if let Some(dir) = prepend.filter(|d| !d.is_empty()) {
        let path = prepended_path(dir, env.get("PATH").cloned());
        env.insert("PATH".into(), path);
    }
    env
}

/// `prepend:inherited`, degrading to just `prepend` when nothing is inherited; a trailing `:` would put the CURRENT DIRECTORY on the PATH (POSIX empty-entry rule).
fn prepended_path(prepend: &str, inherited: Option<String>) -> String {
    match inherited {
        Some(rest) if !rest.is_empty() => format!("{prepend}:{rest}"),
        _ => prepend.to_string(),
    }
}

/// Where the F-006 opt-out may never seat a prompt (defence in depth after F-001: a sidecar path must not become `shell -c` outside the workspace).
const DENIED_ROOTS: [&str; 5] = ["/System", "/usr", "/bin", "/sbin", "/private"];

/// F-006: the terminal cwd must resolve to a real directory inside the canonical workspace `root`. The opt-out (scene terminals open a user-chosen start path) may seat an interactive prompt elsewhere, never a command, and never in a system directory. `Path::starts_with` is component-wise, so a sibling named `<root>-evil` stays outside.
fn confine_terminal_cwd(
    root: &Path,
    requested: &Path,
    allow_external: bool,
    has_command: bool,
    denied_roots: &[&str],
) -> Result<PathBuf, String> {
    let cwd = requested
        .canonicalize()
        .map_err(|e| format!("terminal working directory not found: {e}"))?;
    if !cwd.is_dir() {
        return Err("the terminal working directory must be a folder".into());
    }
    if cwd.starts_with(root) {
        return Ok(cwd);
    }
    if !allow_external {
        return Err("the terminal can only open inside the workspace".into());
    }
    if has_command {
        return Err("commands can only run inside the workspace".into());
    }
    if cwd == Path::new("/") || denied_roots.iter().any(|p| cwd.starts_with(p)) {
        return Err("the terminal cannot open in a system directory".into());
    }
    Ok(cwd)
}

/// The session `id` names, provided the calling window spawned it: a window only ever drives its own terminals.
fn owned_session<'a>(
    map: &'a mut HashMap<u32, PtySession>,
    id: u32,
    window: &tauri::Window,
) -> Result<&'a mut PtySession, String> {
    let session = map.get_mut(&id).ok_or("no such terminal session")?;
    if session.owner != window.label() {
        return Err("that terminal belongs to another window".into());
    }
    Ok(session)
}

/// The user's shell: `$SHELL` (set by launchd from the user record even for GUI apps), falling back to the macOS default.
fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// Spawn a login shell in a fresh PTY, streaming output over `on_data`; data messages are raw UTF-8 byte chunks, the final message is a JSON `{ "exit": code }`. Returns the session id for the write/resize/kill/pause commands.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, PtyState>,
    settings: State<'_, crate::workspace::SettingsState>,
    options: SpawnOptions,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    validate_launch(&options.launch, window.label())?;
    // F-006: confine the terminal cwd to the workspace root unless the caller explicitly opts out (scene terminals open a user-chosen start path). Every path still has to resolve to a real directory, `~` expands against the user's home, and nothing is ever auto-run in it.
    let root = crate::workspace::require_root(&app, &settings)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let raw = options.cwd.trim();
    let requested = if raw == "~" || raw.starts_with("~/") {
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        if raw == "~" {
            home
        } else {
            home.join(&raw[2..])
        }
    } else {
        PathBuf::from(raw)
    };
    let cwd = confine_terminal_cwd(
        &root,
        &requested,
        options.allow_external_cwd,
        options.launch.is_command(),
        &DENIED_ROOTS,
    )?;

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: options.rows.max(2),
            cols: options.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell → /etc/zprofile + ~/.zprofile rebuild the real PATH
    let mut path_prepend = None;
    if let Launch::ClaudeSession {
        continue_last,
        grounding,
    } = &options.launch
    {
        let claude = claude_binary(&state)?;
        path_prepend = claude
            .parent()
            .map(|dir| dir.to_string_lossy().into_owned());
        cmd.arg("-c");
        cmd.arg(exec_script(&shell));
        cmd.arg(&claude);
        for arg in claude_argv(*continue_last, grounding) {
            cmd.arg(arg);
        }
    }
    cmd.cwd(&cwd);
    cmd.env_clear();
    // `vars_os`, not `vars`: one non-UTF-8 value in the inherited environment must not panic the spawn.
    let inherited = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
    for (key, value) in child_environment(inherited, path_prepend.as_deref()) {
        cmd.env(key, value);
    }

    let mut child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Drop the slave immediately or the master reader never sees EOF at child exit.
    drop(pty.slave);

    let killer = child.clone_killer();
    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pty
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let gate = Arc::new(FlowGate::default());
    let sessions = state.sessions.clone();

    {
        let mut map = sessions.lock().map_err(|_| "pty state poisoned")?;
        map.insert(
            id,
            PtySession {
                writer,
                killer,
                master: pty.master,
                gate: gate.clone(),
                owner: window.label().to_string(),
            },
        );
    }

    // Blocking reader → channel on a dedicated thread, coalescing up to 64 KB per message; `Ok(0)` and `Err` both mean the child is gone (macOS gives a clean 0; Linux may EIO), then `wait()` reaps it.
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            gate.wait_while_paused();
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                }
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code());
        if let Ok(mut map) = sessions.lock() {
            map.remove(&id);
        }
        let _ = on_data.send(InvokeResponseBody::Json(format!(
            "{{\"exit\":{}}}",
            code.unwrap_or(0)
        )));
    });

    Ok(id)
}

/// Write user input (keystrokes, pastes) to the session's stdin.
#[tauri::command]
pub fn pty_write(
    window: tauri::Window,
    state: State<'_, PtyState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = owned_session(&mut map, id, &window)?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

/// Resize the PTY (the kernel delivers SIGWINCH to the foreground process group).
#[tauri::command]
pub fn pty_resize(
    window: tauri::Window,
    state: State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = owned_session(&mut map, id, &window)?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kill the session's child; the reader thread unblocks, reaps via `wait()`, sends the exit message, and removes the session from the registry. A session already gone is not an error: the exit message can race the kill.
#[tauri::command]
pub fn pty_kill(window: tauri::Window, state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if !map.contains_key(&id) {
        return Ok(());
    }
    let session = owned_session(&mut map, id, &window)?;
    session.gate.set(false); // never leave the reader parked while dying
    let _ = session.killer.kill();
    Ok(())
}

/// Kill every session a window label owns (the present window's destroy hook): each child gets the `pty_kill` treatment, and the reader threads reap and deregister as usual.
pub fn kill_sessions_owned_by(state: &PtyState, owner: &str) {
    if let Ok(mut map) = state.sessions.lock() {
        for session in map.values_mut().filter(|s| s.owner == owner) {
            session.gate.set(false);
            let _ = session.killer.kill();
        }
    }
}

/// Frontend watermark flow control: pause stops draining the PTY (the kernel buffer then backpressures the child); resume unparks the reader.
#[tauri::command]
pub fn pty_pause(window: tauri::Window, state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    set_session_paused(&window, &state, id, true)
}

#[tauri::command]
pub fn pty_resume(
    window: tauri::Window,
    state: State<'_, PtyState>,
    id: u32,
) -> Result<(), String> {
    set_session_paused(&window, &state, id, false)
}

fn set_session_paused(
    window: &tauri::Window,
    state: &PtyState,
    id: u32,
    paused: bool,
) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if !map.contains_key(&id) {
        return Ok(());
    }
    owned_session(&mut map, id, window)?.gate.set(paused);
    Ok(())
}

/// The Claude Code binary a session launches: the path `detect_claude` stored, re-detected when the panel skipped that step, and checked to still be a regular file.
fn claude_binary(state: &PtyState) -> Result<PathBuf, String> {
    let stored = state
        .claude_path
        .lock()
        .map_err(|_| "pty state poisoned")?
        .clone();
    let path = match stored {
        Some(path) => path,
        None => {
            let found =
                PathBuf::from(detect_claude_blocking().ok_or("Claude Code is not installed")?);
            *state.claude_path.lock().map_err(|_| "pty state poisoned")? = Some(found.clone());
            found
        }
    };
    if !path.is_absolute() || !path.canonicalize().map(|p| p.is_file()).unwrap_or(false) {
        return Err("Claude Code is no longer where it was detected; start it again".into());
    }
    Ok(path)
}

/// Whether Claude Code has stored conversations for `cwd`; decides between offering "Continue last conversation" (`claude --continue`, which ERRORS when the folder has none) and a plain fresh start. Probes `~/.claude/projects/<encoded-path>/` for any `.jsonl` (the path encoding, non-alphanumerics → `-`, is documented-stable; file CONTENTS are internal and deliberately never parsed).
#[tauri::command]
pub fn has_claude_session(cwd: String) -> bool {
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    let encoded: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = PathBuf::from(home).join(".claude/projects").join(encoded);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
}

/// Locate the Claude Code CLI: fast path probes the known install locations; fallback asks a login shell (the user's real PATH, GUI apps don't inherit it). Returns the resolved binary path, or None when not installed. The result is kept natively: a Claude session launches THIS path (file-probe detection and login-shell resolution disagree whenever ~/.zshrc owns the PATH line, the default install; see pty_spawn), never one the webview names.
#[tauri::command]
pub async fn detect_claude(state: State<'_, PtyState>) -> Result<Option<String>, String> {
    let found = tauri::async_runtime::spawn_blocking(detect_claude_blocking)
        .await
        .map_err(|e| e.to_string())?;
    *state.claude_path.lock().map_err(|_| "pty state poisoned")? =
        found.as_deref().map(PathBuf::from);
    Ok(found)
}

pub(crate) fn detect_claude_blocking() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let probes = [
        format!("{home}/.local/bin/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
    ];
    for p in probes {
        if PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }
    let out = std::process::Command::new(user_shell())
        .args(["-lc", "command -v claude"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::{
        child_environment, claude_argv, confine_terminal_cwd, exec_script, prepended_path,
        validate_launch, Launch, DENIED_ROOTS,
    };
    use std::path::{Path, PathBuf};

    /// A fresh scratch tree per test: `<tmp>/kookaburra-pty-<name>/` with a canonical `Kookaburra Cut` root inside it.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("kookaburra-pty-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("Kookaburra Cut");
        std::fs::create_dir_all(root.join("acme-promo")).unwrap();
        (base, root.canonicalize().unwrap())
    }

    #[test]
    fn a_project_folder_inside_the_workspace_is_allowed() {
        let (base, root) = scratch("inside");
        let cwd = confine_terminal_cwd(&root, &root.join("acme-promo"), false, true, &DENIED_ROOTS);
        assert_eq!(cwd.unwrap(), root.join("acme-promo"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_sibling_sharing_the_root_prefix_stays_outside() {
        let (base, root) = scratch("sibling");
        let evil = base.join("Kookaburra Cut-evil");
        std::fs::create_dir_all(&evil).unwrap();
        let err = confine_terminal_cwd(&root, &evil, false, false, &DENIED_ROOTS).unwrap_err();
        assert_eq!(err, "the terminal can only open inside the workspace");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_symlink_pointing_out_of_the_workspace_is_refused() {
        let (base, root) = scratch("symlink");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        let err = confine_terminal_cwd(&root, &root.join("escape"), false, false, &DENIED_ROOTS)
            .unwrap_err();
        assert_eq!(err, "the terminal can only open inside the workspace");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_opt_out_seats_a_prompt_but_never_a_command() {
        let (base, root) = scratch("optout");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        let err = confine_terminal_cwd(&root, &outside, true, true, &[]).unwrap_err();
        assert_eq!(err, "commands can only run inside the workspace");
        let cwd = confine_terminal_cwd(&root, &outside, true, false, &[]).unwrap();
        assert_eq!(cwd, outside.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_opt_out_never_opens_a_system_directory() {
        let (base, root) = scratch("system");
        for denied in [Path::new("/"), Path::new("/usr")] {
            let err = confine_terminal_cwd(&root, denied, true, false, &DENIED_ROOTS).unwrap_err();
            assert_eq!(
                err, "the terminal cannot open in a system directory",
                "{denied:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_or_file_path_is_refused_before_any_policy() {
        let (base, root) = scratch("missing");
        assert!(confine_terminal_cwd(&root, &root.join("nope"), true, false, &[]).is_err());
        std::fs::write(root.join("note.txt"), "x").unwrap();
        assert_eq!(
            confine_terminal_cwd(&root, &root.join("note.txt"), true, false, &[]).unwrap_err(),
            "the terminal working directory must be a folder"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prepended_path_never_leaves_an_empty_entry() {
        assert_eq!(
            prepended_path("/a/bin", Some("/usr/bin:/bin".into())),
            "/a/bin:/usr/bin:/bin"
        );
        // An empty inherited PATH must NOT produce "/a/bin:"; a trailing colon is an empty entry, which POSIX resolves as the current directory.
        assert_eq!(prepended_path("/a/bin", Some(String::new())), "/a/bin");
        assert_eq!(prepended_path("/a/bin", None), "/a/bin");
    }

    fn inherited(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_child_environment_is_an_allow_list() {
        let env = child_environment(
            inherited(&[
                ("HOME", "/Users/x"),
                ("USER", "x"),
                ("PATH", "/usr/bin:/bin"),
                ("LC_ALL", "en_AU.UTF-8"),
                ("SSH_AUTH_SOCK", "/tmp/agent"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "tok"),
                ("ANTHROPIC_API_KEY", "key"),
                ("AWS_SECRET_ACCESS_KEY", "leak"),
                ("GITHUB_TOKEN", "leak"),
                ("VSCODE_PID", "1"),
                ("__CFBundleIdentifier", "com.example.ide"),
                ("GIT_ASKPASS", "/x"),
                ("ELECTRON_RUN_AS_NODE", "1"),
                ("TERM_PROGRAM", "vscode"),
                ("TERM_PROGRAM_VERSION", "1"),
                ("CLAUDECODE", "1"),
                ("CLAUDE_CODE_ENTRYPOINT", "cli"),
                ("CLAUDE_CODE_SSE_PORT", "1"),
            ]),
            Some("/Users/x/.local/bin"),
        );
        for kept in [
            "HOME",
            "USER",
            "LC_ALL",
            "SSH_AUTH_SOCK",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
        ] {
            assert!(env.contains_key(kept), "{kept} should reach the terminal");
        }
        for dropped in [
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "VSCODE_PID",
            "__CFBundleIdentifier",
            "GIT_ASKPASS",
            "ELECTRON_RUN_AS_NODE",
            "TERM_PROGRAM_VERSION",
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SSE_PORT",
        ] {
            assert!(
                !env.contains_key(dropped),
                "{dropped} must not reach the terminal"
            );
        }
        assert_eq!(env["TERM_PROGRAM"], "KookaburraCut");
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["FORCE_COLOR"], "3");
        assert_eq!(env["CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL"], "1");
        assert_eq!(env["PATH"], "/Users/x/.local/bin:/usr/bin:/bin");
        assert_eq!(env["LANG"], "en_US.UTF-8");
    }

    #[test]
    fn an_inherited_lang_and_an_absent_path_are_handled() {
        let env = child_environment(inherited(&[("LANG", "en_AU.UTF-8")]), Some("/a/bin"));
        assert_eq!(env["LANG"], "en_AU.UTF-8");
        assert_eq!(env["PATH"], "/a/bin");
        let env = child_environment(inherited(&[("PATH", "/usr/bin")]), None);
        assert_eq!(env["PATH"], "/usr/bin");
    }

    #[test]
    fn claude_argv_is_the_fixed_flags_plus_the_grounding_as_one_element() {
        let args = claude_argv(false, "You are the editing assistant.\nLine two");
        assert_eq!(
            args,
            [
                "--permission-mode",
                "auto",
                "--model",
                "claude-opus-5-5",
                "--effort",
                "high",
                "--append-system-prompt",
                "You are the editing assistant.\nLine two",
            ]
        );
        assert_eq!(claude_argv(true, "g")[0], "--continue");
        // A grounding full of shell metacharacters stays one argv element: nothing parses it.
        let hostile = "'; rm -rf ~ #";
        assert_eq!(claude_argv(false, hostile).last().unwrap(), hostile);
    }

    #[test]
    fn the_exec_script_is_fixed_per_shell_family() {
        assert_eq!(exec_script("/bin/zsh"), "exec \"$0\" \"$@\"");
        assert_eq!(exec_script("/bin/bash"), "exec \"$0\" \"$@\"");
        assert_eq!(exec_script("/opt/homebrew/bin/fish"), "exec $argv");
    }

    #[test]
    fn only_the_main_window_starts_claude_and_the_grounding_is_plain_text() {
        let claude = Launch::ClaudeSession {
            continue_last: false,
            grounding: "Edit scenes.".into(),
        };
        assert!(validate_launch(&claude, "main").is_ok());
        assert_eq!(
            validate_launch(&claude, "present").unwrap_err(),
            "only the main window can start Claude Code"
        );
        assert!(validate_launch(&Launch::InteractiveShell, "present").is_ok());
        let escape = Launch::ClaudeSession {
            continue_last: false,
            grounding: "x\u{1b}]52;c;payload\u{7}".into(),
        };
        assert!(validate_launch(&escape, "main").is_err());
        let empty = Launch::ClaudeSession {
            continue_last: false,
            grounding: "  ".into(),
        };
        assert!(validate_launch(&empty, "main").is_err());
    }

    #[test]
    fn the_launch_shape_deserialises_from_the_frontend_and_defaults_to_a_shell() {
        let claude: Launch =
            serde_json::from_str(r#"{"kind":"claudeSession","continueLast":true,"grounding":"g"}"#)
                .unwrap();
        assert_eq!(
            claude,
            Launch::ClaudeSession {
                continue_last: true,
                grounding: "g".into()
            }
        );
        let shell: Launch = serde_json::from_str(r#"{"kind":"interactiveShell"}"#).unwrap();
        assert_eq!(shell, Launch::InteractiveShell);
        // The old free-form shape is refused outright.
        assert!(serde_json::from_str::<Launch>(r#"{"command":"rm -rf ~"}"#).is_err());
    }
}
