/// <reference lib="webworker" />
import type { HostToWorker, StageInitMessage, WorkerToHost } from "./spikeMessages";

/** SPIKE (scene isolation, Phase 1): the stage worker's entry. Installs the realm shims the unmodified engine needs (a minimal `document`, storage, a Tauri IPC proxy that forwards every invoke to the editor realm), then imports the engine. Everything here is measurement scaffolding: Phase 2 replaces the proxy with the narrow stage protocol and decides which shims survive. */

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;
const post = (msg: WorkerToHost, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

// Console forwarding: the dev harness only sees the editor realm's console.
const format = (args: unknown[]) =>
  args
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : safeJson(a),
    )
    .join(" ");
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    post({ type: "log", level, text: format(args) });
  };
}
scope.addEventListener("error", (ev) => post({ type: "fatal", text: `error: ${ev.message}` }));
scope.addEventListener("unhandledrejection", (ev) =>
  post({ type: "fatal", text: `unhandledrejection: ${format([ev.reason])}` }),
);

const probe: Record<string, unknown> = {
  windowBefore: typeof (scope as { window?: unknown }).window,
  documentBefore: typeof (scope as { document?: unknown }).document,
  tauriInternals: typeof scope.__TAURI_INTERNALS__,
  nativeRaf: typeof scope.requestAnimationFrame,
  offscreenCanvas: typeof OffscreenCanvas,
  createImageBitmap: typeof createImageBitmap,
  fonts: typeof (scope as { fonts?: unknown }).fonts,
};

// ── Realm shims ──────────────────────────────────────────────────────────────
// `window`: troika's typr factory aliases it to self anyway; libraries branch on it.
scope.window = scope;

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

// OffscreenCanvas stands in for HTMLCanvasElement: sync encoders become async-ish, style is inert.
const OC = OffscreenCanvas.prototype as unknown as Record<string, unknown>;
OC.toBlob = function (
  this: OffscreenCanvas,
  cb: (b: Blob | null) => void,
  type?: string,
  quality?: number,
) {
  this.convertToBlob({ type, quality }).then(cb, () => cb(null));
};
OC.toDataURL = () => {
  console.warn("[stage-worker] toDataURL is unavailable in the worker; returning an empty string");
  return "";
};
Object.defineProperty(OffscreenCanvas.prototype, "style", {
  get() {
    if (!this.__style) this.__style = {};
    return this.__style;
  },
  configurable: true,
});
OC.getBoundingClientRect = function (this: OffscreenCanvas) {
  return {
    left: 0,
    top: 0,
    right: this.width,
    bottom: this.height,
    width: this.width,
    height: this.height,
    x: 0,
    y: 0,
  };
};
OC.setAttribute = () => {};
OC.removeAttribute = () => {};
OC.setPointerCapture = () => {};
OC.releasePointerCapture = () => {};
OC.focus = () => {};
Object.defineProperty(OffscreenCanvas.prototype, "clientWidth", {
  get() {
    return this.width;
  },
  configurable: true,
});
Object.defineProperty(OffscreenCanvas.prototype, "clientHeight", {
  get() {
    return this.height;
  },
  configurable: true,
});
Object.defineProperty(OffscreenCanvas.prototype, "ownerDocument", {
  get() {
    return scope.document;
  },
  configurable: true,
});
scope.HTMLCanvasElement ??= OffscreenCanvas;

/** `new Image()` stand-in: decodes through fetch + createImageBitmap and reports its size, enough for feature probes (three-stdlib's WebP check) and size reads. */
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

const noop = () => {};
const element = (tag: string): unknown => {
  if (tag === "canvas") return new OffscreenCanvas(1, 1);
  if (tag === "img") return new WorkerImage();
  if (tag === "video" || tag === "audio") {
    throw new Error(`[stage-worker] <${tag}> elements are unavailable in the stage worker`);
  }
  return {
    tagName: tag.toUpperCase(),
    style: {},
    setAttribute: noop,
    appendChild: noop,
    removeChild: noop,
    addEventListener: noop,
    removeEventListener: noop,
    remove: noop,
    href: "",
  };
};
scope.document = {
  createElement: (tag: string) => element(tag),
  createElementNS: (_ns: string, tag: string) => element(tag),
  createTextNode: (text: string) => ({ textContent: text }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  body: {
    appendChild: noop,
    removeChild: noop,
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
  },
  head: { appendChild: noop, removeChild: noop },
  documentElement: { style: {}, classList: { add: noop, remove: noop, contains: () => false } },
  fonts: (scope as { fonts?: unknown }).fonts,
  visibilityState: "visible",
  hidden: false,
  hasFocus: () => true,
};

// ── requestAnimationFrame: native when the platform has it, else ticks the editor realm hands over ──
let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafNext = 1;
let rafPending = false;
if (typeof scope.requestAnimationFrame !== "function") {
  scope.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = rafNext++;
    rafCallbacks.push({ id, cb });
    if (!rafPending) {
      rafPending = true;
      post({ type: "rafRequest" });
    }
    return id;
  };
  scope.cancelAnimationFrame = (id: number) => {
    rafCallbacks = rafCallbacks.filter((r) => r.id !== id);
  };
}
function onRaf(ts: number): void {
  rafPending = false;
  const batch = rafCallbacks;
  rafCallbacks = [];
  for (const { cb } of batch) cb(ts);
}

