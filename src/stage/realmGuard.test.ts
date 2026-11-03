import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetUrlPath,
  grantReach,
  installRealmGuard,
  provePolicy,
  revokeReach,
} from "./realmGuard";

// biome-ignore lint/suspicious/noExplicitAny: a fake realm of whatever the guard wraps
type Realm = Record<string, any>;

const APP = "tauri://localhost/assets/stageWorker-abc.js";
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

class Sink {
  args: unknown[];
  constructor(...args: unknown[]) {
    this.args = args;
  }
}

function realm(dev = false) {
  class Xhr {
    opened: unknown[] = [];
    open(...args: unknown[]) {
      this.opened = args;
    }
  }
  const fetchSpy = vi.fn(async (_: Request) => new Response("ok"));
  const scope: Realm = {
    location: { href: "blob:tauri://localhost/1234" },
    fetch: fetchSpy,
    Request,
    WebSocket: class extends Sink {},
    EventSource: class extends Sink {},
    Worker: class extends Sink {},
    SharedWorker: class extends Sink {},
    XMLHttpRequest: Xhr,
    importScripts: vi.fn(),
  };
  installRealmGuard(scope, APP, dev);
  return { scope, fetchSpy };
}

const ALLOWED = [
  "blob:tauri://localhost/1234",
  "data:image/webp;base64,AAAA",
  "tauri://localhost/assets/model.glb",
];
const REFUSED = [
  "asset://localhost/%2Fproject%2Fa.png",
  "https://example.com/x",
  "http://127.0.0.1:9000/x",
  "http://localhost/x",
  "http://asset.localhost/x",
  "ipc://localhost/cmd",
  "tauri://other/x",
  "ftp://example.com/x",
];

describe("installRealmGuard", () => {
  it.each(ALLOWED)("lets fetch through to %s", async (url) => {
    const { scope, fetchSpy } = realm();
    await scope.fetch(url);
    expect(fetchSpy.mock.calls[0][0].url).toBe(new URL(url).href);
  });

  it.each(REFUSED)("refuses every network door for %s", async (url) => {
    const { scope, fetchSpy } = realm();
    await expect(scope.fetch(url)).rejects.toThrow(TypeError);
    await expect(scope.fetch(new Request(url))).rejects.toThrow(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => new scope.WebSocket(url)).toThrow(TypeError);
    expect(() => new scope.EventSource(url)).toThrow(TypeError);
    expect(() => new scope.XMLHttpRequest().open("GET", url)).toThrow(TypeError);
    expect(() => scope.importScripts(url)).toThrow(TypeError);
  });

  it("checks one string, however the input answers", () => {
    const { scope } = realm();
    let reads = 0;
    const shifty = { toString: () => (reads++ ? "https://example.com/x" : "data:,a") };
    const socket = new scope.EventSource(shifty) as Sink;
    expect(socket.args[0]).toBe("data:,a");
  });

  it("refuses nested workers", () => {
    const { scope } = realm();
    for (const url of ["blob:tauri://localhost/1", "tauri://localhost/assets/x.js"]) {
      expect(() => new scope.Worker(url)).toThrow(TypeError);
      expect(() => new scope.SharedWorker(url)).toThrow(TypeError);
      expect(() => new (scope.Worker.prototype.constructor as typeof scope.Worker)(url)).toThrow(
        TypeError,
      );
    }
  });

  it("opens the dev socket in dev only", () => {
    const socket = "ws://localhost:1420/";
    const devScope: Realm = { WebSocket: class extends Sink {} };
    installRealmGuard(devScope, "http://localhost:1420/src/stage/stageWorker.ts", true);
    expect(() => new devScope.WebSocket(socket)).not.toThrow();
    expect(() => new devScope.WebSocket("ws://example.com/")).toThrow(TypeError);
    const builtScope: Realm = { WebSocket: class extends Sink {} };
    installRealmGuard(builtScope, "http://localhost:1420/x.js", false);
    expect(() => new builtScope.WebSocket(socket)).toThrow(TypeError);
  });

  it("cannot be undone or reached around through the prototype", () => {
    const original = vi.fn();
    const proto = { importScripts: original };
    const scope = Object.create(proto) as Realm;
    installRealmGuard(scope, APP, false);
    expect(() => scope.importScripts("https://example.com/x")).toThrow(TypeError);
    expect(() => proto.importScripts("https://example.com/x")).toThrow(TypeError);
    expect(Reflect.deleteProperty(proto, "importScripts")).toBe(false);
    expect(original).not.toHaveBeenCalled();
  });

  it("closes the constructor reachable from the prototype", () => {
    const { scope } = realm();
    const Reached = scope.WebSocket.prototype.constructor;
    expect(() => new Reached("https://example.com/x")).toThrow(TypeError);
  });
});

