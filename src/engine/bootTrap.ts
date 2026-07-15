/** Last-resort boot diagnostics, installed as main.tsx's first import and kept dependency-free so it evaluates before anything can crash: surfaces an uncaught error as readable text and, in autorun mode, reports it via `finish_autorun` (dynamic import, keeps this module weightless) so a packaged AFK run writes a result instead of hanging until the wrapper timeout. DOM here is a failure surface only, it never touches exported pixels. */
function surface(kind: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[boot-trap] ${kind}:`, message);
  const root = document.getElementById("root");
  if (root && root.childElementCount === 0) {
    // opacity:1 beats the entry html's #root fade guard; crashes must show.
    root.style.cssText =
      "color:#f66;font:13px monospace;padding:16px;white-space:pre-wrap;opacity:1";
    root.textContent = `Kookaburra Cut failed to boot (${kind}):\n\n${message}`;
  }
  import("./autorun").then((m) => m.reportAutoRunError(`boot ${kind}: ${message}`)).catch(() => {});
}

window.addEventListener("error", (ev) => surface("error", ev.error ?? ev.message));
window.addEventListener("unhandledrejection", (ev) => surface("unhandledrejection", ev.reason));
