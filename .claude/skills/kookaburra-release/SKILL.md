---
name: kookaburra-release
description: Cutting a macOS release of Kookaburra Cut — Developer ID signing, Apple notarisation via a notarytool keychain profile, the styled Retina DMG, the packaged-parity gate, and the tag/GitHub-release flow. Use when asked to "cut a release", "build a release build", "make a DMG", "sign the app", "notarise", "staple", "ship it", "publish a build", "bump the version and release", or when touching scripts/release.sh, scripts/sign-and-notarize.sh, scripts/make-dmg.sh, src-tauri/dmg/, or bundle.macOS in tauri.conf.json.
---

# kookaburra-release

Ship a signed, notarised, stapled `.app` + DMG that opens on any Mac with no Gatekeeper warning, offline.

## The split, in one paragraph

**Tauri signs; we notarise.** Tauri walks the bundle and signs the ffmpeg/ffprobe sidecars and
nested code inside-out, which is the fiddly part worth delegating. Everything else is ours:
Tauri's built-in notarisation **cannot use a notarytool keychain profile**, and it **never
notarises the DMG** — only the `.app`. We also build the DMG ourselves (`bundle.targets` is
`["app"]`) because Tauri's DMG bundler accepts only a png/jpg/gif background — no
multi-resolution TIFF, so the artwork is blurry on Retina — and cannot set a volume icon.

## One-time setup

1. A **Developer ID Application** cert in the keychain — `security find-identity -p codesigning -v`.
2. A **notarytool keychain profile** (prompts for an app-specific password from
   appleid.apple.com, never the Apple ID password):
   ```bash
   xcrun notarytool store-credentials "kookaburra-cut" \
     --apple-id <email> --team-id <TEAMID>
   ```
3. An **updater keypair** for the auto-update lane (once; keep the private key out of git):
   ```bash
   pnpm tauri signer generate -w ~/.tauri/kookaburra-cut-updater.key
   ```
   Paste the printed public key into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
4. Export all of these, or the scripts refuse to start:
   ```bash
   export KOOKABURRA_SIGNING_IDENTITY="Developer ID Application: Your Name (<TEAMID>)"
   export KOOKABURRA_NOTARY_PROFILE="kookaburra-cut"
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/kookaburra-cut-updater.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<its password>"
   ```

## Cutting a release

1. **Pin the release sidecar** — `pnpm setup:ffmpeg:release`. Skip only if untouched since the
   last release (see the first trap below).
2. **Bump the version** in `src-tauri/tauri.conf.json`. `"version"` is the single source of
   truth; every script reads it with `node -p`. An already-tagged version is refused.
3. **Commit** — `release.sh` refuses a dirty tree. Use `/ps-commit`.
4. **`pnpm release`** (or `pnpm release --no-github` to build and tag locally only). It runs:
   guards (clean tree, untagged version, `pnpm build` + `test` + `lint`) → sign + notarise +
   staple the app → styled DMG → notarise + staple the DMG → updater tar + `.sig` → zip +
   sha256 → `latest.json` → tag → draft GitHub release (DMG, zip, sha256, updater tar,
   `latest.json`). Publishing is skipped automatically when no git remote is configured.
   - **Needs a GUI session**: Finder styles the DMG, so this cannot run headless or over SSH.
     Don't lock the screen while it runs.
   - Budget **5–15 minutes**, mostly waiting on Apple.
5. **Run the packaged-parity gate** (below). `release.sh` does *not* run it.

Partial flows:
- `pnpm package:signed` — build, sign, notarise and staple the app **and** the DMG. No tag, no GitHub.
- `pnpm package:dmg` — DMG only, from an existing `release/Kookaburra Cut.app`. Use after swapping
  artwork, then re-notarise just the DMG; the `.app` keeps its ticket.

## Packaged-parity gate (required before publishing)

`docs/determinism.md` makes this its own gate class: the packaged `.app` must reproduce dev-mode
hashes, because "internally deterministic" is not "correct". Quit any running Kookaburra Cut
first (one instance at a time — dev and packaged share `$APPDATA` caches), then run **one leg at
a time**:

```bash
pnpm kookaburra:run --action verify --project showcase-tour  --aspect 16:9 --app "release/Kookaburra Cut.app"
pnpm kookaburra:run --action verify --project ws:launch-2026 --aspect 16:9 --app "release/Kookaburra Cut.app"
```

`ws:launch-2026` must be **EQUAL** — the null-for-legacy proof. Compare against "Current
baselines" in `docs/determinism.md`. On any divergence, diff the `renderStateFingerprint` first.

## Traps

Each of these produces a build that signs and notarises happily, then misbehaves.

