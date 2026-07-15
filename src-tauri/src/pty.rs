//! Embedded terminal backend: real PTYs for the in-app Claude Code session.
//!
//! - `portable-pty` for the PTY pair; the slave is dropped right after spawn (or the reader never sees EOF) and the child is reaped by `wait()` on the reader thread.
//! - Output streams to the webview over a `tauri::ipc::Channel` as RAW byte chunks (the event system is documented as unsuited to this throughput); raw bytes, not strings, let xterm.js reassemble codepoints split across chunk boundaries.
//! - Flow control: the frontend applies the xterm.js watermark scheme and calls `pty_pause`/`pty_resume`; a paused reader stops draining, the kernel PTY buffer fills, and the child blocks, real backpressure.
//! - The shell is spawned as a LOGIN shell so `/etc/zprofile` + `~/.zprofile` rebuild the user's PATH inside the terminal (GUI apps inherit launchd's bare PATH); that is NOT sufficient for `claude` itself, since the default install adds its dir in `~/.zshrc`, which a login non-interactive shell never sources, so the panel execs the DETECTED binary by full path and passes its dir as `path_prepend` (dev only worked because the dev process inherits the launching terminal's interactive PATH).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

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
}

type SessionMap = Arc<Mutex<HashMap<u32, PtySession>>>;

#[derive(Default)]
pub struct PtyState {
    sessions: SessionMap,
    next_id: AtomicU32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Working directory for the shell (the project folder).
    pub cwd: String,
    /// Optional command to exec via `shell -l -c <command>`; absent → interactive shell.
    pub command: Option<String>,
    /// Optional directory prepended to the child's PATH (e.g. the detected claude's dir) so the session, and anything it spawns, resolves it regardless of which rc file owns the user's PATH line; path_helper keeps prepended entries.
    pub path_prepend: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// `prepend:inherited`, degrading to just `prepend` when nothing is inherited; a trailing `:` would put the CURRENT DIRECTORY on the PATH (POSIX empty-entry rule).
fn prepended_path(prepend: &str, inherited: Option<String>) -> String {
    match inherited {
        Some(rest) if !rest.is_empty() => format!("{prepend}:{rest}"),
        _ => prepend.to_string(),
    }
}

/// The user's shell: `$SHELL` (set by launchd from the user record even for GUI apps), falling back to the macOS default.
fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// Spawn a login shell in a fresh PTY, streaming output over `on_data`; data messages are raw UTF-8 byte chunks, the final message is a JSON `{ "exit": code }`. Returns the session id for the write/resize/kill/pause commands.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    settings: State<'_, crate::workspace::SettingsState>,
    options: SpawnOptions,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    // F-006: confine the terminal cwd to the workspace root; the panel only ever opens a ws: project folder, so a path outside it is never legitimate.
    let root = crate::workspace::require_root(&app, &settings)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let cwd = PathBuf::from(&options.cwd)
        .canonicalize()
        .map_err(|e| format!("terminal working directory not found: {e}"))?;
    if !cwd.starts_with(&root) {
        return Err("the terminal can only open inside the workspace".into());
    }

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: options.rows.max(2),
            cols: options.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(user_shell());
    cmd.arg("-l"); // login shell → /etc/zprofile + ~/.zprofile rebuild the real PATH
    if let Some(command) = &options.command {
        cmd.arg("-c");
        cmd.arg(command);
    }
    cmd.cwd(&cwd);
    if let Some(dir) = options.path_prepend.as_deref().filter(|d| !d.is_empty()) {
        cmd.env("PATH", prepended_path(dir, std::env::var("PATH").ok()));
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8"); // GUI-spawned processes often lack a UTF-8 locale
    }

    // The PTY inherits THIS process's environment; in dev, leaked VS Code TERM_PROGRAM/VSCODE_* vars make the embedded claude auto-install the IDE extension, and CLAUDECODE markers read as a nested session, so scrub editor/session identity (CLAUDE_CODE_OAUTH_TOKEN is deliberately NOT scrubbed, token-based auth may ride it).
    for (key, _) in std::env::vars() {
        if key.starts_with("VSCODE_") || key.starts_with("CURSOR_") {
            cmd.env_remove(&key);
        }
    }
    for key in [
        "TERM_PROGRAM_VERSION",
        "GIT_ASKPASS",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SSE_PORT",
        "ELECTRON_RUN_AS_NODE",
        // launchd stamps the SPAWNING app's bundle id on every child; in dev that leaks the launching IDE (claude fingerprints the host terminal by this var before TERM_PROGRAM), and packaged it names our own bundle, an UNKNOWN id under which claude ignores COLORTERM and renders the TUI monochrome.
        "__CFBundleIdentifier",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("TERM_PROGRAM", "KookaburraCut");
    // With the host identity scrubbed, claude has no terminal-DB entry to trust and ignores COLORTERM for the colour decision; declare the capability explicitly, xterm.js genuinely renders 24-bit colour, so forcing level 3 is honest.
    cmd.env("FORCE_COLOR", "3");
    // Belt-and-braces: even if an IDE signal slips through (e.g. a stale ~/.claude/ide lock file), claude must never auto-install an IDE extension from OUR terminal.
    cmd.env("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1");

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
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = map.get_mut(&id).ok_or("no such terminal session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

/// Resize the PTY (the kernel delivers SIGWINCH to the foreground process group).
#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = map.get(&id).ok_or("no such terminal session")?;
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

/// Kill the session's child; the reader thread unblocks, reaps via `wait()`, sends the exit message, and removes the session from the registry.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if let Some(session) = map.get_mut(&id) {
        session.gate.set(false); // never leave the reader parked while dying
        let _ = session.killer.kill();
    }
    Ok(())
}

/// Frontend watermark flow control: pause stops draining the PTY (the kernel buffer then backpressures the child); resume unparks the reader.
#[tauri::command]
pub fn pty_pause(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if let Some(session) = map.get(&id) {
        session.gate.set(true);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resume(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if let Some(session) = map.get(&id) {
        session.gate.set(false);
    }
    Ok(())
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

/// Locate the Claude Code CLI: fast path probes the known install locations; fallback asks a login shell (the user's real PATH, GUI apps don't inherit it). Returns the resolved binary path, or None when not installed; the caller must LAUNCH by this path (not bare `claude`), since file-probe detection and login-shell resolution disagree whenever ~/.zshrc owns the PATH line (the default install; see pty_spawn).
#[tauri::command]
pub async fn detect_claude() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
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
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::prepended_path;

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
}
