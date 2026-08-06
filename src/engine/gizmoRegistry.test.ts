import { describe, expect, it } from "vitest";
import {
  type GizmoPickerHandle,
  gizmoPickerHandles,
  registerGizmoPicker,
  subscribeGizmoPickers,
  unregisterGizmoPicker,
} from "./gizmoRegistry";

const handle = (itemId: string): GizmoPickerHandle => ({
  domain: "objects",
  itemId,
  sceneIndex: 0,
  pickers: () => [],
});

describe("subscribeGizmoPickers", () => {
  it("fires on register and unregister, so a parked pointer's hover truth can be re-tested", () => {
    const seen: number[] = [];
    const off = subscribeGizmoPickers(() => seen.push(gizmoPickerHandles().length));
    registerGizmoPicker("k1", handle("o1"));
    registerGizmoPicker("k1", handle("o1"));
    unregisterGizmoPicker("k1");
    off();
    expect(seen).toEqual([1, 1, 0]);
  });

  it("stays quiet for an unregister that removes nothing, and after unsubscribing", () => {
    let fired = 0;
    const off = subscribeGizmoPickers(() => {
      fired += 1;
    });
    unregisterGizmoPicker("gone");
    expect(fired).toBe(0);
    off();
    registerGizmoPicker("k2", handle("o2"));
    unregisterGizmoPicker("k2");
    expect(fired).toBe(0);
  });
});
