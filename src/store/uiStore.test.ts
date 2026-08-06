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
