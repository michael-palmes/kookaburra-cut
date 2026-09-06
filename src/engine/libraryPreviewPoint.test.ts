import { describe, expect, it, vi } from "vitest";
import type { LibraryItemInfo } from "./library";
import { libraryPreviewFormat, parseLibraryPreviewPoint } from "./libraryPreviewPoint";
import { userTemplatePreviews } from "./templates";

vi.mock("./media", () => ({ fsUrl: (path: string) => path }));

describe("library preview capture points", () => {
  it.each([
    ["16:9", 640, 360],
    ["9:16", 360, 640],
    ["1:1", 640, 640],
    ["4:5", 512, 640],
  ] as const)("preserves %s without cropping", (aspect, width, height) => {
    const point = { scene: 2, sceneFile: "scenes/hero.tsx", atMs: 321.5, aspect };
    expect(parseLibraryPreviewPoint(point)).toEqual(point);
    expect(libraryPreviewFormat(aspect)).toEqual({ name: aspect, width, height });
  });
  it("retains legacy capture points and their 16:9 format", () => {
    expect(parseLibraryPreviewPoint(2)).toBe(2);
    expect(parseLibraryPreviewPoint({ scene: 1, atMs: 1500 })).toEqual({ scene: 1, atMs: 1500 });
    expect(libraryPreviewFormat()).toEqual({ name: "16:9", width: 640, height: 360 });
  });
  it.each([
    { scene: 0, aspect: "2:1" },
    { scene: 0, atMs: Infinity },
    { scene: 0, atMs: -1 },
    { scene: 0, sceneFile: "../other.tsx" },
  ])("rejects invalid saved settings %j", (point) => {
    expect(parseLibraryPreviewPoint(point)).toBeNull();
  });
  it("keeps a personal template's legacy cover until slot images exist", () => {
    const info = {
      posterPath: "/workspace/templates/demo/poster.png",
      posterModifiedAt: 1,
    } as LibraryItemInfo;
    const legacy = userTemplatePreviews(info);
    expect(legacy).toHaveLength(1);
    const slots = userTemplatePreviews({
      ...info,
      previewPaths: [null, null, "/workspace/templates/demo/previews/3.png", null],
      previewModifiedAt: [null, null, 5, null],
    });
    expect(slots).toHaveLength(4);
    expect(slots?.[0]).toEqual(legacy?.[0]);
    expect(slots?.[2]).toContain("previews/3.png");
    expect(slots?.[2]).toContain("?v=5");
  });
});