describe("asset reach", () => {
  const asset = (path: string, query = "") =>
    `asset://localhost/${encodeURIComponent(path)}${query}`;
  const reaches = async (url: string) => {
    const { scope } = realm();
    return (scope.fetch(url) as Promise<Response>).then(
      () => true,
      () => false,
    );
  };

  afterEach(() => {
    revokeReach("project");
    revokeReach("object:cube");
    vi.restoreAllMocks();
  });

  it("refuses asset: until something grants it, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = asset("/w/alpha/assets/a.png");
    expect(await reaches(url)).toBe(false);
    expect(warn).toHaveBeenCalledWith(`reach refused ${url}`);
    grantReach("project", ["/w/alpha"]);
    expect(await reaches(url)).toBe(true);
  });

  it("admits a granted folder's files, the folder itself, and no sibling sharing its prefix", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    grantReach("project", ["/w/alpha/"]);
    expect(await reaches(asset("/w/alpha/assets/a b#ü.png"))).toBe(true);
    expect(await reaches(asset("/w/alpha"))).toBe(true);
    expect(await reaches(asset("/w/alpha-evil/a.png"))).toBe(false);
    expect(await reaches(asset("/w/beta/a.png"))).toBe(false);
  });

  it("is not widened by a query or percent-encoding", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    grantReach("project", ["/w/alpha"]);
    expect(await reaches(asset("/w/alpha/a.png", "?v=3&r=1"))).toBe(true);
    for (const url of [
      asset("/w/beta/a.png", "?/w/alpha/a.png"),
      asset("/w/alpha/../beta/a.png"),
      asset("/w/alpha/..").replace("..", "%2E%2E"),
      `asset://localhost/${encodeURIComponent(encodeURIComponent("/w/alpha/a.png"))}`,
      "asset://localhost/%2Fw%2Falpha%2F%E0%A4%A",
      "asset://localhost/w/alpha/a.png",
      "asset://localhost",
    ]) {
      expect(await reaches(url), url).toBe(false);
    }
  });

  it("matches a granted file exactly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    grantReach("project", [assetUrlPath(asset("/w/fonts/x.woff"))]);
    expect(await reaches(asset("/w/fonts/x.woff"))).toBe(true);
    expect(await reaches(asset("/w/fonts/x.woff2"))).toBe(false);
    expect(await reaches(asset("/w/fonts/y.woff"))).toBe(false);
  });

  it("grants nothing for a path that is not one, least of all the whole disk", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(assetUrlPath("/projects/_samples/a.png")).toBeNull();
    expect(assetUrlPath("tauri://localhost/assets/a.woff")).toBeNull();
    expect(assetUrlPath(asset("/w/../a.woff"))).toBeNull();
    grantReach("project", ["/", "relative/path", null, ""]);
    expect(await reaches(asset("/w/alpha/a.png"))).toBe(false);
  });

  it("closes on revoke, one owner at a time, and a new grant replaces the owner's last", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    grantReach("project", ["/w/alpha"]);
    grantReach("object:cube", ["/w/objects/cube/cube.glb"]);
    revokeReach("project");
    expect(await reaches(asset("/w/alpha/a.png"))).toBe(false);
    expect(await reaches(asset("/w/objects/cube/cube.glb"))).toBe(true);
    grantReach("project", ["/w/alpha"]);
    grantReach("project", ["/w/beta"]);
    expect(await reaches(asset("/w/alpha/a.png"))).toBe(false);
    expect(await reaches(asset("/w/beta/a.png"))).toBe(true);
  });
});

describe("provePolicy", () => {
  it("passes when the policy refuses a data: module and fails closed when it loads", async () => {
    await expect(provePolicy(() => Promise.reject(new Error("refused")))).resolves.toBeUndefined();
    await expect(provePolicy(() => Promise.resolve({}))).rejects.toThrow(/policy/);
  });
});

describe("stage worker entry", () => {
  const entry = source("./stageWorker.ts");
  const code = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("installs the guard before anything else runs", () => {
    const imports = [...code.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    expect(imports[0]).toBe("./realmGuard");
    const body = code
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("import "))
      .slice(0, 2);
    expect(body[1]).toMatch(/^installRealmGuard\(scope, import\.meta\.url,/);
  });

  it("loads the server only after the guard and the policy proof, and never statically", () => {
    expect(code).not.toMatch(/^import .*stageServer/m);
    const guard = code.indexOf("installRealmGuard(scope");
    const proof = code.indexOf("provePolicy((url)");
    const server = code.indexOf('import("./stageServer")');
    expect(guard).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(guard);
    expect(server).toBeGreaterThan(proof);
    expect(code.match(/import\("\.\/stageServer"\)/g)).toHaveLength(1);
  });
});

describe("the policy the worker inherits", () => {
  const { csp, devCsp } = JSON.parse(source("../../src-tauri/tauri.conf.json")).app.security;
  const directive = (policy: string, name: string) =>
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([key]) => key === name)
      ?.slice(1) ?? [];

  it("reaches no remote host from a shipped build", () => {
    expect(directive(csp, "connect-src").filter((v) => /^(https?:|wss?:|\*)/.test(v))).toEqual([]);
    expect(csp).not.toMatch(/\.localhost/);
    expect(devCsp).not.toMatch(/\.localhost/);
    expect(directive(csp, "script-src")).toEqual(["'self'", "blob:", "'wasm-unsafe-eval'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("keeps the local schemes scenes load through", () => {
    for (const policy of [csp, devCsp]) {
      expect(directive(policy, "connect-src")).toEqual(
        expect.arrayContaining(["'self'", "blob:", "data:", "asset:"]),
      );
    }
  });
});
