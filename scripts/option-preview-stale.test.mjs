import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commitOptionPreviews, staleOptionPreviews } from "./option-preview-stale.mjs";

const roots = [];

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, value);
}

const engine = (version) =>
  `export const OPTION_CLIP_FPS = 20;\nexport const OPTION_PREVIEW_WIDTH = 320;\nexport const OPTION_PREVIEW_VERSION = ${version};\n`;

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "option-preview-stale-"));
  roots.push(root);
  write(root, "src/engine/optionPreviews.ts", engine(1));
  write(
    root,
    "fixtures/preview-lab-bg-test/project.json",
    JSON.stringify({
      scenes: [
        { file: "scenes/bg-test.tsx", durationMs: 2000 },
        { file: "scenes/bgp-test-p1.tsx", durationMs: 1000 },
      ],
    }),
  );
  write(root, "fixtures/preview-lab-bg-test/scenes/bg-test.tsx", "export default 1;\n");
  write(root, "fixtures/preview-lab-bg-test/scenes/bgp-test-p1.tsx", "export default 1;\n");
  write(root, "src/assets/option-previews/bg-test.mp4", "mp4");
  write(root, "src/assets/option-previews/bg-test-poster.jpg", "jpeg");
  write(root, "src/assets/option-previews/bgp-test-p1.jpg", "jpeg");
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("option preview staleness", () => {
  test("invalidates only the set whose fixture changed", () => {
    const root = fixtureRoot();
    assert.deepEqual(staleOptionPreviews(root), ["bg-test", "bgp-test-p1"]);
    assert.equal(commitOptionPreviews(root, ["bg-test", "bgp-test-p1"]), 2);
    assert.deepEqual(staleOptionPreviews(root), []);

    write(root, "fixtures/preview-lab-bg-test/scenes/bgp-test-p1.tsx", "export default 2;\n");
    assert.deepEqual(staleOptionPreviews(root), ["bgp-test-p1"]);
  });

  test("re-records every set when the capture version bumps", () => {
    const root = fixtureRoot();
    commitOptionPreviews(root, ["bg-test", "bgp-test-p1"]);
    write(root, "src/engine/optionPreviews.ts", engine(2));
    assert.deepEqual(staleOptionPreviews(root), ["bg-test", "bgp-test-p1"]);
  });

  test("refuses to hash without the capture version", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/engine/optionPreviews.ts",
      "export const OPTION_CLIP_FPS = 20;\nexport const OPTION_PREVIEW_WIDTH = 320;\n",
    );
    assert.throws(() => staleOptionPreviews(root), /capture constants not found/);
  });

  test("drops manifest entries whose fixture is gone", () => {
    const root = fixtureRoot();
    write(root, "src/assets/option-previews/manifest.json", '{"bg-removed":"x"}\n');
    commitOptionPreviews(root, ["bg-test"]);
    const manifest = JSON.parse(
      readFileSync(join(root, "src/assets/option-previews/manifest.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest), ["bg-test"]);
  });

  test("reads the real capture constants", () => {
    assert.ok(Array.isArray(staleOptionPreviews()));
  });
});
