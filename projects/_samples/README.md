# Shared sample pool

Seeded into every new project's `assets/` by `create_project` (media files only,
ancient-stamped so they sort below the user's own media). Templates reference
these by name and never ship a copy.

## Product family

The launch templates show one fictional product family, so the picker reads as one
campaign: Fairywren (a calm planner), Thornbill (a developer CLI and SDK) and
Songlark (an AI assistant). Rendered from HTML and CSS by `tools/sample-product/`
(`pnpm assets:sample-product`), which steps a deterministic clock frame by frame in
headless Chrome. Fictional brands, people and data only; the names were checked
against IP Australia, USPTO and the App Store (see that README).

- Screens match the device catalogue: `-phone` 1206x2622, `-tablet` 2752x2064,
  `-laptop` 3456x2234, `-window` and `-terminal` 2560x1600 (16:10). JPEG.
- Recordings are 30 fps H.264, yuv420p, BT.709 tagged, faststart, 4 to 6 s and at
  most 1.5 MB each. Each still at a recording's settled moment matches its frame.
- Icons are 1024 PNG with transparent corners.
- Keep the family under 12 MB.

| File | Purpose |
| --- | --- |
| `fairywren-icon.png` | Fairywren app icon |
| `fairywren-today-phone.jpg` / `fairywren-today-dark-phone.jpg` | Today, light and dark |
| `fairywren-focus-phone.jpg` | Focus mode, navy |
| `fairywren-then-phone.jpg` | The same day in an older design, for before and after |
| `fairywren-week-tablet.jpg` / `fairywren-week-laptop.jpg` | The same week on a tablet and a laptop |
| `fairywren-share-window.jpg` | Web app timeline in a browser window |
| `fairywren-plan-phone.mp4` | Plans land, one is ticked off, a new plan is typed |
| `fairywren-focus-phone.mp4` | Focus switches on and the day calms to navy |
| `fairywren-share-window.mp4` | A cursor shares the plan and copies the link |
| `thornbill-icon.png` | Thornbill app icon |
| `thornbill-upgrade-terminal.jpg` / `.mp4` | `thornbill upgrade` runs to done |
| `thornbill-docs-window.jpg` / `thornbill-api-window.jpg` | Docs home and an API reference page |
| `thornbill-docs-window.mp4` | The API page switches to Python and copies the code |
| `thornbill-changelog-window.jpg` | The 4.2.0 changelog |
| `thornbill-dashboard-laptop.jpg` | Latency drops after the 4.2.0 deploy |
| `thornbill-editor-window.jpg` | A typed route with an inferred type |
| `songlark-icon.png` | Songlark app icon |
| `songlark-ask-window.jpg` / `songlark-answer-window.jpg` | The prompt typed, then the answer cards |
| `songlark-ask-window.mp4` | Ask, think, answer on the web |
| `songlark-ask-phone.jpg` / `songlark-answer-phone.jpg` / `.mp4` | The same on a phone |
| `songlark-voice-phone.jpg` | Voice mode |

## Kooka set

Filler UI for the older app-update templates: one consistent fictional day-planning
app so every screenshot shares a design language. Generated with gpt-image-2 via the
Codex CLI; fictional brand and content only, no real marks, apps or people. Screens
828x1792 JPEG, icons 512 PNG, badge PNG with alpha, each file under 150 KB.

| File | Purpose |
| --- | --- |
| `sample-phone-recording.mp4` / `sample-laptop-recording.mp4` | Screen-recording stand-ins until real captures exist |
| `kooka-feed-loop-sample.mp4` / `kooka-dark-loop-sample.mp4` / `kooka-alt-loop-sample.mp4` | Kooka screen loops at the native 828x1792 screen ratio (regenerate: `scripts/make-kooka-loops.sh`); device clips seek with a NEGATIVE `startMs` |
| `kooka-terminal-loop-sample.mp4` | Fictional kooka CLI release run for terminal video windows |
| `app-icon.png` | Generic rounded-square icon (BrandLockup default) |
| `kooka-icon-sample.png` / `kooka-icon-dark-sample.png` | Kooka app mark, light and dark |
| `shot-a-sample.jpg` / `shot-b-sample.jpg` / `shot-c-sample.jpg` | Kooka home, task detail, settings |
| `onboard-1/2/3-sample.jpg` | Onboarding trio |
| `settings-off-sample.jpg` / `settings-on-sample.jpg` | Same screen, one toggle off and on |
| `home-light-sample.jpg` / `home-dark-sample.jpg` | Same home screen, light and dark |
| `home-old-sample.jpg` / `home-new-sample.jpg` | Same home screen, two design generations |
| `pro-badge-sample.png` | Pro pill, transparent background |
