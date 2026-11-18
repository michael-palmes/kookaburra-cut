<h1 align="center">
  <img src="docs/assets/readme-banner.jpg" width="900" alt="Kookaburra Cut: give every feature its moment">
</h1>

<p align="center">An AI driven, <strong>deterministic</strong> animated-video studio for macOS (Apple Silicon).</p>

<p align="center">
  <a href="https://github.com/michael-palmes/kookaburra-cut/actions/workflows/ci.yml"><img src="https://github.com/michael-palmes/kookaburra-cut/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/michael-palmes/kookaburra-cut/actions/workflows/codeql.yml"><img src="https://github.com/michael-palmes/kookaburra-cut/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/michael-palmes/kookaburra-cut"><img src="https://api.scorecard.dev/projects/github.com/michael-palmes/kookaburra-cut/badge" alt="OpenSSF Scorecard"></a>
</p>

Kookaburra Cut renders every visual (animated text, graphics, and 3D) through a single
react-three-fiber WebGL canvas, and exports video by stepping a manual clock
frame-by-frame into a bundled **ffmpeg** sidecar (H.264 / H.265 / ProRes). It runs in
pure WKWebView via Tauri 2, no Chromium. Two exports of the same project are
byte-identical by design. Scenes can also be authored conversationally: Edit with
Claude hands your project to Claude Code, which reads and rewrites its scene files
while you watch them update here.

<p align="center">
  <a href="https://kookaburracut.com/">
    <img src="docs/assets/studio-demo.gif" width="900" alt="The Kookaburra Cut studio: editing a device scene while Claude Code rewrites it">
  </a>
</p>

<p align="center"><sub>Reworking a device scene with Claude Code. More at <a href="https://kookaburracut.com/">kookaburracut.com</a>.</sub></p>

## Download

<p align="center">
  <a href="https://github.com/michael-palmes/kookaburra-cut/releases/latest">
    <img src="docs/assets/download-macos.svg" width="252" alt="Download for macOS">
  </a>
</p>

- A signed and notarised `.dmg`; macOS 26.0+ on **Apple Silicon** (arm64) only, no Intel build
- Free and open source. No accounts, no telemetry. Nothing leaves your Mac
  unless you start it: the opt-in update check, Edit with Claude, or a website
  you allow in a scene
- The optional AI authoring path uses your own Claude Code install
- Managed Macs: a configuration profile can turn off the Claude entry points,
  the agent kit, live websites, pack export or update checks, limit packs to
  approved publishers, point updates at your own server, keep exports in the
  project and fix the workspace location ([`docs/fleet.md`](docs/fleet.md),
  [`docs/mdm.md`](docs/mdm.md))
- Accessibility: the WCAG 2.2 AA conformance report (VPAT), keyboard map and open
  findings are in [`docs/accessibility.md`](docs/accessibility.md)

