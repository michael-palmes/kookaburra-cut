#!/usr/bin/env node
// Workspace-name check: nothing from the user's own ~/Kookaburra Cut may land in the repo.
// Every line a branch adds (plus untracked files) is matched against the project folder
// names on this Mac and against scripts/workspace-denylist.txt, the shapes of past leaks.
//
//   node scripts/workspace-names.mjs                 # added lines since HEAD (the commit skill)
//   node scripts/workspace-names.mjs --base <ref>    # since a merge base (pnpm ready)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DENYLIST = "scripts/workspace-denylist.txt";
/** Files whose job is to hold the shapes being hunted. */
const SELF = new Set([DENYLIST, "scripts/workspace-names.mjs", "scripts/workspace-names.test.mjs"]);
/** The workspace's own folders (docs/agent-kit.md, docs/brands.md); never a project. */
const WORKSPACE_FOLDERS = new Set([
  "brands",
  "themes",
  "fonts",
  "gradients",
  "export-presets",
  "presets",
  "screenshots",
  "objects",
  "templates",
]);
/** Where the repo already names its gate fixtures; a folder named there is test infrastructure. */
const FIXTURE_DOCS = ["CLAUDE.md", "docs/determinism.md"];

const git = (args, input) =>
  spawnSync("git", args, { cwd: ROOT, encoding: "utf8", input, maxBuffer: 64 << 20 });

export function readDenylist(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

/** Workspace folders with a digit or hyphen (plain words say nothing), minus bundled content, the workspace's own folders, the spikes and what the fixture docs already name. */
export function workspaceNames(workspace, { bundled = new Set(), fixtureText = "" } = {}) {
  if (!existsSync(workspace)) return null;
  return readdirSync(workspace, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(
      (n) =>
        !n.startsWith("_") &&
        !n.startsWith(".") &&
        /[0-9-]/.test(n) &&
        !n.endsWith("-spike") &&
        !WORKSPACE_FOLDERS.has(n) &&
        !bundled.has(n) &&
        !wordRe(n).test(fixtureText),
    )
    .sort();
}

const quoteRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The name as a whole word, case-insensitive: `ws:acme-launch-3` hits, `acme-launch-30` does not. */
const wordRe = (name) => new RegExp(`(^|[^A-Za-z0-9_])${quoteRe(name)}($|[^A-Za-z0-9_])`, "i");

/** Project, fixture, preset and template ids the repo ships; their workspace copies carry the same names. */
export function bundledIds() {
  const ids = new Set();
  for (const dir of ["projects", "fixtures", "presets"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory()) ids.add(e.name);
  }
  return ids;
}

/** `{ path, line, text }` for every line the diff adds, plus every line of every untracked file. */
export function addedLines(base) {
  const out = [];
  const diff = git([
    "-c",
    "core.quotepath=false",
    "diff",
    "-U0",
    "--no-color",
    "--no-renames",
    base,
    "--",
    ".",
  ]);
  if (diff.status !== 0) throw new Error(`git diff ${base} failed: ${diff.stderr.trim()}`);
  let path = null;
  let line = 0;
  for (const raw of diff.stdout.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = raw.startsWith("+++ b/") ? raw.slice(6) : null;
    } else if (raw.startsWith("@@ ")) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (raw.startsWith("+") && path) {
      out.push({ path, line, text: raw.slice(1) });
      line += 1;
    }
  }
  const untracked = git(["ls-files", "-z", "-o", "--exclude-standard"])
    .stdout.split("\0")
    .filter(Boolean);
  for (const p of untracked) {
    let text;
    try {
      text = readFileSync(join(ROOT, p), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((t, i) => {
      out.push({ path: p, line: i + 1, text: t });
    });
  }
  return out.filter((l) => !SELF.has(l.path));
}

/** Every added line that names a workspace project or matches a denylist shape. */
export function findHits(lines, names, patterns) {
  const nameRes = names.map((n) => [n, wordRe(n)]);
  const hits = [];
  for (const l of lines) {
    for (const [name, re] of nameRes) if (re.test(l.text)) hits.push({ ...l, why: name });
    for (const re of patterns) {
      const m = re.exec(l.text);
      if (m) hits.push({ ...l, why: `denylist: ${m[0]}` });
    }
  }
  return hits;
}

export function check({ base = "HEAD", workspace, log = console.log } = {}) {
  const ws =
    workspace ?? process.env.KOOKABURRA_WORKSPACE_ROOT ?? join(homedir(), "Kookaburra Cut");
  const fixtureText = FIXTURE_DOCS.map((f) => git(["show", `${base}:${f}`]).stdout ?? "").join(
    "\n",
  );
  const names = workspaceNames(ws, { bundled: bundledIds(), fixtureText });
  const patterns = readDenylist(readFileSync(join(ROOT, DENYLIST), "utf8"));
  const hits = findHits(addedLines(base), names ?? [], patterns);
  if (names === null) log("  workspace names: no workspace on this machine, denylist only");
  for (const h of hits) log(`  ${h.path}:${h.line}  ${h.why}`);
  return hits.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";
  const ok = check({ base });
  console.log(
    ok ? "workspace names: clean" : "workspace names: hits above; swap in a neutral placeholder",
  );
  process.exitCode = ok ? 0 : 1;
}
