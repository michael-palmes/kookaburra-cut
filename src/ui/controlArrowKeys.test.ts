import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrowForControlCode, moveCaret, normaliseControlArrow } from "./controlArrowKeys";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const read = (path: string) =>
  testProcess.getBuiltinModule("fs").readFileSync(new URL(path, import.meta.url), "utf8");

class FakeKeyboardEvent {
  type: string;
  key: string;
  shiftKey = false;
  altKey = false;
  metaKey = false;
  ctrlKey = false;
  defaultPrevented = false;
  constructor(type: string, init: Record<string, unknown>) {
    this.type = type;
    this.key = init.key as string;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function field(value: string, start: number, end = start, tagName = "INPUT") {
  const el = {
    tagName,
    value,
    selectionStart: start,
    selectionEnd: end,
    selectionDirection: "forward" as "forward" | "backward" | "none",
    setSelectionRange(s: number, e: number, d: "forward" | "backward" | "none" = "forward") {
      el.selectionStart = s;
      el.selectionEnd = e;
      el.selectionDirection = d;
    },
    replays: [] as FakeKeyboardEvent[],
    handle: undefined as ((e: FakeKeyboardEvent) => void) | undefined,
    dispatchEvent(e: FakeKeyboardEvent) {
      el.replays.push(e);
      el.handle?.(e);
      return !e.defaultPrevented;
    },
  };
  return el;
}

function press(target: ReturnType<typeof field>, key: string, mods: Record<string, boolean> = {}) {
  const e = {
    key,
    target,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
  normaliseControlArrow(e as unknown as KeyboardEvent);
  return e;
}

beforeEach(() => vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent));
afterEach(() => vi.unstubAllGlobals());

describe("arrows sent as control codes (2.1.1)", () => {
  it("maps the four Mac control codes and nothing else", () => {
    expect(["\u001c", "\u001d", "\u001e", "\u001f"].map(arrowForControlCode)).toEqual([
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
    ]);
    for (const key of ["ArrowLeft", "a", "\u001b", ""]) {
      expect(arrowForControlCode(key), key).toBeUndefined();
    }
  });

  it("types nothing, replays the real arrow and moves the caret", () => {
    const el = field("0:04", 4);
    const e = press(el, "\u001c");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(el.value).toBe("0:04");
    expect(el.replays.map((r) => r.key)).toEqual(["ArrowLeft"]);
    expect(el.selectionStart).toBe(3);
    press(el, "\u001d");
    expect(el.selectionStart).toBe(4);
  });

  it("leaves the caret to a handler that takes the replayed arrow", () => {
    const el = field("12", 1);
    el.handle = (r) => r.preventDefault();
    press(el, "\u001e");
    expect(el.selectionStart).toBe(1);
  });

  it("lets real arrows through untouched", () => {
    const el = field("0:04", 2);
    const e = press(el, "ArrowLeft");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(el.replays).toEqual([]);
  });

  it("carries the modifiers, so lane and editor shortcuts still work", () => {
    const el = field("", 0);
    press(el, "\u001d", { metaKey: true, shiftKey: true });
    expect(el.replays[0]).toMatchObject({ key: "ArrowRight", metaKey: true, shiftKey: true });
  });

  it("is installed in every chrome window, ahead of every other key listener", () => {
    expect(read("./chromePrefs.ts")).toMatch(
      /installed = true;\s*installControlArrowKeys\(\);\s*document\.addEventListener\("keydown", guardSingleKeyShortcuts\);/,
    );
    expect(read("./controlArrowKeys.ts")).toContain(
      'window.addEventListener("keydown", normaliseControlArrow, true);',
    );
  });
});

describe("caret moves", () => {
  it("collapses a selection, extends with ⇧ and jumps with ⌘", () => {
    const el = field("abcdef", 1, 4);
    moveCaret(el, "ArrowLeft", false, false);
    expect([el.selectionStart, el.selectionEnd]).toEqual([1, 1]);
    moveCaret(el, "ArrowRight", true, false);
    moveCaret(el, "ArrowRight", true, false);
    expect([el.selectionStart, el.selectionEnd, el.selectionDirection]).toEqual([1, 3, "forward"]);
    moveCaret(el, "ArrowRight", false, true);
    expect(el.selectionStart).toBe(6);
    moveCaret(el, "ArrowLeft", false, false);
    moveCaret(el, "ArrowLeft", true, true);
    expect([el.selectionStart, el.selectionEnd, el.selectionDirection]).toEqual([0, 5, "backward"]);
  });

  it("sends ↑ and ↓ to a one-line field's ends and keeps the column in a text area", () => {
    const line = field("0:04", 2);
    moveCaret(line, "ArrowUp", false, false);
    expect(line.selectionStart).toBe(0);
    moveCaret(line, "ArrowDown", false, false);
    expect(line.selectionStart).toBe(4);
    const area = field("one\nlonger\nab", 2, 2, "TEXTAREA");
    moveCaret(area, "ArrowDown", false, false);
    expect(area.selectionStart).toBe(6);
    moveCaret(area, "ArrowDown", false, false);
    expect(area.selectionStart).toBe(13);
    moveCaret(area, "ArrowUp", false, false);
    expect(area.selectionStart).toBe(6);
  });
});
