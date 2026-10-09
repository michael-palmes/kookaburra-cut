import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "kookaburra:project-aspects";

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

/** A fresh module instance, so the memory re-reads localStorage the way a relaunch does. */
async function fresh() {
  vi.resetModules();
  return import("./projectAspects");
}

beforeEach(stubLocalStorage);
afterEach(() => {
  // @ts-expect-error test-only cleanup
  delete globalThis.localStorage;
});

describe("project aspects", () => {
  it("opens a new project in its first declared format", async () => {
    const { projectOpenAspect } = await fresh();
    expect(projectOpenAspect("ws:social", ["9:16", "16:9"])).toBe("9:16");
  });

  it("skips unknown declared formats and falls back to 16:9", async () => {
    const { projectOpenAspect } = await fresh();
    expect(projectOpenAspect("ws:odd", ["21:9", "1:1"])).toBe("1:1");
    expect(projectOpenAspect("ws:none", [])).toBe("16:9");
  });

  it("keeps each project's aspect apart", async () => {
    const { projectOpenAspect, rememberedProjectAspect, rememberProjectAspect } = await fresh();
    rememberProjectAspect("ws:a", "9:16");
    expect(rememberedProjectAspect("ws:a")).toBe("9:16");
    expect(projectOpenAspect("ws:a", ["16:9"])).toBe("9:16");
    expect(rememberedProjectAspect("ws:b")).toBeNull();
    expect(projectOpenAspect("ws:b", ["16:9"])).toBe("16:9");
  });

  it("restores a remembered aspect after a relaunch", async () => {
    (await fresh()).rememberProjectAspect("ws:a", "4:5");
    expect((await fresh()).projectOpenAspect("ws:a", ["16:9"])).toBe("4:5");
  });

  it("ignores corrupt or unknown stored values", async () => {
    localStorage.setItem(KEY, "not json");
    expect((await fresh()).projectOpenAspect("ws:a", ["1:1"])).toBe("1:1");
    localStorage.setItem(KEY, JSON.stringify({ "ws:a": "21:9" }));
    expect((await fresh()).projectOpenAspect("ws:a", ["1:1"])).toBe("1:1");
  });

  it("still remembers for the session without localStorage", async () => {
    // @ts-expect-error simulating a blocked store
    delete globalThis.localStorage;
    const { projectOpenAspect, rememberProjectAspect } = await fresh();
    rememberProjectAspect("ws:a", "1:1");
    expect(projectOpenAspect("ws:a", ["16:9"])).toBe("1:1");
  });
});
