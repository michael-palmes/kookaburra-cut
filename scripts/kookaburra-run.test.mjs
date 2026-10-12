import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "kookaburra-run.sh");

function run(...args) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

describe("kookaburra-run --cold", () => {
  for (const action of ["perf", "theme-previews", "option-previews", "render-spike"]) {
    test(`refuses ${action}, which needs preview frames`, () => {
      const result = run("--action", action, "--cold");
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--cold only applies to verify, export, screenshot/);
    });
  }
});
