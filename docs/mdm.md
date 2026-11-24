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

## Installing with the pkg

From 0.23.0 each release carries `KookaburraCut-<version>.pkg` beside the DMG,
for an MDM to install with no prompts: Jamf, Kandji, Mosyle and Intune take
it as it is, and `docs/fleet-deployment.md` has a recipe for each. It installs
one thing, `Kookaburra Cut.app`, into `/Applications`, owned by `root:wheel`,
with no install scripts; only into the system domain, only on macOS 26.0+ on
Apple Silicon; and it is not relocatable, so Installer writes `/Applications`
rather than a stray copy of the app elsewhere. It is signed with a Developer ID
Installer certificate from the app's team, notarised and stapled
(`scripts/sign-and-notarize.sh`); `scripts/verify-release.sh` checks each of
these on every release, and `SECURITY.md` ("Release integrity", "Installer
package") lists the commands to check a download yourself. The receipt is
`com.mpalmes.kookaburracut` (`pkgutil --pkg-info com.mpalmes.kookaburracut`).

- **Upgrades.** The next release's pkg replaces the bundle in place. Projects,
  settings and app data live outside it (`~/Kookaburra Cut` and
  `~/Library/Application Support/com.mpalmes.kookaburracut`), so they stay. The
  package is version checked (`bundle-version` in its `PackageInfo`), so a pkg
  older than the installed app leaves the app alone.
- **The in-app updater** still runs on a pkg install, but it cannot replace a
  root-owned bundle as the user, so it asks for an administrator's password
  (`install_update_and_relaunch` in `src-tauri/src/updater.rs` hands the swap
  to `tauri-plugin-updater`, which falls back to an authorised move). A
  standard user cannot finish it, and an update that does finish leaves the
  bundle owned by the user who ran it until the next pkg, while the receipt
  still names the version the pkg installed. On a fleet, push each release's
  pkg and force `DisableUpdateCheck`, or `UpdateEndpoint` to keep in-app
  updates from your own mirror.
- **Removing it.** Delete `/Applications/Kookaburra Cut.app`, then
  `sudo pkgutil --forget com.mpalmes.kookaburracut`; the two folders above
  stay until someone deletes them. `packaging/mdm/uninstall-kookaburra-cut.sh`,
  run as root, does both and clears each account's app data, leaving projects
  and the Keychain key (`docs/fleet-deployment.md`, "Remove it").

## Keys

| Key | Type | When forced |
| --- | --- | --- |
| `DisableClaude` | boolean | `true` removes every Claude entry point: the launcher that greets a new project, the Edit with Claude titlebar button and palette command, the Project menu item, the Create with Claude start card and the theme card's Edit with Claude. The `claude://` handoff (`open_in_claude`) and the Claude download page refuse with the managed reason and touch no network. Settings ▸ Claude shows locked rows, the Use Claude switch among them, and `set_claude_consent` records off whatever it is asked, so Claude can't be turned on while the key is forced |
| `AllowedPublisherKeyIds` | array of strings | Pack imports are limited to packs signed by these publisher key ids (the 16 hex characters a publisher shows under Settings ▸ Publisher, with or without the spaces). `inspect_pack` and `stage_pack` refuse any other pack before anything is written, naming the policy. An empty forced array means no pack imports at all. The id is recomputed from the pack's public key, never read from its manifest |
| `DisableUpdateCheck` | boolean | `true` pins update consent off: no automatic checks, the first-run welcome shows the reason in place of its switch, Settings ▸ Updates locks the switch and Check now, the Check for Updates menu item is gone, and `check_for_update` and `install_update_and_relaunch` refuse. The Rust side records consent as off whatever a switch asks for |
| `WorkspaceRoot` | string | An absolute path (a leading `~/` expands to the user's home). The app keeps projects, themes, fonts and brands there, creating the folder on first launch; `init_workspace` and `move_workspace` refuse, and Settings ▸ Workspace shows the fixed path with a lock in place of Change location. A relative or malformed path locks relocation without moving anything |
| `DisableAgentKit` | boolean | `true` stops everything the app does for an agent. `stamp_claude_provisioning` and `heal_project_kit` write, move and heal nothing, so a project gets no `./kb`, `.kb/`, `.claude/`, `CLAUDE.md` or skills (a kit already in a folder is left as it is), and a pack import keeps no default `CLAUDE.md` (`pack/apply.rs`). The bridge never serves, whatever `KOOKABURRA_BRIDGE` says, and `bridge_root` refuses, so the app never creates `~/Kookaburra Cut/_bridge` (`bridge.rs`); kb in a kit stamped before the profile can still write requests there, and nothing answers them. Every Claude entry point closes as it does under `DisableClaude`, since Claude Code without the kit would run without its rules, and Settings ▸ Claude locks the Agent kit row. `DisableClaude` alone leaves the kit on where the person had already turned Claude on, for people who run Claude Code themselves. With neither key forced, the same gate stays shut until a person turns Claude on (`agent_gate.rs`) |
| `DisablePackExport` | boolean | `true` removes File ▸ Export Pack…, and `open_pack_export`, `build_pack` and `rotate_publisher_key` refuse before any dialog, so the app never creates a pack signing key in the Keychain (`pack/commands.rs`, `pack/publisher.rs`). Settings ▸ Publisher shows locked rows. Imports stay with `AllowedPublisherKeyIds` |
| `ExportsInProject` | boolean | `true` keeps every video and stills export started in the app in the project's `exports/` folder: a request for Downloads is routed there rather than refused (`export_dir_kind` in `lib.rs`), `set_export_to_downloads` records off whatever it is asked, and Settings ▸ Video locks Save exports to Downloads. `.kbpack` files keep their Save dialog; terminal and bridge runs already use the project |
| `UpdateEndpoint` | string | An `https` URL of the update manifest your organisation serves, with no query, fragment, login or `{{…}}` template. A release build's `check_for_update` asks it instead of GitHub (`updater.rs`). The archive's signature is still checked against the key pinned in the app (`plugins.updater.pubkey` in `tauri.conf.json`), so a mirror can serve only builds this project signed; the manifest's `platforms.darwin-aarch64.url` must point at the mirror's copy of the archive. A malformed value means no check at all, never a fallback to GitHub: Check for Updates is gone and Settings ▸ Updates shows the lock with the reason. `DisableUpdateCheck` still wins |
| `AuditLogPath` | string | An absolute folder outside every home folder, such as `/Library/Logs/Kookaburra Cut`. The app also appends every line of its log to `<folder>/<login>.log`, the login name read from the password database (`audit::mirror_at_launch`), so a collector running as root (Jamf, Kandji, Intune, a SIEM forwarder) can pick it up. The copy is 0600, owned by the person, and rotates like `app.log` at 1 MiB with two older files kept (`audit_mirror.rs`). A missing folder is made 0700, which suits a Mac with one account; see "A copy for your collector" for shared Macs. A relative, `~`, `.` or `..` path, a home-folder path, a folder the account can't write or list, or a file there that is a link, a hard link or another account's means no copy and one `[managed]` line, never a failed launch, and the local log carries on either way. Settings ▸ About ▸ Export log tells the person their organisation's profile asks for a copy |

No pack imports at all is `AllowedPublisherKeyIds` forced to an empty array;
there is no separate switch (`deny_publisher_in` in `managed.rs`).

A key that is forced to `false` (or an empty `WorkspaceRoot`) still marks the
install as managed, which only matters for the boot log line. Under
`DisableUpdateCheck` the first-run welcome's Get started records the consent
it showed (off), so lifting the profile later leaves automatic checks off until
the person turns the Settings switch on; the welcome is not asked twice.

### Retired keys

`DisableLiveWebsites` and `AllowedWebsiteOrigins` governed live website scenes,
which were removed after 0.24.0: the app opens no website, so there is nothing
left for them to turn off. A profile that still forces either one locks
nothing and never fails closed, whatever its value, and the boot log says so
once (`RETIRED_KEYS` in `managed.rs`): `[managed] configuration profile still
forces DisableLiveWebsites: live websites were removed, so it does nothing`.
Keep forcing both while any Mac in the fleet still runs 0.24.0 or earlier,
where they are the lock on live websites; the sample profiles in
`packaging/mdm/` carry them for that reason.

## What a managed user sees

Nothing is greyed out: an entry point that policy removes is gone, and a
Settings row that policy governs shows a lock icon and "Managed by your
organisation" in place of its control, with the key named in the tooltip. A
command a page still manages to call answers with a one-line reason that starts
with `managed:` and names the key, for example:

```
managed: Claude is turned off by your organisation (DisableClaude).
```

Two keys change where things land rather than removing them: under
`ExportsInProject` the export's toast names the project's `exports/` folder,
and under `DisableAgentKit` a new project opens without `./kb`, `.kb/`,
`.claude/` or `CLAUDE.md` (`stamp_claude_provisioning` in `workspace.rs`).
`AuditLogPath` removes nothing: Settings ▸ About ▸ Export log adds "Your
organisation's profile asks for a copy of this log (AuditLogPath)."
(`src/settings/SettingsApp.tsx`), shown whenever the value is well formed,
including when the copy could not start.

## A sample profile

The payload below forces six keys. Install it with `profiles install -path`,
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
                <key>DisableAgentKit</key>
                <true/>
                <key>DisablePackExport</key>
                <true/>
                <key>ExportsInProject</key>
                <true/>
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

To keep updates but serve them from your own mirror, drop `DisableUpdateCheck`
and add `UpdateEndpoint` beside the other keys:

```xml
<key>UpdateEndpoint</key>
<string>https://updates.example.com/kookaburra-cut/latest.json</string>
```

To keep a copy of the app log where your collector reads it, add
`AuditLogPath` the same way:

```xml
<key>AuditLogPath</key>
<string>/Library/Logs/Kookaburra Cut</string>
```

## A copy for your collector

The app's own log is `~/Library/Application Support/com.mpalmes.kookaburracut/logs/app.log`
(`src-tauri/src/audit.rs`), owner-only, so a collector running as root can
already read it per user. `AuditLogPath` puts a copy at one path you choose
instead. Besides trust, pack imports, updates and refusals, it
records the moments work leaves the app: each Edit with Claude handoff
(`[claude]`), each finished video or stills export and the file it wrote
(`[export]`) and each pack export with its key id (`[pack]`), by name and path
only.

On a Mac with more than one account, create the folder in your deployment (a
package postinstall or an MDM script) before anyone launches the app, so each
account can add its own file and none can remove another's:

```bash
sudo mkdir -p "/Library/Logs/Kookaburra Cut"
sudo chown root:wheel "/Library/Logs/Kookaburra Cut"
sudo chmod 1777 "/Library/Logs/Kookaburra Cut"
```

The sticky bit stops one account renaming or removing another's files, and
each file is 0600, so accounts see one another's file names but never their
lines. The folder must stay listable (not 1733), because rotation removes the
oldest copy by name (`remove_old` in `audit_mirror.rs`). A copy is the
person's own file, so it is a record, not tamper-proof: a forwarder that tails
it ships each line within seconds. In a folder every account can write,
another account can also take a name first (`<login>.log` before that person's
first launch): the app then refuses the file, keeps no copy and says so in that
person's own log (`open_file` in `audit_mirror.rs`), so have your collector
flag an account with no file. Where that matters, create each person's empty
file ahead of time, owned by them and 0600.

Each line is one event (`audit::line`):

```
[2026-11-09T03:15:22.123Z][kookaburra_cut_lib::workspace][INFO] [trust] product-tour: allowed (/Users/x/Kookaburra Cut/product-tour)
```

The time is UTC in ISO 8601 with milliseconds, then the Rust module, the level
(`INFO` or `WARN`) and the message, which most often starts with an area tag
(`[trust]`, `[pack]`, `[managed]`, `[kit]`, `[workspace]`,
`[claude]`, `[export]`, `[update]`, `[history]`, `[privacy]`, `[audit]`). Every control character in a
message is escaped as `\u000A` and the like, so a file or folder name can never
start a line of its own. The message is prose, not key=value pairs; this
pattern splits a line for a SIEM:

```
^\[(?<time>[^\]]+)\]\[(?<module>[^\]]+)\]\[(?<level>[A-Z]+)\] (?:\[(?<area>[a-z-]+)\] )?(?<message>.*)$
```

Lines name projects, folders, media files, packs and publishers, and
never hold what is in a file (`SECURITY.md`, "On the Mac"). With
`AuditLogPath` forced, those names reach whoever reads the folder.

## Verifying

1. On the Mac,
   `defaults read "/Library/Managed Preferences/com.mpalmes.kookaburracut" DisableClaude`
   prints `1` (a user-level profile writes under
   `/Library/Managed Preferences/<user>/` instead). Don't check with plain
   `defaults read com.mpalmes.kookaburracut`: it can leave forced values out
   (it does on macOS 27), so the key looks missing while the profile works.
2. Launch the app. Settings ▸ Claude shows locked rows, the titlebar has no
   Edit with Claude, the Project menu has no Edit with Claude item, and a new
   project opens without the launcher.
3. `~/Library/Application Support/com.mpalmes.kookaburracut/logs/app.log`
   shows `[managed] configuration profile forces: DisableClaude` at boot, plus
   one line per malformed key and a `[managed] refused:` line naming the key
   the first time it refuses a command in a launch (`src-tauri/src/managed.rs`,
   `refusal`, written by `audit.rs`). A dev build prints the same lines in the terminal that runs
   `pnpm tauri dev`.
4. Under `DisableAgentKit`, a project created after launch has no `./kb`,
   `.kb/`, `.claude/` or `CLAUDE.md`, and `ls ~/"Kookaburra Cut"/_bridge` finds
   nothing (on a Mac that never ran the app or kb unmanaged; the app leaves an
   existing folder alone).
5. Under `DisablePackExport`, the File menu has no Export Pack…, and on a Mac
   that never exported a pack
   `security find-generic-password -s "Kookaburra Cut pack signing key"` finds
   nothing.
6. Under `ExportsInProject`, an export lands in the project's `exports/`
   folder and Settings ▸ Video shows the lock.
7. Under a malformed `UpdateEndpoint`, Settings ▸ Updates shows the lock and
   the reason. A well-formed one only shows in a release build, since a dev
   build answers every check "Not available in a dev build".
8. Under `AuditLogPath`, `app.log` shows `[managed] AuditLogPath: copying this
   log to /Library/Logs/Kookaburra Cut/<login>.log`, `sudo ls -l` on the
   folder shows that file as `-rw-------` owned by the person, its newest lines
   match the end of `app.log`, and Settings ▸ About ▸ Export log carries the
   note. A malformed or unusable value leaves one `[managed] AuditLogPath ...
   keeping no copy of the app log` line instead (`audit::log_mirror_at_boot`).
9. The negative check: without a profile,
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
preferences daemon re-read the folder; then relaunch the app. To see what the
app will read without launching it, this prints the policy as JSON, with one
`[managed]` line per malformed key:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib managed::tests::this_mac_forces -- --ignored --nocapture
```

Remove the file to lift the policy:

```bash
sudo rm "/Library/Managed Preferences/$USER/com.mpalmes.kookaburracut.plist"
```

## For contributors

- Every guard lives in `src-tauri/src/managed.rs`: `deny_claude`,
  `deny_update_check`, `deny_workspace_change`,
  `deny_publisher`, `deny_agent_kit`, `deny_pack_export`,
  `managed_update_endpoint`, `exports_in_project` and `audit_log_dir`, each a
  one-line call at the top of the command it governs (`audit_log_dir` in
  `audit::mirror_at_launch`, read once before the log starts);
  `every_governed_command_calls_its_guard` fails when one goes missing. A new managed key adds a `Key`, a field on
  `ManagedPolicy`, a parse arm in `from_source`, a guard, a row in that test,
  a row here and a unit test.
- The webviews read the effective policy through `managed_policy` (the
  `managed` permission set, granted to the main, settings and packs windows) via
  `src/engine/managed.ts`; the Rust guards stand on their own, so a page that
  never reads the policy still cannot cross it.
- Refusals carry the `managed:` marker so the UI can tell policy from a fault
  (`isManagedRefusal`, `plainError`).
