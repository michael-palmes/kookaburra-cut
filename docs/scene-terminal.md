# Terminal scene content

A **terminal** is singleton scene content (sidecar `terminal` block): a styled
terminal window drawn as a screen-locked panel over the composited slide. It is
a picture of a terminal, not a terminal: the author writes a text transcript, the
editor lays it out and bakes a PNG, and preview, Present and export all show that
PNG. The app starts no shell (docs/decisions.md, "Embedded terminal removed").

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Placement | Screen-space panel (frame-panel pass, base pose) | Overlay/frame family: always camera-facing, transitions slide it with the scene. A future `mount` field keeps room for world-space. |
| Authoring source | `transcript`: plain text with ANSI SGR colours | Nothing runs, so nothing on the Mac is exposed; a person or an agent can write it directly, and it stays diffable. |
| Snapshot | Styled cell grid in the sidecar + baked PNG in `assets/terminal-<stem>.png` | The PNG is the export truth (the emoji raster-cache philosophy); theme, font or grid edits re-bake from the stored grid. |
| Unbaked export | Themed empty frame (block cursor at home), or the old PNG for a stale transcript, with a pre-export warning | Never a hard block: an empty prompt is a legitimate slide. |

Confirmed defaults: one terminal per scene, theme preset catalogue
(`match-theme` + graphite/abyss/phosphor/amber/paper, each a full ANSI 16),
`mac` or `bare` chrome.

## The block

```jsonc
"terminal": {
  "theme": "phosphor",             // preset id, default "match-theme"
  "chrome": { "style": "mac", "title": "deploy" },
  "cols": 80, "rows": 24,          // logical grid, NEVER derived from the projected rect
  "fontPx": 13,                    // raster density, never panel geometry
  "transcript": "$ pnpm test\n",    // the authoring source; the app derives snapshot from it
  "position": [0, 0],              // frame-relative centre, -1..1 (decoration convention)
  "size": 0.55,                    // window width as a fraction of the frame width
  "snapshot": {
    "grid": [[["$ pnpm test", 2]]], // rows of styled runs [text, fg?, bg?, flags]
    "cursor": { "col": 0, "row": 1 },
    "src": "assets/terminal-01-intro.png",
    "transcript": "$ pnpm test\n"   // what this grid came from; absent on an old captured grid
  }
}
```

Parse/resolve/layout live in `src/engine/sceneTerminal.ts` (degrade-not-throw
per field, the chart pattern). `sceneTerminalLayout` is the single geometry
source (window, title bar, screen, grid rect, cell metrics) shared by the
renderer, the gizmo and the raster, so they cannot drift. The
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

## Transcript and bake

`layoutTranscript` (`sceneTerminalTranscript.ts`, pure) lays the transcript out
with terminal semantics: wrap at `cols` (deferred, so a line of exactly `cols`
does not wrap), keep the last `rows`, the cursor after the last character. `\r`,
`\b` and tab stops behave as in a terminal. ANSI SGR is honoured: the 16, 256 and
truecolour forms, bold, dim, italic, underline and inverse. The text forms `\e[`,
`\x1b[`, `\033[` and `\u001b[` count as ESC, so a colour can be typed by hand.
Every other escape sequence and control, format and combining character is
dropped, so a transcript can't move the cursor or reach past the grid.

`reconcileTerminalBakes` (`sceneTerminalBaker.ts`) keeps the PNG in step with the
sidecar. It runs off every project change in the main window, never during an
export or an autorun, and for workspace projects only:

- **A transcript newer than its snapshot** (`terminalSnapshotStale`:
  `snapshot.transcript` differs or there is no `src`) lays out, bakes, then writes
  the grid with no history entry. The edit that changed the transcript holds the
  one history entry, so undo can't get stuck re-deriving. This one path serves the
  inspector and agents alike, and a crash between the two just bakes again on the
  next open.
- **Anything else that changes the pixels** (an undo restoring an older grid, a
  theme, font or grid-size edit, a re-theme of `match-theme`) re-bakes the PNG alone.
  The baker remembers each scene's last print per session.
- **The first sight of a settled snapshot** leaves its PNG alone, so opening a
  project never rewrites one. An old captured grid keeps its PNG until someone
  changes it. With the app closed, an agent that changes `theme`, `cols`, `rows` or
  `fontPx` removes `snapshot` so the next open bakes.

Bake (`sceneTerminalRaster.ts` + `sceneTerminalBake.ts`) draws the grid on an
offscreen 2D canvas at 2x and lands the PNG via the Rust
`write_terminal_snapshot` command: fixed-name overwrite at
`assets/terminal-<stem>.png`, temp-then-rename (the app-icon rule, because
`import_media_bytes` collision-suffixes). Re-bakes re-read the asset revisions
(`noteAssetWritten`), so mounted textures re-fetch at a new URL. Baking happens
only at author time: export and preview never rasterise.

`startCommand` and `startPath`, from when a terminal scene ran a shell, are ignored:
the parser notes them and drops them, so the next sidecar write loses them.

## Shared projects

A terminal block travels in `.kbpack` projects like any sidecar data, its text no
different from scene copy: drawing it runs nothing. The export picker warns that
terminal content travels with the pack, since a transcript or an old captured
snapshot can hold whatever was on someone's screen.

## Editing

The inspector's `terminal.edit` drill owns the transcript, theme, chrome + title
and grid fields. `TerminalGizmo`
(panel-space `Gizmo2D`) moves and resizes the window, writing
`position`/`size`. UI selection lives in `terminalEditStore`, which the export
preamble clears (the gizmo-guard rule). Export pre-flight warns per scene when a
terminal has no snapshot or its transcript is newer, and so does `kb check`.
