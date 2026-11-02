import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const tagPaths = /tag_paths=\(([^)]*)\)/
  .exec(read(".github/workflows/signers.yml"))[1]
  .trim()
  .split(/\s+/);
const covered = (p) => tagPaths.some((t) => p === t || p.startsWith(`${t}/`));

/** Every repository script the release workflow reaches, following scripts that name other scripts. */
function pipelineScripts() {
  const seen = new Set();
  const queue = [".github/workflows/release.yml", "scripts/release.sh"];
  while (queue.length) {
    for (const [p] of read(queue.pop()).matchAll(/scripts\/[A-Za-z0-9._/-]+\.(?:sh|mjs|py)/g)) {
      if (seen.has(p) || !existsSync(join(ROOT, p))) continue;
      seen.add(p);
      queue.push(p);
    }
  }
  return [...seen];
}

describe("the tag-key path list", () => {
  test("covers every script the release pipeline runs", () => {
    const scripts = pipelineScripts();
    assert.ok(scripts.includes("scripts/sign-and-notarize.sh"));
    assert.deepEqual(
      scripts.filter((p) => !covered(p)),
      [],
    );
  });

  test("names only what exists, or a pin file the repo may add", () => {
    const mayAdd = new Set([
      ".npmrc",
      "rust-toolchain",
      "src-tauri/.cargo",
      "src-tauri/rust-toolchain",
      "src-tauri/rust-toolchain.toml",
    ]);
    assert.deepEqual(
      tagPaths.filter((p) => !mayAdd.has(p) && !existsSync(join(ROOT, p))),
      [],
    );
  });
});
