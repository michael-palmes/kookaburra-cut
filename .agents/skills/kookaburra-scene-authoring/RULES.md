# Kookaburra Cut project rules

This folder is a Kookaburra Cut video project. The app renders, previews and exports it;
you edit files and the app shows the result. Load the `kookaburra-scene-authoring` skill
before any edit or any answer about what is on screen.

`kb` below means `python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py`,
run from this folder.

## Safety protocol

1. Work in the project folder itself (`~/Kookaburra Cut/<slug>`), never a git worktree.
   The app only sees that folder, so nothing edited in a worktree previews, captures or
   exports. If the path contains `.claude/worktrees/` or `kb status` opens with STOP,
   edit nothing: tell the user and ask them to start a new session directly in the
   project folder with worktrees turned off.
2. `kb status` first; fix any load error it lists before other work.
3. `kb checkpoint "<what>"` before editing; `kb undo` rolls back. That is all the version
   control a project needs: never create branches, commits, stashes or worktrees by hand.
4. Edit only `project.json`, `scenes/` and `assets/`. `edits/` changes only through `kb video`
   (load kookaburra-video-editing). Never touch `exports/`, `.kookaburra*` or `.claude/skills/`.
   Videos are never re-encoded by hand; `kb video render` makes `assets/<name>-edited.mp4`.
5. Prefer `kb` for structure: `kb scene ...` for order, duration and transitions,
   `kb doc ...` for sidecars, `kb assets add` for media. Start new scenes from a preset.
6. After editing: `kb check --app`, then `kb capture` and Read the PNGs. Check a
   portrait aspect too when layout changed.
7. Never end a turn with the project failing to load: fix it or `kb undo`.
8. Fonts outside the bundled set need `kb fonts check` first; a failing face silently
   falls back to the theme font.
9. No dev servers, installs or build commands. There is nothing to run here.

## Live edits

- The app being open is normal. Saves reload within about 2 s.
- A broken scene shows as an error card ("This scene can't load") while the rest of
  the project opens; `kb status` names the file. Export refuses until it is fixed. Fix
  the file and it recovers on the next save.
- A failed reload keeps the last good project on screen under a banner; fix and save.
- Live status (load errors, font issues) comes from `kb status`, not memory.
- Never tell the user to close or reopen the app as a fix.

## Talking to the user

They are probably not technical. Say what changed on screen in plain words, and
mention when a frame was checked by capture.
