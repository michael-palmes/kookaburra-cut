#!/usr/bin/env node
// Look lab contact sheets: renders real scene3d looks in headless Chrome, no app boot, no autorun queue.
// Usage: node tools/look-lab/sheet.mjs --look <id> [--presets p1,p6] [--t 8 | --compare 4,8]
//   [--cams front,lab,wide,behind,far] [--tall lab|none] [--grid] [--width 480] [--ss 2]
//   [--params k=v,...] [--headline "..."] [--content | --no-content] [--theme <id>] [--raw] [--out file.png]
//   [--gpu] [--timeout 180] [--retries 1] [--verbose] [--serve]
// Exit: 0 clean, 1 rendered with console or shader errors, 2 setup failure or timeout.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CONFIG = join(HERE, "vite.config.ts");
const PAGE = "/tools/look-lab/index.html";
const LOCK = join(REPO, "node_modules/.vite-look-lab/.startup-lock");
const CHROME =
  process.env.LOOK_LAB_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const FLAGS = new Set(["grid", "content", "no-content", "raw", "gpu", "verbose", "serve"]);
const VALUES = new Set(
  "look presets t compare cams tall width ss params headline theme out timeout retries".split(" "),
);
const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
  const key = a.slice(2);
  if (FLAGS.has(key)) opts[key] = true;
  else if (!VALUES.has(key)) fail(`unknown flag --${key} (see tools/look-lab/README.md)`);
  else if (i + 1 < argv.length) opts[key] = argv[++i];
  else fail(`--${key} needs a value`);
}
if (!opts.look) fail("--look <id> is required (a scene3d look id, e.g. wash-dome)");

const times = opts.compare ?? opts.t ?? "8";
const query = new URLSearchParams({ look: opts.look, t: times });
if (opts.grid) query.set("mode", "grid");
for (const k of ["presets", "cams", "tall", "width", "ss", "params", "headline", "theme"]) {
  if (opts[k] !== undefined) query.set(k, opts[k]);
}
if (opts.content) query.set("content", "1");
if (opts["no-content"]) query.set("content", "0");
if (opts.raw) query.set("raw", "1");

const started = Date.now();
const log = (msg) => {
  if (opts.verbose) console.log(`look-lab +${((Date.now() - started) / 1000).toFixed(1)}s ${msg}`);
};

function fail(msg) {
  console.error(`look-lab: ${msg}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Serialises Vite start-up and first page load across parallel runs (the shared dep cache is rewritten on a cold start). */
async function acquireLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  const deadline = Date.now() + 10 * 60_000;
  let waited = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      if (waited) log("start-up lock acquired");
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(join(LOCK, "owner"), "utf8"));
    } catch {}
    const stale = owner ? !alive(owner.pid) || Date.now() - owner.at > 120_000 : false;
    if (stale) {
      rmSync(LOCK, { recursive: true, force: true });
      continue;
    }
    if (!waited) log(`waiting for another run's start-up (pid ${owner?.pid ?? "?"})`);
    waited = true;
    if (Date.now() > deadline) fail("timed out waiting for the start-up lock");
    await sleep(200);
  }
}

let lockHeld = false;
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    const owner = JSON.parse(readFileSync(join(LOCK, "owner"), "utf8"));
    if (owner.pid === process.pid) rmSync(LOCK, { recursive: true, force: true });
  } catch {}
}

if (opts.serve) {
  const vite = await createServer({ configFile: CONFIG });
  await vite.listen();
  const base = vite.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5190/";
  console.log(`look-lab: serving ${new URL(PAGE, base)}?${query}`);
  await new Promise(() => {});
}

const lockStart = Date.now();
await acquireLock();
lockHeld = true;
const lockWaitMs = Date.now() - lockStart;
const vite = await createServer({
  configFile: CONFIG,
  appType: "mpa",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});

let waiter = null;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/__lab/")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.end("ok");
      const body = Buffer.concat(chunks);
      const kind = req.url.slice("/__lab/".length);
      if (kind === "log") {
        const { msg } = JSON.parse(body.toString("utf8"));
        log(`page: ${msg}`);
        if (msg === "loaded") releaseLock();
      } else waiter?.(kind, body);
    });
    return;
  }
  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
query.set("post", "1");
const url = `http://127.0.0.1:${port}${PAGE}?${query}`;
log(`server on ${port} (${Date.now() - started} ms)`);

let chrome = null;
let profile = null;

