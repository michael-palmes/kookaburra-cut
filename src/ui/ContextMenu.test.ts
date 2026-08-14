import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  contextMenuKeyboardIntent,
  contextMenuNavigationIndex,
  contextMenuSequentialIndex,
} from "./ContextMenu";

describe("contextMenuNavigationIndex", () => {
  it("enters at the nearest edge and wraps through enabled items", () => {
    expect(contextMenuNavigationIndex("ArrowDown", -1, 3)).toBe(0);
    expect(contextMenuNavigationIndex("ArrowUp", -1, 3)).toBe(2);
    expect(contextMenuNavigationIndex("ArrowDown", 2, 3)).toBe(0);
    expect(contextMenuNavigationIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("supports Home and End and ignores unrelated keys", () => {
    expect(contextMenuNavigationIndex("Home", 1, 3)).toBe(0);
    expect(contextMenuNavigationIndex("End", 1, 3)).toBe(2);
    expect(contextMenuNavigationIndex("Enter", 1, 3)).toBeNull();
    expect(contextMenuNavigationIndex("ArrowDown", -1, 0)).toBeNull();
  });

  it("dismisses Tab in either direction while leaving Escape to the layer stack", () => {
    expect(contextMenuKeyboardIntent("Tab", false, 0, 3)).toEqual({
      kind: "dismiss",
      reverse: false,
    });
    expect(contextMenuKeyboardIntent("Tab", true, 0, 3)).toEqual({
      kind: "dismiss",
      reverse: true,
    });
    expect(contextMenuKeyboardIntent("Escape", false, 0, 3)).toBeNull();
  });

  it("keeps arrow, Home and End movement as focus intents", () => {
    expect(contextMenuKeyboardIntent("ArrowDown", false, 2, 3)).toEqual({
      kind: "focus",
      index: 0,
    });
    expect(contextMenuKeyboardIntent("Home", false, 2, 3)).toEqual({
      kind: "focus",
      index: 0,
    });
    expect(contextMenuKeyboardIntent("End", false, 0, 3)).toEqual({
      kind: "focus",
      index: 2,
    });
  });
});

describe("contextMenuSequentialIndex", () => {
  it("moves to the next or previous external focus target", () => {
    expect(contextMenuSequentialIndex(2, 5, false)).toBe(3);
    expect(contextMenuSequentialIndex(2, 5, true)).toBe(1);
    expect(contextMenuSequentialIndex(0, 5, true)).toBeNull();
    expect(contextMenuSequentialIndex(4, 5, false)).toBeNull();
  });
});

describe("ContextMenu semantic markup", () => {
  it("keeps decorative icons separate from visible menu labels", () => {
    const html = renderToStaticMarkup(
      createElement(ContextMenu, {
        menu: {
          x: 12,
          y: 20,
          ariaLabel: "Layer actions",
          items: [
            {
              id: "edit",
              label: "Edit",
              icon: createElement("svg", { viewBox: "0 0 20 20" }),
              onSelect: vi.fn(),
            },
            "separator",
            {
              id: "delete",
              label: "Delete",
              confirmLabel: "Really delete?",
              danger: true,
              disabled: true,
              title: "Unavailable",
              onSelect: vi.fn(),
            },
          ],
        },
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain(
      'class="context-menu" role="menu" aria-label="Layer actions" tabindex="-1"',
    );
    expect(html).toContain('role="menuitem" class="context-menu-item"');
    expect(html).toContain('class="context-menu-item-icon" aria-hidden="true"');
    expect(html).toContain('<span class="context-menu-item-label">Edit</span>');
    expect(html).toContain('class="context-menu-item danger" disabled="" title="Unavailable"');
    expect(html).toContain('<span class="context-menu-item-label">Delete</span>');
    expect(html).toContain('class="context-menu-separator"');
  });
});
