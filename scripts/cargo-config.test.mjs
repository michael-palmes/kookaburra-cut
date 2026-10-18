import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("plain cargo pins the deployment target that tauri dev and build export", () => {
  const { minimumSystemVersion } = JSON.parse(read("src-tauri/tauri.conf.json")).bundle.macOS;
  const pinned = read(".cargo/config.toml").match(/^MACOSX_DEPLOYMENT_TARGET = "(.+)"$/m)?.[1];
  assert.equal(pinned, minimumSystemVersion);
});
