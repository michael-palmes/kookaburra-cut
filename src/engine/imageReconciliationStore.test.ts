import { beforeEach, describe, expect, it } from "vitest";
import { useImageReconciliationStore } from "./imageReconciliationStore";

const store = () => useImageReconciliationStore.getState();

describe("imageReconciliationStore", () => {
  beforeEach(() => store().reset());

  it("retains origins across scene visits within one project", () => {
    store().bindProject("ws:demo");
    store().recordOrigin("ws:demo", "scenes/one.tsx", {
      kind: "legacy-promotion",
      imageId: "img1",
      decorationId: "logo",
    });
    store().recordOrigin("ws:demo", "scenes/two.tsx", {
      kind: "duplicate",
      imageId: "img2",
      sourceImageId: "img1",
    });

    expect(store().originsFor("ws:demo", "scenes/one.tsx")).toEqual([
      { kind: "legacy-promotion", imageId: "img1", decorationId: "logo" },
    ]);
    expect(store().originsFor("ws:demo", "scenes/two.tsx")).toEqual([
      { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
    ]);

    store().bindProject("ws:demo");
    expect(store().originsFor("ws:demo", "scenes/one.tsx")).toHaveLength(1);
  });

  it("clears every origin on a real project switch", () => {
    store().bindProject("ws:first");
    store().recordOrigin("ws:first", "scenes/one.tsx", {
      kind: "duplicate",
      imageId: "img2",
      sourceImageId: "img1",
    });

    store().bindProject("ws:second");

    expect(store().originsFor("ws:first", "scenes/one.tsx")).toEqual([]);
    expect(store().originsFor("ws:second", "scenes/one.tsx")).toEqual([]);
  });

  it("ignores stale operations and replaces a reused image ID with its newest origin", () => {
    store().bindProject("ws:current");
    store().recordOrigin("ws:stale", "scenes/one.tsx", {
      kind: "duplicate",
      imageId: "img2",
      sourceImageId: "img1",
    });
    store().recordOrigin("ws:current", null, {
      kind: "duplicate",
      imageId: "img2",
      sourceImageId: "img1",
    });
    store().recordOrigin("ws:current", "scenes/one.tsx", {
      kind: "legacy-promotion",
      imageId: "img2",
      decorationId: "logo",
    });
    store().recordOrigin("ws:current", "scenes/one.tsx", {
      kind: "duplicate",
      imageId: "img2",
      sourceImageId: "img7",
    });

    expect(store().originsFor("ws:current", "scenes/one.tsx")).toEqual([
      { kind: "duplicate", imageId: "img2", sourceImageId: "img7" },
    ]);
  });
});
