import { beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: captures.invoke }));

import { sampleScreenColour } from "./screenSampler";

beforeEach(() => {
  captures.invoke.mockReset();
});

describe("sampleScreenColour", () => {
  it("normalises what the sampler returns", async () => {
    captures.invoke.mockResolvedValue("#FF00AA");
    expect(await sampleScreenColour()).toBe("#ff00aa");
    captures.invoke.mockResolvedValue("#abc");
    expect(await sampleScreenColour()).toBe("#aabbcc");
  });

  it("treats a cancelled sample as no pick, without an error", async () => {
    captures.invoke.mockResolvedValue(null);
    const onError = vi.fn();
    expect(await sampleScreenColour(onError)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects an answer that is not a hex", async () => {
    captures.invoke.mockResolvedValue("nope");
    expect(await sampleScreenColour()).toBeNull();
  });

  it("reports a failed invoke instead of throwing", async () => {
    captures.invoke.mockRejectedValue(new Error("sampler unavailable"));
    const onError = vi.fn();
    expect(await sampleScreenColour(onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith("Error: sampler unavailable");
  });
});
