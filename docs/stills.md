# Stills

How Kookaburra Cut turns a project into stills: a **PDF handout** (one
full-bleed page per still) or **PNG images** (a zip of numbered PNGs plus
`pages.json`), built from the same page list. Every page is captured through the
deterministic export path, so a still shows exactly what the video shows at that
frame (or, for an automatic still, what Present holds on).

Read this before touching `src/engine/stills.ts`, `src/engine/stillPages.ts`,
`src/engine/stillsExport.ts`, `src/engine/stillText.ts`,
`src/engine/exportFrame.ts`, `src/engine/presentHold.ts`,
`src/engine/presentHoldPoint.ts`, `src/engine/presentTimingRegistry.ts` or
`src-tauri/src/stills/`.

## Pages

Each included scene gives either:

- **one automatic still** at its settled moment (below), or
- **its marked stills only**: camera keys flagged as stills and fixed times,
  several allowed. Marks replace the automatic still; they never add to it.

Excluded scenes give nothing (no page, no bookmark). Excluding every scene is
refused before Rust is touched.

## The sidecar

```jsonc
{
  "stills": {
    "exclude": true,            // leave this scene out of every stills export
    "marksMs": [2400, 5200]     // fixed stills, scene-local ms
  },
  "camera": {
    "keys": [
      { "id": "k3", "tMs": 3000, "pose": { /* … */ }, "still": true }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `stills` absent | Included, one automatic still. An empty block is dropped on parse, so absent stays the default |
| `stills.exclude` | Only `true` is kept. The marks stay on disk while a scene is left out |
| `stills.marksMs` | Whole, non-negative ms, unique, ascending (the parser rounds, de-dupes and sorts, dropping bad entries with a warning). A duration shrink clamps them (`clampDocTracksToDuration`) |
| `"still": true` | On a `camera.keys[]` or `cameraRig.keys[]` entry. Writers delete the field to unmark; `false` is never written |

`SCENE_DOC_VERSION` stays 1 and `parseSceneDoc` parses the block, so a UI write
never strips it.

**Active and dormant marks.** Only the camera block driving the scene counts
(`activeCameraBlock`, which mirrors `buildSceneCameraTracks`): none when
`animatedTrack` is `"layeredScreenshot"`, `cameraRig` when `cameraMode` is
`"rig"` and the rig has a valid key, else `camera`. Key marks on the other block
are dormant: kept, ignored and counted in a warning. A scene whose only marks
are dormant falls back to its automatic still.

**Key marks ride their key.** They follow drags, are deleted with the key (⌘Z
restores them), carry across orbit and rig conversion (`sceneRigConvert.ts`),
and survive scene duplicates (Rust renumbers key ids in place) and packs
(sidecars travel verbatim). Duplicate key and split build bare keys, so a mark is
never copied.

## The automatic still

`autoStillLocalMs` (`stillPages.ts`) picks the scene-local moment:

1. **Present's hold.** `derivePresentHold` (`presentHoldPoint.ts`, shared with
   `src/present`) over the scene's registered timings: the latest intro end plus
   150 ms, 400 ms with no timings, kept 100 ms short of the leave point.
   Registrations come from `AnimatedHeadline` (with its stagger spread),
   `AnimatedGroup`, `Device` intro motion, the frame decorations
   (`FrameDecoration`, `FrameChip`, `FrameSymbol`) and `AnimatedCounter`.
2. **The latest keyed or known end** (`sceneKnownEndMs`): the scene camera
   track's end (or the project camera's motion inside the scene when the scene
   has no track), the last key of `deviceTrack`, `compare.track`, `chart.track`,
   `layeredScreenshot.animation` (when it is the animated track) and the built
   lighting tracks (side A and comparison side B), the chart build-in's end, and
   media motion ends (`sceneMediaMotionEndMs`: image tilt-reveal 1000 ms and
   push-in 1200 ms, video window 900 and 1000 ms, or the authored `durationMs`;
   looping motions never count).
3. `settled = max(hold, known)`, capped at the earliest **authored** outro
   (`outAtMs`) but never below the hold. Present's default 600 ms leave runway is
   not a cap.
4. No timings and nothing keyed: the centre of the scene's clean window.

The moment snaps **up** onto the 60 fps grid. Inside the clean window (the
scene-local span where `resolveAt` shows this scene alone) the page is that
frame. When the settled moment falls past it, into the outgoing transition, the
page renders the **scene alone** at that moment (capped at its end), as Present
holds it, rather than clamping back to a frame where the intro or camera is still
moving. A scene with no clean frame at all also renders alone, with an
`empty-solo-window` warning.

**Match Present.** An automatic still renders with the scene held: held
primitives (`AnimatedHeadline`, `AnimatedGroup`, `LookText3D` and the frame
decorations, via `useHeldLocalMs`) freeze at the hold while raw time runs on to
the settled moment, so the camera, devices and charts land while text never
starts an outro. The exporter writes the hold map once per run
(`replaceSceneHolds`, one notify, a bumped version), waits for the canvas to
commit it (`awaitHoldsCommitted`), and clears it in `finally` before
`setExporting(false)`, so the preview never draws a held scene. Video exports
and captures refuse to start while holds are active (`assertNoSceneHolds`).

**Readiness.** Timings are snapshotted after the export preamble (every scene
mounted) and `awaitPresentTimingsSettled`: a staggered headline reports pending
(`reportPresentTimingPending`) until its first typeset spreads the units, and the
spin (text sync, then a macrotask) waits for zero pending, failing after 5000
spins.

## Marked stills

Marked stills are **raw frames**, WYSIWYG with the playhead: no holds. Each mark
rounds to the nearest 60 fps frame and is clamped into the clean window (a
clamped mark warns "sits in a transition"). A key mark beats a time mark on the
same frame, repeats collapse, and pages sort by frame. The plan is
`sceneStillsPlan` (pure, shared by the UI and the exporter); `planStillPages`
turns it into page records `{ sceneIndex, sceneName, kind, frame, tMs, sceneMs,
resolved, ordinal, sceneCount }`, the holds for automatic scenes, typed warnings
and one bookmark per scene.

## The capture

`exportStills` runs under `withExporting`, mirroring the video run's snapshot
and `finally` restore:

1. `exportPreamble` once, the canvas sized to the native format (a 2160 short
   edge for the standing aspects), and `buildFramePlans` once. No codec or encode spec, so the software clip lane
   pins.
2. Settle timings, plan pages, write holds, `start_stills_export`.
3. Per page, `renderFrameInto(rig, page.tMs, page.resolved, draws)`
   (`exportFrame.ts`): the video loop's per-frame body (clock flush, canvas
   commit, video frames, text sync, emoji, size guard, camera, state, lighting
   and compare plans, `renderComposited`, `readFrameOrThrow`). Page 1 draws
   twice and keeps the second; the rest draw once. The page always renders from
   `page.resolved`, never `resolveAt(tMs)`.
4. **The page stage** (`pageFromReadback`, `downscale.ts`): the one flip site.
   GL's bottom-up readback becomes top-down opaque RGBA at the page size: a
   row-flip copy at native size (byte-equal to the box filter at 1:1), else the
   deterministic box filter. The output buffer and the row scratch (about
   199 MB of Float64 at 4K) are allocated once per run. Rust never flips.
5. PDF: one reused canvas, `putImageData`, `toBlob("image/jpeg", 0.9)`, plus the
   text layer. PNG: the raw page RGBA, encoded in Rust.

| Size chip | Short edge |
| --- | --- |
| 4K | 2160 |
| 1080p (default) | 1080 |
| 720p | 720 |

Never upscaled: a format whose short edge is already smaller (Phone) keeps its
native size.

**The text layer** (`stillText.ts`, PDF only). `pageTextRoots` mirrors the
compositor's solo paths: the scene host (side A, full frame or through its
cutout), its frame panel (at the base camera pose) and the persistent layers.
`collectPageText` takes every troika mesh visible up to its root, on the camera's
layers, at an effective alpha of 0.05 or more (fill, stroke or outline times the
material's opacity), splits it into lines from troika's caret boxes, strips emoji
placeholders, NFC-normalises, projects each line box through a posed camera
clone and drops chromatic echoes. Lines stay grouped by root in that order
(host, panel, persistent layers), top to bottom then left to right within a
root (at most 4000 lines of 2000 characters), so a stream-order reader
(`pdftotext -raw`) reads a cutout's caption before the panel beside it. Preview
orders its copy by PDFKit's own layout analysis, which ignores stream order.
With nothing placed, the scene's registered strings go in unpositioned.

## Outputs

Both follow the video's destination rules (`resolve_export_output`):
`<project>-<aspect>.pdf` or `.zip` in the project's `exports/` folder (bundled
projects: `~/Kookaburra Cut/<project>/`), or Downloads when the setting says so,
with a Finder-style ` 2` de-dupe. Autoruns write into the run dir
(`destination: "autorun"`).

**PDF** (`pdf.rs`, `pdf_font.rs`): a hand-rolled streaming PDF 1.7 writer,
uncompressed, classic xref. Each page's `/DCTDecode` image, content stream and
page dictionary hit the disk as the page arrives; fonts, outlines, info, catalog,
page tree and xref wait for the finish.

| Part | Detail |
| --- | --- |
| Page size | Short edge 540 pt from the native format (16:9 is 960 × 540 pt), whatever the size chip |
| Bookmarks | One per scene, to its first page; a scene with several stills gets `m:ss.s` children (scene-local). Opens with `/PageMode /UseOutlines` |
| Text layer | Invisible (`3 Tr`) text in `KookaburraGlyphless`, a three-glyph CIDFontType2 generated in code (glyph 1 is empty, glyph 2 a zero-area diagonal). Identity-H, CIDs assigned in first-appearance order per document, `CIDToGIDMap` to glyph 1, a ToUnicode `bfchar` map (surrogate pairs beyond the BMP). A one-glyph line (a bullet, a chart's `4`) gets its own CID on glyph 2: PDFKit folds a lone outline-less glyph into the glyph before it, stretching that line's selection. Each line's `Tf` is its rect height and `Tz` stretches it to the rect width (`Stretch::Matrix` is kept as a switch) |
| Info | Title (project name), Author (the macOS full user name, left out when blank), Creator `Kookaburra Cut <version>`, Producer, creation and mod dates, `DisplayDocTitle` |
| `/ID` | The first 16 bytes of a SHA-256 over every page payload's digest and the title |
| Reproducible mode | Leaves out the author, dates and app version (autoruns only) |

**PNG images** (`pngzip.rs`): the `.kbpack` writer's zip settings, entries
0o644, a local-time stamp (1980-01-01 in reproducible mode).

| Part | Detail |
| --- | --- |
| Entries | `<base>/NN-<scene-slug>[-k].png`, stored. `NN` pads to `max(2, digits)`; the slug is ASCII lowercase, digits and single hyphens, at most 40 characters, falling back to `scene-N`; `-k` from a scene's second page. `<base>` is the output stem before any Downloads suffix, unless the start options name a `zipFolder` |
| Encode | The pinned Rust `png` crate (`=0.18.1`): RGB8 (the capture is opaque), an sRGB chunk, `Balanced`, `Adaptive`, on a blocking worker outside the lock |
| `pages.json` | Last, deflated: `{ version: 1, project, aspect, width, height, pages: [{ file, scene, sceneIndex, kind, sceneMs, globalMs }] }` |

## IPC

| Command | What it does |
| --- | --- |
| `start_stills_export` | Refuses while any export runs; validates (1 to 2000 pages, page edge at most 8192, title at most 4096 bytes, an optional `zipFolder` of at most 255 ASCII letters, digits, `-`, `_` or `@`); resolves the output; opens the hidden temp file `.<stem>.part.<ext>` beside it; returns the planned path |
| `push_still` | One page as a raw body. Headers: `x-kookaburra-still` (index), `-width`, `-height`, `-meta` (base64 JSON `{ sceneIndex, sceneName, kind, sceneMs, globalMs }`) and, PDF only, `-text-bytes`. Body: PDF `[JPEG][UTF-8 JSON text layer]`, PNG exactly `w × h × 4` top-down RGBA. Enforces page order and size, cross-checks the JPEG's SOI, frame header and EOI, and caps the text layer (8 MB, 4000 lines). Any failure clears the job and deletes the temp file |
| `finish_stills_export` | Once every planned page is in: finalises on a blocking worker, `sync_all`, hashes, renames the temp file onto the output, records `LastExport` (Show in Finder); returns `{ path, kind, pages, bytes, sha256, pageSha256[], zipFolder? }` |
| `cancel_stills_export` | Idempotent: drops a streaming job (and its temp file) or makes a finalising one unwind before the rename. Called on abort or any error, once on main-window boot (a WebContent reload mid-export leaves the job busy until then) and at autorun boot |

`ExportState` holds the video run and a separate stills slot. `start_export` and
`start_stills_export` each refuse while the other is busy, and video's push,
finish and cancel never reach the stills slot.

## Editor surfaces

| Surface | What it offers |
| --- | --- |
| Export modal | A pinned **Stills** row after Custom…, hidden only by a search it cannot answer. Format (PDF document, PNG images), aspect, size chips with the pixel size, a summary ("9 pages: 7 automatic, 2 marked · 1 scene left out"), warnings (dormant marks, marks in a transition; every scene left out disables Export). Format and size are remembered, and Stills is remembered as the last export like a preset |
| Inspector | The Scene overview's **Stills** row (Automatic, N marked, Left out) opens the Stills drill: Include in stills, one row per planned still (jump, remove, a clamped note), the dormant hint, Add still at playhead |
| Camera lane | The key menu's **Use as still** / **Remove still**, a badge above the diamond and "· Still" in its tooltip |
| Playback bar | Ticks for the marked stills of included scenes (hidden while exporting) |
| Scene menu | Leave out of stills / Include in stills, bulk aware, one undo entry |
| ⌘K | Export PDF…, Export PNG images…, Add still at playhead |
| File menu | Export PDF…, Export Images… (`kookaburra://export-stills`, opening the modal on the Stills row) |

