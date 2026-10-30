import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { stampProjectKit } from "./appHeartbeat";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stampProjectKit", () => {
  it("stamps a workspace project once per session, retrying after a failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    stampProjectKit("ws:demo");
    await flush();
    stampProjectKit("ws:demo");
    await flush();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["provision_project", { slug: "demo" }],
      ["provision_project", { slug: "demo" }],
    ]);
  });

  it("checks for a missing kit on every later load, one check at a time", async () => {
    vi.mocked(invoke).mockClear();
    stampProjectKit("ws:healed");
    await flush();
    stampProjectKit("ws:healed");
    stampProjectKit("ws:healed");
    await flush();
    stampProjectKit("ws:healed");
    await flush();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["provision_project", { slug: "healed" }],
      ["heal_project_kit", { slug: "healed" }],
      ["heal_project_kit", { slug: "healed" }],
    ]);
  });

  it("never stamps a bundled project", () => {
    vi.mocked(invoke).mockClear();
    stampProjectKit("showcase-tour");
    expect(invoke).not.toHaveBeenCalled();
  });
});