**The dev sidecar poisons the build.** `pnpm setup:ffmpeg` copies the *Homebrew* ffmpeg, which
links `/opt/homebrew` dylibs that exist on no other Mac, and it **overwrites** the release
sidecar. Instead run `pnpm setup:ffmpeg:release` (pinned static build).
`sign-and-notarize.sh` guards this with `otool -L` and refuses to proceed unless the sidecars
link system libraries only.

**Never call `trash::delete`.** The crate's default macOS backend shells out to `osascript` →
"tell Finder to delete". TCC attributes that Apple Event to *us*, and under the hardened runtime
with no `NSAppleEventsUsageDescription` it is **silently denied** — so every delete fails in a
packaged build while working perfectly in `tauri dev`, where your terminal already holds Finder
automation permission. Instead call `workspace::trash_path` (NSFileManager), which needs no
entitlement and still records Put Back.

**Entitlements must stay empty.** Nothing in the shell needs one: no in-process JIT (WebKit's
lives in its own process), no `dlopen`, no `DYLD_*`, no Apple Events, and the sidecars are
separate signed processes rather than loaded code. If you find yourself adding an entitlement,
you have almost certainly introduced one of the above by accident — fix the cause instead.

**Artefacts go in `release/`, never `dist/`.** `dist/` is Vite's `frontendDist` and `vite build`
empties it, deleting anything you leave there.

**Never set `bundle.createUpdaterArtifacts`.** It tars the bundle during `tauri build`, BEFORE
notarisation staples the ticket, so updater-installed copies would miss the offline Gatekeeper
proof. `sign-and-notarize.sh` hand-rolls the tar from the stapled app and signs it with
`pnpm tauri signer sign`; `release.sh` writes `latest.json` from that signature. Also note the
in-app updater only sees a release once it is **published** — the draft 404s at
`releases/latest/download/latest.json`, which the app reports calmly as a failed check.

**The ffmpeg sidecar is GPL** (libx264). It ships as an arm's-length sidecar *process*, so the app
is not forced GPL, but public distribution must offer the source — `release.sh`'s notes point at
`scripts/build-ffmpeg-sidecar.sh` and ffmpeg.org. Do **not** "fix" this with `LICENSE=lgpl`: that
drops libx264, which is the deterministic default encoder, and invalidates every baseline.

## DMG artwork

`src-tauri/dmg/dmg_bg.png` (806×488) and `dmg_bg@2x.png` (1612×976) — an exact 2:1 pair.
`make-dmg.sh` checks both dimensions, then `tiffutil -cathidpicheck` merges them into a
multi-rep TIFF (**1x first**) so Finder serves the Retina rep.

The AppleScript icon positions are measured off the artwork, in 1x window points:

- Drop-target circle centres are `(170,253)` and `(635,253)`. Finder lands an icon **~3pt low**,
  so the script requests `y=250`.
- The **label plates** at `y=316..345` catch the two labels. They exist because Finder draws icon
  labels in the *system* label colour — black in Light Mode, white in Dark — and a DMG cannot
  override it. A dark background alone is unreadable in Light Mode.

Swapping art: replace both PNGs at exactly those sizes, re-measure the circle and plate centres,
retune the positions and window bounds in `make-dmg.sh`, then `pnpm package:dmg` and re-notarise
the DMG alone.

## Verify

Run all of these and fix until clean:

```bash
codesign -dvv "release/Kookaburra Cut.app"                  # flags=0x10000(runtime), Authority=Developer ID Application, a Timestamp
codesign -d --entitlements - "release/Kookaburra Cut.app"   # expect NO entitlements
xcrun stapler validate "release/Kookaburra Cut.app"         # "The validate action worked!"
xcrun stapler validate release/KookaburraCut-<version>.dmg  # same
spctl -a -t exec -vv "release/Kookaburra Cut.app"           # accepted, source=Notarized Developer ID
```

Then launch the app, confirm it boots, and run the packaged-parity gate.

## Troubleshooting

- **Finder styling fails (`-1728`)** — grant the terminal Automation permission (System Settings >
  Privacy & Security > Automation) and re-run. `make-dmg.sh` already retries four times and
  detaches a stray `/Volumes/Kookaburra Cut` on pre-flight.
- **notarytool returns `Invalid`** — `xcrun notarytool log <submission-id> --keychain-profile
  kookaburra-cut` names the offending binary. Usually an unsigned or dylib-linked sidecar.
- **App launches then quits in a packaged build only** — suspect the CSP or a TCC denial, not the
  signature. `docs/determinism.md` ("Packaged-app parity") lists the known silent failures.
