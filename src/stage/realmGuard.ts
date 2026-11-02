/** The second wall behind the inherited policy (the only one in dev): `import()` is syntax, so `provePolicy` covers it. */

type Scope = Record<string, unknown>;
type Ctor = new (...args: unknown[]) => object;

const LOCAL_SCHEMES = new Set(["asset:", "blob:", "data:"]);

const refuse = (url: string) => new TypeError(`the stage cannot reach ${url}`);

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
  // A worker from the app's own files would start with no policy; a blob worker inherits this one.
  guardCtor("Worker", (url) => url.protocol === "blob:");

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