// ── Tauri IPC proxy (spike only) ─────────────────────────────────────────────
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const callbacks = new Map<number, { fn: (data: unknown) => void; once: boolean }>();
let nextInvoke = 1;
// Callback ids live far above anything a command argument would carry by chance.
let nextCallback = 0x40000000;
let convertPrefix = "asset://localhost/";

const invokeProxy = (cmd: string, args: unknown = {}, options?: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = nextInvoke++;
    pending.set(id, { resolve, reject });
    let payload = args;
    const transfer: Transferable[] = [];
    if (args instanceof Uint8Array) {
      // The export reuses its readback buffer, so the copy, not the buffer, crosses the boundary.
      const copy = args.slice();
      payload = copy;
      transfer.push(copy.buffer);
    } else if (args instanceof ArrayBuffer) {
      payload = args.slice(0);
      transfer.push(payload as ArrayBuffer);
    }
    const callbackIds: number[] = [];
    if (payload && typeof payload === "object" && !(payload instanceof Uint8Array)) {
      const serialised = JSON.stringify(payload);
      for (const id of callbacks.keys()) {
        if (serialised.includes(String(id))) callbackIds.push(id);
      }
      // Channels serialise themselves (toJSON → "__CHANNEL__:<id>"); pass the serialised form.
      payload = JSON.parse(serialised);
    }
    post({ type: "invoke", id, cmd, args: payload, options, callbackIds }, transfer);
  });

scope.__TAURI_INTERNALS__ = {
  invoke: invokeProxy,
  transformCallback(fn: (data: unknown) => void, once = false) {
    const id = nextCallback++;
    callbacks.set(id, { fn, once });
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
    post({ type: "unregisterCallback", id });
  },
  convertFileSrc(path: string, protocol = "asset") {
    return `${convertPrefix.replace("asset", protocol)}${encodeURIComponent(path)}`;
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

scope.addEventListener("message", (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "invokeResult": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(msg.error);
      return;
    }
    case "callback": {
      const cb = callbacks.get(msg.id);
      if (!cb) return;
      if (cb.once) callbacks.delete(msg.id);
      cb.fn(msg.data);
      return;
    }
    case "raf":
      onRaf(msg.ts);
      return;
    case "init":
      void boot(msg);
      return;
  }
});

async function boot(init: StageInitMessage): Promise<void> {
  const expected = init.convertSample.url;
  const idx = expected.indexOf(encodeURIComponent(init.convertSample.path));
  if (idx > 0) convertPrefix = expected.slice(0, idx);
  probe.convertPrefix = convertPrefix;
  probe.convertMatches =
    scope.__TAURI_INTERNALS__ &&
    (scope.__TAURI_INTERNALS__ as { convertFileSrc: (p: string) => string }).convertFileSrc(
      init.convertSample.path,
    ) === expected;
  // One WebGL2 context on the real canvas, before the engine, so the truth log carries the platform answer even if the engine fails to boot.
  try {
    const test = new OffscreenCanvas(8, 8);
    const gl = test.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    probe.webgl2 = gl ? JSON.stringify(gl.getContextAttributes()) : "unavailable";
    if (gl) {
      probe.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
      probe.extColorBufferFloat = !!gl.getExtension("EXT_color_buffer_float");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch (e) {
    probe.webgl2 = `error: ${String(e)}`;
  }
  try {
    const url = URL.createObjectURL(
      new Blob(["export const probe = 42;"], { type: "text/javascript" }),
    );
    const mod = (await import(/* @vite-ignore */ url)) as { probe: number };
    probe.blobImport = mod.probe === 42;
    URL.revokeObjectURL(url);
  } catch (e) {
    probe.blobImport = `error: ${String(e)}`;
  }
  post({ type: "ready", probe });
  try {
    const app = await import("./stageWorkerApp");
    await app.bootStage(init);
  } catch (e) {
    post({
      type: "fatal",
      text: `boot: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    });
  }
}
