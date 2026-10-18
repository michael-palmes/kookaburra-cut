import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acceptanceBuildEnvironment,
  assertCheckoutMatches,
  assertSafeTarget,
  bundledModelsPinned,
  createAcceptanceIdentity,
  PRODUCTION_APP_PATH,
  PRODUCTION_BUNDLE_IDENTIFIER,
  PRODUCTION_PRODUCT_NAME,
  provisionModels,
} from "./acceptance-app.mjs";

test("development authoring is explicit and recorded separately from normal acceptance", () => {
  assert.equal(acceptanceBuildEnvironment({}, false).NODE_ENV, "production");
  assert.deepEqual(acceptanceBuildEnvironment({ CARGO_TARGET_DIR: "/target" }, true), {
    CARGO_TARGET_DIR: "/target",
    NODE_ENV: "development",
  });
});

describe("acceptance app identity", () => {
  test("is stable per worktree and unique between worktrees", () => {
    const first = createAcceptanceIdentity("/private/tmp/worktree-a");
    const same = createAcceptanceIdentity("/private/tmp/worktree-a");
    const other = createAcceptanceIdentity("/private/tmp/worktree-b");

    assert.deepEqual(first, same);
    assert.notEqual(first.productName, other.productName);
    assert.notEqual(first.bundleIdentifier, other.bundleIdentifier);
  });
});

describe("acceptance app target safety", () => {
  const safe = {
    productName: "Kookaburra Cut Acceptance abc12345",
    bundleIdentifier: "com.mpalmes.kookaburracut.acceptance.abc12345",
    bundlePath: "/tmp/Kookaburra Cut Acceptance abc12345.app",
  };

  test("rejects every production target", () => {
    assert.throws(() => assertSafeTarget({ ...safe, productName: PRODUCTION_PRODUCT_NAME }));
    assert.throws(() =>
      assertSafeTarget({ ...safe, bundleIdentifier: PRODUCTION_BUNDLE_IDENTIFIER }),
    );
    assert.throws(() => assertSafeTarget({ ...safe, bundlePath: PRODUCTION_APP_PATH }));
  });

  test("accepts a unique absolute app target", () => {
    assert.doesNotThrow(() => assertSafeTarget(safe));
  });
});

describe("acceptance app checkout safety", () => {
  const expected = { worktree: "/tmp/wt", branch: "feat/native", head: "abc" };

  test("rejects worktree, branch and HEAD mismatches", () => {
    for (const [key, value] of [
      ["worktree", "/tmp/other"],
      ["branch", "main"],
      ["head", "def"],
    ]) {
      assert.throws(() => assertCheckoutMatches(expected, { ...expected, [key]: value }));
    }
    assert.doesNotThrow(() => assertCheckoutMatches(expected, { ...expected }));
  });
});

describe("acceptance app beat-this model", () => {
  /** A fake runner: `--check DIR` passes for the folders in `pinned`; `--from` makes the worktree's folder pinned. */
  function fakeRun(pinned) {
    const calls = [];
    const run = (_cmd, args) => {
      calls.push(args.slice(1));
      if (args[1] === "--from") pinned.add("/wt/src-tauri/resources/models");
      if (args[1] === "--check" && !pinned.has(args[2])) throw new Error("mismatch");
    };
    return { run, calls };
  }

  test("uses the worktree's own pinned copy", () => {
    const { run, calls } = fakeRun(new Set(["/wt/src-tauri/resources/models"]));
    assert.equal(provisionModels("/wt", "/main", run), "/wt/src-tauri/resources/models");
    assert.equal(calls.length, 1);
  });

  test("copies the main checkout's pinned copy, never downloading", () => {
    const { run, calls } = fakeRun(new Set(["/main/src-tauri/resources/models"]));
    assert.equal(provisionModels("/wt", "/main", run), "/wt/src-tauri/resources/models");
    assert.deepEqual(calls[2], ["--from", "/main/src-tauri/resources/models"]);
  });

  test("refuses to build without a pinned model anywhere", () => {
    const { run } = fakeRun(new Set());
    assert.throws(() => provisionModels("/wt", "/main", run), /pnpm setup:models/);
  });

  test("checks the bundle's Resources/models", () => {
    const { run, calls } = fakeRun(new Set(["/b/X.app/Contents/Resources/models"]));
    assert.equal(bundledModelsPinned("/wt", "/b/X.app", run), true);
    assert.deepEqual(calls[0], ["--check", "/b/X.app/Contents/Resources/models"]);
    assert.equal(bundledModelsPinned("/wt", "/b/Y.app", run), false);
  });
});
