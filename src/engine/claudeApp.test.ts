import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimClaudeLauncherGreeting,
  queueClaudeLauncherGreeting,
  rearmClaudeLauncherGreeting,
} from "./claudeApp";

const KEY = "kookaburra:claude-launcher-pending";

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

describe("Claude launcher greeting", () => {
  it("never greets a project that wasn't created here", () => {
    expect(claimClaudeLauncherGreeting("ws:existing")).toBe(false);
  });

  it("greets a new project once, on its first open", () => {
    queueClaudeLauncherGreeting("ws:new");
    expect(claimClaudeLauncherGreeting("ws:other")).toBe(false);
    expect(claimClaudeLauncherGreeting("ws:new")).toBe(true);
    expect(claimClaudeLauncherGreeting("ws:new")).toBe(false);
  });

  it("re-arms once for whichever project opens next", () => {
    queueClaudeLauncherGreeting("ws:new");
    rearmClaudeLauncherGreeting();
    expect(claimClaudeLauncherGreeting("ws:existing")).toBe(true);
    expect(claimClaudeLauncherGreeting("ws:existing")).toBe(false);
    expect(claimClaudeLauncherGreeting("ws:new")).toBe(true);
  });

  it("ignores a corrupt store", () => {
    localStorage.setItem(KEY, "not json");
    expect(claimClaudeLauncherGreeting("ws:a")).toBe(false);
    queueClaudeLauncherGreeting("ws:a");
    expect(claimClaudeLauncherGreeting("ws:a")).toBe(true);
  });

  it("never greets when consuming the greeting can't be saved", () => {
    queueClaudeLauncherGreeting("ws:new");
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(claimClaudeLauncherGreeting("ws:new")).toBe(false);
  });

  it("keeps only the most recent pending greetings", () => {
    for (let i = 0; i < 60; i++) queueClaudeLauncherGreeting(`ws:p${i}`);
    expect(claimClaudeLauncherGreeting("ws:p0")).toBe(false);
    expect(claimClaudeLauncherGreeting("ws:p59")).toBe(true);
  });
});
