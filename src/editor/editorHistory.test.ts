import { beforeEach, describe, expect, it } from "vitest";
import type { EditDoc } from "../engine/edit";
import {
  bindEditorHistory,
  closeEditorHistoryCoalescing,
  EXTERNAL_EDIT_LABEL,
  pushEditorHistory,
  pushExternalEditorHistory,
  takeEditorRedo,
  takeEditorUndo,
} from "./editorHistory";

const doc = (name: string, speed = 1): EditDoc => ({
  version: 1,
  name,
  sources: [],
  settings: { width: 1920, height: 1080, fps: 60 },
  clips: [{ id: "c1", sourceId: "s1", inMs: 0, outMs: 1000, speed, startMs: 0 }],
});

describe("editorHistory", () => {
  beforeEach(() => {
    bindEditorHistory(null, null);
    bindEditorHistory("ws:demo", "hero");
  });

  it("undoes and redoes whole edit-document snapshots", () => {
    pushEditorHistory({ label: "change speed", before: doc("hero"), after: doc("hero", 2) });
    expect(takeEditorUndo()).toMatchObject({ label: "change speed", before: { name: "hero" } });
    expect(takeEditorUndo()).toBeNull();
    expect(takeEditorRedo()?.after.clips[0].speed).toBe(2);
  });

  it("truncates redo when a new edit branches", () => {
    pushEditorHistory({ label: "one", before: doc("hero"), after: doc("hero", 2) });
    pushEditorHistory({ label: "two", before: doc("hero", 2), after: doc("hero", 4) });
    takeEditorUndo();
    pushEditorHistory({ label: "three", before: doc("hero", 2), after: doc("hero", 6) });
    expect(takeEditorRedo()).toBeNull();
    expect(takeEditorUndo()?.label).toBe("three");
    expect(takeEditorUndo()?.label).toBe("one");
  });

  it("caps history at 50 entries", () => {
    for (let i = 0; i < 60; i++) {
      pushEditorHistory({ label: `e${i}`, before: doc("hero", i + 1), after: doc("hero", i + 2) });
    }
    const labels: string[] = [];
    for (let entry = takeEditorUndo(); entry; entry = takeEditorUndo()) labels.push(entry.label);
    expect(labels).toHaveLength(50);
    expect(labels.at(-1)).toBe("e10");
  });

  it("resets only when the slug or edit name changes", () => {
    pushEditorHistory({ label: "one", before: doc("hero"), after: doc("hero", 2) });
    bindEditorHistory("ws:demo", "hero");
    expect(takeEditorUndo()?.label).toBe("one");
    bindEditorHistory("ws:demo", "outro");
    expect(takeEditorUndo()).toBeNull();
    pushEditorHistory({ label: "two", before: doc("outro"), after: doc("outro", 2) });
    bindEditorHistory("ws:other", "outro");
    expect(takeEditorUndo()).toBeNull();
  });

  it("coalesces one continuous control gesture and separates the next", () => {
    pushEditorHistory({
      label: "resize tap",
      before: doc("hero", 1),
      after: doc("hero", 2),
      coalesceKey: "tap-size",
    });
    pushEditorHistory({
      label: "resize tap",
      before: doc("hero", 2),
      after: doc("hero", 3),
      coalesceKey: "tap-size",
    });
    expect(takeEditorUndo()?.after.clips[0].speed).toBe(3);
    expect(takeEditorUndo()).toBeNull();

    bindEditorHistory(null, null);
    bindEditorHistory("ws:demo", "hero");
    pushEditorHistory({
      label: "resize tap",
      before: doc("hero", 1),
      after: doc("hero", 2),
      coalesceKey: "tap-size",
    });
    closeEditorHistoryCoalescing();
    pushEditorHistory({
      label: "resize tap",
      before: doc("hero", 2),
      after: doc("hero", 3),
      coalesceKey: "tap-size",
    });
    expect(takeEditorUndo()?.before.clips[0].speed).toBe(2);
    expect(takeEditorUndo()?.before.clips[0].speed).toBe(1);
  });

  it("records an outside change as exactly one step that never coalesces", () => {
    const sized = (size: number) => ({ ...doc("hero"), tapSize: size });
    pushEditorHistory({
      label: "resize tap",
      before: sized(1),
      after: sized(2),
      coalesceKey: "tap-size",
    });
    // The outside change lands mid-gesture (keyboard nudges on the slider never close it).
    pushExternalEditorHistory(sized(2), { ...sized(2), clips: doc("hero", 4).clips });
    pushEditorHistory({
      label: "resize tap",
      before: { ...sized(2), clips: doc("hero", 4).clips },
      after: { ...sized(3), clips: doc("hero", 4).clips },
      coalesceKey: "tap-size",
    });
    expect(takeEditorUndo()).toMatchObject({ label: "resize tap", after: { tapSize: 3 } });
    const outside = takeEditorUndo();
    expect(outside?.label).toBe(EXTERNAL_EDIT_LABEL);
    expect(outside?.before.clips[0].speed).toBe(1);
    expect(outside?.after.clips[0].speed).toBe(4);
    expect(takeEditorUndo()).toMatchObject({ label: "resize tap", before: { tapSize: 1 } });
    expect(takeEditorUndo()).toBeNull();
  });

  it("keeps two outside changes in a row as two steps, and skips one that changed nothing", () => {
    pushExternalEditorHistory(doc("hero", 1), doc("hero", 2));
    pushExternalEditorHistory(doc("hero", 2), doc("hero", 3));
    pushExternalEditorHistory(doc("hero", 3), doc("hero", 3));
    expect(takeEditorUndo()?.before.clips[0].speed).toBe(2);
    expect(takeEditorUndo()?.before.clips[0].speed).toBe(1);
    expect(takeEditorUndo()).toBeNull();
  });
});
