import { describe, expect, it } from "vitest";
import { EASE_NAMES } from "../../engine/ease";

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

const start = source.indexOf('if (drillIn === "compare.edit"');
const end = source.indexOf('<DrillGroup label="Divider line">', start);
if (start < 0 || end < 0) throw new Error("compare.edit drill section not found in SceneTab");
const drill = source.slice(start, end);

describe("comparison animation drill (source pin)", () => {
  it("seats the Animation group above the motion presets", () => {
    const animation = drill.indexOf('<DrillGroup\n            label="Animation"');
    const presets = drill.indexOf('<DrillGroup label="Motion presets"');
    expect(animation).toBeGreaterThan(-1);
    expect(presets).toBeGreaterThan(animation);
  });

  it("picks the ease from the shared catalogue, never a hand-typed subset", () => {
    expect(drill).toContain("{EASE_NAMES.map((name) => (");
    for (const name of ["inOutQuad", "outBack", "jump"]) expect(EASE_NAMES).toContain(name);
    expect(drill).not.toMatch(/<option value="inOut/);
  });

  it("replaces the whole track in one history entry per field commit", () => {
    expect(drill).toContain("const track = buildCompareAnimationTrack({ ...anim, ...patch }");
    expect(drill).toContain('{ history: "divider animation" }');
    expect(drill.match(/writeAnimation\(/g)?.length).toBeGreaterThan(5);
  });

  it("shows the angle fields only for masks that carry an angle", () => {
    const angleRow = drill.indexOf('label="Angle from"');
    const gate = drill.lastIndexOf("{maskEntry?.needsAngle && (", angleRow);
    expect(angleRow).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
  });

  it("keeps the static divider row, its keys note and the Manual chip", () => {
    expect(drill).toContain("{hasKeys ? (");
    expect(drill).toContain("Keys drive the divider; edit them in the timeline lane below");
    expect(drill).toContain("const clearKeys = () => {");
    expect(drill).toContain("patchDoc(clearCompareTrack,");
  });
});
