import { describe, expect, it } from "vitest";
import { exportProgressAnnouncement, exportVerbFor } from "./exportAnnouncement";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const app = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

const at = (frame: number, total = 600) => ({ frame, total, stage: "render" as const });

describe("export progress announcements (4.1.3)", () => {
  it("speaks once per 10% step, not every frame", () => {
    expect(exportProgressAnnouncement(at(0))).toBe("Exporting 0%");
    expect(exportProgressAnnouncement(at(59))).toBe("Exporting 0%");
    expect(exportProgressAnnouncement(at(60))).toBe("Exporting 10%");
    expect(exportProgressAnnouncement(at(599))).toBe("Exporting 90%");
    expect(exportProgressAnnouncement(at(600))).toBe("Exporting 100%");
  });

  it("names stills runs by what they make", () => {
    expect(exportProgressAnnouncement(at(300), exportVerbFor("pdf"))).toBe("Exporting PDF 50%");
    expect(exportVerbFor("png-zip")).toBe("Exporting images");
  });

  it("names the preparation and the encoding passes", () => {
    expect(exportProgressAnnouncement(null)).toBe("Exporting, getting ready");
    expect(exportProgressAnnouncement({ frame: 3, total: 9, stage: "pass1" })).toBe(
      "Encoding, pass 1 of 2",
    );
    expect(exportProgressAnnouncement({ frame: 3, total: 9, stage: "pass2" })).toBe(
      "Encoding, pass 2 of 2",
    );
  });

  it("keeps a polite region mounted before the run, so the first step is heard", () => {
    expect(app).toMatch(
      /<div className="visually-hidden" role="status" aria-live="polite">\s*\{exportSpoken\}/,
    );
  });

  it("says how each run ended", () => {
    for (const line of ["Export finished.", "Export cancelled.", "Export failed."]) {
      expect(app).toContain(`"${line}"`);
    }
  });
});
