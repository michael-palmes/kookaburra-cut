# Editable content library

Templates, scene presets and themes are reusable documents that can be opened,
edited and saved from Kookaburra Cut. Welcome exposes the library without first
opening a project. The source documents remain authoritative.

## Everyday workflow

| Content | Create | Edit | Reuse |
| --- | --- | --- | --- |
| Template | Convert a project, or choose Edit a copy on an app template | Open from Templates, use the normal editor, edit card details | Create a new project from the template |
| Scene preset | Save as preset from a scene, or copy an app preset | Open from Presets, edit its single scene and card details | Insert from the preset gallery at the chosen position |
| Theme | Open Themes from Welcome, then New or Duplicate | Open the theme editor, change settings and Save | Apply the theme to a project or scene |

Workspace content is editable in every build. App content can be copied into
the workspace in release builds. Development builds can also edit the bundled
documents in place. Native write commands enforce that distinction.

Templates and presets use the same project loader, media editor and scene
inspector as ordinary projects. Website and terminal content retain their
existing live-preview, capture and export boundaries. Imported scene code needs
the same trust consent as an imported project.

## Preset contract

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

The separate editor holds the raw document as a draft and previews it with a
live specimen. Its controls cover identity, colours, gradients, fonts, motion,
text style, backgrounds, staging, lights, fixtures, shadows and effects.
Changing one field preserves other supported and unknown document fields.

New themes cannot replace an existing theme accidentally. Duplication only
replaces a collision after the existing confirmation flow. Closing or opening
another theme includes any focused field in the unsaved-change check.

Theme preview jobs use the exact saved document and a canonical JSON cache key.
They run serially while the editor is idle, retain deferred work when the canvas
is busy, and restore the playhead without restoring a project the user left.

## Names and previews

The library manifest supplies the item's display name in both its card and the
editor. Its underlying project document does not need a second rename write.

Workspace template and preset posters refresh after opening or editing their
content. Captures verify the project identity before saving; a navigation cannot
put another project's pixels on the old card. Poster URLs include modification
times so the catalogue shows updated images.

Bundled preview sets still use the template/preset preview autoruns described in
[`presets/README.md`](../presets/README.md). Development cards show stale art.
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
- Pack import reviews omitted Website origins and terminal commands in library items.

Tests exercise save-to-insert behaviour, scoped paths, native scene invariants,
collision handling, raw theme preservation, release library actions and capture
ownership. Native acceptance uses the repository's branch-specific launcher.
Determinism and pack round-trip requirements remain in
[`docs/determinism.md`](determinism.md).
