# Kookaburra Cut project rules

This folder is a Kookaburra Cut video project. The app renders, previews and exports it;
you edit files and the app shows the result. Load the `kookaburra-scene-authoring` skill
before any edit or any answer about what is on screen.

`kb` below means `python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py`,
run from this folder.

## Safety protocol

1. `kb status` first; fix any load error it lists before other work.
2. `kb checkpoint "<what>"` before editing; `kb undo` rolls back.
3. Edit only `project.json`, `scenes/` and `assets/`. Never touch `exports/`, `edits/`,
   `.kookaburra*` or `.claude/skills/`.
4. Prefer `kb` for structure: `kb scene ...` for order, duration and transitions,
   `kb doc ...` for sidecars, `kb assets add` for media. Start new scenes from a preset.
5. After editing: `kb check --app`, then `kb capture` and Read the PNGs. Check a
   portrait aspect too when layout changed.
6. Never end a turn with the project failing to load: fix it or `kb undo`.
7. Fonts outside the bundled set need `kb fonts check` first; a failing face silently
   falls back to the theme font.
8. No dev servers, installs or build commands. There is nothing to run here.

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