Every release is built by this repository's release workflow from a signed tag,
signed with a Developer ID certificate and notarised by Apple. Managed Macs can
install the release's signed `.pkg` through an MDM instead
([`docs/mdm.md`](docs/mdm.md#installing-with-the-pkg)). To check a download
against the release's `SHA256SUMS` and its build provenance (the same for the
`.pkg`), and the pkg's installer signature:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners
pkgutil --check-signature KookaburraCut-<version>.pkg  # Developer ID Installer, trusted by the Apple notary service
spctl -a -t install -vv KookaburraCut-<version>.pkg    # accepted, source=Notarized Developer ID
```

Offline, against the release's provenance bundle:

```bash
gh attestation verify KookaburraCut-<version>.dmg --bundle KookaburraCut-<version>.intoto.jsonl \
  --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

> Status: early release, in active development. Every path off your Mac, with
> its off switch, is in [`docs/privacy.md`](docs/privacy.md) and
> [`SECURITY.md`](SECURITY.md).

## For security teams

- [`docs/security-overview.md`](docs/security-overview.md): what leaves the Mac,
  where data rests, how releases are built, questionnaire answers and what is
  not done yet, for the team deciding whether it may run on managed Macs.
- [`SECURITY.md`](SECURITY.md): the engineering record, every control with the
  file or command behind it, and how to report a vulnerability.
- [`docs/fleet.md`](docs/fleet.md): deploying it on managed Macs: verifying a
  release, the keys to force, Claude Code's own settings, what to expect in EDR.

## Core features

- **AI-authored scenes**: Edit with Claude opens the project in Claude Code, with
  a kit stamped into the folder. The output is plain, editable TSX built on a typed toolkit, not a
  black box.
- **Deterministic export**: a manual clock stepped frame-by-frame through one
  WebGL canvas into the ffmpeg sidecar. The same project produces the same
  bytes, every time.
- **Device mockups**: video and images play on a studio-lit 3D handset through
  a deterministic frame-extraction pipeline, with per-scene camera orbits.
- **Motion that looks finished**: headline presets, animated counters, a
  transition pack with live preview, LUT grades and film grain.
- **One project, every feed**: 16:9 / 9:16 / 1:1 / 4:5 from the same scenes,
  plus platform export presets (social, CTV, web, ProRes master) with size
  estimates and loudness targeting.
- **Projects are just files**: a folder of `project.json` + `scenes/*.tsx` +
  assets. Git-friendly, no opaque project format.
- **Themes**: JSON documents covering colour, typography, lighting, staging and
  text-motion defaults; swappable per project or per scene.
- **Fully local**: preview and export never leave your Mac.

## Building from source

Prerequisites:

- macOS on Apple Silicon, Xcode command-line tools (Xcode 26 to bundle the app or
  change its icon)
- Node 24.22.1, pnpm (`corepack enable` honours the pinned version)
- Rust through `rustup` (`rust-toolchain.toml` pins the version)
- ffmpeg on `PATH` (for the dev sidecar copy)

```bash
pnpm install
pnpm setup:ffmpeg     # provision the ffmpeg sidecar (dev copy of system ffmpeg)
pnpm tauri dev        # launch the app (Vite HMR + WKWebView shell)
```

Other commands:

```bash
pnpm build            # tsc --noEmit + vite build
pnpm test             # vitest
pnpm lint             # biome check .
```

Stack: Tauri 2 · React 19 · react-three-fiber · troika SDF text · anime.js v4 ·
zustand · ffmpeg/ffprobe sidecars. Package manager: **pnpm**. Full version list
in [`docs/architecture.md`](docs/architecture.md).

> Note: the photoreal device model is a licensed third-party asset and is
> **not** included in this repository (see Licensing below). Clones build and
> run against a bundled generic placeholder handset; dropping a licensed model
> into `src/assets/models/licensed/` overrides it (see
> `src/assets/models/README.md`).

## Layout

```
src/toolkit/   shipped authoring primitives  (the @kookaburra/toolkit surface)
src/engine/    timeline · format · compositor · exporter (deterministic loop)
src/theme/     theme schema, bundled themes, fonts
src/store/     zustand editor/preview state
projects/      one folder per project: project.json + scenes/ + assets/
src-tauri/     Rust shell, tauri.conf.json, capabilities/, bin/ (sidecars)
docs/          architecture, determinism, decisions, design, voice, privacy, security, fleet
.agents/       project skills (scene authoring, video editing, brand packs, release)
.claude/       slash commands (new-scene, preview, export); skills/ is a symlink to ../.agents/skills
```

## Authoring scenes

Scenes live in `projects/<project>/scenes/*.tsx` as `defineScene` default exports and
use `@kookaburra/toolkit` only: never the DOM or the wall clock. See the
`kookaburra-scene-authoring` skill and `/new-scene`, or
[`docs/determinism.md`](docs/determinism.md) for the why.

## Documentation

Start at [`docs/README.md`](docs/README.md). The short version:
[`docs/architecture.md`](docs/architecture.md) explains how rendering and export
work, [`docs/determinism.md`](docs/determinism.md) is the byte-identical-export
contract, and [`docs/decisions.md`](docs/decisions.md) records every locked
decision and why.

## Contributing & security

This is a personal, source-available project. Issues and discussion are welcome;
pull requests may be declined: see [`CONTRIBUTING.md`](CONTRIBUTING.md).
Security: [`SECURITY.md`](SECURITY.md) is the engineering record and the
place to report a vulnerability, for the security engineer, auditor and
contributor; [`docs/security-overview.md`](docs/security-overview.md) is the
summary for the security lead, CTO or engineering manager;
[`docs/fleet.md`](docs/fleet.md) is the deployment guide for the IT team; and
[`docs/privacy.md`](docs/privacy.md) says it in plain words for the person
using the app.

## Licensing

Kookaburra Cut's code is dual-licensed under either the
[MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at
your option. Bundled assets keep their own terms: fonts are OFL 1.1, HDRI
environments are CC0 (Poly Haven), and the photoreal device model is a
purchased licensed asset that is deliberately **not** in the repo (its
committed preview images are not reusable outside this project). The ffmpeg
sidecar the app drives is a **GPL** build (libx264/libx265), provisioned
locally by script and never committed here. Full inventory:
[NOTICE.md](NOTICE.md).

## Trademarks & affiliation

Kookaburra Cut is an independent project. Apple and iPhone are trademarks of
Apple Inc.; device names in the catalogue identify the hardware being
depicted. Platform names in export presets (Meta, TikTok, YouTube, LinkedIn,
X, Reddit, Telegram) identify export targets only. This project is not
affiliated with, sponsored by, or endorsed by Apple, OpenAI, Anthropic, or
any of those platforms.
