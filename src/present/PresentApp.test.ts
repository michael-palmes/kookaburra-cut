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
  .readFileSync(new URL("./PresentApp.tsx", import.meta.url), "utf8");

describe("Present lighting scope", () => {
  it("provides project-only lighting to every scene host", () => {
    const scopeStart = source.indexOf(
      "<ProjectLightingContext.Provider value={project.projectLighting ?? null}>",
    );
    const sceneHost = source.indexOf("<SceneHost", scopeStart);
    const scopeEnd = source.indexOf("</ProjectLightingContext.Provider>", sceneHost);

    expect(scopeStart).toBeGreaterThan(-1);
    expect(sceneHost).toBeGreaterThan(scopeStart);
    expect(scopeEnd).toBeGreaterThan(sceneHost);
  });

  it("reserves zero-base paired lights from the active A-side track", () => {
    expect(source).toMatch(
      /useMemo\([\s\S]*buildLightingTracks\([\s\S]*\.map\(\s*animatedFixtureLightIds,?\s*\)[\s\S]*\[project\]/,
    );
    expect(source).toContain("animatedFixtureLightIds={animatedFixtureLightSets[i]}");
  });
});
