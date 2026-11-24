// The vendor questionnaire, subprocessors and third-party assessment pages: every relative link resolves, answers use four words, the version line keeps step.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
  "docs/vendor-questionnaire.md",
  "docs/subprocessors.md",
  "docs/third-party-assessment.md",
];
const ANSWERS = new Set(["Yes", "No", "Partial", "Not applicable"]);
const VERSION_LINE = /^\*\*Version:\*\* (\d+\.\d+\.\d+)(, pending)?\.$/m;

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const withoutFences = (text) => text.replace(/^```[\s\S]*?^```/gm, "");
const withoutCode = (text) => withoutFences(text).replace(/`[^`\n]*`/g, "");

// GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen, repeats numbered.
function headingSlugs(markdown) {
  const slugs = new Set();
  const seen = new Map();
  for (const line of withoutFences(markdown).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const base = heading[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function relativeLinks(markdown) {
  const links = [];
  for (const match of withoutCode(markdown).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1])) links.push(match[1]);
  }
  return links;
}

function brokenLinks(doc) {
  const text = read(doc);
  const broken = [];
  for (const link of relativeLinks(text)) {
    const [path, anchor] = link.split("#");
    const target = path ? resolve(ROOT, dirname(doc), decodeURIComponent(path)) : join(ROOT, doc);
    const inRepo = relative(ROOT, target);
    if (inRepo.startsWith(`..${sep}`) || inRepo === "..") {
      broken.push(`${link} leaves the repository`);
    } else if (!existsSync(target)) {
      broken.push(`${link} names a missing file`);
    } else if (anchor && target.endsWith(".md")) {
      if (!headingSlugs(readFileSync(target, "utf8")).has(anchor))
        broken.push(`${link} names a missing heading`);
    }
  }
  return broken;
}

test("every relative link in the vendor documents resolves to a file and heading", () => {
  for (const doc of DOCS) {
    assert.deepEqual(brokenLinks(doc), [], `${doc} has broken links`);
  }
});

test("every questionnaire answer is Yes, No, Partial or Not applicable, with evidence", () => {
  const lines = read(DOCS[0]).split("\n");
  let rows = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\| Question \| Answer \| Evidence \| Notes \|$/.test(lines[i])) continue;
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
      const cells = lines[j].slice(1, -1).split(" | ");
      assert.equal(cells.length, 4, `line ${j + 1} does not have four cells`);
      assert.ok(ANSWERS.has(cells[1].trim()), `line ${j + 1} answers "${cells[1].trim()}"`);
      assert.ok(cells[2].trim(), `line ${j + 1} has no evidence`);
      rows++;
    }
  }
  assert.ok(rows > 0, "no answer tables found");
});

test("the version line is the shipped version, or a later one marked pending", () => {
  const shipped = JSON.parse(read("src-tauri/tauri.conf.json")).version;
  const parts = (version) => version.split(".").map(Number);
  const order = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  const described = new Set();
  for (const doc of DOCS) {
    const found = read(doc).match(VERSION_LINE);
    assert.ok(found, `${doc} has no **Version:** line`);
    const [, version, pending] = found;
    described.add(version);
    if (pending) {
      assert.ok(
        order(version, shipped) > 0,
        `${doc} says ${version} is pending, but tauri.conf.json is ${shipped}: drop "pending"`,
      );
    } else {
      assert.equal(version, shipped, `${doc} describes ${version}; tauri.conf.json is ${shipped}`);
    }
  }
  assert.equal(described.size, 1, "the documents describe different versions");
});

test("heading anchors follow GitHub's rules", () => {
  const slugs = headingSlugs(
    "# Packs (`.kbpack`)\n## Claude Code's own settings\n## Updates: in-app or MDM\n## Retention\n## Retention\n```\n# not a heading\n```",
  );
  assert.deepEqual(
    [...slugs],
    [
      "packs-kbpack",
      "claude-codes-own-settings",
      "updates-in-app-or-mdm",
      "retention",
      "retention-1",
    ],
  );
});
