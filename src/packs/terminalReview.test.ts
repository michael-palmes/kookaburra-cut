import { describe, expect, it, vi } from "vitest";
import { terminalReviewRows } from "./terminalReview";

describe("terminalReviewRows", () => {
  it("collects scenes whose terminal pre-types a command, sets a start path or carries a snapshot", () => {
    const rows = terminalReviewRows("Launch", [
      { file: "scenes/01-plain.tsx", doc: { version: 1 } },
      { file: "scenes/02-idle.tsx", doc: { version: 1, terminal: { cols: 90 } } },
      {
        file: "scenes/03-demo.tsx",
        doc: { version: 1, name: "Live demo", terminal: { startCommand: "pnpm dev" } },
      },
      {
        file: "scenes/04-repo.tsx",
        doc: { version: 1, terminal: { startPath: "~/Projects/demo" } },
      },
      {
        file: "scenes/05-shot.tsx",
        doc: { version: 1, terminal: { snapshot: { grid: [[["$ ls"]]] } } },
      },
    ]);
    expect(rows).toEqual([
      {
        project: "Launch",
        scene: "Live demo",
        file: "scenes/03-demo.tsx",
        command: "pnpm dev",
        startPath: null,
        hasSnapshot: false,
      },
      {
        project: "Launch",
        scene: "04-repo",
        file: "scenes/04-repo.tsx",
        command: null,
        startPath: "~/Projects/demo",
        hasSnapshot: false,
      },
      {
        project: "Launch",
        scene: "05-shot",
        file: "scenes/05-shot.tsx",
        command: null,
        startPath: null,
        hasSnapshot: true,
      },
    ]);
  });

  it("reports the parse-sanitised command, never the raw sidecar text", () => {
    const rows = terminalReviewRows("Launch", [
      {
        file: "scenes/01-demo.tsx",
        doc: { terminal: { startCommand: "echo safe\nrm -rf ~" } },
      },
    ]);
    expect(rows[0].command).toBe("echo safe");
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
