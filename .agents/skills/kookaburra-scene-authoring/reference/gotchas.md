# Gotchas

Things that bite real sessions, with the fix. Read the row before working around a
symptom another way. Rows marked "until a later update" describe current app behaviour
that a coming update changes; the fix here is the one that works today.

## The app, captures and other agents

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Workspace project not found ... Known projects: none` from a capture or check | Another app instance (an acceptance or dev build with its own workspace) used to answer the shared queue | kb now addresses the instance that serves this project's workspace, and `servedBy` in every answer names it. If you still see a "not found" or `no-app` error, read it (it names the root and the instances it found), run `./kb status` (every live instance, and why a passive one does not serve) and ask the user to open this project in the installed app |
| `GPU stalled` (exit 3) | A GPU-process timeout on a large readPixels while the machine is busy | The render window recycles itself and kb retries once on its own; while it restarts kb prints `the app is restarting its render window after a GPU stall (try N of 3)`, so just wait. On exit 3, wait `retryAfterMs` and rerun. `GPU wedged` (exit 2) means stop capturing and ask the user to quit and reopen Kookaburra Cut. Prevent it: keep the default 1280 px sheets, use `--scale 0.5`, fewer frames, one request at a time |
| A capture PNG has gone by the time you Read it | The app prunes its own responses | kb copies every capture into `.kb/captures/` and prints the copies' paths; the app keeps its originals 60 minutes. Read the paths kb prints, never `bridgePath` |
| A Bash `sed -i`, heredoc or Python write to a scene was never checked | Only Edit and Write used to trigger the check | The Bash hooks now check the scene files a command changed, after the fact. Still prefer Edit, Write or `./kb doc`: the Bash check only knows a file's earlier errors when the command names it, so a script's or glob's writes are judged without them |
| `kb undo` reverted another agent's work | A plain undo restores the whole project | A plain undo now refuses (`others-changed`) when another agent changed files since its target. Undo your own scene with `./kb undo --scene S`, and lease scenes you edit with `./kb lease S` |
| kb stored in a shell variable fails in zsh (`command not found`) | zsh does not split a variable into words | Run `./kb <command>` from the project folder, never through a variable or alias |
| Times from recording notes are seconds off the footage | Notes are written from memory, not from the file | Measure from decoded frames: `./kb video analyse NAME` (screen changes), then `./kb video frames NAME --at T` |
| `./kb status` leads with `DEV BUILD` | A development build serves this project; React dev builds use far more WebContent memory, so long sessions stall and reload | Ask the user to run the packaged app for long or multi-agent sessions |

## Media and timing

| Symptom | Cause | Fix |
| --- | --- | --- |
| A replaced image still shows the old one in the preview (captures show the new one) | The editor caches media by file name; captures load fresh (until a later update) | Add the new file under a new name and point the scene at it, or use the app's "Set as icon" |
| `./kb assets add` wrote `name-2.png` instead of replacing `name.png` | It never overwrites (until a later update adds a replace) | Point the scene at the new name with `./kb doc S set ...` |
| A screen in a variable-frame-rate screen recording appears early | ffmpeg decodes some VFR recordings out of order (until a later update) | Conform the recording to constant 60 fps first and cut from that copy, never from the original |
| A negative `media.startMs` jumps back to 0 | Editing the device in the inspector resets it (until a later update) | Trim the head off the video with `./kb video trim NAME first --head T` instead |
| A device video freezes on its last frame | Device videos never loop, so a scene longer than its clip holds the last frame | Size the scene to the clip (`./kb assets probe` gives its length), or `./kb video fit NAME --scene S` or `./kb video hold` |
| A cut lands up to about 120 ms off the beat on a long track | The app's beat grid drifts on long tracks (until a later update) | Use the key moments from `./kb beats --scene S`, never raw grid beats |

## Text and themes

| Symptom | Cause | Fix |
| --- | --- | --- |
| A line fades word by word, or takes far longer than its `from`/`to` | A theme's `textAnimation.durationMs` overrides every TSX window, `spring-pop` forces word granularity, and a theme `staggerMs: 0` reads as absent (until a later update) | Put `staggerMs={0}` and `delivery="all-at-once"` on single-block lines; override per key in the sidecar's `textAnimationOverrides.<key>` without `durationMs`; leave `durationMs` out of themes unless every scene should obey it |
| A theme or lighting edit does nothing | Partial blocks are dropped silently: `shadow.technique: "none"` still needs every shadow field, gradients need `angleDeg` (until a later update) | Copy the whole block from `./kb theme show`, then change one value. Theme fonts are `{ "family", "weight" }`; project and sidecar fonts are `"Family@weight"` |
| Text in front of the screen plane looks larger and drifts outside the safe area | Content nearer the camera (z 0.3, say) projects larger (until a later update) | Lay text out at z 0, or divide its x and y by `5 / (5 - z)` (the camera sits at z 5) |
| A device's edge is tinted wrong after a mid-scene background change | A device keeps the lighting of the theme the scene starts with (until a later update) | Give the scene the background the device sits in, or copy that theme's `lighting` into the sidecar |

## Colour and light (how rendering works)

| Symptom | Cause | Fix |
| --- | --- | --- |
| A flat brand hex renders off (a light grey reads several steps darker) | Once any effect exists (a theme, scene or manifest vignette or bloom), every frame goes through one tone-map pass, `toneMapped={false}` surfaces and the clear colour included | For exact flat colour set `render.toneMapping` to `"linear"` in `project.json`, then capture a lit device frame to check it still looks right. `./kb check film colour` warns about this; `./kb capture --probe X,Y` reads the exact pixel |
| A translucent shadow or rule looks paler than its CSS spec | Blending happens in linear light | Tune by capture. Starting points: shadow opacity about 0.30 on light backgrounds, 0.42 on saturated ones; 0.78 for dashed rules |
| White UI or white text glows in a dark scene | The default bloom threshold (0.82) sits below white | Set that scene's `effects.bloom.luminanceThreshold` to about 1.2 (its `project.json` entry, a hand edit), and push only the colour that should glow above 1 |

## Exports

| Symptom | Cause | Fix |
| --- | --- | --- |
| `./kb export` exits 2 (`not-open` or `wrong-project`) | It exports only the project open in the editor | Ask the user to open this project in Kookaburra Cut, then rerun |
| `./kb export` waits, then exits 3 (`app-busy`) | The user is editing, the Export window is open, or another export runs; a text field left focused in the editor keeps it busy until the user clicks away (until a later fix) | Ask the user to click away from the field or close the Export window, then rerun |
| `./kb export` or `./kb verify-export` exits 1 with kind `flashes` | The film flashes more than three times in a second somewhere; the file is kept, with the report beside it as `<file>.flashes.json` | Fix the flagged moments (hold each state at least 334 ms, or soften the change with a transition), or pass `--allow-flashes` only after checking them with the user |
