import { describe, expect, it } from "vitest";
import { COMPARE_GRIP_CATALOG } from "../../engine/compareCatalog";

/** Source pins for the comparison drill, which has no DOM test env: the fields that must stay unconditional, the writes that must go through the pure nearest-key helpers, and the pickers that must read their catalogue rather than a hand-typed list. */

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
const end = source.indexOf("if (drillIn === LEGACY_MEDIA_DRILL_ROUTE", start);
if (start < 0 || end < 0) throw new Error("compare.edit drill section not found in SceneTab");
const drill = source.slice(start, end);
const rows = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("./rows.tsx", import.meta.url), "utf8");

describe("comparison drill (source pin)", () => {
  it("shows the Divider slider whatever the track holds", () => {
    expect(drill).toContain('label="Divider position"');
    expect(drill).not.toContain("{hasKeys ? (");
    expect(drill).not.toContain("Keys drive the divider");
  });

  it("routes both fields through the nearest-key helpers, live then committed", () => {
    for (const write of ["setCompareDividerValue", "setCompareDividerAngle"]) {
      expect(drill).toContain(`cmpLive((c) => ${write}(c, ms, v))`);
      expect(drill).toContain(`cmpCommit((c) => ${write}(c, ms, v))`);
    }
    expect(drill).toContain("const ms = gestureMs();");
    expect(drill).toContain("const ms = releaseGestureMs();");
  });

  it("leaves the timeline lane as the only animation surface", () => {
    expect(drill).not.toContain('label="Animation"');
    expect(drill).not.toContain("writeAnimation");
    expect(drill).not.toContain('aria-label="Divider ease"');
    expect(drill).not.toContain("Animate the angle");
  });

  it("keeps Manual and the motion presets", () => {
    expect(drill).toContain('<DrillGroup label="Motion presets"');
    expect(drill).toContain("const clearKeys = () => {");
    expect(drill).toContain("patchDoc(clearCompareTrack,");
    expect(drill).toContain("COMPARE_PRESETS.map((p) => (");
  });

  it("builds the grip picker from the catalogue, under the grip toggle", () => {
    expect(drill).toContain("COMPARE_GRIP_CATALOG.map((e) => ({");
    expect(drill).toContain("{maskEntry?.hasGrip && grip && (");
    expect(drill.indexOf('ariaLabel="Grip style"')).toBeGreaterThan(
      drill.indexOf('label="Grip handle"'),
    );
    for (const entry of COMPARE_GRIP_CATALOG) expect(drill).not.toContain(`value: "${entry.id}"`);
  });

  it("hands the sides to the inspectors instead of holding its own Before/After section", () => {
    expect(drill).toContain("Use the Before and After toggles in Device, Theme, Background and");
    expect(drill).not.toContain("<ToggleFieldset");
    expect(drill).not.toContain("Screen media");
    expect(drill).not.toContain("Same as before");
  });

  it("picks the divider colour with the shared picker, never a token row", () => {
    expect(drill).toContain('label="Divider colour"');
    expect(drill).toContain("<ColourPicker");
    expect(drill).not.toContain('ariaLabel="Divider colour"');
    expect(drill).not.toContain("lineTokens");
  });

  it("wears the shared colour-row layout on the divider colour", () => {
    expect(drill).toContain('className="popover-row text-inspector-colour-row"');
    expect(drill).toContain('<span className="action-row-icon">');
    expect(drill).toContain('<TextControlIcon type="colour" />');
  });

  it("shows the key the gesture is pinned to, not the one under a running playhead", () => {
    expect(drill).toContain("compareGestureMs.current !== null");
    expect(drill).toContain("nearestCompareKey(cmp.track?.keys, compareGestureMs.current)");
    expect(drill).toContain("cmp.track?.keys.find((k) => k.id === compareTargetKeyId)");
  });

  it("releases the gesture when a drag ends where it started", () => {
    expect(drill).toContain("const cmpAbort = () => {");
    expect(drill).toContain("next.compare = structuredClone(baseline.compare);");
    expect(drill).toContain("onDragEnd={(committed) => {");
    expect(drill).toContain("if (!committed) cmpAbort();");
    // Both halves of the gesture state clear, or the next commit builds on a stale snapshot.
    const abort = drill.slice(drill.indexOf("const cmpAbort = () => {"));
    expect(abort.slice(0, abort.indexOf("};"))).toContain("compareGestureMs.current = null;");
    expect(source).toContain("compareDragBaseline.current = null;\n    compareGripMemory.current");
  });

  it("hands useDragScrub the release seam, after the commit-or-restore branch", () => {
    expect(rows).toContain("onDragEnd?: (committed: boolean) => void;");
    expect(rows).toContain("const committed = changed(v);");
    expect(rows).toMatch(
      /if \(committed\) onCommit\(v\);\s*else onText\(write\(value\)\);\s*onDragEnd\?\.\(committed\);/,
    );
  });

  it("restores the grip a switched-off handle wore", () => {
    expect(drill).toContain("compareGripMemory.current = structuredClone(gripObject)");
    expect(drill).toContain(
      "grip: on ? (remembered ? structuredClone(remembered) : true) : undefined,",
    );
    expect(drill).not.toContain("grip: on ? true : undefined");
  });

  it("leads every After tint option with its resolved swatch", () => {
    expect(drill).toContain("COMPARE_TINT_TOKENS.map((token)");
    expect(drill).toContain("<CompareSwatchIcon colour={resolveCompareColour(token, sceneTheme)}");
    expect(drill).toContain("<CompareNoneIcon size={14} />");
    expect(drill).not.toContain('{ value: "accent", label: "accent" }');
  });
});
