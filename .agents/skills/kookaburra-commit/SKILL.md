---
name: kookaburra-commit
description: Plans and creates git commits for the Kookaburra Cut repo. Reviews uncommitted changes for red flags, groups them into logical conventional commits and executes them. Use for every commit in this repo, whenever asked to "commit", "commit my changes", "plan commits", "review and commit", or before opening a PR. Project-scoped distillation of ps-commit.
---

# kookaburra-commit

Reviews all uncommitted changes, groups them into logical conventional commits and executes them. Every commit in this repo goes through this flow; never hand-roll `git commit` for substantive changes. Do not push unless asked.

## When to use

- Any time work in this repo needs committing, including before opening a PR
- The user says "commit", "plan commits" or "review and commit"

## Instructions

1. **Gather.** `git status`, `git diff HEAD --stat`, `git ls-files --others --exclude-standard`, then read the full `git diff HEAD` and any untracked files. Nothing to commit: say so and stop. Merge conflicts: ask the user to resolve first and stop.
2. **Validate.** `pnpm lint` always; `pnpm build` when TypeScript changed; `pnpm test` when `src/engine/` or `src/toolkit/` changed. Fix and rerun until clean. Never run verifies here: they gate render and export changes via `docs/determinism.md`, not commits.
3. **Light review.** Scan the diff for red flags before planning:
   - Determinism: wall-clock APIs (`Date.now`, `performance.now`, `new Date`, `requestAnimationFrame`, `setTimeout`) in scenes, engine or toolkit; drive motion from `useTimeline()` instead
   - Hard-coded colours, type or motion in scenes; use `useTheme()` tokens instead
   - Licensed assets staged: nothing under `src/assets/models/licensed/` is ever committed
   - Absolute paths or remote URLs in scene files; use the project `assets/` folder
   - Leftover debug output (`console.log`, `debugger`), secrets, dead code, TODO without an owner
   - Accidental files: `.DS_Store`, `dist/`, `node_modules/`, export output
   - House writing rules broken: em dashes, multi-line comments, comments that restate the code
   - Private workspace names (this leaked once and forced a history rewrite of a pushed PR): nothing from the user's own `~/Kookaburra Cut` projects may land in code, tests, fixtures, docs, skills or messages, so no project, folder or scene names, slugs, on-screen copy, product, client or people's names, or local paths. Run both checks below; every hit except the documented gate fixtures (`launch-2026`, the `*-spike` projects) is a finding, fixed by swapping in a neutral placeholder (`product-tour`, "Highlights", `/Users/x`). The folder grep can't see scene copy or product names, so also grep for the names of any workspace project opened this session.
     ```bash
     git diff HEAD | grep '^+' | grep -iwFf <(ls ~/Kookaburra\ Cut | grep -v '^_' | grep -E '[0-9-]')
     git ls-files --others --exclude-standard -z | xargs -0 grep -niwFf <(ls ~/Kookaburra\ Cut | grep -v '^_' | grep -E '[0-9-]')
     ```
4. **Group into commits.** One logical change per commit; split unrelated work, never split one cohesive change. Tests stage with the source they cover. Messages: `type: subject`, lowercase imperative, under 72 characters, no scope, no body. Types: feat, fix, docs, refactor, perf, test, chore, ci, build, revert.
5. **Approve or auto-commit.** A single commit with no review findings commits straight away; report what was committed. Multiple commits or any finding: present the findings and the plan (message plus files per commit) and wait for approval.
6. **Execute.** `git reset HEAD` first, then per commit: `git add -- <files>` (hunk-split with `git add -p` when one file spans commits), verify with `git diff --cached --stat`, then `git commit -m "..."`. If a hook rejects the commit, stop and show its output; never retry with `--no-verify`.
7. **Verify.** `git log --oneline -n <count>` and `git status`; report anything left uncommitted and why.

## Edge cases

- Ambiguous hunk ownership: ask, do not guess
- Aborted mid-plan: stop; `git reset --soft HEAD~N` undoes the last N commits
- Binary assets: stage by name, never diff, and check they are meant to be committed (see the licensed-assets rule above)
