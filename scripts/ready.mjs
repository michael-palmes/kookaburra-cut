#!/usr/bin/env node
// PR readiness: the Tier 0 checks and verify legs this diff needs (docs/determinism.md "Gate tiers").
//
//   pnpm ready             # plan, statics, gates
//   pnpm ready --plan      # print the plan only
//   pnpm ready --base <ref> --no-statics --no-gates --force (ignore the result cache) --x2 (a rebase)
//   pnpm gate:merge        # = --legs showcase-tour,ws:launch-2026 (named legs, project[@aspect])
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANCHORS, classify, plan, readBaselines, readStillsBaselines } from "./gate-plan.mjs";
import { renderClosure } from "./render-closure.mjs";
import { check as checkWorkspaceNames } from "./workspace-names.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTORUN = join(homedir(), "Kookaburra Cut", "_autorun");
const CACHE = join(AUTORUN, "gate-cache.json");
const WORKSPACE = process.env.KOOKABURRA_WORKSPACE_ROOT || join(homedir(), "Kookaburra Cut");

const git = (...args) =>
  spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

function changedPaths(base) {
  // -z: NUL-separated and never C-quoted, so paths with spaces or non-ASCII read as written.
  const diff = git("diff", "-z", "--name-status", "--no-renames", base);
  if (diff.status !== 0) throw new Error(`git diff ${base} failed: ${diff.stderr.trim()}`);
  const deleted = new Set();
  const paths = new Set();
  const fields = diff.stdout.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    paths.add(fields[i + 1]);
    if (fields[i] === "D") deleted.add(fields[i + 1]);
  }
  for (const path of git("ls-files", "-z", "-o", "--exclude-standard")
    .stdout.split("\0")
    .filter(Boolean))
    paths.add(path);
  return { paths: [...paths].sort(), deleted };
}

function depsChanged(base) {
  const before = git("show", `${base}:package.json`);
  if (before.status !== 0) return true;
  const pick = (pkg) =>
    JSON.stringify([pkg.dependencies, pkg.devDependencies, pkg.pnpm, pkg.engines]);
  return (
    pick(JSON.parse(before.stdout)) !==
    pick(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")))
  );
}

// ── the result cache ──────────────────────────────────────────────────────────

/** One hash over every repo file that can move pixels, plus the gitignored inputs that can too. */
function repoDigest(closure, opts) {
  const files = git("ls-files", "-z", "-co", "--exclude-standard")
    .stdout.split("\0")
    .filter(Boolean);
  const gated = files.filter(
    (p) => existsSync(join(ROOT, p)) && classify(p, closure, opts).kind !== "none",
  );
  const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
    cwd: ROOT,
    input: gated.join("\n"),
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const h = createHash("sha256").update(gated.join("\n")).update(hashed.stdout);
  for (const dir of ["src/assets/models/licensed", "src-tauri/bin"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      const s = statSync(join(abs, name));
      h.update(`${dir}/${name}:${s.size}:${s.mtimeMs}\n`);
    }
  }
  return h.digest("hex");
}

/** A workspace fixture's sources: project.json and its folders, never its exports. Null when absent. */
export function fixtureDigest(folder) {
  if (!existsSync(join(folder, "project.json"))) return null;
  const h = createHash("sha256");
  const walk = (rel) => {
    for (const entry of readdirSync(join(folder, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || (!rel && ["exports", "node_modules"].includes(entry.name)))
        continue;
      if (entry.isDirectory()) walk(path);
      else if (rel || entry.name === "project.json") {
        const s = statSync(join(folder, path));
        h.update(`${path}:${s.size}:${s.mtimeMs}\n`);
      }
    }
  };
  walk("");
  return h.digest("hex");
}

function legKey(leg, repo) {
  let fixture = "";
  if (leg.project.startsWith("ws:")) {
    fixture = fixtureDigest(join(WORKSPACE, leg.project.slice(3)));
    if (fixture === null) return null;
  }
  return createHash("sha256")
    .update(`${leg.project}|${leg.aspect}|libx264|${repo}|${fixture}`)
    .digest("hex");
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return { entries: {} };
  }
}

// Every worktree shares the file: merge onto what is there now, then rename into place so no reader sees half a write.
function writeCache(cache) {
  const merged = { ...readCache().entries, ...cache.entries };
  const entries = Object.entries(merged)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, 300);
  mkdirSync(AUTORUN, { recursive: true });
  const tmp = `${CACHE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ entries: Object.fromEntries(entries) }, null, 2)}\n`);
  renameSync(tmp, CACHE);
}

// ── running things ────────────────────────────────────────────────────────────

