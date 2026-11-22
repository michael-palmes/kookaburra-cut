import { afterEach, describe, expect, it, vi } from "vitest";

async function freshPump() {
  vi.resetModules();
  const pump = await import("./framePump");
  const native: FrameRequestCallback[] = [];
  const asks: number[] = [];
  const scope = {
    requestAnimationFrame: (cb: FrameRequestCallback) => native.push(cb),
    cancelAnimationFrame: (_id: number) => {},
  };
  pump.installFramePump(scope, () => asks.push(asks.length));
  return { pump, scope, native, asks };
}

afterEach(() => vi.restoreAllMocks());

describe("the stage's frame pump", () => {
  it("draws a waiting frame on the window's tick when the worker's own never fires", async () => {
    const { pump, scope, asks } = await freshPump();
    const draw = vi.fn();
    scope.requestAnimationFrame(draw);
    expect(asks).toHaveLength(1);
    pump.fireFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    pump.fireFrame();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("asks the window once however many callbacks wait", async () => {
    const { pump, scope, asks } = await freshPump();
    const a = vi.fn();
    const b = vi.fn();
    scope.requestAnimationFrame(a);
    scope.requestAnimationFrame(b);
    expect(asks).toHaveLength(1);
    pump.fireFrame();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("falls back to the worker's own frame when the window sends none", async () => {
    const { scope, native } = await freshPump();
    const draw = vi.fn();
    scope.requestAnimationFrame(draw);
    native[0](0);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("draws once per display interval whichever source ticks, and keeps the early one waiting", async () => {
    const { pump, scope, asks } = await freshPump();
    const now = vi.spyOn(performance, "now");
    const draw = vi.fn();
    now.mockReturnValue(100);
    scope.requestAnimationFrame(draw);
    pump.fireFrame();
    scope.requestAnimationFrame(draw);
    now.mockReturnValue(105);
    pump.fireFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(asks).toHaveLength(3);
    now.mockReturnValue(117);
    pump.fireFrame();
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("never draws a cancelled frame", async () => {
    const { pump, scope } = await freshPump();
    const draw = vi.fn();
    scope.cancelAnimationFrame(scope.requestAnimationFrame(draw));
    pump.fireFrame();
    expect(draw).not.toHaveBeenCalled();
  });
});
