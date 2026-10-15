import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  scheduleTrustRestamp: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./projectTrust", () => ({ scheduleTrustRestamp: mocks.scheduleTrustRestamp }));

import {
  armSourceFiles,
  bindSourceBaseline,
  changedSourceFiles,
  noteSourceWrite,
  observeSourceStamps,
  resetSourceBaselineForTests,
  type SourceStamp,
} from "./sourceBaseline";

const stamps = (entries: Record<string, string>): SourceStamp[] =>
  Object.entries(entries).map(([file, stamp]) => ({ file, stamp }));

/** Two identical ticks settle a change; returns what the second tick reported. */
function settle(slug: string, current: SourceStamp[]): string[] | null {
  expect(observeSourceStamps(slug, current)).toBeNull();
  return observeSourceStamps(slug, current);
}

const start = {
  "project.json": "1:10",
  "scenes/01-a.tsx": "1:20",
  "scenes/01-a.json": "1:30",
  "scenes/02-b.json": "1:40",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSourceBaselineForTests();
  bindSourceBaseline("demo");
  expect(observeSourceStamps("demo", stamps(start))).toBeNull();
});

describe("changedSourceFiles", () => {
  it("names changed, new and removed files", () => {
    const baseline = new Map(Object.entries({ a: "1", b: "1", c: "1" }));
    expect(changedSourceFiles(baseline, stamps({ a: "1", b: "2", d: "1" }))).toEqual([
      "b",
      "c",
      "d",
    ]);
  });
});

describe("the per-file reload baseline", () => {
  it("reloads an outside change once it reads the same on two ticks", () => {
    const edited = stamps({ ...start, "scenes/01-a.json": "2:31" });
    expect(settle("demo", edited)).toEqual(["scenes/01-a.json"]);
    expect(observeSourceStamps("demo", edited)).toBeNull();
  });

  it("waits while an outside write is still moving", () => {
    expect(observeSourceStamps("demo", stamps({ ...start, "project.json": "2:11" }))).toBeNull();
    expect(observeSourceStamps("demo", stamps({ ...start, "project.json": "3:12" }))).toBeNull();
    expect(observeSourceStamps("demo", stamps({ ...start, "project.json": "3:12" }))).toEqual([
      "project.json",
    ]);
  });

  it("adopts the app's own write, so it never reloads it", () => {
    noteSourceWrite("demo", {
      file: "scenes/01-a.json",
      hash: "h",
      before: "1:30",
      stamp: "2:31",
    });
    expect(settle("demo", stamps({ ...start, "scenes/01-a.json": "2:31" }))).toBeNull();
    expect(mocks.scheduleTrustRestamp).toHaveBeenCalledWith("demo");
  });

  it("still reloads an outside change to another file that lands in the same window", () => {
    noteSourceWrite("demo", { file: "scenes/01-a.json", hash: "h", before: "1:30", stamp: "2:31" });
    const both = stamps({ ...start, "scenes/01-a.json": "2:31", "scenes/02-b.json": "2:41" });
    expect(settle("demo", both)).toEqual(["scenes/02-b.json"]);
  });

  it("doesn't adopt an app write over an outside change it didn't see", () => {
    // Claude wrote 01-a (2:35) before the app's write (3:36) replaced it.
    noteSourceWrite("demo", { file: "scenes/01-a.json", hash: "h", before: "2:35", stamp: "3:36" });
    expect(settle("demo", stamps({ ...start, "scenes/01-a.json": "3:36" }))).toEqual([
      "scenes/01-a.json",
    ]);
  });

  it("chains several app writes to one file", () => {
    noteSourceWrite("demo", { file: "project.json", hash: "a", before: "1:10", stamp: "2:11" });
    noteSourceWrite("demo", { file: "project.json", hash: "b", before: "2:11", stamp: "3:12" });
    expect(settle("demo", stamps({ ...start, "project.json": "3:12" }))).toBeNull();
  });

  it("adopts a new file the app created", () => {
    noteSourceWrite("demo", { file: "scenes/03-c.json", hash: "h", before: null, stamp: "1:50" });
    expect(settle("demo", stamps({ ...start, "scenes/03-c.json": "1:50" }))).toBeNull();
  });

  it("keeps its baseline across a pause for the same project, so changes made meanwhile reload", () => {
    bindSourceBaseline("demo");
    expect(settle("demo", stamps({ ...start, "scenes/01-a.tsx": "2:21" }))).toEqual([
      "scenes/01-a.tsx",
    ]);
  });

  it("starts fresh for another project and ignores writes to one it isn't watching", () => {
    noteSourceWrite("other", { file: "project.json", hash: "h", before: "1:10", stamp: "9:99" });
    bindSourceBaseline("other");
    expect(observeSourceStamps("demo", stamps(start))).toBeNull();
    expect(observeSourceStamps("other", stamps({ "project.json": "5:5" }))).toBeNull();
    expect(observeSourceStamps("other", stamps({ "project.json": "5:5" }))).toBeNull();
  });

  it("arms only the named files for writers that report no stamp", async () => {
    mocks.invoke.mockResolvedValue(
      stamps({ ...start, "project.json": "2:11", "scenes/02-b.json": "2:41" }),
    );
    await armSourceFiles("demo", ["project.json"]);
    expect(mocks.invoke).toHaveBeenCalledWith("project_file_stamps", { slug: "demo" });
    expect(
      settle("demo", stamps({ ...start, "project.json": "2:11", "scenes/02-b.json": "2:41" })),
    ).toEqual(["scenes/02-b.json"]);
  });
});
