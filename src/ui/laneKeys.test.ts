import { describe, expect, it, vi } from "vitest";
import {
  focusAdjacentLane,
  LARGE_STEP_FRAMES,
  laneKeyIntent,
  nextAnnouncement,
  rovingIndex,
  rovingStop,
} from "./laneKeys";
import { GROUPS } from "./ShortcutsSheet";

const key = (k: string, mods: Partial<Record<"shift" | "alt" | "meta" | "ctrl", boolean>> = {}) =>
  laneKeyIntent({
    key: k,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
  });

describe("laneKeyIntent", () => {
  it("moves focus with the plain arrows, Home and End, and between lanes with Up and Down", () => {
    expect(key("ArrowLeft")).toEqual({ kind: "focus", to: "prev" });
    expect(key("ArrowRight")).toEqual({ kind: "focus", to: "next" });
    expect(key("Home")).toEqual({ kind: "focus", to: "first" });
    expect(key("End")).toEqual({ kind: "focus", to: "last" });
    expect(key("ArrowUp")).toEqual({ kind: "lane", step: -1 });
    expect(key("ArrowDown")).toEqual({ kind: "lane", step: 1 });
  });

  it("moves with ⌘, trims the start with ⌥ and the end with ⌥⌘, ⇧ for ten frames", () => {
    expect(key("ArrowLeft", { meta: true })).toEqual({ kind: "move", frames: -1 });
    expect(key("ArrowRight", { meta: true, shift: true })).toEqual({
      kind: "move",
      frames: LARGE_STEP_FRAMES,
    });
    expect(key("ArrowRight", { alt: true })).toEqual({ kind: "trim", edge: "start", frames: 1 });
    expect(key("ArrowLeft", { alt: true, meta: true, shift: true })).toEqual({
      kind: "trim",
      edge: "end",
      frames: -LARGE_STEP_FRAMES,
    });
  });

  it("selects, deletes, opens the menu and steps back out", () => {
    expect(key("Enter")).toEqual({ kind: "select" });
    expect(key(" ")).toEqual({ kind: "select" });
    expect(key("Delete")).toEqual({ kind: "delete" });
    expect(key("Backspace")).toEqual({ kind: "delete" });
    expect(key("F10", { shift: true })).toEqual({ kind: "menu" });
    expect(key("ContextMenu")).toEqual({ kind: "menu" });
    expect(key("Escape")).toEqual({ kind: "escape" });
  });

  it("never answers a bare letter, and leaves ⌃ to macOS", () => {
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      expect(key(letter)).toBeNull();
      expect(key(letter.toUpperCase(), { shift: true })).toBeNull();
    }
    expect(key("ArrowLeft", { ctrl: true })).toBeNull();
    expect(key("ArrowLeft", { shift: true })).toBeNull();
    expect(key("Backspace", { meta: true })).toBeNull();
  });
});

describe("rovingIndex", () => {
  it("steps and jumps, holding at the ends", () => {
    expect(rovingIndex(0, 4, "prev")).toBe(0);
    expect(rovingIndex(0, 4, "next")).toBe(1);
    expect(rovingIndex(3, 4, "next")).toBe(3);
    expect(rovingIndex(2, 4, "first")).toBe(0);
    expect(rovingIndex(1, 4, "last")).toBe(3);
    expect(rovingIndex(0, 0, "next")).toBe(-1);
  });
});

describe("rovingStop", () => {
  it("keeps the last focused item, else the selection, else the first", () => {
    expect(rovingStop(["a", "b", "c"], "b", "c")).toBe("b");
    expect(rovingStop(["a", "b", "c"], "gone", "c")).toBe("c");
    expect(rovingStop(["a", "b", "c"], null, null)).toBe("a");
    expect(rovingStop([], "a", "b")).toBeNull();
  });
});

describe("focusAdjacentLane", () => {
  const lane = (item: { focus: () => void } | null) => {
    const self = {
      contains: (node: unknown) => node === self || node === item,
      querySelector: () => item,
      focus: vi.fn(),
    };
    return self;
  };

  it("lands on the next lane's roving item, or the lane when it has none", () => {
    const itemA = { focus: vi.fn() };
    const itemB = { focus: vi.fn() };
    const a = lane(itemA);
    const b = lane(itemB);
    const empty = lane(null);
    const lanes = [a, b, empty] as unknown as HTMLElement[];
    expect(focusAdjacentLane(lanes, itemA as unknown as HTMLElement, 1)).toBe(true);
    expect(itemB.focus).toHaveBeenCalled();
    expect(focusAdjacentLane(lanes, itemB as unknown as HTMLElement, 1)).toBe(true);
    expect(empty.focus).toHaveBeenCalled();
    expect(focusAdjacentLane(lanes, itemA as unknown as HTMLElement, -1)).toBe(false);
  });
});

describe("nextAnnouncement", () => {
  it("changes the text so a repeat is read again", () => {
    expect(nextAnnouncement("", "Keyframe moved to 0:01.00")).toBe("Keyframe moved to 0:01.00");
    const again = nextAnnouncement("Keyframe can't move further", "Keyframe can't move further");
    expect(again).not.toBe("Keyframe can't move further");
    expect(again.trim()).toBe("Keyframe can't move further");
  });
});

describe("shortcuts sheet", () => {
  it("lists the lane keys, none of them a bare letter", () => {
    const rows = GROUPS.flatMap((group) => group.rows);
    const laneRows = rows.filter(([, what]) => /focused|Tab|lane items/.test(what));
    expect(laneRows.length).toBeGreaterThanOrEqual(14);
    for (const [keys] of laneRows) expect(keys).not.toMatch(/^[A-Z](\s|$)/);
    expect(rows.some(([keys, what]) => keys === "⌥⌘← / ⌥⌘→" && /Timeline/.test(what))).toBe(true);
  });
});
