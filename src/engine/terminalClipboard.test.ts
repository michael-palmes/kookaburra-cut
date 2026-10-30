import { describe, expect, it, vi } from "vitest";

// The addon module needs a browser global at import time; the provider is the whole policy.
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

const { WriteOnlyClipboardProvider } = await import("./terminalClipboard");

describe("WriteOnlyClipboardProvider", () => {
  it("writes through to the clipboard and never reads it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const readText = vi.fn(() => Promise.resolve("secret"));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText, readText } },
    });
    const provider = new WriteOnlyClipboardProvider();
    await provider.writeText("c", "hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    await expect(provider.readText()).resolves.toBe("");
    expect(readText).not.toHaveBeenCalled();
  });
});
