#!/usr/bin/env node
// The licences folder the app bundles (Contents/Resources/licenses): the project's own licences and
// NOTICE.md, the font, shader and beat model licences, and THIRD-PARTY-NOTICES.txt for every npm
// package (pnpm licenses list --prod, as scripts/sbom.mjs reads it) and Rust crate (cargo metadata
// for the shipped target) with its licence files. The sidecar build writes sidecar/; this leaves it.
//
//   node scripts/licence-notices.mjs
//   node scripts/licence-notices.mjs --check-sbom <cdx.json> --notices <THIRD-PARTY-NOTICES.txt>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri/resources/licenses");
const TARGET = "aarch64-apple-darwin";
const CRATE = "kookaburra-cut";
const RULE = "=".repeat(72);
const KEEP = new Set(["README.md", "sidecar"]);
const COPIES = [
  ["LICENSE-MIT", "LICENSE-MIT"],
  ["LICENSE-APACHE", "LICENSE-APACHE"],
  ["NOTICE.md", "NOTICE.md"],
  ["src/assets/fonts/OFL.txt", "fonts/OFL.txt"],
  ["src/assets/fonts/LICENSES.md", "fonts/LICENSES.md"],
  ["src/toolkit/stage/shaders/NOTICE.md", "shaders/NOTICE.md"],
  ["LICENSE-APACHE", "shaders/LICENSE-APACHE"],
  ["scripts/licences/beat-this-rs-LICENSE", "beat-this/LICENSE"],
];
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicen[cs]e)([-._].*)?$/i;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** The SPDX ids an expression names, exceptions included. */
export function spdxIds(expression) {
  return [
    ...new Set(
      (expression ?? "")
        .split(/[\s()/]+/)
        .filter((t) => t && !/^(AND|OR|WITH)$/.test(t))
        .map((t) => t.replace(/\+$/, "")),
    ),
  ];
}

/** A package folder's licence files, by name; a REUSE `LICENSES/` folder counts too. */
export function licenceFiles(dir, extra = []) {
  const out = new Map();
  const add = (name, path) => {
    try {
      if (statSync(path).isFile()) out.set(name, readFileSync(path, "utf8"));
    } catch {}
  };
  let names = [];
  try {
    names = readdirSync(dir).sort();
  } catch {}
  for (const name of names) {
    if (name === "LICENSES" && statSync(join(dir, name)).isDirectory()) {
      for (const inner of readdirSync(join(dir, name)).sort())
        add(`LICENSES/${inner}`, join(dir, name, inner));
    } else if (LICENCE_FILE.test(name)) add(name, join(dir, name));
  }
  for (const rel of extra) if (!out.has(rel)) add(rel, join(dir, rel));
  return out;
}

const tidy = (text) =>
  `${text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim()}\n`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

/**
 * THIRD-PARTY-NOTICES.txt from package records ({ kind, name, version, licence, by, home, files }).
 * A text printed once is named after that, and a package without files gets the standard texts.
 */
