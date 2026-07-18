---
description: Scaffold a new Kookaburra Cut scene (TSX + sidecar doc) and register it in its project.json
argument-hint: <project> <scene-name> [device|title|blank]
---

Create a new scene for the Kookaburra Cut project `$1` named `$2`, of kind `$3` (default `device` if the
user mentions a device/media, else `title`; `blank` only when asked).

The app's native scaffolder (`scaffold_scene` in `src-tauri/src/scene_doc.rs`) and this
command emit IDENTICAL scenes from the SAME templates — never invent a different shape.

Steps:

1. Invoke the `kookaburra-scene-authoring` skill; follow its rules and its "Scene documents"
   section (the sidecar schema).
2. Determine the next numeric prefix by listing `projects/$1/scenes/` (e.g. `03`), and
   slugify the name: stem = `<NN>-<slug>` (e.g. `03-hero-demo`).
3. Read the TSX template for the kind from `src-tauri/templates/scenes/<kind>.tsx.tmpl` and
   replace the placeholders: `__SCENE_ID__` = the slug, `__STEM__` = the stem, `__NAME__` =
   the human name, `__DURATION_MS__` = the duration (step 5). Write it to
   `projects/$1/scenes/<stem>.tsx`.
4. Write the sidecar `projects/$1/scenes/<stem>.json` per the skill's schema: `version: 1`,
   `name`, `duration` (step 5), `text` — for the title kind seed `title` (the user's copy,
   else `""`) AND `subtitle: ""` (empty strings keep the panel fields visible; TitleBlock
   recentres); other kinds get a `title` if the user gave copy (`headline` is the legacy
   key on old scenes; never write it for new ones) — and for the device kind one
   `devices[0]` entry (`id: "d1"`, catalog `model`/`colour`, `media` if given, the
   template's default `placement`, `motion`, `shadow`).
5. Duration: video media → `{ "mode": "follow-media", "sourceDeviceId": "d1" }` and
   `durationMs` = the video's length (`ffprobe -v error -show_entries format=duration -of
   default=nw=1:nk=1 <file>`, seconds → ms, rounded). Otherwise `{ "mode": "manual" }` and
   **4000ms**.
6. Register the scene in `projects/$1/project.json` under `scenes` with its `file` and
   `durationMs`, in order.
7. Verify: `pnpm build`, `pnpm test`, `pnpm lint` — fix and rerun until clean.
8. Tell the user to preview with `/preview $1`, and to gate with `Verify ×2` before relying
   on the scene (the skill's validation loop).

Media rules: the referenced media must already live in `projects/$1/assets/` (copy it there
if the user points elsewhere); reference it project-relatively (`assets/<file>`).
