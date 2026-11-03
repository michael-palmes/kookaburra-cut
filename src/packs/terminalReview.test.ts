import { describe, expect, it, vi } from "vitest";
import { terminalReviewRows } from "./terminalReview";

describe("terminalReviewRows", () => {
  it("collects scenes whose terminal carries a transcript or a snapshot", () => {
    const rows = terminalReviewRows("Launch", [
      { file: "scenes/01-plain.tsx", doc: { version: 1 } },
      { file: "scenes/02-idle.tsx", doc: { version: 1, terminal: { cols: 90 } } },
      {
        file: "scenes/03-demo.tsx",
        doc: { version: 1, name: "Live demo", terminal: { transcript: "$ pnpm dev" } },
      },
      {
        file: "scenes/05-shot.tsx",
        doc: { version: 1, terminal: { snapshot: { grid: [[["$ ls"]]] } } },
      },
    ]);
    expect(rows).toEqual([
      { project: "Launch", scene: "Live demo", file: "scenes/03-demo.tsx" },
      { project: "Launch", scene: "05-shot", file: "scenes/05-shot.tsx" },
    ]);
  });

  it("skips malformed docs and terminal blocks without a row", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = terminalReviewRows("Launch", [
      { file: "scenes/01-bad.tsx", doc: "not-an-object" },
      { file: "scenes/02-bad.tsx", doc: { terminal: 7 } },
    ]);
    warn.mockRestore();
    expect(rows).toEqual([]);
  });
});
