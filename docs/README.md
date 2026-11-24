# Kookaburra Cut docs

The documentation set for humans and coding agents. Suggested reading order:
architecture → determinism → decisions.

## Architecture & engineering

| Doc | What's in it |
| --- | --- |
| [architecture.md](./architecture.md) | The rendering & export architecture, the canonical stack, and the rationale behind it |
| [determinism.md](./determinism.md) | The byte-identical-export contract: what breaks it, how to verify, gate tiers, current baselines |
| [decisions.md](./decisions.md) | The locked-decisions log: every durable choice, with its why |

## Product surface

| Doc | What's in it |
| --- | --- |
| [design.md](./design.md) | Design language for the macOS application chrome (the editor UI) |
| [voice.md](./voice.md) | Voice, tone, lexicon and the locked copy lines |
| [accessibility.md](./accessibility.md) | Accessibility statement, keyboard map, how to report a problem, and the WCAG 2.2 AA conformance report (VPAT) |

## Security and privacy

| Doc | For | What's in it |
| --- | --- | --- |
| [privacy.md](./privacy.md) | The person using the app | What leaves the Mac, what the app keeps, how to clear it and how to uninstall, in plain words |
| [security-overview.md](./security-overview.md) | The security lead, CTO or engineering manager | What leaves the Mac, subprocessors, where data rests, how releases are built, questionnaire answers and what is not done yet, every line linked to its proof |
| [SECURITY.md](../SECURITY.md) | The security engineer, auditor and contributor | The engineering record: the threat model, every control with the file or command behind it, release integrity, and how to report a vulnerability |
| [fleet.md](./fleet.md) | The IT team deploying it | Verifying a release, the keys to force, Claude Code's own managed settings, shared folders, what to expect in EDR, retention, in-app or MDM updates |
| [fleet-deployment.md](./fleet-deployment.md) | The IT team deploying it | Recipes for Jamf Pro, Kandji (Iru), Mosyle and Intune: the install script, three ready profiles, checks on a Mac, an update mirror and removal |
| [mdm.md](./mdm.md) | The administrator writing the profile | Managed preferences: the keys a configuration profile can force, a sample profile, and how to verify |
| [security-assessment-scope.md](./security-assessment-scope.md) | A third-party security assessor | The threat model, trust boundaries and their entry files, existing tests and fuzzing, rules of engagement, deliverables and a vendor shortlist |
| [third-party-assessment.md](./third-party-assessment.md) | The security team assessing the app before allowing it | The AI data flows, source code integrity, common deployment conditions mapped to the control behind each, and what no control here can give |
| [vendor-questionnaire.md](./vendor-questionnaire.md) | The procurement or security team filling in a questionnaire | SIG Lite and CAIQ v4 answers by domain: Yes, No, Partial or Not applicable, each with the file, workflow or command that proves it |
| [subprocessors.md](./subprocessors.md) | The privacy or procurement reviewer | Every third party a Mac running the app can reach: when, what is sent, identifiers, the off switch and the file behind it |

## Features

| Doc | What's in it |
| --- | --- |
| [agent-kit.md](./agent-kit.md) | How Claude Code edits a project: the kit stamped into the folder, `kb`, hooks, the bridge, load safety and the headless edit CLI |
| [packs.md](./packs.md) | `.kbpack`, the one signed file that carries projects, templates, presets, brands, themes, fonts, objects and more between Macs |
| [content-library.md](./content-library.md) | Templates, scene presets and themes as reusable documents, opened, edited and saved from the app |
| [brands.md](./brands.md) | Workspace brands: safe defaults and guidance for a project (a theme, fonts, colours, imagery and a voice), never hard rules |
| [backgrounds.md](./backgrounds.md) | The colour rules for every animated background, gradient preset and theme: the text or device is the star |
| [camera.md](./camera.md) | How a scene's camera is authored and what it guarantees: orbits, free-flight poses, depth bands |
| [charts.md](./charts.md) | One data visual per scene: eight chart types driven from the sidecar's `chart` block and edited in the app |
| [comparisons.md](./comparisons.md) | One scene rendered twice and composited under an animatable mask: before and after, side by side |
| [overlays.md](./overlays.md) | Full-frame panels locked to the camera with a shaped cutout, which turn a project into a slide deck |
| [foldables.md](./foldables.md) | Folding devices: two displays, a hinge you can pose and keyframe, and the auto screen power that follows it |
| [gizmos.md](./gizmos.md) | Direct manipulation over the preview: drag an item on the stage instead of typing numbers into the inspector |
| [scene-terminal.md](./scene-terminal.md) | A terminal as scene content: a picture of a terminal baked from a written transcript, never a process |
| [stills.md](./stills.md) | Turning a project into stills: a PDF handout or a zip of PNGs, one page per still, through the export path |

Scene-authoring rules and the toolkit reference live in the
`kookaburra-scene-authoring` skill (`.agents/skills/`); `/new-scene` scaffolds a
scene, and the `kookaburra-export-presets` skill covers export preset flows.

## Support and releases

| Doc | For | What's in it |
| --- | --- | --- |
| [support-policy.md](./support-policy.md) | Anyone who needs help | Community support through GitHub issues, what is supported, what to send and how to report a security problem |
| [release-cadence.md](./release-cadence.md) | The IT team | How versions are numbered, which release gets security fixes, how a fleet holds a version and how to check a release |
| [incident-response.md](./incident-response.md) | Anyone running the app, and the maintainer | What happens if a release or a signing key is compromised, and how to check what you have |

## Legal

The maintainer's own notice, not legal advice. The terms for the app and its
code are the licence files, [LICENSE-MIT](../LICENSE-MIT) or
[LICENSE-APACHE](../LICENSE-APACHE).

| Doc | What's in it |
| --- | --- |
| [legal/privacy-notice.md](./legal/privacy-notice.md) | The legal form of [privacy.md](./privacy.md) for the app and `kookaburracut.com`, against the Australian Privacy Principles and the GDPR |
