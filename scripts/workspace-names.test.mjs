import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DENYLIST, findHits, readDenylist, workspaceNames } from "./workspace-names.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const patterns = readDenylist(readFileSync(join(ROOT, DENYLIST), "utf8"));
const line = (text) => ({ path: "docs/x.md", line: 1, text });

describe("workspace names", () => {
  test("keeps project-like folders and drops the generic, the bundled and the spikes", () => {
    const ws = mkdtempSync(join(tmpdir(), "kc-ws-"));
    for (const n of [
      "_autorun",
      "brands",
      "test",
      "launch-2026",
      "camera-spike",
      "blank",
      "acme-launch-3",
      "2026-01-02-new-project",
    ])
      mkdirSync(join(ws, n));
    const names = workspaceNames(ws, {
      bundled: new Set(["blank"]),
      fixtureText: "pnpm kookaburra:run --project ws:launch-2026",
    });
    assert.deepEqual(names, ["2026-01-02-new-project", "acme-launch-3"]);
    assert.equal(workspaceNames(join(ws, "missing")), null);
    rmSync(ws, { recursive: true, force: true });
  });

  test("matches a name as a whole word only", () => {
    const names = ["acme-launch-3"];
    assert.equal(findHits([line("see ws:acme-launch-3 today")], names, []).length, 1);
    assert.equal(findHits([line("acme-launch-30 is another")], names, []).length, 0);
    assert.equal(findHits([line("ACME-LAUNCH-3")], names, []).length, 1);
  });

  test("the denylist catches past leak shapes and lets placeholders through", () => {
    const hit = (t) => findHits([line(t)], [], patterns).length > 0;
    assert.ok(hit("/Users/someone/Kookaburra Cut/demo"));
    assert.ok(hit("~/Kookaburra Cut/acme-launch-3/scenes"));
    assert.ok(hit("open 2026-03-04-boardroom-cut first"));
    assert.ok(!hit("/Users/x/Kookaburra Cut"));
    assert.ok(!hit("~/Kookaburra Cut/brands/<slug>/brand.json"));
    assert.ok(!hit("~/Kookaburra Cut/_autorun/last-run.json"));
    assert.ok(!hit("~/Kookaburra Cut/<slug>/project.json"));
    assert.ok(!hit("ws:launch-2026 on 2026-10-28"));
    assert.ok(!hit("~/Kookaburra Cut/product-tour/assets"));
  });
});
