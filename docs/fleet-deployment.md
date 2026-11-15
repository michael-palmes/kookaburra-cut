# Deploying Kookaburra Cut with an MDM

Written against version 0.22.4, the current release, and what 0.23.0 adds;
wherever 0.23.0 differs, the text says so. Copy-paste recipes for Jamf Pro,
Kandji (now Iru), Mosyle and Microsoft Intune: install the app, force a posture
with a configuration profile, check a Mac, serve updates from your own server,
and remove it. Which keys to force and why is in [fleet.md](./fleet.md); what
each key does is in [mdm.md](./mdm.md); the control behind each is in
[SECURITY.md](../SECURITY.md). The files these recipes use are in
[`packaging/mdm/`](../packaging/mdm/), and `scripts/fleet-profiles.test.mjs`
checks them against `src-tauri/src/managed.rs`.

Console paths come from each vendor's public documentation in November 2026,
and vendors rename them; the files and commands are what matter. None of these
recipes has run on a live tenant yet ([Not yet](#not-yet)).

## Before you start

- **Macs.** Apple Silicon on macOS 26 or later (`minimumSystemVersion` in
  `src-tauri/tauri.conf.json`; the release notes in
  `.github/workflows/release.yml` say there is no Intel build).
- **The release.** Verify it first ([fleet.md, "Verify a
  release"](./fleet.md#verify-a-release)), then take the DMG's SHA-256 from its
  `SHA256SUMS`. For 0.22.4 that is
  `a71315babdc38eac53dfcb75163416709721b8edb515db1385ac214c86e35278`.
- **The version.** Managed keys start at 0.22.2: an earlier build honours none
  ([Choose a posture](#2-choose-a-posture) says which key arrives when).
- **One updater per Mac.** Either your MDM delivers each version, or the in-app
  updater does, from GitHub or your own mirror ([Updates](#4-updates)).

## 1. Install the app

### Today: the DMG

The release ships a drag-and-drop DMG, `KookaburraCut-<version>.dmg`.
[`install-kookaburra-cut.sh`](../packaging/mdm/install-kookaburra-cut.sh)
installs it unattended as root. It downloads over HTTPS only, checks the file
against the SHA-256 you pin, checks the app's code signature, Developer ID team
`Q4B8N8ZKA2` ([fleet.md](./fleet.md#verify-a-release)), Gatekeeper verdict and
version, copies it to `/Applications` owned by root, and checks it again there.
It does nothing when that version or a newer one is installed, so it never
undoes an in-app update, and refuses while the app is open, so a recurring run
tries again later.

| Parameter | Default | Set it to |
| --- | --- | --- |
| 4 | `0.22.4` | The version to install |
| 5 | 0.22.4's DMG SHA-256 | That version's DMG line in `SHA256SUMS` |
| 6 | The GitHub release's download folder | Your own copy of the DMG's folder, for Macs that cannot reach GitHub (HTTPS only) |

Jamf Pro passes parameters 4 to 6 (1 to 3 are its own). Elsewhere, edit the
three defaults at the top. It exits 0 when installed or already current, 1 when
a download or check fails, 2 on an Intel Mac or one older than macOS 26, and 3
while the app is open.

```bash
#!/bin/bash
# Installs Kookaburra Cut from its release DMG once the pinned SHA-256 and Developer ID team check out (docs/fleet-deployment.md).
set -euo pipefail

VERSION="${4:-0.22.4}"
DMG_SHA256="${5:-a71315babdc38eac53dfcb75163416709721b8edb515db1385ac214c86e35278}"
BASE_URL="${6:-https://github.com/michael-palmes/kookaburra-cut/releases/download/v$VERSION}"

TEAM_ID="Q4B8N8ZKA2"
APP="/Applications/Kookaburra Cut.app"
DMG="KookaburraCut-$VERSION.dmg"

say() { echo "kookaburra-cut: $*"; }
fail() {
  say "$1"
  exit "${2:-1}"
}
version_of() {
  [ -f "$1/Contents/Info.plist" ] || return 0
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || true
}
check() {
  codesign --verify --deep --strict "$1" 2>/dev/null || fail "$1 fails its code signature check"
  local signer
  signer="$(codesign -dv "$1" 2>&1)"
  grep -qx "TeamIdentifier=$TEAM_ID" <<<"$signer" || fail "$1 is not signed by team $TEAM_ID"
  spctl -a -t exec "$1" 2>/dev/null || fail "Gatekeeper rejects $1"
  [ "$(version_of "$1")" = "$VERSION" ] || fail "$1 is not version $VERSION"
}

[ "$(id -u)" -eq 0 ] || fail "run this as root, as your MDM does"
[ "$(uname -m)" = arm64 ] || fail "Kookaburra Cut needs Apple Silicon" 2
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] || fail "Kookaburra Cut needs macOS 26 or later" 2
installed="$(version_of "$APP")"
if [ "$installed" = "$VERSION" ]; then
  say "$VERSION is already installed"
  exit 0
fi
if [ -n "$installed" ] && [ "$(printf '%s\n' "$installed" "$VERSION" | sort -V | tail -1)" = "$installed" ]; then
  say "$installed is newer than $VERSION; leaving it"
  exit 0
fi
if pgrep -qf "^$APP/Contents/MacOS/"; then
  fail "the app is open; the next run tries again" 3
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/kookaburra-cut.XXXXXX")"
trap 'hdiutil detach -quiet "$work/mnt" 2>/dev/null || true; rm -rf "$work"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/$DMG" "$BASE_URL/$DMG" || fail "could not download $BASE_URL/$DMG"
echo "$DMG_SHA256  $work/$DMG" | shasum -a 256 -c - >/dev/null 2>&1 || fail "$DMG does not match the pinned SHA-256"

mkdir "$work/mnt" "$work/stage"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$work/mnt" "$work/$DMG" || fail "could not open $DMG"
check "$work/mnt/Kookaburra Cut.app"
ditto "$work/mnt/Kookaburra Cut.app" "$work/stage/Kookaburra Cut.app"
chown -R root:wheel "$work/stage/Kookaburra Cut.app"
check "$work/stage/Kookaburra Cut.app"

rm -rf "$APP"
mv "$work/stage/Kookaburra Cut.app" "$APP" || fail "could not move the new app into /Applications"
check "$APP"
say "installed $VERSION"
```

### From the release after 0.23.0: the pkg

`KookaburraCut-<version>.pkg` ships beside the DMG from the release after
0.23.0: the same app, installed into `/Applications` with no prompts, signed
with a Developer ID Installer certificate of the same team, notarised and
stapled (`scripts/sign-and-notarize.sh` once that work lands). Check it before
you upload it:

```bash
pkgutil --check-signature KookaburraCut-<version>.pkg   # Developer ID Installer: ... (Q4B8N8ZKA2)
spctl -a -vv -t install KookaburraCut-<version>.pkg     # accepted, source=Notarized Developer ID
```

Its receipt is `com.mpalmes.kookaburracut`, the bundle identifier
(`identifier` in `src-tauri/tauri.conf.json`).

### Jamf Pro

- **DMG.** A drag-and-drop DMG does not install from Packages as it is (Jamf's
  [Package Deployment](https://learn.jamf.com/r/en-US/jamf-pro-documentation-11.30.0/Package_Deployment)
  sends you to Composer), so use the script. Settings ▸ Computer management ▸
  Scripts: add `install-kookaburra-cut.sh` and label parameters 4 to 6
  "Version", "DMG SHA-256" and "DMG base URL (optional)". Then a policy with that
  script, its parameters filled, your scope, the Recurring Check-in trigger and
  an Ongoing frequency: the script exits at once while the version is current.
- **pkg.** Settings ▸ Computer management ▸ Packages: upload the pkg. A policy
  with a Packages payload set to Install, scoped to a smart group whose
  Application Title is `Kookaburra Cut.app` and Application Version is not the
  new version.
- **Profile.** Computers ▸ Configuration Profiles ▸ Upload: choose a
  `.mobileconfig` from `packaging/mdm/` and scope it.

### Kandji (now Iru)

Kandji is now Iru
([brand update](https://docs.iru.com/en/iru/platform-overview/iru-brand-update));
the Library items kept their names.

- **DMG.** A Custom App Library item takes the DMG and extracts its app into
  `/Applications`
  ([Custom Apps overview](https://docs.iru.com/en/endpoint/library/library-items-profiles/custom-apps-overview)).
  Iru installs what you upload, so upload only a DMG you verified. Choose
  Audit and enforce with this audit script, which fails (and so reinstalls)
  when the app is missing or another version; change the version at each
  update:

  ```bash
  #!/bin/bash
  v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/Kookaburra Cut.app/Contents/Info.plist" 2>/dev/null)"
  [ "$v" = "0.22.4" ]
  ```

  Or run `install-kookaburra-cut.sh` as a Custom Script instead, which also
  checks the team and the hash on each Mac. Assign either to your Blueprint.
- **pkg.** The same Custom App item takes the pkg.
- **Profile.** A Custom Profile Library item takes the `.mobileconfig`
  ([Custom Profiles overview](https://docs.iru.com/en/endpoint/library/library-items-profiles/custom-profiles-overview));
  assign it to the Blueprint.

### Mosyle

We found no public Mosyle documentation for these steps, so these names come
from other vendors' Mosyle guides.

- **DMG.** A Custom Command running `install-kookaburra-cut.sh` with its
  defaults edited. Custom Commands run as root; set it to repeat, since the
  script does nothing once the version is current.
- **pkg.** Upload the pkg as a custom app for macOS (Management ▸ Apps).
- **Profile.** Management ▸ Certificates / Custom Profiles: upload the
  `.mobileconfig`.

### Microsoft Intune

- **DMG.** Apps ▸ macOS ▸ Add ▸ macOS app (DMG)
  ([Microsoft Learn](https://learn.microsoft.com/mem/intune/apps/lob-apps-macos-dmg)).
  Upload the DMG you verified. Detection: bundle ID `com.mpalmes.kookaburracut`
  and the version. Ignore app version: No when Intune delivers every update,
  Yes when the in-app updater runs, as Microsoft advises for apps that update
  themselves. The app's `LSMinimumSystemVersion` of 26.0 stops older Macs
  opening it whatever minimum you pick.
- **pkg.** Apps ▸ macOS ▸ Add ▸ macOS app (PKG), with the same detection.
- **Profile.** Devices ▸ macOS ▸ Configuration ▸ Create ▸ New policy ▸
  Templates ▸ Custom: upload the `.mobileconfig` with Deployment channel set to
  Device channel, since the profiles are `PayloadScope` System. The channel
  cannot change once saved
  ([custom settings](https://learn.microsoft.com/en-us/mem/intune/configuration/custom-settings-macos)).
- **Scripts.** Devices ▸ macOS ▸ Shell scripts, with "Run script as signed-in
  user" set to No, for the uninstall script below.

## 2. Choose a posture

Three profiles, one per common posture. Each forces only the keys shown, in the
domain `com.mpalmes.kookaburracut` (`DOMAIN` in `managed.rs`).

| Key | From | Locked down | Agents allowed, updates mirrored | Open |
| --- | --- | --- | --- | --- |
| `DisableClaude` | 0.22.2 | `true` | not forced | not forced |
| `DisableLiveWebsites` | 0.22.2 | `true` | `true` | not forced |
| `AllowedPublisherKeyIds` | 0.22.2 | `[]`: no pack imports | your approved key ids | not forced |
| `DisableUpdateCheck` | 0.22.2 | `true` | not forced | not forced |
| `WorkspaceRoot` | 0.22.2 | `~/Kookaburra Cut` | `~/Kookaburra Cut` | not forced |
| `DisableAgentKit` | 0.22.3 | `true` | not forced | not forced |
| `DisablePackExport` | 0.22.3 | `true` | not forced | not forced |
| `ExportsInProject` | 0.22.3 | `true` | `true` | `true` |
| `UpdateEndpoint` | 0.22.3 | your mirror | your mirror | not forced |
| `AuditLogPath` | 0.23.0 | `/Library/Logs/Kookaburra Cut` | not forced | not forced |

The files: [`kookaburra-cut-locked-down.mobileconfig`](../packaging/mdm/kookaburra-cut-locked-down.mobileconfig),
[`kookaburra-cut-agents-mirrored.mobileconfig`](../packaging/mdm/kookaburra-cut-agents-mirrored.mobileconfig)
and [`kookaburra-cut-open.mobileconfig`](../packaging/mdm/kookaburra-cut-open.mobileconfig).
The From column is the first release whose `Key::ALL` in `managed.rs` holds the
key, and an older build ignores it: deploy 0.22.3 or later, since on 0.22.2 the
open profile changes nothing and the mirrored one leaves checks on GitHub.
`AuditLogPath` needs 0.23.0.

- **Locked down** forces all ten. Its `AuditLogPath` copies the app log for
  your collector; on a Mac with more than one account, create the folder first
  ([mdm.md, "A copy for your collector"](./mdm.md#a-copy-for-your-collector)).
  `UpdateEndpoint` does nothing while
  `DisableUpdateCheck` is forced, since that key wins ([mdm.md](./mdm.md)); it is
  there so that lifting `DisableUpdateCheck` later sends checks to your server,
  never GitHub.
- **Agents allowed, updates mirrored** follows [fleet.md](./fleet.md#force-the-keys)
  where Claude Code is approved: Claude and the agent kit stay on, so deploy
  Claude Code's own managed settings beside it
  ([fleet.md](./fleet.md#claude-codes-own-managed-settings-on-top)), and update
  checks go to your mirror ([Updates](#4-updates)). Replace
  `a1b2c3d4e5f60718`, the sample id [mdm.md](./mdm.md) uses, with your approved
  publishers' key ids, or leave the array empty for no imports.
- **Open** leaves every feature to the person and forces only
  `ExportsInProject`, the one key all three share. fleet.md recommends more for
  unreleased work.
- **`WorkspaceRoot` `~/Kookaburra Cut`** fixes the default, a local folder, so
  nobody moves projects into a synced one. Someone who already moved their
  workspace finds an empty one at the fixed path, and Settings cannot move it,
  so move their projects in first ([mdm.md](./mdm.md), `WorkspaceRoot`).

For all three:

- Before uploading, replace `com.example` in each `PayloadIdentifier` with your
  own reverse domain, each `PayloadUUID` with a fresh `uuidgen`, and the
  `UpdateEndpoint` URL with your mirror's. `plutil -lint <file>` checks the file
  after editing.
- Every key sits under `Forced` in a `com.apple.ManagedClient.preferences`
  payload: the app ignores a key macOS does not report as forced, so a
  "Set once" or "Often" setting does nothing ([mdm.md](./mdm.md)).
- One posture per Mac. Two profiles forcing the same key conflict, so scope each
  to its own group.
- A Mac picks up a new or changed profile at the app's next launch, since the
  policy is read once per launch (`managed.rs`).

The locked-down profile in full:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.ManagedClient.preferences</string>
      <key>PayloadIdentifier</key>
      <string>com.example.kookaburracut.locked-down.preferences</string>
      <key>PayloadUUID</key>
      <string>B502D3FD-C27F-4937-A23A-944C9F712DD8</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadDisplayName</key>
      <string>Kookaburra Cut managed preferences</string>
      <key>PayloadContent</key>
      <dict>
        <key>com.mpalmes.kookaburracut</key>
        <dict>
          <key>Forced</key>
          <array>
            <dict>
              <key>mcx_preference_settings</key>
              <dict>
                <key>DisableClaude</key>
                <true/>
                <key>DisableAgentKit</key>
                <true/>
                <key>DisableLiveWebsites</key>
                <true/>
                <key>AllowedPublisherKeyIds</key>
                <array/>
                <key>DisablePackExport</key>
                <true/>
                <key>ExportsInProject</key>
                <true/>
                <key>WorkspaceRoot</key>
                <string>~/Kookaburra Cut</string>
                <key>DisableUpdateCheck</key>
                <true/>
                <key>UpdateEndpoint</key>
                <string>https://updates.example.com/kookaburra-cut/latest.json</string>
                <key>AuditLogPath</key>
                <string>/Library/Logs/Kookaburra Cut</string>
              </dict>
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Kookaburra Cut: locked down</string>
  <key>PayloadDescription</key>
  <string>No Claude, agent kit, live websites, pack import or export, or update checks. Video and stills exports stay in each project, projects stay in ~/Kookaburra Cut, and the app log is copied to /Library/Logs/Kookaburra Cut.</string>
  <key>PayloadIdentifier</key>
  <string>com.example.kookaburracut.locked-down</string>
  <key>PayloadScope</key>
  <string>System</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>7934D11E-F86F-4B4C-83E1-CEA6F89E4FFE</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
```

## 3. Check a Mac

```bash
sudo profiles list | grep kookaburracut                                   # the profile is installed
plutil -p "/Library/Managed Preferences/com.mpalmes.kookaburracut.plist"  # what it forces for every account
defaults read com.mpalmes.kookaburracut                                    # as the person: what the app reads
```

A user-level profile lands in `/Library/Managed Preferences/<user>/` instead
([mdm.md](./mdm.md), "Without a profile, on a dev Mac"). Then ask the app:

- **0.23.0 and later.** The app log records the forced keys at each launch,
  one line per malformed key, and the first refusal of each key in a launch
  (`[managed] refused: <key>`), in `src-tauri/src/audit.rs` and `managed.rs`:

  ```bash
  grep '\[managed\]' ~/Library/Application\ Support/com.mpalmes.kookaburracut/logs/app.log
  ```

- **Before 0.23.0.** A release build keeps no log; the same boot line goes to stderr
  (`log_at_boot` in that version's `managed.rs`). Launch it from Terminal as
  the person, read the line, then quit the app:

  ```bash
  "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut" 2>&1 | grep '\[managed\]'
  ```

Either way the line reads
`[managed] configuration profile forces: DisableClaude, ...`. In the app, each
Settings row a key governs shows a lock and "Managed by your organisation"
([mdm.md, "What a managed user sees"](./mdm.md#what-a-managed-user-sees)), and
[mdm.md, "Verifying"](./mdm.md#verifying) has a check per key.

## 4. Updates

### Through your MDM

Recommended in [fleet.md](./fleet.md#updates-in-app-or-mdm-delivery): force
`DisableUpdateCheck`, verify each release, and push it with the same recipe
and a new version and hash. A Homebrew cask is staged in
[`packaging/homebrew/`](../packaging/homebrew/README.md) for fleets that
install with Homebrew; it is not published until its tap exists
([Not yet](#not-yet)).

### The in-app updater, from your own mirror

`UpdateEndpoint` (0.22.3) points the in-app updater at a manifest you host, so
the app asks your server instead of GitHub and your server decides when a
version reaches the fleet (`updater.rs`). The archive must still carry this
project's updater signature, so a mirror can serve only builds this project
signed ([mdm.md](./mdm.md), `UpdateEndpoint`).

The manifest, `latest.json`, holds:

| Field | Value |
| --- | --- |
| `version` | The release's version. The signature binds it, so a manifest cannot announce one archive as another version (`plugins.updater.requireSignedVersion` in `tauri.conf.json`, [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)) |
| `pub_date` | The release time, as GitHub's manifest gives it |
| `platforms.darwin-aarch64.signature` | The contents of `KookaburraCut-<version>-updater.app.tar.gz.sig`, as GitHub's manifest gives it |
| `platforms.darwin-aarch64.url` | Your HTTPS copy of `KookaburraCut-<version>-updater.app.tar.gz` |

`notes` may stay; the app never shows it (`updater.rs`). Build it from the
release's own manifest, checking each file first. The last check needs a
checkout of the release's tag for `scripts/verify-updater-sig.mjs`, which checks
the signature the way the app does:

```bash
V=0.23.0
MIRROR=https://updates.example.com/kookaburra-cut
D="$(mktemp -d)"
gh release download "v$V" --repo michael-palmes/kookaburra-cut -D "$D" \
  -p latest.json -p SHA256SUMS -p "KookaburraCut-$V-updater.app.tar.gz" -p "KookaburraCut-$V-updater.app.tar.gz.sig"
(cd "$D" && shasum -a 256 -c SHA256SUMS --ignore-missing)
gh attestation verify "$D/KookaburraCut-$V-updater.app.tar.gz" --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref "refs/tags/v$V" --deny-self-hosted-runners
node scripts/verify-updater-sig.mjs "$D/KookaburraCut-$V-updater.app.tar.gz" \
  "$D/KookaburraCut-$V-updater.app.tar.gz.sig" "$(jq -r .plugins.updater.pubkey src-tauri/tauri.conf.json)" "$V"
jq --arg url "$MIRROR/KookaburraCut-$V-updater.app.tar.gz" \
  '.platforms["darwin-aarch64"].url = $url' "$D/latest.json" > "$D/latest.mirror.json"
```

Upload `KookaburraCut-<version>-updater.app.tar.gz` to `$MIRROR/`, then
`latest.mirror.json` as `$MIRROR/latest.json`, in that order, so no Mac reads a
manifest before its archive is there. Force `UpdateEndpoint` to
`$MIRROR/latest.json`.

- **The URL.** `https`, with no query, fragment, login or `{{...}}` template
  (`usable_endpoint` in `managed.rs`), so a pre-signed or token URL fails.
  Restrict the server by network, not by credentials in the URL. Anything else
  means no update check at all, never a fallback to GitHub.
- **Your CA.** The updater checks the server's certificate with
  `rustls-platform-verifier` (`src-tauri/Cargo.lock`), which asks macOS's own
  trust settings, so a root your MDM installs as trusted should work. Try one
  Mac first ([Not yet](#not-yet)).
- **What a person sees.** Automatic checks run only once the person agreed in
  the first-run welcome, at most every 20 hours (`AUTO_CHECK_THROTTLE_MS` in
  `src/engine/updates.ts`). The install script leaves the app owned by root,
  and replacing an app the person cannot write asks for an administrator
  password ([SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac)), so the
  in-app path suits Macs whose people are administrators.
- **Rollback.** Neither the updater nor the install script installs an older
  version over a newer one, so to go back, delete `/Applications/Kookaburra
  Cut.app` and run the install script with the older version and hash.

## 5. Remove it

[`uninstall-kookaburra-cut.sh`](../packaging/mdm/uninstall-kookaburra-cut.sh),
run as root, removes the app, the pkg receipt where there is one, and for every
account under `/Users` the same paths the Homebrew cask's `zap` trashes
([`kookaburra-cut.rb`](../packaging/homebrew/Casks/kookaburra-cut.rb)), the
paths [SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac) lists as the app's
own. It exits 0 when done, 1 when not run as root, and 3 while the app is open.

```bash
#!/bin/bash
# Removes Kookaburra Cut and each account's app data, the cask's zap list; projects and Keychain keys stay (docs/fleet-deployment.md).
set -euo pipefail

APP="/Applications/Kookaburra Cut.app"

[ "$(id -u)" -eq 0 ] || {
  echo "kookaburra-cut: run this as root, as your MDM does"
  exit 1
}
if pgrep -qf "^$APP/Contents/MacOS/"; then
  echo "kookaburra-cut: the app is open; the next run tries again"
  exit 3
fi

rm -rf "$APP"
if pkgutil --pkg-info com.mpalmes.kookaburracut >/dev/null 2>&1; then
  pkgutil --forget com.mpalmes.kookaburracut >/dev/null
fi

for home in /Users/*; do
  [ -d "$home/Library" ] || continue
  rm -rf \
    "$home/Kookaburra Cut/_autorun" \
    "$home/Kookaburra Cut/_bridge" \
    "$home/Library/Application Support/com.mpalmes.kookaburracut" \
    "$home/Library/Caches/com.mpalmes.kookaburracut" \
    "$home/Library/Preferences/com.mpalmes.kookaburracut.plist" \
    "$home/Library/WebKit/com.mpalmes.kookaburracut"
done
echo "kookaburra-cut: removed"
```

That covers settings, caches, the app log (0.23.0), the pack key's fallback
file, the live website store and the agent bridge. What it leaves:

- **Projects.** Each workspace (`~/Kookaburra Cut`, or the `WorkspaceRoot` you
  forced) holds the person's projects; keep, archive or delete them under your
  retention policy. A kept project's kit files (`.claude/`, `./kb`, `.kb/`,
  `CLAUDE.md`) are safe to delete ([agent-kit.md](./agent-kit.md)).
- **The pack signing key.** A login Keychain item, which neither a root script
  nor a cask can remove. The person runs
  `security delete-generic-password -s "Kookaburra Cut pack signing key"`, or
  deletes it in Keychain Access (`src-tauri/src/pack/key.rs`). Packs it signed
  stay valid.
- **The profile.** Remove it from the Mac's scope in your MDM.
- **`~/.claude`.** Claude Code's own; the app never writes it.

With Homebrew, `brew uninstall --zap --cask kookaburra-cut` removes the same
paths, for the account that runs it only.

## Not yet

- The pkg ships from the release after 0.23.0; until then, the DMG and the
  install script.
- The Homebrew tap `michael-palmes/homebrew-kookaburra-cut` does not exist yet;
  the cask is staged in `packaging/homebrew/` with its audit record.
- None of these recipes has run on a live Jamf Pro, Iru, Mosyle or Intune
  tenant. The install and uninstall scripts ran against the v0.22.2 release with
  `/Applications` and `/Users` pointed at a scratch folder, and the mirror recipe
  against v0.22.2's assets; the profiles pass `plutil -lint` but have not been
  installed on a Mac here.
- A mirror behind a private certificate authority is untested.
