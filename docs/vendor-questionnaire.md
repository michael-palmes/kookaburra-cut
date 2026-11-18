# Vendor questionnaire

**Version:** 0.23.0, pending.

Pre-filled answers for the security questionnaire a procurement or security
team sends before a pilot: the SIG Lite, arranged by the SIG's risk domains,
and the CSA CAIQ v4, by its domain codes, for what applies to a local macOS
app with no service, no account and no hosted data.

## How to use this

- **Find the row by topic.** The SIG and CAIQ texts are licensed, so questions
  here are paraphrased, not quoted. Each section names the SIG domain and CAIQ
  code it answers; a later SIG that renames or adds a domain maps by topic.
- **Answers** are Yes, No, Partial or Not applicable. A Partial or No says what
  is missing in its notes; nothing is implied.
- **Evidence** is the file, workflow, release asset or command that proves the
  answer. Links resolve at the tag of the version you install:
  `github.com/michael-palmes/kookaburra-cut/blob/v<version>/docs/vendor-questionnaire.md`.
  A `gh api` command reads a repository setting that lives on GitHub, not in
  the code.
- **The other documents**, nothing repeated on purpose: one-line answers and
  the data-flow statement in [security-overview.md](./security-overview.md),
  every control in [SECURITY.md](../SECURITY.md), the plain-words version in
  [privacy.md](./privacy.md), deployment in [fleet.md](./fleet.md), the managed
  keys in [mdm.md](./mdm.md) and every third party in
  [subprocessors.md](./subprocessors.md).

## Version

This page describes 0.23.0, pending: `main` once the 0.23.0 work has merged,
before that release is tagged. On 0.22.4, the latest release, these rows differ:

- **Logging and audit:** 0.22.4 keeps no log in a release build.
- **Data at rest:** Settings ▸ Allowed projects ▸ Forget and Settings ▸ Storage
  ▸ Clear all app data arrive in 0.23.0.
- **Supply chain:** the SBOM, the crate list embedded in the binary,
  [verify-install.sh](../scripts/verify-install.sh), the licence and source
  policy, no dependency install scripts, the provenance bundle and updater
  signature as release assets, the sidecar's source archives and the licence
  notices inside the app.
- **Vulnerability management:** the 14-day acknowledgement, CodeQL over Python
  and the `unsafe` allow-list.

When 0.23.0 is tagged, the version line here and the one in
[subprocessors.md](./subprocessors.md) drop "pending" in the same change;
`scripts/vendor-docs.test.mjs` fails until they do.

## What applies

