# Shared sample pool

Seeded into every new project's `assets/` by `create_project` (media files only,
ancient-stamped so they sort below the user's own media). Templates reference
these by name and never ship a copy.

The Kooka set is filler UI for the app-update templates: one consistent
fictional day-planning app so every screenshot shares a design language.
Generated with gpt-image-2 via the Codex CLI; fictional brand and content only,
no real marks, apps or people. Screens 828x1792 JPEG, icons 512 PNG, badge PNG
with alpha, each file under 150 KB.

| File | Purpose |
| --- | --- |
| `sample-phone-recording.mp4` / `sample-laptop-recording.mp4` | Screen-recording stand-ins until real captures exist |
| `app-icon.png` | Generic rounded-square icon (BrandLockup default) |
| `kooka-icon-sample.png` / `kooka-icon-dark-sample.png` | Kooka app mark, light and dark |
| `shot-a-sample.jpg` / `shot-b-sample.jpg` / `shot-c-sample.jpg` | Kooka home, task detail, settings |
| `onboard-1/2/3-sample.jpg` | Onboarding trio |
| `settings-off-sample.jpg` / `settings-on-sample.jpg` | Same screen, one toggle off and on |
| `home-light-sample.jpg` / `home-dark-sample.jpg` | Same home screen, light and dark |
| `home-old-sample.jpg` / `home-new-sample.jpg` | Same home screen, two design generations |
| `pro-badge-sample.png` | Pro pill, transparent background |
