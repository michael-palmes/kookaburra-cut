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
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "src", "assets", "option-previews");
const MANIFEST = join(ASSETS, "manifest.json");

// Capture constants participate in the hash so changing them re-records everything.
const enginePin = (() => {
  const src = readFileSync(join(ROOT, "src", "engine", "optionPreviews.ts"), "utf8");
  const fps = src.match(/OPTION_CLIP_FPS = (\d+)/)?.[1];
  const width = src.match(/OPTION_PREVIEW_WIDTH = (\d+)/)?.[1];
  if (!fps || !width) throw new Error("option-preview-stale: capture constants not found");
  return `fps=${fps};width=${width}`;
})();

function setNameOf(stem) {
  if (stem.startsWith("tm-")) return `textanim-${stem.slice(3)}`;
  if (/^(bgp?|shadow|stage|kind|object|chart|chartanim)-/.test(stem)) return stem;
  return null;
}
const isClip = (stem, set) =>
  stem.startsWith("tm-")
    ? set !== "textanim-none"
    : (stem.startsWith("bg-") && !stem.startsWith("bgp-")) || stem.startsWith("chartanim-");

function collectSets() {
  const sets = new Map();
  const labs = readdirSync(join(ROOT, "projects")).filter((d) => d.startsWith("preview-lab"));
  for (const lab of labs) {
    const projectPath = join(ROOT, "projects", lab, "project.json");
    if (!existsSync(projectPath)) continue;
    const manifest = JSON.parse(readFileSync(projectPath, "utf8"));
    for (const scene of manifest.scenes ?? []) {
      const stem = scene.file.replace(/^scenes\//, "").replace(/\.tsx$/, "");
      const set = setNameOf(stem);
      if (!set) continue;
      const hash = createHash("sha1");
      hash.update(enginePin);
      hash.update(`duration=${scene.durationMs}`);
      hash.update(readFileSync(join(ROOT, "projects", lab, "scenes", `${stem}.tsx`)));
      const sidecar = join(ROOT, "projects", lab, "scenes", `${stem}.json`);
      if (existsSync(sidecar)) hash.update(readFileSync(sidecar));
      sets.set(set, { hash: hash.digest("hex"), clip: isClip(stem, set) });
    }
  }
  return sets;
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
const mode = process.argv[2];

if (mode === "list") {
  const stale = [];
  for (const [set, { hash, clip }] of collectSets()) {
    const assetOk = clip
      ? existsSync(join(ASSETS, `${set}.mp4`)) && existsSync(join(ASSETS, `${set}-poster.jpg`))
      : existsSync(join(ASSETS, `${set}.jpg`));
    if (!assetOk || manifest[set] !== hash) stale.push(set);
  }
  process.stdout.write(stale.sort().join(","));
} else if (mode === "commit") {
  const sets = collectSets();
  const captured = process.argv.slice(3);
  for (const set of captured) {
    const entry = sets.get(set);
    if (entry) manifest[set] = entry.hash;
  }
  // Drop entries whose fixture no longer exists, so renames don't leave ghosts.
  for (const set of Object.keys(manifest)) if (!sets.has(set)) delete manifest[set];
  const ordered = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(MANIFEST, `${JSON.stringify(ordered, null, 2)}\n`);
  process.stdout.write(`manifest: ${captured.length} set(s) committed\n`);
} else {
  console.error("usage: option-preview-stale.mjs list | commit <set...>");
  process.exit(2);
}
