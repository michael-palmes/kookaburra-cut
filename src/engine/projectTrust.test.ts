import { beforeEach, describe, expect, it, vi } from "vitest";

// The gate's native commands, scripted per test; calls are recorded for order/count asserts.
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
let autorunAction: string | null = null;
let autorunTrust: string | null = null;
let storedGrantValid = false;
/** Slugs Rust has marked trusted for this app session (a matching grant seen, or a redeemed nonce). */
const sessionTrusted = new Set<string>();
/** What the native sheet answers: a nonce on Allow, null on Don't open. */
let sheetAnswer: string | null = "nonce-1";
let deferSheet: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "get_autorun_config") return { action: autorunAction, trust: autorunTrust };
    if (cmd === "is_project_trusted") return storedGrantValid;
    if (cmd === "check_project_trust") {
      const slug = String(args?.slug);
      if (storedGrantValid) sessionTrusted.add(slug);
      // A session-trusted slug re-stamps natively and answers true even though the content moved.
      return storedGrantValid || sessionTrusted.has(slug);
    }
    if (cmd === "request_project_trust") {
      if (deferSheet) await new Promise<void>((resolve) => (deferSheet = resolve));
      return sheetAnswer;
    }
    if (cmd === "trust_project") {
      if (args?.nonce !== sheetAnswer)
        throw new Error("trust can only be granted from the consent sheet");
      storedGrantValid = true;
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

const names = () => calls.map((c) => c.cmd);

// Fresh module state per test: the autorun cache and the inflight map are module-level.
async function freshGate() {
  vi.resetModules();
  return import("./projectTrust");
}

beforeEach(() => {
  calls.length = 0;
  autorunAction = null;
  autorunTrust = null;
  storedGrantValid = false;
  sessionTrusted.clear();
  sheetAnswer = "nonce-1";
  deferSheet = null;
});

describe("ensureProjectTrusted", () => {
  it("rejects changed sources in a background load without asking", async () => {
    const { ensureProjectTrusted, TrustDeniedError } = await freshGate();
    await expect(ensureProjectTrusted("ws-preset:demo", "Demo", "stored-only")).rejects.toThrow(
      TrustDeniedError,
    );
    expect(names()).toEqual(["is_project_trusted"]);
  });

  it("allows background loading only while the stored grant matches", async () => {
    const { ensureProjectTrusted } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("ws-preset:demo", "Demo", "stored-only");
    expect(names()).toEqual(["is_project_trusted"]);
  });

  it("passes silently on a valid stored grant, without a sheet", async () => {
    const { ensureProjectTrusted } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("demo", "Demo");
    expect(names()).toEqual(["get_autorun_config", "check_project_trust"]);
  });

  it("never re-stamps a stored-only load, even for a slug trusted this session", async () => {
    const { ensureProjectTrusted, TrustDeniedError } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("demo", "Demo");
    storedGrantValid = false;
    calls.length = 0;
    await expect(ensureProjectTrusted("demo", "Demo", "stored-only")).rejects.toThrow(
      TrustDeniedError,
    );
    expect(names()).toEqual(["is_project_trusted"]);
  });

  it("re-stamps natively, without a sheet, for an edit landing while trusted in this session", async () => {
    const { ensureProjectTrusted } = await freshGate();
    storedGrantValid = true;
    await ensureProjectTrusted("demo", "Demo");
    // An outside edit moved the content fingerprint under a project this session allowed.
    storedGrantValid = false;
    calls.length = 0;
    await ensureProjectTrusted("demo", "Demo");
    expect(names()).toEqual(["check_project_trust"]);
  });

  it("asks on the next open after content changed while the project was closed", async () => {
    const { ensureProjectTrusted } = await freshGate();
    // A fresh app session: the stored grant no longer matches and nothing marked the slug trusted here.
    await ensureProjectTrusted("demo", "Demo");
    expect(names()).toEqual([
      "get_autorun_config",
      "check_project_trust",
      "request_project_trust",
      "trust_project",
    ]);
  });

  it("redeems the sheet's nonce, never a made-up one", async () => {
    const { ensureProjectTrusted } = await freshGate();
    await ensureProjectTrusted("demo", "Demo");
    const grant = calls.find((c) => c.cmd === "trust_project");
    expect(grant?.args).toEqual({ slug: "demo", nonce: "nonce-1" });
  });

  it("auto-trusts autorun launches through the same nonce path, so the headless Verify never blocks", async () => {
    const { ensureProjectTrusted } = await freshGate();
    autorunAction = "verify";
    await ensureProjectTrusted("launch-2026", "Launch 2026");
    expect(names()).toEqual([
      "get_autorun_config",
      "check_project_trust",
      "request_project_trust",
      "trust_project",
    ]);
  });

  it("never asks for a stored-only autorun (kb's headless export)", async () => {
    const { ensureProjectTrusted, NeedsTrustError, TrustDeniedError } = await freshGate();
    autorunAction = "export";
    autorunTrust = "stored-only";
    const denied = ensureProjectTrusted("demo", "Demo");
    await expect(denied).rejects.toThrow(NeedsTrustError);
    await expect(denied).rejects.not.toThrow(TrustDeniedError);
    expect(names()).not.toContain("request_project_trust");
    storedGrantValid = true;
    calls.length = 0;
    await ensureProjectTrusted("demo", "Demo");
    expect(names()).toEqual(["is_project_trusted"]);
  });

  it("throws TrustDeniedError on Don't open and asks again next time", async () => {
    const { ensureProjectTrusted, TrustDeniedError } = await freshGate();
    sheetAnswer = null;
    await expect(ensureProjectTrusted("demo", "Demo")).rejects.toThrow(TrustDeniedError);
    expect(names()).not.toContain("trust_project");
    // Declining is not remembered: a second open asks again.
    calls.length = 0;
    await expect(ensureProjectTrusted("demo", "Demo")).rejects.toThrow(TrustDeniedError);
    expect(names()).toContain("request_project_trust");
  });

  it("shares one sheet between re-entrant requests for the same slug", async () => {
    const { ensureProjectTrusted } = await freshGate();
    deferSheet = () => {};
    const first = ensureProjectTrusted("demo", "Demo");
    const second = ensureProjectTrusted("demo", "Demo");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(names().filter((c) => c === "request_project_trust")).toHaveLength(1);
    deferSheet?.();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(names().filter((c) => c === "trust_project")).toHaveLength(1);
  });
});
