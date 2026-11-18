/** Keyboard focus for aria-modal layers (design.md §12): focus moves in when one opens, Tab never walks out to the window behind it, and focus returns to the opener when it closes. The Escape layer stack drives it, so there is no global observer. */
const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const FLOATING = '[role="menu"], .colour-popover';
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';

type TabKey = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

/** 1 for Tab, -1 for ⇧Tab, 0 for anything else (⌃Tab and friends belong to the system). */
export function tabDirection(e: TabKey): 1 | -1 | 0 {
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return 0;
  return e.shiftKey ? -1 : 1;
}

/** Where Tab lands when it would leave the layer: the far end in its direction, or null to let the browser move. */
export function wrapTarget<T>(list: readonly T[], current: T | null, direction: 1 | -1): T | null {
  if (list.length === 0) return null;
  const first = list[0] as T;
  const last = list[list.length - 1] as T;
  const at = current === null ? -1 : list.indexOf(current);
  if (at === -1) return direction > 0 ? first : last;
  if (direction > 0 && at === list.length - 1) return first;
  if (direction < 0 && at === 0) return last;
  return null;
}

/** The element to hand focus back to: the opener while it is still in the window, else nothing. */
export function restoreTarget<T extends { isConnected: boolean }>(
  opener: T | null,
  active: unknown,
  body: unknown,
): T | null {
  const lost =
    active === null ||
    active === body ||
    (typeof active === "object" && !(active as { isConnected?: boolean }).isConnected);
  return lost && opener?.isConnected ? opener : null;
}

type Layer = { el: HTMLElement; opener: HTMLElement | null };
const layers: Layer[] = [];
let tabbing: 1 | -1 | 0 = 0;
let installed = false;

function shown(el: Element): boolean {
  return el.getClientRects().length > 0 && !el.closest("[inert]");
}

function tabbables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && shown(el),
  );
}

function topLayer(): HTMLElement | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const el = layers[i]?.el;
    if (el?.isConnected && shown(el)) return el;
  }
  return null;
}

function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "keydown",
    (e) => {
      const direction = tabDirection(e);
      if (!direction) return;
      tabbing = direction;
      window.setTimeout(() => {
        tabbing = 0;
      }, 0);
      const top = topLayer();
      if (!top) return;
      const active = document.activeElement as HTMLElement | null;
      const lost = active === null || active === document.body;
      if (!lost && !top.contains(active)) return;
      const target = wrapTarget(tabbables(top), lost || active === top ? null : active, direction);
      if (target) {
        e.preventDefault();
        focus(target);
      }
    },
    true,
  );
  // WKWebView's Tab skips buttons unless macOS Keyboard navigation is on, so also catch a Tab that lands outside.
  document.addEventListener(
    "focusin",
    (e) => {
      if (!tabbing) return;
      const top = topLayer();
      const into = e.target;
      if (!top || !(into instanceof Element) || top.contains(into) || into.closest(FLOATING))
        return;
      const list = tabbables(top);
      focus((tabbing > 0 ? list[0] : list[list.length - 1]) ?? top);
    },
    true,
  );
}

/** Reconcile with the open aria-modal layers: focus a new one, hand focus back from a closed one. */
export function syncModalFocus(): void {
  if (typeof document === "undefined") return;
  install();
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as Layer;
    if (layer.el.isConnected && layer.el.matches(MODAL)) continue;
    layers.splice(i, 1);
    const back = restoreTarget(layer.opener, document.activeElement, document.body);
    if (back) focus(back);
  }
  for (const el of document.querySelectorAll<HTMLElement>(MODAL)) {
    if (layers.some((l) => l.el === el)) continue;
    const active = document.activeElement as HTMLElement | null;
    layers.push({
      el,
      opener: active && active !== document.body && !el.contains(active) ? active : null,
    });
    if (active && el.contains(active)) continue;
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    focus(el);
  }
}
