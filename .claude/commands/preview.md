---
description: Launch the Kookaburra Cut HMR preview (optionally focused on a project)
argument-hint: [project]
---

Launch the Kookaburra Cut preview for project `$1` (or the default if omitted).

Steps:

1. Start the app with `pnpm tauri dev` (Vite HMR + the Tauri WKWebView shell). The preview canvas runs `frameloop="demand"`; scrub the timeline to drive `seek(t)`.
2. If `$1` is given, ensure its `projects/$1/project.json` exists and is the active project.
3. Report the dev URL (http://localhost:1420) and any build errors surfaced in the terminal.

NOTE: Scaffold stub — wire project selection into the editor store as the preview UI is built. Preview and export share one timeline, so what you scrub is what exports.
