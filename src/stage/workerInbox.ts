/** The worker's message inbox: the entry script installs it before anything else loads, so an `init` posted while the server module is still importing waits here instead of being dropped (a listener attached after the entry script finishes misses what the window already sent). */

type Handler = (ev: MessageEvent) => void;

let handler: Handler | null = null;
const queued: MessageEvent[] = [];

export function installWorkerInbox(scope: {
  addEventListener: (t: "message", h: Handler) => void;
}): void {
  scope.addEventListener("message", (ev) => {
    if (handler) handler(ev);
    else queued.push(ev);
  });
}

/** Hands every message, queued ones first, to the server's handler. */
export function takeWorkerInbox(next: Handler): void {
  handler = next;
  for (const ev of queued.splice(0)) next(ev);
}
