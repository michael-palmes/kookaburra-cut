import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isFileLoadingAllowed, resolveConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("the dev server serves the checkout and nothing else from the home folder", async () => {
  const config = await resolveConfig(
    { configFile: join(repo, "vite.config.ts"), logLevel: "silent" },
    "serve",
  );
  const bundled = readdirSync(join(repo, "projects")).find((name) => !name.includes("."));
  for (const rel of [
    `projects/${bundled}/project.json`,
    "presets",
    "fixtures",
    "src/toolkit/index.ts",
    "node_modules/three/package.json",
  ]) {
    assert.ok(isFileLoadingAllowed(config, join(repo, rel)), rel);
  }
  for (const rel of [
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".config/gh/hosts.yml",
    "Kookaburra Cut/product-tour/project.json",
    "Library/Application Support/Claude/config.json",
  ]) {
    assert.ok(!isFileLoadingAllowed(config, join(homedir(), rel)), rel);
  }
});
