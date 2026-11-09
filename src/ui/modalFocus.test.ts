import { describe, expect, it } from "vitest";
import { restoreTarget, tabDirection, wrapTarget } from "./modalFocus";

const key = (
  k: string,
  mods: Partial<Record<"shiftKey" | "metaKey" | "ctrlKey" | "altKey", boolean>> = {},
) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("tabDirection", () => {
  it("reads Tab forwards and ⇧Tab backwards", () => {
    expect(tabDirection(key("Tab"))).toBe(1);
    expect(tabDirection(key("Tab", { shiftKey: true }))).toBe(-1);
  });

  it("leaves ⌃Tab, ⌥Tab, ⌘Tab and other keys to the system", () => {
    expect(tabDirection(key("Tab", { ctrlKey: true }))).toBe(0);
    expect(tabDirection(key("Tab", { altKey: true }))).toBe(0);
    expect(tabDirection(key("Tab", { metaKey: true }))).toBe(0);
    expect(tabDirection(key("Enter"))).toBe(0);
  });
});

describe("wrapTarget", () => {
  const list = ["close", "field", "cancel", "save"];

  it("wraps off either end of the layer", () => {
    expect(wrapTarget(list, "save", 1)).toBe("close");
    expect(wrapTarget(list, "close", -1)).toBe("save");
  });

  it("lets Tab move normally inside the layer", () => {
    expect(wrapTarget(list, "field", 1)).toBeNull();
    expect(wrapTarget(list, "cancel", -1)).toBeNull();
  });

  it("enters at the near end when focus is on the layer itself or lost", () => {
    expect(wrapTarget(list, null, 1)).toBe("close");
    expect(wrapTarget(list, null, -1)).toBe("save");
    expect(wrapTarget(list, "outside", 1)).toBe("close");
  });

  it("has nothing to wrap to in an empty layer", () => {
    expect(wrapTarget([], null, 1)).toBeNull();
  });
});

describe("restoreTarget", () => {
  const body = { isConnected: true };
  const opener = { isConnected: true };

  it("hands focus back to the opener once it falls to the body", () => {
    expect(restoreTarget(opener, body, body)).toBe(opener);
    expect(restoreTarget(opener, null, body)).toBe(opener);
    expect(restoreTarget(opener, { isConnected: false }, body)).toBe(opener);
  });

  it("never takes focus the app has already placed", () => {
    expect(restoreTarget(opener, { isConnected: true }, body)).toBeNull();
  });

  it("skips an opener that has left the window", () => {
    expect(restoreTarget({ isConnected: false }, body, body)).toBeNull();
    expect(restoreTarget(null, body, body)).toBeNull();
  });
});
