# CLAUDE.md — Gannet video project

This folder is a **Gannet** video project. The Gannet app renders, previews and
exports it — you edit the files here, and the app shows the result live. The
person you're helping is likely non-technical: explain what you changed in
plain language, not code terms.

## Layout

- `reel.json` — the ordered scene list (durations, transitions). Keep it valid JSON.
- `scenes/*.tsx` — one animated scene per file.
- `assets/` — the user's media (videos, images), referenced by relative path
  (e.g. `assets/recording.mp4`).
- `exports/`, `edits/`, `.gannet*` — owned by the Gannet app. Never edit these.

## Rules

1. Edit only `reel.json`, `scenes/`, and `assets/`.
2. Never run dev servers, package installs, or build commands — the Gannet app
   owns preview and export. There is nothing to "run" here.
3. Scene authoring follows the `gannet-scene-authoring` skill (auto-loaded from
   `.claude/skills/`): every scene is one `defineScene` default export; all
   motion derives from `useTimeline()` (never the wall clock or the DOM); text
   only via toolkit primitives; colours/type/motion via `useTheme()` tokens;
   layout against `useFormat()` so one scene serves 16:9, 9:16 and 1:1.
4. Reference assets by relative path from this folder. No absolute paths, no
   remote URLs.
5. Preview updates automatically when you save — tell the user to look at the
   Gannet window after a change.
