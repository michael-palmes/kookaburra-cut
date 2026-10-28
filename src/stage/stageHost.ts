import { Channel, convertFileSrc, invoke, transformCallback } from "@tauri-apps/api/core";
import { getAutoRunConfig, reportAutoRunError } from "../engine/autorun";
import type { HostToWorker, WorkerToHost } from "./spikeMessages";

/** SPIKE (scene isolation, Phase 1): hosts the stage worker from the editor realm. Builds the same letterboxed stage frame the editor lays out, hands its canvas to a module worker as an OffscreenCanvas, and forwards the worker's Tauri invokes (every one, with callback and channel ids remapped) so the unmodified engine runs inside the worker. The forwarding is deliberately promiscuous: this measures fps, export time and pixel parity, nothing else. */
export function startStageWorker(root: HTMLElement): void {
  const config = getAutoRunConfig();
  const format = config?.aspects[0];
  const aspect = format ? format.width / format.height : 16 / 9;

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.style.cssText = "position:fixed;inset:0";
  const frame = document.createElement("div");
  frame.className = "stage-frame";
  frame.style.setProperty("--stage-aspect", String(aspect));
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  frame.appendChild(canvas);
  stage.appendChild(frame);
  root.appendChild(stage);
  root.classList.add("ready");

  const rect = canvas.getBoundingClientRect();
  // The editor's "full" quality canvas clamps dpr to [1, 2].
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const offscreen = canvas.transferControlToOffscreen();

  const worker = new Worker(new URL("./stageWorker.ts", import.meta.url), { type: "module" });
  const post = (msg: HostToWorker, transfer: Transferable[] = []) =>
    worker.postMessage(msg, transfer);

  worker.onerror = (ev) => {
    console.error("[stage-host] worker error:", ev.message);
    reportAutoRunError(`stage worker error: ${ev.message}`);
  };

  worker.onmessage = (ev: MessageEvent<WorkerToHost>) => {
    const msg = ev.data;
    switch (msg.type) {
      case "log":
        if (msg.level === "error") console.error(`[stage-worker] ${msg.text}`);
        else console.warn(`[stage-worker] ${msg.text}`);
        return;
      case "ready":
        console.warn(`[stage-host] worker ready: ${JSON.stringify(msg.probe)}`);
        return;
      case "fatal":
        console.error(`[stage-worker] fatal: ${msg.text}`);
        reportAutoRunError(`stage worker: ${msg.text}`);
        return;
      case "rafRequest":
        requestAnimationFrame((ts) => post({ type: "raf", ts }));
        return;
      case "unregisterCallback": {
        const real = callbacks.get(msg.id);
        if (real !== undefined) {
          callbacks.delete(msg.id);
          (
            window as unknown as {
              __TAURI_INTERNALS__: { unregisterCallback: (id: number) => void };
            }
          ).__TAURI_INTERNALS__.unregisterCallback(real);
        }
        return;
      }
      case "invoke":
        void forwardInvoke(msg);
        return;
    }
  };

  /** Worker callback id → the real callback id registered in this realm. */
  const callbacks = new Map<number, number>();

  const realCallbackFor = (workerId: number): number => {
    const existing = callbacks.get(workerId);
    if (existing !== undefined) return existing;
    const real = transformCallback((data: unknown) => {
      post({ type: "callback", id: workerId, data });
    }, false);
    callbacks.set(workerId, real);
    return real;
  };

  const channelFor = (workerId: number): Channel<unknown> => {
    const channel = new Channel<unknown>();
    channel.onmessage = (data) => post({ type: "callback", id: workerId, data });
    return channel;
  };

  /** Rebuilds `args` with the worker's callback ids swapped for real ones: numeric top-level fields become callback ids, `__CHANNEL__:<id>` strings anywhere become Channels. */
  const remap = (value: unknown, ids: Set<number>, depth: number): unknown => {
    if (ids.size === 0) return value;
    if (typeof value === "string") {
      const m = /^__CHANNEL__:(\d+)$/.exec(value);
      if (m && ids.has(Number(m[1]))) return channelFor(Number(m[1]));
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => remap(v, ids, depth + 1));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] =
          depth === 0 && typeof v === "number" && ids.has(v)
            ? realCallbackFor(v)
            : remap(v, ids, depth + 1);
      }
      return out;
    }
    return value;
  };

  async function forwardInvoke(msg: Extract<WorkerToHost, { type: "invoke" }>): Promise<void> {
    try {
      const args =
        msg.args instanceof Uint8Array || msg.args instanceof ArrayBuffer
          ? msg.args
          : remap(msg.args, new Set(msg.callbackIds), 0);
      const value = await invoke(
        msg.cmd,
        args as Record<string, unknown>,
        msg.options as undefined,
      );
      const transfer = value instanceof ArrayBuffer ? [value] : [];
      post({ type: "invokeResult", id: msg.id, ok: true, value }, transfer);
    } catch (e) {
      let error: unknown = e;
      try {
        structuredClone(e);
      } catch {
        error = e instanceof Error ? e.message : String(e);
      }
      post({ type: "invokeResult", id: msg.id, ok: false, error });
    }
  }

  const samplePath = "/Users/x/Kookaburra Cut/a b/assets/c+d.png";
  post(
    {
      type: "init",
      canvas: offscreen,
      width: rect.width,
      height: rect.height,
      dpr,
      convertSample: { path: samplePath, url: convertFileSrc(samplePath) },
      nativeRaf: false,
    },
    [offscreen],
  );
}
