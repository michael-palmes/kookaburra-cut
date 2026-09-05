import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type HMRPayload, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contentHmr } from "../../vite.content-hmr";

describe("editable content through Vite's module graph", () => {
  let root: string;
  let server: ViteDevServer;
  let finished: (() => void) | undefined;
  let nextRead: (() => Promise<string>) | undefined;
  const messages: HMRPayload[] = [];

  async function write(path: string, text: string) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  }

  async function change(path: string, text: string | null, event = "change", wait = true) {
    const file = join(root, path);
    if (text === null) await rm(file);
    else await write(path, text);
    messages.length = 0;
    const complete = new Promise<void>((resolve) => {
      finished = resolve;
    });
    server.watcher.emit(event, file);
    if (wait) await complete;
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kookaburra-content-hmr-")));
    await write("presets/hero/scenes/one.json", '{"name":"Before"}');
    await write("projects/kit/template.json", "{}");
    await write("projects/kit/project.json", '{"name":"Kit"}');
    await write("projects/demo/scenes/one.json", "{}");
    await write("src/editor.js", 'export const title = "Editor";');
    await write(
      "entry.js",
      `
      import "/src/editor.js";
      export const documents = import.meta.glob(["/presets/**/*.json", "/projects/**/*.json"], { eager: true });
      export const posters = import.meta.glob("/presets/*/poster.png", { eager: true, query: "?url", import: "default" });
      export const assets = import.meta.glob("/presets/*/assets/**", { eager: true, query: "?url", import: "default" });
    `,
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "delay-content-read",
          hotUpdate: {
            order: "pre",
            handler(options) {
              if (this.environment.name === "client" && nextRead) {
                options.read = nextRead;
                nextRead = undefined;
              }
            },
          },
        },
        contentHmr(),
      ],
      optimizeDeps: { noDiscovery: true },
      server: {
        port: 0,
        watch: { ignored: ["**"] },
        async hotUpdateEnvironments(current, update) {
          const complete = finished;
          for (const environment of Object.values(current.environments)) await update(environment);
          complete?.();
        },
      },
    });
    await server.listen();
    expect(server.config.plugins.some((plugin) => plugin.name === "kookaburra-content-hmr")).toBe(
      true,
    );
    vi.spyOn(server.environments.client.hot, "send").mockImplementation((payload) => {
      if (typeof payload !== "string") messages.push(payload);
    });
    await server.transformRequest("/entry.js");
    for (const path of [
      "/presets/hero/scenes/one.json",
      "/projects/kit/project.json",
      "/projects/demo/scenes/one.json",
      "/src/editor.js",
    ]) {
      await server.transformRequest(path);
    }
  });

  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("updates preset data without frontend HMR and keeps fresh imports available", async () => {
    await change("presets/hero/scenes/one.json", '{"name":"After"}');
    expect(messages).toEqual([
      {
        type: "custom",
        event: "kookaburra:library-document",
        data: { path: "/presets/hero/scenes/one.json", content: { name: "After" } },
      },
    ]);
    expect((await server.transformRequest("/presets/hero/scenes/one.json"))?.code).toContain(
      "After",
    );
  });

  it("handles template documents and sidecar creation/deletion without a glob reload", async () => {
    await change("projects/kit/project.json", '{"name":"Edited kit"}');
    expect(messages.every((message) => message.type === "custom")).toBe(true);
    await change("presets/hero/scenes/two.json", '{"name":"New"}', "add");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom", data: { content: { name: "New" } } });
    expect((await server.transformRequest("/entry.js"))?.code).toContain("two.json");
    await change("presets/hero/scenes/two.json", null, "unlink");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom", data: { content: null } });
    expect((await server.transformRequest("/entry.js"))?.code).not.toContain("two.json");
  });

  it("retains normal HMR for app code and non-editable bundled projects", async () => {
    await change("src/editor.js", 'export const title = "Changed";');
    expect(
      messages.some((message) => message.type === "full-reload" || message.type === "update"),
    ).toBe(true);
    await change("projects/demo/scenes/one.json", '{"name":"Changed"}');
    expect(
      messages.some((message) => message.type === "full-reload" || message.type === "update"),
    ).toBe(true);
  });

  it("refreshes replaced and newly imported media without reloading glob consumers", async () => {
    const path = "presets/hero/assets/screen.png";
    await change(path, "first image", "add");
    expect(messages).toEqual([
      {
        type: "custom",
        event: "kookaburra:library-document",
        data: { path: `/${path}`, content: expect.stringMatching(/screen\.png\?v=\d+$/) },
      },
    ]);
    expect((await server.transformRequest("/entry.js"))?.code).toContain("screen.png");
    await server.transformRequest(`/${path}?url`);
    await change(path, "replaced image");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom", data: { path: `/${path}` } });
    await change(path, null, "unlink");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom", data: { content: null } });
    expect((await server.transformRequest("/entry.js"))?.code).not.toContain("screen.png");
  });

  it("refreshes saved poster URLs without reloading the editor", async () => {
    await change("presets/hero/poster.png.42.123.tmp", "pending", "add");
    expect(messages).toEqual([]);
    await change("presets/hero/poster.png", "first poster", "add");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "custom",
      event: "kookaburra:library-document",
      data: {
        path: "/presets/hero/poster.png",
        content: expect.stringMatching(/^\/presets\/hero\/poster\.png\?v=\d+$/),
      },
    });
    expect((await server.transformRequest("/entry.js"))?.code).toContain("poster.png");
    await server.transformRequest("/presets/hero/poster.png?url");
    await change("presets/hero/poster.png", "updated poster");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom" });
    await change("presets/hero/poster.png", null, "unlink");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "custom", data: { content: null } });
    expect((await server.transformRequest("/entry.js"))?.code).not.toContain("hero/poster.png");
    await change("presets/hero/poster.png.42.123.tmp", null, "unlink");
    expect(messages).toEqual([]);
  });

  it.each(['{"name":"Latest"}', null])(
    "discards an old read that finishes after a newer save or deletion (%s)",
    async (latest) => {
      let started!: () => void;
      let release!: (value: string) => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const delayed = new Promise<string>((resolve) => {
        release = resolve;
      });
      nextRead = () => {
        started();
        return delayed;
      };
      await change("presets/hero/scenes/race.json", '{"name":"Old"}', "add", false);
      await reading;
      await change("presets/hero/scenes/race.json", latest, latest === null ? "unlink" : "change");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "custom",
        data: { content: latest === null ? null : { name: "Latest" } },
      });
      release('{"name":"Old"}');
      await delayed;
      expect(messages).toHaveLength(1);
    },
  );
});
