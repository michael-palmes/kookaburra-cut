import { describe, expect, it } from "vitest";

/** Source-text pins for the transport focus rules: the behaviour lives in DOM handlers this node-env suite can't mount, so the shape is held here instead. */

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

const app = read("../App.tsx");
const spaceBranch = app.slice(
  app.indexOf('if (e.code === "Space"'),
  app.indexOf('} else if (e.key === "ArrowLeft"'),
);
const arrowBranch = app.slice(
  app.indexOf('} else if (e.key === "ArrowLeft"'),
  app.indexOf('window.addEventListener("keydown", onKeyDown)'),
);

describe("App transport keydown", () => {
  it("no longer swallows every key from a form control", () => {
    expect(app).not.toContain(
      'if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;',
    );
    expect(app).toContain(
      'const formControl = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";',
    );
  });

  it("lets Space through only where a literal space means nothing", () => {
    expect(spaceBranch).toContain("if (formControl && !spaceMeansPlayback(target)) return;");
  });

  it("commits the pending value before playback starts", () => {
    expect(spaceBranch.indexOf("target?.blur()")).toBeGreaterThan(-1);
    expect(spaceBranch.indexOf("target?.blur()")).toBeLessThan(spaceBranch.indexOf("togglePlay()"));
  });

  it("stands the new blur down under an export", () => {
    expect(spaceBranch).toContain("if (exporting || isExporting()) return;");
  });

  // Arrows are deliberately NOT a defocus source: they keep moving the caret inside a focused field.
  it("keeps arrows in the focused control instead of frame stepping", () => {
    expect(arrowBranch).toContain("if (formControl) return;");
    expect(arrowBranch).not.toContain("commitFocusedInspectorEdit();");
  });

  it("commits a focused inspector edit on a bar scrub, never during an export", () => {
    const scrub = app.slice(app.indexOf("onScrub={(ms) => {"), app.indexOf("onNewScene={"));
    expect(scrub.indexOf("if (!isExporting()) {")).toBeLessThan(
      scrub.indexOf("commitFocusedInspectorEdit();"),
    );
    expect(scrub.indexOf("commitFocusedInspectorEdit();")).toBeLessThan(
      scrub.indexOf("setCurrentMs(ms)"),
    );
  });
});

describe("space-plays opt-in markers", () => {
  const files = [
    "./colour/ColourPicker.tsx",
    "./inspector/SceneTab.tsx",
    "./PlaybackBar.tsx",
    "./inspector/ScenesDrillIn.tsx",
    "./TrackLane.tsx",
  ];

  it("marks each m:ss and hex field exactly once", () => {
    for (const file of files) {
      expect(read(file).match(/data-space-plays/g)).toHaveLength(1);
    }
  });

  it("leaves the sibling name fields alone", () => {
    expect(read("./PlaybackBar.tsx")).toContain(
      'className="modal-input pb-label-input pb-label-duration"\n                data-space-plays=""',
    );
    expect(read("./inspector/ScenesDrillIn.tsx")).toContain(
      'className="modal-input scene-manager-edit scene-manager-edit-duration"\n                  data-space-plays=""',
    );
  });
});

describe("lane seek", () => {
  it("blurs from TrackLane, never from the documentless seek helper", () => {
    expect(read("./TrackLane.tsx")).toContain(
      "commitFocusedInspectorEdit();\n    seekSceneLocal(slotStartMs, tMs,",
    );
    expect(read("./laneSeek.ts")).not.toContain("document");
  });
});
