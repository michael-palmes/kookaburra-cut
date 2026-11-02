# Brands

A brand gives a project safe defaults and guidance (a theme, fonts, a colour set, imagery
and a voice), never hard rules. Scenes may depart from it when the brief needs to. There is
no brand builder UI: the stamped `kookaburra-brand-packs` skill builds brands from a brand
folder and guidelines PDF.

## On disk

```
<workspace>/brands/<slug>/          id ws:<slug>
  brand.json                        manifest, the pack marker
  guidelines.md                     agent-ready guidelines
  images/<category>/[<sub>/...]     png, jpg, webp (sanitised svg originals beside their PNGs)
  library.json                      tags, surfaces, light and dark pairs (built by brand.py)
  scene/<same path as images/>      size-limited copies of images larger than a scene needs
```

The brand's themes, fonts and gradients stay where the app already keeps them
(`themes/<slug>/`, `fonts/` + `fonts.json`, `gradients/<slug>.json`); `brand.json` lists
them, so they resolve everywhere and travel in packs as their own kinds.

`brand.json` v1: `version`, `name` (required), `description`, `guidelines` (default
`guidelines.md`), `themes` (theme ids), `defaultTheme`, `typography`
(`{ headline, body }` as `Family@weight`), `fonts` (`[{ family, weight }]`), `colors`
(`[{ name, hex, role?, note? }]`, role `primary`, `accent`, `neutral` or `tint`) and
`gradients` (workspace gradient slugs). Every field but `version` and `name` is optional
and parsed leniently. The skill's SKILL.md has a full example.

`library.json` v1: `version`, `sceneEdge` and `images`, keyed by path relative to `images/`,
each `{ tags?, surface?, pair?, width, height, scene? }`. `surface` (`on-light` or `on-dark`)
is measured from a cut-out's ink, and read from its name only when the pixels don't say or
the picture is opaque. `pair` is the same artwork for the other background, matched by name
with words like `white`, `black`, `on-dark` and `dark` set aside. `scene` is the copy under
`scene/`. It is a cache plus the tags people added, so a brand without one still lists and
searches by name, and every entry is read leniently and confined to the brand's own folders
(`kblib/brandlib.py`), since a brand can arrive in a pack.

## In a project

- `project.json` `"brand": "ws:<slug>"` opts in. Rust keeps the manifest as raw JSON, so
  the key survives every native writer.
- The inspector's Project tab has a Brand row (between Scenes and Theme) opening
  `src/ui/inspector/BrandDrill.tsx`: None plus a card per workspace brand. Picking runs
  `set_project_brand` (`src-tauri/src/brands.rs`), which writes the key, switches
  `themeId` to `defaultTheme`, sets `typography.headline` and `body` (other slots kept)
  and copies `guidelines.md` to `<project>/BRAND.md`, then reloads like a theme change.
  Clearing removes the key and `BRAND.md` and leaves the theme and fonts alone.
  Re-picking refreshes `BRAND.md`. One Undo reverts the manifest change; `BRAND.md` is
  outside undo history, and re-picking repairs it.
- The media browser's Library tab gains a "Screenshots | <brand>" toggle when the open
  project's brand has images: category chips, then a grid of shared 640px posters
  (`brand_image_meta`, generated one at a time for the visible category). Picking copies
  into `assets/` like a global screenshot, taking the `scene/` copy when an image has one
  (`brands.rs` `scene_copy`); projects never reference the brand folder.
- The colour picker shows a Brand section (the brand's `colors`, tooltips with their
  notes) after Theme. Brand gradients are ordinary workspace gradients.
- `src/engine/brands.ts` holds the types, invoke wrappers and the open project's brand
  store that the Library and colour picker read.
- A brand never restyles the app chrome (docs/design.md).

## The agent kit

- RULES.md rule 13 and the scene skill's Brand section: read `BRAND.md` before designing,
  treat it as defaults and guidance, and say what was bent and why.
- `kb status` and `kb context` print a Brand line (`overview.py` `brand_line`): the
  project's brand, with a pointer to `kb brand icons` when it has images, or, for an
  unbranded project, the installed brands with a pointer to `kb brand use`. `kb status
  --json` carries `brand` and `brandImages` (counts by folder).
- `kb brand list | show | use NAME | clear | icons` (`kblib/brands.py`): `use` matches the
  user's words to an installed brand and writes what the picker writes, so "use the Acme
  brand" becomes one command. `icons` finds pictures by name, tag or path (the icon-like
  folders first; `--all`, `--category`) and `--sheet` writes contact sheets to look at, so
  the right icon is found by eye. `kb check` warns when the brand is missing or `BRAND.md` is.
- The managed permissions allow `Read(~/Kookaburra Cut/brands/**)`.
- `kookaburra-brand-packs` (`scripts/brand.py`, stdlib): `list`, `scan`, `init`, `fonts`,
  `images`, `library`, `tag`, `gradient`, `check`, `apply` (which runs the project's `kb
  brand use`, so the apply rules live in Rust and kb only). `images` holds a brand to what
  `kb assets add` holds a project to (no links followed, credentials refused, real formats,
  sRGB and upright, no blanks, sanitised SVGs) by importing `kblib`, so the skill needs the
  scene skill beside it, which every stamp provides. `pdf.js` and `svg2png.js` run under
  `osascript -l JavaScript`, so PDF pages and SVG icons need no installs. Its tests live
  in the scene skill's suite (`test_brand_pack.py`, `test_brand_library.py`), which keeps
  them out of projects.

## Packs

Brands are a `.kbpack` item kind (docs/packs.md): `payload/brands/<slug>/`, installed to
`brands/<slug>/`, requiring their themes, fonts and gradients, with `library.json` and
`scene/` as ordinary files of the brand. A project whose `project.json` names a brand pulls
it in, and a keep-both rename rewrites the reference.
