import { installFramePump } from "../engine/framePump";
import { channelImmediate, clearChannelImmediate } from "../engine/macrotask";

type FrameScope = Parameters<typeof installFramePump>[0] & {
  setImmediate?: unknown;
  clearImmediate?: unknown;
  postMessage: (message: unknown) => void;
};

/** The worker's frame and immediate sources, both message tasks: WebKit serves a worker's timers only when its message queue is empty (engine/framePump.ts). anime.js takes its non-browser main loop from `setImmediate` (the loop itself stays off), and React's scheduler prefers it. */
export function installWorkerFrames(scope: FrameScope): void {
  scope.setImmediate ??= channelImmediate;
  scope.clearImmediate ??= clearChannelImmediate;
  installFramePump(scope, () => scope.postMessage({ type: "frameWanted" }));
}
