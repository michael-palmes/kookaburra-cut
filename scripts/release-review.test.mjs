import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release.sh before it signs", () => {
  let dir;
  let clone;
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), text);
  };
  const commit = (subject) => {
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  const release = (input) =>
    spawnSync("bash", ["scripts/release.sh"], { cwd: clone, encoding: "utf8", input });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kookaburra-release-"));
    clone = join(dir, "clone");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "origin.git")]);
    spawnSync("git", ["clone", "-q", join(dir, "origin.git"), clone], { encoding: "utf8" });
    git("checkout", "-q", "-B", "main");
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["tag.gpgsign", "false"],
      ["gpg.format", "ssh"],
      ["kookaburra.tagkey", join(dir, "unused.pub")],
    ]) {
      git("config", key, value);
    }
    mkdirSync(join(clone, "scripts"));
    mkdirSync(join(clone, ".github/workflows"), { recursive: true });
    copyFileSync(join(ROOT, "scripts/release.sh"), join(clone, "scripts/release.sh"));
    copyFileSync(
      join(ROOT, ".github/workflows/signers.yml"),
      join(clone, ".github/workflows/signers.yml"),
    );
    write("README.md", "macOS 26.0+\n");
    write("pnpm-lock.yaml", "one\n");
    write("src/app.ts", "one\n");
    const conf = (version) =>
      JSON.stringify({ version, bundle: { macOS: { minimumSystemVersion: "26.0" } } });
    const security = (version) => `# Security\n\n**As of version ${version}.**\n`;
    write("src-tauri/tauri.conf.json", conf("0.1.0"));
    write("SECURITY.md", security("0.1.0"));
    commit("first release");
    git("tag", "-a", "v0.1.0", "-m", "first");
    write("pnpm-lock.yaml", "two\n");
    write("src/app.ts", "two\n");
    write("src-tauri/tauri.conf.json", conf("0.2.0"));
    write("SECURITY.md", security("0.2.0"));
    commit("second release");
    git("push", "-q", "origin", "main", "--tags");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("shows what changed since the previous tag and signs nothing on no", () => {
    const r = release("n\n");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not signed/);
    assert.match(r.stdout, /Commits since v0\.1\.0/);
    assert.match(r.stdout, /second release/);
    assert.doesNotMatch(r.stdout, /first release/);
    assert.match(r.stdout, /pnpm-lock\.yaml/);
    assert.match(r.stdout, /src-tauri\/tauri\.conf\.json/);
    assert.doesNotMatch(r.stdout, /src\/app\.ts/);
    assert.equal(git("tag", "--list", "v0.2.0"), "");
  });

  test("signs nothing when no one answers", () => {
    const r = release("");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not signed/);
    assert.equal(git("tag", "--list", "v0.2.0"), "");
  });
});
