# Changelog

All notable changes to Kookaburra Cut are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-08-02

### Added

- Neighbouring animations share one draggable keyframe: the lane draws a
  single diamond per junction, so moving it retimes both sides at once.
  Legacy animations with a gap between them show two keyframes until they
  are dragged together.
- Keyframe and segment menus to duplicate an animation, add a keyframe at
  the clicked point, resize it to an exact duration or delete it and merge
  the gap, with a playhead-aware "+ Animation".
- An optional Detailed view that swaps the diamonds for narrow lines, with
  a minimum length derived from the strip's pixel width.

### Changed

- Both timelines span the full window width, and the whole timeline dock
  scrubs, not just the strip.
- Scenes shorter than 8% of the strip are floored so they stay selectable,
  with scrubbing mapped piecewise so the playhead still tracks the pointer.
- The easing panel is rebuilt with a title, grouped options and curve
  icons, opened from the keyframe menu.
- The scene inspector's Camera section is now Animations, with mode icons.
- Deleting the last animation freezes the framing where it was.

### Fixed

- Text renders again on macOS 27. Its Metal compiler rejects the code ANGLE
  generates for `inout` parameters bound to hoisted globals, so troika's
  derived text material never linked and every text mesh was invisible in
  both preview and export.

## [0.9.0] - 2026-07-31

### Added

- Before/after comparison scenes. One scene renders as two sides and
  composites under an animatable mask (linear at any angle, circle,
  radial or blend), with a divider line, grip and label chips drawn
  from theme tokens. The divider gets its own timeline lane with eased
  keys and four motion presets, and the after side can carry its own
  media, theme, background and lighting through a Before/After pill in
  the inspector.
- Multi-device scenes. Stage two to four devices with six layout
  presets, resolved per aspect, and a Position drill covering gap and
  per-device position, rotation, scale and grounding. The comparison
  kind scaffolds each device with its own screen media.
- Staged 3D objects. Any scene can stage objects from a library with a
  CC0 starter set and GLB import, beside-device presets and a
  preview-only drag gizmo.
- A reference pane in the video editor: match two recordings side by
  side with scrub lock, swap, frame nudge that bakes as a trim, sync
  markers and a ghost overlay.
- Welcome screen project groups, and search docked beside the wordmark
  with Cmd+F to focus it.
- Copy scenes into another project with their assets, and a
  project-wide font override.
- Video window placement sliders, and a Window recording toggle that
  crops the margins and corner radius off a raw macOS window capture,
  set automatically when a capture is detected.
- An Image scene kind, a wired Blank template and a header-icon image
  picker.
- A capture bridge so the embedded terminal can see rendered frames in
  the packaged app.

### Changed

- The video window floats over the scene's own background: the backing
  stage is gone, and wizard-created titled scenes place the window to
  fit the text.
- Media lists order by date added, file drops import while pickers are
  open, and picker grids scroll three across under a pinned toolbar.
- Media cards gain Copy path, Show in Finder and delete from library.
- Overlays take a full-panel shape, panel text styles, and a default
  colour that follows the visible backdrop.
- Lighting sliders are labelled, light types carry icons, lighting
  presets show baked thumbnails, and the Render row sits under
  Playback options.
- Show in Finder reveals exports that land in Downloads.
- Change device applies to every staged device by default.

### Fixed

- Edit video re-points the device actually being edited, not always
  the first.
- 3D backgrounds no longer sort in front of scene content at oblique
  camera angles.
- Overlay bullets wrap from measured text, so the space reserved and
  the space drawn agree.
- Device rows in the inspector target the selected device, fixing a
  latent bug when removing the first one.

## [0.8.0] - 2026-07-29

### Added

- 3D backgrounds. A new background type built from real world-space
  geometry, so it moves with the scene camera instead of sitting flat
  behind everything. Ten looks: Grid plain, Grid shell, Grid hall,
  Contour field, Drift slabs, Orb field, Halo rings, Skyline prisms,
  Point swell and Dust drift, each with nine colour presets, its own
  sliders, and any 2D background as the backing behind it.
- Four animated grid backgrounds: Dot grid, Graph grid, Horizon grid
  and Hex grid, with thirty-six presets between them.
- A live Theme preset for animated backgrounds. Colours come from the
  active theme's tokens as the scene renders, so the fill follows a
  theme switch instead of going stale.
- Any scene can take an overlay. Add overlay sits in the inspector until
  one exists, then opens the full drill, and Show on this scene hides an
  overlay while keeping its styling.
