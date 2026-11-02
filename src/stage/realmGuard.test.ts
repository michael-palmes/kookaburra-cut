import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { installRealmGuard, provePolicy } from "./realmGuard";

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
    XMLHttpRequest: Xhr,
    importScripts: vi.fn(),
  };
  installRealmGuard(scope, APP, dev);
  return { scope, fetchSpy };
}

const ALLOWED = [
  "asset://localhost/project/a.png",
  "blob:tauri://localhost/1234",
  "data:image/webp;base64,AAAA",
  "tauri://localhost/assets/model.glb",
];
const REFUSED = [
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
    const shifty = { toString: () => (reads++ ? "https://example.com/x" : "asset://localhost/a") };
    const socket = new scope.EventSource(shifty) as Sink;
    expect(socket.args[0]).toBe("asset://localhost/a");
  });

  it("starts nested workers from blobs only, which inherit the policy", () => {
    const { scope } = realm();
    expect(() => new scope.Worker("blob:tauri://localhost/1")).not.toThrow();
    expect(() => new scope.Worker("tauri://localhost/assets/x.js")).toThrow(TypeError);
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
    expect(directive(csp, "connect-src").filter((v) => /^(https?:|wss?:|\*)/.test(v))).toEqual([
      "http://ipc.localhost",
      "http://asset.localhost",
    ]);
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
