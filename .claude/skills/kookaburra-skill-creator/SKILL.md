---
name: kookaburra-skill-creator
description: Creates or updates project skills, slash commands, and toolkit primitives for the Kookaburra Cut repo. Use when asked to "add a Kookaburra Cut skill", "create a project skill", "add a slash command", "add a toolkit primitive", "document an authoring workflow", or extend Kookaburra Cut's .claude/ infrastructure. Project-scoped distillation of ps-agent-skill-creator.
---

# kookaburra-skill-creator

Builds new in-repo skills/commands/primitives for Kookaburra Cut that actually work — not ones that merely look complete. Project-scoped; lives in and commits with this repo. For personal, cross-project skills use the global `ps-agent-skill-creator` instead.

## When to use

- Adding a new project skill under `.claude/skills/<name>/`
- Adding a slash command under `.claude/commands/<name>.md`
- Adding a toolkit primitive under `src/toolkit/` (and documenting it)
- Improving an existing Kookaburra Cut skill/command

## Instructions

1. **Interview first — ask before writing.** Ask focused multiple-choice questions covering: purpose, trigger phrases, the exact workflow, edge cases, failures already seen, and validation steps. Do not write skill content from assumptions. Skipping this produces generic, low-value skills — every time.
2. **Name it for the repo.** Project skills/commands use a descriptive `kookaburra-`-or-domain name in kebab-case (e.g. `kookaburra-scene-authoring`, `new-scene`). No `ps-` prefix — that prefix is reserved for global personal skills.
3. **Place it correctly.**
   - Skill → `.claude/skills/<name>/SKILL.md` (+ `REFERENCE.md` if it would exceed ~250 lines).
   - Command → `.claude/commands/<name>.md`.
   - Primitive → `src/toolkit/<area>/<Name>.tsx`, exported from `src/toolkit/index.ts`, documented in `kookaburra-scene-authoring/REFERENCE.md`.
4. **Write to the quality bar** (below). No vague rules.
5. **Verify IMMEDIATELY.** Run the checklist and fix until clean before responding. Do not defer.

## Quality bar

- **Description is king.** The YAML `description` is the only thing seen before loading. Pack it with concrete trigger keywords/phrases, in third person. Vague descriptions never get loaded.
- **Only add what the agent doesn't know.** Cut general knowledge; the context window is shared.
- **One skill = one capability.** Never merge unrelated workflows — it breaks trigger matching.
- **Every rule traces to a real failure.** "Use `useTimeline()` not `Date.now()` — `Date.now()` makes frame N non-reproducible and breaks byte-identical export" beats "use time correctly".
- **Every prohibition includes an alternative.** "Never animate the DOM. Instead, render via a troika toolkit primitive." A bare "don't" is a dead end.
- **One concrete example beats paragraphs.** Show a snippet.
- **Validation loop.** Give exact commands and say to fix-and-rerun until passing.
- **Skip what linters enforce.** Reference `biome.json` / `tsconfig.json` instead of restating style.

## Pre-finalization checklist

- [ ] Description has concrete triggers, third person
- [ ] Instructions are numbered, actionable steps
- [ ] Every prohibition has an alternative
- [ ] No vague rules ("write clean code")
- [ ] Validation loop included (`pnpm build` / `pnpm test` / `pnpm lint` as relevant)
- [ ] SKILL.md under ~250 lines (split to REFERENCE.md if not)
- [ ] One capability only
- [ ] New primitive exported from `src/toolkit/index.ts` and added to REFERENCE.md

## Example: SKILL.md skeleton

```markdown
---
name: <name>
description: <what + when, third person, with trigger keywords>
---

# <name>

<one-sentence purpose>

## When to use
- <trigger>

## Instructions
1. **Step** — actionable, with exact command
2. **Verify** — run `pnpm build && pnpm test`; fix and rerun until clean
```
