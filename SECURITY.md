# Security

Kookaburra Cut is a local-only macOS desktop app: no telemetry, no accounts,
no cloud. Everything it reads and writes stays on your machine (the workspace
at `~/Kookaburra Cut`, and app caches under the standard Application Support
location). Two opt-in network exceptions: the optional embedded Claude Code
terminal, which only runs when you explicitly invoke it, installs via a script
shown visibly in the terminal, and talks to Anthropic while in use; and the
update check, off until you enable it, which asks GitHub's release endpoint
(`github.com/michael-palmes/kookaburra-cut/releases`) whether a newer version
exists, sends no identifiers, and downloads nothing without your say-so.
Updates install only after their ed25519 signature verifies against the key
baked into the app.

If you believe you've found a security issue (for example in the Tauri IPC
surface, the bundled sidecar handling, or the embedded terminal), please open a
GitHub issue. If the details feel sensitive, say so in the issue and a private
channel can be arranged before specifics are shared.
