import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ContextLoss,
  glContextCensus,
  installGlContextCensus,
  onGlContextLoss,
  resetGlContextCensus,
  tagGlCanvas,
  WEBGL_CONTEXT_CAP,
} from "./glContexts";

class FakeGL {
  readonly extension = { loseContext: () => this.canvas.lose() };
  constructor(readonly canvas: FakeCanvas) {}
  getExtension(name: string) {
    return name.toLowerCase() === "webgl_lose_context" ? this.extension : null;
  }
}

class FakeCanvas extends EventTarget {
  width = 16;
  height = 16;
  isConnected = true;
  context: FakeGL | null = null;
  calls: unknown[][] = [];
  getContext(...args: unknown[]): unknown {
    this.calls.push(args);
    if (args[0] === "2d") return { kind: "2d" };
    this.context ??= new FakeGL(this);
    return this.context;
  }
  lose() {
    this.dispatchEvent(new Event("webglcontextlost"));
  }
}

const open = (n: number) =>
  Array.from({ length: n }, () => {
    const canvas = new FakeCanvas();
    canvas.getContext("webgl2");
    return canvas;
  });

beforeAll(() => {
  installGlContextCensus({ HTMLCanvasElement: FakeCanvas, WebGL2RenderingContext: FakeGL });
});

afterEach(() => {
  resetGlContextCensus();
  vi.restoreAllMocks();
});

describe("the WebGL context census", () => {
  it("passes getContext straight through: same arguments in, same context out", () => {
    const canvas = new FakeCanvas();
    const attributes = { preserveDrawingBuffer: true, antialias: true };
    const context = canvas.getContext("webgl2", attributes);
    expect(context).toBe(canvas.context);
    expect(canvas.calls).toEqual([["webgl2", attributes]]);
    expect(canvas.calls[0][1]).toBe(attributes);
    expect(canvas.getContext("webgl2")).toBe(context);
    expect(canvas.getContext("2d")).toEqual({ kind: "2d" });
    const census = glContextCensus();
    expect(census).toMatchObject({ cap: 16, live: 1, lost: 0, deliberate: 0 });
    expect(census.contexts).toEqual([
      expect.objectContaining({
        owner: "canvas",
        api: "webgl2",
        width: 16,
        height: 16,
        lost: false,
      }),
    ]);
    installGlContextCensus({ HTMLCanvasElement: FakeCanvas, WebGL2RenderingContext: FakeGL });
    new FakeCanvas().getContext("webgl2");
    expect(glContextCensus().live).toBe(2);
  });

  it("counts our own loseContext as deliberate", () => {
    const [canvas] = open(1);
    tagGlCanvas(canvas, "stage");
    const seen: ContextLoss[] = [];
    const off = onGlContextLoss((loss) => seen.push(loss));
    canvas.context?.getExtension("WEBGL_lose_context")?.loseContext();
    off();
    expect(seen).toEqual([{ owner: "stage", api: "webgl2", lossClass: "deliberate", live: 1 }]);
    expect(glContextCensus()).toMatchObject({ live: 0, lost: 0, deliberate: 1, gpuLosses: 0 });
  });

  it("reads a single unexpected loss at the cap as WebKit's eviction", () => {
    const canvases = open(WEBGL_CONTEXT_CAP + 1);
    canvases[0].lose();
    expect(glContextCensus()).toMatchObject({ live: 16, evictions: 1, gpuLosses: 0, lost: 1 });
  });

  it("reads a loss below the cap, or two within a second, as a GPU loss", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const canvases = open(WEBGL_CONTEXT_CAP);
    canvases[0].lose();
    expect(glContextCensus()).toMatchObject({ evictions: 1, gpuLosses: 0 });
    now.mockReturnValue(1500);
    canvases[1].lose();
    expect(glContextCensus()).toMatchObject({ evictions: 0, gpuLosses: 2, lost: 2 });
    now.mockReturnValue(5000);
    canvases[2].lose();
    expect(glContextCensus()).toMatchObject({ evictions: 0, gpuLosses: 3 });
    resetGlContextCensus();
    const [few] = open(3);
    few.lose();
    expect(glContextCensus()).toMatchObject({ live: 2, evictions: 0, gpuLosses: 1 });
  });
});
