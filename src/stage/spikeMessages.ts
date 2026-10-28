/** Spike-only message shapes between the editor realm and the stage worker (Phase 1 of the scene-isolation spike). Phase 2 replaces this with the typed, versioned stage protocol. */

export interface StageInitMessage {
  type: "init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
  /** One `convertFileSrc` sample so the worker can check its own path-to-URL mirror. */
  convertSample: { path: string; url: string };
  nativeRaf: boolean;
}

export type HostToWorker =
  | StageInitMessage
  | { type: "invokeResult"; id: number; ok: true; value: unknown }
  | { type: "invokeResult"; id: number; ok: false; error: unknown }
  | { type: "callback"; id: number; data: unknown }
  | { type: "raf"; ts: number };

export type WorkerToHost =
  | { type: "log"; level: "warn" | "error"; text: string }
  | {
      type: "invoke";
      id: number;
      cmd: string;
      args: unknown;
      options: unknown;
      /** Worker-side callback ids present in `args` (top-level numeric fields or `__CHANNEL__:<id>` strings). */
      callbackIds: number[];
    }
  | { type: "unregisterCallback"; id: number }
  | { type: "rafRequest" }
  | { type: "fatal"; text: string }
  | { type: "ready"; probe: Record<string, unknown> };
