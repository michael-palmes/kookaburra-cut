import { describe, expect, it } from "vitest";
import { stageRegionLabel } from "./stageRegion";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const read = (path: string) =>
  testProcess.getBuiltinModule("fs").readFileSync(new URL(path, import.meta.url), "utf8");

describe("the stage landmark (1.1.1, 1.3.1)", () => {
  it("names the scene on screen and the time in whole seconds", () => {
    const scene = { title: "Highlights", index: 1, count: 4 };
    expect(stageRegionLabel(scene, 64_900)).toBe("Preview: Highlights, scene 2 of 4, at 1:04");
    expect(stageRegionLabel(scene, 4_100)).toBe(stageRegionLabel(scene, 4_900));
    expect(stageRegionLabel(null, 0)).toBe("Preview");
  });

  it("is the editor's one main landmark", () => {
    const app = read("../App.tsx");
    expect(app).toContain('<main className="stage" aria-label={stageLabel}>');
    expect(app.match(/<main\b/g)).toHaveLength(1);
  });

  it("points the content picker's Add button at the picker only while it is open", () => {
    expect(read("./inspector/SceneOverview.tsx")).toContain(
      "aria-controls={expanded === false ? undefined : controls}",
    );
  });
});
