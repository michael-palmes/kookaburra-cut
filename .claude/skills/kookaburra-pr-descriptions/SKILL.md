---
name: kookaburra-pr-descriptions
description: Writes pull request titles and descriptions for the Kookaburra Cut repo to one fixed, minimal standard. Use whenever opening a PR (gh pr create), writing or rewriting a PR description or PR body, or updating an existing PR's text. Triggers on "open a PR", "create a pull request", "PR description", "PR body", "update the PR".
---

# kookaburra-pr-descriptions

One fixed shape for every PR description: a summary, a short What changed list, and a Verification line when the change gated. Bare essentials only; the code, docs and commit list carry the detail.

## When to use

- Opening any PR in this repo (`gh pr create`)
- Writing, rewriting or updating a PR description

## The standard

**Title**: conventional-commit form, `type: lowercase imperative subject`, under 72 characters (`feat:`, `fix:`, `docs:`, `chore:`, ...). It becomes the squash-merge commit, so write it as one.

**Body**: under ~120 words, Australian English, no em dashes (commas, colons, parentheses or full stops instead).

```markdown
<One or two sentences: what this PR does and why it matters to a user of the repo.>

## What changed
- <4 to 6 bullets, each one shipped change>
- <deliberate behaviour changes and known limitations are bullets here too, e.g. "Transitions adjacent to a comparison blend the before side only">

## Verification
<ONE line, no hashes: e.g. "New gate fixture Verify x2 identical in all four aspects; gate:merge EQUAL on both anchors; 1128 tests green.">
```

Omit `## Verification` entirely when the PR is trivial chrome or docs (nothing gated beyond build, lint and tests). Never add other sections.

## Hard exclusions

Each of these has leaked into a real PR description before; the alternative is always available:

1. **No local paths, planning folders, worktrees or memory notes.** PR #105 referenced a private planning folder that reviewers cannot see. Point to repo docs instead (`docs/comparisons.md`, `docs/determinism.md`).
2. **No internal work-package narrative.** No "PR 3 of the ladder", batch numbers, or session history ("found along the way", "after the in-hand pass"). State what the PR does now, in the present tense.
3. **No commit-by-commit recounts.** The PR's commit list already shows them.
4. **No baseline hashes.** They live in `docs/determinism.md`; the Verification line says the outcome ("Verify x2 identical", "gate EQUAL"), not the bytes.
5. **No screenshots or media attachments.** A visual change gets a What-changed bullet describing it; reviewers see the pixels in the app and the gate fixtures.
6. **Never name the developer.** No "Michael", no "the author". The PR describes the change, not the people.

## Instructions

1. **Draft the body to the template above**, writing it to a temp file (the scratchpad, never the repo).
2. **Pre-flight the draft** and fix until clean:
   ```bash
   wc -w <body-file>                                   # aim under ~120
   grep -nE "—|/Users/|worktree|batch [0-9]|PR [0-9] of|Michael" <body-file>   # must return nothing
   ```
3. **Open the PR**: `gh pr create --title "type: subject" --body-file <body-file>`.
4. **Read the rendered PR back** (`gh pr view`) and confirm every reference resolves inside the repo.

## Example

Title: `feat: before/after comparison scenes`

```markdown
Adds before/after comparison scenes: one scene rendered as two sides under an animatable mask, with a scene kind, inspector drill and a divider timeline lane. Design record: docs/comparisons.md.

## What changed
- Compare engine: sidecar `compare` block, a second side host, masked composite on the transition target pools
- Mask family (linear, circle, radial, blend) with divider line, grip, label chips and tints
- Comparison scene kind, wizard flow and inspector drill with a Before/After pill
- Transitions adjacent to a comparison blend the before side only (said in the picker)

## Verification
New gate fixture Verify x2 identical in all four aspects; gate:merge EQUAL on both anchors; 1128 tests green.
```
