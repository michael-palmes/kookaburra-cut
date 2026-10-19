## What and why

<!-- What does this change, and what problem does it solve? -->

## Linked issue

<!-- Open an issue first for anything beyond a small fix, so the direction can be agreed before the work. Fixes #... -->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] `pnpm lint` passes
- [ ] If this touches the render or export path, `pnpm ready` passes: exports must stay byte-identical to the recorded baselines (see [`docs/determinism.md`](../docs/determinism.md), "Gate tiers")

Note: this is a personal, source-available project on a fairly opinionated internal
roadmap — see [`CONTRIBUTING.md`](../CONTRIBUTING.md). Pull requests are welcome but
may be declined, even good ones.
