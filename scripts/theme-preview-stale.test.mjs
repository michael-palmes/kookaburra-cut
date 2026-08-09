import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  cleanupThemePreviews,
  commitThemePreviews,
  invalidateThemePreviews,
  staleThemePreviews,
} from "./theme-preview-stale.mjs";

const roots = [];

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, value);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "theme-preview-stale-"));
  roots.push(root);
  write(
    root,
    "src/engine/themePreviews.ts",
    'export const THEME_PREVIEW_WIDTH = 640;\nexport const THEME_PREVIEW_COUNT = 4;\nexport const THEME_PREVIEW_VERSION = 1;\nexport const THEME_PREVIEW_PROJECT_ID = "preview-lab-theme";\nexport const THEME_PREVIEW_SCENES = [0, 1, 2, 4] as const;\n',
  );
  write(
    root,
    "src/theme/registry.ts",
    'export const THEME_LINEUP: readonly string[] = ["theme-a", "theme-b"];\n',
  );
  write(root, "src/theme/builtin/theme-a.json", '{"id":"theme-a"}\n');
  write(root, "src/theme/builtin/theme-b.json", '{"id":"theme-b"}\n');
  write(root, "projects/preview-lab-theme/project.json", '{"id":"preview-lab-theme"}\n');
  write(root, "projects/preview-lab-theme/scenes/01.tsx", "export default 1;\n");
  write(root, "src/assets/fonts/Test-Regular.woff", "font");
  write(root, "src/assets/backdrops/test.png", "backdrop");
  for (const theme of ["theme-a", "theme-b"]) {
    for (let index = 1; index <= 4; index++) {
      write(root, `src/assets/theme-previews/${theme}-${index}.jpg`, "jpeg");
    }
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("theme preview staleness", () => {
  test("invalidates only a changed theme and every theme for a fixture change", () => {
    const root = fixtureRoot();
    commitThemePreviews(root, ["theme-a", "theme-b"]);
    assert.deepEqual(staleThemePreviews(root), []);

    write(root, "src/theme/builtin/theme-b.json", '{"id":"theme-b","changed":true}\n');
    assert.deepEqual(staleThemePreviews(root), ["theme-b"]);

    write(root, "projects/preview-lab-theme/scenes/01.tsx", "export default 2;\n");
    assert.deepEqual(staleThemePreviews(root), ["theme-a", "theme-b"]);

    write(root, "projects/preview-lab-theme/scenes/01.tsx", "export default 1;\n");
    write(
      root,
      "src/engine/themePreviews.ts",
      'export const THEME_PREVIEW_WIDTH = 720;\nexport const THEME_PREVIEW_COUNT = 4;\nexport const THEME_PREVIEW_VERSION = 2;\nexport const THEME_PREVIEW_PROJECT_ID = "preview-lab-theme";\nexport const THEME_PREVIEW_SCENES = [0, 1, 2, 4] as const;\n',
    );
    assert.deepEqual(staleThemePreviews(root), ["theme-a", "theme-b"]);
  });

  test("records the capture contract and removes orphan JPEGs on promotion", () => {
    const root = fixtureRoot();
    write(root, "src/assets/theme-previews/removed-theme-1.jpg", "orphan");
    const result = commitThemePreviews(root, ["theme-a", "theme-b"]);
    const manifest = JSON.parse(
      readFileSync(join(root, "src/assets/theme-previews/manifest.json"), "utf8"),
    );

    assert.deepEqual(manifest.capture, {
      version: 1,
      project: "preview-lab-theme",
      scenes: [0, 1, 2, 4],
      count: 4,
      width: 640,
    });
    assert.deepEqual(Object.keys(manifest.themes), ["theme-a", "theme-b"]);
    assert.deepEqual(result, { committed: 2, removed: 1 });
  });

  test("cleans an orphan-only theme without making current themes stale", () => {
    const root = fixtureRoot();
    commitThemePreviews(root, ["theme-a", "theme-b"]);
    write(
      root,
      "src/theme/registry.ts",
      'export const THEME_LINEUP: readonly string[] = ["theme-a"];\n',
    );

    assert.deepEqual(staleThemePreviews(root), []);
    assert.deepEqual(cleanupThemePreviews(root), { removed: 4, removedEntries: 1 });
    assert.equal(existsSync(join(root, "src/assets/theme-previews/theme-b-1.jpg")), false);
    const manifest = JSON.parse(
      readFileSync(join(root, "src/assets/theme-previews/manifest.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest.themes), ["theme-a"]);
  });

  test("keeps a forced refresh stale throughout partial promotion", () => {
    const root = fixtureRoot();
    commitThemePreviews(root, ["theme-a", "theme-b"]);

    assert.deepEqual(invalidateThemePreviews(root, ["theme-a"]), {
      invalidated: 1,
      removed: 0,
    });
    write(root, "src/assets/theme-previews/theme-a-1.jpg", "new jpeg");
    assert.deepEqual(staleThemePreviews(root), ["theme-a"]);
    assert.equal(
      readFileSync(join(root, "src/assets/theme-previews/theme-a-2.jpg"), "utf8"),
      "jpeg",
    );
  });

  test("invalidates previews when bundled font or backdrop bytes change", () => {
    const root = fixtureRoot();
    commitThemePreviews(root, ["theme-a", "theme-b"]);

    write(root, "src/assets/fonts/Test-Regular.woff", "changed font");
    assert.deepEqual(staleThemePreviews(root), ["theme-a", "theme-b"]);
    commitThemePreviews(root, ["theme-a", "theme-b"]);

    write(root, "src/assets/backdrops/test.png", "changed backdrop");
    assert.deepEqual(staleThemePreviews(root), ["theme-a", "theme-b"]);
  });

  test("fingerprints an explicit preview project override", () => {
    const root = fixtureRoot();
    commitThemePreviews(root, ["theme-a", "theme-b"]);
    write(root, "projects/alternate/project.json", '{"id":"alternate"}\n');

    assert.deepEqual(staleThemePreviews(root, { project: "alternate" }), ["theme-a", "theme-b"]);
  });
});