| SIG domain | CAIQ v4 | Applies | Section |
| --- | --- | --- | --- |
| Enterprise risk management, Information assurance | GRC | Yes | [Governance and risk](#governance-and-risk) |
| Nth party management | STA | Yes | [Third parties](#third-parties) |
| Asset and information management, Network security | DSP | Yes | [Data flows](#data-flows-and-what-leaves-the-mac), [Data at rest](#data-at-rest-retention-and-deletion) |
| Information assurance (encryption) | CEK | Yes | [Encryption and keys](#encryption-and-keys) |
| Access control | IAM | Partly | [Authentication and access](#authentication-and-access) |
| IT operations management | LOG | Yes | [Logging and audit](#logging-and-audit) |
| Threat management | TVM | Yes | [Vulnerability management](#vulnerability-management) |
| IT operations management, Application security | CCC, AIS | Yes | [Change control](#change-control-and-secure-development) |
| Supply chain risk management | STA | Yes | [Supply chain](#supply-chain-and-release-integrity) |
| Operational resilience | BCR | Partly | [Business continuity](#business-continuity) |
| Cybersecurity incident management | SEF | Partly | [Incident response](#incident-response) |
| Endpoint security | UEM | Yes | [Managed Macs](#managed-macs) |
| Privacy management | DSP | Yes | [Privacy](#privacy) |
| Artificial intelligence | none in v4 | Yes | [AI](#ai) |
| Compliance management | A&A | Yes | [Compliance](#compliance) |
| Human resources security | HRS | No | [Not applicable](#not-applicable) |
| Physical and environmental security | DCS | No | [Not applicable](#not-applicable) |
| Server security, Cloud hosting services | IVS | No | [Not applicable](#not-applicable) |
| Data portability | IPY | Yes | [Data at rest](#data-at-rest-retention-and-deletion) |

## Governance and risk

SIG: Enterprise risk management, Information assurance. CAIQ: GRC.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is there a documented information security policy? | Partial | [SECURITY.md](../SECURITY.md) | SECURITY.md is the security record: threat model, every control, reporting. Versioned per release and shipped in each release's assets. No separate policy document and no approval cycle beyond the maintainer. |
| Is there a threat model or risk assessment? | Yes | [SECURITY.md, "Scope and threat model"](../SECURITY.md#scope-and-threat-model) | Names the risks in scope and the two out of scope: a hostile process already running as the same user, and Claude Code's own behaviour, network use and storage, which are Anthropic's. |
| Are accepted and deferred risks recorded? | Yes | [SECURITY.md, "Not yet"](../SECURITY.md#not-yet), [scene-website.md](./scene-website.md#accepted-residual-risk) | A public, versioned list, so nothing deferred reads as done. |
| Are security decisions recorded with their reasons? | Yes | [decisions.md](./decisions.md) | One dated row per decision. |
| Is someone accountable for security? | Yes | [CODEOWNERS](../.github/CODEOWNERS), `gh api repos/michael-palmes/kookaburra-cut/collaborators` | The maintainer, the repository's one admin. One person: see [Business continuity](#business-continuity). |
| Is there a contract, licence agreement or support agreement? | No | [LICENSE-MIT](../LICENSE-MIT), [LICENSE-APACHE](../LICENSE-APACHE), [support-policy.md](./support-policy.md) | An individual maintainer, with no company or trading entity. The app is free and open source with no paid offer, so the MIT OR Apache-2.0 licence files are the only terms. Support is community support through GitHub issues, best effort, with no response-time promise. |
| Is the project assessed against a public baseline? | Partial | [best-practices.md](./best-practices.md), [scorecard.yml](../.github/workflows/scorecard.yml) | OpenSSF Best Practices answers, self-certified, with the Unmet criteria named; OpenSSF Scorecard runs weekly and on every push to `main`, results published. Neither is an audit. |
| Does the vendor hold insurance (cyber or professional indemnity)? | No | The maintainer's statement | None held. |

## Third parties

SIG: Nth party management. CAIQ: STA.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the vendor send customer data to subprocessors? | No | [subprocessors.md](./subprocessors.md) | The vendor receives no customer data, so it has none to pass on. |
| Are the third parties a device can reach named, with what they receive? | Yes | [subprocessors.md](./subprocessors.md) | GitHub, Anthropic through the person's own Claude Code, and websites a person approves. Each only when a person acts. |
| Is there an analytics, crash reporting or telemetry vendor? | No | [tauri.conf.json](../src-tauri/tauri.conf.json), [capabilities](../src-tauri/capabilities/) | The window's content security policy allows `connect-src` only to itself, `blob:`, `data:`, `ipc:` and `asset:`; no capability names a remote URL. |
| Is Apple a runtime subprocessor? | No | [sign-and-notarize.sh](../scripts/sign-and-notarize.sh) | Apple notarises the release at build time. macOS's own Gatekeeper checks are the operating system's, as for any app. |

## Data flows and what leaves the Mac

SIG: Asset and information management, Network security. CAIQ: DSP.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is customer data sent to or stored by the vendor? | No | [SECURITY.md, "What leaves the Mac"](../SECURITY.md#what-leaves-the-mac) | No account, no server, no telemetry. Opening, editing, importing, exporting and presenting make no request. |
| Is there a data-flow statement? | Yes | [SECURITY.md, "What leaves the Mac"](../SECURITY.md#what-leaves-the-mac), [security-overview.md](./security-overview.md#what-leaves-the-mac) | Four paths, each started by a person, each with an off switch. |
| Update check: what is sent, and can it be turned off? | Yes | [updater.rs](../src-tauri/src/updater.rs), [updates.ts](../src/engine/updates.ts), [mdm.md](./mdm.md#keys) | One GET for `latest.json` from `github.com`, only with the first-run consent on or on Check for Updates. No identifier, no version in the URL; the user agent is the updater plugin's name and version. Off: the first-run switch, Settings ▸ Updates, `DisableUpdateCheck`; `UpdateEndpoint` sends it to your server instead. |
| Update install: what is sent? | Yes | [updater.rs](../src-tauri/src/updater.rs) | Nothing goes up. The signed archive comes down only on Install and relaunch. Off: Later, or `DisableUpdateCheck`. |
| Edit with Claude: what is sent? | Yes | [claude_app.rs](../src-tauri/src/claude_app.rs), [SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent) | The project folder's path and a starter prompt, handed to the Claude desktop app on the same Mac and never sent until the person presses Enter there. Claude Code then sends project files to Anthropic under the person's own account. Off: `DisableClaude`, `DisableAgentKit`. |
| Live websites in a scene: what is sent? | Yes | [website.rs](../src-tauri/src/website.rs), [scene-website.md](./scene-website.md#origin-and-navigation-policy) | Nothing until a person allows that origin for that project. The page then loads like a browser tab, HTTPS or loopback only. Off: revoke in the inspector, `DisableLiveWebsites`; only your own sites: `AllowedWebsiteOrigins`. |
| Does the app open other pages? | Yes | [claude_app.rs](../src-tauri/src/claude_app.rs) | Get Claude and What leaves your Mac open fixed URLs in the default browser, nothing appended. |
| Is there any other network client in the app? | No | [Cargo.toml](../src-tauri/Cargo.toml), [realmGuard.ts](../src/stage/realmGuard.ts), [build-ffmpeg-sidecar.sh](../scripts/build-ffmpeg-sidecar.sh) | No Rust HTTP client of its own (reqwest only through the updater plugin, and `deny.toml` bans the rest); scene code runs behind a guard that refuses every network API but the app's own files; the release ffmpeg is built with `--disable-network`. |
| Can an organisation list and restrict egress? | Yes | [subprocessors.md](./subprocessors.md), [fleet.md](./fleet.md) | Hosts: `github.com` and `release-assets.githubusercontent.com` (or your `UpdateEndpoint`), plus origins a person approves (only those on `AllowedWebsiteOrigins`, when forced). With `DisableUpdateCheck`, `DisableClaude` and `DisableLiveWebsites` the app makes no request of its own; What leaves your Mac still opens the privacy page in the browser. |
| Is the agent bridge a network service? | No | [bridge.rs](../src-tauri/src/bridge.rs) | A file queue in an owner-only folder, not a socket. |

## Data at rest, retention and deletion

SIG: Asset and information management, Privacy management. CAIQ: DSP, IPY.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Where is customer data stored? | Yes | [SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac), [workspace.rs](../src-tauri/src/workspace.rs) | On the Mac only: projects in `~/Kookaburra Cut` (or the path `WorkspaceRoot` forces), app data in `~/Library/Application Support/com.mpalmes.kookaburracut`, exports in `~/Downloads` or the project. |
| Data residency or region? | Not applicable | [SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac) | No server, tenant or region: the data stays on the device. |
| Is app data restricted to the user? | Yes | [privacy.rs](../src-tauri/src/privacy.rs) | Folders 0700, files 0600, re-sealed at every launch, skipped by Spotlight. A workspace folder the app creates is 0700; projects inside it are the person's documents and take the default mode. |
| Are caches bounded? | Yes | [clip_cache.rs](../src-tauri/src/clip_cache.rs), [bridge.rs](../src-tauri/src/bridge.rs) | Decoded frames capped at 20 GB by default with least-recently-used eviction; bridge answers at most an hour and 2 GiB; import backups 24 hours. |
| Are caches kept out of backups? | Yes | [privacy.rs](../src-tauri/src/privacy.rs) | `cache/clips` and `cache/media` carry Time Machine's exclusion at every launch. Projects back up like any document. |
| Is footage kept out of project history? | Yes | [history.rs](../src-tauri/src/history.rs) | A project's git holds scenes and settings only, so a deleted asset is gone. |
| Can a person delete their data? | Yes | [settings_win.rs](../src-tauri/src/settings_win.rs), [workspace.rs](../src-tauri/src/workspace.rs), [security-overview.md](./security-overview.md#uninstall) | A project delete moves it to the Trash and drops its grant and cache entries; Settings ▸ Website data clears site storage; Settings ▸ Allowed projects ▸ Forget drops one grant; Settings ▸ Storage ▸ Clear all app data clears every cache, the website data, the bridge queues, grants and preferences, and keeps the projects, the pack key and the log. Uninstall steps at the link. |
| Is deleted data securely erased? | No | [workspace.rs](../src-tauri/src/workspace.rs) | Deletes go to the Trash or are removed in place. FileVault is the protection for what remains on disk. |
| How long does the vendor retain customer data? | Not applicable | [subprocessors.md](./subprocessors.md) | The vendor holds none. |
| Can data be exported in an open format? | Yes | [packs.md](./packs.md), [agent-kit.md](./agent-kit.md) | Projects are plain files (`project.json`, `scenes/*.tsx`, `assets/`); a pack is a zip with a JSON manifest. |

## Encryption and keys

SIG: Information assurance. CAIQ: CEK.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the app encrypt data at rest? | No | [privacy.md](./privacy.md#what-the-app-keeps-on-your-mac-and-how-to-clear-it) | Projects, caches, settings and the log are not encrypted by the app. FileVault and the macOS account are the protection at rest. |
| Is data in transit encrypted? | Yes | [tauri.conf.json](../src-tauri/tauri.conf.json), [scene-website.md](./scene-website.md#origin-and-navigation-policy) | The update endpoint is HTTPS and an `UpdateEndpoint` must be; a live website must be HTTPS, or HTTP only on loopback with an explicit port; TLS errors are never bypassed. |
| What secrets does the app keep? | Yes | [SECURITY.md, "Saved secrets"](../SECURITY.md#saved-secrets), [key.rs](../src-tauri/src/pack/key.rs) | One: the pack signing key. The app holds no password, token or API key for anyone. |
| Which Keychain items does the app create? | Yes | [packs.md](./packs.md#signing-and-trust-on-first-use), [mdm.md](./mdm.md#keys) | One generic password in the login Keychain: service "Kookaburra Cut pack signing key", account the bundle identifier, not synchronisable, made on the first pack export. Never made under `DisablePackExport`. A 0600 file in app data stands in only where the Keychain cannot answer. |
| Are keys generated from a secure source? | Yes | [key.rs](../src-tauri/src/pack/key.rs), [best-practices.md](./best-practices.md) | The operating system's entropy source (`getrandom`). |
| Which algorithms are used? | Yes | [best-practices.md](./best-practices.md) | Ed25519 (packs, updater), SHA-256 (file and content hashes), Apple code signing. No MD5, SHA-1 or short RSA in the app's own cryptography. |
| Can keys be rotated? | Yes | [publisher.rs](../src-tauri/src/pack/publisher.rs), [release skill](../.agents/skills/kookaburra-release/SKILL.md) | The pack key from Settings ▸ Publisher. The updater key can rotate, at the cost of one manual download per install. |
| Where are the release signing keys held? | Yes | [release.yml](../.github/workflows/release.yml), `gh api repos/michael-palmes/kookaburra-cut/environments` | The Developer ID certificate, notary key and updater key are secrets of the `release` environment: `v*` tags only, behind a required reviewer. The tag-signing key sits in a Mac's Secure Enclave and cannot be copied off it. |

## Authentication and access

SIG: Access control. CAIQ: IAM.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the app have user accounts or sign-in? | No | [security-overview.md](./security-overview.md#what-the-app-does-not-do) | No sign-in, licence key or registration. Access is the macOS user account. |
| Does it support SSO or MFA? | Not applicable | [security-overview.md](./security-overview.md#what-the-app-does-not-do) | Nothing to sign in to. Claude Code signs in under its own account, outside the app. |
| Does the app need administrator rights? | No | [updater.rs](../src-tauri/src/updater.rs) | Only an in-app update into a folder the user cannot write asks macOS for an administrator password; `DisableUpdateCheck` removes it. |
| Are the app's internal privileges least privilege? | Yes | [capabilities](../src-tauri/capabilities/), [acl.rs](../src-tauri/src/acl.rs) | Each window holds only the native commands it uses, and only the Tauri core permissions its code calls (no `core:default`, menu or tray); a test fails on a command not yet placed or a core permission no window needs. Remote website content gets none. |
| Are trust decisions made outside the webview? | Yes | [native_alert.rs](../src-tauri/src/native_alert.rs), [SECURITY.md](../SECURITY.md#scene-code-and-the-trust-boundary) | Allow, website grants, moving the workspace and Clear all app data are answered on native sheets, so a compromised page cannot press the button. |
| Who can change the code or ship a release? | Partial | `gh api repos/michael-palmes/kookaburra-cut/collaborators`, [allowed_tag_signers](../.github/allowed_tag_signers), [allowed_signers](../.github/allowed_signers) | One admin, the maintainer, and one collaborator with write access, the second reviewer. A release run needs approval from a reviewer who did not start it, so the second reviewer approves the maintainer's releases, but the admin can change that rule, so the pipeline rests on the admin account. The one sanctioned change, a break-glass for an urgent security fix, is named in that release's notes and advisory ([incident-response.md](./incident-response.md)). |
| Does the maintainer's GitHub account require a second factor? | Yes | The maintainer's statement; GitHub shows a personal account's second factor to no one else | A passkey. |
| Is the Mac holding the release tag key protected? | Partial | [release skill, "Signing keys"](../.agents/skills/kookaburra-release/SKILL.md#signing-keys) | FileVault is on, and the tag key sits in its Secure Enclave behind Touch ID. The Mac is not managed by MDM and runs no EDR or antivirus beyond macOS's own. |
| Is access separated from other users on the same Mac? | Partial | [privacy.rs](../src-tauri/src/privacy.rs), [workspace.rs](../src-tauri/src/workspace.rs) | App data is owner-only. A workspace folder the app creates (from 0.23.0) is 0700, so other accounts can't list its projects; a folder that already existed, including one an earlier version made, keeps its mode. `chmod 700 ~/"Kookaburra Cut"` closes it. |

## Logging and audit

SIG: IT operations management. CAIQ: LOG.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the app keep an audit log? | Yes | [audit.rs](../src-tauri/src/audit.rs), [SECURITY.md, "On the Mac"](../SECURITY.md#on-the-mac) | `~/Library/Application Support/com.mpalmes.kookaburracut/logs/app.log`, in release and dev builds. |
| What does it record? | Yes | [audit.rs](../src-tauri/src/audit.rs) | Allow given, declined and asked again; website origins allowed and removed; pack imports with the publisher's key id and verdict; update checks and installs; workspace moves and project deletes; what a kit stamp moved; managed keys and each key's first refusal a launch; what the startup seal corrected. |
| Does it exclude content and secrets? | Yes | [audit.rs](../src-tauri/src/audit.rs) | Paths, slugs, origins, key ids, versions and counts only; never a file's contents or a secret. Names a pack or page chose are escaped onto one line. |
| Is it bounded and protected? | Yes | [audit.rs](../src-tauri/src/audit.rs), [privacy.rs](../src-tauri/src/privacy.rs) | 1 MiB a file, three files, at most 3 MiB. Folder 0700, files re-sealed to 0600 at launch, skipped by Spotlight. |
| Is it tamper-evident? | No | [audit.rs](../src-tauri/src/audit.rs) | Plain text with no signature or hash chain; a process running as the same user can edit it. |
| Can it be turned off? | No | [decisions.md](./decisions.md) | No managed key turns it off: nothing in it leaves the Mac, and a switch that removes evidence is the first thing an attacker with admin would set. |
| Is it forwarded to a SIEM or to the vendor? | No | [subprocessors.md](./subprocessors.md) | Never leaves the Mac. It is a plain file at a fixed path, so a fleet's own agent can collect it. |

## Vulnerability management

SIG: Threat management. CAIQ: TVM.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is there a private way to report a vulnerability? | Yes | [SECURITY.md, "Reporting a vulnerability"](../SECURITY.md#reporting-a-vulnerability), `gh api repos/michael-palmes/kookaburra-cut/private-vulnerability-reporting` | GitHub private vulnerability reporting, enabled: a draft advisory only the maintainer sees. |
| Is there an acknowledgement time? | Yes | [SECURITY.md, "Reporting a vulnerability"](../SECURITY.md#reporting-a-vulnerability) | Within 14 days, usually sooner. |
| Which versions receive security fixes? | Yes | [SECURITY.md, "Supported versions"](../SECURITY.md#supported-versions) | The latest release only. |
| Is there a committed time to fix? | No | [SECURITY.md, "Supported versions"](../SECURITY.md#supported-versions), [release-cadence.md](./release-cadence.md) | Fixes ship in the latest release only, best effort, with no committed time. Older versions are not patched; the in-app updater moves people forward. |
| Are fixes disclosed? | Yes | [CHANGELOG.md](../CHANGELOG.md) | Each fix is a `### Security` entry, with its GHSA advisory linked when one exists; the release notes are built from that section. |
| Are dependencies scanned for known vulnerabilities? | Yes | [audit.yml](../.github/workflows/audit.yml), [dependency-review.yml](../.github/workflows/dependency-review.yml), [dependabot.yml](../.github/dependabot.yml), `gh api repos/michael-palmes/kookaburra-cut --jq .security_and_analysis` | `pnpm audit` and `cargo deny` against RustSec on every pull request and weekly; dependency review on what a pull request adds; Dependabot weekly for npm, both Cargo locks and Actions, with security updates on. |
| Is osv-scanner used? | Partial | [osv-scanner.toml](../src-tauri/osv-scanner.toml), [scorecard.yml](../.github/workflows/scorecard.yml) | Its configuration sits beside each Cargo lock and records three advisories as ignored with the reason, each in a crate only the Linux or BSD build compiles; Scorecard's Vulnerabilities check reads it. There is no separate osv-scanner job. |
| Is static analysis run? | Yes | [codeql.yml](../.github/workflows/codeql.yml), [ci.yml](../.github/workflows/ci.yml) | CodeQL over JavaScript and TypeScript, Rust, Actions and Python on every pull request, push and weekly; clippy with warnings denied; biome. |
| Is `unsafe` Rust controlled? | Yes | [Cargo.toml](../src-tauri/Cargo.toml) | Denied crate-wide, allowed per file or function, every block with a one-line SAFETY comment. Not yet run under a sanitiser. |
| Are untrusted inputs fuzzed? | Partial | [fuzz.yml](../.github/workflows/fuzz.yml), [fuzz](../src-tauri/fuzz/) | Weekly libFuzzer over pack paths, manifests and signatures, edit documents, font faces, the mp4 reader and PNG decode. Font shaping, glTF and the whole archive reader are tested on hostile fixtures, not fuzzed ([SECURITY.md, "Not yet"](../SECURITY.md#not-yet)). |
| Is secret scanning on? | Yes | `gh api repos/michael-palmes/kookaburra-cut --jq .security_and_analysis` | Secret scanning and push protection are enabled. |
| Are releases scanned for malware? | Yes | [sign-and-notarize.sh](../scripts/sign-and-notarize.sh) | Apple's notary service checks each release before issuing its ticket. |
| Has a third-party penetration test been done? | No | [security-overview.md](./security-overview.md#questionnaire-answers) | None. The maintainer's own audit in November 2026 drove the changes from 0.22.0 on. |

## Change control and secure development

SIG: IT operations management, Application security. CAIQ: CCC, AIS.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does every change land through a pull request with required checks? | Yes | `gh api repos/michael-palmes/kookaburra-cut/rulesets/19092788`, [ci.yml](../.github/workflows/ci.yml) | `main` takes squash merges only, no force push or deletion, and requires `frontend`, `rust` and `Signed head` (pinned to the app that posts it), up to date with `main`. |
| Are commits signed? | Partial | [signers.yml](../.github/workflows/signers.yml), [allowed_signers](../.github/allowed_signers) | Every pull request's head commit must be signed by a listed key, by the tag key when it touches the pipeline, locks or pins. Only the head commit is checked. |
| Is every change reviewed by a second person? | Partial | `gh api repos/michael-palmes/kookaburra-cut/rulesets/19092788`, [CODEOWNERS](../.github/CODEOWNERS), `gh api repos/michael-palmes/kookaburra-cut/codeowners/errors` | The ruleset requires an approval, a code owner and approval of the last push, but the maintainer, as the one admin, bypasses it on a pull request; status checks still apply. CODEOWNERS names a second reviewer on the security surfaces, an active collaborator with write access, so GitHub requests their review there; the admin bypass means that review is not required. The process also calls for an automated high-effort code review before each pull request ([SECURITY.md, "Process"](../SECURITY.md#process)); nothing enforces it. |
| Are duties separated between writing, approving and releasing? | Partial | [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity), `gh api repos/michael-palmes/kookaburra-cut/environments/release` | Approving a release run takes a second person: self-review is prevented and admins cannot bypass. Writing and merging do not: the maintainer merges through the admin bypass, and as admin can change the environment's rules, which the break-glass for an urgent security fix does on the record ([incident-response.md](./incident-response.md)). |
| Are release tags protected? | Yes | `gh api repos/michael-palmes/kookaburra-cut/rulesets/19092476` | `v*` tags cannot be deleted, moved or updated, with no bypass. |
| Are build and signing separated? | Yes | [release.yml](../.github/workflows/release.yml) | A keyless build job, a sign job in the protected environment that never builds or installs, and a verify job with no secret, each on a fresh runner. |
| Do workflows run with least privilege? | Yes | [workflows](../.github/workflows/) | Each starts from `permissions: {}` or `contents: read` (Scorecard from `read-all`, narrowed per job) and sets `persist-credentials: false`. |
| Are tests run in CI? | Yes | [ci.yml](../.github/workflows/ci.yml), [ci-scope.sh](../scripts/ci-scope.sh) | Lint, typecheck and build, unit and script tests on every pull request; the kit suite, clippy and `cargo test` on every pull request that touches what they read, and on every push to `main`. |
| Is production data kept out of development? | Yes | [workspace-names.mjs](../scripts/workspace-names.mjs), [workspace-denylist.txt](../scripts/workspace-denylist.txt) | There is no production data. A check on every branch keeps local project names out of the repository; CI runs its denylist half. |
| Do exports stay exact across changes? | Partial | [determinism.md](./determinism.md) | A change to the export path is gated on recorded byte-identical hashes before it merges. The gate runs on the maintainer's Mac, not in CI. |

## Supply chain and release integrity

SIG: Supply chain risk management. CAIQ: STA.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Are CI actions pinned? | Yes | [workflows](../.github/workflows/) | Every action is pinned to a commit SHA. |
| Are dependencies and tools pinned? | Yes | [rust-toolchain.toml](../rust-toolchain.toml), [package.json](../package.json), [install-build-tools.sh](../scripts/install-build-tools.sh), [build-ffmpeg-sidecar.sh](../scripts/build-ffmpeg-sidecar.sh), [setup-models.sh](../scripts/setup-models.sh) | Lock files for npm and both Cargo graphs; exact Rust, Node and pnpm; build tools, ffmpeg, x264, x265 and the beat model by SHA-256. |
| Do dependency install scripts run? | No | [pnpm-workspace.yaml](../pnpm-workspace.yaml) | pnpm runs none, and a lock that adds one fails install until it is reviewed. |
| Is there a dependency licence and source policy? | Yes | [deny.toml](../src-tauri/deny.toml), [dependency-review.yml](../.github/workflows/dependency-review.yml) | An allow list of permissive licences (plus OFL-1.1 for fonts), crates.io as the only source, no wildcard versions. |
| Is an SBOM published? | Yes | [sbom.mjs](../scripts/sbom.mjs), [release.yml](../.github/workflows/release.yml) | CycloneDX 1.5, `KookaburraCut-<version>.cdx.json` on each release, attested on the DMG and the pkg: npm packages, crates for the shipped target, the sidecar's sources, the beat model, and the bundled fonts, HDRIs, device models, adapted shaders and kit scripts with their hashes. The binary also embeds its crate list (`cargo auditable`). |
| Does the app ship its third-party licences? | Yes | [NOTICE.md](../NOTICE.md), [licence-notices.mjs](../scripts/licence-notices.mjs), [verify-release.sh](../scripts/verify-release.sh) | The app carries the GPL texts from the sidecar's sources, the font, shader and model licences and a notice with the licence of every npm package and crate (Settings ▸ About ▸ Acknowledgements). A release without them fails verification. Each release attaches the sidecar's source archives. |
| Is build provenance published? | Yes | [release.yml](../.github/workflows/release.yml) | A GitHub build provenance attestation (SLSA provenance predicate) over the DMG, pkg, zip, updater archive, `build-info.txt`, the SBOM and the sidecar's source archives, published as `KookaburraCut-<version>.intoto.jsonl` for offline checks. No SLSA level is claimed. |
| Are releases signed and notarised? | Yes | [sign-and-notarize.sh](../scripts/sign-and-notarize.sh), [verify-release.sh](../scripts/verify-release.sh) | Developer ID, hardened runtime, no entitlements, notarised and stapled; Team ID `Q4B8N8ZKA2`. A separate job checks every signature and every file against the keyless build's record. |
| Are updates verified before install? | Yes | [tauri.conf.json](../src-tauri/tauri.conf.json), [updater.rs](../src-tauri/src/updater.rs) | Ed25519 signature against the key built into the app, bound to the announced version, so an old archive cannot roll an install back. |
| Can a customer verify a download? | Yes | [security-overview.md](./security-overview.md#verify-it-yourself), [verify-install.sh](../scripts/verify-install.sh) | `SHA256SUMS`, `gh attestation verify`, `codesign` and `spctl`, and one script that runs them all. |
| Are builds reproducible? | No | [determinism.md](./determinism.md) | Not claimed: the runner image and Xcode float and are recorded in `build-info.txt`. The exported film is reproducible, and each release is gated on it. |
| Is the build environment fresh and recorded? | Partial | [release.yml](../.github/workflows/release.yml) | A fresh GitHub-hosted runner per job; toolchains pinned, runner image and Xcode recorded, not pinned. |
| Are licensed third-party assets checked? | Yes | [licensed.sha256](../src/assets/models/licensed.sha256) | The licensed device models arrive encrypted from a private repository and must match pinned SHA-256s. |
| May films made with the bundled device models be published? | Yes | [NOTICE.md](../NOTICE.md#bundled-assets) | Renders of the device models may be published freely, commercial use included; the model files may not be extracted or redistributed, and Apple's trademarks and trade dress are the user's own call. |

## Business continuity

SIG: Operational resilience. CAIQ: BCR.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is there a business continuity or disaster recovery plan for the service? | Not applicable | [security-overview.md](./security-overview.md#what-the-app-does-not-do) | There is no service. The app runs on the Mac, offline, with no licence server. |
| Does the app depend on the vendor to keep working? | No | [SECURITY.md, "What leaves the Mac"](../SECURITY.md#what-leaves-the-mac) | If GitHub is down, only update checks and downloads fail. |
| Can the project continue without its one maintainer? | Partial | [release-cadence.md, "If the project stops"](./release-cadence.md#if-the-project-stops), [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity) | Key-person risk: one maintainer holds admin rights and the only tag key a release accepts, so nobody else can ship a signed release today, and no successor is named. Installed apps keep working and the code can be forked. |
| Could someone else build and ship it? | Yes | [LICENSE-MIT](../LICENSE-MIT), [LICENSE-APACHE](../LICENSE-APACHE), [release.yml](../.github/workflows/release.yml) | The code is MIT or Apache-2.0 and every tool and source is pinned and recorded. A fork ships under its own signing identity. |
| What does a lost updater key mean? | Yes | [release skill](../.agents/skills/kookaburra-release/SKILL.md), [tauri.conf.json](../src-tauri/tauri.conf.json) | Installed apps trust only the key built into them, so after a new key each install needs one manual download; updates then resume. |
| What does a lost tag or commit key mean? | Yes | [release skill, "Recovery for a lost Mac"](../.agents/skills/kookaburra-release/SKILL.md#recovery-for-a-lost-mac) | Neither has a backup, by design. The repository admin replaces them; published releases are unaffected, and a tag not yet built is cut again. |
| What does a lost pack key mean? | Yes | [packs.md](./packs.md#signing-and-trust-on-first-use) | Packs already signed stay valid. Packs from a new key show recipients a changed-key warning. |
| Is source escrow available? | Not applicable | [README.md](../README.md) | The source is public. |

## Incident response

SIG: Cybersecurity incident management. CAIQ: SEF.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is there an incident response process? | Partial | [SECURITY.md, "Reporting a vulnerability"](../SECURITY.md#reporting-a-vulnerability), [CHANGELOG.md](../CHANGELOG.md), [incident-response.md](./incident-response.md) | A report becomes a private draft advisory, the fix ships in a release with a `### Security` entry, and the advisory is linked. One person runs it, best effort. |
| What happens if a release or a signing key is compromised? | Partial | [incident-response.md](./incident-response.md) | Pull the release, publish a GitHub security advisory, rotate the tag, updater and Developer ID keys, and ship a fixed version through the updater. A new updater key costs one manual download per install, and there is no check of an installed app against its release file by file yet. |
| Will customers be told of a breach of their data? | Not applicable | [subprocessors.md](./subprocessors.md) | The vendor holds no customer data and no customer list. Security releases reach people through the in-app update check, the release notes and the repository's advisories. |
| Is there evidence on the device for an investigation? | Yes | [audit.rs](../src-tauri/src/audit.rs) | The app log records grants, imports, updates and refusals. The vendor holds no logs from the app. |
| Can a customer contain an incident on their own fleet? | Yes | [mdm.md](./mdm.md#keys) | A profile can stop updates, pack imports, live websites and every Claude entry point at the next launch. |

## Managed Macs

SIG: Endpoint security. CAIQ: UEM.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Can an MDM configure the app? | Yes | [mdm.md](./mdm.md), [managed.rs](../src-tauri/src/managed.rs) | Eleven keys in `com.mpalmes.kookaburracut`, honoured only while macOS reports them forced by a profile; a user's own `defaults write` grants nothing. |
| Does a malformed setting fail closed? | Yes | [managed.rs](../src-tauri/src/managed.rs) | A wrong type reads as the most restrictive value; an unusable `UpdateEndpoint` means no update check, never GitHub. |
| Can Claude entry points be turned off? | Yes | [mdm.md](./mdm.md#keys) | `DisableClaude`. |
| Can everything the app lays out for an agent be turned off? | Yes | [mdm.md](./mdm.md#keys) | `DisableAgentKit`: no kit, no bridge folder, no handoff. |
| Can live websites be turned off? | Yes | [mdm.md](./mdm.md#keys) | `DisableLiveWebsites`, or `AllowedWebsiteOrigins` to allow only your own sites' exact origins. |
| Can pack imports be limited to approved publishers? | Yes | [mdm.md](./mdm.md#keys) | `AllowedPublisherKeyIds`; an empty list means no imports. |
| Can pack export be turned off? | Yes | [mdm.md](./mdm.md#keys) | `DisablePackExport`; no signing key is ever made. |
| Can update checks be turned off or redirected? | Yes | [mdm.md](./mdm.md#keys) | `DisableUpdateCheck`, or `UpdateEndpoint` for your own server; archives must still carry this project's signature. |
| Can exports be kept out of Downloads? | Yes | [mdm.md](./mdm.md#keys) | `ExportsInProject`. |
| Can the project location be fixed? | Yes | [mdm.md](./mdm.md#keys) | `WorkspaceRoot`. |
| Does the app install background processes? | No | [security-overview.md](./security-overview.md#what-the-app-does-not-do), [fleet.md](./fleet.md#what-to-expect-in-edr) | No launch agent, login item or helper tool. Its child processes are listed for EDR. |
| Does it run sandboxed? | Partial | [decisions.md](./decisions.md), [realmGuard.ts](../src/stage/realmGuard.ts) | Hardened runtime, no entitlements, no App Sandbox. Scene code runs in a worker with no DOM, IPC or network. |
| Can versions be installed and pinned through MDM? | Partial | [fleet.md](./fleet.md#updates-in-app-or-mdm-delivery), [SECURITY.md, "Not yet"](../SECURITY.md#not-yet) | Deliver the signed pkg (or the DMG) and set `DisableUpdateCheck`. A Homebrew cask is staged in [packaging/homebrew](../packaging/homebrew/) until its tap is published; [fleet-deployment.md](./fleet-deployment.md) has an install script that pins a version and its SHA-256. |

## Privacy

SIG: Privacy management. CAIQ: DSP.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the vendor process personal data? | No | [privacy.md](./privacy.md), [subprocessors.md](./subprocessors.md) | No account, telemetry or upload. Mail sent to `security@` or `privacy@` reaches the maintainer's Gmail mailbox (Google) and is kept 2 years after the last message in a thread. The website keeps no access log; its error log can record a failed request's IP address. |
| Is a data processing agreement needed? | Not applicable | [subprocessors.md](./subprocessors.md) | Nothing is processed on the customer's behalf. Anthropic's terms cover what a person sends through their own Claude Code. |
| Are there cross-border transfers? | Not applicable | [subprocessors.md](./subprocessors.md) | None by the app. Claude Code and approved websites go where their providers do. |
| Does the app read device or identity data? | No | [packs.md](./packs.md#signing-and-trust-on-first-use), [scene-website.md](./scene-website.md#native-boundary) | No entitlements, so no camera, microphone or location; website views deny device permissions; a pack names its device only as `Mac`, never the computer name. |
| Is there a privacy notice? | Yes | [privacy.md](./privacy.md) | The app opens it from What leaves your Mac, at the installed version's tag. |
| Can data subject requests be met? | Not applicable | [privacy.md](./privacy.md#what-the-app-keeps-on-your-mac-and-how-to-clear-it) | The vendor holds nothing; the person deletes on their Mac. |

## AI

SIG: Artificial intelligence. The CAIQ v4 has no AI domain.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Does the product use AI or machine learning? | Yes | [setup-models.sh](../scripts/setup-models.sh), [ocr.rs](../src-tauri/src/ocr.rs) | On the Mac only: a bundled, pinned beat-tracking model for music, and Apple's Vision for text in stills. Neither sends anything. |
| Does the vendor call a hosted AI model? | No | [SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent) | The app holds no API key and starts no Claude Code. Edit with Claude hands off to the person's own install. |
| Is customer data used to train models? | No | [subprocessors.md](./subprocessors.md) | The vendor receives none. Claude Code's data use is set by the person's Anthropic account and organisation. |
| Can the AI integration be turned off? | Yes | [mdm.md](./mdm.md#keys) | `DisableClaude` and `DisableAgentKit`. |
| Is the agent bounded? | Partial | [SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent), [fleet.md](./fleet.md#claude-codes-own-managed-settings-on-top) | Project text is data, never instructions; commands that look like sending work off the Mac ask first; kb refuses credential folders. Not a sandbox: a script a misled agent runs can still read a file. |

## Compliance

SIG: Compliance management. CAIQ: A&A.

| Question | Answer | Evidence | Notes |
| --- | --- | --- | --- |
| Is there a SOC 2 report? | No | [security-overview.md](./security-overview.md#questionnaire-answers) | None. |
| Is there an ISO/IEC 27001 certificate? | No | [security-overview.md](./security-overview.md#questionnaire-answers) | None. |
| Has a third-party penetration test been done? | No | [security-overview.md](./security-overview.md#questionnaire-answers) | None. |
| Any other certification or attestation (CSA STAR, ISO 27701, PCI DSS, HIPAA, FedRAMP)? | No | [security-overview.md](./security-overview.md#questionnaire-answers) | None held. |
| Is the security posture published for checking? | Yes | [SECURITY.md](../SECURITY.md), [scorecard.yml](../.github/workflows/scorecard.yml) | The record, the deferrals and the Scorecard results are public. |

## Not applicable

| Domain | Why |
| --- | --- |
| Human resources security (HRS) | A sole maintainer, with no employees or contractors, so staff screening, training and offboarding do not apply. Nobody receives customer data ([subprocessors.md](./subprocessors.md)). Contributions arrive as pull requests and are reviewed before they merge; the second reviewer is a collaborator, not staff (`gh api repos/michael-palmes/kookaburra-cut/collaborators`). |
| Physical and environmental security (DCS) | No office, data centre or hosted data. Releases build on GitHub-hosted runners ([release.yml](../.github/workflows/release.yml)). |
| Server security, Cloud hosting services (IVS) | No server and no hosted service. |

Not answered here: ESG and accessibility. The vendor, the terms, support and
insurance are in [Governance and risk](#governance-and-risk).
