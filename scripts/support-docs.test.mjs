// The support, release cadence, incident and privacy pages: links resolve, no placeholder or dropped page survives, named paths exist.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
  "docs/README.md",
  "docs/support-policy.md",
  "docs/release-cadence.md",
  "docs/incident-response.md",
  "docs/legal/privacy-notice.md",
];
const DROPPED = [
  "docs/legal/EULA-draft.md",
  "docs/legal/privacy-notice-draft.md",
  "docs/licensing-options.md",
];

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

function brokenLinks(doc) {
  const broken = [];
  for (const match of withoutCode(read(doc)).matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
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

test("every relative link in the support documents resolves to a file and heading", () => {
  for (const doc of DOCS) {
    assert.deepEqual(brokenLinks(doc), [], `${doc} has broken links`);
  }
});

test("no maintainer placeholder or dropped page survives", () => {
  for (const path of DROPPED) assert.ok(!existsSync(join(ROOT, path)), `${path} is back`);
  for (const doc of [...DOCS, "docs/decisions.md"]) {
    const text = read(doc);
    assert.ok(!text.includes("[DECISION"), `${doc} still has a [DECISION] placeholder`);
    for (const path of DROPPED) {
      const name = path.split("/").pop();
      assert.ok(!text.includes(name), `${doc} still names ${name}`);
    }
  }
});

test("every repository path the support documents name exists", () => {
  const pathLike = /^(?:\.github|scripts|src|src-tauri|docs)\/[\w./-]+$/;
  for (const doc of DOCS) {
    for (const match of withoutFences(read(doc)).matchAll(/`([^`\n]+)`/g)) {
      const path = match[1];
      if (!pathLike.test(path) || path.includes("<")) continue;
      assert.ok(existsSync(join(ROOT, path)), `${doc} names ${path}, which does not exist`);
    }
  }
});

test("heading anchors follow GitHub's rules", () => {
  const slugs = headingSlugs(
    "# Release cadence\n## Which release gets security fixes\n## What counts\n## What counts",
  );
  assert.deepEqual(
    [...slugs],
    ["release-cadence", "which-release-gets-security-fixes", "what-counts", "what-counts-1"],
  );
});
