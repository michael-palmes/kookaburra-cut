import { beforeEach, describe, expect, it } from "vitest";
import {
  bindHistory,
  type HistoryEntry,
  peekRedo,
  peekUndo,
  pushHistory,
  restoreCursorAfterFailedUndo,
  takeRedo,
  takeUndo,
} from "./history";

function entry(label: string): HistoryEntry {
  return {
    label,
    changes: [
      { kind: "manifest", slug: "p", before: `{"b":"${label}"}`, after: "{}", reload: false },
    ],
  };
}

function entryFor(slug: string, label: string): HistoryEntry {
  return {
    label,
    changes: [{ kind: "manifest", slug, before: "{}", after: "{}", reload: false }],
  };
}

describe("history (v12 · M2.5)", () => {
  beforeEach(() => {
    bindHistory(null);
    bindHistory("ws:test");
  });

  it("undoes and redoes in order", () => {
    pushHistory(entry("one"));
    pushHistory(entry("two"));
    expect(takeUndo()?.label).toBe("two");
    expect(takeUndo()?.label).toBe("one");
    expect(takeUndo()).toBeNull();
    expect(takeRedo()?.label).toBe("one");
    expect(takeRedo()?.label).toBe("two");
    expect(takeRedo()).toBeNull();
  });

  it("a new edit truncates the redo tail (branching)", () => {
    pushHistory(entry("one"));
    pushHistory(entry("two"));
    takeUndo();
    pushHistory(entry("three"));
    expect(peekRedo()).toBeNull();
    expect(takeUndo()?.label).toBe("three");
    expect(takeUndo()?.label).toBe("one");
  });

  it("caps at 50 entries, oldest first", () => {
    for (let i = 0; i < 60; i++) pushHistory(entry(`e${i}`));
    let count = 0;
    let last: string | undefined;
    for (let e = takeUndo(); e; e = takeUndo()) {
      count++;
      last = e.label;
    }
    expect(count).toBe(50);
    expect(last).toBe("e10");
  });

  it("clears on a REAL project switch only", () => {
    pushHistory(entry("one"));
    bindHistory("ws:test"); // same id - keeps
    expect(peekUndo()?.label).toBe("one");
    bindHistory("ws:other");
    expect(peekUndo()).toBeNull();
  });

  it("an edit that completes after a project switch is dropped, not filed under the new project", () => {
    bindHistory(null);
    bindHistory("ws:a", "a");
    pushHistory(entryFor("a", "in a"));
    expect(peekUndo()?.label).toBe("in a");
    bindHistory("ws:b", "b");
    pushHistory(entryFor("a", "late from a"));
    expect(peekUndo()).toBeNull();
    pushHistory(entryFor("b", "in b"));
    expect(peekUndo()?.label).toBe("in b");
  });

  it("a compound entry touching another project is dropped whole", () => {
    bindHistory(null);
    bindHistory("ws:b", "b");
    pushHistory({
      label: "mixed",
      changes: [...entryFor("b", "").changes, ...entryFor("a", "").changes],
    });
    expect(peekUndo()).toBeNull();
  });

  it("a binding without a slug accepts every project's edits", () => {
    bindHistory(null);
    bindHistory("ws:c");
    pushHistory(entryFor("a", "unfenced"));
    expect(peekUndo()?.label).toBe("unfenced");
  });

  it("empty entries are ignored", () => {
    pushHistory({ label: "noop", changes: [] });
    expect(peekUndo()).toBeNull();
  });

  it("a failed undo puts the cursor back", () => {
    pushHistory(entry("one"));
    expect(takeUndo()?.label).toBe("one");
    restoreCursorAfterFailedUndo();
    expect(peekUndo()?.label).toBe("one");
    expect(peekRedo()).toBeNull();
  });
});