function sh(cmd, args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = "";
    const take = (d) => {
      out += d;
      if (!quiet) {
        for (const line of String(d).split("\n"))
          if (/^kookaburra:run: (waiting|queue|warning)/.test(line)) console.log(`    ${line}`);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) =>
      resolve({ code, out, seconds: Math.round((Date.now() - started) / 1000) }),
    );
  });
}

async function runStatics(s) {
  const steps = [];
  if (s.lint) steps.push(["lint", "pnpm", ["lint"]]);
  if (s.build) steps.push(["build", "pnpm", ["build"]]);
  if (s.vitest === "all") steps.push(["vitest", "pnpm", ["vitest", "run"]]);
  else if (s.vitest) {
    const files = s.vitest.related.filter((p) => existsSync(join(ROOT, p)));
    if (files.length > 0)
      steps.push([
        "vitest related",
        "pnpm",
        ["vitest", "related", "--run", "--passWithNoTests", ...files],
      ]);
    for (const dir of s.vitest.dirs) steps.push([`vitest ${dir}`, "pnpm", ["vitest", "run", dir]]);
  }
  if (s.scripts) {
    const tests = readdirSync(join(ROOT, "scripts"))
      .filter((f) => f.endsWith(".test.mjs"))
      .map((f) => `scripts/${f}`);
    steps.push(["script tests", "node", ["--test", ...tests]]);
  }
  if (s.kit) steps.push(["kb tests", "node", ["scripts/test-kit.mjs"]]);
  if (s.rust) {
    steps.push([
      "cargo clippy",
      "cargo",
      [
        "clippy",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ],
    ]);
    steps.push([
      "cargo test",
      "cargo",
      ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
    ]);
  }
  let ok = true;
  for (const [name, cmd, args] of steps) {
    const r = await sh(cmd, args, { quiet: true });
    console.log(`  ${r.code === 0 ? "ok  " : "FAIL"} ${String(r.seconds).padStart(4)}s ${name}`);
    if (r.code !== 0) {
      ok = false;
      console.log(r.out.split("\n").slice(-40).join("\n"));
    }
  }
  return ok;
}

async function autorun(args) {
  const r = await sh("bash", ["scripts/kookaburra-run.sh", ...args]);
  const dir = r.out.match(/run dir → (.+)/)?.[1]?.trim();
  let result = null;
  try {
    result = JSON.parse(readFileSync(join(dir, "last-run.json"), "utf8"));
  } catch {}
  return { ...r, dir, result };
}

const matches = (hash, baseline) => Boolean(hash && baseline && hash.startsWith(baseline));

