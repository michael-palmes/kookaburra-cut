import { describe, expect, it } from "vitest";
import { TransitionWriteQueue } from "./transitionWriteQueue";

describe("TransitionWriteQueue", () => {
  it("persists rapid choices in selection order", async () => {
    const queue = new TransitionWriteQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    const second = queue.enqueue(async () => {
      events.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("recovers after a rejected write and can settle before Apply to all", async () => {
    const queue = new TransitionWriteQueue();
    await expect(
      queue.enqueue(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await expect(queue.enqueue(async () => {})).resolves.toBeUndefined();
    await expect(queue.settle()).resolves.toBeUndefined();
  });
});
