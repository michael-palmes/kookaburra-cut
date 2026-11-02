import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { stampProjectKit } from "./appHeartbeat";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;

describe("stampProjectKit", () => {
  it("stamps a workspace project once per session, retrying after a failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    stampProjectKit("ws:demo");
    await flush();
    stampProjectKit("ws:demo");
    stampProjectKit("ws:demo");
    await flush();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["provision_project", { slug: "demo" }],
      ["provision_project", { slug: "demo" }],
    ]);
  });

  it("stamps only after a load succeeded, since a load can fail before Allow and the stamp runs git", () => {
    const app = testProcess
      .getBuiltinModule("fs")
      .readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const stamps = app.split("stampProjectKit(projectId)").length - 1;
    const load = app.slice(app.indexOf("loadProject(projectId)"));
    const success = load.slice(0, load.indexOf(".catch((e) =>"));
    expect(stamps).toBe(1);
    expect(success).toContain("stampProjectKit(projectId)");
  });

  it("never stamps a bundled project", () => {
    vi.mocked(invoke).mockClear();
    stampProjectKit("showcase-tour");
    expect(invoke).not.toHaveBeenCalled();
  });
});
