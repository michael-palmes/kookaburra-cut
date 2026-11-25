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

- A signed and notarised `.dmg` for macOS 26.0+ on **Apple Silicon** (arm64). There's no Intel build
- Free and open source. No accounts, no telemetry
- The optional AI authoring path uses your own Claude Code install
- Managed Macs install the signed `.pkg` through an MDM ([`docs/fleet.md`](docs/fleet.md))
- Accessibility: the WCAG 2.2 AA conformance report (VPAT), keyboard map and open findings are in [`docs/accessibility.md`](docs/accessibility.md)

## Secure and private

Nothing leaves your Mac unless you choose.

<p align="center">
  <img src="docs/assets/security-doors.png" width="900" alt="Your Mac as a walled box holding projects, render and export. Two switched doors lead to GitHub for updates and your own Claude app, each with the key a fleet forces to lock it. There is no other way out.">
</p>

| Risk | What the app does |
| --- | --- |
| [Your work leaves the Mac](SECURITY.md#what-leaves-the-mac) | There are no accounts, no telemetry and no crash reports. The app goes online for two things: updates and Edit with Claude. You turn each one on, and IT can turn each one off. The app itself loads no web page. |
| [The AI sees more than it should](SECURITY.md#what-reaches-your-agent) | The app has no API key and sends nothing to Anthropic itself. Edit with Claude opens one project folder in your own Claude app, and nothing is sent until you press Enter there. Claude then sends that project's files to Anthropic, under your account and your organisation's Claude settings. |
| [A project or pack you were sent runs code](SECURITY.md#scene-code-and-the-trust-boundary) | Nothing runs when you import. Scene code runs only after you press Allow, and it can't reach the network or the app's commands. Packs are signed, and every file's hash is checked on import. |
| [Text in a project tries to instruct the AI](SECURITY.md#what-reaches-your-agent) | Text that Claude reads from a project is escaped, capped and marked as data. Agent settings in a shared folder are set aside, and you see the list before Claude starts. |
| [A release or update is tampered with](SECURITY.md#release-integrity) | GitHub Actions builds each release from a signed tag, with no signing secret in reach. Signing needs a second reviewer. Apple notarises the app, and each release comes with an attestation and an SBOM. An update installs only if it's signed with the key built into the app. |
| [Confidential files sit on the Mac](SECURITY.md#on-the-mac) | Projects stay in your home folder. Nothing is uploaded or synced. Only your account can read the app's data, and Spotlight skips it. The app adds no encryption of its own, so use FileVault. |
| [Your organisation needs to set limits](docs/mdm.md) | A configuration profile can lock nine settings. People can't override them with `defaults write`. If a key is malformed, the app takes the safe option. |

**Not done yet.** There's one maintainer, who can change the release rules. There's been no third-party penetration test. There's no SOC 2 or ISO 27001, and no App Sandbox. The AI is limited by rules and prompts, not by a sandbox. [The full list](SECURITY.md#not-yet).

**Check it yourself:**

```bash
codesign -dvv "/Applications/Kookaburra Cut.app"         # Developer ID Application, hardened runtime
spctl -a -t exec -vv "/Applications/Kookaburra Cut.app"  # source=Notarized Developer ID
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners  # built by this repository's release workflow at that tag
```

For your security team: [one page](docs/security-overview.md) · [threat model](SECURITY.md) · [managed Macs](docs/fleet.md) · [verify a release](docs/fleet.md#verify-a-release) · [privacy in plain words](docs/privacy.md) · [report privately](https://github.com/michael-palmes/kookaburra-cut/security/advisories/new)

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

## Contributing

This is a personal open source project. Issues and discussion are welcome. Pull requests may be declined: see [`CONTRIBUTING.md`](CONTRIBUTING.md). Report a vulnerability privately, as [`SECURITY.md`](SECURITY.md#reporting-a-vulnerability) sets out.

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
