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
  .readFileSync(new URL("./StageScenes.tsx", import.meta.url), "utf8");

describe("StageScenes lighting reservations", () => {
  it("memoises side-specific fixture light ids for the loaded project", () => {
    expect(source).toMatch(
      /useMemo\([\s\S]*buildLightingTracks\([\s\S]*buildCompareBLightingTracks\([\s\S]*afterTracks\.owned\[index\][\s\S]*\[project\]/,
    );
    expect(source).toContain("animatedFixtureLightIds={animatedFixtureLightSets?.a[i]}");
    expect(source).toContain("animatedFixtureLightIds={animatedFixtureLightSets?.b[i]}");
  });
});
