/// <reference lib="webworker" />

/**
 * The stage worker's entry: the realm shims three, troika and the toolkit need in a worker
 * (a document that can make canvases, an image that can decode, storage, an OffscreenCanvas
 * that answers like a canvas element), then the server. Nothing here grants reach: there is
 * no `window`, no `__TAURI_INTERNALS__` and no IPC in this realm; a scene that asks for either
 * fails. See docs/architecture.md ("The stage worker").
 */

import { installWorkerInbox } from "./workerInbox";

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;
installWorkerInbox(scope);

const forward = (level: "warn" | "error") => {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    scope.postMessage({
      type: "log",
      level,
      text: args
        .map((a) =>
          a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : safeJson(a),
        )
        .join(" "),
    });
  };
};
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
forward("warn");
forward("error");
scope.addEventListener("error", (ev) =>
  scope.postMessage({ type: "fatal", text: `error: ${ev.message}` }),
);
scope.addEventListener("unhandledrejection", (ev) =>
  scope.postMessage({
    type: "fatal",
    text: `unhandledrejection: ${ev.reason instanceof Error ? (ev.reason.stack ?? ev.reason.message) : String(ev.reason)}`,
  }),
);

// ── Storage: per-realm conveniences only (the preview-quality keys and the like never reach pixels) ──
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  } as Storage;
};
scope.sessionStorage = memStorage();
scope.localStorage = memStorage();

// anime.js takes its non-browser main loop here (there is no `window`); the loop itself stays off, the engine is driven by `seek`.
scope.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
scope.clearImmediate ??= (id: number) => clearTimeout(id);

// ── OffscreenCanvas as the canvas element three, troika and TransformControls expect ──
const OC = OffscreenCanvas.prototype as unknown as Record<string, unknown>;
OC.toBlob = function (
  this: OffscreenCanvas,
  cb: (b: Blob | null) => void,
  type?: string,
  quality?: number,
) {
  this.convertToBlob({ type, quality }).then(cb, () => cb(null));
};
/** The box in CSS pixels, the frame pointer coordinates arrive in; the server records the window's size on the canvas (`__css`), since the drawing buffer carries the pixel ratio. */
OC.getBoundingClientRect = function (
  this: OffscreenCanvas & { __css?: { width: number; height: number } },
) {
  const width = this.__css?.width ?? this.width;
  const height = this.__css?.height ?? this.height;
  return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 };
};
OC.setAttribute = () => {};
OC.removeAttribute = () => {};
OC.setPointerCapture = () => {};
OC.releasePointerCapture = () => {};
OC.hasPointerCapture = () => false;
OC.focus = () => {};
const define = (name: string, get: (this: OffscreenCanvas) => unknown) =>
  Object.defineProperty(OffscreenCanvas.prototype, name, { get, configurable: true });
define("clientWidth", function () {
  return this.width;
});
define("clientHeight", function () {
  return this.height;
});
define("ownerDocument", () => scope.document);
define("parentElement", () => null);

/** The one cursor the stage reports: the canvas stand-in's `style.cursor`, posted to the window when it changes. */
const styles = new WeakMap<object, Record<string, string>>();
define("style", function () {
  let style = styles.get(this);
  if (!style) {
    style = {};
    Object.defineProperty(style, "cursor", {
      get: () => cursor,
      set: (value: string) => {
        if (value === cursor) return;
        cursor = value;
        scope.postMessage({ type: "cursor", cursor: value });
      },
      enumerable: true,
    });
    styles.set(this, style);
  }
  return style;
});
let cursor = "";
scope.HTMLCanvasElement ??= OffscreenCanvas;

/** `new Image()` stand-in: decodes through fetch + createImageBitmap and reports its size (three-stdlib's WebP probe, size reads). */
class WorkerImage extends EventTarget {
  width = 0;
  height = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  crossOrigin: string | null = null;
  decoding = "async";
  onload: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  bitmap: ImageBitmap | null = null;
  private source = "";
  get src(): string {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    fetch(value)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then(
        (bmp) => {
          this.bitmap = bmp;
          this.width = this.naturalWidth = bmp.width;
          this.height = this.naturalHeight = bmp.height;
          this.complete = true;
          this.onload?.();
          this.dispatchEvent(new Event("load"));
        },
        (e) => {
          this.complete = true;
          this.onerror?.(e);
          this.dispatchEvent(new Event("error"));
        },
      );
  }
  decode(): Promise<void> {
    return this.complete
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          this.addEventListener("load", () => resolve(), { once: true });
          this.addEventListener("error", () => reject(new Error("decode failed")), { once: true });
        });
  }
}
scope.Image = WorkerImage;
scope.HTMLImageElement ??= WorkerImage;

// ── A minimal document: canvases, fonts, an event target for pointer drags ──
const noop = () => {};
const inert = (tag: string) => ({
  tagName: tag.toUpperCase(),
  style: {},
  setAttribute: noop,
  appendChild: noop,
  removeChild: noop,
  addEventListener: noop,
  removeEventListener: noop,
  remove: noop,
  href: "",
});
class WorkerDocument extends EventTarget {
  createElement(tag: string): unknown {
    if (tag === "canvas") return new OffscreenCanvas(1, 1);
    if (tag === "img") return new WorkerImage();
    if (tag === "video" || tag === "audio") {
      throw new Error(`<${tag}> elements are unavailable in the stage worker`);
    }
    return inert(tag);
  }
  createElementNS(_ns: string, tag: string): unknown {
    return this.createElement(tag);
  }
  createTextNode(text: string): unknown {
    return { textContent: text };
  }
  getElementById(): null {
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): unknown[] {
    return [];
  }
  body = inert("body");
  head = inert("head");
  documentElement = inert("html");
  fonts = (scope as { fonts?: unknown }).fonts;
  visibilityState = "visible";
  hidden = false;
  pointerLockElement = null;
  hasFocus(): boolean {
    return true;
  }
}
scope.document = new WorkerDocument();

scope.addEventListener("messageerror", () =>
  scope.postMessage({ type: "fatal", text: "a message from the window could not be deserialised" }),
);

// With HMR on, a change to a module this realm holds is reported to the window; the React plugin skips Fast Refresh in a worker.
if (import.meta.hot) {
  const held = (import.meta.hot as unknown as { hmrClient?: { dataMap?: Map<string, unknown> } })
    .hmrClient?.dataMap;
  if (!held)
    console.warn(
      "[stage] the Vite client no longer lists its modules; every update reloads the window",
    );
  import.meta.hot.on("vite:beforeUpdate", ({ updates }) => {
    const paths = updates
      .filter((u) => !held || held.has(u.path) || held.has(u.acceptedPath))
      .map((u) => u.path);
    if (paths.length) scope.postMessage({ type: "sourceChanged", paths });
  });
}

// The server imports the engine, which must see the shims above at evaluation time.
scope.postMessage({ type: "log", level: "info", text: "stage worker entry evaluated" });
import("./stageServer").then(
  () => scope.postMessage({ type: "log", level: "info", text: "stage server module loaded" }),
  (e) =>
    scope.postMessage({
      type: "fatal",
      text: `server import failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    }),
);