/** Exports each leg once (anchors share one boot, in order; every other leg gets its own) and compares. */
async function runLegs(legs, baselines, cache, repo, force, forceTwice) {
  const outcomes = [];
  const all = legs.map((leg) => ({
    ...leg,
    key: legKey(leg, repo),
    baseline: baselines[leg.project]?.[leg.aspect],
  }));
  // A hit counts only while it still matches today's baseline; --force and --x2 always rerun.
  const hitOf = (l) => {
    const hit =
      l.key && !force && !forceTwice ? cache.entries[`${l.project}|${l.aspect}|${l.key}`] : null;
    return hit && (!l.baseline || matches(hit.sha256, l.baseline)) ? hit : null;
  };
  // The anchors' baselines were recorded as a pair in one boot, so they run, or skip, together.
  const anchors = all.filter((l) => ANCHORS.includes(l.project) && l.aspect === "16:9");
  const anchorsCached = anchors.every(hitOf);
  const pending = [];
  for (const leg of all) {
    const hit = anchors.includes(leg) ? anchorsCached && hitOf(leg) : hitOf(leg);
    if (hit)
      outcomes.push({
        ...leg,
        status: "EQUAL",
        detail: `cached (inputs unchanged since ${hit.at})`,
        sha: hit.sha256,
      });
    else pending.push(leg);
  }
  const boots = [];
  const pendingAnchors = pending.filter((l) => anchors.includes(l));
  if (pendingAnchors.length > 0) boots.push(pendingAnchors);
  for (const leg of pending) if (!anchors.includes(leg)) boots.push([leg]);
  for (const boot of boots) {
    // Tier 2+ (a shared seam, or --x2 for a rebase) verifies every leg ×2; otherwise only legs without a baseline.
    // A shared boot never splits: one leg short of a baseline verifies the whole pair, in order.
    const whole = forceTwice || (boot.length > 1 && !boot.every((l) => l.baseline));
    const once = whole ? [] : boot.filter((l) => l.baseline);
    let twice = whole ? [...boot] : boot.filter((l) => !l.baseline);
    if (once.length > 0) {
      const label = once.map((l) => `${l.project}@${l.aspect}`).join(", ");
      console.log(`  export ×1: ${label}`);
      const r = await autorun([
        "--action",
        "export",
        "--project",
        once.map((l) => l.project).join(","),
        "--aspect",
        once[0].aspect,
        "--codec",
        "libx264",
      ]);
      const passed = [];
      const missed = [];
      for (const leg of once) {
        const row = r.result?.results?.find((x) => x.project === leg.project);
        if (matches(row?.sha256, leg.baseline)) {
          passed.push({
            ...leg,
            status: "EQUAL",
            detail: `×1 matches ${leg.baseline}`,
            sha: row.sha256,
            seconds: r.seconds,
          });
        } else {
          console.log(
            `    ${leg.project}: ${row?.sha256?.slice(0, 8) ?? `no hash (exit ${r.code}, ${r.dir ?? "no run dir"})`} vs ${leg.baseline}, verifying ×2`,
          );
          missed.push({ ...leg, exportSha: row?.sha256 });
        }
      }
      // A miss in a shared boot re-verifies the whole boot, so every leg keeps the order it was recorded in.
      if (missed.length > 0 && boot.length > 1)
        twice = boot.map((l) => missed.find((m) => m.project === l.project) ?? l);
      else {
        outcomes.push(...passed);
        twice.push(...missed);
      }
    }
    if (twice.length === 0) continue;
    // One verify per boot group, so the anchors keep gate:merge's order.
    console.log(`  verify ×2: ${twice.map((l) => `${l.project}@${l.aspect}`).join(", ")}`);
    const r = await autorun([
      "--action",
      "verify",
      "--project",
      twice.map((l) => l.project).join(","),
      "--aspect",
      twice[0].aspect,
      "--codec",
      "libx264",
    ]);
    for (const leg of twice) {
      const row = r.result?.results?.find((x) => x.project === leg.project);
      const base = { ...leg, seconds: r.seconds, sha: row?.hashA };
      if (!row)
        outcomes.push({
          ...base,
          status: "ERROR",
          detail: `no result (exit ${r.code}, ${r.dir ?? "no run dir"})`,
        });
      else if (!row.identical)
        outcomes.push({
          ...base,
          status: "NONDETERMINISTIC",
          detail: `${row.hashA?.slice(0, 8)} ≠ ${row.hashB?.slice(0, 8)} (${r.dir})`,
        });
      else if (!leg.baseline)
        outcomes.push({
          ...base,
          status: "EQUAL",
          detail: `no baseline: ×2 identical at ${row.hashA.slice(0, 8)}, record it`,
        });
      else if (!matches(row.hashA, leg.baseline))
        outcomes.push({
          ...base,
          status: "MOVED",
          detail: `×2 identical at ${row.hashA.slice(0, 8)}, baseline ${leg.baseline}: attribute or rebase`,
        });
      else if (leg.exportSha)
        outcomes.push({
          ...base,
          status: "NONDETERMINISTIC",
          detail: `×1 gave ${leg.exportSha.slice(0, 8)}, ×2 matched ${leg.baseline}`,
        });
      else
        outcomes.push({
          ...base,
          status: "EQUAL",
          detail: `×2 identical, matches ${leg.baseline}`,
        });
    }
  }
  // Local "YYYY-MM-DD HH:MM" (the sv-SE format), so the cached-since label reads as wall time.
  const now = new Date().toLocaleString("sv-SE").slice(0, 16);
  for (const o of outcomes) {
    if (o.status === "EQUAL" && o.key && o.sha && !o.detail.startsWith("cached"))
      cache.entries[`${o.project}|${o.aspect}|${o.key}`] = { sha256: o.sha, at: now };
  }
  return outcomes;
}

