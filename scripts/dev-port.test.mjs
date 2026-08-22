import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { overrideConfig, PORT_MAX, PORT_MIN, pickPort } from "./dev-port.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CLI = join(SCRIPTS, "dev-port.mjs");
const roots = [];

function fixtureConf(devCsp) {
  const root = mkdtempSync(join(tmpdir(), "dev-port-"));
  roots.push(root);
  const path = join(root, "tauri.conf.json");
  writeFileSync(
    path,
    JSON.stringify({
      build: { devUrl: "http://localhost:1420" },
      app: { security: { devCsp } },
    }),
  );
  return path;
}

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }).trim();
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("dev-port override", () => {
  test("replaces every 1420 in the dev CSP and moves the dev URL", () => {
    const conf = fixtureConf("connect-src ws://localhost:1420 http://localhost:1420 http://x:1420");
    const config = overrideConfig(1437, conf);

    assert.equal(config.build.devUrl, "http://localhost:1437");
    assert.equal(
      config.app.security.devCsp,
      "connect-src ws://localhost:1437 http://localhost:1437 http://x:1437",
    );
    assert.equal(config.app.security.devCsp.includes("1420"), false);
  });

  test("throws when the config carries no dev CSP", () => {
    const conf = fixtureConf(undefined);
    assert.throws(() => overrideConfig(1437, conf), /devCsp/);
  });

  test("prints one compact JSON line the repo config can be launched with", () => {
    const out = cli("override", "1437");

    assert.equal(out.includes("\n"), false);
    const config = JSON.parse(out);
    assert.equal(config.build.devUrl, "http://localhost:1437");
    assert.equal(typeof config.app.security.devCsp, "string");
    assert.equal(config.app.security.devCsp.includes("1420"), false);
    assert.equal(config.app.security.devCsp.includes("http://localhost:1437"), true);
  });
});

describe("dev-port pick", () => {
  test("returns a bindable port inside the agent range", async () => {
    const port = await pickPort();

    assert.equal(Number.isInteger(port), true);
    assert.equal(port >= PORT_MIN && port <= PORT_MAX, true);
  });

  test("prints an in-range integer and never the interactive ports", () => {
    const port = Number(cli("pick"));

    assert.equal(Number.isInteger(port), true);
    assert.equal(port >= PORT_MIN && port <= PORT_MAX, true);
    assert.equal(port === 1420 || port === 1421, false);
  });
});
