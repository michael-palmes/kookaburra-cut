import { describe, expect, it } from "vitest";

/** Source pins for the per-inspector Before/After routing, which lives inside SceneTab and has no DOM test env: which surfaces carry the shared selector, that Before and After share ONE piece of state, and that the comparison drill points at those surfaces instead of carrying its own side fieldset. The routing itself is tested as pure functions in compareSideRouting.test.ts. */

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

const sceneTab = read("./SceneTab.tsx");
const lighting = read("./LightingInspectorSection.tsx");

const section = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Source section not found: ${start}`);
  return source.slice(from, to);
};

describe("comparison side surfaces (source pin)", () => {
  it("shows the selector in Device, Theme, Background and Lighting, and nowhere else", () => {
    expect(sceneTab.match(/<CompareSideSelector/g)).toHaveLength(3);
    expect(sceneTab).toContain("comparison={\n          hasComparison(doc)");
    expect(
      section(
        sceneTab,
        'if (drillIn === "style.theme" && doc) {',
        'if (drillIn === "frame.cutout"',
      ),
    ).toContain("<CompareSideSelector");
    expect(
      section(
        sceneTab,
        'if (drillIn === "style.background" && doc) {',
        'if (drillIn === "motion.transition"',
      ),
    ).toContain("<CompareSideSelector");
    expect(sceneTab).toContain("sideControls={");
    expect(lighting).toContain("{sideControls}");
  });

  it("drives all four from one shared side, gated on the scene having a comparison", () => {
    expect(sceneTab.match(/hasComparison\(doc\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sceneTab.match(/onChange=\{setCompareSide\}/g)).toHaveLength(2);
    expect(sceneTab).toContain("const compareSideActive = activeCompareSide(doc, compareSide);");
    expect(sceneTab).toContain("const bgTarget = compareEditTarget(doc, compareSide);");
    expect(sceneTab).toContain("const lightingTarget = bgTarget;");
    expect(sceneTab).not.toContain("setBgTarget(");
    expect(sceneTab).not.toContain("setLightingTarget(");
  });

  it("points the comparison drill at those surfaces instead of holding a side fieldset", () => {
    const drill = section(
      sceneTab,
      'if (drillIn === "compare.edit"',
      'if (drillIn === "legacyImage.edit"',
    );

    expect(drill).toContain(
      "Use the Before and After toggles in Device, Theme, Background and Lighting to edit each",
    );
    expect(drill).not.toContain("<ToggleFieldset");
    expect(drill).not.toContain('ariaLabel="Comparison side"');
    expect(drill).not.toContain("compareSide");
    expect(sceneTab).not.toContain('drillIn === "compare.device"');
    expect(sceneTab).not.toContain('drillIn === "compare.theme"');
  });

  it("routes the Device media actions at the selected side", () => {
    const device = section(
      sceneTab,
      'if (drillIn === "device" && doc && device && deviceId) {',
      "\n\n  if (drillIn === ",
    );

    expect(device).toContain('deviceRouting.mediaTarget === "compareDevice"');
    expect(device).toContain('openDrill("compare.media")');
    expect(device).toContain("target.editVideoTarget");
    expect(device).not.toContain("device.media?.kind");
  });
});
