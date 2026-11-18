# Kookaburra Cut on managed Macs

Describes version 0.22.4. For the IT and security team deploying Kookaburra Cut
to a fleet. The keys themselves, their types and a sample profile are in
[mdm.md](./mdm.md); the decision-maker's summary is
[security-overview.md](./security-overview.md); the engineering record with the
control behind every claim is [SECURITY.md](../SECURITY.md). Every line here
names the file or command it rests on. The Claude Code settings below were
checked against Anthropic's documentation on 6 November 2026.

## In short

1. Deploy only builds you have verified ([Verify a release](#verify-a-release)),
   through your MDM, with `DisableUpdateCheck` forced on; or keep the in-app
   updater and point it at your own server with `UpdateEndpoint`
   ([Updates](#updates-in-app-or-mdm-delivery)).
2. Force `AllowedPublisherKeyIds` (empty until you approve a publisher),
   `DisableLiveWebsites` (or `AllowedWebsiteOrigins` with your own sites) and
   `ExportsInProject`. Leave `DisableClaude` and
   `DisableAgentKit` unset where Claude Code is approved for this work; force
   both where it is not ([Force the keys](#force-the-keys)).
3. Put the credential deny rules, `disableBypassPermissionsMode` and an
   organisation login pin in Claude Code's own managed settings. The app's
   rules cover only projects it has opened
   ([Claude Code's own managed settings on top](#claude-codes-own-managed-settings-on-top)).
4. Treat a shared project folder like a script from that person
   ([Shared projects and packs](#shared-projects-and-packs)).
5. Expect `ffmpeg`, `ffprobe`, `git`, `sips` and `open` as the app's children,
   and alert on anything else ([What to expect in EDR](#what-to-expect-in-edr)).

## Verify a release

Download the DMG, `SHA256SUMS`, `build-info.txt`, the SBOM, the provenance
bundle (`KookaburraCut-<version>.intoto.jsonl`) and `SECURITY.md` from the
release page. Then:

```bash
V=<version>
shasum -a 256 -c SHA256SUMS --ignore-missing
for f in "KookaburraCut-$V.dmg" build-info.txt; do
  gh attestation verify "$f" --repo michael-palmes/kookaburra-cut \
    --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
    --source-ref "refs/tags/v$V" --deny-self-hosted-runners
done
gh attestation verify "KookaburraCut-$V.dmg" --bundle "KookaburraCut-$V.intoto.jsonl" \
  --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref "refs/tags/v$V" --deny-self-hosted-runners        # offline, from the release's own bundle
gh attestation verify "KookaburraCut-$V.dmg" --repo michael-palmes/kookaburra-cut \
  --predicate-type https://cyclonedx.org/bom                    # the SBOM attestation
grep '^commit=' build-info.txt                                  # the same commit as the next line
git ls-remote https://github.com/michael-palmes/kookaburra-cut "refs/tags/v$V^{}"
```

From 0.23.0 the release also carries a signed pkg for your MDM to install
silently ([mdm.md, "Installing with the pkg"](./mdm.md#installing-with-the-pkg)).
It is in `SHA256SUMS`, the provenance and the SBOM attestation, so run the
`gh attestation verify` lines above on `KookaburraCut-$V.pkg` too, then check
its installer signature:

```bash
pkgutil --check-signature "KookaburraCut-$V.pkg"   # Developer ID Installer: ... (Q4B8N8ZKA2), trusted by the Apple notary service
spctl -a -t install -vv "KookaburraCut-$V.pkg"     # accepted, source=Notarized Developer ID
```

Install it on a staging Mac:

```bash
APP="/Applications/Kookaburra Cut.app"
codesign -dvv "$APP"                  # flags=0x10000(runtime), Developer ID Application, TeamIdentifier=Q4B8N8ZKA2, a Timestamp
codesign -d --entitlements - "$APP"   # none
spctl -a -t exec -vv "$APP"           # accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"
```

Then read what changed. Each release from 0.22.0 ships its own `SECURITY.md`
to diff against the one you approved, and the source diff is one command:

```bash
git diff v<previous> v<version> -- SECURITY.md docs/mdm.md src-tauri/src/managed.rs src-tauri/src/privacy.rs src-tauri/capabilities src-tauri/permissions src/stage
```

`scripts/verify-install.sh --version <version> --previous <previous>` runs
all of the above from a checkout of the tag, including the `SECURITY.md` diff
and a check of the updater archive against its published `.tar.gz.sig` and
the key built into the app. `SHA256SUMS` alone catches a broken download; the
attestations are the check that counts, since they tie the DMG,
`build-info.txt` and the SBOM to this repository's release workflow at that
tag, on GitHub's own runners
([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)). None of
it proves anyone reviewed the code ([Updates](#updates-in-app-or-mdm-delivery)).
Pin Team ID `Q4B8N8ZKA2` in your application control and treat a change as an
incident.

## Force the keys

Domain `com.mpalmes.kookaburracut`, as forced keys in a custom settings
payload (the sample profile is in [mdm.md](./mdm.md)). The app honours a key
only while macOS reports it forced, so a user's `defaults write` does nothing;
a wrong type fails closed to the most restrictive setting; the policy is read
once per launch (`src-tauri/src/managed.rs`).
`DisableAgentKit`, `DisablePackExport`, `ExportsInProject` and `UpdateEndpoint`
are honoured from 0.22.3; an older build ignores them, so deploy 0.22.3 or
later before relying on them. `AuditLogPath` and `AllowedWebsiteOrigins` need
0.23.0.

| Key | Recommend | Why |
| --- | --- | --- |
| `AllowedPublisherKeyIds` | `[]`, then approved publishers' key ids | Empty means no pack imports at all; there is no separate switch. The id is recomputed from the pack's own key, so a manifest cannot claim one (`pack/commands.rs`). |
| `DisableLiveWebsites` | `true` unless a team needs them | The only path where remote pages load inside the app. Captured images still render in previews and exports (`website.rs`). |
| `AllowedWebsiteOrigins` | Your own sites' origins, where a team needs them live | Live websites open only from these exact origins (scheme, host and port), and a grant made before the profile stops working. Empty means none. `DisableLiveWebsites` wins over it (`managed.rs`, `website.rs`). |
| `DisableUpdateCheck` | `true` with MDM delivery | Stops the GitHub request and the in-app install, which a standard user cannot finish anyway, since it asks for an administrator password (`updater.rs`). |
| `UpdateEndpoint` | Your mirror's `https://` manifest URL, if you keep the in-app updater | The app then asks only that host. The archive must still carry this project's updater signature, bound to the version, so a mirror can serve only builds this project signed; a malformed value means no check at all, never a fallback to GitHub (`updater.rs`). |
| `ExportsInProject` | `true` | Renders land in the project's `exports/` folder instead of `~/Downloads`, where they outlive the project and ride whatever syncs that folder (`resolve_export_output` in `lib.rs`). |
| `DisablePackExport` | `true` where nothing should leave as a pack | Removes Share as pack, and the signing key is never minted in the Keychain. Imports are governed by `AllowedPublisherKeyIds` (`pack/commands.rs`, `pack/key.rs`). |
| `WorkspaceRoot` | Only to standardise; a local, unsynced path | Projects hold unreleased footage, so keep them out of synced folders. The agent bridge stays in `~/Kookaburra Cut/_bridge` either way (`bridge.rs`). |
| `DisableAgentKit` | `true` where Claude Code is not approved for this work | Stops everything the app lays out for an agent: no kit stamped into a project, no `_bridge` folder, no handoff, and the Claude entry points go with it (`workspace.rs`, `bridge.rs`). Where Claude Code is approved, leave it unset: the kit is what gives the agent its rules. |
| `DisableClaude` | Unset where Claude Code is approved; `true` beside `DisableAgentKit` where it is not | Removes the Edit with Claude buttons and the Claude download link, nothing more (`claude_app.rs`). |

`DisableClaude` on its own is not recommended, because it removes a button, not
a capability: anyone can still open the folder in Claude Code from a terminal,
which skips the app's review sheet, and the kit is still stamped and the
bridge still runs. Where the decision is "not for this data", force
`DisableAgentKit` with it and enforce the decision through Claude Code's own
policy or your application control. Where Claude Code is approved, the kit is
the control you want in place, and `DisableClaude` would only push people to
the terminal.

What a managed person sees: an entry point policy removes is gone, and a
Settings row policy governs shows a lock and "Managed by your organisation"
with the key named in the tooltip ([mdm.md, "What a managed user
sees"](./mdm.md#what-a-managed-user-sees)). Each refusal is one `[managed]`
line in the activity log ([Retention](#retention)).

## Claude Code's own managed settings on top

When the app loads a project (after Allow) it rewrites the project's
`.claude/settings.json`: `./kb` and five git commands allowed, WebFetch and
WebSearch set to ask, credential reads denied, and hooks that ask before
`curl`, `ssh`, `git push`, `gh`, cloud CLIs and the like; a folder's permission
mode, `env`, MCP servers and helpers are stripped
([SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent)).
That covers only projects the app has opened, binds only Claude Code's own file
tools (not a script the agent runs), and the hooks run only once the person
trusts the folder in Claude Code. In a folder whose `.git` names a program, the
agent gets no git allow rule at all and a `Bash(git:*)` deny
([Shared projects and packs](#shared-projects-and-packs)).

For every session on the Mac, deploy Claude Code's managed settings
(`/Library/Application Support/ClaudeCode/managed-settings.json`, or the
`com.anthropic.claudecode` profile), as Anthropic documents them on the date
above; they are Anthropic's to change, so check the current settings reference
before rolling out:

- `permissions.disableBypassPermissionsMode: "disable"`.
- `disableAutoMode: "disable"`, if a person should approve each unlisted
  action. The app sets no permission mode, and Claude Code ignores `auto` and
  `bypassPermissions` from project files.
- `forceLoginMethod` and `forceLoginOrgUUID`, so project content goes under your
  organisation's account and its retention settings.
- `permissions.deny` mirroring the kit's credential list: `Read(~/.ssh/**)`,
  `Read(~/.aws/**)`, `Read(~/.config/**)`, `Read(~/.gnupg/**)`,
  `Read(~/Library/Keychains/**)`, `Read(**/.env)`, `Read(**/.env.*)`,
  `Read(**/*.pem)`, `Read(**/*.key)`, `Read(**/.netrc)`,
  `Read(**/.git-credentials)` (the full list is `CREDENTIAL_*` in
  `src-tauri/src/kit.rs`).
- `cleanupPeriodDays` to your retention standard.

Weigh two of them first. `allowManagedHooksOnly` turns off the kit's hooks and
with them the send-off asks; `allowManagedPermissionRulesOnly` drops the kit's
rules, so every `./kb` call prompts and the deny rules must be yours. If your
standard sets either, add `Bash(./kb *)` and the kit's ask and deny rules to
the managed set (`src-tauri/templates/project-claude-settings.json`).
`sandbox.enabled` would bind scripts too, but it is untested with kb, which
writes to `~/Kookaburra Cut/_bridge` outside the project: pilot it before
forcing it.

## Shared projects and packs

Pressing Allow on a project means
([SECURITY.md, "Scene code and the trust boundary"](../SECURITY.md#scene-code-and-the-trust-boundary)):

- A native sheet, with Don't open as its default, names the project and its
  folder. The grant is bound to the hash of its scenes, `project.json`,
  `CLAUDE.md` and `.claude/settings.json` (not its assets); a change made
  outside the app asks again at the next launch (`workspace.rs`, `trust_covered_files`).
- Scene code runs in a Web Worker with no DOM and none of the app's commands,
  under a content security policy naming no outside host, behind a guard that
  limits every request to the project's own files; a release build will not
  start it unless that policy is live (`src/stage/`).
- The app moves agent files the folder brought (`AGENTS.md`, nested
  `CLAUDE.md`, `.mcp.json`, foreign `.claude/` content) into `NOTES.md` or
  aside, stamps its own kit, and runs git with the system and global config off
  (`kit.rs`, `history.rs`). A live git hook found on the first open moves to
  `.git/hooks.moved-aside/` and the review sheet lists it; a `.git/config`
  that names a program leaves the agent with no git allow rule and a
  `Bash(git:*)` deny, and kb's own hook refuses git there too.
- Live websites need a separate grant per origin, on another native sheet,
  and `AllowedWebsiteOrigins` limits which origins can be granted at all
  (`website.rs`).

What is left: a WebKit or GPU driver bug reached through scene code, and the
media parsers (ffmpeg, AVFoundation, `sips`, the font, glTF and PNG readers),
which are bounded and tested on hostile files; a weekly cargo-fuzz run covers
the pack, edit document, font, mp4 and PNG parsers (`.github/workflows/fuzz.yml`,
[SECURITY.md, "Not yet"](../SECURITY.md#not-yet)). Allow no longer runs code
with the person's account, which it did on 0.21.1.

Packs are signed, hash-checked as they unpack, stripped of agent files, never
compiled on import and limited by `AllowedPublisherKeyIds`
([SECURITY.md, "Packs"](../SECURITY.md#packs)). A shared folder (a zip, an
AirDrop or a `git clone` into the workspace) has no policy key: the Allow
sheet is its only gate. The folder policy, then: treat a shared folder like a
script from that person. If you would not press Allow on it, do not run Claude
Code in it either. A declined folder is never swept, and Claude Code started
from a terminal skips the app's review sheet.

## What to expect in EDR

Children of `Kookaburra Cut.app/Contents/MacOS/kookaburra-cut`, from every
`Command::new` in `src-tauri/src` outside its test modules
([SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac)):

- `Contents/MacOS/ffmpeg` and `ffprobe` beside the binary (the same Team ID, a
  cleared environment, built without networking), often (`tools.rs`).
- `git` from `PATH`, in a project folder, at creation and after Allow
  (`history.rs`).
- `/usr/bin/sips`, one dropped still at a time (`imagefile.rs`).
- `open`: `-R <file>` and `<folder>` for Finder, `claude://code/new?folder=…`
  for the handoff, and the two fixed pages (`claude_app.rs`, `lib.rs`,
  `pack/commands.rs`).
- Only while installing an in-app update: `touch` on the installed bundle,
  then `/usr/bin/open -n` to relaunch it; where the app's folder is not
  writable, macOS asks for an administrator password and the updater plugin
  runs `sh` as root with `/usr/bin/osascript`, `mv` and `rm`.
  `DisableUpdateCheck` removes all of these (`updater.rs`).

WebKit's helpers (WebContent, GPU and Networking) start through launchd, not
as children. The app process connects only to `github.com` and
`release-assets.githubusercontent.com`, or to your `UpdateEndpoint`; a live
website's traffic goes through WebKit to the approved origin.

Under Claude Code, not under the app: kb (`python3 -I .../kb.py`, which Claude
Code runs from the project) starts `git`, the bundled `ffmpeg` and `ffprobe`,
the app binary headless (`kookaburra-cut edit`, `media`, `trust`, `check` and
headless exports), `/usr/bin/sips`, `/usr/bin/osascript -l JavaScript` to
rasterise an SVG it has rewritten first, and `xcode-select -p`; the brand
skill runs `osascript` the same way
(`.agents/skills/kookaburra-scene-authoring/scripts/kblib/`,
`.agents/skills/kookaburra-brand-packs/scripts/`).

Alert on anything else under the app: a shell or `osascript` outside an update,
`curl`, `python`, `claude`, or an `ffmpeg` that is not the one in the bundle.

## Retention

The app holds no API key and sends nothing itself. Claude Code sends what it
reads (project files, and the frames kb saves under the project's `.kb/`)
under the signed-in account, so confirm that your Claude Team or Enterprise
retention and training settings cover unreleased footage, and pin logins
([Claude Code's own managed settings on top](#claude-codes-own-managed-settings-on-top)).
`~/.claude` keeps Claude Code's local transcripts; the app never touches it.

On the Mac ([SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac)):

- Projects, with their `.kb/` frames, are ordinary documents, backed up and
  indexed like any file.
- App data, `_bridge` and `_autorun` are owner-only, re-sealed each launch and
  kept out of Spotlight; the clip and media caches (decoded footage, a 20 GB
  cap) also skip Time Machine.
- The activity log, `~/Library/Application Support/com.mpalmes.kookaburracut/logs/app.log`,
  records trust grants and declines, website grants, pack imports with their
  key id and verdict, pack exports, each Edit with Claude handoff, each
  finished video or stills export and where it went, update checks and
  installs, and managed refusals: paths,
  slugs, origins, key ids and versions, never file contents. Rotated at 1 MiB
  with three files kept, owner-only. Settings ▸ About reveals the folder; an
  incident responder reads it from there, since nothing sends it anywhere.
- Bridge responses last up to an hour, import backups 24 hours; deleted
  projects go to the Trash; exports land in `~/Downloads` unless
  `ExportsInProject` is forced.

Keep FileVault and encrypted backups, an unsynced workspace, and your usual
Trash schedule. Settings ▸ Storage ▸ Clear all app data and the uninstall
steps are in [security-overview.md](./security-overview.md#where-data-rests-and-how-to-delete-it).

## Updates: in-app or MDM delivery

The maintainer is the only repository admin. A release run needs a second
reviewer's approval, never the person who started it, but the admin can change
that rule ([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity)).

**The in-app updater** installs only an archive with an ed25519 signature from
the key built into the app, bound to the announced version so a manifest
cannot roll an install back, holding a Developer ID signed and notarised app.
Fixes arrive at the next launch (the automatic check runs at most every 20
hours), and only the latest release receives them. But both keys, the tag
signer and the updater key, sit behind one GitHub account: whoever took it
over could change the tag-signer list and the release reviewers, approve a
run and ship a properly signed update to every Mac. The updater adds no second
person. `UpdateEndpoint` moves the request to your server and nothing else:
the archive it serves must still carry this project's signature.

**MDM delivery of verified builds** makes your team the second reviewer. A
release reaches the fleet only after your check ([Verify a
release](#verify-a-release)), your read of the diff and a soak that gives a bad
release time to surface. You also pin one version and avoid the administrator
prompt. From 0.23.0 the signed pkg installs with no prompts
([fleet-deployment.md](./fleet-deployment.md#from-0230-the-pkg) has a recipe
per MDM). The cost is speed, so watch the repository's releases and advisories
and fast-track security fixes. Your check catches a tampered or swapped
download; it cannot catch a harmful change pushed through that account, since
the signature, the notarisation and the attestation all come from it. Your
delay and your review are the real control.

**Recommendation:** MDM delivery with `DisableUpdateCheck` forced on, a short
soak for ordinary releases and a fast lane for security ones; revisit once the
`release` environment's rules sit beyond the admin's reach
([SECURITY.md, "Not yet"](../SECURITY.md#not-yet)).
