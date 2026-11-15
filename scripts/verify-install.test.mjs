import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/verify-install.sh";
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const bash = (...args) => spawnSync("bash", args, { cwd: ROOT, encoding: "utf8" });

describe("verify-install.sh", () => {
  test("parses, and refuses to run without a version and a folder", () => {
    assert.equal(bash("-n", SCRIPT).status, 0);
    const r = bash(SCRIPT);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--version and --dir are required/);
    const help = bash(SCRIPT, "--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /gh release download v<version>/);
  });

  test("pins the Team ID SECURITY.md publishes", () => {
    const teamId = /^TEAM_ID=([A-Z0-9]{10})$/m.exec(read(SCRIPT))?.[1];
    assert.ok(teamId, "the script sets TEAM_ID");
    const published = [...read("SECURITY.md").matchAll(/TeamIdentifier=([A-Z0-9]+)/g)].map(
      (m) => m[1],
    );
    assert.ok(published.length > 0, "SECURITY.md names the Team ID");
    assert.deepEqual([...new Set(published)], [teamId]);
  });
});
