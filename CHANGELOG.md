# Changelog

All notable changes to Kookaburra Cut are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] - 2026-08-25

### Added

- A creative text motion pack: twenty in and out presets sampled per character
  or per word, among them orbit, slam, highlight wipe, word cycle, spotlight,
  converge and vapor, driven by new per-unit fields for rotation, stretch, mask
  clip, accent mix, SDF weight and chromatic echoes.
- Nine named text looks, themeable and settable per line: gradient, outline,
  neon, offset print, highlight block, frosted, arc, plus 3D glass and chrome.
- A Text style catalogue drill with a rendered preview card for every motion
  preset and look, a delay start, and a pinned delivery and timing footer.
- Size as a percentage on every typography element, reaching the counter, the
  brand lockup, chips and 3D text.

### Changed

- Project cards on the welcome screen open the shared context menu from the
  overflow button and on right click, with leading icons and a move to group
  glyph.
- Welcome search covers every project, with the rail following to All, and
  picking a group clears the query.

### Fixed

- Text drill copy fields write while you type: the preview follows each
  keystroke, the edit commits as one undo step, and Escape restores the copy as
  it was.
- Delete in the text drill removes the selected element rather than the group.
  The last element takes its emptied group with it and closes the drill.

## [0.13.0] - 2026-08-24

### Added

- A redesigned Scene inspector: a full-height, content-first surface with
  stacked navigation, first-click selection on the canvas, and first-class
  editing for images, devices, lighting, comparisons and objects. Ordered copy,
  styles, icons and motion live in managed Text groups, and frame chrome is
  separated from scene content.
- Twenty-four new themes across professional, expressive, digital-asset and
  finance categories, browsable by category with search, Recent and My themes,
  keyboard navigation and lazy previews. Four bundled fonts and two static
  backdrops come with them.
- Twelve app-update templates, backed by a sample art pack so every device
  screen shows believable UI, plus rendered card art in the picker that cycles
  on hover.
- Phone and Phone Landscape aspects, with the iPhone 17 Pro panel at its native
  1206x2622.
- Still images in the video editor as two second freeze clips, and one scene
  media family with authored Stage, Overlay and Window hosts, drag gizmos,
  window chrome on any host and several videos in a scene.
- A scene manager that deletes a whole selection, a Delete unused sheet that
  clears unreferenced assets, a colour picker with a foldable spectrum,
  ninety-six presets, a native eyedropper and the project's own colours, and
  scene lengths in minutes and seconds.
- A keyed divider angle for comparison scenes: keys are authored in the
  timeline lane, then refined by a slider and an angle field that edit the key
  nearest the playhead. Grip styles, a hex divider colour and tints come with
  them, and Before/After selectors move inside Device, Theme, Background and
  Lighting.
- Devices are offered by what the build carries, and the After side gains its
  own staging, finish, shadow and Edit video.

### Changed

- The comparison divider rides through transitions instead of standing down, so
  a comparison stays whole as one scene blends into the next.
- Space commits and plays from numeric, hex and slider fields, header trash
  icons lose their confirm step, and Delete removes the selected content.
- The media picker preview opens inside the inspector, with chevrons and arrow
  keys stepping the grid, and the Content header takes an accent-filled Add
  button distinct from the per-type add icons.
- Copy to project is an inspector drill with snapshot cards, and duplicate
  names warn as you type.
- Terminal autoruns queue on FIFO tickets, take their own dev port and launch
  without stealing focus, so they sit beside an interactive session instead of
  fighting it.

### Fixed

- Adding or reordering scenes no longer strands a device over a title scene.
  Scene document edits address the written file rather than an index captured
  before the write, and duplicating mints fresh ids.
- A file used both as a device screen and as an image backdrop is no longer
  flipped upside down by mount order.
- Gizmos track a framed scene's cutout viewport, and a transparent panel with a
  shaped cutout composes through it.
