import { beforeEach, describe, expect, it, vi } from "vitest";

let answer: (() => Promise<unknown>) | null = null;
const calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (!answer) throw new Error(`unexpected command ${cmd}`);
    return answer();
  }),
}));

async function fresh() {
  vi.resetModules();
  return import("./managed");
}

beforeEach(() => {
  calls.length = 0;
  answer = null;
});

describe("managed refusals", () => {
  it("recognises the marker Rust puts on every policy refusal", async () => {
    const m = await fresh();
    expect(
      m.isManagedRefusal("managed: Claude is turned off by your organisation (DisableClaude)."),
    ).toBe(true);
    expect(m.isManagedRefusal(new Error("managed: Update checks are turned off"))).toBe(true);
    expect(m.isManagedRefusal("Claude Code is not installed")).toBe(false);
    expect(m.isManagedRefusal("")).toBe(false);
  });

  it("shows a refusal without its marker and other errors as they came", async () => {
    const m = await fresh();
    expect(
      m.plainError(
        "managed: Live websites are turned off by your organisation (DisableLiveWebsites).",
      ),
    ).toBe("Live websites are turned off by your organisation (DisableLiveWebsites).");
    expect(m.plainError("website URL is invalid")).toBe("website URL is invalid");
  });
});

describe("managed policy read", () => {
  it("asks once per window and hands every caller the same answer", async () => {
    const m = await fresh();
    answer = async () => ({
      ...m.UNMANAGED,
      managed: true,
      disableClaude: true,
      forcedKeys: ["DisableClaude"],
    });
    expect(m.managedPolicyNow()).toBeNull();
    const [a, b] = await Promise.all([m.managedPolicy(), m.managedPolicy()]);
    expect(a).toBe(b);
    expect(a.disableClaude).toBe(true);
    expect(calls).toEqual(["managed_policy"]);
    expect(m.managedPolicyNow()).toBe(a);
  });

  it("fails closed when the policy cannot be read", async () => {
    const m = await fresh();
    answer = async () => {
      throw new Error("ipc unavailable");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = await m.managedPolicy();
    expect(policy).toEqual(m.LOCKED_DOWN);
    expect(policy.disableClaude && policy.disableLiveWebsites && policy.disableUpdateCheck).toBe(
      true,
    );
    expect(policy.allowedPublisherKeyIds).toEqual([]);
    warn.mockRestore();
  });

  it("reads every field as off on an unmanaged Mac", async () => {
    const m = await fresh();
    answer = async () => m.UNMANAGED;
    const policy = await m.managedPolicy();
    expect(policy.managed).toBe(false);
    expect(policy.disableClaude).toBe(false);
    expect(policy.workspaceRootLocked).toBe(false);
    expect(policy.allowedPublisherKeyIds).toBeNull();
  });
});
