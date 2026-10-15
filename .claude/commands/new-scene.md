---
description: Insert a saved Kookaburra Cut scene preset and apply requested edits
argument-hint: <project> <scene-name> [preset-slug]
---

Create a scene in project `$1` named `$2`, starting from preset `$3`.

Use the `kookaburra-scene-authoring` skill. Run kb from the project folder: a workspace
project is `~/Kookaburra Cut/$1`, a bundled one is `projects/$1` in this repo. From the
repo, kb is `python3 .agents/skills/kookaburra-scene-authoring/scripts/kb.py`; inside a
project it is `python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py`.
Below, `kb X` means that command run from the project folder (`cd` there in the same
command).

1. `kb status` and `kb scenes`. Fix any load error first.
2. Pick the preset: `$3` when given, else the best match from `kb presets` (name, tagline,
   tags); `title` when nothing specific was asked. `kb presets show <slug>` shows what it
   contains and a preview image to Read.
3. `kb checkpoint "before adding $2"`.
4. `kb scene add <kebab-name> --preset <slug> --name "$2" --after <current stem>` (kb
   numbers the stem; without `--after` or `--at N` the scene goes at the end). kb inserts through
   the app's own preset copy when the app is open (assets copied and renamed on
   collision, stem and `defineScene` id minted, the project's default transition
   seeded), else from the app bundle. Never copy preset files by hand.
5. Apply only the requested edits, sidecar first (`kb doc <stem> set ...`). Preserve the
   preset's managed text keys, devices, chart data and media that are not being changed.
   Touch the TSX only for composition the sidecar cannot express.
6. `kb check --app`, then `kb capture --scene <stem> --at <seconds>` in a landscape and a
   portrait aspect (`--aspect 16:9`, `--aspect 9:16`) and Read the PNGs. Fix and repeat
   until both look right.
7. Report what was added and where, in plain words. If anything still fails, `kb undo`.

To change the reusable original, edit the preset itself in the app (Welcome, Presets);
an inserted scene is an independent copy.