The titlebar reads "Exporting PDF… NN%" or "Exporting images…", Cancel works as
for video, and the toast offers Show in Finder.

## Autorun

```bash
pnpm kookaburra:run --action stills --project showcase-tour --stills pdf
pnpm kookaburra:run --action stillsverify --project showcase-tour --stills png --size 720p
```

- `--stills pdf|png` (default `pdf`) and `--size 4k|1080p|720p` (default
  `1080p`) apply only to these two actions (anything else exits 2). The aspect
  defaults to 16:9 and `--project` takes a comma list.
- Runs write reproducibly into the run dir. Result rows carry `kind`, `path`,
  `pages`, `bytes`, `sha256`, `pagesHash`, `pageTimesMs` and any `warnings`.
- `stillsverify` runs two passes in one boot under one export hold. Pass B
  writes `<stem>-b` beside pass A's file, inside pass A's zip folder so a PNG
  zip still compares byte for byte (a PDF never embeds its file name), and the
  row adds `pathB`, `identical`, `pagesHashB`, `sha256B`, `fileIdentical`, and
  on a mismatch `divergentPages` and `firstDivergence` (page, differing 8 × 8
  tiles, text, meta, payload).
- The wrapper prints each output, then `pdfinfo` and page 1's `pdftotext` when
  poppler is installed, or `unzip -l` for a zip; pass B gets its path only.

The gate contract and baselines live in [determinism.md](./determinism.md),
"Stills export".

## Known gaps

- 3D extruded text is not troika, so it never reaches the text layer.
- Per-letter fades count as visible: the alpha filter reads mesh-level opacity,
  so a line part way through a per-unit reveal goes in whole.
- Text positions are approximate (caret boxes stretched by `Tz`): right for
  search, selection and copy, not for layout.
- A custom TSX animation that neither holds nor registers a timing can still be
  caught mid-move by an automatic still. Mark a still instead.
- WebKit's JPEG encoder is not pinned, so PDF determinism is defined on page
  RGBA, the text layer and page metadata, never on file bytes.
