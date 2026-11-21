import { traced } from "./taskTrace";

/** The stage worker's animation frames. WebKit serves a worker's timers, and the animation frames built on them, only when its message queue is empty, so a busy stage (clock ticks, clip frames landing, React work) starved its own draws. The window's display tick arrives as a message, in turn with the rest, and the worker's native frame stays as the source when the window has none (hidden, occluded). */

const MIN_FRAME_MS = 12;

type Native = {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
};

const pending = new Map<number, FrameRequestCallback>();
let nextId = 1;
let lastAt = Number.NEGATIVE_INFINITY;
let asked = false;
let ask: () => void = () => {};
let native: ((cb: FrameRequestCallback) => number) | null = null;

function arm(): void {
  native?.(fireFrame);
  if (asked) return;
  asked = true;
  ask();
}

/** Runs the waiting frame callbacks, once per display interval whichever source calls. */
export function fireFrame(): void {
  asked = false;
  if (pending.size === 0) return;
  const now = performance.now();
  if (now - lastAt < MIN_FRAME_MS) {
    arm();
    return;
  }
  lastAt = now;
  const batch = [...pending.values()];
  pending.clear();
  for (const cb of batch) traced("raf", () => cb(now));
}

export function installFramePump(scope: Native, askWindow: () => void): void {
  native = scope.requestAnimationFrame?.bind(scope) ?? null;
  ask = askWindow;
  scope.requestAnimationFrame = (cb) => {
    const id = nextId++;
    pending.set(id, cb);
    arm();
    return id;
  };
  scope.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
}
