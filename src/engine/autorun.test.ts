import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const env = (overrides: Record<string, string | null>) => ({
  action: null,
  project: "showcase-tour",
  aspect: null,
  codec: null,
  preset: null,
  encodeJson: null,
  scene: null,
  at: null,
  sets: null,
  themes: null,
  stills: null,
  stillsSize: null,
  ...overrides,
});

/** A fresh module per case: the env is prefetched once per page load. */
async function configFor(overrides: Record<string, string | null>) {
  vi.resetModules();
  vi.mocked(invoke).mockResolvedValue(env(overrides));
  const autorun = await import("./autorun");
  await autorun.initAutoRunConfig();
  return () => autorun.getAutoRunConfig();
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("stills autorun config", () => {
  it("defaults to a 1080p PDF at 16:9", async () => {
    const config = (await configFor({ action: "stills" }))();
    expect(config).toMatchObject({ action: "stills", stills: "pdf", stillsSize: "1080p" });
    expect(config?.aspects.map((a) => a.name)).toEqual(["16:9"]);
  });

  it("reads png as the PNG zip and an explicit size and aspect", async () => {
    const config = (
      await configFor({ action: "stillsverify", stills: "png", stillsSize: "720p", aspect: "9:16" })
    )();
    expect(config).toMatchObject({ stills: "png-zip", stillsSize: "720p" });
    expect(config?.aspects.map((a) => a.name)).toEqual(["9:16"]);
  });

  it("accepts a project list, like verify", async () => {
    const config = (await configFor({ action: "stills", project: "a,b" }))();
    expect(config?.projects).toEqual(["a", "b"]);
  });

  it("rejects an unknown format or size", async () => {
    expect(await configFor({ action: "stills", stills: "tiff" })).toThrow(
      'unknown KOOKABURRA_STILLS "tiff"',
    );
    expect(await configFor({ action: "stills", stillsSize: "8k" })).toThrow(
      'unknown KOOKABURRA_STILLS_SIZE "8k"',
    );
  });
});
