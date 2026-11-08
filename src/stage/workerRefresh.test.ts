import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import viteReact from "@vitejs/plugin-react";
import { describe, expect, it } from "vitest";
import { rewriteRefreshRuntime } from "../../vite.worker-refresh";

const require = createRequire(import.meta.url);
const runtimePath = join(dirname(require.resolve("@vitejs/plugin-react")), "refresh-runtime.js");

describe("workerSafeRefresh", () => {
  it("leaves the installed refresh runtime with no bare window reference", () => {
    const rewritten = rewriteRefreshRuntime(readFileSync(runtimePath, "utf8"));
    expect(rewritten).not.toMatch(/(^|[^.\w$])window\./);
    expect(rewritten).toContain("globalThis.__registerBeforePerformReactRefresh");
  });

  it("keeps a property named window", () => {
    expect(rewriteRefreshRuntime("hook.window.x = 1;\nwindow.y = 2;")).toBe(
      "hook.window.x = 1;\nglobalThis.y = 2;",
    );
  });
});

describe("stageWorker", () => {
  it("defines every refresh global the window preamble does", () => {
    const globals = [...viteReact.preambleCode.matchAll(/window\.(\$\w+\$) =/g)].map((m) => m[1]);
    expect(globals).toEqual(["$RefreshReg$", "$RefreshSig$"]);
    const worker = readFileSync(new URL("./stageWorker.ts", import.meta.url), "utf8");
    for (const name of globals) expect(worker).toContain(`scope.${name} ??=`);
  });
});