- Overlay panels lay their title and subtitle out from measured text, so
  the space reserved and the space drawn always agree: no phantom gaps,
  no overlap. Cutout presets scaffold a flat panel over a lifted scene
  clear, and bullets can be typed in the create wizard.
- Device-only scenes scaffold centred and dominant, resting on a staged
  floor with real map shadows, or floating with a soft blob shadow.
- The terminal panel flags a new version of Claude Code and updates it
  in place, with a Run diagnostics button on failed sessions.

### Changed

- Exports read General, then Studio, then the platform groups, and the
  General and Studio presets cover every aspect the engine supports.
  App-triggered exports now land in ~/Downloads by default.
- The Scene tab reads in divided sections: what the scene has, what can
  be added, then its settings. Change video and Edit video sit together,
  and Clear text is one click.
- Picking a theme card applies it straight away in both pickers.
- Picking an Animated, Gradient, Image or Video background clears the
  scene's stage backdrop in the same undoable step.
- Adding or duplicating a scene lands the playhead inside the new scene
  rather than on its entry transition, and right-clicking anywhere in
  the playback bar opens the menu for the scene under the pointer.
- Background previews follow the project's theme: a light project sees
  light clips, preset tiles lead with the theme's mode, and clicking a
  card applies exactly what the card shows.
- Dark presets across the shader packs are brighter, and every light
  preset is softened so text still leads.
- First run creates ~/Kookaburra Cut without asking. Settings is now the
  one place that location changes, with a one-click reset to the default.

### Fixed

- Importing a pack that carries a font no longer fails on a workspace
  that has never pinned one.
- Pack imports name what actually went wrong. A write failure no longer
  reads as an unreadable pack, one bad font no longer condemns the rest,
  and a font written before a failure is indexed instead of orphaned.

## [0.7.0] - 2026-07-27

### Added

- Packs. Export projects, themes, fonts, 3D objects, gradients, export
  presets and screenshots as one signed .kbpack file, and import someone
  else's through a trust, contents and conflicts flow. Double-click a
  pack or drop it onto the app.
- Camera rigs: free-flight camera poses alongside orbit, with depth
  bands, rig presets and shot continuity between scenes.
- Scene lighting. A sun, free lights in world, camera or subject space,
  emissive light fixtures, HDRI environments, lighting keyframes,
  presets and tone-mapping controls, per scene.
- Three new aspect ratios: 5:4, 3:2 and 2:3.
- Twelve scene presets in a leaner create flow.
- Video editor: clips can be spliced at the playhead, and freeze frames
  resize after placing.
- Scenes are placed with a draggable insert strip instead of a dialog.
- Tap highlights remember their settings per project and add a 6x speed.
- Inspector shortcuts for editing video, transitions and duplication.

### Changed

- The media pickers share the one library view everywhere.
- Video window presets are polished and inspector rows align.
- Shortening a scene clamps cleanly at either edge, and the editor
  chrome flips sides mid-transition.
- New scenes default to a 600 ms crossfade; project settings are tidier.
- Edit in Claude Code moves from Cmd+E to Opt+Cmd+E, freeing Cmd+E for
  Export Video.

### Fixed

- Exports use far less memory on long projects.
- Animated backgrounds hold their exact colours through transitions.
- A missing image asset degrades to a placeholder instead of failing
  the render.
- Project manifests that list the same scene file twice are refused.

## [0.6.0] - 2026-07-24

### Added

- Video editor: S and F keyboard shortcuts for Split and Freeze.
- Video editor: tap highlights for screen recordings. Arm the Tap tool
  (T), click the preview to place a soft glow dot at the playhead, drag
  its marker to reposition, right-click to retime or delete; Render to
  project composites the animation into the flattened video.
- A letterbox fit option for video backgrounds: show the whole frame
  instead of cropping to fill.
- Plain text scenes render their header icon above the headline, the
  same field overlays already show.

### Changed

- The inspector is restructured into compact drill-in menus.
- Number inputs drag to scrub, with a live camera preview and a single
  undo step per drag.

## [0.5.0] - 2026-07-23

### Added

- Scene overlays: a camera-locked panel with a shaped cutout the scene
  renders through, like a slide deck. Titles, bullets, a status chip, a
  header icon and decorations, all editable in the inspector with a
  drag, resize and rotate gizmo in the preview.
- The video window scene primitive: a screen recording as a floating
  rounded window over a colour, gradient or image backing stage, with
  real 3D parallax under the scene camera.
- A media library: browse the shared workspace pool from every picker,
  filtered by kind, with right-click menus throughout.
- An Android device in graphite, black and white.
- Sharing export presets (H.264 and H.265, 60 fps, up to native 4K).
- A loading overlay while an export prepares.

