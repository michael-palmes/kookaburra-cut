import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const shim = readFileSync("scripts/tauri-path/actool", "utf8");

function underClosedStdin(path) {
  return execFileSync("sh", ["-c", `"${path}" <&-`], { encoding: "utf8" }).trim();
}

test("the actool shim gives actool an open stdin when its parent left it closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "tauri-path-"));
  try {
    const stub = join(dir, "stub");
    writeFileSync(stub, "#!/bin/sh\n[ -e /dev/fd/0 ] && echo open || echo closed\n");
    chmodSync(stub, 0o755);
    const copy = join(dir, "actool");
    assert.ok(shim.includes("/usr/bin/actool"));
    writeFileSync(copy, shim.replace("/usr/bin/actool", stub));
    chmodSync(copy, 0o755);
    assert.equal(underClosedStdin(stub), "closed");
    assert.equal(underClosedStdin(copy), "open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every bundling route runs the CLI behind the shim", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(scripts.tauri, /scripts\/tauri-path:\$PATH/);
  assert.doesNotMatch(readFileSync("scripts/acceptance-app.mjs", "utf8"), /"exec",\s*"tauri"/);
  assert.match(readFileSync("scripts/sign-and-notarize.sh", "utf8"), /TAURI_CLI:-pnpm tauri/);
  assert.match(readFileSync(".github/workflows/release.yml", "utf8"), /run: pnpm tauri build/);
});
