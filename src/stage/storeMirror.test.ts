import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { mirrorStores } from "./storeMirror";

type Clock = { currentMs: number };

describe("mirrorStores apply", () => {
  it("reaches every listener when one throws once, without echoing the patch", () => {
    const clock = createStore<Clock>(() => ({ currentMs: 0 }));
    const send = vi.fn();
    const mirror = mirrorStores({ clock: clock as never }, send);
    let throws = 1;
    clock.subscribe(() => {
      if (throws-- > 0) throw new Error("Maximum update depth exceeded");
    });
    const seen: number[] = [];
    clock.subscribe((s) => seen.push(s.currentMs));

    mirror.apply("clock", { currentMs: 120 });

    expect(clock.getState().currentMs).toBe(120);
    expect(seen).toEqual([120]);
    expect(send).not.toHaveBeenCalled();
    clock.setState({ currentMs: 140 });
    expect(send).toHaveBeenCalledWith("clock", { currentMs: 140 });
  });

  it("still fails when the error persists", () => {
    const clock = createStore<Clock>(() => ({ currentMs: 0 }));
    const mirror = mirrorStores({ clock: clock as never }, vi.fn());
    clock.subscribe(() => {
      throw new Error("broken listener");
    });

    expect(() => mirror.apply("clock", { currentMs: 120 })).toThrow("broken listener");
  });
});