async function stopChrome() {
  const proc = chrome;
  chrome = null;
  if (proc && proc.exitCode === null) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(100);
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  }
  if (profile) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
    profile = null;
  }
}

async function cleanup() {
  await stopChrome();
  releaseLock();
  server.close();
  await vite.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(2);
  });
}

/** One headless Chrome attempt: resolves with the page's report and PNG, or rejects on a failure or timeout. */
function attempt(timeoutMs) {
  profile = mkdtempSync(join(tmpdir(), "look-lab-chrome-"));
  const gpu = opts.gpu
    ? ["--use-angle=metal", "--ignore-gpu-blocklist"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--mute-audio",
      "--window-size=1280,800",
      ...gpu,
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  return new Promise((resolvePromise, reject) => {
    let report = null;
    const timer = setTimeout(() => {
      waiter = null;
      reject(new Error(`no sheet after ${timeoutMs / 1000} s`));
    }, timeoutMs);
    chrome.on("exit", (code) => {
      if (!waiter) return;
      clearTimeout(timer);
      waiter = null;
      reject(new Error(`Chrome exited (${code}) before the sheet arrived`));
    });
    waiter = (kind, body) => {
      if (kind === "report") report = JSON.parse(body.toString("utf8"));
      else if (kind === "png") {
        clearTimeout(timer);
        waiter = null;
        resolvePromise({ report, png: body });
      } else if (kind === "fail") {
        clearTimeout(timer);
        waiter = null;
        const { error, diagnostics } = JSON.parse(body.toString("utf8"));
        const err = new Error(error);
        err.diagnostics = diagnostics;
        err.pageFailure = true;
        reject(err);
      }
    };
  });
}

const timeoutMs = Number(opts.timeout ?? 180) * 1000;
const retries = Number(opts.retries ?? 1);
let result = null;
let lastError = null;
for (let i = 0; i <= retries && !result; i++) {
  try {
    log(`chrome attempt ${i + 1}: ${url}`);
    result = await attempt(timeoutMs);
  } catch (e) {
    lastError = e;
    console.error(`look-lab: attempt ${i + 1} failed: ${e.message.split("\n")[0]}`);
    if (e.pageFailure) {
      for (const d of e.diagnostics ?? []) {
        console.error(`  ${d.level}: ${d.text.split("\n").slice(0, 6).join("\n    ")}`);
      }
      break;
    }
  } finally {
    await stopChrome();
  }
}
await cleanup();
if (!result) fail(`no sheet rendered (${lastError?.message.split("\n")[0] ?? "unknown"})`);

const stem = [
  opts.look,
  opts.grid ? "grid" : "sheet",
  `t${String(times).replaceAll(",", "-")}`,
  opts.presets ? opts.presets.replaceAll(",", "-") : null,
]
  .filter(Boolean)
  .join("-");
const out = resolve(opts.out ?? join(tmpdir(), "look-lab", `${stem}.png`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, result.png);

const r = result.report ?? { diagnostics: [], timing: {} };
const errors = r.diagnostics.filter((d) => d.level === "error");
const warnings = r.diagnostics.filter((d) => d.level === "warning");
const t = r.timing;
console.log(`look-lab: ${opts.look} -> ${out} (${r.width}x${r.height})`);
console.log(`  renderer: ${r.renderer}`);
console.log(
  `  timing: ${((Date.now() - started) / 1000).toFixed(1)} s total${lockWaitMs > 500 ? ` (${(lockWaitMs / 1000).toFixed(1)} s queued behind other runs' start-up)` : ""}, page ${(t.totalMs / 1000).toFixed(1)} s, ${t.tiles} tiles, first ${Math.round(t.firstTileMs)} ms, then ${Math.round(t.avgTileMs)} ms avg`,
);
for (const m of r.motion ?? []) {
  console.log(
    `  motion ${m.preset} ${m.cam}: mean ${m.mean.toFixed(2)}, ${Math.round(m.moving * 100)}% moved`,
  );
}
for (const d of [...errors, ...warnings]) {
  const lines = d.text.split("\n").slice(0, d.level === "error" ? 8 : 2);
  console.log(`  ${d.level}${d.count > 1 ? ` x${d.count}` : ""}: ${lines.join("\n    ")}`);
}
if (!errors.length && !warnings.length) console.log("  no console or shader errors");
if (existsSync(out)) process.exit(errors.length ? 1 : 0);
process.exit(2);
