/** This realm's WebGL context census (docs/agent-kit.md, "Health"). Imported right after bootTrap in every window entry, it wraps `getContext` on HTMLCanvasElement and OffscreenCanvas as a PURE pass-through (the same arguments in, the same context object out) and only records what came back, so it can never change a rendered byte. WebKit keeps at most 16 live contexts per WebContent process and evicts the oldest past that with a console line no page can read, so the census infers it: `WEBGL_lose_context.loseContext` is wrapped to mark our own losses deliberate, a single unexpected loss while 16 or more are live is an eviction, and two or more within a second (or any with fewer live) is a GPU loss. */

export type LossClass = "deliberate" | "eviction" | "gpuLoss";

export const WEBGL_CONTEXT_CAP = 16;
const BURST_MS = 1000;
const KEEP_LOST = 64;

export interface ContextLoss {
  owner: string;
  api: string;
  lossClass: LossClass;
  live: number;
}

export interface GlContextInfo {
  owner: string;
  api: string;
  width: number;
  height: number;
  lost: boolean;
  lossClass: LossClass | null;
  ageMs: number;
}

export interface GlCensus {
  cap: number;
  live: number;
  lost: number;
  deliberate: number;
  evictions: number;
  gpuLosses: number;
  reportedAtMs: number;
  contexts: GlContextInfo[];
}

