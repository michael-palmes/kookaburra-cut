import { beforeEach, describe, expect, it, vi } from "vitest";

// The gate's three native commands, scripted per test; calls are recorded for order/count asserts.
const calls: string[] = [];
let autorunAction: string | null = null;
let storedGrantValid = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "get_autorun_config") return { action: autorunAction };
    if (cmd === "is_project_trusted") return storedGrantValid;
    if (cmd === "trust_project") return undefined;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

// Fresh module state per test: sessionTrusted, the autorun cache and the store's inflight map are all module-level.
async function freshGate() {
  vi.resetModules();
  const gate = await import("./projectTrust");
  const { useTrustStore } = await import("../store/trustStore");
  return { ...gate, useTrustStore };
}

// The gate awaits its invokes before touching the store; a few microtask hops let it reach the modal request.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  calls.length = 0;
  autorunAction = null;
  storedGrantValid = false;
});

describe("ensureProjectTrusted", () => {
  it("passes silently on a valid stored grant, without a modal", async () => {
    const { ensureProjectTrusted, useTrustStore } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("demo", "Demo");
    expect(useTrustStore.getState().pending).toBeNull();
    expect(calls).toContain("is_project_trusted");
    expect(calls).not.toContain("trust_project");
  });

  it("re-stamps in-session edits without re-asking (session-sticky)", async () => {
    const { ensureProjectTrusted, useTrustStore } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("demo", "Demo");
    // An edit moved the fingerprint, so the stored grant no longer matches natively.
    storedGrantValid = false;
    calls.length = 0;
    await ensureProjectTrusted("demo", "Demo");
    expect(useTrustStore.getState().pending).toBeNull();
    expect(calls).toEqual(["trust_project"]);
  });

  it("auto-trusts autorun launches so the headless Verify never blocks", async () => {
    const { ensureProjectTrusted, useTrustStore } = await freshGate();
    autorunAction = "verify";
    await ensureProjectTrusted("launch-2026", "Launch 2026");
    expect(useTrustStore.getState().pending).toBeNull();
    expect(calls).toContain("trust_project");
  });

  it("persists the grant when the user allows", async () => {
    const { ensureProjectTrusted, useTrustStore } = await freshGate();
    const gate = ensureProjectTrusted("demo", "Demo");
    await flush();
    expect(useTrustStore.getState().pending?.slug).toBe("demo");
    useTrustStore.getState().answer(true);
    await gate;
    expect(calls).toContain("trust_project");
    // The slug is now session-trusted: the next load re-stamps instead of asking.
    calls.length = 0;
    await ensureProjectTrusted("demo", "Demo");
    expect(useTrustStore.getState().pending).toBeNull();
    expect(calls).toEqual(["trust_project"]);
  });

  it("throws TrustDeniedError on decline and asks again next time", async () => {
    const { ensureProjectTrusted, TrustDeniedError, useTrustStore } = await freshGate();
    const gate = ensureProjectTrusted("demo", "Demo");
    await flush();
    useTrustStore.getState().answer(false);
    await expect(gate).rejects.toThrow(TrustDeniedError);
    expect(calls).not.toContain("trust_project");
    // Declining is not remembered: a second open asks again.
    const again = ensureProjectTrusted("demo", "Demo");
    await flush();
    expect(useTrustStore.getState().pending?.slug).toBe("demo");
    useTrustStore.getState().answer(false);
    await expect(again).rejects.toThrow(TrustDeniedError);
  });

  it("shares one modal between re-entrant requests for the same slug", async () => {
    const { ensureProjectTrusted, useTrustStore } = await freshGate();
    const first = ensureProjectTrusted("demo", "Demo");
    await flush();
    const second = ensureProjectTrusted("demo", "Demo");
    await flush();
    useTrustStore.getState().answer(true);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});
