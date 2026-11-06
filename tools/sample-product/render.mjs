#!/usr/bin/env node
// Renders the sample product family into projects/_samples by stepping each page's render(ms) in headless Chrome (README.md).
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICES, FPS, JOBS, MAX_VIDEO_BYTES } from "./manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CHROME =
  process.env.SAMPLE_PRODUCT_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIDECAR = join(REPO, "src-tauri/bin/ffmpeg-aarch64-apple-darwin");
const FFMPEG = existsSync(SIDECAR) ? SIDECAR : "ffmpeg";
const SERVED = ["/tools/sample-product/", "/src/assets/fonts/"];
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const opts = {
  only: null,
  out: join(REPO, "projects/_samples"),
  keepFrames: false,
  list: false,
  at: null,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") opts.only = argv[++i]?.split(",").filter(Boolean);
  else if (a === "--out") opts.out = resolve(argv[++i]);
  else if (a === "--keep-frames") opts.keepFrames = true;
  else if (a === "--list") opts.list = true;
  else if (a === "--at") opts.at = argv[++i]?.split(",").map(Number);
  else fail(`unknown argument "${a}"`);
}
if (opts.at && !argv.includes("--out"))
  fail("--at needs --out, so peeks never land in the sample pool");

function fail(msg) {
  console.error(`sample-product: ${msg}`);
  process.exit(2);
}

const jobs = JOBS.filter((j) => !opts.only || opts.only.some((o) => j.out.includes(o)));
if (opts.list) {
  for (const j of jobs)
    console.log(`${j.out}  ${j.page}  ${j.device}${j.seconds ? `  ${j.seconds}s` : ""}`);
  process.exit(0);
}
if (!jobs.length) fail("no job matches --only");
if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME} (set SAMPLE_PRODUCT_CHROME)`);
mkdirSync(opts.out, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = "";
  try {
    rel = normalize(decodeURIComponent(url.pathname));
  } catch {}
  const file = join(REPO, rel);
  if (
    !rel ||
    !SERVED.some((p) => rel.startsWith(p)) ||
    !file.startsWith(REPO + sep) ||
    !existsSync(file)
  ) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "sample-product-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const wsUrl = await new Promise((resolveUrl, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("Chrome did not open DevTools")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolveUrl(m[1]);
    }
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r, reject) => {
  ws.onopen = r;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolveMsg, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
  else resolveMsg(msg.result);
};
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolveMsg, reject) => pending.set(id, { resolveMsg, reject }));
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp("Page.enable");
await cdp("Runtime.enable");

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

async function open(job) {
  const device = DEVICES[job.device];
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.scale,
    mobile: false,
  });
  await cdp("Emulation.setDefaultBackgroundColorOverride", {
    color: device.transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 255, g: 255, b: 255, a: 1 },
  });
  const url = `${origin}/tools/sample-product/${job.page}`;
  await cdp("Page.navigate", { url });
  for (let i = 0; ; i++) {
    const state = await evaluate(
      `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && typeof window.render === 'function'`,
    );
    if (state) break;
    if (i >= 200) throw new Error(`${job.page} never defined window.render`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await evaluate("window.pageReady ?? true");
  const missing = await evaluate(
    "[...document.fonts].filter((f) => f.status === 'error').map((f) => f.family + ' ' + f.weight)",
  );
  return { device, missing };
}

async function frame(ms) {
  await evaluate(`window.render(${ms})`);
  await evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const { data } = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
  return Buffer.from(data, "base64");
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.slice(-800)}`);
  return r;
}

function writeStill(png, out, job) {
  if (out.endsWith(".png")) {
    const raw = `${out}.raw.png`;
    writeFileSync(raw, png);
    run("pngquant", [
      "--quality",
      "90-99",
      "--speed",
      "1",
      "--strip",
      "--force",
      "--output",
      out,
      raw,
    ]);
    rmSync(raw);
    run("oxipng", ["-q", "-o", "4", "--strip", "safe", out]);
    return;
  }
  const tmp = `${out}.tmp.png`;
  writeFileSync(tmp, png);
  run("magick", [
    tmp,
    "-strip",
    "-sampling-factor",
    job.sampling ?? "4:2:0",
    "-quality",
    String(job.quality ?? 86),
    out,
  ]);
  rmSync(tmp);
}

function encode(dir, out, job) {
  let crf = job.crf ?? 18;
  for (;;) {
    run(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      join(dir, "%04d.png"),
      "-vf",
      "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryslow",
      "-tune",
      "animation",
      "-crf",
      String(crf),
      "-g",
      "60",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-movflags",
      "+faststart",
      "-an",
      out,
    ]);
    const size = statSync(out).size;
    if (size <= MAX_VIDEO_BYTES) return { crf, size };
    if (crf >= 30) throw new Error(`${out} is still ${size} bytes at CRF 30`);
    crf += 2;
  }
}

const results = [];
try {
  for (const job of jobs) {
    const started = Date.now();
    const { device, missing } = await open(job);
    if (missing.length) throw new Error(`${job.out}: fonts failed to load: ${missing.join(", ")}`);
    const out = join(opts.out, job.out);
    const px = `${device.width * device.scale}x${device.height * device.scale}`;
    if (opts.at) {
      for (const at of opts.at) {
        const peek = out.replace(/\.\w+$/, `@${at}.png`);
        writeFileSync(peek, await frame(at * 1000));
        results.push({ out: peek.slice(opts.out.length + 1), px, bytes: statSync(peek).size });
      }
    } else if (!job.seconds) {
      writeStill(await frame((job.at ?? 0) * 1000), out, job);
      results.push({ out: job.out, px, bytes: statSync(out).size });
    } else {
      const dir = mkdtempSync(join(tmpdir(), "sample-product-frames-"));
      const count = Math.round(job.seconds * FPS);
      for (let i = 0; i < count; i++) {
        writeFileSync(
          join(dir, `${String(i).padStart(4, "0")}.png`),
          await frame((i * 1000) / FPS),
        );
      }
      const { crf, size } = encode(dir, out, job);
      if (opts.keepFrames) console.log(`  frames kept in ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
      results.push({ out: job.out, px, bytes: size, crf, frames: count });
    }
    const r = results.at(-1);
    console.log(
      `${r.out}  ${r.px}  ${(r.bytes / 1024).toFixed(0)} KB${r.crf ? `  crf ${r.crf}, ${r.frames} frames` : ""}  ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
} finally {
  ws.close();
  chrome.kill("SIGTERM");
  await new Promise((r) => (chrome.exitCode === null ? chrome.once("exit", r) : r()));
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const total = results.reduce((s, r) => s + r.bytes, 0);
console.log(`${results.length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
