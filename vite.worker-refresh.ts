import type { Plugin } from "vite";

const REFRESH_RUNTIME = "/@react-refresh";

/** A bare `window.` reference (not a property named window), the one shape the runtime uses. */
const BARE_WINDOW = /(^|[^.\w$])window\./g;

export function rewriteRefreshRuntime(code: string): string {
  return code.replace(BARE_WINDOW, "$1globalThis.");
}

/** Fast Refresh runtime, realm-neutral: the footer skips a worker, but the runtime still has to evaluate there (docs/architecture.md, "The stage worker"). */
export function workerSafeRefresh(): Plugin {
  return {
    name: "kookaburra-worker-safe-refresh",
    apply: "serve",
    transform: {
      filter: { id: { include: [REFRESH_RUNTIME] } },
      handler(code, id) {
        if (id !== REFRESH_RUNTIME) return;
        return { code: rewriteRefreshRuntime(code), map: null };
      },
    },
  };
}
