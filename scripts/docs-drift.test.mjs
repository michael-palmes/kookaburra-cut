import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { allDrift, citedPaths, missingPaths, versionDrift } from "./docs-drift.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cited paths", () => {
  test("keeps repo paths, drops line suffixes, globs and placeholders", () => {
    const text = [
      "See `src/engine/exporter.ts:447` and `docs/packs.md`, then `scripts/release.sh`.",
      "Never `src-tauri/src/pack/**`, `src/assets/models/licensed/<uuid>.glb` or `projects/*/scenes/*.tsx`.",
      "Plain `pnpm gate` and `cargo test` are commands, not paths.",
    ].join("\n");
    assert.deepEqual(citedPaths(text), [
      "src/engine/exporter.ts",
      "docs/packs.md",
      "scripts/release.sh",
    ]);
  });

  test("reports a cited file that is not in the tree", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
    roots.push(root);
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/present.ts"), "");
    writeFileSync(join(root, "docs/a.md"), "`src/present.ts` is here, `src/gone.ts` is not.");
    assert.deepEqual(missingPaths(root), ["docs/a.md: src/gone.ts"]);
  });
});

describe("the version table", () => {
  const table = [
    "| Dependency | Version | Role | Licence |",
    "| --- | --- | --- | --- |",
    "| TypeScript | 7.0.x | Typed toolkit | Apache-2.0 |",
    "| three | 0.184.x | WebGL | MIT |",
    "| tauri-plugin-log | 2.x | Native log sink | MIT |",
    "| Vitest | 4.x | Tests | MIT |",
  ].join("\n");

  test("flags a minor that moved and accepts a major-only row", () => {
    const drift = versionDrift(table, {
      dependencies: { three: "^0.185.1" },
      devDependencies: { typescript: "^7.0.2", vitest: "^4.1.11" },
    });
    assert.deepEqual(drift, ["three: documented 0.184.x, installed ^0.185.1"]);
  });

  test("flags a documented package the manifest no longer installs", () => {
    const drift = versionDrift(table, {
      dependencies: {},
      devDependencies: { typescript: "^7.0.2" },
    });
    assert.ok(drift.some((line) => line.startsWith("three: documented")));
    assert.ok(drift.some((line) => line.startsWith("Vitest: documented")));
  });
});

describe("this repository", () => {
  test("cites only paths that exist and documents the installed versions", () => {
    assert.deepEqual(allDrift(), []);
  });
});
