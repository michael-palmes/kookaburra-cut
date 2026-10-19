#!/usr/bin/env node
// Runs the kb suite one python process per module, several at once (it mostly waits, so they overlap).
//
//   node scripts/test-kit.mjs [test_module ...] [--jobs N]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const KIT_SCRIPTS = join(ROOT, ".agents", "skills", "kookaburra-scene-authoring", "scripts");
const TIMINGS = join(ROOT, "node_modules", ".cache", "kookaburra", "test-kit.json");

export function discoverModules(scripts = KIT_SCRIPTS) {
  return readdirSync(join(scripts, "tests"))
    .filter((f) => /^test_\w+\.py$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
}

// Longest first so the slowest module never starts last; unknown modules rank by file size.
export function orderModules(modules, timings, sizeOf) {
  const weight = (m) => timings[m] ?? sizeOf(m) / 1000;
  return [...modules].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
}

export function parseSummary(output) {
  const ran = Number(output.match(/^Ran (\d+) tests?/m)?.[1] ?? 0);
  const skipped = Number(output.match(/skipped=(\d+)/)?.[1] ?? 0);
  return { ran, skipped, ok: /^OK\b/m.test(output) };
}

function readTimings() {
  try {
    return JSON.parse(readFileSync(TIMINGS, "utf8"));
  } catch {
    return {};
  }
}

function runModule(mod) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Discover from the repo root, as before: run from the kit folder, its inspect.py shadows the stdlib's.
    const argv = [
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      join(KIT_SCRIPTS, "tests"),
      "-t",
      KIT_SCRIPTS,
      "-p",
      `${mod}.py`,
    ];
    const child = spawn("python3", argv, { cwd: ROOT, env: process.env });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.on("close", (code) => {
      const summary = parseSummary(output);
      resolve({
        mod,
        code,
        output,
        seconds: (Date.now() - started) / 1000,
        ...summary,
        ok: code === 0 && summary.ok,
      });
    });
  });
}

async function runAll(modules, jobs) {
  const queue = [...modules];
  const results = [];
  const worker = async () => {
    while (queue.length > 0) {
      const r = await runModule(queue.shift());
      results.push(r);
      const tag = r.ok ? "ok  " : "FAIL";
      const skip = r.skipped ? `, ${r.skipped} skipped` : "";
      console.log(`${tag} ${r.seconds.toFixed(1).padStart(5)}s ${r.mod} (${r.ran} tests${skip})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, modules.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let jobs = availableParallelism();
  const picked = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--jobs") jobs = Number(args[++i]);
    else picked.push(args[i].replace(/^tests\./, "").replace(/\.py$/, ""));
  }
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error("test-kit: --jobs needs a positive integer");
    process.exit(2);
  }
  const all = discoverModules();
  const unknown = picked.filter((m) => !all.includes(m));
  if (unknown.length > 0) {
    console.error(`test-kit: no such module: ${unknown.join(", ")}`);
    process.exit(2);
  }
  const timings = readTimings();
  const sizeOf = (m) => statSync(join(KIT_SCRIPTS, "tests", `${m}.py`)).size;
  const modules = orderModules(picked.length > 0 ? picked : all, timings, sizeOf);
  const started = Date.now();
  const results = await runAll(modules, jobs);
  for (const r of results) timings[r.mod] = Math.round(r.seconds * 10) / 10;
  if (!existsSync(dirname(TIMINGS))) mkdirSync(dirname(TIMINGS), { recursive: true });
  writeFileSync(TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`\n==== ${r.mod} (exit ${r.code})\n${r.output}`);
  const ran = results.reduce((n, r) => n + r.ran, 0);
  const skipped = results.reduce((n, r) => n + r.skipped, 0);
  const wall = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nkit: ${ran} tests in ${modules.length} modules, ${skipped} skipped, ${failed.length} failed modules, ${wall}s on ${jobs} jobs`,
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
