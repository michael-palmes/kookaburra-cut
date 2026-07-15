# design-sync notes — Kookaburra Cut

- **This repo is NOT a component library.** The app's toolkit (`src/toolkit/`) is r3f/WebGL scene primitives that cannot render in Claude Design's DOM runtime — they are deliberately OUT of the sync. The DS surface is the hand-authored wrapper kit at `.design-sync/kit/` (Michael-approved 2026-07-10): thin typed React bindings over the real app stylesheet `src/styles.css`. App source is never touched by the sync.
- **The kit is its own package** (`.design-sync/kit/package.json`, name `@kookaburra/chrome`, `types: dist/index.d.ts`). Without it the converter's entry-ancestor walk lands on the repo-root package.json and component discovery finds nothing (`[ZERO_MATCH]` → tokens-only).
- **`buildCmd` must run before the converter**: `tsc` compiles the kit AND `cp` copies `src/styles.css` into `.design-sync/kit/dist/` — `cssEntry` is security-bounded to the package dir, so the app stylesheet can't be referenced in place. A converter run without `buildCmd` uses a stale stylesheet copy.
- **`guidelinesGlob` is deliberately ONLY `docs/design.md`.** The default glob (`docs/*.md`) would sweep the whole engineering docs tree (architecture/determinism/decisions) into the uploaded guidelines.
- **SF Pro / SF Mono never ship — by the repo's own spec.** `docs/design.md` §5.4 records "no bundled UI face, stay pure system"; `runtimeFontPrefixes` suppresses `[FONT_MISSING]`. Do not "fix" this with a bundled font.
- The repo `.gitignore`'s unanchored `dist/` already covers `.design-sync/kit/dist/`.
- Kit class combos mirror app usage exactly (`btn primary`, `btn btn-small`, `chip selected`, toast/modal/scrubber anatomy from `src/App.tsx` + `src/ui/*`). When chrome CSS classes change, re-check the kit wrappers against `grep className src/ui`.

## Known render warns

- `[RENDER_THIN]` Modal: "DOM content present but rendered height is 0px" — the modal renders via fixed positioning so the measured root collapses; screenshot verified complete (v14 re-sync, 2026-07-12). Benign, expect it every run.
- Machine render baseline EXISTS since 2026-07-12 (v14 re-sync): playwright + chromium-headless-shell v1228 installed under `.ds-sync/`; 15/15 clean, all cells graded good.
- **The app self-check provisions `fonts/SF-Pro-Text-*.otf` + `fonts/fonts.css` and `_ds_manifest.json`/`_adherence.oxlintrc.json` SERVER-SIDE** (seen after the first project open). These are app-owned, never produced by the build: reconciliation passes must NOT delete them even though `fonts/**` is in the delete globs.

## Re-sync risks

- **`resync.mjs` does NOT run `buildCmd`** (observed 2026-07-12 — an older note here claimed otherwise). Always run `cfg.buildCmd` manually before the driver. A missing/deleted `dist/` does NOT fail the run: the driver falls into synth-entry mode (`[NO_DIST]`) and produces a DESTRUCTIVE verdict (4 components, delete-nearly-everything). Any verdict whose log shows `[NO_DIST]` is untrustworthy — discard it.
- **tsc leaves stale outputs in `kit/dist/`.** After renaming or deleting a kit source file, `rm -rf .design-sync/kit/dist` and rebuild — a ghost `.d.ts` re-adds the dead component to discovery (the v14 Scrubber ghost).
- **Kit class audits must include conditional `cx()` args.** `chip-end` shipped for a whole campaign as a kit-invented class no stylesheet ever defined (invisible: it just did nothing). Audit pattern: every string literal inside `cx(...)`, not just first args.
- v13 chrome renames landed in the kit 2026-07-12: `Scrubber` → `PlaybackBar` (segmented `pb-*` anatomy), `Titlebar` → the 46px name-over-path identity block, `chip-end` retired. When chrome CSS changes again, re-run the class audit against `src/styles.css`.
- Preview content name-drops real projects (`launch-2026`) and app flows — cosmetic only; nothing imports from the app. Threshold copy in previews mirrors the shipped voice (the locked export toast line) — re-check against voice.md when strings change.
