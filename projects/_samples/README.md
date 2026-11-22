# Shared sample pool

`create_project` seeds the samples a project names into its `assets/`, plus
`app-icon.png` (media files only, ancient-stamped so they sort below the user's
own media), and a load restores a named one that has gone missing. Templates
reference these by name and never ship a copy. A product icon is the exception:
it fills the app icon slot, so it ships in its template as `assets/app-icon.png`.

## Product family

Unveil and Spotlight show one fictional product, Fairywren (a calm planner). Its screens are
rendered from HTML and CSS by `tools/sample-product/` (`pnpm assets:sample-product`),
which steps a deterministic clock frame by frame in headless Chrome. Fictional brand,
people and data only; the name was checked against IP Australia, USPTO and the App
Store (see that README). The tool also draws light twins and two sibling products,
Thornbill and Songlark; only the files a bundled template names are kept here.

- Phone screens are 1206x2622 JPEG.
- Recordings are 30 fps H.264, yuv420p, BT.709 tagged, faststart, 4 to 6 s and at
  most 1.5 MB each. Each still at a recording's settled moment matches its frame.
- The icon is a 1024 PNG with transparent corners, shipped as Unveil's
  `assets/app-icon.png`.
- Keep the family under 18 MiB.
- Fairywren's phone screens are drawn for the camera: type about a fifth larger than a
  real app and fewer rows, so they read on a phone inside a film frame.

| File | Purpose |
| --- | --- |
| `fairywren-today-dark-phone.jpg` | Today |
| `fairywren-focus-dark-phone.jpg` | Focus mode |
| `fairywren-insights-dark-phone.jpg`, `fairywren-month-dark-phone.jpg` | Two more screens for a line-up |
| `fairywren-share-dark-phone.jpg` | A shared list |
| `fairywren-plan-dark-phone.mp4` | Plans land, one is ticked off, a new plan is typed |
| `fairywren-sorted-dark-phone.mp4` | "Plans your week for you": the week sorts itself under a "This week, sorted" card |
| `fairywren-quickadd-dark-phone.mp4` | A plan typed in plain words is parsed and added |
| `fairywren-reschedule-dark-phone.mp4` | A meeting runs over and two plans move to fit |
| `fairywren-share-dark-phone.mp4` | A list shared with three people, who tick items off |
| `fairywren-focusflow-phone.mp4` | Spotlight's flow in light mode: one large Focus toggle, no baked tap |

### Timings and regions

Regions are screen UV `[u0, v0, u1, v1]` (`ScreenRegion rect`), times are seconds into the clip.

- Plan: the first plan's tick is at `(0.886, 0.340)` and lands at 1.75 s; the round plus button is
  at `(0.883, 0.930)`, pressed at 3.25 s. The New plan sheet is `[0.02, 0.588, 0.98, 0.991]`, up
  from 3.95 s. The Today still is the frame at 3.1 s.
- "This week, sorted" card: `[0.04, 0.172, 0.96, 0.40]`, still from 2.0 s.
- Quick add field and parsed plan: `[0.04, 0.27, 0.96, 0.444]`, still from 2.8 to 3.4 s apart from the
  blinking caret (Add at 3.45 s). The schedule below slides down to make room from 2.25 s and back
  up from 3.9 s.
- Reschedule card: `[0.04, 0.27, 0.96, 0.531]`, still from 1.3 to 3.3 s (Keep at 3.35 s).
- Share sheet: `[0.02, 0.613, 0.98, 0.991]`, still from 1.6 to 2.3 s (Share at 2.3 s).
- Focus flow: the toggle centre is `(0.818, 0.389)` and flips at 1.5 s; the Focus card is
  `[0.04, 0.327, 0.96, 0.451]` until it grows at 1.85 s.

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