### Changed

- A device scene's length can follow its video automatically.

### Fixed

- Timeline rename and duration edits no longer shift the surrounding
  layout.
- Project app icons update immediately after a swap.

## [0.4.0] - 2026-07-21

### Added

- Layered screenshot stacks. Chain screen and text cards into a layered
  arrangement with a drill-in builder, four presets, an animation lane of
  its own and present-mode hold looping.
- A full-frame video scene kind in the new-scene wizard: the scene is a
  background video with no stage, and its length follows the video.
- A global screenshots folder (~/Kookaburra Cut/screenshots) with
  copy-on-use picking; new projects seed sample screenshots and an app
  icon.

### Fixed

- The MacBook Pro 16" device renders correctly again: readable keycaps
  with legends, solid speaker grilles and a brighter aluminium finish.
  Source builds regenerate the model with "pnpm assets:macbook-pro-16".
- Release DMG builds report the failing line instead of dying silently
  when a volume of the same name is already mounted.

## [0.3.0] - 2026-07-20

### Added

- Present mode. Play a project as a click-through slideshow in its own
  window, holding on each scene until you advance, with per-scene camera
  loops, a gentle device turntable and a straight video mode.
- Three new transitions (slice, dissolve and warp) and an optional feel
  control (smooth or snappy easing) per transition.
- Freeze frames. A toolbar button holds the frame under the playhead as
  its own clip, with an editable hold time.
- A scene manager: drill into a reorderable scene list with multi-select
  drag, duplicate and rename.
- A brand lockup primitive, a six-scene starter template arc and a
  project app icon picker.
- Per-text-element font, size and position overrides, and custom device
  tints via a colour picker.
- Camera centre guides with gentle snapping, and redesigned camera
  keyboard shortcuts.
- A playback quality picker (Balanced and Performance) and an opt-in
  fps slowdown badge.

### Changed

- A transition now belongs to the scene it plays at the end of, blending
  into the next; existing projects read identically through a legacy shim.
- The new-scene wizard shares text fields across scene kinds and shows
  preview stills; media pickers sort newest first.
- Preview playback is much smoother on media-heavy projects: playing
  clips bind a lightweight preview tier while exports keep the exact
  full-resolution path.

### Fixed

- The editor media list scrolls instead of squashing, and button labels
  no longer wrap onto two lines.

## [0.2.0] - 2026-07-17

### Added

- Opt-in auto-update. Turn on "Check for updates on launch" in Settings and
  the app checks GitHub for new releases and installs them in one click.
- Hardware video acceleration via VideoToolbox. Media, editing and clip prep
  are hardware-accelerated by default (toggle in Settings), and hardware
  fast-draft export lanes are available for H.264, HEVC and ProRes.
  Deterministic exports still use the software path, so Verify is unaffected.

### Changed

- Device motion is now opt-in for new device scenes.

### Fixed

- Terminal-triggered runs now resolve the packaged app binary from
  Info.plist rather than assuming its name.
- The packaged app now reads bundled project assets from its own resources
  rather than a dev checkout on the same machine, so device screen videos
  export correctly instead of a placeholder.

## [0.1.0] - 2026-07-16

First public source release.

- Build video projects as folders of scenes, authored in React with a small
  toolkit of primitives: animated text, counters, image cards, video clips,
  3D devices and staging.
- Ten built-in themes cover colour, typography, lighting, staging and
  text-motion defaults, and can be applied per project or per scene.
- Real 3D device mockups play your video or image assets on their screen,
  with per-scene camera moves.
- A pack of transitions — crossfade, blur, push, zoom, whip, luma, glitch and
  more — with a live-preview picker for choosing and tuning them.
- One soundtrack per project, mixed sample-exact with the video and faded out
  automatically at the end.
- Export to platform-ready presets — Meta, TikTok, YouTube, LinkedIn, X,
  Reddit, Telegram, CTV, web, or a ProRes master — with size estimates and
  loudness targeting, alongside a plain default export.
- Every export is deterministic: exporting the same project twice produces
  byte-identical video, provable with the in-app Verify ×2 check.
- Everything renders through a single canvas, stepped frame by frame on a
  manual clock, so text, graphics and 3D composite the same way every time.
- An embedded terminal runs Claude Code scoped to the open project, for
  authoring and editing scenes conversationally.
- Runs entirely on your Mac: no telemetry, no cloud, no account. The optional
  embedded Claude Code terminal is the one network exception, and only talks
  to Anthropic while you are using it.
- Ships as a native macOS app for Apple Silicon, built on Tauri.
