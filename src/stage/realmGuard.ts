/** The second wall behind the inherited policy (the only one in dev): `import()` is syntax, so `provePolicy` covers it. */

type Scope = Record<string, unknown>;
type Ctor = new (...args: unknown[]) => object;

const LOCAL_SCHEMES = new Set(["blob:", "data:"]);

/** How a refusal reads in the relayed log; the window fails an autorun on it. */
export const REACH_REFUSED = "reach refused";

const refuse = (url: string) => new TypeError(`the stage cannot reach ${url}`);

/** The files and folders `asset:` may serve this realm, by owner; only what the window handed over. */
const reach = new Map<string, string[]>();

/** Grants `paths` (absolute, a folder admits what is below it), replacing the owner's last grant. */
export function grantReach(key: string, paths: readonly (string | null)[]): void {
  reach.set(
    key,
    paths.flatMap((path) => {
      const clean = path?.replace(/\/+$/, "");
      return clean?.startsWith("/") ? [clean] : [];
    }),
  );
}

export function revokeReach(key: string): void {
  reach.delete(key);
}

/** The file an `asset:` URL names: `convertFileSrc` encodes the whole path into one segment and the query is only a cache-bust. Null when it is not one absolute path with no way up. */
function namedPath(url: URL): string | null {
  try {
    const path = decodeURIComponent(url.pathname.slice(1));
    return path.startsWith("/") && !path.split("/").includes("..") ? path : null;
  } catch {
    return null;
  }
}

/** `namedPath` for a URL the window handed over, to grant it. */
export function assetUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "asset:" ? namedPath(parsed) : null;
  } catch {
    return null;
  }
}

export function assetAllowed(url: URL): boolean {
  const path = namedPath(url);
  const ok =
    path !== null &&
    [...reach.values()].some((paths) =>
      paths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
    );
  if (!ok) console.warn(`${REACH_REFUSED} ${url.href}`);
  return ok;
}

function replace(scope: object, name: string, value: unknown): void {
  for (let o: object | null = scope; o; o = Object.getPrototypeOf(o)) {
    if (!Object.hasOwn(o, name)) continue;
    Object.defineProperty(o, name, { value, writable: false, configurable: false });
  }
}

/** `appUrl` is any URL of the app's own bundle: `self.location` is a `blob:` URL in a built worker. `dev` also lets the Vite client reach its dev server. */
export function installRealmGuard(scope: object, appUrl: string, dev: boolean): void {
  const realm = scope as Scope;
  const app = new URL(appUrl);
  const allowed = (url: URL) =>
    LOCAL_SCHEMES.has(url.protocol) ||
    (url.protocol === "asset:" && assetAllowed(url)) ||
    (url.host === app.host && (url.protocol === app.protocol || (dev && url.protocol === "ws:")));
  // One read, and the checked string is what goes on: an object's toString could answer differently twice.
  const checked = (input: unknown, ok: (url: URL) => boolean = allowed): string => {
    const url = new URL(
      String(input),
      String((realm.location as Location | undefined)?.href ?? appUrl),
    );
    if (!ok(url)) throw refuse(url.href);
    return url.href;
  };

  const fetchFn = realm.fetch as typeof fetch | undefined;
  const RequestCtor = realm.Request as typeof Request | undefined;
  if (fetchFn && RequestCtor) {
    replace(scope, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const request = new RequestCtor(input, init);
        checked(request.url);
        return fetchFn.call(scope, request);
      } catch (e) {
        return Promise.reject(e);
      }
    });
  } else if (fetchFn) {
    replace(scope, "fetch", () => Promise.reject(refuse("the network")));
  }

  const guardCtor = (name: string, ok?: (url: URL) => boolean) => {
    const Original = realm[name] as Ctor | undefined;
    if (!Original) return;
    const guarded: Ctor = new Proxy(Original, {
      construct: (target, [url, ...rest], newTarget): object =>
        Reflect.construct(
          target,
          [checked(url, ok), ...rest],
          newTarget === guarded ? target : newTarget,
        ),
    });
    replace(scope, name, guarded);
    Object.defineProperty(Original.prototype, "constructor", {
      value: guarded,
      writable: false,
      configurable: false,
    });
  };
  guardCtor("WebSocket");
  guardCtor("WebSocketStream");
  guardCtor("WebTransport");
  guardCtor("EventSource");
  // The stage spawns no workers, and a nested one would start without this guard.
  guardCtor("Worker", () => false);
  guardCtor("SharedWorker", () => false);

  const Xhr = realm.XMLHttpRequest as typeof XMLHttpRequest | undefined;
  if (Xhr) {
    const open = Xhr.prototype.open as (...args: unknown[]) => void;
    replace(Xhr.prototype, "open", function (this: XMLHttpRequest, ...args: unknown[]) {
      args[1] = checked(args[1]);
      open.apply(this, args);
    });
  }

  const load = realm.importScripts as ((...urls: string[]) => void) | undefined;
  if (load) {
    replace(scope, "importScripts", (...urls: unknown[]) =>
      load.apply(
        scope,
        urls.map((url) => checked(url)),
      ),
    );
  }
}

/** Resolves only when the realm's policy is live: with `script-src` in force a `data:` module cannot load, and the probe never touches the network. */
export async function provePolicy(importModule: (url: string) => Promise<unknown>): Promise<void> {
  const loaded = await importModule("data:text/javascript,").then(
    () => true,
    () => false,
  );
  if (loaded) throw new Error("the stage worker started without its content security policy");
}
