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
  images/<category>/[<sub>/...]     png, jpg, webp (svg originals beside their PNGs)
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
  into `assets/` like a global screenshot; projects never reference the brand folder.
- The colour picker shows a Brand section (the brand's `colors`, tooltips with their
  notes) after Theme. Brand gradients are ordinary workspace gradients.
- `src/engine/brands.ts` holds the types, invoke wrappers and the open project's brand
  store that the Library and colour picker read.
- A brand never restyles the app chrome (docs/design.md).

## The agent kit

- RULES.md rule 13 and the scene skill's Brand section: read `BRAND.md` before designing,
  treat it as defaults and guidance, and say what was bent and why.
- `kb status` and `kb context` print a Brand line (`overview.py` `brand_line`): the
  project's brand, or, for an unbranded project, the installed brands with a pointer to
  `kb brand use`. `kb status --json` carries `brand`.
- `kb brand list | show | use NAME | clear` (`kblib/brands.py`): `use` matches the user's
  words to an installed brand and writes what the picker writes, so "use the Acme brand"
  becomes one command. `kb check` warns when the brand is missing or `BRAND.md` is.
- The managed permissions allow `Read(~/Kookaburra Cut/brands/**)`.
- `kookaburra-brand-packs` (`scripts/brand.py`, stdlib): `list`, `scan`, `init`, `fonts`,
  `images`, `gradient`, `check`, `apply`. `pdf.js` and `svg2png.js` run under
  `osascript -l JavaScript`, so PDF pages and SVG icons need no installs. Its tests live
  in the scene skill's suite (`test_brand_pack.py`), which keeps them out of projects.

## Packs

Brands are a `.kbpack` item kind (docs/packs.md): `payload/brands/<slug>/`, installed to
`brands/<slug>/`, requiring their themes, fonts and gradients. A project whose
`project.json` names a brand pulls it in, and a keep-both rename rewrites the reference.
