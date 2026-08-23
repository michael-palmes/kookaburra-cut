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

function readSource(path: string): string {
  return testProcess.getBuiltinModule("fs").readFileSync(new URL(path, import.meta.url), "utf8");
}

const deviceSource = readSource("./DeviceDrillIn.tsx");
const mediaSource = readSource("./MediaDrillIn.tsx");
const textSource = readSource("./ManagedTextDrill.tsx");
const chartSource = readSource("./ChartSection.tsx");
const sceneTabSource = readSource("./SceneTab.tsx");
const screenshotStackSource = readSource("../LayeredScreenshotBuilder.tsx");

describe("content inspector header actions", () => {
  it("puts duplicate and trash icons in every repeatable content header", () => {
    expect(deviceSource).toContain('label="Duplicate device"');
    expect(deviceSource).toContain('label="Remove device"');
    expect(mediaSource).toContain('label="Duplicate media"');
    expect(mediaSource).toContain('label="Remove media"');
    expect(textSource).toContain('label="Duplicate text group"');
    expect(textSource).toContain('label="Remove text group"');
    expect(sceneTabSource).toContain('label="Duplicate object"');
    expect(sceneTabSource).toContain('label="Remove object"');
  });

  it("puts trash icons in singleton content headers without inventing duplication", () => {
    expect(chartSource).toContain('label="Remove chart"');
    expect(sceneTabSource).toContain('label="Remove comparison"');
    expect(screenshotStackSource).toContain('label="Remove screenshot stack"');
  });

  it("removes the old fixed and in-body content action rows", () => {
    expect(deviceSource).not.toContain("device-editor-actions");
    expect(mediaSource).not.toContain('<div className="inspector-drill-actions">');
    expect(textSource).not.toContain("text-inspector-footer");
    expect(chartSource).not.toContain('label={confirmRemove ? "Really remove?" : "Remove chart"}');
    expect(sceneTabSource).not.toContain(
      'label={confirmRemoveCompare ? "Really remove?" : "Remove comparison"}',
    );
  });

  it("deletes on one click, with no armed confirmation step", () => {
    for (const source of [
      deviceSource,
      mediaSource,
      textSource,
      chartSource,
      sceneTabSource,
      screenshotStackSource,
    ]) {
      expect(source).not.toContain("Confirm remove");
      expect(source).not.toContain("armed={");
    }
  });
});
