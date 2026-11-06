# Contributing

Kookaburra Cut is a personal open-source project (dual-licensed
MIT OR Apache-2.0). It's published so the approach (a deterministic,
local-only video studio in a webview) can be read, built and learned from.

- **Issues and discussion are welcome.** Bug reports with reproduction steps are
  especially useful.
- **Pull requests may be declined**, even good ones: the project follows a
  fairly opinionated internal roadmap. Open an issue first if you're considering
  a change.

## Building & running

See the [README](README.md) for prerequisites and quick start. The short
version:

```bash
pnpm install
pnpm setup:ffmpeg
pnpm tauri dev
```

Checks before any change: `pnpm test` · `pnpm build` · `pnpm lint`.

New functionality lands with tests beside it (vitest for `src/`, `cargo test`
for `src-tauri/`), and a bug fix keeps its reproduction as a test. `pnpm test`
runs vitest, the node script tests and the kit suite; `pnpm ready` adds the
determinism gate for anything on the render or export path. Code style is what
biome and clippy enforce; text is Australian English.

## Changelog

Every user-visible change goes under `## [Unreleased]` in `CHANGELOG.md`, in
Keep a Changelog form. A security fix goes under `### Security` with one plain
line on who is affected and what changes, and a link to the GitHub advisory
when there is one. The version's section becomes the release notes, so write
it for the person reading the release page.

The photoreal device model is a licensed asset that is not in the repo:
clones build against a bundled generic placeholder (see the README's Licensing
section). Export baselines are same-machine facts: see
[docs/determinism.md](docs/determinism.md) before touching anything on the
render or export path.
