# Variant lab

For template authoring in this repo: write variants of a bundled project's scenes into a
git-ignored dev fixture, render their stills in one autorun, and tile them as one labelled
sheet. Users' projects have `./kb try` for sidecar variants of one scene; the lab also takes
new TSX, generated camera rigs and several base scenes in one run.

## Round trip

```bash
python3 -I tools/variant-lab/lab.py unveil floor.py
pnpm kookaburra:run --action stills --project lab-unveil --stills png --size 720p
python3 -I tools/variant-lab/sheet.py lab-unveil "<the zip it printed>"
```

Keep variants files in your scratchpad, never in the repo.

## A variants file

```python
def variants(lab):
    return {
        f"r{round(r * 100):02d}": {
            "from": "reveal",
            "set": {"backdrop.roughness": r},
            "marks": [9000],
            "label": f"roughness {r}",
        }
        for r in (0.12, 0.25, 0.35, 0.5)
    }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `from` | the stem | Base scene: its TSX, sidecar, length and effects |
| `doc` | the base sidecar | A whole sidecar instead |
| `patch` | none | JSON merge patch over the sidecar (`kb doc merge` rules) |
| `set` | none | `{ "dotted.path.0": value }`, applied after `patch` |
| `tsx` | the base TSX | TSX source; its `defineScene` id is rewritten to `lab-<stem>` |
| `durationMs` | the base entry | Scene length |
| `marks` | none | Stills, scene-local ms; none gives the automatic still |
| `label` | the stem | The tile's label |

Module constants: `RENDER = {...}` merges into the project's `render` block; `AUDIO = True`
keeps the soundtrack.

The `lab` argument: `lab.stem("reveal")` finds a scene by stem, by stem without its number or
by sidecar name, never by position, so a renumber never breaks a variants file. `lab.doc(name)`,
`lab.tsx(name)`, `lab.entry(name)` and `lab.project` are copies of the base; `lab.merge` and
`lab.set` edit a doc.

## What it handles

- `fixtures/lab-<base>/` is dev-only (never bundled) and git-ignored. Each run rewrites it,
  and refuses a folder without the lab's `lab.json`.
- Lab scenes start at other bars, so a key's musical `at` goes and its `tMs` stays; any other
  musical position is named for you to replace with ms.
- Camera-key still marks go, so the pages are your `marks` and nothing else.
- Assets are linked from the base project or `projects/_samples/`.
- Porting the winner is yours: an ordinary edit to the template's sidecar, then the gates.