- The media browser toolbar wraps rather than clipping a control, and its bulk
  sweep collapses into an overflow menu where the bar is narrow.
- Chart lines and areas trim at the value axis bounds, scene rows stand down
  while their rename field is live, and the compare pane letterboxes beside the
  preview instead of covering the controls.

## [0.12.0] - 2026-08-07

### Added

- One gizmo system for the stage. Objects, devices and staged charts take 3D
  handles; text, hero charts and decorations take a 2D layer with move, corner
  resize, rotate and alignment guides. Sections outline on hover and select on
  a canvas click, and the camera tools stand down over a handle, with cmd,
  ctrl or option to keep the camera instead. Text blocks gain a rotation.
- A template browser built to scale past a hundred templates: a category rail
  with live counts, search, a safe or bold tier chip and hover-cycled preview
  cards, with Blank pinned first.
- Ten chart colour schemes, a per-chart font with a project-wide default, and
  value labels that nudge up or down and can sit on a coloured chip.
- Gradient, image and transparent fills for overlay panels, and text
  decorations with their own colour, face, font and line spacing.
- A plain-English warning before the camera switches to Free mode, with Cancel
  and a "Don't show this again" tick.

### Changed

- Live captures and scene thumbnails render in a hidden background window, so
  a terminal capture or a wizard's thumbnail grid never seizes the editor's
  canvas, playhead or selection. Thumbnails fill in as they land, and stand
  down during playback and exports.
- Adding a keyframe selects the new diamond and scrubs onto it, from every add
  path and on every timeline lane.
- Edit data leads the chart's Graph tab, and scaffolded decorations no longer
  seed a starter chip.
- The app ships lighter: dev-only spikes and preview labs left the bundled
  project tree, taking it from 19 MB to 8.9 MB.

### Fixed

- Duplicating a scene no longer cross-wires text between scenes. Scene identity
  comes from the manifest file rather than the id inside the scene source, ids
  are minted unique, and projects carrying duplicates heal themselves on load.
- Billboarded 3D chart labels render again, and 3D bar value labels anchor off
  the mark end.
- Image posters keep their alpha, titles recentre under a header icon, and
  wrapped bullet lines hang under their text.

## [0.11.0] - 2026-08-06

### Added

- Charts. Eight types (column, bar, line, area, their stacked variants and
  pie) render in 2D or lit 3D, as a hero scene, staged beside a device or in
  an overlay panel. Twelve appearance presets and nineteen build-in
  animations, colours drawn from the theme, data edited in the app or
  imported from CSV, and data changes keyframed on their own timeline lane
  so one chart can morph through several readings.
- Depth of field. Focus distance, range and blur strength are animatable
  camera pose fields in both camera modes, with autofocus holding the aimed
  subject sharp. Seven blur styles: plain depth, tilt-shift, soft diffusion,
  radial burst, directional swipe, split diopter and an anamorphic bokeh
  squeeze. Transitions and comparison sides carry their own focus.
- A beat lane above the timeline for projects with a soundtrack: waveform,
  beat grid and detected key moments, with a right-click to drop a camera
  keyframe on a beat or sync a whole scene's camera to the music. Markers can
  be dragged and travel with the project. It guides authoring only, and the
  export path never reads it.
- Line spacing sliders for titles and subtitles, and multi-line titles that
  cascade from measured heights instead of a fixed step.

### Changed

- New scenes inherit the last background applied everywhere, and device
  scene kinds scaffold with closer camera poses.
- The inspector follows the playhead: the open drill stays open and its text
  stays current as scenes change.

### Fixed

- The four opaque scene3d backgrounds render again. Their backing quad was
  painting over every opaque look, because render order was stamped on the
  group rather than on the renderables inside it.
- Cmd-Z reaches the app's undo unless a field is mid-edit, success toasts
  dismiss themselves, and clicking a timeline menu no longer scrubs.

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
