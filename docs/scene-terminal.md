# Terminal scene content

A **terminal** is singleton scene content (sidecar `terminal` block): a styled
terminal window drawn as a screen-locked panel over the composited slide. It is
live and typeable in the editor preview and in Present slideshows, while video
export renders a captured snapshot, so the deterministic pipeline never sees a
process or the DOM.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Placement | Screen-space panel (frame-panel pass, base pose) | Overlay/frame family: always camera-facing, transitions slide it with the scene. A future `mount` field keeps room for world-space. |
| Snapshot | Styled cell grid in the sidecar + baked PNG in `assets/terminal-<stem>.png` | The PNG is the export truth (the emoji raster-cache philosophy); theme, font or grid edits re-bake from the stored grid without recapturing. |
| Start command | Pre-typed only, never auto-run | A `.kbpack` auto-running shell on slide view would be arbitrary code execution (docs/decisions.md). |
| Focus | Click to focus, blur = outside click or Shift+Esc | Plain Esc belongs to the shell (vim, Claude Code), and Present's Escape closes the window. |
| Uncaptured export | Themed empty frame (block cursor at home) with a pre-export warning | Never a hard block: an empty prompt is a legitimate slide. |

Confirmed defaults: one terminal per scene, theme preset catalogue
(`match-theme` + graphite/abyss/phosphor/amber/paper, each a full ANSI 16),
`mac` or `bare` chrome.

## The block

```jsonc
"terminal": {
  "theme": "phosphor",             // preset id, default "match-theme"
  "chrome": { "style": "mac", "title": "deploy" },
  "cols": 80, "rows": 24,          // logical grid, NEVER derived from the projected rect
  "fontPx": 13,                    // raster density + overlay type size, never panel geometry
  "startPath": "~/repo",           // session cwd; default: the workspace project folder
  "startCommand": "pnpm test",     // pre-typed onto the prompt, never run
  "position": [0, 0],              // frame-relative centre, -1..1 (decoration convention)
  "size": 0.55,                    // window width as a fraction of the frame width
  "snapshot": {
    "grid": [[["$ pnpm test", 2]]], // rows of styled runs [text, fg?, bg?, flags]
    "cursor": { "col": 0, "row": 1 },
    "src": "assets/terminal-01-intro.png"
  }
}
```

Parse/resolve/layout live in `src/engine/sceneTerminal.ts` (degrade-not-throw
per field, the chart pattern). `sceneTerminalLayout` is the single geometry
source (window, title bar, screen, grid rect, cell metrics) shared by the
renderer, the gizmo, the DOM overlays and the raster, so they cannot drift. The
cell contract is 0.6/1.35 em of `fontPx`. Grid colours are ANSI index (0-255)
or `#rrggbb`; flags are a bitfield (bold 1, italic 2, underline 4, dim 8,
inverse 16).

## Rendering

`SceneTerminalPanel` (`src/engine/`) draws the chrome as WebGL primitives
(card-mask rounded body, traffic lights, troika title) and the snapshot PNG as
a texture on the screen plane; with no snapshot it draws the themed empty frame
with a block cursor at home. Chrome is never baked into the PNG, so it
restyles live and the PNG stays pure cell pixels (transparent default
background, the screen colour shows through). It mounts through the
generalised `FramePanel` (frame OR terminal) and rides the compositor's panel
pass; unframed scenes draw through three explicit no-plan panel draws (solo +
transition A/B). Colour presets resolve in `src/engine/sceneTerminalTheme.ts`;
`match-theme` derives the surface + ANSI 16 from the scene theme's tokens.

## Capture and bake

Capture (`sceneTerminalCapture.ts`) serialises the live xterm viewport into
the styled-run grid, colours stored mode-faithful (palette index, hex, or null
for the theme default) so a later re-theme re-colours rather than stales.
Bake (`sceneTerminalRaster.ts` + `sceneTerminalBake.ts`) draws the grid on an
offscreen 2D canvas at 2x and lands the PNG via the Rust
`write_terminal_snapshot` command: fixed-name overwrite at
`assets/terminal-<stem>.png`, temp-then-rename (the app-icon rule, because
`import_media_bytes` collision-suffixes). Recaptures bump `assetVersionStore`
so mounted textures re-fetch. Capture happens only at author time: export and
preview never rasterise.

## Sessions: the three realms

One PTY registry idiom, three hosts. Sessions are keyed `${slug}#${sceneStem}`
(`src/engine/sceneTerminalSession.ts`), survive component unmount like the
rail's, run at the LOGICAL cols x rows (no fit addon, the overlay scales
visually), and pre-type `startCommand` onto the prompt. That command is reduced
to a single line with control chars stripped (`sanitizeStartCommand`, at parse
and again at the paste boundary), so an imported pack's newline can never reach
the shell as Enter and auto-run: the "never auto-runs" guarantee does not rest
on bracketed-paste timing.

1. **Export**: no sessions, no DOM. The panel renders the baked PNG or the
   empty frame.
2. **Editor** (`src/ui/SceneTerminalOverlay.tsx`): a DOM xterm positioned over
   the panel's grid rect, paused-playback only, with a Start/Restart chip.
   Click focuses; blur (outside click or Shift+Esc) and scene-leave
   auto-capture through the baker into one history entry. Sidecar edits
   re-theme and resize the running session. `pty_spawn` takes
   `allowExternalCwd` for scene terminals (F-006 opt-out: `~` expands
   Rust-side, the path must resolve to a real directory).
3. **Present** (`src/present/PresentTerminalOverlay.tsx`): a separate webview,
   so it spawns fresh sessions per presentation run on the scene's `entering`
   phase (the pre-typed command sits on the prompt by the hold). Revisited
   slides re-adopt their session. No capture in Present, deliberately. Rust
   tags each PTY with its owner window and kills present-owned sessions on the
   window's Destroyed event; the editor's follow the rail's live-until-app-exit
   posture.

## Present focus contract

`presentStore.terminalFocused` stands the deck down while typing:

- Click on the terminal focuses and never advances (stopPropagation).
- While focused every deck key stands down (Escape included: shells need it)
  and the cursor auto-hide is suppressed; Space types instead of advancing.
- Shift+Esc hands the keyboard back; an outside click blurs in the capture
  phase so it cannot double as an advance (the next outside click advances).
- A failed spawn (a pack-imported `startPath` missing on this machine) leaves
  the baked snapshot showing, never an error card.

## Shared projects

A terminal block travels in `.kbpack` projects like any sidecar data, so the
author of a shared file chooses the command and the start path. Three layers
keep that safe: the command is sanitised to one line at parse and at the paste
boundary (above), no session exists until the user opens the project through
the F-001 trust gate, and the import summary lists every pre-typed command and
custom start path read from the landed sidecars
(`src/packs/import/terminalReview.ts`), so the user reviews the author's
commands before ever presenting. A start path alone executes nothing; a spawn
at a missing path surfaces on the Start chip in the editor and silently leaves
the snapshot in Present.

## Editing

The inspector's `terminal.edit` drill owns theme, chrome + title, grid fields,
start path/command, Start/Restart and Capture snapshot. `TerminalGizmo`
(panel-space `Gizmo2D`) moves and resizes the window, writing
`position`/`size`. UI selection lives in `terminalEditStore`, which the export
preamble clears (the gizmo-guard rule). Export pre-flight warns per scene when
a terminal has no captured snapshot.