async function runActions(actions, stills, baselines) {
  const outcomes = [];
  for (const a of actions) {
    const formats = a.action === "stillsverify" ? ["pdf", "png"] : [null];
    for (const format of formats) {
      const args = [
        "--action",
        a.action,
        "--project",
        a.project,
        "--aspect",
        "16:9",
        ...(format ? ["--stills", format] : []),
      ];
      console.log(`  ${a.action}: ${a.project}${format ? ` (${format})` : ""}`);
      const r = await autorun(args);
      const row = r.result?.results?.[0];
      let status = r.code === 0 && r.result?.ok ? "EQUAL" : "FAIL";
      let detail = r.dir ?? `exit ${r.code}`;
      const want = format ? stills[a.project]?.[format] : null;
      if (status === "EQUAL" && want && row?.pagesHash !== want) {
        status = "MOVED";
        detail = `pagesHash ${row?.pagesHash?.slice(0, 8)} vs baseline ${want.slice(0, 8)}`;
      }
      // The round trip must reproduce the recorded baseline, not just agree with itself.
      const source = r.result?.roundTrip?.sourceHash;
      const recorded = a.action === "packroundtrip" ? baselines[a.project]?.["16:9"] : null;
      if (status === "EQUAL" && recorded && !matches(source, recorded)) {
        status = "MOVED";
        detail = `round trip at ${source?.slice(0, 8) ?? "?"} vs baseline ${recorded}`;
      }
      outcomes.push({
        project: a.project,
        aspect: format ?? "16:9",
        action: a.action,
        status,
        detail,
        seconds: r.seconds,
      });
    }
  }
  return outcomes;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const baseRef = value("--base") ?? "origin/main";
  const base = git("merge-base", "HEAD", baseRef).stdout.trim() || baseRef;
  const closure = await renderClosure();
  const opts = { depsChanged: depsChanged(base) };
  let p;
  if (value("--legs")) {
    // Named legs only (pnpm gate, pnpm gate:merge): no diff, no statics.
    const legs = value("--legs")
      .split(",")
      .map((s) => {
        const [project, aspect = "16:9"] = s.split("@");
        return { project, aspect, why: ["named"] };
      });
    p = { files: [], legs, actions: [], notes: [], statics: {} };
    args.push("--no-statics");
  } else {
    const { paths, deleted } = changedPaths(base);
    // A deleted export-path file left the closure, so count it as render outright.
    for (const d of deleted) if (d.startsWith("src/")) closure.add(d);
    p = plan(paths, closure, opts);
    // A bundled fixture the branch deleted has nothing left to gate.
    const exists = (id) =>
      id.startsWith("ws:") ||
      ["projects", "fixtures"].some((d) => existsSync(join(ROOT, d, id, "project.json")));
    for (const l of p.legs.filter((l) => !exists(l.project)))
      p.notes.push(`${l.project} no longer exists: skipped`);
    p.legs = p.legs.filter((l) => exists(l.project));
    console.log(`ready: ${paths.length} changed paths since ${base.slice(0, 8)} (${baseRef})`);
  }

  for (const f of p.files) console.log(`  ${f.kind.padEnd(7)} ${f.path}  (${f.why})`);
  console.log(
    p.legs.length + p.actions.length > 0
      ? "gates:"
      : "gates: none (nothing on the export path changed)",
  );
  for (const l of p.legs)
    console.log(
      `  ${l.project}@${l.aspect}  ← ${l.why.slice(0, 3).join(", ")}${l.why.length > 3 ? ", …" : ""}`,
    );
  for (const a of p.actions)
    console.log(`  ${a.action} ${a.project}  ← ${a.why.slice(0, 3).join(", ")}`);
  for (const n of p.notes) console.log(`note: ${n}`);
  if (flag("--plan")) return;

  let ok = true;
  // Every branch, whatever it touches: nothing from the user's own workspace may land in the repo.
  if (!value("--legs")) {
    console.log("workspace names:");
    const clean = checkWorkspaceNames({ base });
    console.log(
      `  ${clean ? "ok  " : "FAIL"} workspace names${clean ? "" : " (swap in a neutral placeholder)"}`,
    );
    ok = clean && ok;
  }
  if (!flag("--no-statics")) {
    console.log("statics:");
    ok = (await runStatics(p.statics)) && ok;
  }
  const outcomes = [];
  if (!flag("--no-gates") && p.legs.length + p.actions.length > 0) {
    console.log("gates:");
    const cache = readCache();
    const baselines = readBaselines();
    outcomes.push(
      ...(await runLegs(
        p.legs,
        baselines,
        cache,
        repoDigest(closure, opts),
        flag("--force"),
        p.twice || flag("--x2"),
      )),
    );
    outcomes.push(...(await runActions(p.actions, readStillsBaselines(), baselines)));
    writeCache(cache);
  }
  if (outcomes.length > 0) {
    console.log("\nresults:");
    for (const o of outcomes) {
      console.log(
        `  ${o.status.padEnd(16)} ${(o.action ? `${o.action} ` : "") + o.project}@${o.aspect}  ${o.detail}${o.seconds ? ` (${o.seconds}s)` : ""}`,
      );
    }
  }
  const failed = outcomes.filter((o) => o.status !== "EQUAL");
  ok = ok && failed.length === 0;
  console.log(`\nready: ${ok ? "READY" : "NOT READY"}`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
