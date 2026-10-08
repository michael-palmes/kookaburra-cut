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

describe("background drill header actions and bands", () => {
  const from = sceneTabSource.indexOf('if (drillIn === "style.background" && doc) {');
  const background = sceneTabSource.slice(
    from,
    sceneTabSource.indexOf('if (drillIn === "motion.transition"', from),
  );
  const scene3dBand = background.slice(
    background.indexOf('bgTab === "scene3d" ? ('),
    background.indexOf(') : bgTab === "shader" ? ('),
  );

  it("moves Reset and Apply to all slides into the header", () => {
    expect(background).toContain('kind="reset"');
    expect(background).toContain('kind="apply-all"');
    expect(background).toContain("onDisarm={() => setConfirmApplyAll(false)}");
    expect(sceneTabSource).toContain("window.setTimeout(() => setConfirmApplyAll(false), 4000)");
    expect(background).not.toContain('label="Apply everywhere"');
    expect(background).not.toContain("Reset {selectedShaderPreset.name}");
  });

  it("swaps the fill-type tiles for the icon strip", () => {
    expect(background).toContain("<BgTypeStrip");
    expect(background).toContain('ariaLabel="Background fill type"');
    expect(background).not.toContain("bg-type-grid");
  });

  it("keeps the Options sheet in session-only ui state, shared by 3D and Animated", () => {
    expect(sceneTabSource).toContain("const open = useUiStore((s) => s.bgOptionsSheetOpen);");
    expect(background.match(/<BackgroundOptionsSheet\b/g)).toHaveLength(2);
    expect(background).not.toContain("bgOptionsSheetOpen");
    expect(background).not.toContain("localStorage");
  });

  it("omits Drift from the 3D sheet", () => {
    expect(scene3dBand).toContain("stagingToggle(true)");
    expect(scene3dBand).not.toContain("driftToggle(");
  });

  it("keeps the stored fill's toggles reachable before a look is applied", () => {
    expect(background).toContain("{!(scene3dSpec && scene3dDef) && browseFooter}");
    expect(background).toContain("{!(shaderSpec && shaderDef) && browseFooter}");
  });

  it("selects a preset only while the scene still carries its values", () => {
    expect(background).toContain("selected={appliedScene3dPreset?.id === preset.id}");
    expect(background).toContain("selected={appliedShaderPreset?.id === preset.id}");
  });

  it("never writes the backing from arrow keys alone", () => {
    expect(scene3dBand).toMatch(/ariaLabel="Backing type"\s+focusOnlyKeys/);
  });

  it("gives each banded body its own scroll state and disarms Apply-all on leaving the drill", () => {
    expect(background).toMatch(/key="scene3d"\s+id=\{bgPanelId\}\s+role="tabpanel"/);
    expect(background).toMatch(/key="shader"\s+id=\{bgPanelId\}\s+role="tabpanel"/);
    expect(background).toContain("controls={bgPanelId}");
    expect(sceneTabSource).toContain(
      "useEffect(() => setConfirmApplyAll(false), [sceneIndex, drillIn]);",
    );
  });
});
