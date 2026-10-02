import { afterEach, describe, expect, it } from "vitest";
import { canvasHandle, trackContextLosses } from "./exportBridge";
import {
  assertContextHeld,
  isBlankReadback,
  type ReadbackContext,
  readFrameOrThrow,
} from "./readback";

const W = 4;
const H = 2;

/** A drawn frame: opaque everywhere, as a scene's background clear leaves it, with varied colour bytes. */
function frame(seed: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i++) out[i] = i % 4 === 3 ? 255 : (seed + i * 7) % 256;
  return out;
}

function gpu(read: ((dst: Uint8Array) => void) | null, lost = false): ReadbackContext {
  return {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    isContextLost: () => lost,
    readPixels: ((...args: unknown[]) =>
      read?.(args[6] as Uint8Array)) as ReadbackContext["readPixels"],
  };
}

function liveCanvas(): { loseContext: () => void } {
  const canvas = new EventTarget() as HTMLCanvasElement;
  trackContextLosses(canvas);
  canvasHandle.current = { gl: { domElement: canvas } } as unknown as NonNullable<
    typeof canvasHandle.current
  >;
  return { loseContext: () => canvas.dispatchEvent(new Event("webglcontextlost")) };
}

afterEach(() => {
  canvasHandle.current = null;
});

describe("isBlankReadback", () => {
  it("flags a buffer no read ever wrote", () => {
    expect(isBlankReadback(new Uint8Array(W * H * 4))).toBe(true);
  });

  it("passes an all-black frame, whose alpha is still opaque", () => {
    const black = new Uint8Array(W * H * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    expect(isBlankReadback(black)).toBe(false);
  });

  it("passes a frame with a single written byte", () => {
    const one = new Uint8Array(W * H * 4);
    one[one.length - 1] = 1;
    expect(isBlankReadback(one)).toBe(false);
  });
});

describe("readFrameOrThrow", () => {
  it("hands on a delivered frame byte for byte", () => {
    liveCanvas();
    const drawn = frame(11);
    const rgba = frame(200);
    readFrameOrThrow(
      gpu((dst) => dst.set(drawn)),
      W,
      H,
      rgba,
      "export frame 1/1",
    );
    expect(Array.from(rgba)).toEqual(Array.from(drawn));
  });

  it("fails a read that never lands instead of repeating the reused buffer's last frame", () => {
    liveCanvas();
    const rgba = frame(42);
    expect(() => readFrameOrThrow(gpu(null), W, H, rgba, "export frame 7/9")).toThrow(
      /GPU stalled \(export frame 7\/9\): readPixels returned an all-zero frame.*rerun/,
    );
  });

  it("fails when the context is lost during the read", () => {
    liveCanvas();
    const rgba = new Uint8Array(W * H * 4);
    expect(() => readFrameOrThrow(gpu(null, true), W, H, rgba, "export frame 3/9")).toThrow(
      /GPU stalled \(export frame 3\/9\): the WebGL context was lost.*quit and reopen/,
    );
  });

  it("fails a delivered frame from a context that was lost and restored mid-run", () => {
    const canvas = liveCanvas();
    canvas.loseContext();
    const drawn = frame(5);
    expect(() =>
      readFrameOrThrow(
        gpu((dst) => dst.set(drawn)),
        W,
        H,
        new Uint8Array(drawn.length),
        "f",
      ),
    ).toThrow(/context was lost/);
  });
});

describe("assertContextHeld", () => {
  it("passes a canvas that never lost its context", () => {
    liveCanvas();
    expect(() => assertContextHeld(gpu(null), "before the export")).not.toThrow();
  });

  it("refuses a canvas that lost its context earlier in the session", () => {
    liveCanvas().loseContext();
    expect(() => assertContextHeld(gpu(null), "before the export")).toThrow(
      /GPU stalled \(before the export\)/,
    );
  });

  it("counts losses per canvas, so a reopened canvas starts clean", () => {
    liveCanvas().loseContext();
    liveCanvas();
    expect(() => assertContextHeld(gpu(null), "before the export")).not.toThrow();
  });

  it("stops counting once the canvas is untracked", () => {
    const canvas = new EventTarget() as HTMLCanvasElement;
    const untrack = trackContextLosses(canvas);
    canvasHandle.current = { gl: { domElement: canvas } } as unknown as NonNullable<
      typeof canvasHandle.current
    >;
    untrack();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(() => assertContextHeld(gpu(null), "before the export")).not.toThrow();
  });
});
