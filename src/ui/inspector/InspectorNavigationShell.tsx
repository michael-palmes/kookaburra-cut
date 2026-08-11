import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type InspectorState, useUiStore } from "../../store/uiStore";
import { useEscapeClose } from "../useEscapeClose";

interface FocusLocator {
  element: HTMLElement | null;
  path: number[] | null;
  ariaLabel: string | null;
  text: string | null;
}

interface PageHistoryEntry {
  signature: string;
  snapshot: HTMLElement;
  opener: FocusLocator | null;
}

interface PendingForward {
  snapshot: HTMLElement;
  opener: FocusLocator | null;
}

interface BackCompletion {
  entry: PageHistoryEntry | null;
  opener: FocusLocator | null;
}

interface InspectorNavigationContextValue {
  requestBack: (onComplete: () => void) => void;
}

const InspectorNavigationContext = createContext<InspectorNavigationContextValue | null>(null);
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const TRANSITION_MS = 160;
const snapshotScrollState = new WeakMap<HTMLElement, Array<[HTMLElement, number, number]>>();

export function useInspectorNavigation(): InspectorNavigationContextValue | null {
  return useContext(InspectorNavigationContext);
}

function elementPath(root: HTMLElement, target: HTMLElement): number[] | null {
  if (!root.contains(target)) return null;
  const path: number[] = [];
  let current: HTMLElement | null = target;
  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return current === root ? path : null;
}

function captureElement(root: HTMLElement, active: HTMLElement): FocusLocator | null {
  if (!root.contains(active)) return null;
  return {
    element: active,
    path: elementPath(root, active),
    ariaLabel: active.getAttribute("aria-label"),
    text: active.textContent?.trim() || null,
  };
}

function captureFocus(root: HTMLElement): FocusLocator | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? captureElement(root, active) : null;
}

function targetFromPath(root: HTMLElement, path: number[]): HTMLElement | null {
  let current: HTMLElement = root;
  for (const index of path) {
    const child = current.children.item(index);
    if (!(child instanceof HTMLElement)) return null;
    current = child;
  }
  return current;
}

function restoreFocus(root: HTMLElement, locator: FocusLocator | null): void {
  if (!locator) return;
  if (locator.element?.isConnected) {
    locator.element.focus({ preventScroll: true });
    return;
  }
  const byPath = locator.path ? targetFromPath(root, locator.path) : null;
  if (byPath?.matches(FOCUSABLE)) {
    byPath.focus({ preventScroll: true });
    return;
  }
  const candidates = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const matching = candidates.find(
    (candidate) =>
      (!!locator.ariaLabel && candidate.getAttribute("aria-label") === locator.ariaLabel) ||
      (!!locator.text && candidate.textContent?.trim() === locator.text),
  );
  matching?.focus({ preventScroll: true });
}

function inertSnapshot(page: HTMLElement): HTMLElement {
  const snapshot = page.cloneNode(true) as HTMLElement;
  const sourceElements = [page, ...page.querySelectorAll<HTMLElement>("*")];
  const snapshotElements = [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")];
  const scrollState: Array<[HTMLElement, number, number]> = [];
  sourceElements.forEach((source, index) => {
    const copy = snapshotElements[index];
    if (!(source instanceof HTMLElement) || !(copy instanceof HTMLElement)) return;
    if (source.scrollTop !== 0 || source.scrollLeft !== 0) {
      scrollState.push([copy, source.scrollTop, source.scrollLeft]);
    }
    if (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.value = source.value;
      copy.checked = source.checked;
      copy.indeterminate = source.indeterminate;
    } else if (source instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.value = source.value;
    } else if (source instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      copy.selectedIndex = source.selectedIndex;
    }
  });
  snapshotScrollState.set(snapshot, scrollState);
  snapshot.classList.remove("inspector-nav-entering", "inspector-nav-exiting");
  snapshot.classList.add("inspector-nav-ghost-page");
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.setAttribute("inert", "");
  for (const element of [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("for");
    element.removeAttribute("aria-controls");
    element.removeAttribute("aria-describedby");
    element.removeAttribute("aria-labelledby");
    element.removeAttribute("aria-owns");
    element.tabIndex = -1;
  }
  return snapshot;
}

function showSnapshot(container: HTMLElement | null, snapshot: HTMLElement): void {
  if (!container) return;
  container.replaceChildren(snapshot);
  for (const [element, scrollTop, scrollLeft] of snapshotScrollState.get(snapshot) ?? []) {
    element.scrollTop = scrollTop;
    element.scrollLeft = scrollLeft;
  }
}

export function inspectorRouteSignature(
  inspector: InspectorState = useUiStore.getState().inspector,
): string {
  return [inspector.tab, inspector.drillStack.join("/")].join("|");
}

function animationDisabled(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function modalOwnsKeyboard(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][aria-modal="true"], .modal-overlay, .colour-popover, .context-menu, .media-preview',
    ) !== null
  );
}

