# Third-party assessment

**Version:** 0.25.0, pending.

For the security team that must assess Kookaburra Cut before it is allowed on
corporate Macs. It covers the two audits such an assessment usually asks for,
[AI data flows](#ai-data-flows) and
[source code integrity](#source-code-integrity), then maps common
[deployment conditions](#deployment-conditions) to the control behind each, and
ends with [what no control here can give you](#what-this-cannot-give-you).
Nothing on this page is new evidence: each line points at the file, command or
release asset that proves it. A "pending" version line names a release not yet
tagged ([vendor-questionnaire.md](./vendor-questionnaire.md#version)).

The long forms: [security-overview.md](./security-overview.md) for the
decision-maker, [SECURITY.md](../SECURITY.md) for every control,
[vendor-questionnaire.md](./vendor-questionnaire.md) for SIG Lite and CAIQ
answers, [subprocessors.md](./subprocessors.md) for every third party, and
[fleet.md](./fleet.md) with [mdm.md](./mdm.md) for deployment.

## In short

| Question | Answer | Evidence |
| --- | --- | --- |
| Who is the vendor? | One maintainer. No company, contract, certification or insurance. The source is public under MIT or Apache-2.0 | [vendor-questionnaire.md](./vendor-questionnaire.md#governance-and-risk) |
| What leaves the Mac? | Three paths, each started by a person: an update check, the install it offers, and the Edit with Claude handoff. The app loads no web page and runs no service | [SECURITY.md, "What leaves the Mac"](../SECURITY.md#what-leaves-the-mac) |
| Does the app call an AI service? | No. It holds no API key and links no HTTP client of its own. Claude is off until a person turns it on, and a profile can keep it off | [AI data flows](#ai-data-flows) |
| Can we check a release ourselves? | Yes: signatures, notarisation, build provenance and the SBOM, without trusting the maintainer's word | [security-overview.md](./security-overview.md#verify-it-yourself) |
| What is deferred? | A public list, the same in every document | [SECURITY.md, "Not yet"](../SECURITY.md#not-yet) |

## AI data flows

The one AI path that leaves the Mac is Anthropic's Claude Code, which the
person installs and signs in to themselves. The app's two on-device models
(beat tracking and Apple's Vision for text in stills) send nothing
([vendor-questionnaire.md](./vendor-questionnaire.md#ai)).

**What the app sends.** Nothing to Anthropic. It holds no API key, starts no
Claude Code and links no HTTP client of its own
([SECURITY.md, "What reaches your agent"](../SECURITY.md#what-reaches-your-agent)).

**While Claude is off,** which is how the app starts, it writes no agent files
into a project, keeps no bridge folder and shows no Claude entry point. One
gate stands in front of all of it (`src-tauri/src/agent_gate.rs`).

**Once a person turns Claude on,** the app does three things on the Mac: it
writes the agent kit into each project it opens (`./kb`, `.kb/`, `.claude/`,
`CLAUDE.md`), it serves a file queue for the agent in the workspace's `_bridge`
folder (not a socket), and Edit with Claude opens the Claude desktop app on the
project folder. From there Claude Code sends what it reads to Anthropic under
the person's own login: project files, and any frame or text the agent looks
at. Treat the whole project folder as in scope
([subprocessors.md](./subprocessors.md#anthropic-through-the-persons-own-claude-code)).
What Anthropic keeps, and whether it trains on it, is set by that Anthropic
account and its organisation, not by this app.

| Control | What it does | Set by |
| --- | --- | --- |
| The first-launch choice | Claude stays off until a person picks With Claude; nothing is selected for them. Settings ▸ Claude changes it | The person |
| `DisableClaude` and `DisableAgentKit` | Forced together, Claude cannot be turned on: no entry point, no kit, no bridge, no handoff | Your profile ([mdm.md](./mdm.md#keys)) |
| `RequireManagedClaude` | Claude can be turned on only on a Mac whose Claude Code managed settings pin sign-in to an organisation (`forceLoginOrgUUID`), so project content goes under your own agreement with Anthropic | Your profile ([mdm.md](./mdm.md#keys)) |
| Claude Code's managed settings | The organisation login pin, credential deny rules and no bypass mode, for every session on the Mac | Your Claude Code policy ([fleet.md](./fleet.md#claude-codes-own-managed-settings-on-top)) |
| Your network | Block Anthropic's hosts where Claude is not approved. The app works in full without them | Your proxy or firewall |

**Check it yourself,** on a Mac with Claude off and update checks off:

```bash
ls -a "<a project folder>"            # no kb, .kb, .claude or CLAUDE.md the app wrote
ls "$HOME/Kookaburra Cut/_bridge"     # absent where Claude was never turned on
grep '\[claude\]' "$HOME/Library/Application Support/com.mpalmes.kookaburracut/logs/app.log"   # one line per change of the choice
```

Then watch the app with your own network monitor while you open, edit, export
and present a project: it makes no connection. The forced keys are named in
the app log at each launch ([mdm.md](./mdm.md#verifying)).

**Limits.** The agent is bounded, not sandboxed: a script a misled agent runs
can still read a file. The app cannot stop a person running Claude Code in a
folder by themselves; that is Claude Code's own policy to govern.
`RequireManagedClaude` proves the policy is installed on the Mac, not which
account is signed in, and it cannot see settings delivered only from the
claude.ai admin console.

## Source code integrity

One maintainer holds the repository's admin rights, so the supply-chain
question is what an attacker with that one account could ship, and what you
can check without trusting it.

| Risk | What bounds it | Evidence |
| --- | --- | --- |
| A stolen GitHub login cuts a release | A release is a tag signed by a Touch ID key in a Mac's Secure Enclave. The key cannot be copied off the Mac, and the build refuses any other signer | `.github/allowed_tag_signers`, `.github/workflows/release.yml` |
| A malicious pull request is merged | Every pull request's head commit must be signed by a listed key, checked by a job the pull request cannot change, and every status check must pass before a merge: CodeQL, dependency review and the tests among them | [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity) |
| The build leaks or misuses the signing identity | The build job has no signing secret. Signing runs in a protected environment behind a reviewer who did not start the run | [SECURITY.md, "Release integrity"](../SECURITY.md#release-integrity) |
| The published file is not what was built | A fresh runner verifies every file in the signed app against the build's record; build provenance attestations and `SHA256SUMS` cover each asset | [security-overview.md](./security-overview.md#how-releases-are-built) |
| A dependency turns hostile | `cargo deny` and `pnpm audit` on every pull request and weekly, Dependabot, every action pinned to a commit, the sidecar's sources pinned by SHA-256, an SBOM with each release | [vendor-questionnaire.md](./vendor-questionnaire.md#supply-chain-and-release-integrity) |
| An update replaces a vetted build | A copy installed from the pkg never updates itself. Any other copy accepts only an archive signed by the key built into the app | [fleet.md](./fleet.md#updates-in-app-or-mdm-delivery) |
| Hostile input crashes or escapes the parsers | Weekly fuzzing of the untrusted-input parsers, and bounded readers tested on hostile fixtures | [security-assessment-scope.md](./security-assessment-scope.md#fuzzing) |

**Check it yourself.** `scripts/verify-install.sh` runs every check in
[security-overview.md, "Verify it yourself"](./security-overview.md#verify-it-yourself):
the signatures, notarisation, the attestation that ties each file to this
repository's release workflow at that tag, and a diff of the controls since
the previous release. Review that diff before each rollout, and hold the fleet
on the version you reviewed
([release-cadence.md](./release-cadence.md#holding-a-fleet-on-a-version)).

**Limits.** The admin can change the release environment's reviewer rule and
bypass review on `main`, so the pipeline still rests on one account. No build
is claimed reproducible. No third party has tested the app: the scope a tester
would work to is [security-assessment-scope.md](./security-assessment-scope.md).

## Deployment conditions

Conditions a security team commonly sets, and what holds each one.

| Condition | Control | What you do | Limit |
| --- | --- | --- | --- |
| Only the people who need it | None in the app: no account or licence check | Scope the install in your MDM | The app cannot tell one Mac's role from another's |
| Installed only by MDM, from Apple-notarised packages | A signed, notarised pkg with each release from 0.23.0 | Verify the release, then deploy the pkg ([fleet.md](./fleet.md#verify-a-release), [fleet-deployment.md](./fleet-deployment.md#1-install-the-app)) | None known |
| Updates arrive only from IT | A pkg install leaves updates to its installer | Deploy the pkg, and force `DisableUpdateCheck` as well to cover a copy from the DMG and 0.24.0 and earlier | Without that key, a copy a person takes from the DMG updates itself |
| No AI egress unless under a corporate agreement | The first-launch choice, the two Disable keys, `RequireManagedClaude` | Not approved: force `DisableClaude` and `DisableAgentKit`. Approved: force `RequireManagedClaude` and deploy Claude Code's managed settings with your organisation pin | See [AI data flows](#ai-data-flows), Limits |
| No external web content | The app loads no web page | Nothing. On 0.24.0 and earlier, force the two retired keys ([mdm.md](./mdm.md#retired-keys)) | None known |
| Not on Macs that hold keys, wallets or production access | None in the app | Exclude those Macs in your MDM scope | The app runs with the person's rights and has no App Sandbox, so keeping it off those Macs is the control |
| No projects or packs from outside | `AllowedPublisherKeyIds` forced empty; a shared project's code runs only after Allow | Force the key, and treat a shared project like a script from its sender ([fleet.md](./fleet.md#shared-projects-and-packs)) | A person can still press Allow on a project they were sent |
| Work stays where IT expects | `WorkspaceRoot`, `ExportsInProject`, `DisablePackExport` | Force them ([fleet.md](./fleet.md#force-the-keys)) | They bound the app, not Finder |
| Activity is visible | The app log, mirrored for a collector with `AuditLogPath`; a short list of child processes | Collect the log and alert on other children ([fleet.md](./fleet.md#what-to-expect-in-edr)) | The log records the app's actions, not Claude Code's |

The sample profiles and the install script for each posture are in
[fleet-deployment.md](./fleet-deployment.md#2-choose-a-posture).

## What this cannot give you

- **A vendor to contract with.** No company, support agreement, response-time
  promise or insurance ([support-policy.md](./support-policy.md)).
- **A certification.** No SOC 2 or ISO 27001. The OpenSSF answers are
  self-certified ([best-practices.md](./best-practices.md)).
- **An independent test.** None has been done.
- **A second maintainer.** Nobody else can ship a signed release today.
  Installed copies keep working, and the code can be forked
  ([release-cadence.md](./release-cadence.md#if-the-project-stops)).

Where those are requirements, the app does not meet them, and the conditions
above are what reduce the risk that remains.
