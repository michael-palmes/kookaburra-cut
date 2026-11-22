/** One macrotask yield for the settle-barrier polls (exporter, title measures, project commit). Hidden pages clamp nested setTimeout chains to 1s alignment (the render window measured ~2s per 1s chain, R1 spike 2026-08-07), while MessageChannel messages stay unthrottled; the render window opts in at boot and every visible window keeps the proven setTimeout path, so interactive and AFK export timing is untouched. Pixel output never depends on the yield primitive, only wall time does. */

const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiting: (() => void)[] = [];
if (channel) {
  channel.port1.onmessage = () => waiting.shift()?.();
}

let preferUnthrottled = false;

/** Called once from the render window's entry point; never from a visible window. */
export function setPreferUnthrottledYields(): void {
  preferUnthrottled = true;
}

export function yieldMacrotask(): Promise<void> {
  if (channel && preferUnthrottled) {
    return new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const immediates = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const queued = new Map<number, () => void>();
let nextImmediate = 1;
if (immediates) {
  immediates.port1.onmessage = (ev: MessageEvent<number>) => {
    const fn = queued.get(ev.data);
    queued.delete(ev.data);
    fn?.();
  };
}

/** `setImmediate` for the stage worker, which has none: a MessageChannel task, as React's scheduler would use by itself in a window. A timer waits a millisecond at least, and a worker's timers wait for an empty message queue. */
export function channelImmediate(fn: () => void): number {
  if (!immediates) return setTimeout(fn, 0) as unknown as number;
  const id = -nextImmediate++;
  queued.set(id, fn);
  immediates.port2.postMessage(id);
  return id;
}

export function clearChannelImmediate(id: number): void {
  if (id < 0) queued.delete(id);
  else clearTimeout(id);
}
