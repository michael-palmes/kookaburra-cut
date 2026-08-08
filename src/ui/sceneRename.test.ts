import { describe, expect, it } from "vitest";
import { canOpenSceneMenu, nextRename, renameCommit } from "./sceneRename";

const scenes = [
  { index: 0, name: "Opening", hasDoc: true },
  { index: 1, name: "Features", hasDoc: true },
  { index: 2, name: "Legacy", hasDoc: false },
];

const idle = { busy: false, renaming: null, timing: null };

describe("nextRename", () => {
  it("starts a rename from the saved name", () => {
    expect(nextRename(scenes[1], idle)).toEqual({ index: 1, text: "Features" });
  });

  it("refuses rows with no sidecar doc, and every row while busy", () => {
    expect(nextRename(scenes[2], idle)).toBeNull();
    expect(nextRename(scenes[0], { ...idle, busy: true })).toBeNull();
  });

  it("leaves the typed text alone when the row is already renaming", () => {
    const renaming = { index: 1, text: "Featur" };
    expect(nextRename(scenes[1], { ...idle, renaming })).toBeNull();
  });

  it("refuses a row holding a live duration field", () => {
    expect(nextRename(scenes[1], { ...idle, timing: { index: 1, text: "2.00" } })).toBeNull();
  });

  it("still starts on other rows while one is renaming", () => {
    const renaming = { index: 1, text: "Featur" };
    expect(nextRename(scenes[0], { ...idle, renaming })).toEqual({ index: 0, text: "Opening" });
  });
});

describe("renameCommit", () => {
  it("commits the trimmed text", () => {
    expect(renameCommit({ index: 1, text: "  Highlights " }, scenes, true)).toEqual({
      index: 1,
      name: "Highlights",
    });
  });

  it("writes nothing when the edit is cancelled", () => {
    expect(renameCommit({ index: 1, text: "Highlights" }, scenes, false)).toBeNull();
    expect(renameCommit(null, scenes, true)).toBeNull();
  });

  it("writes nothing for a blank or unchanged name", () => {
    expect(renameCommit({ index: 1, text: "   " }, scenes, true)).toBeNull();
    expect(renameCommit({ index: 1, text: "Features" }, scenes, true)).toBeNull();
    expect(renameCommit({ index: 1, text: " Features " }, scenes, true)).toBeNull();
  });
});

describe("canOpenSceneMenu", () => {
  it("opens on an idle row", () => {
    expect(canOpenSceneMenu(1, idle)).toBe(true);
  });

  it("stands aside for the row being renamed, and for a live duration field", () => {
    expect(canOpenSceneMenu(1, { ...idle, renaming: { index: 1, text: "Featur" } })).toBe(false);
    expect(canOpenSceneMenu(1, { ...idle, timing: { index: 1, text: "2.00" } })).toBe(false);
  });

  it("still opens on other rows while one is renaming", () => {
    expect(canOpenSceneMenu(0, { ...idle, renaming: { index: 1, text: "Featur" } })).toBe(true);
  });

  it("stays shut while an op is in flight", () => {
    expect(canOpenSceneMenu(1, { ...idle, busy: true })).toBe(false);
  });
});
