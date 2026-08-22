---
name: kookaburra-export-presets
description: Kookaburra Cut export presets — the preset JSON schema, exporting through a preset or a custom EncodeSpec from the terminal, and creating/editing user presets at ~/Kookaburra Cut/export-presets/. Use when asked to "export for <platform>", "make an export preset", "change export quality/bitrate", "export smaller/for the web", "two-pass export", "H.265/HEVC export", "loudness target", or anything touching src/export/presets/, ~/Kookaburra Cut/export-presets/, or kookaburra:run --preset/--encode-json.
---

# kookaburra-export-presets

How Kookaburra Cut's export presets work and how to drive them from the terminal (v11 · M7–M8).

## The architecture in one paragraph

A preset is a **data-only JSON document**. The frontend resolves it into a fully-resolved
`EncodeSpec` and Rust builds the ffmpeg argv from that spec only. **THE FROZEN-PATH
RULE:** an export carrying NO spec runs today's byte-pinned legacy argv (`libx264
-preset medium -crf 18`, native res, 60 fps) — presets are a separate argv family that
the standing baselines and `Verify ×2` never see. The modal's "Kookaburra Cut Standard" row and
any `kookaburra:run` call without `--preset`/`--encode-json` take the frozen path.

- Bundled presets: `src/export/presets/*.json` + the lineup in `src/export/presetRegistry.ts`
  (explicit imports; a structure pin asserts every doc parses — extend the test when adding one).
- User presets: `~/Kookaburra Cut/export-presets/<slug>.json`, listed as `ws:<slug>`
  (`export-presets` is a reserved project slug). Write them directly as files or via the
  app's Save-as-preset.
- Output naming: preset/custom exports write `<project>-<aspect>-<preset-id>.<ext>`
  (`-custom` for ad-hoc specs); the frozen path keeps the plain `<project>-<aspect>.<ext>`.

## The preset document schema (version 1)

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | required; newer versions are refused, never mangled |
| `id` / `name` / `description` | string | description = ONE Australian-English sentence for non-technical folk |
| `platform` | string | the modal's grouping key ("Meta", "YouTube", …) |
| `favouredAspect` | `"16:9" \| "9:16" \| "1:1" \| "4:5"` | seeds the modal aspect row; `--preset` without `--aspect` exports this |
| `allowedAspects` | aspect[] (optional) | constrains the aspect row; absent = all four |
| `maxFileSizeMB` | number (optional) | the cap the estimate warns against (amber + Fit to cap) |
| `notes` | string (optional) | shown in the detail pane |
| `video.codec` | `libx264 \| libx265 \| h264_videotoolbox \| hevc_videotoolbox \| prores_ks` | VT lanes are "fast drafts" — excluded from Verify |
| `video.scaleShortEdgeTo` | number (optional) | lanczos downscale, aspect preserved, even dims, never upscales; absent = native |
| `video.fps` | `30 \| 60` | the render clock steps AT this rate (v12 · M3) — 30fps lanes render half the frames in half the time, same pixels as the old decimation |
| `video.rate` | `{crf}` OR `{targetKbps, maxKbps, bufsizeKbps, twoPass?}` | VT is bitrate-only and cannot two-pass; ProRes ignores rate (fixed 422 HQ) |
| `video.profile` / `level` | string (optional) | e.g. `"high"` / `"4.2"` |
| `video.gopSeconds` | number (optional) | keyframe interval (`-g` = fps × gop) |
| `video.bFrames` | number (optional) | `-bf` |
| `video.entropy` | `"cabac" \| "cavlc"` (optional) | x264 only |
| `video.tenBit` | boolean (optional) | x265 main10 (`yuv420p10le`) |
| `video.faststart` | boolean | `+faststart` moov-at-front for web playback |
| `video.colourTags` | boolean | bt709 tags AND the conversion at the same scale filter — tags never lie about pixels |
| `audio.codec` | `{aacKbps}` OR `{pcmBits: 16\|24}` | PCM requires the .mov (ProRes) container |
| `audio.loudnessTarget` | number (optional) | integrated LUFS, gain-only (−14 social · −24 broadcast); warn-never-limit on true peak |

Worked example (`~/Kookaburra Cut/export-presets/client-review.json`):

```json
{
  "version": 1,
  "id": "ws:client-review",
  "name": "Client review",
  "description": "A lean 1080p file that uploads fast and starts playing straight away.",
  "platform": "Custom",
  "favouredAspect": "16:9",
  "allowedAspects": ["16:9", "9:16"],
  "video": {
    "codec": "libx264",
    "scaleShortEdgeTo": 1080,
    "fps": 30,
    "rate": { "targetKbps": 6000, "maxKbps": 8000, "bufsizeKbps": 12000 },
    "profile": "high",
    "level": "4.2",
    "gopSeconds": 2,
    "faststart": true,
    "colourTags": true
  },
  "audio": { "codec": { "aacKbps": 128 }, "loudnessTarget": -14 }
}
```

## The four flows

1. **Export through a bundled preset** (AFK-safe; auto-runs a fresh `pnpm tauri dev`):

   ```bash
   pnpm kookaburra:run --action export --project showcase-tour --preset meta-reels
   ```

   Without `--aspect` the preset's `favouredAspect` is used (here 9:16). Loudness is
   measured automatically when the preset carries a target. Output:
   `~/Kookaburra Cut/showcase-tour/showcase-tour-9x16-meta-reels.mp4` (ws projects:
   `~/Kookaburra Cut/<slug>/exports/`). Bundled ids: `kookaburra-master`, `meta-reels`, `meta-feed`,
   `tiktok`, `youtube`, `youtube-shorts`, `linkedin-ads`, `linkedin-organic`, `x`,
   `reddit`, `telegram`, `ctv`, `web`.

2. **Export through a USER preset** — write the JSON (schema above) to
   `~/Kookaburra Cut/export-presets/<slug>.json`, then:

   ```bash
   pnpm kookaburra:run --action export --project ws:my-project --preset ws:<slug>
   ```

3. **Custom one-off encode** — write a fully-resolved `EncodeSpec` JSON (camelCase,
   the `video` block's fields + optional `audio {codec, loudnessGainDb}` flattened to
   the top level) and pass its path; it travels inline in the env (no fs scopes):

   ```bash
   cat > /tmp/spec.json << 'EOF'
   { "codec": "libx265", "fps": 30, "scaleShortEdgeTo": 1080,
     "rate": { "crf": 24 }, "tenBit": true, "faststart": true, "colourTags": true,
     "audio": { "codec": { "aacKbps": 128 } } }
   EOF
   pnpm kookaburra:run --action export --project showcase-tour --aspect 16:9 --encode-json /tmp/spec.json
   ```

   Note: `--encode-json` does NOT auto-measure loudness (there's no target field on a
   spec) — set `audio.loudnessGainDb` yourself if you need gain.

4. **Create/edit a preset for the app** — write/edit the JSON under
   `~/Kookaburra Cut/export-presets/`; the modal lists it under *Your presets* on next open
   (no restart needed — the list reloads per open). Bundled lineup changes are code
   changes: add the JSON to `src/export/presets/`, import it in `presetRegistry.ts`,
   and extend the `LINEUP` pin in `presetSchema.test.ts`.

## Gotchas

- **`--aspect all` = the STANDING three (16:9 · 9:16 · 1:1), not four.** 4:5 is
  first-class but must be asked for explicitly (`--aspect 4:5`).
- **VideoToolbox lanes are fast drafts** — hardware-encoded, not byte-reproducible,
  excluded from Verify by policy. Never use them for baseline work.
- **Two-pass renders ONCE to an FFV1 mezzanine** (`$APPDATA/cache/export-mezz/`,
  swept next run) — it needs disk (~2 bytes/pixel/frame at the OUTPUT size + 2 GB
  margin) and a pre-flight guard blocks if short. Two-pass needs libx264/libx265.
- **Loudness is gain-only** — one `volume=` slot; a projected true peak above
  −1.5 dBTP warns but never limits. The measurement is cached (content+graph keyed).
- **Software bitrate (VBV) lanes pin `-threads 1`** (x264 VBV under threads is
  non-deterministic — frames identical, bytes differing). CRF lanes are unaffected.
- **Verify ×2 always runs the frozen path** — presets don't change the standing gate.
  Preset-lane Verify hashes are LANE proofs that re-record when the preset's knobs
  change; they are not standing baselines.
- **PCM audio only in .mov** (ProRes); AAC everywhere else. 48 kHz fixed.
- **`colourTags: true` is the platform-correct choice** — the frozen path writes no
  tags (a v0-era decision baselines depend on); every bundled platform preset tags.
