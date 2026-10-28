import { Texture, TextureLoader } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberWorkspaceLibraryPath } from "../../engine/project";
import { type NativePort, setNativePort } from "../../engine/stageRealm";
import { preloadEmojiRasters } from "./emojiRaster";

const emojiRead = vi.fn<NativePort["emojiRead"]>(async () => null);
const emojiWrite = vi.fn<NativePort["emojiWrite"]>(async () => {});
setNativePort({ emojiRead, emojiWrite } as unknown as NativePort);

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
  emojiRead.mockResolvedValue(null);
  vi.stubGlobal("document", { createElement: createCanvas });
  vi.spyOn(TextureLoader.prototype, "loadAsync").mockImplementation(async () => new Texture());
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
      expect(emojiWrite).toHaveBeenCalledExactlyOnceWith(id, `${key}@320`, png);
    } else {
      expect(emojiWrite).not.toHaveBeenCalled();
    }
  });

  it("uses the frozen raster without generating or writing new bytes", async () => {
    emojiRead.mockResolvedValue(png.buffer.slice(0));
    await preloadEmojiRasters("preset:titleicon", [{ version: 1, text: { title: "🦜" } }]);
    expect(emojiRead).toHaveBeenCalledWith("preset:titleicon", "1f99c@320.png");
    expect(TextureLoader.prototype.loadAsync).toHaveBeenCalledWith(
      expect.stringContaining("blob:"),
    );
    expect(createCanvas).not.toHaveBeenCalled();
    expect(emojiWrite).not.toHaveBeenCalled();
  });
});
