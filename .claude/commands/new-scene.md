---
description: Insert a saved Kookaburra Cut scene preset and apply requested edits
argument-hint: <project> <scene-name> [preset-slug]
---

Create a scene in project `$1` named `$2`, starting from saved preset `$3`.

1. Use `kookaburra-scene-authoring`. Read the project's manifest and the available
   `presets/*/preset.json` documents. Choose the matching saved preset from its
   name and tags; use `title` when no particular composition was requested.
   `rig` starts from `title`, then adds the requested free-camera track.
2. Read that preset's `project.json` and its one scene. The saved TSX, sidecar,
   duration and media are authoritative. If the canonical preset is unavailable,
   report that and use the app's New scene gallery when available.
3. Insert through the app's shared preset-copy operation when available. For
   repository file authoring, copy the scene to a fresh destination file stem and
   give its `defineScene` a unique ID. Copy referenced assets, renaming collisions
   and updating references without overwriting existing project assets.
4. Register the copied scene once, after the current scene unless another position
   was requested. Preserve its saved duration and scene effects. Keep the destination
   project's theme and defaults; retain explicit source scene overrides. Do not copy
   the preset project's soundtrack, global camera or persistent layer.
5. Apply only the requested edits to the copied sidecar and its display name.
   Preserve managed text, embedded labels, devices, chart data and media not being
   changed. A later preset edit affects future insertions, not this independent copy.
6. Follow the scene-authoring validation loop: load the scene, fix reported errors,
   capture a frame and inspect it. Check both landscape and portrait for layout edits.

To change the reusable original, open Welcome → Presets → App presets in a dev
build, edit and save the preset there. New scene uses those same saved documents.
User presets remain editable in packaged builds; bundled presets offer Edit a copy.
