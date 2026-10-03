#!/usr/bin/env node
// Option-preview staleness: hashes every preview-lab fixture against the committed manifest so
// `kookaburra:run --action option-previews` re-renders only what changed (and skips the app boot
// entirely when nothing did). The stem→set naming here MIRRORS optionPreviewJobs in
// src/engine/optionPreviews.ts (the pinned vocabulary); change them together.
//
//   list                 print stale set names, comma-separated (empty = all fresh)
//   commit <set...>      merge those sets' current source hashes into the manifest
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const assetsDir = (root) => join(root, "src", "assets", "option-previews");
const manifestPath = (root) => join(assetsDir(root), "manifest.json");

// Capture constants participate in the hash so changing them re-records everything.
function enginePin(root) {
  const src = readFileSync(join(root, "src", "engine", "optionPreviews.ts"), "utf8");
  const fps = src.match(/OPTION_CLIP_FPS = (\d+)/)?.[1];
  const width = src.match(/OPTION_PREVIEW_WIDTH = (\d+)/)?.[1];
  const version = src.match(/OPTION_PREVIEW_VERSION = (\d+)/)?.[1];
  if (!fps || !width || !version)
    throw new Error("option-preview-stale: capture constants not found");
  return `fps=${fps};width=${width};version=${version}`;
}

function setNameOf(stem) {
  if (stem.startsWith("tm-")) return `textanim-${stem.slice(3)}`;
  if (stem.startsWith("tl-")) return `textlook-${stem.slice(3)}`;
  if (/^(bgp?|shadow|stage|object|chart|chartanim)-/.test(stem)) return stem;
  return null;
}
const isClip = (stem, set) =>
  stem.startsWith("tm-")
    ? set !== "textanim-none"
    : stem.startsWith("tl-") ||
      (stem.startsWith("bg-") && !stem.startsWith("bgp-")) ||
      stem.startsWith("chartanim-");

function collectSets(root) {
  const pin = enginePin(root);
  const sets = new Map();
  // The labs are dev-only fixtures, so they live in fixtures/, not the shipped projects/ tree.
  const labs = readdirSync(join(root, "fixtures")).filter((d) => d.startsWith("preview-lab"));
  for (const lab of labs) {
    const projectPath = join(root, "fixtures", lab, "project.json");
    if (!existsSync(projectPath)) continue;
    const manifest = JSON.parse(readFileSync(projectPath, "utf8"));
    for (const scene of manifest.scenes ?? []) {
      const stem = scene.file.replace(/^scenes\//, "").replace(/\.tsx$/, "");
      const set = setNameOf(stem);
      if (!set) continue;
      const hash = createHash("sha1");
      hash.update(pin);
      hash.update(`duration=${scene.durationMs}`);
      hash.update(readFileSync(join(root, "fixtures", lab, "scenes", `${stem}.tsx`)));
      const sidecar = join(root, "fixtures", lab, "scenes", `${stem}.json`);
      if (existsSync(sidecar)) hash.update(readFileSync(sidecar));
      sets.set(set, { hash: hash.digest("hex"), clip: isClip(stem, set) });
    }
  }
  return sets;
}

function readManifest(root) {
  return existsSync(manifestPath(root)) ? JSON.parse(readFileSync(manifestPath(root), "utf8")) : {};
}

/** Sorted names of the sets whose assets are missing or whose source hash moved. */
export function staleOptionPreviews(root = SCRIPT_ROOT) {
  const manifest = readManifest(root);
  const stale = [];
  for (const [set, { hash, clip }] of collectSets(root)) {
    const assetOk = clip
      ? existsSync(join(assetsDir(root), `${set}.mp4`)) &&
        existsSync(join(assetsDir(root), `${set}-poster.jpg`))
      : existsSync(join(assetsDir(root), `${set}.jpg`));
    if (!assetOk || manifest[set] !== hash) stale.push(set);
  }
  return stale.sort();
}

/** Records the captured sets' current hashes and drops entries whose fixture is gone. */
export function commitOptionPreviews(root = SCRIPT_ROOT, captured = []) {
  const manifest = readManifest(root);
  const sets = collectSets(root);
  for (const set of captured) {
    const entry = sets.get(set);
    if (entry) manifest[set] = entry.hash;
  }
  for (const set of Object.keys(manifest)) if (!sets.has(set)) delete manifest[set];
  const ordered = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(manifestPath(root), `${JSON.stringify(ordered, null, 2)}\n`);
  return captured.length;
}

function runCli() {
  const mode = process.argv[2];
  if (mode === "list") {
    process.stdout.write(staleOptionPreviews().join(","));
  } else if (mode === "commit") {
    const count = commitOptionPreviews(SCRIPT_ROOT, process.argv.slice(3));
    process.stdout.write(`manifest: ${count} set(s) committed\n`);
  } else {
    console.error("usage: option-preview-stale.mjs list | commit <set...>");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
