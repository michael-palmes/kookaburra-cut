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
- Keep the family under 18 MB.

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
| `fairywren-sorted-phone.mp4` / `.jpg`, `fairywren-sorted-dark-phone.jpg` | "Plans itself": the week sorts itself under a "This week, sorted" card |
| `fairywren-quickadd-phone.mp4` / `.jpg` | "Faster": a plan typed in plain words is parsed and added |
| `fairywren-reschedule-phone.mp4` / `.jpg` | "Smarter": a meeting runs over and two plans move to fit |
| `fairywren-share-phone.mp4` / `.jpg` | "Together": a list shared with three people, who tick items off |
| `fairywren-focusflow-phone.mp4` | Spotlight's flow: one large Focus toggle, no baked tap |
| `fairywren-insights-phone.jpg` / `fairywren-month-phone.jpg` | Two more screens for a line-up |
| `songlark-offsite-ask-window.jpg` / `songlark-offsite-answer-window.jpg` | Prompt pair two: a team offsite |
| `songlark-notes-ask-window.jpg` / `songlark-notes-answer-window.jpg` | Prompt pair three: launch notes |
| `songlark-followup-window.mp4` / `.jpg` | A follow-up typed into the thread, the answer streaming in word by word |
| `thornbill-changes-terminal.mp4` / `.jpg` | `thornbill upgrade` with one change line per beat |
| `thornbill-diff-window.jpg` | The 4.2 migration diff, changed lines lit |
| `thornbill-benchmark-window.jpg` | 4.1 against 4.2: cold start, p95 latency, throughput |

### Timings and regions for the launch templates

Regions are screen UV `[u0, v0, u1, v1]` (`ScreenRegion rect`), times are seconds into the clip.

- Line-up of five different phones: `fairywren-today-phone.jpg`, `fairywren-focus-phone.jpg`,
  `fairywren-insights-phone.jpg`, `fairywren-month-phone.jpg`, `fairywren-share-phone.jpg`.
- "This week, sorted" card: `[0.04, 0.172, 0.96, 0.40]`, still from 2.0 s.
- Quick add field and parsed plan: `[0.04, 0.27, 0.96, 0.444]`, still from 2.8 to 3.4 s apart from the
  blinking caret (Add at 3.45 s).
- Reschedule card: `[0.04, 0.27, 0.96, 0.531]`, still from 1.3 to 3.3 s (Keep at 3.35 s).
- Share sheet: `[0.02, 0.613, 0.98, 0.991]`, still from 1.6 to 2.3 s (Share at 2.3 s).
- Focus flow: the toggle centre is `(0.818, 0.389)` and flips at 1.5 s; the Focus card is
  `[0.04, 0.327, 0.96, 0.451]` until it grows at 1.85 s. Put the `TapRing` at 1.5 s.
- Changes terminal: the command ends on beat 4 at 128 BPM (1.875 s), then one line per beat
  at 2.34, 2.81, 3.28, 3.75 and 4.22 s, and DONE at 4.69 s, each within one frame.

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
