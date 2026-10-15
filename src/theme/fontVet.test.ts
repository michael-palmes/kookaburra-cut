import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { describeFontError, vetFontBuffer } from "./fontVet";

beforeAll(() => {
  // Typr's factory aliases `window` to `self`, which node lacks.
  (globalThis as { self?: unknown }).self ??= globalThis;
});

const bytes = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe("vetFontBuffer", () => {
  it("passes the bundled faces through troika's own parser", async () => {
    for (const name of [
      "Inter-Regular.woff",
      "JetBrainsMono-Regular.woff",
      "KookaburraFallback.otf",
    ]) {
      expect(await vetFontBuffer(bytes(name))).toEqual({ ok: true });
    }
  });

  it("rejects a face troika cannot parse, with the parser's own words", async () => {
    const woff2 = new Uint8Array(64);
    woff2.set([0x77, 0x4f, 0x46, 0x32]);
    expect(await vetFontBuffer(woff2.buffer)).toEqual({
      ok: false,
      error: "woff2 fonts not supported",
    });
    const truncated = bytes("Inter-Regular.woff").slice(0, 200);
    expect((await vetFontBuffer(truncated)).ok).toBe(false);
  });
});

describe("describeFontError", () => {
  it("keeps Typr's bare string throws readable", () => {
    expect(describeFontError("unknown cmap table format 6")).toBe("unknown cmap table format 6");
    expect(describeFontError(new TypeError("x is null"))).toBe("x is null");
  });
});
