import { invoke } from "@tauri-apps/api/core";
import { Texture, TextureLoader } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberWorkspaceLibraryPath } from "../../engine/project";
import { preloadEmojiRasters } from "./emojiRaster";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const createCanvas = vi.fn(() => ({
  getContext: () => ({
    fillText: vi.fn(),
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  }),
  toBlob: (done: (blob: Blob) => void) => done(new Blob([png], { type: "image/png" })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.stubGlobal("document", { createElement: createCanvas });
  vi.spyOn(TextureLoader.prototype, "loadAsync").mockImplementation(async (url) => {
    if (url.startsWith("asset:")) throw new Error("cache missing");
    return new Texture();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("emoji raster persistence", () => {
  it.each([
    [true, "preset:titleicon", "🚀", "1f680", true],
    [true, "template:blank", "🌿", "1f33f", true],
    [false, "preset:titleicon", "🎬", "1f3ac", false],
    [false, "template:blank", "🧩", "1f9e9", false],
    [true, "showcase-tour", "✨", "2728", false],
    [false, "ws-preset:my-preset", "🌈", "1f308", true],
  ] as const)("dev=%s %s persists=%s", async (dev, id, emoji, key, persists) => {
    vi.stubEnv("DEV", dev);
    rememberWorkspaceLibraryPath("ws-preset:my-preset", "/workspace/presets/my-preset");
    await preloadEmojiRasters(id, [{ version: 1, text: { title: emoji } }]);
    expect(createCanvas).toHaveBeenCalled();
    if (persists) {
      expect(invoke).toHaveBeenCalledExactlyOnceWith("write_emoji_raster", png, {
        headers: {
          "x-kookaburra-slug": id,
          "x-kookaburra-key": `${key}@320`,
        },
      });
    } else {
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it("uses the frozen raster without generating or writing new bytes", async () => {
    vi.mocked(TextureLoader.prototype.loadAsync).mockResolvedValue(new Texture());
    await preloadEmojiRasters("preset:titleicon", [{ version: 1, text: { title: "🦜" } }]);
    expect(TextureLoader.prototype.loadAsync).toHaveBeenCalledWith(
      expect.stringContaining("/presets/titleicon/assets/.emoji-cache/1f99c@320.png"),
    );
    expect(createCanvas).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
