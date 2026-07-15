---
description: Render a Kookaburra Cut project to video via the deterministic export loop
argument-hint: <project> <format-or-preset> <aspect>
---

Export the Kookaburra Cut project `$1` as `$2` at aspect `$3` (`16:9` | `9:16` | `1:1` | `4:5` | `all`).

`$2` picks the lane:

- `h264` → the FROZEN LEGACY PATH (deterministic libx264 CRF 18, native res, 60 fps —
  the exact argv every standing baseline pins; NO colour tags by design).
- `prores` → the legacy ProRes 422 HQ path (`prores_ks`, 10-bit 4:2:2, `.mov`).
- A **preset id** (`meta-reels`, `youtube`, `ctv`, `web`, `ws:<slug>`, …) → the
  EncodeSpec family (v11: scaling, bt709 tags, bitrate/two-pass, loudness; since
  v12 · M3 a 30fps lane RENDERS at 30 — half the frames, half the render time).
  See the `kookaburra-export-presets` skill for the schema and full lineup.

Steps:

1. Ensure the ffmpeg sidecar exists: `pnpm setup:ffmpeg` (dev copy of system ffmpeg).
   For preset lanes needing libx265/HEVC use the pinned static build instead:
   `pnpm setup:ffmpeg:release` (the dev copy would overwrite it — don't mix them up).
2. Run the export from the terminal (auto-runs a fresh `pnpm tauri dev`, AFK-safe):

   ```bash
   pnpm kookaburra:run --action export --project $1 --aspect $3 --codec libx264   # h264 legacy
   pnpm kookaburra:run --action export --project $1 --aspect $3 --codec prores_ks # prores legacy
   pnpm kookaburra:run --action export --project $1 --preset $2                   # preset lane
   ```

   `--preset` without `--aspect` uses the preset's favoured aspect. `--aspect all` =
   the standing three (16:9 · 9:16 · 1:1); 4:5 must be explicit.
3. Outputs land at `~/Kookaburra Cut/<project>/` (bundled/gate projects) or
   `~/Kookaburra Cut/<slug>/exports/` (workspace projects). Preset/custom exports suffix the
   filename (`<project>-<aspect>-<preset-id>.<ext>`); the legacy lanes keep
   `<project>-<aspect>.<ext>`. The run writes `~/Kookaburra Cut/_autorun/last-run.json` and exits
   0=ok / 1=fail / 2=setup·timeout.
4. Determinism: `--action verify` runs Verify ×2 (byte-identical threshold) through the
   frozen path. If a verify fails, STOP and fix determinism before anything else — see
   `docs/determinism.md`.
