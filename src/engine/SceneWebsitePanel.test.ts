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
  .readFileSync(new URL("./SceneWebsitePanel.tsx", import.meta.url), "utf8");

describe("SceneWebsitePanel capture layering", () => {
  it("keeps the capture in the transparent render list above the page plane", () => {
    const captureImage = source.match(/function CaptureImage[\s\S]*?function WebsiteWindow/)?.[0];
    expect(captureImage).toContain(
      "new MeshBasicMaterial({ transparent: true, depthWrite: false, map: texture })",
    );
    expect(captureImage).not.toContain("transparent: false");
  });
});
