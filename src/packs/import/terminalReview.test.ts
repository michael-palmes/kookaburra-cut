import { describe, expect, it, vi } from "vitest";
import { terminalReviewRows } from "./terminalReview";

describe("terminalReviewRows", () => {
  it("collects only scenes whose terminal pre-types a command or sets a start path", () => {
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
    ]);
    expect(rows).toEqual([
      {
        project: "Launch",
        scene: "Live demo",
        file: "scenes/03-demo.tsx",
        command: "pnpm dev",
        startPath: null,
      },
      {
        project: "Launch",
        scene: "04-repo",
        file: "scenes/04-repo.tsx",
        command: null,
        startPath: "~/Projects/demo",
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
