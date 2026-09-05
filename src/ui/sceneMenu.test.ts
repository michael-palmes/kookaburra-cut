import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "./ContextMenu";
import {
  SceneMenuIcon,
  type SceneMenuIconId,
  sceneMenuItems,
  sceneSelectionLabel,
} from "./sceneMenu";

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
    onInsertPreset: vi.fn(),
    onSaveAsPreset: vi.fn(),
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
  it("keeps single-scene presets editable without adding another scene", () => {
    const entries = items({ canAddScenes: false });
    expect(entries.some((e) => e !== "separator" && e.id === "duplicate")).toBe(false);
    expect(entries.some((e) => e !== "separator" && e.id === "insert-preset")).toBe(false);
    expect(item(entries, "save-preset")).toBeDefined();
    expect(item(entries, "copy-to-project")).toBeDefined();
    expect(item(entries, "duration")).toBeDefined();
  });

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
      "insert-preset",
      "copy-to-project",
      "save-preset",
      "duration",
      "manage",
      "separator",
      "copy-background",
      "paste-background",
      "separator",
      "delete",
    ]);
    expect(
      ids(
        items({ onCopyToProject: undefined, onInsertPreset: undefined, onSaveAsPreset: undefined }),
      ),
    ).toEqual([
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

  it("refuses Save as preset for a multi-selection", () => {
    const bulk = item(items({ selectionCount: 3 }), "save-preset");
    expect(bulk.disabled).toBe(true);
    expect(bulk.title).toBe("Presets hold a single scene");
    expect(item(items(), "save-preset").disabled).toBe(false);
  });

  it("routes Delete to its handler", () => {
    const onDelete = vi.fn();
    item(items({ onDelete }), "delete").onSelect();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("SceneMenuIcon", () => {
  it("gives every menu item a leading icon", () => {
    for (const entries of [items(), items({ onManage: vi.fn(), onCopyToProject: undefined })]) {
      for (const entry of entries) {
        if (entry !== "separator") expect(entry.icon).toBeDefined();
      }
    }
  });

  it("draws icons at the house geometry", () => {
    const ids: SceneMenuIconId[] = [
      "rename",
      "duplicate",
      "copy-to-project",
      "insert-preset",
      "save-preset",
      "duration",
      "manage",
      "copy-background",
      "paste-background",
      "delete",
    ];
    for (const id of ids) {
      const html = renderToStaticMarkup(createElement(SceneMenuIcon, { id }));
      expect(html).toContain('viewBox="0 0 20 20"');
      expect(html).toContain('width="17"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.5"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('aria-hidden="true"');
    }
  });
});
