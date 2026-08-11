import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useEscapeClose } from "./useEscapeClose";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The reusable right-click context menu: fixed-positioned at the pointer, clamped to the viewport; Esc, outside pointerdown, or any selection closes it. Items marked `confirm` use a two-step: first activation re-labels ("Really delete?") without closing and disarms itself after 3s, swapping the label in place with no layout shift. */

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Optional decorative leading icon. The visible label remains the accessible name. */
  icon?: ReactNode;
  /** Two-step arm label (presence enables the confirm flow). */
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Disabled-state tooltip. */
  title?: string;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: (ContextMenuItem | "separator")[];
  /** Exact control to refocus when the menu closes. Falls back to the active element at open. */
  returnFocus?: HTMLElement | null;
}

/** Resolve keyboard movement over the enabled menu items. Arrow keys wrap like a native menu. */
export function contextMenuNavigationIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
    case "ArrowUp":
      return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return null;
  }
}

export type ContextMenuKeyboardIntent =
  | { kind: "dismiss"; reverse: boolean }
  | { kind: "focus"; index: number }
  | null;

export function contextMenuKeyboardIntent(
  key: string,
  shiftKey: boolean,
  currentIndex: number,
  itemCount: number,
): ContextMenuKeyboardIntent {
  if (key === "Tab") return { kind: "dismiss", reverse: shiftKey };
  const index = contextMenuNavigationIndex(key, currentIndex, itemCount);
  return index === null ? null : { kind: "focus", index };
}

export function contextMenuSequentialIndex(
  currentIndex: number,
  itemCount: number,
  reverse: boolean,
): number | null {
  if (currentIndex < 0 || currentIndex >= itemCount) return null;
  const nextIndex = currentIndex + (reverse ? -1 : 1);
  return nextIndex >= 0 && nextIndex < itemCount ? nextIndex : null;
}

function enabledMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(".context-menu-item:not(:disabled)")];
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(menu.returnFocus ?? null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [armedId, setArmedId] = useState<string | null>(null);
  useEscapeClose(onClose);

  // Clamp to the viewport once the size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8),
    });
  }, [menu.x, menu.y]);

  // Enter the menu at its first available action, then return to the opener when it closes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (!returnFocusRef.current && active instanceof HTMLElement && !el.contains(active)) {
      returnFocusRef.current = active;
    }
    (enabledMenuItems(el)[0] ?? el).focus({ preventScroll: true });
    return () => {
      const origin = returnFocusRef.current;
      const focused = document.activeElement;
      if (
        origin?.isConnected &&
        (focused === document.body || (focused instanceof Node && el.contains(focused)))
      ) {
        origin.focus({ preventScroll: true });
      }
    };
  }, []);

  // Outside pointerdown dismisses (capture phase, before any click handlers).
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  // Armed confirm items disarm themselves (the house pattern).
  useEffect(() => {
    if (armedId === null) return;
    const t = window.setTimeout(() => setArmedId(null), 3000);
    return () => window.clearTimeout(t);
  }, [armedId]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = enabledMenuItems(event.currentTarget);
    const active = document.activeElement;
    const currentIndex = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    const intent = contextMenuKeyboardIntent(event.key, event.shiftKey, currentIndex, items.length);
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (intent.kind === "dismiss") {
      const origin = returnFocusRef.current;
      const menuElement = ref.current;
      const external = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) =>
          element.isConnected &&
          !element.closest("[inert]") &&
          !menuElement?.contains(element) &&
          element.getClientRects().length > 0,
      );
      const targetIndex = origin
        ? contextMenuSequentialIndex(external.indexOf(origin), external.length, intent.reverse)
        : null;
      const target = targetIndex === null ? origin : external[targetIndex];
      flushSync(onClose);
      if (target?.isConnected) target.focus({ preventScroll: true });
      return;
    }
    items[intent.index]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
          <hr key={`sep-${i}`} className="context-menu-separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              if (item.confirmLabel && armedId !== item.id) {
                setArmedId(item.id);
                return;
              }
              flushSync(onClose);
              item.onSelect();
            }}
          >
            {item.icon !== undefined && (
              <span className="context-menu-item-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="context-menu-item-label">
              {item.confirmLabel && armedId === item.id ? item.confirmLabel : item.label}
            </span>
          </button>
        ),
      )}
    </div>
  );
}
