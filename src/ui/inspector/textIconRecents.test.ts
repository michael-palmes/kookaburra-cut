import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTextIconRecent,
  loadTextIconRecents,
  parseTextIconRecentStore,
  resetTextIconRecentSessionStore,
  storeTextIconRecent,
  visibleTextIconRecents,
} from "./textIconRecents";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", memoryStorage());
  resetTextIconRecentSessionStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTextIconRecentSessionStore();
});

describe("managed text icon recents", () => {
  it("keeps legacy emoji recents but drops unscoped legacy project images", () => {
    const store = parseTextIconRecentStore(JSON.stringify(["✨", "assets/project-a.png", "✅"]));

    expect(visibleTextIconRecents(store, "project-a")).toEqual(["✨", "✅"]);
    expect(visibleTextIconRecents(store, "project-b")).toEqual(["✨", "✅"]);
  });

  it("shares emoji recents while isolating project images by project identity", () => {
    let store = parseTextIconRecentStore(null);
    store = addTextIconRecent(store, "project-a", "✨");
    store = addTextIconRecent(store, "project-a", "assets/mark.png");

    expect(visibleTextIconRecents(store, "project-a")).toEqual(["assets/mark.png", "✨"]);
    expect(visibleTextIconRecents(store, "project-b")).toEqual(["✨"]);

    store = addTextIconRecent(store, "project-b", "assets/mark.png");
    expect(visibleTextIconRecents(store, "project-a")).toEqual(["assets/mark.png", "✨"]);
    expect(visibleTextIconRecents(store, "project-b")).toEqual(["assets/mark.png", "✨"]);
  });

  it("ignores malformed and unsafe stored entries", () => {
    expect(visibleTextIconRecents(parseTextIconRecentStore("not json"), "project-a")).toEqual([]);
    expect(
      visibleTextIconRecents(
        parseTextIconRecentStore(
          JSON.stringify({
            version: 1,
            entries: [
              null,
              { value: 4 },
              { value: "assets/unscoped.png" },
              { value: "🎉", projectId: "stale-scope" },
              { value: "assets/scoped.png", projectId: "project-a" },
            ],
          }),
        ),
        "project-a",
      ),
    ).toEqual(["🎉", "assets/scoped.png"]);
  });

  it("degrades a throwing storage read without breaking the inspector", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(loadTextIconRecents("project-a")).toEqual([]);
  });

  it("retains new recents in session when storage writes throw", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(storeTextIconRecent("project-a", "assets/mark.png")).toEqual(["assets/mark.png"]);
    expect(storeTextIconRecent("project-a", "✨")).toEqual(["✨", "assets/mark.png"]);
    expect(loadTextIconRecents("project-a")).toEqual(["✨", "assets/mark.png"]);
    expect(loadTextIconRecents("project-b")).toEqual(["✨"]);
  });
});
