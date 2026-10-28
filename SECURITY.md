# Security

Kookaburra Cut is a local-only macOS desktop app: no telemetry, no accounts,
no cloud. Everything it reads and writes stays on your machine (the workspace
at `~/Kookaburra Cut`, and app caches under the standard Application Support
location). Two opt-in network exceptions: the optional embedded Claude Code
terminal, which only runs when you explicitly invoke it, installs via a script
shown visibly in the terminal, and sends the open project's files to Anthropic
while in use (once you have started a session, and only while the update check
below is on, the terminal panel also asks
`downloads.claude.ai/claude-code-releases/latest` for the current Claude Code
version, at most once a day, with no identifiers, to offer an update); and the
update check, which runs at launch only if you press Get started on the
first-run welcome with its switch on (recommended, so it starts on; Escape
declines it, and Settings changes it any time) or when you choose Check for
updates, asks GitHub's release endpoint
(`github.com/michael-palmes/kookaburra-cut/releases`) whether a newer version
exists, sends no identifiers, and downloads nothing without your say-so.
Updates install only after their ed25519 signature verifies against the key
baked into the app. Nothing else is contacted: opening a project, importing a
pack or exporting a video never leaves the machine. Content that arrives with a
project cannot configure the assistant: packs never carry Claude settings, an
imported `CLAUDE.md` is saved as `NOTES.md` and replaced with the app's own,
and every open strips hooks, permissions, env, commands, agents and skills the
app did not ship.

What the app keeps for itself stays yours alone. Its own folder under
Application Support (settings, the decoded frames and previews of your footage
in `cache/`, the pack signing key's file fallback) and the `_bridge` and
`_autorun` folders in your workspace are created readable by your account
only, checked again at every launch, and marked so Spotlight never indexes
them; the pack signing key itself lives in your login Keychain and is never
synchronised. Deleting a project or an asset drops its frames and previews
from those caches as it goes to the Trash (a project put back decodes again).
Your projects are your documents and keep ordinary permissions. The bundled
ffmpeg and ffprobe run with a bare environment and may open local files only.

Scene code is the one thing a project can run, so running it needs your say-so
and never more reach than the window needs. Each app window gets only the
native commands it uses (an app permission manifest under
`src-tauri/permissions/`, checked per window before any command runs), and the
embedded terminal starts Claude Code from a fixed launch shape with an
allow-listed environment, never a command string from the page. A project's
scenes run only after you press Allow on a native macOS sheet that names the
project and its folder (Return declines); that consent is bound to the content
of the project's scenes, manifest and agent configuration, so content that
changed while the project was closed asks again on the next open. Anything the
app deletes goes to the Trash.

## Reporting a vulnerability

If you believe you've found a security issue (for example in the Tauri IPC
surface, the bundled sidecar handling, the update mechanism, or the embedded
terminal), please report it privately through GitHub's private vulnerability
reporting: open the
[Security tab](https://github.com/michael-palmes/kookaburra-cut/security) and
choose **Report a vulnerability**, or use the
[report form](https://github.com/michael-palmes/kookaburra-cut/security/advisories/new)
directly. That creates a draft advisory visible only to the maintainer, so
details stay private until a fix ships. Please don't open a public issue for
anything that looks like a security problem.

## Supported versions

Only the latest release is supported; please update before reporting.
