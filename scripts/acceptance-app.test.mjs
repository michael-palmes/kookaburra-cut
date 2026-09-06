import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acceptanceBuildEnvironment,
  assertCheckoutMatches,
  assertSafeTarget,
  createAcceptanceIdentity,
  PRODUCTION_APP_PATH,
  PRODUCTION_BUNDLE_IDENTIFIER,
  PRODUCTION_PRODUCT_NAME,
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
