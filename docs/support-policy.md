# Support policy

How to get help with Kookaburra Cut, what is supported and what to send.

Kookaburra Cut is free and open source, made by one person in their own time.
Support is community support through GitHub issues, on a best-effort basis.
There is no paid tier, no support agreement, no private support channel and no
promised response time for issues. The terms for the app and its code are the licence
files, [LICENSE-MIT](../LICENSE-MIT) or [LICENSE-APACHE](../LICENSE-APACHE), at
your choice.

## Getting help

| For | Where | Visibility |
| --- | --- | --- |
| A bug, a question or a feature idea | [GitHub issues](https://github.com/michael-palmes/kookaburra-cut/issues/new/choose), using the bug report or feature request form | Public |
| A privacy request | Email `privacy@kookaburracut.com` | The requester and the maintainer |
| A security problem | GitHub private vulnerability reporting, as [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) describes, or email `security@kookaburracut.com` | The reporter and the maintainer |

An issue is public. Never put a confidential project, product or client name,
footage, a captured frame or a screenshot of unreleased work in one. Call the
project `my-project`; the aspect, codec and steps are what matter.

Issues are read and answered when the maintainer can. Some will wait, and some
feature ideas won't be built. A pull request is welcome; open an issue first for
anything large.

## What is supported

- **The latest release.** Older releases get no fixes, security fixes
  included; update first ([release-cadence.md](./release-cadence.md)).
- **macOS 26.0 or later on Apple Silicon.** `minimumSystemVersion` is `26.0`
  (`src-tauri/tauri.conf.json`), and there is no Intel build (README,
  "Download").
- **The signed, notarised build** from the
  [releases page](https://github.com/michael-palmes/kookaburra-cut/releases),
  installed from the DMG, the pkg or the zip, through the in-app updater, or by your MDM
  from that same file ([fleet-deployment.md](./fleet-deployment.md)).
- **The app's own behaviour:** opening, editing, previewing, exporting video
  and stills, packs, the managed preferences in [mdm.md](./mdm.md), and the
  agent kit the app writes into a project.
- **Builds from source**, best effort: the bug form asks which one you run.

## What is not supported

- Intel Macs, macOS before 26.0, Windows and Linux.
- A build someone else modified, rebuilt or re-signed. Check the signature
  first ([SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity),
  "Verify an install").
- Writing or fixing a project's scenes for you. The skills the app stamps into
  each project guide Claude Code through that.
- Claude Code, the Claude desktop app and Anthropic accounts: those are
  Anthropic's ([SECURITY.md, "Scope and threat model"](../SECURITY.md#scope-and-threat-model)).
- Websites you allow inside a scene, your MDM product, and the purchased
  device models outside the app.

## What to send

- **The app version**, at the foot of the Settings window (⌘,), and your
  **macOS version** and **Mac model**.
- **How it was installed**: the DMG, the pkg, the in-app updater, your MDM, or source.
- **Whether your organisation manages it.** Settings marks each managed row
  "Managed by your organisation"; name the keys if you know them
  ([mdm.md](./mdm.md)).
- **What happened and what you expected**, and the steps to reproduce.
- **For an export**: the aspect, the codec and whether Verify ×2 passes
  ([determinism.md](./determinism.md)).
- **A project that shows it**, only if you can share it. A project made from
  a bundled template is ideal. If the only example is confidential, say so:
  the maintainer can start from the steps, and won't ask for your footage.

Never send a password, a token, a key or your pack signing key. The app
prints none of them ([SECURITY.md, "Saved secrets"](../SECURITY.md#saved-secrets)).

## Security issues

1. Report privately, never in a public issue: GitHub private vulnerability
   reporting ([SECURITY.md, "Reporting a vulnerability"](../SECURITY.md#reporting-a-vulnerability))
   creates a draft advisory only you and the maintainer can see, or email
   `security@kookaburracut.com`.
2. Expect an acknowledgement within 14 days, usually sooner, as
   [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) says. Once the
   report is confirmed the maintainer works on a fix or a mitigation, best
   effort, with no committed time.
3. If 14 days pass with no reply, follow up on the same report or by email.
4. The fix ships in the next release, listed under `### Security` in
   `CHANGELOG.md` and in the release notes. Earlier versions are not patched
   ([release-cadence.md](./release-cadence.md#which-release-gets-security-fixes)).
5. If a release or a signing key itself is compromised,
   [incident-response.md](./incident-response.md) says what happens and how to
   check what you have.
