# Kookaburra Cut project rules

This folder is a Kookaburra Cut video project. The app renders, previews and exports it;
you edit files and the app shows the result. Load the `kookaburra-scene-authoring` skill
before any edit or any answer about what is on screen.

## Safety protocol

1. Work in the project folder itself, never a git worktree: the app only sees this folder.
   If the path contains `.claude/worktrees/` or `./kb status` opens with STOP, edit nothing
   and ask the user for a new session in the project folder with worktrees turned off.
2. Run kb as `./kb <command>` from this folder, never through a variable or alias.
3. `./kb status` first; fix any load error it lists before other work.
4. `./kb checkpoint "<what>"` before editing; `./kb undo` rolls back. That is all the version
   control a project needs: never create branches, commits, stashes or worktrees by hand.
5. Edit only `project.json`, `scenes/` and `assets/`, with Edit, Write or `./kb doc`, never
   sed, Python or heredocs. `edits/` changes only through `./kb video`. Never touch
   `exports/`, `.kookaburra*` or `.claude/skills/`, nor `.kb/` beyond your scratch folder
   `.kb/agents/<name>/`. Never re-encode videos by hand.
6. Structure through kb: `./kb scene ...`, `./kb doc ...`. Start new scenes from a preset.
7. Add recordings and other media with `./kb assets add <file>`, never by copying files into
   `assets/`: it conforms recordings that would play wrong, so use the path it prints.
8. After editing: `./kb check --app`, then `./kb capture` and Read the PNGs (a portrait
   aspect too when layout changed). Before calling the work done: `./kb verify`.
9. With no app running, kb checks are static only: ask the user to open the app, and never
   assume the preview matches the files.
10. Never end a turn with the project failing to load: fix it or `./kb undo`.
11. Fonts outside the bundled set need `./kb fonts check` first.
12. No dev servers, installs or build commands. There is nothing to run here.

## Exit codes and other agents

- Exit 3: wait `retryAfterMs` and rerun. Exit 1: fix what it names. Exit 2: tell the user.
- With other agents: pass `--agent <name>` to every kb command, `./kb lease <scene>` before
  editing it, and `--scene` on checkpoint and undo. Never edit a scene leased to someone
  else; leave them a `./kb note`.

## Gotchas that bite most (fixes in reference/gotchas.md)

1. Once any effect exists (vignette, bloom), every frame is tone-mapped: flat hexes shift.
2. A theme's `textAnimation.durationMs` overrides every TSX `from`/`to` window.
3. Partial theme blocks are dropped silently: copy whole blocks from `./kb theme show`.
4. Land music on the authored grid: `./kb song analyse --accept`, then `bar:` positions
   (an `at` on keys, `./kb capture --at bar:N`).

## Live edits

- The app being open is normal. Saves reload within about 2 s; live status (load errors,
  font issues) comes from `./kb status`, not memory.
- A broken scene shows as an error card while the rest opens, and export refuses until it is
  fixed. A failed reload keeps the last good project under a banner; fix and save.
- Never tell the user to close or reopen the app as a fix, unless kb reports GPU wedged.

## Talking to the user

They are probably not technical. Say what changed on screen in plain words, and
mention when a frame was checked by capture.
