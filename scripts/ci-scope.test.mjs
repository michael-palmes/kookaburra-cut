import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ci-scope.sh");

function scope(event, ...files) {
  const out = execFileSync("bash", [SCRIPT, event, ...files], { encoding: "utf8" });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

describe("ci-scope", () => {
  test("pushes run every job", () => {
    assert.deepEqual(scope("push"), { rust: "true", kit: "true" });
  });

  test("a UI-only pull request skips the rust job and the kb suite", () => {
    assert.deepEqual(scope("pull_request", "src/ui/Inspector.tsx", "docs/design.md"), {
      rust: "false",
      kit: "false",
    });
  });

  test("the crate and the folders it reads run the rust job", () => {
    for (const path of [
      "src-tauri/src/lib.rs",
      "src/theme/builtin/night.json",
      "presets/a/preset.json",
      "pnpm-lock.yaml",
    ]) {
      assert.equal(scope("pull_request", path).rust, "true", path);
    }
  });

  test("kit and sample projects run both", () => {
    assert.deepEqual(
      scope("pull_request", ".agents/skills/kookaburra-scene-authoring/scripts/kblib/cli.py"),
      {
        rust: "true",
        kit: "true",
      },
    );
    assert.deepEqual(scope("pull_request", "src-tauri/templates/project-kb.sh"), {
      rust: "true",
      kit: "true",
    });
  });

  // An early match on a long list once read as no match: grep -q exited and the pipe's writer died.
  test("an early match in a long diff still counts", () => {
    const ui = Array.from({ length: 20000 }, (_, i) => `src/ui/f${i}.tsx`);
    assert.equal(scope("pull_request", "src-tauri/src/lib.rs", ...ui).rust, "true");
  });
});
