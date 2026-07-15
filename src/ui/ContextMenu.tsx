import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEscapeClose } from "./useEscapeClose";

/** The reusable right-click context menu: fixed-positioned at the pointer, clamped to the viewport; Esc, outside pointerdown, or any selection closes it. Items marked `confirm` use a two-step: first activation re-labels ("Really delete?") without closing and disarms itself after 3s, swapping the label in place with no layout shift. */

export interface ContextMenuItem {
  id: string;
  label: string;
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
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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

  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
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
              onClose();
              item.onSelect();
            }}
          >
            {item.confirmLabel && armedId === item.id ? item.confirmLabel : item.label}
          </button>
        ),
      )}
    </div>
  );
}
