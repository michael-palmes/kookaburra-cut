#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The card-art staleness ledger for the two BUNDLED catalogues: scene presets (presets/) and
 * templates (projects/*&#47;template.json). One entry per item, holding a content hash of the
 * item's authored JSON, written by the promotion step of the preview autoruns and read back in
 * dev by src/engine/presets.ts and src/engine/templates.ts to badge cards whose art is older
 * than the item.
 *
 * The hash covers the manifest, project.json and every scene sidecar. It deliberately does NOT
 * cover the scene TSX: a code edit can change the pixels without touching any JSON, so a
 * TSX-only change goes unbadged and still needs a manual re-render.
 *
 * `canonicalJson` and `contentDigest` are mirrored EXACTLY in src/engine/presets.ts, which is
 * the only way the app can compare a hash this script wrote.
 */

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PREVIEW_LEDGER_VERSION = 1;

const KINDS = {
  preset: {
    itemsDir: (root) => join(root, "presets"),
    manifest: "preset.json",
    ledger: (root) => join(root, "src", "assets", "preset-previews", "ledger.json"),
    art: (root, slug) => [join(root, "src", "assets", "preset-previews", `${slug}.jpg`)],
  },
  template: {
    itemsDir: (root) => join(root, "projects"),
    manifest: "template.json",
    ledger: (root) => join(root, "src", "assets", "template-previews", "ledger.json"),
    art: (root, slug) =>
      [1, 2, 3, 4].map((i) => join(root, "src", "assets", "template-previews", `${slug}-${i}.jpg`)),
  },
};

function kindSpec(kind) {
  const spec = KINDS[kind];
  if (!spec)
    throw new Error(`preset-preview-stale: kind must be preset or template, got "${kind}"`);
  return spec;
}

/** Object keys sorted, no whitespace, so the same document hashes the same here and in the app. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a over two independent lanes, concatenated as 16 hex chars: cheap, dependency-free and identical in the browser. */
export function contentDigest(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** The ledger hash for one item: `[relative path, parsed document]` pairs, sorted by path. */
export function previewContentHash(docs) {
  const sorted = [...docs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return contentDigest(sorted.map(([path, doc]) => `${path}\n${canonicalJson(doc)}\n`).join(""));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function itemDocs(root, kind, slug) {
  const spec = kindSpec(kind);
  const dir = join(spec.itemsDir(root), slug);
  const docs = [
    [spec.manifest, readJson(join(dir, spec.manifest))],
    ["project.json", readJson(join(dir, "project.json"))],
  ];
  const scenes = join(dir, "scenes");
  if (existsSync(scenes)) {
    for (const name of readdirSync(scenes)) {
      if (name.endsWith(".json")) docs.push([`scenes/${name}`, readJson(join(scenes, name))]);
    }
  }
  return docs;
}

/** Every bundled slug of this kind (a folder carrying the kind's manifest), in name order. */
export function bundledSlugs(root = SCRIPT_ROOT, kind = "preset") {
  const spec = kindSpec(kind);
  const dir = spec.itemsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, spec.manifest)))
    .map((entry) => entry.name)
    .sort();
}

/** Current content hashes for every bundled item of this kind. */
export function currentHashes(root = SCRIPT_ROOT, kind = "preset") {
  const hashes = new Map();
  for (const slug of bundledSlugs(root, kind)) {
    hashes.set(slug, previewContentHash(itemDocs(root, kind, slug)));
  }
  return hashes;
}

function readLedger(root, kind) {
  try {
    const raw = readJson(kindSpec(kind).ledger(root));
    return raw && typeof raw.items === "object" && raw.items !== null ? raw.items : {};
  } catch {
    return {};
  }
}

function writeLedger(root, kind, items) {
  const path = kindSpec(kind).ledger(root);
  mkdirSync(dirname(path), { recursive: true });
  const ordered = Object.fromEntries(
    Object.entries(items).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: PREVIEW_LEDGER_VERSION, items: ordered }, null, 2)}\n`,
    );
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function artExists(root, kind, slug) {
  return kindSpec(kind)
    .art(root, slug)
    .every((path) => existsSync(path));
}

/** Items whose committed art is older than their authored JSON (missing art is not stale: those cards already degrade to a swatch). */
export function stalePreviews(root = SCRIPT_ROOT, kind = "preset") {
  const ledger = readLedger(root, kind);
  return [...currentHashes(root, kind)]
    .filter(([slug, hash]) => artExists(root, kind, slug) && ledger[slug] !== hash)
    .map(([slug]) => slug);
}

/** Record the given items as freshly rendered; entries for items that no longer exist are dropped. */
export function commitPreviews(root = SCRIPT_ROOT, kind = "preset", captured = []) {
  const hashes = currentHashes(root, kind);
  const unknown = captured.filter((slug) => !hashes.has(slug));
  if (unknown.length > 0) {
    throw new Error(`preset-preview-stale: unknown ${kind}(s): ${unknown.join(", ")}`);
  }
  const previous = readLedger(root, kind);
  const items = Object.fromEntries(Object.entries(previous).filter(([slug]) => hashes.has(slug)));
  for (const slug of captured) {
    if (!artExists(root, kind, slug)) {
      throw new Error(`preset-preview-stale: no committed art for ${kind} ${slug}`);
    }
    items[slug] = hashes.get(slug);
  }
  writeLedger(root, kind, items);
  return { committed: captured.length, entries: Object.keys(items).length };
}

/** Record every item that already has committed art: the one-off ledger seed for a catalogue whose art predates this ledger. */
export function backfillPreviews(root = SCRIPT_ROOT, kind = "preset") {
  const ready = [...currentHashes(root, kind).keys()].filter((slug) => artExists(root, kind, slug));
  return { ...commitPreviews(root, kind, ready), backfilled: ready.length };
}

function runCli() {
  const [mode, kind, ...slugs] = process.argv.slice(2);
  if (mode === "list") {
    process.stdout.write(stalePreviews(SCRIPT_ROOT, kind).join(","));
    return;
  }
  if (mode === "commit") {
    const result = commitPreviews(SCRIPT_ROOT, kind, slugs);
    process.stdout.write(
      `ledger: ${result.committed} ${kind}(s) committed, ${result.entries} entry(s) held\n`,
    );
    return;
  }
  if (mode === "backfill") {
    const result = backfillPreviews(SCRIPT_ROOT, kind);
    process.stdout.write(`ledger: ${result.backfilled} ${kind}(s) backfilled\n`);
    return;
  }
  console.error(
    "usage: preset-preview-stale.mjs list|backfill <preset|template> | commit <preset|template> <slug...>",
  );
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
