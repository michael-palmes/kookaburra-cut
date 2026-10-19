import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discoverModules, orderModules, parseSummary } from "./test-kit.mjs";

describe("test-kit", () => {
  test("finds every kb test module", () => {
    const modules = discoverModules();
    assert.ok(modules.includes("test_check"));
    assert.ok(modules.every((m) => /^test_\w+$/.test(m)));
  });

  test("runs the slowest recorded module first and ranks unknown ones by size", () => {
    const sizes = { test_a: 9000, test_b: 1000, test_c: 4000 };
    assert.deepEqual(
      orderModules(["test_a", "test_b", "test_c"], { test_b: 30 }, (m) => sizes[m]),
      ["test_b", "test_a", "test_c"],
    );
  });

  test("reads unittest's summary", () => {
    assert.deepEqual(parseSummary("...\nRan 12 tests in 1.2s\n\nOK (skipped=3)\n"), {
      ran: 12,
      skipped: 3,
      ok: true,
    });
    assert.deepEqual(parseSummary("Ran 1 test in 0.1s\n\nFAILED (failures=1)\n"), {
      ran: 1,
      skipped: 0,
      ok: false,
    });
  });
});
