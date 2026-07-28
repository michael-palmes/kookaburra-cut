---
description: Scaffold a new Kookaburra Cut scene (TSX + sidecar doc) and register it in its project.json
argument-hint: <project> <scene-name> [device|deviceonly|title|titleicon|appversion|layeredscreenshot|video|videowindow|overlaystart|overlayend|overlaypanel|rig|blank]
---

Create a new scene for the Kookaburra Cut project `$1` named `$2`, of kind `$3` (default `device` if the
user mentions a device/media (`deviceonly` when they want no title copy), `appversion` for
an app icon + version lockup, `layeredscreenshot` for a 3D stack of app screens, `video`
for a full-frame background video, `videowindow` for a floating screen recording on a
backing stage, `titleicon` for a title with an icon above it, `overlaystart`/`overlayend`
for a panel beside a scene cutout window (window on the start or end side),
`overlaypanel` for a full panel with a chip, `rig` for a free-camera fly-through, else
`title`; `blank` only when asked).

The app's native scaffolder (`scaffold_scene` in `src-tauri/src/scene_doc.rs`) and this
command emit IDENTICAL scenes from the SAME templates — never invent a different shape.

Steps:

1. Invoke the `kookaburra-scene-authoring` skill; follow its rules and its "Scene documents"
   section (the sidecar schema).
2. Determine the next numeric prefix by listing `projects/$1/scenes/` (e.g. `03`), and
   slugify the name: stem = `<NN>-<slug>` (e.g. `03-hero-demo`).
3. Read the TSX template for the kind from `src-tauri/templates/scenes/<kind>.tsx.tmpl`
   (`deviceonly` uses `device.tsx.tmpl`; `titleicon` and `overlaypanel` use
   `title.tsx.tmpl`; `overlaystart`/`overlayend` use `overlay.tsx.tmpl`, whose scene
   clear lifts the background toward the text colour; `videowindow` uses
   `videowindow.tsx.tmpl`) and replace the placeholders: `__SCENE_ID__` = the slug, `__STEM__` = the stem, `__NAME__` =
   the human name, `__DURATION_MS__` = the duration (step 5). Write it to
   `projects/$1/scenes/<stem>.tsx`.
4. Write the sidecar `projects/$1/scenes/<stem>.json` per the skill's schema: `version: 1`,
   `name`, `duration` (step 5), `text` — the title/titleicon/overlay/device/videowindow
   kinds seed `title` (the user's copy, else `""`) AND `subtitle: ""` (empty strings keep
   the panel fields visible; TitleBlock recentres); the appversion kind seeds `title`
   (app name, else `"Your App"`) AND `subtitle` (version, else `"1.0"`); other kinds get
   `title`/`subtitle` only when the user gave copy (`headline` is the legacy key on old
   scenes; never write it for new ones). Then per kind:
   - device/deviceonly: one `devices[0]` entry (`id: "d1"`, catalog `model`/`colour`,
     `media` if given, `motion: { "preset": "none" }`) and NO `shadow` key for either
     kind, so Device auto-resolves it (map shadows over a staged floor, soft blob when
     floating). device: `placement` position `[0, -0.3, 0]`, `rotationDeg: [0, 0, 0]`,
     `scale: 1`. deviceonly: position `[0, 0, 0]` (no title to clear), `scale: 1.35`
     (dominant framing), `ground: true` (rests on a staged floor when the theme has one).
   - titleicon: `headerIcon` (the user's emoji or `assets/` image path, else `"🚀"`).
   - overlaystart/overlayend: `frame` = `{ "cutout": { "shape": "rounded-rect", "side":
     "start"|"end" }, "background": "background", "chip": { "label": "New", "icon":
     "circle-check", "colour": "accent" } }`; user bullet lines (one per line) go to
     `text.bullets`.
   - overlaypanel: same `frame` but the cutout collapses to a sliver so the panel reads
     full-frame: `{ "shape": "rounded-rect", "side": "end", "size": 0.1, "inset": 0.2 }`.
   - layeredscreenshot: a `layeredScreenshot` block with one layer (`{ "id": "l1",
     "visible": true, "z": 0, "items": [...] }`, the first screen as `{ "id": "i1",
     "kind": "screen", "src": "assets/<file>", "media": "image"|"video", "attach": null }`
     when media was given, else an empty items array) and the default pose `{ "spread": 0,
     "azimuthDeg": 0, "elevationDeg": 0, "zoom": 1, "pan": [0, 0] }`.
   - video: no text keys and a `background` block `{ "type": "video", "src":
     "assets/<file>" }` (the media the user gave, else the bundled
     `assets/sample-laptop-recording.mp4`).
   - rig: uses `title.tsx.tmpl` (in-app only; the native scaffolder has no rig kind, the
     inspector's camera presets cover it there) and seeds `cameraMode: "rig"` plus a
     `cameraRig` block from the fly-through preset shape relative to the base camera at
     `[0, 0, 5]`: four tangent-aim keys spread across the duration (positions
     `[-1.2,0.5,6.6]`, `[-0.5,0.2,4.6]`, `[0.4,0,2.8]`, `[1.0,0.1,1.4]`, each key's `at`
     baked to the NEXT position), segments `linear`, default smoothing (no `smooth`
     field). See `docs/camera.md`.
   - videowindow: a `videoWindow` block `{ "media": { "src": "assets/<file>", "aspect":
     <width/height when known> }, "stage": { "type": "color", "color": <the theme's
     background hex> }, "radius": "macos" }` (media defaults to the bundled laptop
     sample; omit `border`/`shadow`/`motion`/`scale` so engine defaults apply).
5. Duration: video media → follow-media and `durationMs` = the video's length
   (`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 <file>`,
   seconds → ms, rounded): `{ "mode": "follow-media", "sourceDeviceId": "d1" }` for the
   device kinds, `{ "mode": "follow-media", "source": "videoWindow" }` for videowindow,
   `{ "mode": "follow-media" }` (no source) for the video kind.
   Otherwise `{ "mode": "manual" }` and **4000ms**.
6. Register the scene in `projects/$1/project.json` under `scenes` with its `file` and
   `durationMs`, in order. The `file` must not already appear in `scenes` (the loader
   hard-errors on duplicates: copy the TSX and sidecar to a fresh stem instead of
   reusing one). New scenes join with a crossfade by default: seed
   `"transition": { "type": "crossfade", "durationMs": 600 }` on the previous scene's
   entry, and on the new entry too when it isn't last; never overwrite an existing
   transition.
7. Verify: `pnpm build`, `pnpm test`, `pnpm lint` — fix and rerun until clean.
8. Tell the user to preview with `/preview $1`, and to gate with `Verify ×2` before relying
   on the scene (the skill's validation loop).

Media rules: the referenced media must already live in `projects/$1/assets/` (copy it there
if the user points elsewhere); reference it project-relatively (`assets/<file>`).
