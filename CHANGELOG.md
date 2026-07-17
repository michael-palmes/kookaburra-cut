# Changelog

All notable changes to Kookaburra Cut are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-17

### Added

- Opt-in auto-update. Turn on "Check for updates on launch" in Settings and
  the app checks GitHub for new releases and installs them in one click.
- Hardware video acceleration via VideoToolbox. Media, editing and clip prep
  are hardware-accelerated by default (toggle in Settings), and hardware
  fast-draft export lanes are available for H.264, HEVC and ProRes.
  Deterministic exports still use the software path, so Verify is unaffected.

### Changed

- Device motion is now opt-in for new device scenes.

### Fixed

- Terminal-triggered runs now resolve the packaged app binary from
  Info.plist rather than assuming its name.
- The packaged app now reads bundled project assets from its own resources
  rather than a dev checkout on the same machine, so device screen videos
  export correctly instead of a placeholder.

## [0.1.0] - 2026-07-16

First public source release.

- Build video projects as folders of scenes, authored in React with a small
  toolkit of primitives: animated text, counters, image cards, video clips,
  3D devices and staging.
- Ten built-in themes cover colour, typography, lighting, staging and
  text-motion defaults, and can be applied per project or per scene.
- Real 3D device mockups play your video or image assets on their screen,
  with per-scene camera moves.
- A pack of transitions — crossfade, blur, push, zoom, whip, luma, glitch and
  more — with a live-preview picker for choosing and tuning them.
- One soundtrack per project, mixed sample-exact with the video and faded out
  automatically at the end.
- Export to platform-ready presets — Meta, TikTok, YouTube, LinkedIn, X,
  Reddit, Telegram, CTV, web, or a ProRes master — with size estimates and
  loudness targeting, alongside a plain default export.
- Every export is deterministic: exporting the same project twice produces
  byte-identical video, provable with the in-app Verify ×2 check.
- Everything renders through a single canvas, stepped frame by frame on a
  manual clock, so text, graphics and 3D composite the same way every time.
- An embedded terminal runs Claude Code scoped to the open project, for
  authoring and editing scenes conversationally.
- Runs entirely on your Mac: no telemetry, no cloud, no account. The optional
  embedded Claude Code terminal is the one network exception, and only talks
  to Anthropic while you are using it.
- Ships as a native macOS app for Apple Silicon, built on Tauri.
