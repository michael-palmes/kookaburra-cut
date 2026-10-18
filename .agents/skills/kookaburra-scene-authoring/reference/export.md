# Exports, film checks and the flash gate

Captures check a frame; these check the finished film. Export only when the user asks
for a film, or for `./kb verify --film` (a quick draft), never as a habit: a 4K export of a
long project can take most of an hour.

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
- Every export saves a record kb reads back, so `./kb verify-export` knows what was asked for.
- Never record a baseline or compare hashes from `./kb export` against the app's own: a
  headless run and the editor may differ at glyph edges.

## Checking the film

```
./kb verify-export exports/<name>.mp4               size, rate, frames, audio, loudness, flashes, swatches, a contact sheet
./kb verify-export exports/<name>.mp4 --loudness-target -14
./kb check film --file exports/<name>.mp4           flashes, colour, handoffs and pacing on the real film
./kb check film pacing                              static: words per second, long still stretches, very short scenes
./kb verify --film                                  a 720p 30 fps draft (kept in .kb/verify/, never exports/), then every film check on it
```

- `verify-export` compares the file with what the project asked for (the export record,
  else the project: aspect from the name, size, 60 fps for High quality, frame count,
  soundtrack), then Read its contact sheet of each scene's first, settled, named and last
  frames. Exit 1 on any mismatch.
- `check film handoffs` shows each seam's two sides with the luminance step; a hard step
  next to a scene under a second warns, and four such cuts inside one second warn as a strobe.
- `check film colour` warns when effects tone-map flat colours (reference/gotchas.md).
- `check film pacing` aims for about 3 words a second and flags stretches over 6 s with no
  keyed move.

## The flash gate

Every export runs a flash detector (WCAG 2.3.1 and ITU-R BT.1702, approximate): more than
three flashes in any second, over a large enough area, fails.

- `./kb export` and `./kb verify-export` exit 1 with kind `flashes` on a failure. The file
  is kept, with the report beside it as `<file>.flashes.json`, listing each moment's time,
  scene and area.
- Fix the flagged moments: hold each state at least 334 ms, keep the luminance change under
  10%, or soften the cut with a transition. Re-export and check again.
- `--allow-flashes` reports without failing. Pass it only after the user has seen the
  flagged moments and accepted them.
- `./kb verify` (no `--film`) checks the newest film in `exports/` only when it is newer than
  every source file; otherwise it says the film is stale and skips it.
