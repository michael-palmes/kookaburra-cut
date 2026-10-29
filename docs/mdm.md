# Managed preferences

How an administrator pins a fleet of Macs to the posture their policy needs,
with the same build everyone else runs. A configuration profile forces keys in
the app's preference domain, `com.mpalmes.kookaburracut`, and the app honours a
key only while macOS reports it as forced (`CFPreferencesAppValueIsForced`). A
plain `defaults write` sets the key without forcing it, so it changes nothing.
Unmanaged Macs see no difference at all.

Two rules hold throughout:

- **Both must allow it.** A managed key is a ceiling. Where a profile turns a
  thing off, the user's own setting cannot turn it back on; where a profile
  says nothing, the user's setting decides as before.
- **Fail closed.** A forced key of the wrong type (a string where a boolean
  belongs, a number in a list of key ids) is treated as the most restrictive
  setting, and the app logs a `[managed]` line naming the key. A profile that
  is wrong never opens anything up.

The policy is read once per launch (`src-tauri/src/managed.rs`); a profile
installed or removed while the app runs takes effect at the next launch.

## Keys

| Key | Type | When forced |
| --- | --- | --- |
| `DisableClaude` | boolean | `true` removes every Claude entry point: the launcher that greets a new project, the Edit with Claude titlebar button and palette command, the Project menu item, the built-in terminal rail, the Create with Claude start card and the theme card's Edit with Claude. The `claude://` handoff (`open_in_claude`), the Claude download page, the Claude terminal launch (`pty_spawn`) and the Claude version probe (`claude_version_info`) refuse with the managed reason and touch no network. Settings ▸ Claude shows locked rows |
| `DisableLiveWebsites` | boolean | `true` makes `website_open` refuse, so no child browser view ever opens for a scene website in the editor or during a Present hold. Captured website PNGs still render in previews and exports. The editor's website panel shows the locked state in place of Open live website |
| `AllowedPublisherKeyIds` | array of strings | Pack imports are limited to packs signed by these publisher key ids (the 16 hex characters a publisher shows under Settings ▸ Publisher, with or without the spaces). `inspect_pack` and `stage_pack` refuse any other pack before anything is written, naming the policy. An empty forced array means no pack imports at all. The id is recomputed from the pack's public key, never read from its manifest |
| `DisableUpdateCheck` | boolean | `true` pins update consent off: no launch check, the first-run welcome shows the reason in place of its switch, Settings ▸ Updates locks the switch and Check now, the Check for Updates menu item is gone, and `check_for_update` and `install_update_and_relaunch` refuse. The Rust side records consent as off whatever a switch asks for |
| `WorkspaceRoot` | string | An absolute path (a leading `~/` expands to the user's home). The app keeps projects, themes, fonts and brands there, creating the folder on first launch; `init_workspace` and `move_workspace` refuse, and Settings ▸ Workspace shows the fixed path with a lock in place of Change location. A relative or malformed path locks relocation without moving anything |

A key that is forced to `false` (or an empty `WorkspaceRoot`) still marks the
install as managed, which only matters for the boot log line. Under
`DisableUpdateCheck` the first-run welcome's Get started records the consent
it showed (off), so lifting the profile later leaves launch checks off until
the person turns the Settings switch on; the welcome is not asked twice.

## What a managed user sees

Nothing is greyed out: an entry point that policy removes is gone, and a
Settings row that policy governs shows a lock icon and "Managed by your
organisation" in place of its control, with the key named in the tooltip. A
command a page still manages to call answers with a one-line reason that starts
with `managed:` and names the key, for example:

```
managed: Claude is turned off by your organisation (DisableClaude).
```

## A sample profile

The payload below forces three keys. Install it with `profiles install -path`,
or through the MDM of your choice (Jamf, Kandji, Mosyle and the rest all
deliver a custom settings payload for a domain; their "application & custom
settings" form with `com.mpalmes.kookaburracut` as the preference domain lands
the same forced keys). Replace the UUIDs with your own.

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
      <string>com.example.kookaburracut.settings</string>
      <key>PayloadUUID</key>
      <string>6C3F3A2E-0F1B-4C1D-9A2B-3D4E5F607182</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
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
                <key>DisableUpdateCheck</key>
                <true/>
                <key>AllowedPublisherKeyIds</key>
                <array>
                  <string>a1b2c3d4e5f60718</string>
                </array>
              </dict>
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Kookaburra Cut settings</string>
  <key>PayloadIdentifier</key>
  <string>com.example.kookaburracut</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>0B9D1F2A-7E3C-4A5B-8C6D-9E0F1A2B3C4D</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadScope</key>
  <string>System</string>
</dict>
</plist>
```

## Verifying

1. On the Mac, `defaults read com.mpalmes.kookaburracut DisableClaude` prints
   `1`: `defaults` composes managed values into what it shows.
2. Launch the app. Settings ▸ Claude shows locked rows, the titlebar has no
   Edit with Claude, the Project menu has no Edit with Claude item, and a new
   project opens without the launcher.
3. In a dev build, the terminal that runs `pnpm tauri dev` shows
   `[managed] configuration profile forces: DisableClaude` at boot, plus one
   line per malformed key.
4. The negative check: without a profile,
   `defaults write com.mpalmes.kookaburracut DisableClaude -bool true` changes
   nothing, because the key is set but not forced. `defaults delete` it
   afterwards.

### Without a profile, on a dev Mac

Managed preferences are what macOS composes from
`/Library/Managed Preferences/<user>/<domain>.plist` (and the machine-wide
`/Library/Managed Preferences/<domain>.plist`), so a forced key can be laid
down there for a quick check without an MDM, root only:

```bash
sudo defaults write "/Library/Managed Preferences/$USER/com.mpalmes.kookaburracut" DisableClaude -bool true
```

If the running app does not see it, `sudo killall cfprefsd` makes the
preferences daemon re-read the folder; then relaunch the app. Remove the file
to lift the policy:

```bash
sudo rm "/Library/Managed Preferences/$USER/com.mpalmes.kookaburracut.plist"
```

## For contributors

- Every guard lives in `src-tauri/src/managed.rs`: `deny_claude`,
  `deny_live_websites`, `deny_update_check`, `deny_workspace_change` and
  `deny_publisher`, each a one-line call at the top of the command it governs.
  A new managed key adds a `Key`, a field on `ManagedPolicy`, a parse arm in
  `from_source`, a guard, a row here and a unit test.
- The webviews read the effective policy through `managed_policy` (the
  `managed` permission set, granted to the main and settings windows) via
  `src/engine/managed.ts`; the Rust guards stand on their own, so a page that
  never reads the policy still cannot cross it.
- Refusals carry the `managed:` marker so the UI can tell policy from a fault
  (`isManagedRefusal`, `plainError`).
