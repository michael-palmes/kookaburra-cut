# Exports, film checks and the flash gate

Captures check a frame (reference/captures.md); these check the film. Export only when the
user asks for a film, or for `./kb verify --film` (a draft), never as a habit: a 4K export of
a long project can take most of an hour. To check flashes while designing, use the ranged
check below: it takes seconds a scene and needs no export.

## Making the film: `./kb export`

`./kb export` makes the film exactly as the app's Export button does (same encode, same
file name, into `exports/`), while an overlay in the editor reads "Claude is exporting" with
the user's own Cancel.

```
./kb export                                   High quality, the editor's aspect, the app's poster setting
./kb export --aspect 9:16 --preset tiktok     a platform preset (./kb catalog exportPresets)
./kb export --fps 30 --short-edge 1080        the Custom panel (30 or 60 fps; 1440, 1080 or 720)
./kb export --verify --poster-frame off       render twice and compare (refuses VideoToolbox presets)
./kb export --headless                        the app closed: a packaged release build renders it
```

- Only the project open in the editor exports. On the Welcome screen or another project it
  exits 2 (`not-open`, `wrong-project`): ask the user to open this project.
- While the user is mid-edit (a pointer down, a text field focused), the Export window is open
  or another export runs, the app answers busy; kb retries for 30 s, then exits 3 (`app-busy`).
- It prints a progress line per stage and every `--progress-every` seconds (10), ending
  `kb export: done exports/<name>.mp4 sha256 ...`. Run it with Bash `run_in_background` and
  read the output when it finishes. Ctrl-C or `--timeout` (3600 s) cancels it.
- `--headless` needs the app closed and a project the user has opened since its code
  changed (else exit 2, `needs-trust`); it takes no `--fps` or `--short-edge`.
- Editing during an export is safe: the film renders the project as the editor loaded it when
  kb started (its first note says so), and edits you save meanwhile land in the next export. If
  a source changed, the answer warns and lists it in `staleSources`: rerun to include it.
- If it fails with `app-reloaded` (exit 2) the editor's page died under the export, usually for
  memory, and the error names the frame, scene and render rate. Don't change the project to
  work around it and don't rerun as is: ask the user to quit and reopen Kookaburra Cut, then
  rerun. `exports/<name>.health.json` keeps the details; `./kb status` shows the editor's memory
  and says when it has reloaded (any reload means restart before a long export).
- Every export saves a record kb reads back, so `./kb verify-export` knows what was asked for.
- Never record a baseline or compare hashes from `./kb export` against the app's own: a
  headless run and the editor may differ at glyph edges.

## Checking while you design

```
./kb check film --scene 04-flythrough        flashes over one scene (and a second either side): seconds, no export
./kb check film --range bar:13-16            flashes over bars 13 to 16 (also 12-20, 00:12-00:20, bar:13..cue:drop)
./kb preview --range bar:13-16               a 480 px, 12 fps clip of the span plus a sheet to Read (--gif for a GIF)
./kb verify --quick                          static, app, captures, safe areas, handoffs: no flash check
./kb verify --scene 04-flythrough            all of it for one scene, flashes included (a ranged check)
./kb verify                                  all of it, flashes over the whole film
./kb verify --formats                        first and last frames in every aspect in formats, and text past each safe area
./kb verify --last                           the last verdict, exiting with its code
```

- The ranged check renders the span in the running app at 360p and 30 fps through the export
  path and runs the export's own flash detector. The editor stays usable. Check each bright
  or fast moment as you make it (fly-throughs, flashes of white, cuts on the beat); polishing
  is no reason to skip it.
- `./kb verify` checks the newest export when it is current, else runs the ranged check over
  the film, and reuses that while nothing changed. `--quick` is for iterating only: its
  summary says flashes were NOT checked, so never call the work done on it.
- Exit codes are honest: 0 only when every step ran clean; 2 means a step could not run
  (`NOT CHECKED`: no app, or an app too old), so the work is not verified. A run piped
  through `tail` or left in the background reports the pipe's status, not verify's: read
  `./kb verify --last` instead.
- `safe-areas` warns once per key and aspect when text crosses the safe area, naming the
  edge and how far (`9:16 03-pricing: text.title crosses the safe area (right by 2.1%)`).

## Checking the film

```
./kb verify-export exports/<name>.mp4               size, rate, frames, audio, loudness, flashes, swatches, a contact sheet
./kb verify-export exports/<name>.mp4 --loudness-target -14
./kb check film --file exports/<name>.mp4           flashes, colour, handoffs and pacing on the real film
./kb check film pacing                              static: words per second, long still stretches, very short scenes
./kb verify --film                                  a 720p 30 fps draft (kept in .kb/verify/, never exports/), then every film check on it
./kb sync-check exports/<name>.mp4                  each cut against its nearest beat, in ms (--bpm N [--offset MS] without music)
```

- `verify-export` compares the file with what the project asked for (the export record,
  else the project: aspect from the name, size, 60 fps for High quality, frame count,
  soundtrack), then Read its contact sheet of each scene's first, settled, named and last
  frames. Exit 1 on any mismatch.
- `check film handoffs` shows each seam's two sides with the luminance step; a hard step
  next to a scene under a second warns, and four such cuts inside one second warn as a strobe.
  The film's last scene never counts as short: the end holds.
- `check film colour` warns when effects tone-map flat colours (reference/gotchas.md). It
  reads corners at each scene's settled moment, and skips a corner a device covers.
- `check film pacing` counts only words above label size (card labels and eyebrows are left
  out), aims for about 3 a second (and reports words per beat with a beat grid), and flags
  stretches over 6 s with no motion: keyed moves or TSX animation, or with `--file` frame
  differences on the film.
- `sync-check` times cuts and big picture changes as a player shows them, poster frame
  taken off. 0 to one frame late (33 ms at 30 fps, 17 at 60) is the frame grid: a cut on a
  beat shows on the first frame at or after it. Never nudge the beat grid to close that; a
  median beyond it (verdict `late` or `early`) means the cuts are off the beat.

## The flash gate

Every export runs a flash detector (WCAG 2.3.1 and ITU-R BT.1702, approximate): more than
three flashes in any second, over a large enough area, fails.

- `./kb export`, `./kb verify-export` and `./kb check film` exit 1 with kind `flashes` on a
  failure, and `./kb verify` fails its flashes step. An export is kept, with the report
  beside it as `<file>.flashes.json`, listing each moment's time, scene and area.
- Each flagged moment gets a strip: the frames before, at and after it side by side, the
  changing region boxed (`<file>.flashes/strip-01-00m35.233s.png` beside a film, or in
  `.kb/flashes/<time>/` for a ranged check). The report lines end `Read <strip>`: Read it
  instead of pulling frames with ffmpeg.
- Fix the flagged moments: hold each state at least 334 ms, keep the luminance change under
  10%, or soften the cut with a transition. Then rerun the same ranged check, not a full
  export.
- A WARNING the user has looked at can be accepted with their reason, and later checks show
  it as accepted instead of repeating it:
  `./kb flashes accept 00:35.4 --why "a slow logo glint, checked by eye"` (`./kb flashes`
  lists them, `./kb flashes forget 00:35.4` drops one). A FAILURE can never be accepted.
- `--allow-flashes` reports without failing. Pass it only after the user has seen the
  flagged moments and accepted them.
