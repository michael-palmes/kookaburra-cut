#!/usr/bin/env node
// Keeps the prose honest about the tree: every repo path a doc or skill cites must exist, and the
// version table in docs/architecture.md must agree with package.json. `pnpm test` runs this through
// docs-drift.test.mjs; run it directly for the list.
//
//   node scripts/docs-drift.mjs          exit 1 with every drift listed, 0 when clean
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where prose cites source: repo docs, the agent guide and the project skills. */
export const DOC_ROOTS = ["docs", ".agents/skills", "CLAUDE.md", "AGENTS.md", "README.md"];

const CITED_PREFIXES = [
  "src/",
  "src-tauri/",
  "scripts/",
  "docs/",
  ".agents/",
  ".github/",
  "presets/",
  "projects/",
  "fixtures/",
];

export function markdownFiles(root = ROOT, roots = DOC_ROOTS) {
  const out = [];
  const walk = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(join(path, entry));
    } else if (path.endsWith(".md")) {
      out.push(path);
    }
  };
  for (const entry of roots) {
    const path = join(root, entry);
    if (existsSync(path)) walk(path);
  }
  return out;
}

/** Backticked repo paths in a document, with `:line` suffixes and trailing punctuation dropped; globs, placeholders and `<slug>` templates are not citations. */
export function citedPaths(text) {
  const found = new Set();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    let cited = match[1].trim();
    if (!CITED_PREFIXES.some((prefix) => cited.startsWith(prefix))) continue;
    if (/[*<>{}$?]/.test(cited) || cited.includes(" ")) continue;
    cited = cited
      .replace(/:\d+(-\d+)?$/, "")
      .replace(/[.,;)]+$/, "")
      .replace(/\/$/, "");
    if (cited.includes("/**") || cited.endsWith("/*")) continue;
    found.add(cited);
  }
  return [...found];
}

/** A citation resolves from the repo root, or from the document's own folder (a skill cites its `scripts/beats.py` that way). */
export function missingPaths(root = ROOT, files = markdownFiles(root)) {
  const missing = [];
  for (const file of files) {
    for (const cited of citedPaths(readFileSync(file, "utf8"))) {
      if (existsSync(join(root, cited)) || existsSync(join(dirname(file), cited))) continue;
      missing.push(`${relative(root, file)}: ${cited}`);
    }
  }
  return missing;
}

/** Rows of the architecture.md dependency table that name a package.json dependency, mapped to the installed range. */
export const TABLE_PACKAGES = {
  "React + react-dom": "react",
  TypeScript: "typescript",
  Vite: "vite",
  "@vitejs/plugin-react": "@vitejs/plugin-react",
  three: "three",
  "@react-three/fiber": "@react-three/fiber",
  "@react-three/drei": "@react-three/drei",
  "@react-three/postprocessing": "@react-three/postprocessing",
  "troika-three-text": "troika-three-text",
  "anime.js": "animejs",
  zustand: "zustand",
  Vitest: "vitest",
  Biome: "@biomejs/biome",
  "Tauri (core + CLI)": "@tauri-apps/api",
};

/** `major.minor` of the table's `x.y.x` cell versus `major.minor` of the manifest's range; a row written as `2.x` only pins the major. */
export function versionDrift(tableText, manifest) {
  const drift = [];
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const line of tableText.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const key = TABLE_PACKAGES[cells[1]];
    if (!key) continue;
    const documented = cells[2].match(/^(\d+)(?:\.(\d+))?\.x/);
    const installed = deps[key]?.replace(/^[\^~=]/, "").match(/^(\d+)\.(\d+)/);
    if (!documented || !installed) {
      drift.push(`${cells[1]}: documented "${cells[2]}", installed "${deps[key] ?? "(absent)"}"`);
      continue;
    }
    const same =
      documented[1] === installed[1] &&
      (documented[2] === undefined || documented[2] === installed[2]);
    if (!same) drift.push(`${cells[1]}: documented ${cells[2]}, installed ${deps[key]}`);
  }
  return drift;
}

export function architectureDrift(root = ROOT) {
  const table = readFileSync(join(root, "docs/architecture.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return versionDrift(table, manifest);
}

export function allDrift(root = ROOT) {
  return [...missingPaths(root), ...architectureDrift(root)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const drift = allDrift();
  if (drift.length) {
    process.stderr.write(`${drift.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("docs match the tree and the manifests\n");
}
