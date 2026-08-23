import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  backfillPreviews,
  bundledSlugs,
  canonicalJson,
  commitPreviews,
  previewContentHash,
  stalePreviews,
} from "./preset-preview-stale.mjs";

const roots = [];

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, value);
}

function preset(root, slug, { art = true, title = "Hello" } = {}) {
  write(root, `presets/${slug}/preset.json`, JSON.stringify({ version: 1, name: slug }));
  write(root, `presets/${slug}/project.json`, JSON.stringify({ id: slug }));
  write(root, `presets/${slug}/scenes/01.json`, JSON.stringify({ version: 1, text: { title } }));
  write(root, `presets/${slug}/scenes/01.tsx`, "export default 1;\n");
  if (art) write(root, `src/assets/preset-previews/${slug}.jpg`, "jpeg");
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "preset-preview-stale-"));
  roots.push(root);
  preset(root, "opener");
  preset(root, "closer");
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("preview staleness ledger", () => {
  test("only the edited item goes stale", () => {
    const root = fixtureRoot();
    assert.deepEqual(bundledSlugs(root, "preset"), ["closer", "opener"]);
    commitPreviews(root, "preset", ["opener", "closer"]);
    assert.deepEqual(stalePreviews(root, "preset"), []);

    write(
      root,
      "presets/closer/scenes/01.json",
      JSON.stringify({ version: 1, text: { title: "Bye" } }),
    );
    assert.deepEqual(stalePreviews(root, "preset"), ["closer"]);

    commitPreviews(root, "preset", ["closer"]);
    assert.deepEqual(stalePreviews(root, "preset"), []);
  });

  test("a TSX-only edit is deliberately not caught", () => {
    const root = fixtureRoot();
    commitPreviews(root, "preset", ["opener", "closer"]);
    write(root, "presets/opener/scenes/01.tsx", "export default 2;\n");
    assert.deepEqual(stalePreviews(root, "preset"), []);
  });

  test("an item with no committed art is never stale", () => {
    const root = fixtureRoot();
    preset(root, "artless", { art: false });
    backfillPreviews(root, "preset");
    assert.deepEqual(stalePreviews(root, "preset"), []);
    const ledger = JSON.parse(readFileSync(join(root, "src/assets/preset-previews/ledger.json")));
    assert.deepEqual(Object.keys(ledger.items), ["closer", "opener"]);
  });

  test("committing drops entries for items that are gone", () => {
    const root = fixtureRoot();
    commitPreviews(root, "preset", ["opener", "closer"]);
    rmSync(join(root, "presets/closer"), { recursive: true });
    commitPreviews(root, "preset", ["opener"]);
    const ledger = JSON.parse(readFileSync(join(root, "src/assets/preset-previews/ledger.json")));
    assert.deepEqual(Object.keys(ledger.items), ["opener"]);
  });

  test("commit refuses an unknown slug or an item with no art", () => {
    const root = fixtureRoot();
    preset(root, "artless", { art: false });
    assert.throws(() => commitPreviews(root, "preset", ["nope"]), /unknown preset/);
    assert.throws(() => commitPreviews(root, "preset", ["artless"]), /no committed art/);
  });

  test("templates hash their own manifest and need all four stills", () => {
    const root = fixtureRoot();
    write(root, "projects/kit/template.json", JSON.stringify({ version: 1, name: "Kit" }));
    write(root, "projects/kit/project.json", JSON.stringify({ id: "kit" }));
    write(root, "projects/kit/scenes/01.json", JSON.stringify({ version: 1 }));
    for (const i of [1, 2, 3]) write(root, `src/assets/template-previews/kit-${i}.jpg`, "jpeg");
    assert.throws(() => commitPreviews(root, "template", ["kit"]), /no committed art/);
    write(root, "src/assets/template-previews/kit-4.jpg", "jpeg");
    commitPreviews(root, "template", ["kit"]);
    assert.deepEqual(stalePreviews(root, "template"), []);
  });

  // The golden vector src/engine/presets.test.ts pins too: the app and this script must
  // digest identically or every bundled card would read as stale.
  test("hashes to the golden vector the app pins", () => {
    assert.equal(canonicalJson({ b: 2, a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}],"b":2}');
    assert.equal(
      previewContentHash([
        ["scenes/01.json", { z: [1, 2], a: "x", n: null }],
        ["preset.json", { version: 1, name: "Golden" }],
      ]),
      "68cbea3520274af8",
    );
  });
});
