import { beforeEach, describe, expect, it } from "vitest";
import { useLightingEditStore } from "./lightingEditStore";

beforeEach(() => useLightingEditStore.getState().reset());

describe("lightingEditStore", () => {
  it("keeps editor-only lane state and resets it as one project-scoped unit", () => {
    const store = useLightingEditStore.getState();
    store.setOpen(true);
    store.select("k2", 1);
    store.setDraft({
      projectId: "workspace:demo",
      sceneIndex: 2,
      target: "scene",
      track: { keys: [{ id: "k2", tMs: 100, pose: {} }], segments: [] },
      committed: false,
    });
    expect(useLightingEditStore.getState()).toMatchObject({
      open: true,
      selectedKeyId: "k2",
      selectedSegment: 1,
      target: "scene",
    });
    useLightingEditStore.getState().reset();
    expect(useLightingEditStore.getState()).toMatchObject({
      open: false,
      selectedKeyId: null,
      selectedSegment: null,
      draft: null,
      target: "scene",
    });
  });

  it("keeps drafts target-aware and clears stale lane selection on a target switch", () => {
    const store = useLightingEditStore.getState();
    store.select("scene-key", 0);
    store.setDraft({
      projectId: "workspace:demo",
      sceneIndex: 1,
      target: "scene",
      track: { keys: [{ id: "scene-key", tMs: 0, pose: {} }], segments: [] },
      committed: false,
    });

    store.setTarget("compareB");
    expect(useLightingEditStore.getState()).toMatchObject({
      target: "compareB",
      selectedKeyId: null,
      selectedSegment: null,
      draft: null,
    });

    store.setDraft({
      projectId: "workspace:demo",
      sceneIndex: 1,
      target: "compareB",
      track: { keys: [{ id: "after-key", tMs: 0, pose: {} }], segments: [] },
      committed: false,
    });
    store.setTarget("compareB");
    expect(useLightingEditStore.getState().draft?.target).toBe("compareB");
  });
});
