import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "./ContextMenu";
import { sceneMenuItems, sceneSelectionLabel } from "./sceneMenu";

type SceneMenuOptions = Parameters<typeof sceneMenuItems>[0];

function items(overrides: Partial<SceneMenuOptions> = {}) {
  return sceneMenuItems({
    canRename: true,
    canDelete: true,
    hasClipboard: true,
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onDuration: vi.fn(),
    onCopyBackground: vi.fn(),
    onPasteBackground: vi.fn(),
    onDelete: vi.fn(),
    onCopyToProject: vi.fn(),
    ...overrides,
  });
}

function item(entries: ReturnType<typeof items>, id: string): ContextMenuItem {
  const found = entries.find((e) => e !== "separator" && e.id === id);
  if (!found || found === "separator") throw new Error(`no ${id} item`);
  return found;
}

describe("sceneSelectionLabel", () => {
  it("keeps the bare verb for one scene", () => {
    expect(sceneSelectionLabel("Delete", 1)).toBe("Delete");
    expect(sceneSelectionLabel("Delete", 0)).toBe("Delete");
  });

  it("counts scenes for a multi-selection", () => {
    expect(sceneSelectionLabel("Delete", 3)).toBe("Delete 3 scenes");
    expect(sceneSelectionLabel("Duplicate", 2)).toBe("Duplicate 2 scenes");
  });
});

describe("sceneMenuItems", () => {
  it("relabels Duplicate, Copy to project and Delete for a multi-selection", () => {
    const entries = items({ selectionCount: 3 });
    expect(item(entries, "duplicate").label).toBe("Duplicate 3 scenes");
    expect(item(entries, "copy-to-project").label).toBe("Copy 3 scenes to project…");
    expect(item(entries, "delete").label).toBe("Delete 3 scenes");
  });

  it("keeps singular labels without a selection count", () => {
    const entries = items();
    expect(item(entries, "duplicate").label).toBe("Duplicate…");
    expect(item(entries, "copy-to-project").label).toBe("Copy to project…");
    expect(item(entries, "delete").label).toBe("Delete");
  });

  it("disables Delete when the project would be emptied", () => {
    const refused = item(items({ canDelete: false }), "delete");
    expect(refused.disabled).toBe(true);
    expect(refused.title).toBe("A project needs at least one scene");
    const allowed = item(items(), "delete");
    expect(allowed.disabled).toBe(false);
    expect(allowed.title).toBeUndefined();
  });

  it("keeps the delete two-step", () => {
    const entry = item(items(), "delete");
    expect(entry.confirmLabel).toBe("Really delete?");
    expect(entry.danger).toBe(true);
  });

  it("keeps the shared order and the optional items", () => {
    const ids = (entries: ReturnType<typeof items>) =>
      entries.map((e) => (e === "separator" ? "separator" : e.id));
    expect(ids(items({ onManage: vi.fn() }))).toEqual([
      "rename",
      "duplicate",
      "copy-to-project",
      "duration",
      "manage",
      "separator",
      "copy-background",
      "paste-background",
      "separator",
      "delete",
    ]);
    expect(ids(items({ onCopyToProject: undefined }))).toEqual([
      "rename",
      "duplicate",
      "duration",
      "separator",
      "copy-background",
      "paste-background",
      "separator",
      "delete",
    ]);
  });

  it("routes Delete to its handler", () => {
    const onDelete = vi.fn();
    item(items({ onDelete }), "delete").onSelect();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
