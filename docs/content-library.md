# Editable content library

Templates, scene presets and themes are reusable documents that can be opened,
edited and saved from Kookaburra Cut. Welcome exposes the library without first
opening a project. The source documents remain authoritative.

Theme-window closing owns a single pending close operation. It flushes focused
fields, waits for a pending save, and prompts only for remaining unsaved changes.
Cancelled prompts and native failures leave the window available for another
attempt; disposed listeners cannot destroy a newly opened window.

In development, personal-theme menus offer **Move to app themes…**. The form
chooses an unused bundled identity and a category. The theme editor saves its
pending draft before the native move starts. Project, scene and comparison
references are updated in the active workspace's projects, templates and
presets, and in the current checkout's projects and presets. Other worktrees,
historical packs and Git history are outside this operation.

The move stages all changes and retains a journal, before/after documents and
the original theme folder under the workspace's `.theme-moves` directory.
Write failures roll back unchanged files and report any incomplete recovery.
The personal theme leaves the library only after the destination and reference
writes succeed. Other installations need a build containing the new app theme.

## Everyday workflow

| Content | Create | Edit | Reuse |
| --- | --- | --- | --- |
| Template | Convert a project, or choose Edit a copy on an app template | Open from Templates, use the normal editor, edit card details | Create a new project from the template |
| Scene preset | Save as preset from a scene, or copy an app preset | Open from Presets, edit its single scene and card details | Choose Add a scene and insert at the chosen position |
| Theme | Open Themes from Welcome, then New or Duplicate | Open the theme editor, change settings and Save | Apply the theme to a project or scene |

Workspace content is editable in every build. App content can be copied into
the workspace in release builds. Development builds can also edit the bundled
documents in place. Native write commands enforce that distinction.

Use `pnpm tauri dev` to edit bundled templates and presets. JSON saves update
the content and catalogue without reloading the frontend. The editor reads saved
sidecars from disk when reopening; external edits use its existing change poll.
App and scene code changes retain normal Vite hot reload. Restart the dev command
once after changing the Vite configuration.

Templates and presets use the same project loader, media editor and scene
inspector as ordinary projects. Website and terminal content retain their
existing live-preview, capture and export boundaries. Imported scene code needs
the same trust consent as an imported project.

## Preset contract

Add a scene and Welcome's App presets use the same catalogue and previews.
The 15 pictured starters live in the Scene starters category alongside the six
existing presets. Their saved example text and media are editable content.

To improve an original in development, open Welcome → Presets → App presets,
open its card, edit in the normal inspector and save. Add a scene then inserts that
saved version directly, without a separate text or media setup wizard. Insertion
defaults to after the current scene; the gallery's timeline can choose another
position. The new scene is selected for editing when insertion finishes.

Changing a preset updates both galleries and future insertions. Scenes already
inserted in projects remain independent copies, including their local edits.

A preset contains exactly one scene. Its editor cannot add, duplicate or remove
that scene, and native mutations enforce the invariant. Inserting a preset
writes the scene at its final position in one manifest update.

Scene content, overrides, effects and referenced media travel together. Asset
collisions are renamed and references updated, including LUTs, environment maps
and Website captures. Bundled sample media is materialised when making an
editable copy. Template copies also retain saved video edits.

Reuse adopts the destination project's theme and project settings. A source
project's global camera, persistent layer and soundtrack are not scene content.
Source typography, lighting, display transform and frame defaults are retained
for editing the saved preset, but do not replace the destination's defaults.
Scene-level overrides remain explicit and travel with the scene.

## Theme editing

Themes uses the same header search, close control and card sizing as Add a scene.
Category icons also appear in the inspector's compact theme browsers. Right-click
a theme for its available actions; applying and Claude editing only appear in an
editor context. Workspace themes can be duplicated from the menu too.

The separate editor holds the raw document as a draft and previews it with a
live specimen. Its controls cover identity, colours, gradients, fonts, motion,
text style, backgrounds, staging, lights, fixtures, shadows and effects.
Changing one field preserves other supported and unknown document fields.
Text style and motion show the selected preset, including None for an omitted
block. The theme editor has no Theme default option; scene inspectors retain it.
Opening these controls does not create settings or mark the theme as changed.

New themes cannot replace an existing theme accidentally. Duplication only
replaces a collision after the existing confirmation flow. Closing or opening
another theme includes any focused field in the unsaved-change check. Closing
waits for a pending save, prompts once for dirty changes and destroys a clean
window directly. A cancelled prompt or failed save leaves the editor usable.
Bundled saves refresh the runtime catalogue as well as the source document.