export function renderNotices(packages, standardTexts) {
  const key = (p) => `${p.kind}\0${p.name}\0${p.version}`;
  const sorted = [...packages].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const count = (kind) => sorted.filter((p) => p.kind === kind).length;
  const lines = [
    "Third-party notices for Kookaburra Cut",
    "",
    "Kookaburra Cut is MIT OR Apache-2.0 (LICENSE-MIT and LICENSE-APACHE beside this file). It is",
    "built with the open source packages below, each under its own licence. sidecar/ holds the",
    "ffmpeg, x264 and x265 licences, and NOTICE.md covers the fonts, images, models and shaders.",
    "",
    `npm packages: ${count("npm")}`,
    `Rust crates: ${count("crate")}`,
  ];
  const printed = new Map();
  const standard = new Set();
  for (const p of sorted) {
    lines.push(
      "",
      RULE,
      `${p.kind}: ${p.name} ${p.version}`,
      `Licence: ${p.licence || "not stated"}`,
    );
    if (p.by) lines.push(`By: ${p.by}`);
    if (p.home) lines.push(`Home: ${p.home}`);
    if (p.files.size === 0) {
      const ids = spdxIds(p.licence);
      if (ids.length === 0)
        throw new Error(`${p.name} ${p.version} has no licence file and no licence`);
      for (const id of ids) {
        if (!standardTexts.has(id))
          throw new Error(
            `${p.name} ${p.version} needs the standard ${id} text (add scripts/licences/spdx/${id}.txt)`,
          );
        standard.add(id);
      }
      lines.push(
        `No licence file in the package: the standard ${ids.join(", ")} text is at the end.`,
      );
      continue;
    }
    for (const [name, raw] of p.files) {
      const text = tidy(raw);
      const first = printed.get(sha(text));
      if (first) {
        lines.push("", `${name}: the same text as ${first} above.`);
        continue;
      }
      printed.set(sha(text), `${name} in ${p.name} ${p.version}`);
      lines.push("", `${name}:`, "", text.trimEnd());
    }
  }
  if (standard.size > 0) {
    lines.push("", RULE, "Standard licence texts", RULE);
    for (const id of [...standard].sort()) {
      lines.push("", `${id}:`, "", tidy(standardTexts.get(id)).trimEnd());
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The package and version lines a notices file lists. */
export function listedPackages(notices) {
  return new Set(
    [...notices.matchAll(/^(npm|crate): (\S+) (\S+)$/gm)].map((m) => `${m[1]}:${m[2]}@${m[3]}`),
  );
}

/** Every npm and cargo component an SBOM lists that the notices leave out, the app crate aside. */
export function missingFromNotices(sbom, notices) {
  const listed = listedPackages(notices);
  const missing = [];
  for (const c of sbom.components ?? []) {
    const purl = c.purl ?? "";
    const kind = purl.startsWith("pkg:npm/")
      ? "npm"
      : purl.startsWith("pkg:cargo/")
        ? "crate"
        : null;
    if (!kind || (kind === "crate" && c.name === CRATE)) continue;
    const key = `${kind}:${c.name}@${c.version}`;
    if (!listed.has(key)) missing.push(key);
  }
  return missing.sort();
}

function npmPackages() {
  const list = JSON.parse(run("pnpm", ["licenses", "list", "--prod", "--json"]));
  const out = [];
  for (const entries of Object.values(list)) {
    for (const e of entries) {
      e.versions.forEach((version, i) => {
        out.push({
          kind: "npm",
          name: e.name,
          version,
          licence: e.license,
          by: typeof e.author === "string" ? e.author : e.author?.name,
          home: e.homepage,
          files: licenceFiles(e.paths[i]),
        });
      });
    }
  }
  return out;
}

function cratePackages() {
  const meta = JSON.parse(
    run("cargo", [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      TARGET,
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps)
      if (d.dep_kinds.some((k) => k.kind !== "dev")) stack.push(d.pkg);
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((p) => p.name !== CRATE)
    .map((p) => ({
      kind: "crate",
      name: p.name,
      version: p.version,
      licence: p.license,
      by: (p.authors ?? []).join(", "),
      home: p.repository ?? p.homepage,
      files: licenceFiles(dirname(p.manifest_path), p.license_file ? [p.license_file] : []),
    }));
}

function standardTexts() {
  const dir = join(ROOT, "scripts/licences/spdx");
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => [f.slice(0, -4), readFileSync(join(dir, f), "utf8")]),
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
      throw new Error(`usage: ${argv[i]} needs a value`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["check-sbom"]) {
    if (!args.notices) throw new Error("usage: --check-sbom <cdx.json> --notices <file>");
    const missing = missingFromNotices(
      JSON.parse(readFileSync(args["check-sbom"], "utf8")),
      readFileSync(args.notices, "utf8"),
    );
    if (missing.length > 0) {
      console.error(
        `the notices leave out ${missing.length} packages the SBOM lists:\n  ${missing.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(`${args.notices}: lists every package in ${args["check-sbom"]}`);
    return;
  }
  const out = OUT;
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out))
    if (!KEEP.has(name)) rmSync(join(out, name), { recursive: true, force: true });
  for (const [from, to] of COPIES) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(join(ROOT, from), join(out, to));
  }
  const packages = [...npmPackages(), ...cratePackages()];
  writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), renderNotices(packages, standardTexts()));
  console.log(`${out}: notices for ${packages.length} packages`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
