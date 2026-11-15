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

## Security and privacy

| Doc | For | What's in it |
| --- | --- | --- |
| [privacy.md](./privacy.md) | The person using the app | What leaves the Mac, what the app keeps, how to clear it and how to uninstall, in plain words |
| [security-overview.md](./security-overview.md) | The security lead, CTO or engineering manager | What leaves the Mac, subprocessors, where data rests, how releases are built, questionnaire answers and what is not done yet, every line linked to its proof |
| [SECURITY.md](../SECURITY.md) | The security engineer, auditor and contributor | The engineering record: the threat model, every control with the file or command behind it, release integrity, and how to report a vulnerability |
| [fleet.md](./fleet.md) | The IT team deploying it | Verifying a release, the keys to force, Claude Code's own managed settings, shared folders, what to expect in EDR, retention, in-app or MDM updates |
| [mdm.md](./mdm.md) | The administrator writing the profile | Managed preferences: the keys a configuration profile can force, a sample profile, and how to verify |

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
| [scene-website.md](./scene-website.md) | A website as scene content: a browser panel that is live only when the person activates it in the editor or a Present hold |
| [stills.md](./stills.md) | Turning a project into stills: a PDF handout or a zip of PNGs, one page per still, through the export path |

Scene-authoring rules and the toolkit reference live in the
`kookaburra-scene-authoring` skill (`.agents/skills/`); `/new-scene` scaffolds a
scene, and the `kookaburra-export-presets` skill covers export preset flows.
