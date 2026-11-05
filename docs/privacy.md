# Privacy

Kookaburra Cut runs on your Mac and keeps your work there. This page says, in
plain words, what can leave the Mac, what the app keeps, how to clear it, and
how an organisation can lock it down. The engineering version, with the file or
command behind every sentence, is [SECURITY.md](../SECURITY.md).

This page describes version 0.22.1. On 0.21.1, pressing Allow on a shared project
runs its code with your account, and the app's own data is not private to your
account. Update once a newer release is out, and until then open only projects
you'd trust as a program.

## Nothing leaves your Mac unless you start it

Opening a project, editing scenes, importing a pack, exporting a video or a PDF
and presenting never touch the network. There is no account, no telemetry, no
crash reporting, and nothing phones home. The app's own window can only talk to
itself: the browser rules it ships with name no outside host. Scene code you
allow runs under the same rules, shut off from the network and from the app's
commands, though it can read its project and the fonts and 3D objects in your
libraries.

Four things can reach the internet, and each one starts with you:

| What | When | Where it goes | What goes | Off switch |
| --- | --- | --- | --- | --- |
| Update check | At launch and about once a day while the app is open, if you left the first-run switch on, or when you choose Check for Updates | GitHub, the app's release page | One request for the latest release file. No identifiers, nothing about your usage or your Mac | The switch on the first-run welcome, or Settings ▸ Updates |
| Update install | Only when you press Install and relaunch | GitHub, the release download | Nothing; the new build comes down, is checked against a key built into the app, and replaces itself | Press Later |
| Edit with Claude | Only when you press Edit with Claude and the Claude desktop app is installed | The Claude desktop app on this Mac, which then talks to Anthropic under your account | The project folder's path and a starter prompt, typed in for you, never sent until you press Enter there | Do not press it; a configuration profile can turn it off |
| Live websites in a scene | Only after you press Allow for that website in the editor; a presentation then loads it again on each hold | The website you approved | The page loads like a browser tab, cookies and all, in a profile separate from Safari | Revoke the website in the scene's inspector; Settings ▸ Website data clears what it stored |

Two buttons open a web page in your browser: Get Claude (the Claude download
page) and What leaves your Mac (this page). The address is fixed inside the
app; nothing about you is added to it.

## What the Claude integration sends

Claude uses your own Claude Code install and your own Anthropic account. The app
never holds a key for you, and it never starts Claude Code or a shell itself.

- **Edit with Claude** hands the project to the Claude desktop app and types a
  starter prompt in. Nothing is sent until you press Enter in that app. From
  there, Claude Code sends the project's files to Anthropic as you work, under
  your own account and settings.
- **What the agent is allowed** comes from the app, not from the project. Every
  time a project opens, the app rewrites the project's Claude settings: only the
  app's own permission rules and hooks stay, and anything a shared folder or a
  pack arrived with is removed and noted in the log. Other files Claude Code would
  read as instructions or settings, such as `AGENTS.md` or `.mcp.json`, move out
  of the way, their text saved to `NOTES.md`. A macOS sheet shows you what moved,
  and Claude won't start until you've seen it.
- **Sending work off the Mac asks first.** Commands that look like an upload, and
  the agent's web tools, stop and ask you. That slows a misled agent, but it isn't
  a sandbox, so start Claude only in folders you trust.
- **Text in a project is data, not instructions.** The rules the app gives the
  agent say that scene copy, notes, brand files, pack contents and captured
  frames are content to edit, never commands to obey, and to stop and ask before
  reaching outside the project or sending anything off the Mac.
- **The agent's tools stay inside the project.** `kb` writes only into the
  project, your workspace or a folder you picked in the app this session, and
  refuses to read credential folders such as `~/.ssh` or `.env` files.

## Scene code and packs

A project's scenes are code. The first time a project opens, a macOS sheet
names it and its folder and asks whether to run its scenes; Return declines.
The question returns if the scenes changed while the project was closed, which
is how a shared folder or a pack is caught. Nothing in a pack runs when you import
it: importing only writes files, and the first open asks the question above.

A pack is signed by the app that made it. On import the app checks that every
file matches the signed list, tells you whether it has seen this publisher's
key before, and shows the scene code and websites it carries. A publisher's name is never verified: only the key is. Agent settings
never travel in a pack, and an author's notes for Claude are saved beside the
project as `NOTES.md` for you to read, not for the agent to obey. When you export
a pack, your own notes stay out unless you tick them, and the names of files you
imported never travel.

## What the app keeps on your Mac, and how to clear it

- **Your workspace**, `~/Kookaburra Cut` by default (Settings ▸ Workspace moves
  it): every project with its scenes, assets, edits and exports, plus your
  themes, brands, fonts, gradients, export presets, scene presets and
  screenshots. Deleting a project moves it to the Trash. Each project is also a
  small git repository holding its scenes and settings only: footage and
  exports are never kept in it, so a removed asset is gone, and a project
  made before this rule has them removed from its history the next time it
  opens, unless you connected that repository to a remote or started it
  yourself, in which case it is left as it is. Your projects are backed up
  like any other folder.
- **Caches** under the app's Application Support folder: decoded video frames
  (the clip cache, with a size limit), media previews and thumbnails. Settings ▸
  Storage shows their size and clears them; they are rebuilt as you work, and
  deleting a project or an asset clears its own frames and previews. Time
  Machine skips these two caches, since everything in them comes back from
  your project's own footage. Frames the agent's tools save inside a project,
  and the app's smaller caches, are backed up like any file.
- **Settings**: your preferences, which publishers' keys you have imported from,
  which projects you allowed to run. The key that signs your own packs lives
  in your login Keychain and never synchronises; macOS may ask once to let the
  app use it.
- **Website data**: cookies and site storage for websites you allowed, in a
  profile separate from Safari. Settings ▸ Website data clears one site or all.
- **Agent files**: the Claude Code skills and settings the app writes inside
  each project's `.claude` folder, and a `_bridge` folder in the workspace that
  the agent and the app use to talk. Claude Code's own history and login live
  in `~/.claude`, which Claude Code manages, not this app.
- **Exports** land in `~/Downloads` by default (Settings ▸ Video changes that
  to the project's own `exports` folder).

Your projects stay as readable to other accounts on the Mac as any file in
your home folder is. The app's own caches, settings and the agent's `_bridge`
and `_autorun` folders are readable by your account alone, and Spotlight skips
them. FileVault and your account password are the protection at rest.

## For organisations

The app can be locked down with a configuration profile from your MDM, so staff
run the same build with the network paths you do not want switched off and
greyed out in Settings with a note that the organisation manages them: Claude
(Edit with Claude and Get Claude), live websites, the update check, the
publishers whose packs may be imported, and the workspace location. The keys
and a sample profile are in [docs/mdm.md](./mdm.md).

Report a security problem privately through the repository's Security tab, as
[SECURITY.md](../SECURITY.md) describes.
