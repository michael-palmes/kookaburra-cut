---
description: Launch the Kookaburra Cut HMR preview (optionally focused on a project)
argument-hint: [project]
---

Launch the Kookaburra Cut preview for project `$1` (or the default if omitted).

Steps:

1. Pick a free dev port: `PORT="$(node scripts/dev-port.mjs pick)"`. Port 1420 is reserved for Michael's own session, so never start on it.
2. Start the app with that port: `KOOKABURRA_PORT="$PORT" pnpm tauri dev -c "$(node scripts/dev-port.mjs override "$PORT")"` (Vite HMR + the Tauri WKWebView shell). The preview canvas runs `frameloop="demand"`; scrub the timeline to drive `seek(t)`.
3. If `$1` is given, ensure its `projects/$1/project.json` exists and is the active project.
4. Report the actual dev URL (http://localhost:$PORT) and any build errors surfaced in the terminal.

NOTE: Scaffold stub — wire project selection into the editor store as the preview UI is built. Preview and export share one timeline, so what you scrub is what exports.
