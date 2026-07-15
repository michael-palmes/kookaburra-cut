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

The photoreal device model is a licensed asset that is not in the repo:
clones build against a bundled generic placeholder (see the README's Licensing
section). Export baselines are same-machine facts: see
[docs/determinism.md](docs/determinism.md) before touching anything on the
render or export path.