Theme preview jobs use the exact saved document and a canonical JSON cache key.
They run serially while the editor is idle, retain deferred work when the canvas
is busy, and restore the playhead without restoring a project the user left.

## Moving personal themes into the app

Development builds offer Move to app themes from personal-theme context menus.
The name and category start from the source. The resulting bundled identity must
be unused; the action never replaces a bundled theme. Pending editor and inspector
writes settle first, and the raw theme document retains its catalogue and unknown
fields while receiving its new identity.

The move updates matching project, scene and comparison theme references in the
active workspace's projects, templates and presets, plus the current checkout's
projects and presets. Other worktrees, installations, historical packs and Git
history remain outside this operation. Other installations need a build containing
the newly bundled theme.

Each move keeps a journal, the original theme and original reference documents in
`<workspace>/.theme-moves/`. The destination and reference changes are staged before
publishing; the personal theme moves into recovery storage only after those writes
succeed. Collisions and concurrent edits fail without replacing user changes.
Failures report the recovery path and any incomplete rollback. An interrupted
process leaves those recovery files available for manual recovery. Successful moves
refresh theme lists, previews and affected open documents.

## Names and previews

The library manifest supplies the item's display name in both its card and the
editor. Its underlying project document does not need a second rename write.

The Project inspector has a Library previews section for editable templates and
presets. Templates have four numbered slots and a cover choice; presets have one
preview. Capture current frame saves the playhead's scene, scene-local time and
aspect, including the photographic and phone formats. Cards contain the image inside their standard landscape frame, without
cropping or changing the scene layout.

Capture points accept an optional `aspect` and `sceneFile`. Legacy points retain
16:9 and midpoint behaviour. New captures follow their scene file through
reordering; app scene edits bind legacy template points before changing the scene
list. Removed scenes or times beyond a shortened scene require recapture, while
the previous image remains visible.

Both content types use the background render queue after pending edits settle.
Opening or editing saved content refreshes valid slots at their saved capture
points. Playback and export defer jobs, and source revisions reject obsolete
results. Rendering never moves the editor's playhead. Failed captures retain the
previous image and report the error in the inspector.

Templates store slot images in `previews/1.png` through `previews/4.png`; presets
store `poster.png`. A template's selected slot is its gallery cover, with the
legacy `poster.png` or `poster.jpg` retained until slot images exist. Listings
expose all four images and refresh their URLs after capture. Native preview access
permits only the item's validated image files, including checkout captures, before
returning paths or announcing a completed capture. Duplication copies existing
images and settings, including older bundled JPEG art, into the personal
item. Packs carry those files with the item. Personal previews are editable in
every build; bundled originals require development mode.

The preview autoruns in [`presets/README.md`](../presets/README.md) also honour
saved aspects and scene files. Initial bundled art remains a fallback.
Standalone theme edits have a live specimen immediately; their cached gallery
art is generated when an editor canvas next becomes available.

## Review and regression coverage

The branch review corrected the following failures:

- Workspace library code compiled without the project trust gate.
- Scoped library IDs were rejected by terminal capture, video editing and scene listing.
- Presets could gain extra scenes which reuse silently discarded.
- Save/copy operations lost scene effects, media dependencies and bundled samples.
- A new theme could overwrite an existing document with the same name.
- Theme controls discarded lighting fields and ignored named gradient changes.
- Concurrent theme saves could race preview captures or cache the wrong document.
- Failed catalogue refreshes erased visible entries or allowed repeat saves.
- New scene (now Add a scene) generated separate defaults instead of inserting the editable preset.
- JSON saves reloaded the frontend, and delayed updates could restore older data.
- Removing or filtering the selected preset silently selected a different scene.
- Pack import reviews omitted Website origins and terminal commands in library items.

Tests exercise save-to-insert behaviour, scoped paths, native scene invariants,
collision handling, raw theme preservation, release library actions and capture
ownership, four-slot captures, aspect dimensions, scene removal and portable
preview images. Native acceptance uses `pnpm acceptance:app` and its exact bundle
path. Add `--dev-authoring` to include development library actions; the provenance
record identifies that mode. The default remains a production frontend.
Determinism and pack round-trip requirements remain in
[`docs/determinism.md`](determinism.md).