interface Entry {
  context: WeakRef<object>;
  canvas: WeakRef<object>;
  api: string;
  createdAt: number;
  lost: boolean;
  lostAt: number | null;
  lossClass: LossClass | null;
  deliberate: boolean;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** The constructors the census patches; a test passes fakes. */
export interface GlScope {
  HTMLCanvasElement?: { prototype: object };
  OffscreenCanvas?: { prototype: object };
  WebGLRenderingContext?: { prototype: object };
  WebGL2RenderingContext?: { prototype: object };
}

const WEBGL_TYPES = new Set(["webgl", "webgl2", "experimental-webgl"]);
const WRAPPED = Symbol("kookaburra.glCensus");

let entries: Entry[] = [];
let byContext = new WeakMap<object, Entry>();
const owners = new WeakMap<object, string>();
let patchedExtensions = new WeakSet<object>();
const listeners = new Set<(loss: ContextLoss) => void>();
const counts = { deliberate: 0, evictions: 0, gpuLosses: 0 };

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function liveCount(): number {
  return entries.filter((e) => !e.lost && e.context.deref() !== undefined).length;
}

/** Names a canvas in the census (`stage`, `heartbeat`); untagged ones read as `canvas`, `detached canvas` or `offscreen`. */
export function tagGlCanvas(canvas: object, owner: string): void {
  owners.set(canvas, owner);
}

function ownerOf(entry: Entry): string {
  const canvas = entry.canvas.deref();
  if (!canvas) return "collected";
  const tagged = owners.get(canvas);
  if (tagged) return tagged;
  const connected = (canvas as { isConnected?: boolean }).isConnected;
  if (connected === undefined) return "offscreen";
  return connected ? "canvas" : "detached canvas";
}

function classify(entry: Entry, at: number, liveBefore: number): LossClass {
  if (entry.deliberate) return "deliberate";
  const burst = entries.filter(
    (e) =>
      e !== entry &&
      e.lostAt !== null &&
      e.lossClass !== null &&
      e.lossClass !== "deliberate" &&
      at - e.lostAt <= BURST_MS,
  );
  if (burst.length > 0) {
    for (const e of burst) {
      if (e.lossClass === "eviction") {
        e.lossClass = "gpuLoss";
        counts.evictions -= 1;
        counts.gpuLosses += 1;
      }
    }
    return "gpuLoss";
  }
  return liveBefore >= WEBGL_CONTEXT_CAP ? "eviction" : "gpuLoss";
}

function onLost(entry: Entry): void {
  if (entry.lost) return;
  const at = clock();
  const liveBefore = liveCount();
  entry.lost = true;
  entry.lostAt = at;
  const lossClass = classify(entry, at, liveBefore);
  entry.lossClass = lossClass;
  entry.deliberate = false;
  if (lossClass === "deliberate") counts.deliberate += 1;
  else if (lossClass === "eviction") counts.evictions += 1;
  else counts.gpuLosses += 1;
  const loss: ContextLoss = { owner: ownerOf(entry), api: entry.api, lossClass, live: liveBefore };
  for (const listener of listeners) {
    try {
      listener(loss);
    } catch (e) {
      console.warn("[gl-census] loss listener failed:", e);
    }
  }
}

function note(canvas: object, context: object, api: string): void {
  if (byContext.has(context)) return;
  const entry: Entry = {
    context: new WeakRef(context),
    canvas: new WeakRef(canvas),
    api: api === "webgl2" ? "webgl2" : "webgl",
    createdAt: clock(),
    lost: false,
    lostAt: null,
    lossClass: null,
    deliberate: false,
  };
  byContext.set(context, entry);
  entries.push(entry);
  const target = canvas as Partial<EventTarget>;
  target.addEventListener?.("webglcontextlost", () => onLost(entry));
  target.addEventListener?.("webglcontextrestored", () => {
    entry.lost = false;
  });
}

function wrapMethod(
  proto: object | undefined,
  name: string,
  after: (self: unknown, args: unknown[], result: unknown) => void,
): void {
  if (!proto) return;
  const holder = proto as Record<string, unknown>;
  const original = holder[name];
  if (typeof original !== "function" || (original as unknown as Record<symbol, boolean>)[WRAPPED])
    return;
  const wrapped: Method = function (this: unknown, ...args: unknown[]) {
    const result = (original as Method).apply(this, args);
    try {
      after(this, args, result);
    } catch (e) {
      console.warn("[gl-census] bookkeeping failed:", e);
    }
    return result;
  };
  (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  holder[name] = wrapped;
}

function markDeliberate(gl: unknown, extension: object): void {
  if (patchedExtensions.has(extension)) return;
  patchedExtensions.add(extension);
  const holder = extension as Record<string, unknown>;
  const lose = holder.loseContext;
  if (typeof lose !== "function") return;
  holder.loseContext = function (this: unknown, ...args: unknown[]) {
    const entry = byContext.get(gl as object);
    if (entry) entry.deliberate = true;
    return (lose as Method).apply(this, args);
  };
}

/** Patches the scope's prototypes once (idempotent); runs on import against the window. */
export function installGlContextCensus(scope: GlScope = globalThis as GlScope): void {
  const noteContext = (self: unknown, args: unknown[], result: unknown) => {
    const type = args[0];
    if (result && typeof result === "object" && typeof type === "string" && WEBGL_TYPES.has(type)) {
      note(self as object, result, type);
    }
  };
  wrapMethod(scope.HTMLCanvasElement?.prototype, "getContext", noteContext);
  wrapMethod(scope.OffscreenCanvas?.prototype, "getContext", noteContext);
  const noteExtension = (self: unknown, args: unknown[], result: unknown) => {
    const name = args[0];
    if (
      result &&
      typeof result === "object" &&
      typeof name === "string" &&
      name.toLowerCase() === "webgl_lose_context"
    ) {
      markDeliberate(self, result);
    }
  };
  wrapMethod(scope.WebGLRenderingContext?.prototype, "getExtension", noteExtension);
  wrapMethod(scope.WebGL2RenderingContext?.prototype, "getExtension", noteExtension);
}

/** Every unexpected or deliberate loss in this realm, classified. */
export function onGlContextLoss(listener: (loss: ContextLoss) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The census each window reports on its tick (the heartbeat's `webgl` block and `kb debug contexts`). */
export function glContextCensus(): GlCensus {
  const now = clock();
  entries = entries.filter((e) => e.context.deref() !== undefined || !e.lost);
  const lost = entries.filter((e) => e.lost);
  if (lost.length > KEEP_LOST) {
    const drop = new Set(lost.slice(0, lost.length - KEEP_LOST));
    entries = entries.filter((e) => !drop.has(e));
  }
  return {
    cap: WEBGL_CONTEXT_CAP,
    live: liveCount(),
    lost: counts.evictions + counts.gpuLosses,
    deliberate: counts.deliberate,
    evictions: counts.evictions,
    gpuLosses: counts.gpuLosses,
    reportedAtMs: Date.now(),
    contexts: entries.map((e) => {
      const canvas = e.canvas.deref() as { width?: number; height?: number } | undefined;
      return {
        owner: ownerOf(e),
        api: e.api,
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        lost: e.lost,
        lossClass: e.lossClass,
        ageMs: Math.round(now - e.createdAt),
      };
    }),
  };
}

/** Tests only: forget every context (patched prototypes stay patched). */
export function resetGlContextCensus(): void {
  entries = [];
  byContext = new WeakMap();
  patchedExtensions = new WeakSet();
  counts.deliberate = 0;
  counts.evictions = 0;
  counts.gpuLosses = 0;
}

installGlContextCensus();
