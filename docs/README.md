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

Scene-authoring rules and the toolkit reference live in the
`kookaburra-scene-authoring` skill (`.claude/skills/`); `/new-scene` scaffolds a
scene, and the `kookaburra-export-presets` skill covers export preset flows.
