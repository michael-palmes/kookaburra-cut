import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "kookaburra:free-camera-warning-dismissed";

// Node test environment has no localStorage; a Map-backed stand-in is enough.
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/** A fresh module instance, so the store re-reads localStorage the way a relaunch does. */
async function freshStore() {
  vi.resetModules();
  const { useUiStore } = await import("./uiStore");
  return useUiStore;
}

beforeEach(stubLocalStorage);
afterEach(() => {
  // @ts-expect-error test-only cleanup
  delete globalThis.localStorage;
});

describe("free camera warning dismissal", () => {
  it("starts undismissed", async () => {
    const store = await freshStore();
    expect(store.getState().freeCameraWarningDismissed).toBe(false);
  });

  it("persists the dismissal and loads it back", async () => {
    const store = await freshStore();
    store.getState().setFreeCameraWarningDismissed(true);
    expect(store.getState().freeCameraWarningDismissed).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    const relaunched = await freshStore();
    expect(relaunched.getState().freeCameraWarningDismissed).toBe(true);
  });

  it("brings the warning back when the flag is cleared", async () => {
    localStorage.setItem(KEY, "1");
    const store = await freshStore();
    store.getState().setFreeCameraWarningDismissed(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    const relaunched = await freshStore();
    expect(relaunched.getState().freeCameraWarningDismissed).toBe(false);
  });

  it("stays usable when storage is unavailable", async () => {
    // @ts-expect-error test-only teardown of the stub
    delete globalThis.localStorage;
    const store = await freshStore();
    expect(store.getState().freeCameraWarningDismissed).toBe(false);
    store.getState().setFreeCameraWarningDismissed(true);
    expect(store.getState().freeCameraWarningDismissed).toBe(true);
  });
});

describe("inspector drill navigation", () => {
  it("pushes and pops exactly one canonical level", async () => {
    const store = await freshStore();
    store.getState().openInspectorDrill("lighting");
    store.getState().openInspectorDrill("lighting.shadows");

    expect(store.getState().inspector).toEqual({
      tab: "scene",
      drillStack: ["lighting", "lighting.shadows"],
      drillIn: "lighting.shadows",
      overviewSelection: null,
    });

    store.getState().closeInspectorDrill();
    expect(store.getState().inspector.drillStack).toEqual(["lighting"]);
    expect(store.getState().inspector.drillIn).toBe("lighting");
    expect(store.getState().inspectorNavigation.kind).toBe("pop");
  });

  it("resets the path on tab changes and explicit resets", async () => {
    const store = await freshStore();
    store.getState().openInspectorDrill("lighting");
    store.getState().setInspectorTab("project");
    expect(store.getState().inspector).toEqual({
      tab: "project",
      drillStack: [],
      drillIn: null,
      overviewSelection: null,
    });
    expect(store.getState().inspectorNavigation.kind).toBe("reset");

    store.getState().openInspectorDrill("project.scenes");
    store.getState().resetInspectorDrill();
    expect(store.getState().inspector.drillStack).toEqual([]);
    expect(store.getState().inspector.drillIn).toBeNull();
  });

  it("copies an external jump path and keeps its top mirror in sync", async () => {
    const store = await freshStore();
    const path = ["chart.edit", "chart.position"];
    store.getState().jumpInspectorDrill(path);
    path.push("mutated-outside");

    expect(store.getState().inspector.drillStack).toEqual(["chart.edit", "chart.position"]);
    expect(store.getState().inspector.drillIn).toBe("chart.position");
    expect(store.getState().inspectorNavigation.kind).toBe("jump");
  });

  it("replaces the current drill without changing its depth", async () => {
    const store = await freshStore();
    store.getState().openInspectorDrill("legacyImage.edit");
    store.getState().replaceInspectorDrill("image.edit");

    expect(store.getState().inspector.drillStack).toEqual(["image.edit"]);
    expect(store.getState().inspector.drillIn).toBe("image.edit");
    expect(store.getState().inspectorNavigation.kind).toBe("replace");

    store.getState().closeInspectorDrill();
    expect(store.getState().inspector.drillStack).toEqual([]);
  });

  it("does not emit a pop when already at the overview", async () => {
    const store = await freshStore();
    const before = store.getState().inspectorNavigation.sequence;
    store.getState().closeInspectorDrill();
    expect(store.getState().inspectorNavigation.sequence).toBe(before);
  });

  it("keeps overview selection through a drill round trip and clears it on reset", async () => {
    const store = await freshStore();
    const selection = { sceneIndex: 2, rowId: "device:phone", domain: "devices" as const };
    store.getState().setInspectorOverviewSelection(selection);
    store.getState().openInspectorDrill("device");
    store.getState().closeInspectorDrill();

    expect(store.getState().inspector.overviewSelection).toEqual(selection);

    store.getState().resetInspectorDrill();
    expect(store.getState().inspector.overviewSelection).toBeNull();
  });
});
