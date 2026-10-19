#!/usr/bin/env node
// Every repo file the export path loads, from a write-free vite build of the canvas children and harness.
//
//   node scripts/render-closure.mjs   # prints the closure, one repo-relative path per line
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RENDER_ENTRIES = [
  "src/engine/autorun.ts",
  "src/engine/exportBridge.tsx",
  "src/engine/CompositorDriver.tsx",
  "src/engine/StageScenes.tsx",
  "src/engine/StagePointer.tsx",
  "src/engine/RenderSettingsApplier.tsx",
  "src/engine/project.ts",
  "src/toolkit/index.ts",
];

export async function renderClosure() {
  const { build, loadConfigFromFile } = await import("vite");
  // Development mode, as autorun runs: import.meta.env.DEV branches (fixture globs, dev-only paths) stay in.
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "development" },
    join(ROOT, "vite.config.ts"),
    ROOT,
    "silent",
  );
  const config = loaded.config;
  // Replaced, not merged: the app's own HTML entries would pull in every window's chrome.
  config.build = {
    ...config.build,
    write: false,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      ...config.build?.rollupOptions,
      input: Object.fromEntries(RENDER_ENTRIES.map((e, i) => [`e${i}`, join(ROOT, e)])),
      onwarn: () => {},
    },
  };
  // vite build writes NODE_ENV process-wide; vitest and the dev app spawned later must not inherit it.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  let out;
  try {
    out = await build({
      ...config,
      mode: "development",
      root: ROOT,
      configFile: false,
      logLevel: "silent",
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  const files = new Set();
  for (const output of Array.isArray(out) ? out : [out]) {
    for (const chunk of output.output) {
      if (chunk.type !== "chunk") continue;
      for (const id of chunk.moduleIds) {
        const path = id.replace(/^\0/, "").split("?")[0];
        if (!path.startsWith(ROOT) || path.includes("/node_modules/")) continue;
        files.add(relative(ROOT, path));
      }
    }
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = await renderClosure();
  process.stdout.write(`${[...files].sort().join("\n")}\n`);
}
