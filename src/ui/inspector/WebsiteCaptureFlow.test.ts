import { describe, expect, it } from "vitest";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const source = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("./SceneTab.tsx", import.meta.url), "utf8");

describe("Website capture flow", () => {
  it("refreshes the asset inventory before exposing a new capture", () => {
    const writeCapture = source.match(
      /const writeCapture = async[\s\S]*?const captureCurrentWebsite/,
    )?.[0];
    if (!writeCapture) throw new Error("Website capture flow not found");
    const refresh = writeCapture.indexOf("await refreshWorkspaceAssets(project.id)");
    const bump = writeCapture.indexOf("useAssetVersionStore.getState().bump");
    const patch = writeCapture.indexOf("await patchDoc");
    expect(refresh).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(refresh);
    expect(patch).toBeGreaterThan(bump);
  });
});
