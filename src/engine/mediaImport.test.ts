import { beforeEach, describe, expect, it, vi } from "vitest";

const emitted: string[] = [];
let reply: unknown;

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(async () => reply),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string) => {
    emitted.push(name);
  }),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("./assetRevisions", () => ({ refreshWorkspaceAssets: vi.fn(async () => {}) }));

const { importMedia, importSummary, soleImport } = await import("./media");

const report = (over: Partial<Parameters<typeof importSummary>[0]> = {}) => ({
  rels: [],
  converted: 0,
  notes: [],
  refused: [],
  ...over,
});

describe("what an import says", () => {
  it("says nothing when nothing happened", () => {
    expect(importSummary(report())).toBeNull();
  });

  it("counts what landed, what conforms and what was converted", () => {
    expect(importSummary(report({ rels: ["assets/a.png"] }))).toEqual({
      kind: "success",
      message: "Added 1 file to assets",
    });
    expect(importSummary(report({ rels: ["a", "b", "c"], converted: 2 }), 1)?.message).toBe(
      "Added 3 files to assets; 1 conforming (place it now, Media shows progress); 2 converted to plain sRGB",
    );
  });

  it("carries notes on a success and turns an error when a file was refused", () => {
    const noted = importSummary(report({ rels: ["a"], notes: ["plate.png is one flat colour"] }));
    expect(noted).toEqual({
      kind: "success",
      message: "Added 1 file to assets. plate.png is one flat colour",
    });
    const mixed = importSummary(report({ rels: ["a"], refused: ["bad.png is not an image"] }));
    expect(mixed).toEqual({
      kind: "error",
      message: "Added 1 file to assets. bad.png is not an image",
    });
    expect(importSummary(report({ refused: ["bad.png is not an image"] }))?.message).toBe(
      "bad.png is not an image",
    );
  });
});

describe("a one-file import", () => {
  it("gives the path, nothing for a skipped file, and throws the reason for a refused one", () => {
    expect(soleImport(report({ rels: ["assets/a.png"] }))).toBe("assets/a.png");
    expect(soleImport(report())).toBeUndefined();
    expect(() => soleImport(report({ refused: ["bad.png is not an image"] }))).toThrow(
      "bad.png is not an image",
    );
  });
});

describe("importMedia", () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it("broadcasts only when something landed", async () => {
    reply = report({ refused: ["bad.png is not an image"] });
    await importMedia("product-tour", ["/Users/x/bad.png"]);
    expect(emitted).toEqual([]);
    reply = report({ rels: ["assets/a.png"] });
    await importMedia("product-tour", ["/Users/x/a.png"]);
    expect(emitted).toEqual(["kookaburra://media-imported", "kookaburra://media-changed"]);
  });
});
