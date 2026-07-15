import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadColourRecents, rememberColourPick } from "./colourRecents";

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

beforeEach(stubLocalStorage);
afterEach(() => {
  // @ts-expect-error test-only cleanup
  delete globalThis.localStorage;
});

describe("colour recents", () => {
  it("returns [] when empty or corrupt", () => {
    expect(loadColourRecents()).toEqual([]);
    localStorage.setItem("kookaburra:colour-recents", "{not json");
    expect(loadColourRecents()).toEqual([]);
    localStorage.setItem("kookaburra:colour-recents", JSON.stringify({ a: 1 }));
    expect(loadColourRecents()).toEqual([]);
  });

  it("drops non-string entries", () => {
    localStorage.setItem("kookaburra:colour-recents", JSON.stringify(["#ffffff", 3, null]));
    expect(loadColourRecents()).toEqual(["#ffffff"]);
  });

  it("stores most-recent-first with case-insensitive dedupe", () => {
    rememberColourPick("#AA0000");
    rememberColourPick("#00bb00");
    rememberColourPick("#aa0000");
    expect(loadColourRecents()).toEqual(["#aa0000", "#00bb00"]);
  });

  it("caps at 10", () => {
    for (let i = 0; i < 12; i++) {
      rememberColourPick(`#0000${i.toString(16).padStart(2, "0")}`);
    }
    const recents = loadColourRecents();
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe("#00000b");
  });
});
