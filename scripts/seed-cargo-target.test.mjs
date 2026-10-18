import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "seed-cargo-target.sh");
const THIRD_PARTY = [
  "debug/deps/libserde-1a.rlib",
  "debug/.fingerprint/serde-1a/lib-serde",
  "debug/build/ring-2b/out/libring.a",
  "release/deps/libserde-7a.rlib",
  "release/.fingerprint/serde-7a/lib-serde",
];
const APP = [
  "debug/deps/kookaburra_cut-3c",
  "debug/deps/libkookaburra_cut_lib.rlib",
  "debug/deps/kookaburra_cut_lib.x.y.rcgu.o",
  "debug/deps/edit_cli-4d",
  "debug/.fingerprint/kookaburra-cut-3c/bin-kookaburra-cut",
  "debug/build/kookaburra-cut-5e/out/tauri-build-context.rs",
  "release/deps/kookaburra_cut-8b",
  "release/.fingerprint/kookaburra-cut-8b/bin-kookaburra-cut",
];
const UPLIFTED = ["debug/kookaburra-cut", "debug/ffmpeg", "debug/projects/a/project.json"];
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function checkouts() {
  const root = mkdtempSync(join(tmpdir(), "seed-cargo-target-"));
  roots.push(root);
  const primary = join(root, "primary");
  mkdirSync(join(primary, "scripts"), { recursive: true });
  mkdirSync(join(primary, "src-tauri", "tests"), { recursive: true });
  cpSync(SCRIPT, join(primary, "scripts", "seed-cargo-target.sh"));
  writeFileSync(join(primary, "src-tauri", "tests", "edit_cli.rs"), "");
  git(primary, "init", "-q");
  git(primary, "add", ".");
  git(primary, "commit", "-qm", "init");
  const source = join(primary, "src-tauri", "target");
  for (const file of [...THIRD_PARTY, ...APP, ...UPLIFTED, "CACHEDIR.TAG", "debug/.cargo-lock"]) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), file);
  }
  const worktree = join(root, "worktree");
  git(primary, "worktree", "add", "-q", "--detach", worktree);
  const gitDir = join(primary, ".git", "worktrees", "worktree");
  return { primary, source, worktree, target: join(worktree, "src-tauri", "target"), gitDir };
}

function seed(checkout) {
  return spawnSync("bash", [join(checkout, "scripts", "seed-cargo-target.sh")], {
    encoding: "utf8",
  });
}

const stages = (gitDir) =>
  readdirSync(gitDir).filter((name) => name.startsWith("cargo-target-seed."));

describe("seed-cargo-target", { skip: process.platform !== "darwin" }, () => {
  test("clones only third-party artefacts of every profile into a new worktree", () => {
    const { worktree, target, gitDir } = checkouts();
    const result = seed(worktree);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cloned third-party artefacts \(debug release\)/);
    for (const file of [...THIRD_PARTY, "CACHEDIR.TAG"])
      assert.ok(existsSync(join(target, file)), file);
    for (const file of [...APP, ...UPLIFTED]) assert.ok(!existsSync(join(target, file)), file);
    assert.deepEqual(stages(gitDir), []);
  });

  test("leaves the primary and an existing target alone but sweeps stale stages", () => {
    const { primary, source, worktree, target, gitDir } = checkouts();
    mkdirSync(target);
    mkdirSync(join(gitDir, "cargo-target-seed.99999999", "debug"), { recursive: true });
    for (const checkout of [primary, worktree]) {
      const result = seed(checkout);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
    assert.deepEqual(readdirSync(target), []);
    assert.deepEqual(stages(gitDir), []);
    assert.ok(existsSync(join(source, APP[0])));
  });

  test("waits for a build holding the primary's lock", async () => {
    const { source, worktree, target } = checkouts();
    const holder = spawn("perl", [
      "-MFcntl=:flock",
      "-e",
      'open(my $f, "<", shift) or die; flock($f, LOCK_EX) or die; $| = 1; print "locked\\n"; sleep 2',
      join(source, "debug", ".cargo-lock"),
    ]);
    await once(holder.stdout, "data");
    const result = seed(worktree);
    await once(holder, "close");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /waiting for the primary checkout to finish building/);
    assert.ok(existsSync(join(target, THIRD_PARTY[0])));
  });

  test("never fails the install and leaves no partial target when seeding breaks", () => {
    const { source, worktree, target, gitDir } = checkouts();
    chmodSync(join(source, "CACHEDIR.TAG"), 0o000);
    const result = seed(worktree);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /seeding failed/);
    assert.ok(!existsSync(target));
    assert.deepEqual(stages(gitDir), []);
  });
});