export function InspectorNavigationShell({
  resetKey,
  children,
}: {
  resetKey: string;
  children: ReactNode;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pendingForwardRef = useRef<PendingForward | null>(null);
  const backCompletionRef = useRef<BackCompletion | null>(null);
  const signaturesRef = useRef<string[]>([]);
  const pageHistoryRef = useRef<PageHistoryEntry[]>([]);
  const stableSnapshotRef = useRef<HTMLElement | null>(null);
  const lastFocusRef = useRef<FocusLocator | null>(null);
  const activationRef = useRef<FocusLocator | null>(null);
  const replacementFocusRef = useRef<FocusLocator | null>(null);
  const replacementPendingRef = useRef(false);
  const cancelAnimationRef = useRef<(() => void) | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const backInFlightRef = useRef(false);
  const suppressDomNavigationRef = useRef(false);
  const resetKeyMountedRef = useRef(false);
  const [innerLayerOpen, setInnerLayerOpen] = useState(false);
  const drillDepth = useUiStore((state) => state.inspector.drillStack.length);

  const cancelAnimation = useCallback(() => {
    cancelAnimationRef.current?.();
    cancelAnimationRef.current = null;
    pageRef.current?.classList.remove("inspector-nav-entering", "inspector-nav-exiting");
  }, []);

  const clearNavigation = useCallback(
    (suppressDomNavigation = false) => {
      cancelAnimation();
      overlayRef.current?.replaceChildren();
      pendingForwardRef.current = null;
      backCompletionRef.current = null;
      pageHistoryRef.current = [];
      backInFlightRef.current = false;
      activationRef.current = null;
      replacementFocusRef.current = null;
      replacementPendingRef.current = false;
      suppressDomNavigationRef.current = suppressDomNavigation;
      const page = pageRef.current;
      signaturesRef.current = page ? [inspectorRouteSignature()] : [];
      stableSnapshotRef.current = page ? inertSnapshot(page) : null;
      lastFocusRef.current = page ? captureFocus(page) : null;
    },
    [cancelAnimation],
  );

  const scheduleFocus = useCallback((task: () => void) => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      task();
    });
  }, []);

  const runAnimation = useCallback(
    (target: HTMLElement, className: string, onFinish: () => void) => {
      cancelAnimation();
      target.classList.add(className);
      let timer = 0;
      let settled = false;
      const clean = () => {
        window.clearTimeout(timer);
        target.removeEventListener("animationend", finish);
        target.classList.remove(className);
      };
      const finish = (event?: AnimationEvent) => {
        if (event && event.target !== target) return;
        if (settled) return;
        settled = true;
        clean();
        cancelAnimationRef.current = null;
        onFinish();
      };
      cancelAnimationRef.current = () => {
        if (settled) return;
        settled = true;
        clean();
      };
      target.addEventListener("animationend", finish);
      timer = window.setTimeout(finish, TRANSITION_MS + 40);
    },
    [cancelAnimation],
  );

  const prepareForward = useCallback(
    (parentInspector?: InspectorState) => {
      const page = pageRef.current;
      if (!page) return;
      cancelAnimation();
      if (suppressDomNavigationRef.current) {
        signaturesRef.current = [inspectorRouteSignature(parentInspector)];
        pageHistoryRef.current = [];
        stableSnapshotRef.current = inertSnapshot(page);
      }
      suppressDomNavigationRef.current = false;
      const activation = activationRef.current;
      const connectedActivation =
        activation?.element?.isConnected && page.contains(activation.element) ? activation : null;
      pendingForwardRef.current = {
        snapshot: inertSnapshot(page),
        opener: connectedActivation ?? captureFocus(page) ?? lastFocusRef.current,
      };
      activationRef.current = null;
    },
    [cancelAnimation],
  );

  const prepareReplacement = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;
    if (backInFlightRef.current) {
      replacementFocusRef.current = null;
      replacementPendingRef.current = true;
      return;
    }
    cancelAnimation();
    pendingForwardRef.current = null;
    replacementFocusRef.current = captureFocus(page);
    replacementPendingRef.current = true;
  }, [cancelAnimation]);

  const completeBackRender = useCallback(
    (nextSignature: string, completion: BackCompletion) => {
      const page = pageRef.current;
      if (!page) return;
      const expected = completion.entry?.signature;
      if (expected === nextSignature) {
        signaturesRef.current.pop();
        pageHistoryRef.current.pop();
      } else {
        signaturesRef.current = [nextSignature];
        pageHistoryRef.current = [];
      }
      overlayRef.current?.replaceChildren();
      backInFlightRef.current = false;
      replacementFocusRef.current = null;
      replacementPendingRef.current = false;
      scheduleFocus(() => {
        const currentPage = pageRef.current;
        if (currentPage) restoreFocus(currentPage, completion.opener);
      });
    },
    [scheduleFocus],
  );

  const commitDomNavigation = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;
    const nextSignature = inspectorRouteSignature();
    if (suppressDomNavigationRef.current) {
      suppressDomNavigationRef.current = false;
      overlayRef.current?.replaceChildren();
      pendingForwardRef.current = null;
      backCompletionRef.current = null;
      pageHistoryRef.current = [];
      backInFlightRef.current = false;
      signaturesRef.current = [nextSignature];
      stableSnapshotRef.current = inertSnapshot(page);
      lastFocusRef.current = captureFocus(page);
      return;
    }
    const currentSignature = signaturesRef.current.at(-1);
    if (nextSignature === currentSignature) {
      stableSnapshotRef.current = inertSnapshot(page);
      return;
    }

    const completion = backCompletionRef.current;
    if (completion) {
      backCompletionRef.current = null;
      completeBackRender(nextSignature, completion);
      stableSnapshotRef.current = inertSnapshot(page);
      return;
    }

    if (replacementPendingRef.current) {
      replacementPendingRef.current = false;
      const locator = replacementFocusRef.current;
      replacementFocusRef.current = null;
      if (signaturesRef.current.length > 0) {
        signaturesRef.current[signaturesRef.current.length - 1] = nextSignature;
      } else {
        signaturesRef.current = [nextSignature];
      }
      stableSnapshotRef.current = inertSnapshot(page);
      if (!backInFlightRef.current) {
        scheduleFocus(() => {
          const currentPage = pageRef.current;
          if (!currentPage) return;
          restoreFocus(currentPage, locator);
          if (!currentPage.contains(document.activeElement)) {
            currentPage
              .querySelector<HTMLElement>(".inspector-drill-back")
              ?.focus({ preventScroll: true });
          }
        });
      }
      return;
    }

    const pending = pendingForwardRef.current;
    pendingForwardRef.current = null;
    const inferredBack = signaturesRef.current.at(-2) === nextSignature;
    if (inferredBack) {
      const outgoing = stableSnapshotRef.current;
      const entry = pageHistoryRef.current.pop() ?? null;
      signaturesRef.current.pop();
      if (outgoing && !animationDisabled()) {
        showSnapshot(overlayRef.current, outgoing);
        runAnimation(outgoing, "inspector-nav-exiting", () =>
          overlayRef.current?.replaceChildren(),
        );
      }
      scheduleFocus(() => restoreFocus(page, entry?.opener ?? null));
      stableSnapshotRef.current = inertSnapshot(page);
      return;
    }

    const parentSnapshot = pending?.snapshot ?? stableSnapshotRef.current;
    const opener = pending?.opener ?? lastFocusRef.current;
    if (currentSignature && parentSnapshot) {
      pageHistoryRef.current.push({
        signature: currentSignature,
        snapshot: parentSnapshot,
        opener,
      });
      signaturesRef.current.push(nextSignature);
      if (!animationDisabled()) {
        showSnapshot(overlayRef.current, parentSnapshot);
        runAnimation(page, "inspector-nav-entering", () => overlayRef.current?.replaceChildren());
      }
      scheduleFocus(() =>
        pageRef.current
          ?.querySelector<HTMLElement>(".inspector-drill-back")
          ?.focus({ preventScroll: true }),
      );
    } else {
      signaturesRef.current = [nextSignature];
      pageHistoryRef.current = [];
    }
    stableSnapshotRef.current = inertSnapshot(page);
  }, [completeBackRender, runAnimation, scheduleFocus]);

  const requestBack = useCallback(
    (onComplete: () => void) => {
      if (backInFlightRef.current) return;
      const page = pageRef.current;
      if (!page) {
        onComplete();
        return;
      }
      backInFlightRef.current = true;
      const entry = pageHistoryRef.current.at(-1) ?? null;
      const commit = () => {
        backCompletionRef.current = { entry, opener: entry?.opener ?? null };
        onComplete();
        window.setTimeout(() => {
          if (!backCompletionRef.current) return;
          backCompletionRef.current = null;
          overlayRef.current?.replaceChildren();
          backInFlightRef.current = false;
        }, 0);
      };
      if (animationDisabled()) {
        commit();
        return;
      }
      cancelAnimation();
      if (entry) showSnapshot(overlayRef.current, entry.snapshot);
      runAnimation(page, "inspector-nav-exiting", commit);
    },
    [cancelAnimation, runAnimation],
  );

  useLayoutEffect(() => {
    void resetKey;
    clearNavigation(resetKeyMountedRef.current);
    resetKeyMountedRef.current = true;
  }, [resetKey, clearNavigation]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    signaturesRef.current = [inspectorRouteSignature()];
    stableSnapshotRef.current = inertSnapshot(page);
    const observer = new MutationObserver(commitDomNavigation);
    observer.observe(page, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [commitDomNavigation]);

  useEffect(
    () =>
      useUiStore.subscribe((state, previous) => {
        if (state.inspectorNavigation.sequence === previous.inspectorNavigation.sequence) return;
        if (
          state.inspectorNavigation.kind === "push" ||
          state.inspectorNavigation.kind === "jump"
        ) {
          prepareForward(previous.inspector);
          return;
        }
        if (state.inspectorNavigation.kind === "replace") {
          prepareReplacement();
          return;
        }
        if (state.inspectorNavigation.kind === "reset") clearNavigation(true);
      }),
    [clearNavigation, prepareForward, prepareReplacement],
  );

  const clickCurrentBack = useCallback(() => {
    pageRef.current?.querySelector<HTMLButtonElement>(".inspector-drill-back")?.click();
  }, []);

  useEffect(() => {
    const sync = () => setInnerLayerOpen(modalOwnsKeyboard());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "role", "aria-modal"],
    });
    return () => observer.disconnect();
  }, []);

  useEscapeClose(clickCurrentBack, drillDepth > 0 && !innerLayerOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowUp" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        drillDepth === 0 ||
        innerLayerOpen
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      clickCurrentBack();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clickCurrentBack, drillDepth, innerLayerOpen]);

  useEffect(
    () => () => {
      cancelAnimation();
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    },
    [cancelAnimation],
  );

  const context = useMemo<InspectorNavigationContextValue>(() => ({ requestBack }), [requestBack]);

  return (
    <InspectorNavigationContext.Provider value={context}>
      <div className="inspector-nav-shell">
        <div className="inspector-nav-overlay" aria-hidden="true" ref={overlayRef} />
        <div
          className="inspector-nav-page"
          ref={pageRef}
          onFocusCapture={() => {
            const page = pageRef.current;
            if (page) lastFocusRef.current = captureFocus(page);
          }}
          onClickCapture={(event) => {
            const page = pageRef.current;
            const target =
              event.target instanceof Element ? event.target.closest<HTMLElement>(FOCUSABLE) : null;
            activationRef.current = page && target ? captureElement(page, target) : null;
          }}
        >
          {children}
        </div>
      </div>
    </InspectorNavigationContext.Provider>
  );
}
